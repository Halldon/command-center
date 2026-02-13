#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {verifyMessage} = require('ethers');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'artifacts', 'run_manifest.json');
const sigPath = path.join(root, 'artifacts', 'run_manifest.sig.json');

const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
const sig = JSON.parse(fs.readFileSync(sigPath, 'utf8'));
const digest = crypto.createHash('sha256').update(manifestRaw).digest('hex');
const expectedMessage = `Eigen-style verifiable agent run\nmanifest_sha256:${digest}`;
const recovered = verifyMessage(expectedMessage, sig.signature);

const checks = {
  messageMatches: sig.message === expectedMessage,
  recoveredMatchesRecorded: recovered.toLowerCase() === String(sig.signerAddress).toLowerCase(),
  recoveredMatchesStoredRecovered: recovered.toLowerCase() === String(sig.recoveredAddress).toLowerCase()
};

const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ok,checks,recovered,signer:sig.signerAddress},null,2));
if(!ok) process.exit(1);
