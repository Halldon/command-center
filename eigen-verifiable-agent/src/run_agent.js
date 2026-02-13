#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const snapshotPath = path.resolve(root, '..', 'command-center-app', 'snapshot.json');
const outPath = path.join(root, 'artifacts', 'agent_output.json');

function score(item){
  const impact = Number(item.impact || 0);
  const urgency = Number(item.urgency || 0);
  const confidence = Number(item.confidence || 0) * 100;
  return impact * 0.45 + urgency * 0.35 + confidence * 0.20;
}

function main(){
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const attention = snapshot?.attentionQueue?.items || [];
  const ranked = attention
    .map(i => ({...i, computedScore: Number(score(i).toFixed(2))}))
    .sort((a,b)=>b.computedScore-a.computedScore);

  const top3 = ranked.slice(0,3).map(i => ({
    id: i.id,
    title: i.title,
    severity: i.severity,
    computedScore: i.computedScore,
    recommendedAction: i.recommendedAction?.label || 'Review manually'
  }));

  const output = {
    runAt: new Date().toISOString(),
    policyVersion: '1.0.0',
    objective: 'Rank operator attention and recommend immediate actions',
    top3,
    meta: {
      sourceSnapshot: snapshotPath,
      totalAttentionItems: attention.length,
      schemaVersion: snapshot.schemaVersion || 'unknown'
    }
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ok:true,outPath,top3Count:top3.length}, null, 2));
}

main();
