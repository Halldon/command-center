const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withTx, query } = require('./db');

const CORE_CE_FIELDS = new Set([
  'specversion',
  'id',
  'source',
  'type',
  'time',
  'subject',
  'datacontenttype',
  'dataschema',
  'data'
]);

const DEFAULT_SEVERITY_MAP = {
  ok: 'ok',
  info: 'ok',
  warn: 'warn',
  warning: 'warn',
  degraded: 'warn',
  critical: 'critical',
  error: 'critical',
  stale: 'critical'
};

function nowIso() {
  return new Date().toISOString();
}

function parseIso(value) {
  const n = Date.parse(String(value || ''));
  return Number.isFinite(n) ? n : 0;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function toObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function hashToken(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeCloudEvent(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object') {
    return { error: 'event must be an object' };
  }
  const event = rawEvent.event && typeof rawEvent.event === 'object' ? rawEvent.event : rawEvent;
  const specversion = String(event.specversion || '1.0').trim();
  const id = String(event.id || '').trim();
  const source = String(event.source || '').trim();
  const type = String(event.type || '').trim();
  const subject = String(event.subject || '').trim();
  const timeRaw = String(event.time || nowIso()).trim();
  const datacontenttype = String(event.datacontenttype || 'application/json').trim();
  const dataschema = String(event.dataschema || '').trim();
  const data = toObject(event.data, {});
  if (!specversion || !id || !source || !type) {
    return { error: 'CloudEvent requires specversion,id,source,type' };
  }
  const timeMs = parseIso(timeRaw);
  if (!timeMs) return { error: 'CloudEvent time must be a valid ISO timestamp' };
  const extensions = {};
  for (const [key, value] of Object.entries(event)) {
    if (CORE_CE_FIELDS.has(key)) continue;
    extensions[key] = value;
  }
  return {
    event: {
      specversion,
      id,
      source,
      type,
      subject,
      time: new Date(timeMs).toISOString(),
      datacontenttype,
      dataschema,
      data,
      extensions
    }
  };
}

function eventTypeKey(type) {
  const raw = String(type || '').toLowerCase().trim();
  if (!raw) return '';
  const parts = raw.split(/[./]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : raw;
}

function eventIsHeartbeat(type) {
  const key = eventTypeKey(type);
  return ['heartbeat', 'pulse', 'health', 'status'].includes(key) || /heartbeat|pulse|health/.test(String(type || '').toLowerCase());
}

function resolveSeverity(adapter, event) {
  const map = { ...DEFAULT_SEVERITY_MAP, ...toObject(adapter.severity_map, {}) };
  const raw = String(
    event.data?.severity ||
    event.extensions?.severity ||
    event.data?.status ||
    ''
  ).toLowerCase().trim();
  if (!raw) return 'info';
  return map[raw] || raw;
}

function resolveStatus(event, severity) {
  const status = String(event.data?.status || '').toLowerCase().trim();
  if (status) return status;
  if (severity === 'critical') return 'critical';
  if (severity === 'warn') return 'warn';
  if (severity === 'ok') return 'ok';
  return 'monitoring';
}

function readJsonFile(filePath, fallback = {}) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function idempotencyKey(event, explicit = '') {
  const provided = String(explicit || '').trim();
  if (provided) return provided.slice(0, 220);
  const dataHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(event.data || {}))
    .digest('hex')
    .slice(0, 16);
  return `${event.source}|${event.id}|${event.type}|${event.time}|${dataHash}`;
}

function adapterKeySet(adapter) {
  const keys = new Set();
  const add = (value) => {
    const key = slugify(value);
    if (key) keys.add(key);
  };
  add(adapter.project_id);
  add(adapter.name);
  toArray(adapter.aliases).forEach(add);
  return keys;
}

function buildAdapterLookup(adapters) {
  const byId = new Map();
  const aliases = new Map();
  adapters.forEach((adapter) => {
    byId.set(adapter.project_id, adapter);
    adapterKeySet(adapter).forEach((key) => {
      if (!aliases.has(key)) aliases.set(key, adapter.project_id);
    });
  });
  return { byId, aliases };
}

function resolveProjectId(event, lookup) {
  const candidates = [
    event.extensions?.projectid,
    event.extensions?.project_id,
    event.data?.projectId,
    event.data?.project_id,
    event.subject
  ];
  for (const candidate of candidates) {
    const key = slugify(candidate);
    if (!key) continue;
    if (lookup.aliases.has(key)) return lookup.aliases.get(key);
  }
  return '';
}

function adapterAllowsType(adapter, type) {
  const allowed = toArray(adapter.event_types).map((item) => String(item || '').toLowerCase().trim()).filter(Boolean);
  if (!allowed.length) return true;
  const normalized = String(type || '').toLowerCase().trim();
  const key = eventTypeKey(normalized);
  return allowed.includes(normalized) || allowed.includes(key);
}

function normalizeStateRow(adapter, existing = {}) {
  return {
    project_id: adapter.project_id,
    status: String(existing.status || 'unknown'),
    severity: String(existing.severity || 'info'),
    stale: existing.stale === true,
    missed_intervals: Number.isFinite(Number(existing.missed_intervals)) ? Number(existing.missed_intervals) : null,
    missing_metrics: toArray(existing.missing_metrics),
    last_event_at: existing.last_event_at ? new Date(existing.last_event_at).toISOString() : null,
    last_heartbeat_at: existing.last_heartbeat_at ? new Date(existing.last_heartbeat_at).toISOString() : null,
    last_event_id: existing.last_event_id || null,
    last_event_type: existing.last_event_type || null,
    last_idempotency_key: existing.last_idempotency_key || null,
    metrics: toObject(existing.metrics, {}),
    attributes: toObject(existing.attributes, {}),
    details: toObject(existing.details, {}),
    heartbeat_interval_seconds: Number(existing.heartbeat_interval_seconds || adapter.heartbeat_interval_seconds || 600),
    max_event_age_seconds: Number(existing.max_event_age_seconds || adapter.max_event_age_seconds || 1800),
    required_metrics: toArray(existing.required_metrics).length ? toArray(existing.required_metrics) : toArray(adapter.required_metrics),
    runbook_links: {
      ...toObject(adapter.runbook_links, {}),
      ...toObject(existing.runbook_links, {})
    },
    updated_at: existing.updated_at ? new Date(existing.updated_at).toISOString() : nowIso()
  };
}

function stateSummary(row) {
  if (row.stale) {
    return `Heartbeat stale (${Number.isFinite(row.missed_intervals) ? `${row.missed_intervals} missed intervals` : 'no heartbeat'})`;
  }
  if (row.last_event_type) {
    return `Last event: ${row.last_event_type}`;
  }
  return 'No realtime events yet.';
}

function eventTraceAttrs(event) {
  const ext = toObject(event.extensions, {});
  const data = toObject(event.data, {});
  return {
    trace_id: String(ext.traceid || ext.trace_id || data.trace_id || data.traceId || '').trim() || null,
    span_id: String(ext.spanid || ext.span_id || data.span_id || data.spanId || '').trim() || null
  };
}

function incidentUid(projectId, kind, marker) {
  return `${projectId}:${kind}:${marker || 'none'}`;
}

function buildIncident(projectId, kind, severity, message, detail, runbook, marker) {
  return {
    incident_uid: incidentUid(projectId, kind, marker),
    project_id: projectId,
    kind,
    severity,
    message,
    detail: detail || {},
    runbook: runbook || null
  };
}

function parseMissedIntervals(nowMs, lastHeartbeatAt, intervalSeconds) {
  if (!lastHeartbeatAt) return Number.POSITIVE_INFINITY;
  const lastMs = parseIso(lastHeartbeatAt);
  if (!lastMs) return Number.POSITIVE_INFINITY;
  const intervalMs = Math.max(1000, Number(intervalSeconds || 600) * 1000);
  return Math.max(0, Math.floor((nowMs - lastMs) / intervalMs));
}

function applyEventToStateRow(row, adapter, event, idempotency, incidents) {
  const isHeartbeat = eventIsHeartbeat(event.type);
  row.last_event_at = event.time;
  row.last_event_id = event.id;
  row.last_event_type = event.type;
  row.last_idempotency_key = idempotency;
  row.attributes = {
    ...toObject(row.attributes, {}),
    ...toObject(event.extensions, {})
  };
  row.details = {
    ...toObject(row.details, {}),
    ...toObject(event.data, {})
  };

  const severity = resolveSeverity(adapter, event);
  const status = resolveStatus(event, severity);

  if (isHeartbeat) {
    row.last_heartbeat_at = event.time;
    row.metrics = toObject(event.data?.metrics, row.metrics || {});
    row.required_metrics = toArray(adapter.required_metrics);
    row.runbook_links = toObject(adapter.runbook_links, row.runbook_links || {});
    row.heartbeat_interval_seconds = Number(adapter.heartbeat_interval_seconds || row.heartbeat_interval_seconds || 600);
    row.max_event_age_seconds = Number(adapter.max_event_age_seconds || row.max_event_age_seconds || 1800);
    const missing = toArray(row.required_metrics).filter((metric) => {
      const key = String(metric || '');
      if (!key) return false;
      const value = row.metrics ? row.metrics[key] : undefined;
      return value === undefined || value === null || value === '';
    });
    row.missing_metrics = missing;
    row.status = missing.length ? 'warn' : status;
    row.severity = missing.length ? 'warn' : severity;
    row.stale = false;
    row.missed_intervals = 0;
    if (missing.length) {
      incidents.push(buildIncident(
        adapter.project_id,
        'missing_metrics',
        'warn',
        `Heartbeat missing required metrics: ${missing.join(', ')}`,
        { missingMetrics: missing, eventId: event.id },
        toObject(adapter.runbook_links, {}).prevent || toObject(adapter.runbook_links, {}).solve,
        event.id
      ));
    }
  } else {
    row.status = status || row.status;
    row.severity = severity || row.severity;
  }
  row.updated_at = nowIso();
}

function applyFreshnessSweep(rowsById, adapters, staleAfterMissedHeartbeats) {
  const incidents = [];
  const nowMs = Date.now();
  const staleRows = [];

  adapters.forEach((adapter) => {
    const row = rowsById.get(adapter.project_id) || normalizeStateRow(adapter, {});
    const previousStale = row.stale === true;
    const missed = parseMissedIntervals(nowMs, row.last_heartbeat_at, adapter.heartbeat_interval_seconds);
    const stale = missed >= staleAfterMissedHeartbeats;
    row.stale = stale;
    row.missed_intervals = Number.isFinite(missed) ? missed : null;
    row.heartbeat_interval_seconds = Number(adapter.heartbeat_interval_seconds || row.heartbeat_interval_seconds || 600);
    row.max_event_age_seconds = Number(adapter.max_event_age_seconds || row.max_event_age_seconds || 1800);
    row.required_metrics = toArray(adapter.required_metrics);
    row.runbook_links = toObject(adapter.runbook_links, row.runbook_links || {});
    if (stale) {
      row.status = 'stale';
      row.severity = 'critical';
      staleRows.push({
        projectId: adapter.project_id,
        projectName: adapter.name,
        missedIntervals: row.missed_intervals,
        heartbeatIntervalSeconds: row.heartbeat_interval_seconds,
        lastHeartbeatAt: row.last_heartbeat_at || null,
        runbook: row.runbook_links?.solve || row.runbook_links?.reviews || null
      });
      if (!previousStale) {
        incidents.push(buildIncident(
          adapter.project_id,
          'stale',
          'critical',
          `Heartbeat missed >=${staleAfterMissedHeartbeats} intervals.`,
          {
            missedIntervals: row.missed_intervals,
            intervalSeconds: row.heartbeat_interval_seconds,
            lastHeartbeatAt: row.last_heartbeat_at || null
          },
          row.runbook_links?.solve || row.runbook_links?.reviews || null,
          row.last_heartbeat_at || 'none'
        ));
      }
    } else if (previousStale) {
      incidents.push(buildIncident(
        adapter.project_id,
        'recovered',
        'ok',
        'Heartbeat recovered within freshness SLO.',
        {
          lastHeartbeatAt: row.last_heartbeat_at || null
        },
        row.runbook_links?.reviews || row.runbook_links?.solve || null,
        row.last_heartbeat_at || nowIso()
      ));
    }
    row.updated_at = nowIso();
    rowsById.set(adapter.project_id, row);
  });

  return { incidents, staleRows };
}

async function loadAdapters(client) {
  const { rows } = await client.query(
    `
      SELECT
        project_id,
        name,
        type,
        owner,
        priority,
        aliases,
        heartbeat_interval_seconds,
        max_event_age_seconds,
        required_metrics,
        severity_map,
        runbook_links,
        event_types
      FROM project_adapters
      WHERE active = TRUE
      ORDER BY project_id
    `
  );
  return rows.map((row) => ({
    ...row,
    aliases: toArray(row.aliases),
    required_metrics: toArray(row.required_metrics),
    severity_map: toObject(row.severity_map, {}),
    runbook_links: toObject(row.runbook_links, {}),
    event_types: toArray(row.event_types)
  }));
}

async function loadStateRows(client) {
  const { rows } = await client.query('SELECT * FROM project_state');
  const map = new Map();
  rows.forEach((row) => {
    map.set(row.project_id, normalizeStateRow({ project_id: row.project_id }, row));
  });
  return map;
}

async function persistStateRow(client, row) {
  await client.query(
    `
      INSERT INTO project_state (
        project_id, status, severity, stale, missed_intervals, missing_metrics,
        last_event_at, last_heartbeat_at, last_event_id, last_event_type, last_idempotency_key,
        metrics, attributes, details, heartbeat_interval_seconds, max_event_age_seconds,
        required_metrics, runbook_links, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6::jsonb,
        $7, $8, $9, $10, $11,
        $12::jsonb, $13::jsonb, $14::jsonb, $15, $16,
        $17::jsonb, $18::jsonb, now()
      )
      ON CONFLICT (project_id) DO UPDATE SET
        status = EXCLUDED.status,
        severity = EXCLUDED.severity,
        stale = EXCLUDED.stale,
        missed_intervals = EXCLUDED.missed_intervals,
        missing_metrics = EXCLUDED.missing_metrics,
        last_event_at = EXCLUDED.last_event_at,
        last_heartbeat_at = EXCLUDED.last_heartbeat_at,
        last_event_id = EXCLUDED.last_event_id,
        last_event_type = EXCLUDED.last_event_type,
        last_idempotency_key = EXCLUDED.last_idempotency_key,
        metrics = EXCLUDED.metrics,
        attributes = EXCLUDED.attributes,
        details = EXCLUDED.details,
        heartbeat_interval_seconds = EXCLUDED.heartbeat_interval_seconds,
        max_event_age_seconds = EXCLUDED.max_event_age_seconds,
        required_metrics = EXCLUDED.required_metrics,
        runbook_links = EXCLUDED.runbook_links,
        updated_at = now()
    `,
    [
      row.project_id,
      row.status,
      row.severity,
      row.stale === true,
      row.missed_intervals,
      JSON.stringify(toArray(row.missing_metrics)),
      row.last_event_at ? new Date(row.last_event_at) : null,
      row.last_heartbeat_at ? new Date(row.last_heartbeat_at) : null,
      row.last_event_id,
      row.last_event_type,
      row.last_idempotency_key,
      JSON.stringify(toObject(row.metrics, {})),
      JSON.stringify(toObject(row.attributes, {})),
      JSON.stringify(toObject(row.details, {})),
      Number(row.heartbeat_interval_seconds || 600),
      Number(row.max_event_age_seconds || 1800),
      JSON.stringify(toArray(row.required_metrics)),
      JSON.stringify(toObject(row.runbook_links, {}))
    ]
  );
}

async function insertIncident(client, incident) {
  await client.query(
    `
      INSERT INTO incidents (
        incident_uid, project_id, kind, severity, message, detail, runbook
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      ON CONFLICT (incident_uid) DO NOTHING
    `,
    [
      incident.incident_uid,
      incident.project_id,
      incident.kind,
      incident.severity,
      incident.message,
      JSON.stringify(toObject(incident.detail, {})),
      incident.runbook || null
    ]
  );
}

async function deadLetter(client, reason, payload, details = {}, projectId = null) {
  await client.query(
    `
      INSERT INTO dead_letter_events (project_id, reason, details, payload)
      VALUES ($1, $2, $3::jsonb, $4::jsonb)
    `,
    [projectId, reason, JSON.stringify(toObject(details, {})), JSON.stringify(toObject(payload, payload))]
  );
}

async function ingestCloudEventsDb(payload, headers, config) {
  const headerIdempotency = String(headers['idempotency-key'] || '').trim();
  return withTx(config.databaseUrl, async (client) => {
    const adapters = await loadAdapters(client);
    const lookup = buildAdapterLookup(adapters);
    const rowsById = await loadStateRows(client);
    adapters.forEach((adapter) => {
      if (!rowsById.has(adapter.project_id)) {
        rowsById.set(adapter.project_id, normalizeStateRow(adapter, {}));
      } else {
        rowsById.set(adapter.project_id, normalizeStateRow(adapter, rowsById.get(adapter.project_id)));
      }
    });

    const rawEvents = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.events)
        ? payload.events
        : [payload];

    const accepted = [];
    const duplicates = [];
    const rejected = [];
    const incidentQueue = [];
    const touchedProjects = new Set();

    for (const rawEvent of rawEvents) {
      const normalized = normalizeCloudEvent(rawEvent);
      if (normalized.error) {
        rejected.push({ reason: normalized.error });
        await deadLetter(client, normalized.error, rawEvent, { stage: 'normalize' });
        continue;
      }
      const event = normalized.event;
      const projectId = resolveProjectId(event, lookup);
      if (!projectId || !lookup.byId.has(projectId)) {
        const reason = 'unknown_project_adapter';
        rejected.push({ eventId: event.id, reason });
        await deadLetter(client, reason, event, { stage: 'project_resolve' }, projectId || null);
        continue;
      }
      const adapter = lookup.byId.get(projectId);
      if (!adapterAllowsType(adapter, event.type)) {
        const reason = 'event_type_not_allowed';
        rejected.push({ eventId: event.id, projectId, reason });
        await deadLetter(client, reason, event, { allowedTypes: adapter.event_types }, projectId);
        continue;
      }

      const ageSec = Math.max(0, Math.floor((Date.now() - parseIso(event.time)) / 1000));
      if (ageSec > Number(adapter.max_event_age_seconds || 1800)) {
        const reason = 'stale_event_rejected';
        rejected.push({
          eventId: event.id,
          projectId,
          reason,
          eventAgeSec: ageSec,
          maxEventAgeSeconds: adapter.max_event_age_seconds
        });
        await deadLetter(client, reason, event, {
          eventAgeSec: ageSec,
          maxEventAgeSeconds: adapter.max_event_age_seconds
        }, projectId);
        continue;
      }

      const explicitIdempotency = String(rawEvent?.idempotencyKey || payload?.idempotencyKey || headerIdempotency || '').trim();
      const dedupeKey = idempotencyKey(event, explicitIdempotency);
      const trace = eventTraceAttrs(event);
      const severity = resolveSeverity(adapter, event);
      const insertEvent = await client.query(
        `
          INSERT INTO events (
            event_uid, idempotency_key, project_id, source, type, event_time,
            severity, trace_id, span_id, attributes, payload
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
          ON CONFLICT (project_id, idempotency_key) DO NOTHING
          RETURNING id
        `,
        [
          event.id,
          dedupeKey,
          projectId,
          event.source,
          event.type,
          new Date(event.time),
          severity,
          trace.trace_id,
          trace.span_id,
          JSON.stringify(toObject(event.extensions, {})),
          JSON.stringify(event)
        ]
      );

      if (!insertEvent.rowCount) {
        duplicates.push({
          eventId: event.id,
          projectId,
          idempotencyKey: dedupeKey
        });
        continue;
      }

      const row = rowsById.get(projectId) || normalizeStateRow(adapter, {});
      applyEventToStateRow(row, adapter, event, dedupeKey, incidentQueue);
      rowsById.set(projectId, row);
      touchedProjects.add(projectId);
      accepted.push({
        eventId: event.id,
        projectId,
        idempotencyKey: dedupeKey
      });
    }

    const freshness = applyFreshnessSweep(
      rowsById,
      adapters,
      Number(config.staleAfterMissedHeartbeats || 2)
    );
    freshness.incidents.forEach((row) => incidentQueue.push(row));

    for (const projectId of new Set([...touchedProjects, ...freshness.staleRows.map((row) => row.projectId)])) {
      const row = rowsById.get(projectId);
      if (!row) continue;
      await persistStateRow(client, row);
    }
    for (const incident of incidentQueue) {
      await insertIncident(client, incident);
    }

    return {
      ok: rejected.length === 0,
      accepted,
      duplicates,
      rejected,
      summary: {
        received: rawEvents.length,
        accepted: accepted.length,
        duplicates: duplicates.length,
        rejected: rejected.length,
        staleProjects: freshness.staleRows.length
      }
    };
  });
}

