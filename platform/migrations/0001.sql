PRAGMA foreign_keys = ON;

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('owner', 'guest')),
  created_at INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE REFERENCES tenants(id),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL
);

CREATE TABLE sessions (
  hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'guest')),
  expires INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires);

CREATE TABLE api_keys (
  hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
);
CREATE INDEX api_keys_tenant ON api_keys(tenant_id);

CREATE TABLE auth_attempts (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX auth_attempts_expiry ON auth_attempts(expires);
