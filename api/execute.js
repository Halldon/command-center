const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_OUTPUT_CHARS = 12000;
const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]+$/;

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function truncate(value, max = MAX_OUTPUT_CHARS) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function readOperatorConfig() {
  const filePath = path.join(process.cwd(), 'operator.config.json');
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
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
  const aliases = [
    ...(Array.isArray(project?.aliases) ? project.aliases : []),
    ...(Array.isArray(project?.matchNames) ? project.matchNames : [])
  ];
  aliases.forEach(add);
  return keys;
}

function isValidBranchName(value) {
  return BRANCH_NAME_RE.test(String(value || ''));
}

function normalizeBranchFlow(project) {
  const configured = Array.isArray(project?.branchFlow) ? project.branchFlow : [];
  const flow = configured
    .map((branch) => String(branch || '').trim())
    .filter((branch) => isValidBranchName(branch));
  const unique = [];
  for (const branch of flow) {
    if (!unique.includes(branch)) unique.push(branch);
  }
  return unique.length ? unique : ['main'];
}

function resolvePromotionStep(project, fromBranchInput, toBranchInput) {
  const flow = normalizeBranchFlow(project);
  if (flow.length < 2) {
    return {
      error: 'No promotion path configured for this project. Add branchFlow with at least two branches.',
      flow
    };
  }

  const requestedFrom = String(fromBranchInput || '').trim();
  const requestedTo = String(toBranchInput || '').trim();
  if (requestedFrom && !isValidBranchName(requestedFrom)) {
    return { error: `Invalid fromBranch: ${requestedFrom}`, flow };
  }
  if (requestedTo && !isValidBranchName(requestedTo)) {
    return { error: `Invalid toBranch: ${requestedTo}`, flow };
  }

  if (requestedFrom && requestedTo) {
    const idx = flow.indexOf(requestedFrom);
    if (idx < 0 || idx >= flow.length - 1 || flow[idx + 1] !== requestedTo) {
      return {
        error: `Requested promotion ${requestedFrom} -> ${requestedTo} is not adjacent in branchFlow.`,
        flow
      };
    }
    return { from: requestedFrom, to: requestedTo, flow, error: '' };
  }

  if (requestedFrom) {
    const idx = flow.indexOf(requestedFrom);
    if (idx < 0 || idx >= flow.length - 1) {
      return {
        error: `Requested fromBranch "${requestedFrom}" has no next branch in branchFlow.`,
        flow
      };
    }
    return { from: requestedFrom, to: flow[idx + 1], flow, error: '' };
  }

  if (requestedTo) {
    const idx = flow.indexOf(requestedTo);
    if (idx <= 0) {
      return {
        error: `Requested toBranch "${requestedTo}" has no previous branch in branchFlow.`,
        flow
      };
    }
    return { from: flow[idx - 1], to: requestedTo, flow, error: '' };
  }

  return { from: flow[0], to: flow[1], flow, error: '' };
}

function buildPromotionCommand(repoPath, fromBranch, toBranch) {
  const repo = String(repoPath || '').trim();
  if (!repo) {
    return { error: 'Project repoPath is required for promote_review action.' };
  }
  if (!isValidBranchName(fromBranch) || !isValidBranchName(toBranch)) {
    return { error: 'Invalid branch names for promote_review action.' };
  }
  const command = `cd ${shellQuote(repo)} && git fetch --all --prune && git checkout ${shellQuote(toBranch)} && git merge --no-ff --no-edit ${shellQuote(fromBranch)}`;
  return { command };
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return req.body;
}

function getToken(req) {
  const headerToken = req.headers['x-command-center-token'];
  if (headerToken) return String(headerToken).trim();
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return '';
}

function ensureActorAllowed(config, actor) {
  const triggerRule = String(config?.securityRules?.liveActionTriggers || '');
  if (/james only/i.test(triggerRule)) {
    return /james/i.test(String(actor || ''));
  }
  return true;
}

function isExternalAction(action) {
  return String(action?.classification || '').toLowerCase().startsWith('external');
}

function isBackgroundAction(action, command) {
  const cls = String(action?.classification || '').toLowerCase();
  const cmd = String(command || '');
  return cls === 'internal_paper' && /--loop(\s|$)/.test(cmd);
}

async function runCommand(command, timeoutMs) {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync('/bin/zsh', ['-lc', command], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env
    });
    return {
      ok: true,
      exitCode: 0,
      stdout: truncate(stdout),
      stderr: truncate(stderr),
      durationMs: Date.now() - startedAt,
      timedOut: false
    };
  } catch (err) {
    return {
      ok: false,
      exitCode: typeof err.code === 'number' ? err.code : null,
      stdout: truncate(err.stdout || ''),
      stderr: truncate(err.stderr || err.message || String(err)),
      durationMs: Date.now() - startedAt,
      timedOut: Boolean(err.killed)
    };
  }
}

function startBackgroundCommand(command) {
  const child = spawn('/bin/zsh', ['-lc', command], {
    detached: true,
    stdio: 'ignore',
    env: process.env
  });
  child.unref();
  return {
    ok: true,
    background: true,
    pid: child.pid
  };
}

