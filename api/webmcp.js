const fs = require('fs');
const path = require('path');

function readSnapshot() {
  const snapshotPath = path.join(process.cwd(), 'snapshot.json');
  const raw = fs.readFileSync(snapshotPath, 'utf8');
  return JSON.parse(raw);
}

function tools() {
  return [
    {
      name: 'get_attention_queue',
      description: 'Return ranked items that need human attention.',
      input_schema: { type: 'object', properties: { limit: { type: 'number' } } }
    },
    {
      name: 'get_executive_brief',
      description: 'Return the concise executive daily brief.',
      input_schema: { type: 'object', properties: {} }
    },
    {
      name: 'get_reliability_radar',
      description: 'Return reliability trend signals.',
      input_schema: { type: 'object', properties: {} }
    },
    {
      name: 'get_decisions',
      description: 'Return decision console entries (optionally filtered by status).',
      input_schema: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['open', 'in_progress', 'done', 'all'] } }
      }
    },
    {
      name: 'get_focus_mode',
      description: 'Return personal focus mode settings and current state.',
      input_schema: { type: 'object', properties: {} }
    },
    {
      name: 'search_alerts',
      description: 'Search explainability/reliability items by keyword.',
      input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    }
  ];
}

function callTool(name, args = {}, s) {
  switch (name) {
    case 'get_attention_queue': {
      const items = s.attentionQueue?.items || [];
      const limit = Math.max(1, Math.min(Number(args.limit || 10), 50));
      return { items: items.slice(0, limit), total: items.length };
    }
    case 'get_executive_brief':
      return s.executiveDailyBrief || { summary: 'No brief available.' };
    case 'get_reliability_radar':
      return s.reliabilityRadar || { message: 'No reliability radar available.' };
    case 'get_decisions': {
      const items = s.decisionConsole?.items || [];
      const status = (args.status || 'all').toLowerCase();
      return {
        items: status === 'all' ? items : items.filter((i) => (i.status || '').toLowerCase() === status),
        total: items.length
      };
    }
    case 'get_focus_mode':
      return s.personalFocusMode || { mode: 'normal' };
    case 'search_alerts': {
      const q = String(args.query || '').toLowerCase();
      const ex = s.explainability?.items || [];
      const rr = s.reliabilityRadar?.signals || [];
      const combined = [
        ...ex.map((x) => ({ source: 'explainability', ...x })),
        ...rr.map((x) => ({ source: 'reliability', ...x }))
      ];
      return {
        query: args.query,
        matches: combined.filter((m) => JSON.stringify(m).toLowerCase().includes(q)).slice(0, 50)
      };
    }
    default:
      return { error: `Unknown tool: ${name}`, available_tools: tools().map((t) => t.name) };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const snapshot = readSnapshot();

    if (req.method === 'GET') {
      return res.status(200).json({
        protocol: 'webmcp-lite/0.1',
        name: 'command-center-webmcp',
        mode: 'read-only',
        tools: tools(),
        endpoint: '/api/webmcp'
      });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = body.action || 'list_tools';

    if (action === 'list_tools') {
      return res.status(200).json({ tools: tools() });
    }

    if (action === 'call_tool') {
      const name = body.name;
      const args = body.arguments || {};
      const result = callTool(name, args, snapshot);
      return res.status(200).json({ ok: !result.error, result });
    }

    return res.status(400).json({ error: 'Unsupported action', supported: ['list_tools', 'call_tool'] });
  } catch (err) {
    return res.status(500).json({ error: 'webmcp endpoint failed', details: String(err.message || err) });
  }
};
