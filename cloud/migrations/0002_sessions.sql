CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX sessions_expiry ON sessions (expires_at);