function appendAudit(event) {
  try {
    const runtimeDir = path.join(process.cwd(), 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const file = path.join(runtimeDir, 'exec_audit.jsonl');
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
  } catch (_) {
    // Best effort only.
  }
}

function readAuditHistory(limit) {
  try {
    const file = path.join(process.cwd(), 'runtime', 'exec_audit.jsonl');
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    const parsed = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line));
      } catch (_) {
        // Ignore malformed line.
      }
    }
    return parsed.reverse().slice(0, limit);
  } catch (_) {
    return [];
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Command-Center-Token');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    return res.status(200).json({
      endpoint: '/api/execute',
      mode: 'allowlisted-authenticated-execution',
      tokenConfigured: Boolean(process.env.COMMAND_CENTER_EXEC_TOKEN),
      requiredEnv: ['COMMAND_CENTER_EXEC_TOKEN'],
      notes: [
        'Commands are loaded from operator.config.json only.',
        'External irreversible actions require confirmed=true per request.'
      ]
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const expectedToken = String(process.env.COMMAND_CENTER_EXEC_TOKEN || '').trim();
    if (!expectedToken) {
      return res.status(503).json({
        error: 'Execution token is not configured on the server.',
        hint: 'Set COMMAND_CENTER_EXEC_TOKEN in environment variables.'
      });
    }

    const providedToken = getToken(req);
    if (!providedToken || providedToken !== expectedToken) {
      return res.status(401).json({ error: 'Unauthorized: invalid execution token.' });
    }

    const body = parseBody(req);
    const opAction = String(body.action || '').toLowerCase();
    if (opAction === 'history') {
      const limit = Math.max(1, Math.min(Number(body.limit || 30), 200));
      const history = readAuditHistory(limit);
      return res.status(200).json({ ok: true, history, limit });
    }

    const config = readOperatorConfig();
    const projectId = slugify(body.projectId || '');
    const actionKey = String(body.actionKey || '').trim();
    const actor = String(body.actor || '').trim();
    const confirmed = body.confirmed === true;
    const dryRun = body.dryRun === true;
    const requestedMode = String(body.mode || '').toLowerCase();

    if (!projectId) return res.status(400).json({ error: 'projectId is required.' });
    if (!actionKey) return res.status(400).json({ error: 'actionKey is required.' });
    if (!ensureActorAllowed(config, actor)) {
      return res.status(403).json({
        error: 'Actor is not allowed by liveActionTriggers policy.',
        policy: config?.securityRules?.liveActionTriggers || null
      });
    }

    const projects = Array.isArray(config.projects) ? config.projects : [];
    const project = projects.find((row) => projectKeySet(row).has(projectId));
    if (!project) {
      return res.status(404).json({ error: `Unknown projectId: ${projectId}` });
    }

    const actions = project.actions || {};
    let action = actions[actionKey];
    let command = '';
    let fromBranch = '';
    let toBranch = '';
    const reviewId = String(body.reviewId || '').trim();

    if (actionKey === 'promote_review') {
      const step = resolvePromotionStep(project, body.fromBranch, body.toBranch);
      if (step.error) {
        return res.status(409).json({
          error: step.error,
          branchFlow: step.flow,
          requiresConfig: true
        });
      }
      const promotion = buildPromotionCommand(project.repoPath, step.from, step.to);
      if (promotion.error) {
        return res.status(400).json({ error: promotion.error });
      }
      action = {
        label: `Promote ${step.from} -> ${step.to}`,
        classification: 'internal_merge',
        cmd: promotion.command
      };
      command = promotion.command;
      fromBranch = step.from;
      toBranch = step.to;

      if (!confirmed) {
        return res.status(412).json({
          error: 'Confirmation is required for branch promotion actions.',
          policy: config?.securityRules?.liveConfirmationPolicy || null,
          requiresConfirmation: true
        });
      }
    } else {
      if (!action || typeof action !== 'object') {
        return res.status(404).json({
          error: `Unknown actionKey "${actionKey}" for project "${project.name}".`,
          availableActions: [...Object.keys(actions), 'promote_review']
        });
      }
      command = String(action.cmd || '').trim();
      if (!command) {
        return res.status(400).json({ error: 'Action is configured without a command.' });
      }
    }

    if (isExternalAction(action) && !confirmed) {
      return res.status(412).json({
        error: 'Confirmation is required for external irreversible actions.',
        policy: config?.securityRules?.liveConfirmationPolicy || null,
        requiresConfirmation: true
      });
    }

    const timeoutMs = Number(process.env.COMMAND_CENTER_EXEC_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    let result;
    if (dryRun) {
      result = { ok: true, dryRun: true, message: 'Dry-run preview only. Command not executed.' };
    } else if (isBackgroundAction(action, command)) {
      result = startBackgroundCommand(command);
    } else {
      result = await runCommand(command, timeoutMs);
    }

    const auditRow = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      actor,
      projectId,
      projectName: project.name,
      actionKey,
      actionLabel: action.label || actionKey,
      command,
      classification: action.classification || 'internal_diagnostic',
      mode: requestedMode || 'unspecified',
      dryRun,
      result
    };
    if (fromBranch) auditRow.fromBranch = fromBranch;
    if (toBranch) auditRow.toBranch = toBranch;
    if (reviewId) auditRow.reviewId = reviewId;
    appendAudit(auditRow);

    return res.status(200).json({
      ok: Boolean(result.ok),
      project: {
        id: projectId,
        name: project.name
      },
      action: {
        key: actionKey,
        label: action.label || actionKey,
        classification: action.classification || 'internal_diagnostic'
      },
      command,
      fromBranch: fromBranch || undefined,
      toBranch: toBranch || undefined,
      reviewId: reviewId || undefined,
      dryRun,
      result
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Execution endpoint failed.',
      details: String(err.message || err)
    });
  }
};
