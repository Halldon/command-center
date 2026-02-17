const { readPublishedState, publishBlockMeta } = require('./_central_state');
const { proxyToControlPlane } = require('./_control_plane_proxy');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-cache');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (await proxyToControlPlane(req, res, '/api/state')) return;

    const published = readPublishedState();
    const block = publishBlockMeta(published.state);
    if (block.blocked) {
      return res.status(503).json({
        error: 'Publish blocked: stale data gate is active.',
        staleProjects: block.staleProjects
      });
    }

    const payload = {
      ...published.state,
      _meta: {
        source: 'central_state',
        version: String(published.version),
        mtimeMs: published.mtimeMs,
        staleProjects: block.staleProjects,
        blockEnabled: block.enabled
      }
    };
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({
      error: 'state endpoint failed',
      details: String(err.message || err)
    });
  }
};
