#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {Wallet, verifyMessage} = require('ethers');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'artifacts', 'run_manifest.json');
const sigPath = path.join(root, 'artifacts', 'run_manifest.sig.json');

const walletDir = '/Users/j/.openclaw/secrets';
const walletFile = fs.readdirSync(walletDir).filter(f=>f.startsWith('agent-wallet-')).sort().slice(-1)[0];
if (!walletFile) throw new Error('No agent-wallet-* file found');
const walletJson = JSON.parse(fs.readFileSync(path.join(walletDir, walletFile), 'utf8'));
const wallet = new Wallet(walletJson.privateKeyHex);

(async()=>{
  const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
  const digest = crypto.createHash('sha256').update(manifestRaw).digest('hex');
  const message = `Eigen-style verifiable agent run\nmanifest_sha256:${digest}`;
  const signature = await wallet.signMessage(message);
  const recovered = verifyMessage(message, signature);
  const payload = {
    signedAt: new Date().toISOString(),
    signerAddress: wallet.address,
    recoveredAddress: recovered,
    message,
    signature,
    walletFile
  };
  fs.writeFileSync(sigPath, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ok:true,sigPath,signer:wallet.address,recovered},null,2));
})();
