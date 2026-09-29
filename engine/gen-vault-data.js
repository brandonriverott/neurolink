#!/usr/bin/env node
/* ============================================================
   gen-vault-data.js — writes vault-data.js (window.VAULT_LIVE)
   for the Neurolink HD brain. The actual scan lives in the shared
   vault-graph.mjs module (also used by rag-server.mjs's live /graph),
   so the static snapshot and the live endpoint can never disagree.

   Run:  node gen-vault-data.js   (re-run anytime; refresh.mjs runs it nightly)
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { scanVaultGraph, REGION_META } from './vault-graph.mjs';

const OUT = path.join(import.meta.dirname, 'vault-data.js');
const g = scanVaultGraph();
fs.writeFileSync(OUT, 'window.VAULT_LIVE = ' + JSON.stringify(g) + ';\n');

console.log(`✓ wrote ${OUT}`);
console.log(`  neurons (notes):     ${g.totalNeurons}`);
console.log(`  synapses (wikilinks):${String(g.totalSynapses).padStart(6)}  → ${g.edgeCount} resolved unique edges`);
console.log(`  tag neurons:         ${g.nodes.filter(n => n.tag).length}`);
console.log('  region counts:');
for (const k of Object.keys(REGION_META)) {
  console.log(`    ${REGION_META[k].name.padEnd(18)} ${String(g.regions[k].count).padStart(4)}  (${g.regions[k].recent} fired 7d)`);
}
