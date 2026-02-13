#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {execSync} = require('child_process');

const root = path.resolve(__dirname, '..');
const srcPath = path.join(root, 'src', 'run_agent.js');
const inputPath = path.resolve(root, '..', 'command-center-app', 'snapshot.json');
const outputPath = path.join(root, 'artifacts', 'agent_output.json');
const manifestPath = path.join(root, 'artifacts', 'run_manifest.json');

const hashFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function gitRev(){
  try { return execSync('git rev-parse HEAD',{cwd:path.resolve(root,'..')}).toString().trim(); }
  catch { return 'unknown'; }
}

const manifest = {
  manifestVersion: '1.0.0',
  generatedAt: new Date().toISOString(),
  code: {
    entrypoint: srcPath,
    sha256: hashFile(srcPath),
    gitCommit: gitRev()
  },
  input: {
    path: inputPath,
    sha256: hashFile(inputPath)
  },
  output: {
    path: outputPath,
    sha256: hashFile(outputPath)
  },
  upgradePolicy: {
    policyFile: path.join(root, 'policies', 'upgrade_policy.json'),
    mode: 'explicit-policy-file-required'
  }
};

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ok:true,manifestPath},null,2));
