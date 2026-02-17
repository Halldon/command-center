const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RUNTIME_ROOT = process.env.COMMAND_CENTER_RUNTIME_ROOT
  ? path.resolve(process.env.COMMAND_CENTER_RUNTIME_ROOT)
  : path.join('/tmp', 'command-center', 'ingest');
const STATE_PATH = path.join(RUNTIME_ROOT, 'state.json');
const EVENTS_PATH = path.join(RUNTIME_ROOT, 'events.jsonl');
const INCIDENTS_PATH = path.join(RUNTIME_ROOT, 'incidents.jsonl');
const IDEMPOTENCY_PATH = path.join(RUNTIME_ROOT, 'idempotency.json');
const OPERATOR_CONFIG_PATH = path.join(process.cwd(), 'operator.config.json');
const SNAPSHOT_FALLBACK_PATH = path.join(process.cwd(), 'snapshot.json');

const DEFAULT_PROJECT_ADAPTER = {
  heartbeatIntervalSeconds: 300,
  maxEventAgeSeconds: 900,
  requiredMetrics: [],
  severityMap: {
    ok: 'ok',
    info: 'ok',
    warn: 'warn',
    warning: 'warn',
    degraded: 'warn',
    critical: 'critical',
    error: 'critical',
    stale: 'stale'
  },
  runbookLinks: {
    reviews: './docs/operator-quickstart.md',
    solve: './docs/verification.md',
    prevent: './docs/project-contract.md'
  }
};

const MAX_IDEMPOTENCY_KEYS = Number(process.env.COMMAND_CENTER_MAX_IDEMPOTENCY_KEYS || 50000);

function nowIso() {
  return new Date().toISOString();
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !/^(0|false|off|no)$/i.test(String(raw || '').trim());
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function escRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(filePath, payload) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath, row) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function readOperatorConfig() {
  return readJson(OPERATOR_CONFIG_PATH, {});
}

function projectTypeFromName(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('outreach')) return 'outreach';
  if (n.includes('polymarket') || n.includes('trading')) return 'polymarket';
  if (n.includes('ops') || n.includes('decision') || n.includes('automation')) return 'ops';
  if (n.includes('infra') || n.includes('reliability')) return 'infrastructure';
  return 'generic';
}

function projectKeySet(project) {
  const keys = new Set();
  const add = (value) => {
    const key = slugify(value);
    if (key) keys.add(key);
  };
  add(project?.name);
  add(project?.id);
  add(project?.projectId);
  add(project?.slug);
  (Array.isArray(project?.aliases) ? project.aliases : []).forEach(add);
  (Array.isArray(project?.matchNames) ? project.matchNames : []).forEach(add);
  return keys;
}

