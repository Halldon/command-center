const crypto = require('crypto');
const { ingestCloudEvents } = require('./_central_state');
const { proxyToControlPlane } = require('./_control_plane_proxy');

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return req.body;
}

function getToken(req) {
  const headerToken = req.headers['x-command-center-ingest-key'];
  if (headerToken) return String(headerToken).trim();
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return '';
}

function hashToken(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function authAllowed(req) {
  const configuredToken = String(process.env.COMMAND_CENTER_INGEST_TOKEN || '').trim();
  const configuredTokenSha = String(process.env.COMMAND_CENTER_INGEST_TOKEN_SHA256 || '').trim().toLowerCase();
  if (!configuredToken && !configuredTokenSha) return true;
  const provided = getToken(req);
  if (!provided) return false;
  if (configuredToken && provided === configuredToken) return true;
  if (configuredTokenSha) return hashToken(provided) === configuredTokenSha;
  return false;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Command-Center-Ingest-Key, Idempotency-Key');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET' || req.method === 'POST') {
    if (await proxyToControlPlane(req, res, '/api/ingest')) return;
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      endpoint: '/api/ingest',
      protocol: 'CloudEvents + OpenTelemetry attributes',
      auth: {
        tokenConfigured: Boolean(process.env.COMMAND_CENTER_INGEST_TOKEN || process.env.COMMAND_CENTER_INGEST_TOKEN_SHA256),
        header: 'X-Command-Center-Ingest-Key or Authorization: Bearer <token>'
      },
      acceptedForms: [
        'single CloudEvent object',
        '{ "events": [CloudEvent, ...], "idempotencyKey": "optional-batch-key" }'
      ]
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!authAllowed(req)) {
    return res.status(401).json({
      error: 'Unauthorized ingest token.',
      hint: 'Set COMMAND_CENTER_INGEST_TOKEN (or SHA256 variant) and send matching header.'
    });
  }

  try {
    const body = parseBody(req);
    const result = ingestCloudEvents(body, req.headers || {});
    const status = result.rejected?.length ? 207 : 200;
    return res.status(status).json(result);
  } catch (err) {
    return res.status(500).json({
      error: 'ingest endpoint failed',
      details: String(err.message || err)
    });
  }
};
