-- Tenant-scoped analytics, logs, explicit public status, and opt-in collection.
CREATE TABLE IF NOT EXISTS data_sites (
  write_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, origin)
);
CREATE INDEX IF NOT EXISTS data_sites_tenant ON data_sites(tenant_id);

CREATE TABLE IF NOT EXISTS data_records (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('pageview', 'event', 'log')),
  name TEXT,
  path TEXT,
  referrer TEXT,
  properties TEXT,
  service TEXT,
  level TEXT CHECK(level IN ('debug', 'info', 'warn', 'error')),
  message TEXT,
  trace_id TEXT,
  at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  site_id TEXT REFERENCES data_sites(write_id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY(tenant_id, id)
);
CREATE INDEX IF NOT EXISTS data_records_time ON data_records(tenant_id, at DESC);
CREATE INDEX IF NOT EXISTS data_records_retention ON data_records(tenant_id, received_at);

CREATE TABLE IF NOT EXISTS data_quotas (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bucket INTEGER NOT NULL,
  used INTEGER NOT NULL CHECK(used <= 1000),
  PRIMARY KEY(tenant_id, bucket)
);
CREATE TABLE IF NOT EXISTS data_site_quotas (
  site_id TEXT NOT NULL REFERENCES data_sites(write_id) ON DELETE CASCADE,
  bucket INTEGER NOT NULL,
  used INTEGER NOT NULL CHECK(used <= 200),
  PRIMARY KEY(site_id, bucket)
);

-- These run only for real inserts: exact replays are filtered by the INSERT.
-- D1 batch transactions roll back records and quota increments together.
CREATE TRIGGER IF NOT EXISTS data_record_budget BEFORE INSERT ON data_records
BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM data_records WHERE tenant_id = NEW.tenant_id) >= 10000
    THEN RAISE(ABORT, 'data_tenant_capacity') END;
  SELECT CASE WHEN NEW.site_id IS NOT NULL AND
    (SELECT count(*) FROM data_records WHERE tenant_id = NEW.tenant_id AND site_id = NEW.site_id) >= 2000
    THEN RAISE(ABORT, 'data_site_capacity') END;
  INSERT INTO data_quotas(tenant_id, bucket, used)
    VALUES(NEW.tenant_id, CAST(NEW.received_at / 3600000 AS INTEGER), 1)
    ON CONFLICT(tenant_id, bucket) DO UPDATE SET used = used + 1;
  INSERT INTO data_site_quotas(site_id, bucket, used)
    SELECT NEW.site_id, CAST(NEW.received_at / 3600000 AS INTEGER), 1 WHERE NEW.site_id IS NOT NULL
    ON CONFLICT(site_id, bucket) DO UPDATE SET used = used + 1;
END;

CREATE TABLE IF NOT EXISTS data_status (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0, 1))
);
CREATE TABLE IF NOT EXISTS data_status_updates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('investigating', 'monitoring', 'resolved')),
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS data_status_updates_time ON data_status_updates(tenant_id, at DESC);
