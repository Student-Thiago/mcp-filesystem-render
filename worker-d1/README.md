# MCP filesystem Worker (D1-backed)

Same idea as the R2 variant, but files live in a D1 SQLite database instead of
an object store. D1 needs no payment method on the Workers Free plan.

```
MCP client  ──HTTPS──▶  Worker /mcp  ──binding──▶  D1 database
            bearer token            (no network hop)
```

## Free tier

| | Limit |
| --- | --- |
| Storage per database | 500 MB |
| Storage per account | 5 GB |
| Rows read | 5M/day |
| Rows written | 100K/day |
| Queries per Worker invocation | 50 |
| Max row size | 2 MB (this server caps files at 1.5 MB) |

## Deploy from the dashboard (no CLI, works on a phone)

1. **Storage & Databases → D1 → Create** a database named `mcp-filesystem`.
2. Open its **Console** tab and paste the contents of `schema.sql`, then run it.
3. **Workers & Pages → Create → Worker.** Deploy the default template so the
   service exists.
4. **Edit code**, replace everything with `src/index.js`, and deploy.
5. **Settings → Bindings → Add → D1 database.** Variable name must be exactly
   `DB`, pointed at `mcp-filesystem`.
6. **Settings → Variables and Secrets → Add.** Type **Secret**, name
   `MCP_TOKEN`, value a long random string.
7. Redeploy. Bindings and secrets only take effect on the next deploy.

## Deploy from a terminal

```bash
cd worker-d1
npx wrangler d1 create mcp-filesystem      # paste the database_id into wrangler.toml
npx wrangler d1 execute mcp-filesystem --remote --file=./schema.sql
npx wrangler secret put MCP_TOKEN          # openssl rand -hex 32
npx wrangler deploy
```

## Verify

```bash
curl https://YOUR-WORKER.workers.dev/healthz
# ok

curl -s https://YOUR-WORKER.workers.dev/mcp \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Failure modes worth telling apart:

| Symptom | Cause |
| --- | --- |
| `MCP_TOKEN secret is not set` (500) | Step 6 missing, or no redeploy after it |
| 401 on every call | Token mismatch between client header and secret |
| `no such table: nodes` | Step 2 not run against the remote database |
| Tool errors mentioning `DB` | Binding missing or not named `DB` |

## Connect

```json
{
  "mcpServers": {
    "filesystem-d1": {
      "url": "https://YOUR-WORKER.workers.dev/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

## Design notes

- **One table, `nodes`.** Path is the primary key; `parent` is indexed so
  `list_directory` reads only that directory's rows. D1 bills rows read, so the
  index keeps cost proportional to directory size rather than tree size.
- **Directories are real rows.** Unlike R2, an empty directory can exist, and
  `write_file` backfills missing ancestors via `ensureParents`.
- **Path containment.** `.` and `..` are resolved away and anything climbing
  above the root is rejected. No symlinks exist in this model.
- **`delete_path` cannot target the root**, so no single call empties the tree.
  Recursive delete uses `GLOB` rather than `LIKE` because D1 caps `LIKE`
  patterns at 50 bytes.
- **Text only.** Content is a TEXT column. Binary would need base64, which
  inflates by a third against the 1.5 MB cap.
- **Time Travel** gives 7 days of point-in-time recovery on the free plan, which
  is a genuine advantage over the R2 variant.

## Untested

Not executed. First deploy plus the curl above is the real test.