async function evaluateFreshnessSweep(config) {
  return withTx(config.databaseUrl, async (client) => {
    const adapters = await loadAdapters(client);
    const rowsById = await loadStateRows(client);
    adapters.forEach((adapter) => {
      if (!rowsById.has(adapter.project_id)) {
        rowsById.set(adapter.project_id, normalizeStateRow(adapter, {}));
      } else {
        rowsById.set(adapter.project_id, normalizeStateRow(adapter, rowsById.get(adapter.project_id)));
      }
    });
    const freshness = applyFreshnessSweep(
      rowsById,
      adapters,
      Number(config.staleAfterMissedHeartbeats || 2)
    );
    for (const adapter of adapters) {
      const row = rowsById.get(adapter.project_id);
      if (!row) continue;
      await persistStateRow(client, row);
    }
    for (const incident of freshness.incidents) {
      await insertIncident(client, incident);
    }
    return freshness;
  });
}

async function ingestStats(config) {
  const [eventsCount, duplicatesApprox, deadLetterCount] = await Promise.all([
    query('SELECT COUNT(*)::bigint AS c FROM events', [], config.databaseUrl),
    query('SELECT COUNT(*)::bigint AS c FROM events WHERE false', [], config.databaseUrl),
    query('SELECT COUNT(*)::bigint AS c FROM dead_letter_events', [], config.databaseUrl)
  ]);
  const acceptedEvents = Number(eventsCount.rows[0]?.c || 0);
  const rejectedEvents = Number(deadLetterCount.rows[0]?.c || 0);
  return {
    totalEvents: acceptedEvents + rejectedEvents,
    acceptedEvents,
    duplicateEvents: Number(duplicatesApprox.rows[0]?.c || 0),
    rejectedEvents,
    lastEventAt: null,
    lastHeartbeatAt: null
  };
}

