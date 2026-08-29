-- Schema for the D1-backed MCP filesystem.
--
-- Files are rows. There is no directory table: a directory exists if any file
-- has it as a path prefix. `create_directory` inserts a hidden placeholder so
-- an empty directory can still be listed.

CREATE TABLE IF NOT EXISTS files (
  path        TEXT PRIMARY KEY,
  content     TEXT NOT NULL DEFAULT '',
  size        INTEGER NOT NULL DEFAULT 0,
  is_marker   INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Directory listings filter on a path prefix. Without this index every listing
-- is a full table scan, which burns the daily rows-read allowance fast.
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
