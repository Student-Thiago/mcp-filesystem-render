-- Filesystem modelled as a single table of nodes.
--
-- Apply before first use:
--   npx wrangler d1 execute mcp-filesystem --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS nodes (
  -- Canonical path: no leading slash, no "." or ".." segments.
  -- The root is the empty parent, and is implicit rather than a row.
  path       TEXT PRIMARY KEY,
  parent     TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('file', 'dir')),
  content    TEXT,
  size       INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,

  -- Directories hold no bytes; files always carry content.
  CHECK ((kind = 'dir' AND content IS NULL) OR (kind = 'file' AND content IS NOT NULL))
);

-- list_directory reads by parent, so this index keeps listings off a table scan
-- and keeps "rows read" (what D1 bills) proportional to the directory size.
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes (parent);