async function publishedVersion(config) {
  const { rows } = await query(
    `
      SELECT
        GREATEST(
          COALESCE((SELECT EXTRACT(EPOCH FROM MAX(updated_at)) * 1000 FROM project_state), 0),
          COALESCE((SELECT EXTRACT(EPOCH FROM MAX(created_at)) * 1000 FROM incidents), 0),
          COALESCE((SELECT EXTRACT(EPOCH FROM MAX(ingested_at)) * 1000 FROM events), 0)
        )::bigint AS version_ms
    `,
    [],
    config.databaseUrl
  );
  return String(rows[0]?.version_ms || 0);
}

async function loadPublishedState(config) {
  const baseline = readJsonFile(config.baselineSnapshotPath, {
    schemaVersion: '2.0.0',
    generatedAt: nowIso(),
    headline: { globalStatus: 'monitoring' },
    projects: []
  });
  const [adaptersRes, stateRes, incidentsRes, version] = await Promise.all([
    query(
      `
      SELECT
        project_id,
        name,
        type,
        owner,
        priority,
        required_metrics,
        runbook_links,
        heartbeat_interval_seconds,
        max_event_age_seconds
      FROM project_adapters
      WHERE active = TRUE
      ORDER BY project_id
      `,
      [],
      config.databaseUrl
    ),
    query(
      `
      SELECT *
      FROM project_state
      ORDER BY project_id
      `,
      [],
      config.databaseUrl
    ),
    query(
      `
      SELECT
        incident_uid,
        project_id,
        kind,
        severity,
        message,
        detail,
        runbook,
        status,
        created_at
      FROM incidents
      ORDER BY created_at DESC
      LIMIT 100
      `,
      [],
      config.databaseUrl
    ),
    publishedVersion(config)
  ]);

  const adapters = adaptersRes.rows.map((row) => ({
    ...row,
    required_metrics: toArray(row.required_metrics),
    runbook_links: toObject(row.runbook_links, {})
  }));
  const byProjectState = new Map();
  stateRes.rows.forEach((row) => {
    byProjectState.set(row.project_id, normalizeStateRow({ project_id: row.project_id }, row));
  });
  const stateRows = adapters.map((adapter) => {
    const row = normalizeStateRow(adapter, byProjectState.get(adapter.project_id) || {});
    row.name = adapter.name;
    row.type = adapter.type;
    row.owner = adapter.owner || '';
    row.priority = adapter.priority || '';
    return row;
  });

  const staleProjects = stateRows
    .filter((row) => row.stale)
    .map((row) => ({
      projectId: row.project_id,
      projectName: row.name,
      missedIntervals: row.missed_intervals,
      heartbeatIntervalSeconds: row.heartbeat_interval_seconds,
      lastHeartbeatAt: row.last_heartbeat_at || null,
      runbook: row.runbook_links?.solve || row.runbook_links?.reviews || null
    }));

  const incidents = incidentsRes.rows.map((row) => ({
    id: row.incident_uid,
    ts: new Date(row.created_at).toISOString(),
    projectId: row.project_id,
    kind: row.kind,
    severity: row.severity,
    message: row.message,
    detail: toObject(row.detail, {}),
    runbook: row.runbook || '',
    status: row.status || 'open'
  }));

  const ingestion = await ingestStats(config);
  const generatedAt = Number(version) > 0 ? new Date(Number(version)).toISOString() : nowIso();

  const snapshot = toObject(baseline, {});
  snapshot.generatedAt = generatedAt;
  snapshot.realtime = {
    schemaVersion: 'cc.realtime.v1',
    source: 'control-plane-postgres',
    generatedAt,
    staleCount: staleProjects.length,
    staleProjects,
    incidents: incidents.slice(0, 50),
    ingestion: {
      ...ingestion,
      lastEvaluationAt: nowIso()
    },
    projects: stateRows.reduce((acc, row) => {
      acc[row.project_id] = {
        projectId: row.project_id,
        name: row.name,
        type: row.type,
        owner: row.owner,
        priority: row.priority,
        status: row.status,
        severity: row.severity,
        stale: row.stale,
        missedIntervals: row.missed_intervals,
        missingMetrics: toArray(row.missing_metrics),
        lastEventAt: row.last_event_at,
        lastHeartbeatAt: row.last_heartbeat_at,
        lastEventId: row.last_event_id,
        lastEventType: row.last_event_type,
        requiredMetrics: toArray(row.required_metrics),
        runbookLinks: toObject(row.runbook_links, {}),
        heartbeatIntervalSeconds: row.heartbeat_interval_seconds,
        maxEventAgeSeconds: row.max_event_age_seconds,
        metrics: toObject(row.metrics, {}),
        attributes: toObject(row.attributes, {}),
        details: toObject(row.details, {})
      };
      return acc;
    }, {})
  };

  snapshot.incidentFeed = incidents.slice(0, 40).map((incident) => ({
    at: incident.ts,
    severity: incident.severity,
    item: `[${incident.projectId}] ${incident.message}`
  }));

  const baseProjects = toArray(snapshot.projects);
  const projectMap = new Map();
  baseProjects.forEach((row) => {
    const key = slugify(row?.id || row?.projectId || row?.name);
    if (key) projectMap.set(key, { ...row });
  });
  stateRows.forEach((row) => {
    const key = slugify(row.project_id || row.name);
    const existing = key ? projectMap.get(key) : null;
    const summary = stateSummary(row);
    const next = {
      ...(existing || {}),
      name: existing?.name || row.name || row.project_id,
      status: row.status || existing?.status || 'unknown',
      summary,
      lastUpdate: row.last_event_at || row.last_heartbeat_at || nowIso()
    };
    if (key) projectMap.set(key, next);
  });
  snapshot.projects = [...projectMap.values()];
  if (!snapshot.headline || typeof snapshot.headline !== 'object') snapshot.headline = {};
  snapshot.headline.globalStatus = staleProjects.length ? 'critical' : (snapshot.headline.globalStatus || 'monitoring');

  return {
    state: snapshot,
    version
  };
}

