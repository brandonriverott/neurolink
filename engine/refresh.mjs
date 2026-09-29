#!/usr/bin/env node
/* ============================================================
   refresh.mjs — keeps the brain's retrieval CURRENT.
     1. rebuild rag-index.json   (re-embed the vault — the heavy step)
     2. regen vault-data.js      (cockpit snapshot — fast)
     3. the running server loads the atomic snapshot on its next freshness tick
   Runs DIRECTLY under launchd as `node refresh.mjs` (node has Full Disk Access;
   no shell wrapper, no claude, no keychain). Manual: node refresh.mjs
   Schedule lives in ~/Library/LaunchAgents/com.neurolink.refresh.plist (StartInterval 3600 = hourly
   when read 2026-09-29). The server also checks for changed notes on a timer: rag-server.mjs calls
   liveIndex.start() with live-index.mjs's default of 60000 ms (60 s) as of 2026-09-29.
   ============================================================ */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const DIR = import.meta.dirname;
const NODE = process.execPath;                         // the same FDA-granted node running this
const stamp = () => new Date().toISOString();
const run = (cmd, args) => {
  console.log(`\n$ ${cmd.split('/').pop()} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd: DIR, stdio: 'inherit' });
};

// Full re-embed only when forced, when no index exists, or when the index is stale (>20h) —
// the daily integrity backstop. Otherwise a fast incremental refresh (reuse unchanged files'
// vectors, embed only what changed) so this can run every few hours cheaply and same-day notes
// become searchable without waiting for the nightly full.
let full = process.argv.includes('--full');
if (!full) {
  // With the hourly plist schedule above, the run that starts in the 03:00 hour does the daily
  // FULL integrity rebuild; every other run is a fast incremental.
  // (Gating on builtAt-age never fires once incrementals run hourly — each incremental
  //  refreshes builtAt — so the daily full is keyed on the early-morning hour instead.)
  if (new Date().getHours() === 3) full = true;
  else { try { JSON.parse(fs.readFileSync(path.join(DIR, 'rag-index.json'), 'utf8')); } catch { full = true; } }   // missing/corrupt index → full rebuild
}
console.log(`🔄 neurolink refresh (${full ? 'FULL' : 'incremental'}) — ${stamp()}`);
// 1. re-embed (full ~2h / incremental ~30s). A build fails when the vault changes mid-build or the
// server's own timed refresh (see header) holds the lock (exit 75) — both transient, so retry as a fast incremental.
// ponytail: 3 tries, 60s apart; a full rebuild that loses the race falls back to incremental (index stays current).
let fullMissed = false;
for (let attempt = 1; ; attempt++) {
  try { run(NODE, full && attempt === 1 ? ['rag-index.mjs', '--full'] : ['rag-index.mjs']); break; }
  catch (e) {
    if (attempt >= 3) throw e;
    if (full && attempt === 1) fullMissed = true;
    console.log(`  ↻ index build attempt ${attempt} failed (exit ${e.status}) — retrying incremental in 60s`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
  }
}
if (fullMissed) console.log('  ⚠ daily FULL integrity rebuild MISSED — index kept current by incremental only; full retries in the next 03:00-hour run');
run(NODE, ['gen-vault-data.js']);      // 2. cockpit snapshot (fast)
console.log('  ↻ running server observes the atomic index without a forced restart');
console.log(`✓ refresh done — ${stamp()}`);
