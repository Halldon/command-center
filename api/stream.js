const fs = require('fs');
const path = require('path');

function readSnapshotWithMeta() {
  const snapshotPath = path.join(process.cwd(), 'snapshot.json');
  const stat = fs.statSync(snapshotPath);
  const raw = fs.readFileSync(snapshotPath, 'utf8');
  return {
    snapshot: JSON.parse(raw),
    mtimeMs: stat.mtimeMs,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { snapshot, mtimeMs } = readSnapshotWithMeta();

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const id = String(Math.floor(mtimeMs));
    res.write(`retry: 5000\n`);
    res.write(`id: ${id}\n`);
    res.write(`event: snapshot\n`);
    res.write(`data: ${JSON.stringify({ snapshot, generatedAt: snapshot.generatedAt, mtimeMs })}\n\n`);

    // Vercel-friendly SSE-lite: emit authoritative snapshot, then close.
    // EventSource will reconnect using retry interval for near-real-time updates.
    res.end();
  } catch (err) {
    res.status(500).json({ error: 'stream endpoint failed', details: String(err.message || err) });
  }
};