function projectScopeAllowed(apiKey, projectId) {
  if (!apiKey) return false;
  if (!apiKey.active) return false;
  if (!apiKey.project_id) return true;
  return String(apiKey.project_id) === String(projectId);
}

async function resolveIngestAuthToken(rawToken, config) {
  const token = String(rawToken || '').trim();
  if (!token) return { ok: false, reason: 'missing_token' };
  if (config.ingestToken && token === config.ingestToken) {
    return { ok: true, key: { key_id: 'env-token', project_id: null, active: true, source: 'env' } };
  }
  if (config.ingestTokenSha256 && hashToken(token) === config.ingestTokenSha256) {
    return { ok: true, key: { key_id: 'env-token-sha', project_id: null, active: true, source: 'env' } };
  }
  const tokenHash = hashToken(token);
  const { rows } = await query(
    `
      SELECT key_id, project_id, active
      FROM ingest_keys
      WHERE secret_hash = $1
      LIMIT 1
    `,
    [tokenHash],
    config.databaseUrl
  );
  if (!rows.length) return { ok: false, reason: 'invalid_token' };
  return { ok: true, key: rows[0] };
}

module.exports = {
  normalizeCloudEvent,
  ingestCloudEventsDb,
  loadPublishedState,
  evaluateFreshnessSweep,
  resolveIngestAuthToken,
  projectScopeAllowed,
  hashToken,
  nowIso
};
