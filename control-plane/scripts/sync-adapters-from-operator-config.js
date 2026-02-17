#!/usr/bin/env node
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { readConfig } = require('../src/config');
const { withTx } = require('../src/db');

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function defaultRequiredMetrics(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'outreach') return ['queueDepth', 'healthRows', 'failingChecks'];
  if (t === 'polymarket' || t === 'trading') return ['loopLatencyMs', 'openPositions', 'riskScore'];
  if (t === 'ops') return ['queueBacklog', 'incidentCount'];
  return ['healthScore'];
}

function defaultRunbooks(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'outreach') {
    return {
      reviews: './docs/operator-quickstart.md',
      solve: './docs/verification.md',
      prevent: './docs/project-contract.md',
      rollback: './docs/rollback.md'
    };
  }
  if (t === 'polymarket' || t === 'trading') {
    return {
      reviews: './docs/priority-model-v3.md',
      solve: './docs/verification.md',
      prevent: './docs/project-contract.md',
      rollback: './docs/rollback.md'
    };
  }
  return {
    reviews: './docs/operator-quickstart.md',
    solve: './docs/verification.md',
    prevent: './docs/project-contract.md',
    rollback: './docs/rollback.md'
  };
}

function defaultHeartbeat(priority) {
  const p = String(priority || '').toUpperCase();
  if (p === 'P0' || p === 'URGENT') return 60;
  return 600;
}

function projectTypeFromName(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('outreach')) return 'outreach';
  if (n.includes('polymarket') || n.includes('trading')) return 'polymarket';
  if (n.includes('ops') || n.includes('decision') || n.includes('automation')) return 'ops';
  if (n.includes('infra') || n.includes('reliability')) return 'infrastructure';
  return 'generic';
}

function parseOperatorConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed?.projects) ? parsed.projects : [];
}

async function upsertAdapter(client, row) {
  await client.query(
    `
    INSERT INTO project_adapters (
      project_id, name, type, owner, priority, aliases,
      heartbeat_interval_seconds, max_event_age_seconds,
      required_metrics, severity_map, runbook_links, event_types, active, updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6::jsonb,
      $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, TRUE, now()
    )
    ON CONFLICT (project_id) DO UPDATE SET
      name = EXCLUDED.name,
      type = EXCLUDED.type,
      owner = EXCLUDED.owner,
      priority = EXCLUDED.priority,
      aliases = EXCLUDED.aliases,
      heartbeat_interval_seconds = EXCLUDED.heartbeat_interval_seconds,
      max_event_age_seconds = EXCLUDED.max_event_age_seconds,
      required_metrics = EXCLUDED.required_metrics,
      severity_map = EXCLUDED.severity_map,
      runbook_links = EXCLUDED.runbook_links,
      event_types = EXCLUDED.event_types,
      active = TRUE,
      updated_at = now()
    `,
    [
      row.projectId,
      row.name,
      row.type,
      row.owner,
      row.priority,
      JSON.stringify(row.aliases),
      row.heartbeatIntervalSeconds,
      row.maxEventAgeSeconds,
      JSON.stringify(row.requiredMetrics),
      JSON.stringify(row.severityMap),
      JSON.stringify(row.runbookLinks),
      JSON.stringify(row.eventTypes)
    ]
  );
}

async function main() {
  const config = readConfig();
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }
  const operatorConfigPath = config.operatorConfigPath || path.join(config.rootDir, 'operator.config.json');
  const projects = parseOperatorConfig(operatorConfigPath);
  if (!projects.length) {
    console.log('[sync:adapters] no projects in operator config');
    return;
  }

  await withTx(config.databaseUrl, async (client) => {
    const activeIds = [];
    for (const project of projects) {
      const name = String(project?.name || '').trim();
      if (!name) continue;
      const type = String(project?.type || '').trim() || projectTypeFromName(name);
      const projectId = slugify(project?.id || project?.projectId || project?.slug || name);
      if (!projectId) continue;
      const adapter = project?.adapter && typeof project.adapter === 'object' ? project.adapter : {};
      const heartbeatIntervalSeconds = Number(adapter.heartbeatIntervalSeconds || defaultHeartbeat(project.priority));
      const maxEventAgeSeconds = Number(adapter.maxEventAgeSeconds || heartbeatIntervalSeconds * 3);
      const requiredMetrics = toArray(adapter.requiredMetrics).length
        ? toArray(adapter.requiredMetrics)
        : defaultRequiredMetrics(type);
      const severityMap = {
        ok: 'ok',
        info: 'ok',
        warn: 'warn',
        warning: 'warn',
        critical: 'critical',
        error: 'critical',
        stale: 'critical',
        ...(adapter.severityMap || {})
      };
      const runbookLinks = {
        ...defaultRunbooks(type),
        ...(adapter.runbookLinks || {})
      };
      const aliases = [
        projectId,
        slugify(name),
        slugify(project?.id),
        slugify(project?.projectId),
        slugify(project?.slug),
        ...toArray(project?.aliases).map(slugify),
        ...toArray(project?.matchNames).map(slugify)
      ].filter(Boolean);

      const eventTypes = toArray(adapter.eventTypes).length
        ? toArray(adapter.eventTypes)
        : ['heartbeat', 'metric', 'action', 'incident'];

      await upsertAdapter(client, {
        projectId,
        name,
        type,
        owner: String(project?.owner || '').trim(),
        priority: String(project?.priority || '').trim(),
        aliases: [...new Set(aliases)],
        heartbeatIntervalSeconds,
        maxEventAgeSeconds,
        requiredMetrics,
        severityMap,
        runbookLinks,
        eventTypes
      });
      activeIds.push(projectId);
    }

    if (activeIds.length) {
      await client.query(
        `
          UPDATE project_adapters
          SET active = FALSE, updated_at = now()
          WHERE project_id <> ALL($1::text[])
        `,
        [activeIds]
      );
    }
    console.log(`[sync:adapters] synced ${activeIds.length} project adapters`);
  });
}

main().catch((err) => {
  console.error('[sync:adapters] failed', err.message || err);
  process.exit(1);
});
