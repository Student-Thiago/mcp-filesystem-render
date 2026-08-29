// server.js — MCP filesystem server, Streamable HTTP, token-authenticated.
//
// Env:
//   FILESYSTEM_MCP_TOKEN  required. Bearer token clients must present.
//   FILESYSTEM_MCP_ROOT   required in production. Directory the tools may touch.
//   PORT                  provided by Render.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const TOKEN = process.env.FILESYSTEM_MCP_TOKEN;
if (!TOKEN) {
  console.error("FILESYSTEM_MCP_TOKEN is not set. Refusing to start.");
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 3000);
const MAX_BYTES = 2 * 1024 * 1024; // cap on read/write payloads

// Resolved from FILESYSTEM_MCP_ROOT at startup, through symlinks.
let ROOT;

/**
 * Resolve `p` inside ROOT, following symlinks, and reject anything that escapes.
 * Files that do not exist yet are allowed as long as their nearest existing
 * ancestor resolves inside ROOT.
 */
async function safePath(p) {
  if (typeof p !== "string" || p.length === 0) {
    throw new Error("path is required");
  }
  if (p.includes("\0")) {
    throw new Error("path contains a null byte");
  }

  const absolute = path.resolve(ROOT, p);

  // Walk up to the deepest ancestor that exists, so symlinks in the middle of
  // the path cannot be used to hop outside ROOT.
  let existing = absolute;
  const trailing = [];
  for (;;) {
    try {
      existing = await fs.realpath(existing);
      break;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error("path does not resolve");
      trailing.unshift(path.basename(existing));
      existing = parent;
    }
  }

  const resolved = path.resolve(existing, ...trailing);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    throw new Error("path escapes the allowed root");
  }
  return resolved;
}

const relative = (abs) => path.relative(ROOT, abs) || ".";
const ok = (text) => ({ content: [{ type: "text", text }] });

function buildServer() {
  const server = new McpServer(
    { name: "filesystem", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "list_directory",
    {
      description: "List the entries of a directory inside the allowed root.",
      inputSchema: { path: z.string().default(".") },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ path: p = "." }) => {
      const dir = await safePath(p);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const listing = entries
        .map((e) => `${e.isDirectory() ? "[DIR] " : "[FILE]"} ${e.name}`)
        .sort()
        .join("\n");
      return ok(listing || "(empty directory)");
    }
  );

  server.registerTool(
    "read_file",
    {
      description: "Read a UTF-8 text file inside the allowed root.",
      inputSchema: { path: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ path: p }) => {
      const file = await safePath(p);
      const stat = await fs.stat(file);
      if (stat.isDirectory()) throw new Error("path is a directory");
      if (stat.size > MAX_BYTES) {
        throw new Error(`file is ${stat.size} bytes, over the ${MAX_BYTES} limit`);
      }
      return ok(await fs.readFile(file, "utf8"));
    }
  );

  server.registerTool(
    "write_file",
    {
      description: "Create or overwrite a text file inside the allowed root.",
      inputSchema: { path: z.string(), content: z.string() },
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async ({ path: p, content }) => {
      if (Buffer.byteLength(content, "utf8") > MAX_BYTES) {
        throw new Error(`content exceeds the ${MAX_BYTES} byte limit`);
      }
      const file = await safePath(p);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, "utf8");
      return ok(`wrote ${relative(file)}`);
    }
  );

  server.registerTool(
    "create_directory",
    {
      description: "Create a directory (and parents) inside the allowed root.",
      inputSchema: { path: z.string() },
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ path: p }) => {
      const dir = await safePath(p);
      await fs.mkdir(dir, { recursive: true });
      return ok(`created ${relative(dir)}`);
    }
  );

  server.registerTool(
    "delete_path",
    {
      description:
        "Delete a file, or an empty directory. Set recursive to remove a directory tree.",
      inputSchema: { path: z.string(), recursive: z.boolean().default(false) },
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async ({ path: p, recursive = false }) => {
      const target = await safePath(p);
      if (target === ROOT) throw new Error("refusing to delete the root itself");
      const stat = await fs.lstat(target);
      if (stat.isDirectory()) {
        if (recursive) await fs.rm(target, { recursive: true, force: true });
        else await fs.rmdir(target); // fails if not empty, which is the point
      } else {
        await fs.unlink(target);
      }
      return ok(`deleted ${relative(target)}`);
    }
  );

  return server;
}

function authorized(req) {
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES * 2) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  // Unauthenticated liveness probe. Reveals nothing about the filesystem.
  if (pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  if (pathname !== "/mcp") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }

  if (!authorized(req)) {
    res.writeHead(401, {
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="mcp"'
    });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32001, message: "unauthorized" },
        id: null
      })
    );
    return;
  }

  // Stateless: a fresh server and transport per request, so no session state
  // leaks between callers and a cold start costs nothing.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    const body = req.method === "POST" ? await readBody(req) : undefined;
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("request failed:", err.message);
    if (!res.headersSent) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32700, message: err.message },
          id: null
        })
      );
    }
  }
});

const start = async () => {
  const configured = process.env.FILESYSTEM_MCP_ROOT ?? process.cwd();
  await fs.mkdir(configured, { recursive: true });
  ROOT = await fs.realpath(configured);

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`MCP filesystem server on :${PORT}/mcp`);
    console.log(`root: ${ROOT}`);
  });
};

start().catch((err) => {
  console.error("failed to start:", err);
  process.exit(1);
});
