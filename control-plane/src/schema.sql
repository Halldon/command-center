CREATE SCHEMA IF NOT EXISTS command_center;
SET search_path TO command_center, public;

CREATE TABLE IF NOT EXISTS project_adapters (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  owner TEXT,
  priority TEXT,
  aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  heartbeat_interval_seconds INTEGER NOT NULL DEFAULT 600,
  max_event_age_seconds INTEGER NOT NULL DEFAULT 1800,
  required_metrics JSONB NOT NULL DEFAULT '[]'::jsonb,
  severity_map JSONB NOT NULL DEFAULT '{}'::jsonb,
  runbook_links JSONB NOT NULL DEFAULT '{}'::jsonb,
  event_types JSONB NOT NULL DEFAULT '["heartbeat","metric","action","incident"]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ingest_keys (
  key_id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES project_adapters(project_id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  event_uid TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES project_adapters(project_id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  event_time TIMESTAMPTZ NOT NULL,
  severity TEXT,
  trace_id TEXT,
  span_id TEXT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload JSONB NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_events_project_time ON events(project_id, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_events_ingested_time ON events(ingested_at DESC);

CREATE TABLE IF NOT EXISTS dead_letter_events (
  id BIGSERIAL PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  project_id TEXT,
  reason TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_received ON dead_letter_events(received_at DESC);

CREATE TABLE IF NOT EXISTS project_state (
  project_id TEXT PRIMARY KEY REFERENCES project_adapters(project_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'unknown',
  severity TEXT NOT NULL DEFAULT 'info',
  stale BOOLEAN NOT NULL DEFAULT TRUE,
  missed_intervals INTEGER,
  missing_metrics JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_event_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  last_event_id TEXT,
  last_event_type TEXT,
  last_idempotency_key TEXT,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  heartbeat_interval_seconds INTEGER NOT NULL DEFAULT 600,
  max_event_age_seconds INTEGER NOT NULL DEFAULT 1800,
  required_metrics JSONB NOT NULL DEFAULT '[]'::jsonb,
  runbook_links JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_state_updated ON project_state(updated_at DESC);

CREATE TABLE IF NOT EXISTS incidents (
  id BIGSERIAL PRIMARY KEY,
  incident_uid TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES project_adapters(project_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  runbook TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_incidents_project_time ON incidents(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status, created_at DESC);
