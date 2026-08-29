// MCP filesystem server on Cloudflare Workers, backed by R2.
//
// The Worker is the URL an MCP client connects to. It speaks JSON-RPC over
// Streamable HTTP, authenticates every request with a bearer token, and stores
// file contents as objects in an R2 bucket.
//
// Bindings (wrangler.toml):
//   FILES      R2 bucket
// Secrets (wrangler secret put):
//   MCP_TOKEN  bearer token clients must present

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL = "2025-06-18";
const SERVER_INFO = { name: "r2-filesystem", version: "1.0.0" };
const MAX_BYTES = 2 * 1024 * 1024; // 2 MiB per file
const DIR_MARKER = ".keep"; // empty directories need a placeholder object

/** A tool failure that should be reported to the model, not thrown as HTTP 500. */
class ToolError extends Error {}

/**
 * Normalize a client-supplied path into an R2 key.
 * R2 keys are flat strings, so containment means resolving away "." and ".."
 * and refusing anything that would climb above the bucket root.
 */
function normalizeKey(input, { allowRoot = false } = {}) {
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

const asPrefix = (key) => (key === "" ? "" : `${key}/`);

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
      const prefix = asPrefix(normalizeKey(path, { allowRoot: true }));
      const lines = [];
      let cursor;

      do {
        const page = await env.FILES.list({ prefix, delimiter: "/", cursor });
        for (const p of page.delimitedPrefixes ?? []) {
          lines.push(`[DIR]  ${p.slice(prefix.length).replace(/\/$/, "")}`);
        }
        for (const obj of page.objects ?? []) {
          const name = obj.key.slice(prefix.length);
          if (name === DIR_MARKER) continue; // hide directory placeholders
          lines.push(`[FILE] ${name} (${obj.size} bytes)`);
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);

      return lines.sort().join("\n") || "(empty)";
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
      const key = normalizeKey(path);
      const object = await env.FILES.get(key);
      if (!object) throw new ToolError(`no such file: ${key}`);
      if (object.size > MAX_BYTES) {
        throw new ToolError(`file is ${object.size} bytes, over the ${MAX_BYTES} limit`);
      }
      return await object.text();
    }
  },
  {
    name: "write_file",
    description: "Create or overwrite a text file.",
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
      const bytes = new TextEncoder().encode(content);
      if (bytes.byteLength > MAX_BYTES) {
        throw new ToolError(`content is ${bytes.byteLength} bytes, over the ${MAX_BYTES} limit`);
      }
      const key = normalizeKey(path);
      await env.FILES.put(key, bytes, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" }
      });
      return `wrote ${key} (${bytes.byteLength} bytes)`;
    }
  },
  {
    name: "create_directory",
    description: "Create a directory. Directories are implicit in R2, so this writes a placeholder.",
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
      const key = normalizeKey(path);
      await env.FILES.put(`${key}/${DIR_MARKER}`, new Uint8Array());
      return `created ${key}/`;
    }
  },
  {
    name: "delete_path",
    description:
      "Delete a file. Set recursive to true to delete a directory and everything under it.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean", description: "Delete a whole subtree. Defaults to false." }
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
      const key = normalizeKey(path); // allowRoot omitted: cannot wipe the bucket

      if (!recursive) {
        const head = await env.FILES.head(key);
        if (!head) {
          const probe = await env.FILES.list({ prefix: `${key}/`, limit: 1 });
          if ((probe.objects ?? []).length > 0) {
            throw new ToolError(`${key} is a directory; pass recursive to delete it`);
          }
          throw new ToolError(`no such file: ${key}`);
        }
        await env.FILES.delete(key);
        return `deleted ${key}`;
      }

      let removed = 0;
      let cursor;
      do {
        const page = await env.FILES.list({ prefix: `${key}/`, cursor });
        const keys = (page.objects ?? []).map((o) => o.key);
        if (keys.length > 0) {
          await env.FILES.delete(keys); // R2 accepts up to 1000 keys per call
          removed += keys.length;
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);

      if (await env.FILES.head(key)) {
        await env.FILES.delete(key);
        removed += 1;
      }
      if (removed === 0) throw new ToolError(`nothing to delete at ${key}`);
      return `deleted ${removed} object(s) under ${key}`;
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

/** Constant-time string compare. Workers has no timingSafeEqual. */
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

    // Unauthenticated liveness probe. Reveals nothing about the bucket.
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

    // Stateless: no sessions, so there is no server-initiated stream to open.
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