function normalizeAdapter(project) {
  const configured = project?.adapter && typeof project.adapter === 'object' ? project.adapter : {};
  const merged = {
    ...DEFAULT_PROJECT_ADAPTER,
    ...configured,
    runbookLinks: {
      ...DEFAULT_PROJECT_ADAPTER.runbookLinks,
      ...(configured.runbookLinks || {})
    },
    severityMap: {
      ...DEFAULT_PROJECT_ADAPTER.severityMap,
      ...(configured.severityMap || {})
    }
  };

  merged.heartbeatIntervalSeconds = clampNumber(
    merged.heartbeatIntervalSeconds,
    DEFAULT_PROJECT_ADAPTER.heartbeatIntervalSeconds,
    10,
    86400
  );
  merged.maxEventAgeSeconds = clampNumber(
    merged.maxEventAgeSeconds,
    Math.max(merged.heartbeatIntervalSeconds * 3, DEFAULT_PROJECT_ADAPTER.maxEventAgeSeconds),
    merged.heartbeatIntervalSeconds,
    7 * 86400
  );
  merged.requiredMetrics = (Array.isArray(merged.requiredMetrics) ? merged.requiredMetrics : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .slice(0, 64);
  return merged;
}

function adapterRegistry(operatorConfig = readOperatorConfig()) {
  const projects = Array.isArray(operatorConfig?.projects) ? operatorConfig.projects : [];
  const byId = {};
  const aliases = {};

  for (const project of projects) {
    const projectName = String(project?.name || '').trim();
    if (!projectName) continue;
    const projectId = slugify(project?.id || project?.projectId || project?.slug || projectName);
    if (!projectId) continue;
    const type = String(project?.type || '').trim() || projectTypeFromName(projectName);
    const adapter = normalizeAdapter(project);
    const contract = {
      projectId,
      name: projectName,
      type,
      owner: String(project?.owner || '').trim(),
      priority: String(project?.priority || '').trim(),
      heartbeatIntervalSeconds: adapter.heartbeatIntervalSeconds,
      maxEventAgeSeconds: adapter.maxEventAgeSeconds,
      requiredMetrics: adapter.requiredMetrics,
      severityMap: adapter.severityMap,
      runbookLinks: adapter.runbookLinks
    };
    byId[projectId] = contract;

    const keys = projectKeySet(project);
    keys.add(projectId);
    keys.forEach((key) => {
      aliases[key] = projectId;
    });
  }

  return { byId, aliases };
}

function parseIso(value) {
  const n = Date.parse(String(value || ''));
  return Number.isFinite(n) ? n : 0;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadBaselineSnapshot() {
  const snapshot = readJson(SNAPSHOT_FALLBACK_PATH, {});
  if (snapshot && typeof snapshot === 'object' && Object.keys(snapshot).length) {
    return snapshot;
  }
  return {
    schemaVersion: '2.0.0',
    generatedAt: nowIso(),
    headline: { globalStatus: 'monitoring' },
    projects: []
  };
}

function ensureProjectRealtimeRow(state, adapter) {
  const realtime = state.realtime || {};
  realtime.projects = realtime.projects && typeof realtime.projects === 'object' ? realtime.projects : {};
  state.realtime = realtime;

  if (!realtime.projects[adapter.projectId]) {
    realtime.projects[adapter.projectId] = {
      projectId: adapter.projectId,
      name: adapter.name,
      type: adapter.type,
      status: 'unknown',
      severity: 'info',
      stale: true,
      missedIntervals: null,
      lastHeartbeatAt: null,
      lastEventAt: null,
      lastEventType: null,
      lastEventId: null,
      lastIdempotencyKey: null,
      requiredMetrics: adapter.requiredMetrics,
      runbookLinks: adapter.runbookLinks,
      heartbeatIntervalSeconds: adapter.heartbeatIntervalSeconds,
      maxEventAgeSeconds: adapter.maxEventAgeSeconds,
      metrics: {},
      attributes: {},
      details: {}
    };
  }
  return realtime.projects[adapter.projectId];
}

function ensureStateInitialized() {
  if (fs.existsSync(STATE_PATH)) return;
  const baseline = deepClone(loadBaselineSnapshot());
  baseline.realtime = baseline.realtime && typeof baseline.realtime === 'object'
    ? baseline.realtime
    : {};
  baseline.realtime.schemaVersion = baseline.realtime.schemaVersion || 'cc.realtime.v1';
  baseline.realtime.generatedAt = baseline.realtime.generatedAt || nowIso();
  baseline.realtime.source = 'central-ingest';
  baseline.realtime.ingestion = baseline.realtime.ingestion && typeof baseline.realtime.ingestion === 'object'
    ? baseline.realtime.ingestion
    : {};
  baseline.realtime.ingestion.totalEvents = Number(baseline.realtime.ingestion.totalEvents || 0);
  baseline.realtime.ingestion.acceptedEvents = Number(baseline.realtime.ingestion.acceptedEvents || 0);
  baseline.realtime.ingestion.duplicateEvents = Number(baseline.realtime.ingestion.duplicateEvents || 0);
  baseline.realtime.ingestion.rejectedEvents = Number(baseline.realtime.ingestion.rejectedEvents || 0);
  baseline.realtime.ingestion.lastEventAt = baseline.realtime.ingestion.lastEventAt || null;
  baseline.realtime.ingestion.lastHeartbeatAt = baseline.realtime.ingestion.lastHeartbeatAt || null;
  baseline.realtime.projects = baseline.realtime.projects && typeof baseline.realtime.projects === 'object'
    ? baseline.realtime.projects
    : {};
  baseline.realtime.incidents = Array.isArray(baseline.realtime.incidents)
    ? baseline.realtime.incidents
    : [];
  baseline.realtime.staleProjects = Array.isArray(baseline.realtime.staleProjects)
    ? baseline.realtime.staleProjects
    : [];
  baseline.incidentFeed = Array.isArray(baseline.incidentFeed) ? baseline.incidentFeed : [];
  baseline.generatedAt = nowIso();
  writeJsonAtomic(STATE_PATH, baseline);
}

function readStateWithMeta() {
  ensureStateInitialized();
  const stat = fs.statSync(STATE_PATH);
  const state = readJson(STATE_PATH, {});
  return {
    state: state && typeof state === 'object' ? state : {},
    mtimeMs: stat.mtimeMs
  };
}

function writeState(state) {
  state.generatedAt = nowIso();
  state.realtime = state.realtime && typeof state.realtime === 'object' ? state.realtime : {};
  state.realtime.generatedAt = state.generatedAt;
  writeJsonAtomic(STATE_PATH, state);
}

function normalizeCloudEvent(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object') {
    return { error: 'event must be a JSON object' };
  }
  const event = rawEvent.event && typeof rawEvent.event === 'object' ? rawEvent.event : rawEvent;
  const specversion = String(event.specversion || '1.0').trim();
  const id = String(event.id || '').trim();
  const source = String(event.source || '').trim();
  const type = String(event.type || '').trim();
  const time = String(event.time || nowIso()).trim();
  const subject = String(event.subject || '').trim();
  const datacontenttype = String(event.datacontenttype || 'application/json').trim();
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const dataschema = String(event.dataschema || '').trim();

  if (!id || !source || !type || !specversion) {
    return { error: 'CloudEvent requires specversion,id,source,type' };
  }
  const parsedTime = parseIso(time);
  if (!parsedTime) {
    return { error: 'CloudEvent time must be RFC3339/ISO-8601' };
  }

  const extensions = {};
  for (const [key, value] of Object.entries(event)) {
    if (['specversion', 'id', 'source', 'type', 'time', 'subject', 'datacontenttype', 'dataschema', 'data'].includes(key)) {
      continue;
    }
    extensions[key] = value;
  }

  return {
    event: {
      specversion,
      id,
      source,
      type,
      time: new Date(parsedTime).toISOString(),
      subject,
      datacontenttype,
      dataschema,
      data,
      extensions
    }
  };
}

function eventProjectId(event, registry) {
  const extensionProject = event?.extensions?.projectid || event?.extensions?.project_id || '';
  const dataProject = event?.data?.projectId || event?.data?.project_id || '';
  const subject = event?.subject || '';
  const candidates = [extensionProject, dataProject, subject];
  for (const candidate of candidates) {
    const key = slugify(candidate);
    if (!key) continue;
    if (registry.aliases[key]) return registry.aliases[key];
  }
  return '';
}

function eventIdempotencyKey(event, explicitKey = '') {
  const provided = String(explicitKey || '').trim();
  if (provided) return provided.slice(0, 200);
  const base = `${event.source}|${event.id}|${event.type}|${event.time}`;
  const dataHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(event.data || {}))
    .digest('hex')
    .slice(0, 16);
  return `${base}|${dataHash}`;
}

