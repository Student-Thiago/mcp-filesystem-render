// MCP filesystem server on Cloudflare Workers, backed by D1 (SQLite).
//
// The Worker is the URL an MCP client connects to. It authenticates every
// request, then reads and writes rows in a D1 database that models a filesystem.
//
// Bindings (wrangler.toml):
//   DB         D1 database
// Secrets (wrangler secret put):
//   MCP_TOKEN  bearer token clients must present
//
// Schema lives in schema.sql. Apply it before first use:
//   npx wrangler d1 execute mcp-filesystem --remote --file=./schema.sql

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL = "2025-06-18";
const SERVER_INFO = { name: "d1-filesystem", version: "1.0.0" };

// D1 caps any single string/BLOB/row at 2 MB. Stay clear of the ceiling so
// metadata columns cannot push a row over it.
const MAX_BYTES = 1_500_000;

/** A tool failure that should be reported to the model, not thrown as HTTP 500. */
class ToolError extends Error {}

/**
 * Normalize a client path into a canonical key: no leading slash, no "." or
 * "..", no empty segments. Rejects anything climbing above the root.
 */
function normalizePath(input, { allowRoot = false } = {}) {
  if (typeof input !== "string") throw new ToolError("path must be a string");
  if (input.includes("\0")) throw new ToolError("path contains a null byte");

  const parts = [];
  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) throw new ToolError("path escapes the root");
      parts.pop();
      continue;
    }
    parts.push(segment);
  }

  const key = parts.join("/");
  if (!key && !allowRoot) throw new ToolError("path must name a file or directory");
  return key;
}

const parentOf = (key) => {
  const i = key.lastIndexOf("/");
  return i === -1 ? "" : key.slice(0, i);
};

/** Ensure every ancestor directory row exists, so listings show the tree. */
async function ensureParents(env, key) {
  const segments = key.split("/").slice(0, -1);
  if (segments.length === 0) return;

  const statements = [];
  let walked = "";
  for (const segment of segments) {
    walked = walked ? `${walked}/${segment}` : segment;
    statements.push(
      env.DB.prepare(
        `INSERT INTO nodes (path, parent, kind, content, size, updated_at)
         VALUES (?, ?, 'dir', NULL, 0, unixepoch())
         ON CONFLICT(path) DO NOTHING`
      ).bind(walked, parentOf(walked))
    );
  }
  await env.DB.batch(statements);
}

