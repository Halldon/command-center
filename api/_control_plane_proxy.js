const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

function readOperatorBaseUrl() {
  try {
    const filePath = path.join(process.cwd(), 'operator.config.json');
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const base = String(parsed?.realtime?.apiBaseUrl || '').trim();
    return base;
  } catch (_) {
    return '';
  }
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const target = new URL(raw);
    if (!['http:', 'https:'].includes(target.protocol)) return '';
    return raw;
  } catch (_) {
    return '';
  }
}

function resolveControlPlaneBaseUrl() {
  return normalizeBaseUrl(
    process.env.COMMAND_CENTER_CONTROL_PLANE_URL
      || process.env.COMMAND_CENTER_API_BASE_URL
      || readOperatorBaseUrl()
  );
}

function sameHost(baseUrl, req) {
  try {
    const target = new URL(baseUrl);
    const host = String(req.headers.host || '').toLowerCase();
    return Boolean(host) && host === String(target.host || '').toLowerCase();
  } catch (_) {
    return false;
  }
}

function buildTargetUrl(baseUrl, req, forcedPath) {
  const incoming = new URL(String(req.url || '/'), 'http://localhost');
  const finalPath = String(forcedPath || incoming.pathname || '/');
  const target = new URL(`${finalPath}${incoming.search || ''}`, `${baseUrl}/`);
  return target;
}

function sanitizeRequestHeaders(headers, bodyBuffer) {
  const next = { ...(headers || {}) };
  delete next.host;
  delete next.connection;
  delete next['content-length'];
  next['x-command-center-proxy'] = 'vercel-api';
  if (bodyBuffer) {
    next['content-length'] = String(bodyBuffer.length);
    if (!next['content-type']) next['content-type'] = 'application/json';
  }
  return next;
}

function normalizeBody(req) {
  if (req.body === undefined || req.body === null) return null;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  if (typeof req.body === 'object') return Buffer.from(JSON.stringify(req.body), 'utf8');
  return Buffer.from(String(req.body), 'utf8');
}

function copyResponseHeaders(res, headers = {}) {
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = String(key || '').toLowerCase();
    if (lower === 'transfer-encoding') continue;
    if (lower === 'connection') continue;
    res.setHeader(key, value);
  }
}

async function proxyToControlPlane(req, res, forcedPath) {
  const baseUrl = resolveControlPlaneBaseUrl();
  if (!baseUrl) return false;
  if (sameHost(baseUrl, req)) return false;

  const target = buildTargetUrl(baseUrl, req, forcedPath);
  const bodyBuffer = normalizeBody(req);
  const headers = sanitizeRequestHeaders(req.headers || {}, bodyBuffer);
  const transport = target.protocol === 'https:' ? https : http;

  await new Promise((resolve, reject) => {
    const upstream = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers
      },
      (upstreamRes) => {
        copyResponseHeaders(res, upstreamRes.headers || {});
        res.statusCode = upstreamRes.statusCode || 502;
        upstreamRes.pipe(res);
        upstreamRes.on('end', resolve);
      }
    );

    upstream.on('error', reject);
    upstream.setTimeout(30000, () => {
      upstream.destroy(new Error('proxy timeout'));
    });

    if (bodyBuffer) {
      upstream.write(bodyBuffer);
      upstream.end();
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      upstream.end();
      return;
    }

    req.pipe(upstream);
  }).catch((err) => {
    if (!res.headersSent) {
      res.status(502).json({
        error: 'Control-plane proxy request failed.',
        details: String(err.message || err)
      });
      return;
    }
    res.end();
  });

  return true;
}

module.exports = {
  resolveControlPlaneBaseUrl,
  proxyToControlPlane
};