function normalizeSeverity(value, severityMap = DEFAULT_PROJECT_ADAPTER.severityMap) {
  const raw = String(value || '').toLowerCase().trim();
  if (!raw) return 'info';
  return severityMap[raw] || raw;
}

function updateProjectSummary(state, projectId, patch) {
  const projects = Array.isArray(state.projects) ? state.projects : [];
  const idx = projects.findIndex((row) => projectKeySet(row).has(projectId));
  const row = idx >= 0 ? projects[idx] : {
    name: patch.name || projectId,
    status: 'unknown',
    summary: '',
    lastUpdate: nowIso()
  };

  row.status = patch.status || row.status || 'unknown';
  row.lastUpdate = patch.lastUpdate || nowIso();
  row.summary = patch.summary || row.summary || '';

  if (idx >= 0) {
    projects[idx] = row;
  } else {
    projects.push(row);
  }
  state.projects = projects;
}

function applyEventToState(state, event, adapter, idempotencyKey) {
  const row = ensureProjectRealtimeRow(state, adapter);
  row.lastEventAt = event.time;
  row.lastEventId = event.id;
  row.lastEventType = event.type;
  row.lastIdempotencyKey = idempotencyKey;
  row.attributes = {
    ...row.attributes,
    ...event.extensions
  };
  row.details = {
    ...row.details,
    ...(event.data && typeof event.data === 'object' ? event.data : {})
  };

  const isHeartbeat = /(heartbeat|health|status|pulse)/i.test(String(event.type || ''));
  const inferredSeverity = normalizeSeverity(
    event.data?.severity || event.extensions?.severity || (isHeartbeat ? event.data?.status : ''),
    adapter.severityMap
  );
  const inferredStatus = String(event.data?.status || inferredSeverity || row.status || 'monitoring').toLowerCase();

  if (isHeartbeat) {
    row.lastHeartbeatAt = event.time;
    row.heartbeatIntervalSeconds = adapter.heartbeatIntervalSeconds;
    row.maxEventAgeSeconds = adapter.maxEventAgeSeconds;
    row.requiredMetrics = adapter.requiredMetrics;
    row.runbookLinks = adapter.runbookLinks;
    row.metrics = event.data?.metrics && typeof event.data.metrics === 'object'
      ? event.data.metrics
      : row.metrics;
    row.missingMetrics = adapter.requiredMetrics.filter((key) => {
      const val = row.metrics ? row.metrics[key] : undefined;
      return val === undefined || val === null || val === '';
    });
    row.status = row.missingMetrics.length ? 'warn' : inferredStatus;
    row.severity = row.missingMetrics.length ? 'warn' : inferredSeverity;
    row.stale = false;
    row.missedIntervals = 0;
    state.realtime.ingestion.lastHeartbeatAt = event.time;
  } else {
    row.status = inferredStatus || row.status;
    row.severity = inferredSeverity || row.severity;
  }

  const summary = isHeartbeat
    ? `Heartbeat ${row.status}${row.missingMetrics?.length ? ` | missing metrics: ${row.missingMetrics.join(', ')}` : ''}`
    : `Event ${event.type}`;

  updateProjectSummary(state, adapter.projectId, {
    name: adapter.name,
    status: row.status,
    lastUpdate: event.time,
    summary
  });
}