const TOOLS = [
  {
    name: "list_directory",
    description: "List the files and directories directly under a path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path. Defaults to the root." }
      }
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ path = "" }, env) => {
      const dir = normalizePath(path, { allowRoot: true });

      if (dir !== "") {
        const node = await env.DB.prepare(`SELECT kind FROM nodes WHERE path = ?`)
          .bind(dir)
          .first();
        if (!node) throw new ToolError(`no such directory: ${dir}`);
        if (node.kind !== "dir") throw new ToolError(`${dir} is a file`);
      }

      const { results } = await env.DB.prepare(
        `SELECT path, kind, size FROM nodes WHERE parent = ? ORDER BY kind DESC, path`
      )
        .bind(dir)
        .all();

      if (!results.length) return "(empty)";

      return results
        .map((row) => {
          const name = row.path.slice(dir === "" ? 0 : dir.length + 1);
          return row.kind === "dir" ? `[DIR]  ${name}` : `[FILE] ${name} (${row.size} bytes)`;
        })
        .join("\n");
    }
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ path }, env) => {
      const key = normalizePath(path);
      const row = await env.DB.prepare(`SELECT kind, content FROM nodes WHERE path = ?`)
        .bind(key)
        .first();
      if (!row) throw new ToolError(`no such file: ${key}`);
      if (row.kind === "dir") throw new ToolError(`${key} is a directory`);
      return row.content ?? "";
    }
  },
  {
    name: "write_file",
    description: "Create or overwrite a text file. Parent directories are created as needed.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"]
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      destructiveHint: true,
      openWorldHint: false
    },
    handler: async ({ path, content }, env) => {
      if (typeof content !== "string") throw new ToolError("content must be a string");
      const size = new TextEncoder().encode(content).byteLength;
      if (size > MAX_BYTES) {
        throw new ToolError(`content is ${size} bytes, over the ${MAX_BYTES} limit`);
      }

      const key = normalizePath(path);
      const existing = await env.DB.prepare(`SELECT kind FROM nodes WHERE path = ?`)
        .bind(key)
        .first();
      if (existing?.kind === "dir") throw new ToolError(`${key} is a directory`);

      await ensureParents(env, key);
      await env.DB.prepare(
        `INSERT INTO nodes (path, parent, kind, content, size, updated_at)
         VALUES (?, ?, 'file', ?, ?, unixepoch())
         ON CONFLICT(path) DO UPDATE SET
           content = excluded.content,
           size = excluded.size,
           updated_at = excluded.updated_at`
      )
        .bind(key, parentOf(key), content, size)
        .run();

      return `wrote ${key} (${size} bytes)`;
    }
  },
  {
    name: "create_directory",
    description: "Create a directory, including any missing parents.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false
    },
    handler: async ({ path }, env) => {
      const key = normalizePath(path);
      const existing = await env.DB.prepare(`SELECT kind FROM nodes WHERE path = ?`)
        .bind(key)
        .first();
      if (existing?.kind === "file") throw new ToolError(`${key} is a file`);

      await ensureParents(env, key);
      await env.DB.prepare(
        `INSERT INTO nodes (path, parent, kind, content, size, updated_at)
         VALUES (?, ?, 'dir', NULL, 0, unixepoch())
         ON CONFLICT(path) DO NOTHING`
      )
        .bind(key, parentOf(key))
        .run();

      return `created ${key}/`;
    }
  },
  {
    name: "delete_path",
    description:
      "Delete a file, or an empty directory. Set recursive to true to delete a whole subtree.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean", description: "Delete a subtree. Defaults to false." }
      },
      required: ["path"]
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: true,
      openWorldHint: false
    },
    handler: async ({ path, recursive = false }, env) => {
      // allowRoot is omitted deliberately: there is no call that empties the tree.
      const key = normalizePath(path);

      const node = await env.DB.prepare(`SELECT kind FROM nodes WHERE path = ?`)
        .bind(key)
        .first();
      if (!node) throw new ToolError(`no such path: ${key}`);

      if (node.kind === "file") {
        await env.DB.prepare(`DELETE FROM nodes WHERE path = ?`).bind(key).run();
        return `deleted ${key}`;
      }

      if (!recursive) {
        const child = await env.DB.prepare(`SELECT 1 FROM nodes WHERE parent = ? LIMIT 1`)
          .bind(key)
          .first();
        if (child) throw new ToolError(`${key} is not empty; pass recursive to delete it`);
        await env.DB.prepare(`DELETE FROM nodes WHERE path = ?`).bind(key).run();
        return `deleted ${key}/`;
      }

      // GLOB rather than LIKE: LIKE patterns are capped at 50 bytes in D1, and
      // GLOB treats the key literally apart from the trailing wildcard.
      const { meta } = await env.DB.prepare(
        `DELETE FROM nodes WHERE path = ? OR path GLOB ?`
      )
        .bind(key, `${key}/*`)
        .run();

      return `deleted ${meta.changes} node(s) under ${key}`;
    }
  }
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

const publicTools = () =>
  TOOLS.map(({ name, description, inputSchema, annotations }) => ({
    name,
    description,
    inputSchema,
    annotations
  }));

/** Constant-time compare. Workers has no timingSafeEqual. */
function tokenMatches(presented, expected) {
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function authorized(request, env) {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return presented.length > 0 && tokenMatches(presented, env.MCP_TOKEN);
}

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function dispatch(message, env) {
  const { id, method, params } = message;

  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO
      });
    }

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: publicTools() });

    case "tools/call": {
      const tool = TOOLS_BY_NAME.get(params?.name);
      if (!tool) return rpcError(id, -32602, `unknown tool: ${params?.name}`);
      try {
        const text = await tool.handler(params.arguments ?? {}, env);
        return rpcResult(id, { content: [{ type: "text", text }] });
      } catch (err) {
        // Tool failures belong in the result so the model can react to them.
        return rpcResult(id, {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true
        });
      }
    }

    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.MCP_TOKEN) {
      return new Response("MCP_TOKEN secret is not set", { status: 500 });
    }

    // Unauthenticated liveness probe. Reveals nothing about the data.
    if (url.pathname === "/healthz") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    if (url.pathname !== "/mcp") {
      return new Response("not found", { status: 404 });
    }

    if (!authorized(request, env)) {
      return Response.json(rpcError(null, -32001, "unauthorized"), {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="mcp"' }
      });
    }

    if (request.method !== "POST") {
      return new Response("method not allowed", {
        status: 405,
        headers: { allow: "POST" }
      });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return Response.json(rpcError(null, -32700, "invalid JSON"), { status: 400 });
    }

    const batch = Array.isArray(payload) ? payload : [payload];
    const responses = [];
    for (const message of batch) {
      // Notifications carry no id and get no response.
      if (message?.id === undefined || message?.id === null) continue;
      responses.push(await dispatch(message, env));
    }

    if (responses.length === 0) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(payload) ? responses : responses[0]);
  }
};
