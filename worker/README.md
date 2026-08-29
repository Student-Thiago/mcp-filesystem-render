# MCP filesystem Worker (R2-backed)

The Worker is the URL an MCP client connects to. It authenticates each request,
then reads and writes objects in an R2 bucket on the AI's behalf.

```
MCP client  ──HTTPS──▶  Worker /mcp  ──binding──▶  R2 bucket
            bearer token            (no network hop)
```

R2 free tier: 10 GB stored, 1M writes/month, 10M reads/month, no egress fees.
Workers free tier: 100k requests/day. No sleep, no cold-start penalty worth
worrying about, no persistent disk needed.

## Deploy

Requires Node and a Cloudflare account. Run from the `worker/` directory.

```bash
cd worker
npx wrangler login
npx wrangler r2 bucket create mcp-filesystem
npx wrangler secret put MCP_TOKEN     # paste a long random string
npx wrangler deploy
```

Generate a token with `openssl rand -hex 32` if you need one.

Deploy prints the URL, e.g. `https://mcp-filesystem.<subdomain>.workers.dev`.

## Verify

```bash
curl https://YOUR-WORKER.workers.dev/healthz
# ok

curl -s https://YOUR-WORKER.workers.dev/mcp \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# {"jsonrpc":"2.0","id":1,"result":{"tools":[...]}}
```

Without the header the same request returns 401. That is the auth working.

## Connect

```json
{
  "mcpServers": {
    "filesystem-r2": {
      "url": "https://YOUR-WORKER.workers.dev/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

## Tools

| Tool | Notes |
| --- | --- |
| `list_directory` | Uses R2 prefix + delimiter listing. Paginates. |
| `read_file` | UTF-8 text, 2 MiB cap. |
| `write_file` | Overwrites. 2 MiB cap. |
| `create_directory` | Writes a `.keep` placeholder; R2 has no real directories. |
| `delete_path` | Single object by default. `recursive: true` deletes a subtree. |

## Design notes

- **Stateless.** No sessions, so any Worker isolate can serve any request and
  cold starts cost nothing. Server-initiated streams are not supported.
- **Path containment.** R2 keys are flat strings. `normalizeKey` resolves `.`
  and `..` and rejects anything climbing above the root, so there is no
  traversal and no symlinks to worry about.
- **Auth.** Bearer token compared in constant time. A `workers.dev` URL is
  permanently public, so the token is the only thing standing between the
  internet and a bucket with a delete tool. Rotate with
  `wrangler secret put MCP_TOKEN`.
- **Empty on first deploy.** This is durable scratch storage, not a checkout of
  a repository.

## Untested

This has not been executed. The first `wrangler deploy` and the curl above are
the real test.