function incidentId(projectId, kind) {
  return `${projectId}:${kind}:${new Date().toISOString().slice(0, 16)}`;
}

function pushIncident(state, adapter, kind, message, detail = {}) {
  const incident = {
    id: incidentId(adapter.projectId, kind),
    ts: nowIso(),
    kind,
    projectId: adapter.projectId,
    projectName: adapter.name,
    severity: kind === 'stale' ? 'critical' : 'warn',
    message,
    detail,
    runbook: adapter.runbookLinks?.solve || adapter.runbookLinks?.reviews || ''
  };
  state.realtime.incidents = Array.isArray(state.realtime.incidents) ? state.realtime.incidents : [];
  state.realtime.incidents.unshift(incident);
  state.realtime.incidents = state.realtime.incidents.slice(0, 100);
  state.incidentFeed = Array.isArray(state.incidentFeed) ? state.incidentFeed : [];
  state.incidentFeed.unshift({
    at: incident.ts,
    severity: incident.severity,
    item: `[${incident.projectName}] ${incident.message}`
  });
  state.incidentFeed = state.incidentFeed.slice(0, 100);
  appendJsonl(INCIDENTS_PATH, incident);
  return incident;
}

function evaluateFreshness(state, registry, options = {}) {
  const persistIncidents = options.persistIncidents !== false;
  state.realtime = state.realtime && typeof state.realtime === 'object' ? state.realtime : {};
  state.realtime.projects = state.realtime.projects && typeof state.realtime.projects === 'object'
    ? state.realtime.projects
    : {};
  state.realtime.ingestion = state.realtime.ingestion && typeof state.realtime.ingestion === 'object'
    ? state.realtime.ingestion
    : {};

  const now = Date.now();
  const staleProjects = [];
  let changed = false;

  for (const adapter of Object.values(registry.byId)) {
    const row = ensureProjectRealtimeRow(state, adapter);
    const lastHeartbeatMs = parseIso(row.lastHeartbeatAt);
    const intervalMs = Math.max(1000, Number(adapter.heartbeatIntervalSeconds || 300) * 1000);
    const missedIntervals = lastHeartbeatMs
      ? Math.floor((now - lastHeartbeatMs) / intervalMs)
      : Number.POSITIVE_INFINITY;
    const stale = missedIntervals >= 2;

    if (row.stale !== stale || row.missedIntervals !== missedIntervals) {
      changed = true;
    }

    if (stale) {
      staleProjects.push({
        projectId: adapter.projectId,
        projectName: adapter.name,
        missedIntervals: Number.isFinite(missedIntervals) ? missedIntervals : null,
        heartbeatIntervalSeconds: adapter.heartbeatIntervalSeconds,
        lastHeartbeatAt: row.lastHeartbeatAt || null,
        runbook: adapter.runbookLinks?.solve || adapter.runbookLinks?.reviews || ''
      });
      if (!row.stale && persistIncidents) {
        pushIncident(
          state,
          adapter,
          'stale',
          `Heartbeat missed >=2 intervals (${adapter.heartbeatIntervalSeconds}s cadence).`,
          {
            missedIntervals: Number.isFinite(missedIntervals) ? missedIntervals : null,
            lastHeartbeatAt: row.lastHeartbeatAt || null
          }
        );
      }
      row.status = 'stale';
      row.severity = 'critical';
      updateProjectSummary(state, adapter.projectId, {
        name: adapter.name,
        status: 'stale',
        summary: `Heartbeat stale (${Number.isFinite(missedIntervals) ? `${missedIntervals} missed intervals` : 'no heartbeat'})`
      });
    } else if (row.stale && persistIncidents) {
      pushIncident(
        state,
        adapter,
        'recovered',
        'Heartbeat recovered within SLO.',
        {
          lastHeartbeatAt: row.lastHeartbeatAt || null
        }
      );
    }

    row.stale = stale;
    row.missedIntervals = Number.isFinite(missedIntervals) ? missedIntervals : null;
    row.heartbeatIntervalSeconds = adapter.heartbeatIntervalSeconds;
    row.maxEventAgeSeconds = adapter.maxEventAgeSeconds;
    row.runbookLinks = adapter.runbookLinks;
  }

  state.realtime.staleProjects = staleProjects;
  state.realtime.staleCount = staleProjects.length;
  state.realtime.lastEvaluationAt = nowIso();
  state.realtime.ingestion.lastEvaluationAt = state.realtime.lastEvaluationAt;
  return { changed, staleProjects };
}

function loadIdempotencyMap() {
  const raw = readJson(IDEMPOTENCY_PATH, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function pruneIdempotencyMap(map) {
  const keys = Object.keys(map);
  if (keys.length <= MAX_IDEMPOTENCY_KEYS) return map;
  const sorted = keys
    .map((key) => ({ key, at: Number(map[key]?.at || 0) }))
    .sort((a, b) => b.at - a.at);
  const kept = {};
  for (const row of sorted.slice(0, MAX_IDEMPOTENCY_KEYS)) {
    kept[row.key] = map[row.key];
  }
  return kept;
}

function ingestCloudEvents(payload, headers = {}) {
  const registry = adapterRegistry();
  const { state } = readStateWithMeta();
  const idempotencyMap = loadIdempotencyMap();

  state.realtime = state.realtime && typeof state.realtime === 'object' ? state.realtime : {};
  state.realtime.ingestion = state.realtime.ingestion && typeof state.realtime.ingestion === 'object'
    ? state.realtime.ingestion
    : {};
  state.realtime.ingestion.totalEvents = Number(state.realtime.ingestion.totalEvents || 0);
  state.realtime.ingestion.acceptedEvents = Number(state.realtime.ingestion.acceptedEvents || 0);
  state.realtime.ingestion.duplicateEvents = Number(state.realtime.ingestion.duplicateEvents || 0);
  state.realtime.ingestion.rejectedEvents = Number(state.realtime.ingestion.rejectedEvents || 0);
  state.realtime.ingestion.lastEventAt = state.realtime.ingestion.lastEventAt || null;
  state.realtime.ingestion.lastErrorAt = state.realtime.ingestion.lastErrorAt || null;
  state.realtime.ingestion.lastError = state.realtime.ingestion.lastError || null;

  const rawEvents = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.events)
      ? payload.events
      : [payload];

  const accepted = [];
  const rejected = [];
  const duplicates = [];

  for (const rawEvent of rawEvents) {
    const normalized = normalizeCloudEvent(rawEvent);
    if (normalized.error) {
      rejected.push({ reason: normalized.error });
      continue;
    }

    const event = normalized.event;
    const projectId = eventProjectId(event, registry);
    if (!projectId || !registry.byId[projectId]) {
      rejected.push({
        eventId: event.id,
        reason: 'unknown_project_adapter',
        detail: 'No adapter contract found in operator.config.json for this event project.'
      });
      continue;
    }
    const adapter = registry.byId[projectId];
    const eventAgeSec = Math.max(0, Math.floor((Date.now() - parseIso(event.time)) / 1000));
    if (eventAgeSec > Number(adapter.maxEventAgeSeconds || DEFAULT_PROJECT_ADAPTER.maxEventAgeSeconds)) {
      rejected.push({
        eventId: event.id,
        projectId,
        reason: 'stale_event_rejected',
        eventAgeSec,
        maxEventAgeSeconds: adapter.maxEventAgeSeconds
      });
      continue;
    }

    const providedIdempotency = String(
      rawEvent?.idempotencyKey || payload?.idempotencyKey || headers['idempotency-key'] || ''
    ).trim();
    const idempotencyKey = eventIdempotencyKey(event, providedIdempotency);
    if (idempotencyMap[idempotencyKey]) {
      duplicates.push({
        eventId: event.id,
        projectId,
        idempotencyKey
      });
      continue;
    }

    idempotencyMap[idempotencyKey] = {
      at: Date.now(),
      eventId: event.id,
      projectId
    };

    applyEventToState(state, event, adapter, idempotencyKey);
    appendJsonl(EVENTS_PATH, {
      ingestedAt: nowIso(),
      projectId,
      idempotencyKey,
      event
    });
    accepted.push({
      eventId: event.id,
      projectId,
      idempotencyKey
    });
  }

  state.realtime.ingestion.totalEvents += rawEvents.length;
  state.realtime.ingestion.acceptedEvents += accepted.length;
  state.realtime.ingestion.duplicateEvents += duplicates.length;
  state.realtime.ingestion.rejectedEvents += rejected.length;
  state.realtime.ingestion.lastEventAt = accepted.length ? nowIso() : state.realtime.ingestion.lastEventAt;
  state.realtime.ingestion.lastErrorAt = rejected.length ? nowIso() : state.realtime.ingestion.lastErrorAt;
  state.realtime.ingestion.lastError = rejected.length
    ? rejected.slice(0, 3).map((row) => row.reason).join(', ')
    : null;

  const freshness = evaluateFreshness(state, registry, { persistIncidents: true });
  writeState(state);
  writeJsonAtomic(IDEMPOTENCY_PATH, pruneIdempotencyMap(idempotencyMap));

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
      staleProjects: freshness.staleProjects.length
    }
  };
}

function readPublishedState() {
  const registry = adapterRegistry();
  const { state, mtimeMs } = readStateWithMeta();
  const freshness = evaluateFreshness(state, registry, { persistIncidents: true });
  if (freshness.changed) {
    writeState(state);
  }
  const version = String(Math.floor(fs.statSync(STATE_PATH).mtimeMs));
  return {
    state,
    mtimeMs,
    version
  };
}

function publishBlockMeta(state) {
  const stale = Array.isArray(state?.realtime?.staleProjects) ? state.realtime.staleProjects : [];
  const enabled = envBool('COMMAND_CENTER_BLOCK_STALE_API', false);
  return {
    enabled,
    blocked: enabled && stale.length > 0,
    staleProjects: stale
  };
}

module.exports = {
  RUNTIME_ROOT,
  STATE_PATH,
  EVENTS_PATH,
  INCIDENTS_PATH,
  IDEMPOTENCY_PATH,
  readOperatorConfig,
  adapterRegistry,
  readPublishedState,
  ingestCloudEvents,
  publishBlockMeta,
  envBool,
  clampNumber,
  nowIso
};
