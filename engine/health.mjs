#!/usr/bin/env node
/* health.mjs — fast (<5s) brain health check. No claude calls. Runs every 6h via launchd. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG, logFile } from './config.mjs';

const HOUR = 36e5;
const REFLECTION_MAX_AGE_H = 48;
const SELFTEST_MAX_AGE_H = 36;
const REFRESH_MAX_AGE_H = 12;
// Four scheduled refreshes are six hours apart; allow 30 minutes for launchd jitter.
const RAG_REFRESH_LAG_SLA_H = 6.5;
const TRACE_MINER_MAX_AGE_H = 8 * 24;
const PENDING_MAX_AGE_H = 1;
const FAILED_EVENT_RECENT_H = 48;

const ageHours = (nowMs, ts) => Math.max(0, (nowMs - ts) / HOUR);
const formatAge = hours => hours < 1 ? `${Math.round(hours * 60)}m` : `${Math.round(hours)}h`;
const formatLag = hours => `${Math.round(hours * 10) / 10}h`;
const outcomeOf = entry => entry?.outcome || (entry?.wrote ? 'wrote' : entry?.skipped ? 'skipped' : '');
const isFailedOutcome = entry => /failed|poison/i.test(outcomeOf(entry));

function readJsonLines(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return { entries: lines.map(line => JSON.parse(line)), valid: true, count: lines.length };
  } catch {
    return { entries: [], valid: false, count: 0 };
  }
}

function visibleFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
      .map(entry => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function latestByTs(entries) {
  return entries.reduce((latest, entry) => (entry.ts || 0) > (latest?.ts || 0) ? entry : latest, null);
}

function componentOutcome(entries, { filter, success, maxAgeH, nowMs }) {
  const component = entries.filter(filter);
  const latest = latestByTs(component);
  const lastSuccess = latestByTs(component.filter(success));
  const latestAge = latest?.ts ? ageHours(nowMs, latest.ts) : null;
  const successAge = lastSuccess?.ts ? ageHours(nowMs, lastSuccess.ts) : null;
  const latestFailed = latest && isFailedOutcome(latest)
    && (!lastSuccess || (latest.ts || 0) > (lastSuccess.ts || 0));

  if (latestFailed) {
    const prior = successAge === null ? 'no successful outcome recorded' : `last success ${formatAge(successAge)} ago`;
    return { pass: false, detail: `latest failed ${formatAge(latestAge)} ago · ${prior}` };
  }
  if (successAge === null) return { pass: false, detail: 'not yet successful' };
  return {
    pass: successAge < maxAgeH,
    detail: `last success ${formatAge(successAge)} ago · ${outcomeOf(lastSuccess)}`,
  };
}

function serviceDefinitions(dir) {
  try {
    const plists = fs.readdirSync(dir).filter(name => name.endsWith('.plist')).sort();
    const labels = plists.map(name => {
      const source = fs.readFileSync(path.join(dir, name), 'utf8');
      return source.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/)?.[1] || null;
    });
    return { files: plists.length, labels: labels.filter(Boolean) };
  } catch {
    return { files: 0, labels: [] };
  }
}

function refreshOutcome(file, nowMs) {
  let source;
  try { source = fs.readFileSync(file, 'utf8'); }
  catch { return { pass: false, detail: 'missing' }; }

  const starts = [...source.matchAll(/🔄 neurolink refresh[^\n]* — ([^\n]+)/g)]
    .map(match => Date.parse(match[1].trim())).filter(Number.isFinite);
  const successes = [...source.matchAll(/✓ refresh done — ([^\n]+)/g)]
    .map(match => Date.parse(match[1].trim())).filter(Number.isFinite);
  const lastStart = starts.length ? Math.max(...starts) : null;
  const lastSuccess = successes.length ? Math.max(...successes) : null;

  if (lastStart !== null && (lastSuccess === null || lastStart > lastSuccess)) {
    const prior = lastSuccess === null ? 'no successful refresh recorded' : `last success ${formatAge(ageHours(nowMs, lastSuccess))} ago`;
    return { pass: false, detail: `latest run incomplete/failed — started ${formatAge(ageHours(nowMs, lastStart))} ago · ${prior}` };
  }
  if (lastSuccess === null) return { pass: false, detail: 'no successful refresh recorded' };
  const ageH = ageHours(nowMs, lastSuccess);
  return { pass: ageH < REFRESH_MAX_AGE_H, detail: `last success ${formatAge(ageH)} ago` };
}

function queueAgeCheck(dir, nowMs, mode) {
  const files = visibleFiles(dir);
  if (!files.length) return { pass: true, detail: mode === 'pending' ? '0 pending' : '0 failed' };
  const mtimes = files.map(file => fs.statSync(file).mtimeMs);
  if (mode === 'pending') {
    const oldestAge = ageHours(nowMs, Math.min(...mtimes));
    return { pass: oldestAge < PENDING_MAX_AGE_H, detail: `${files.length} pending · oldest ${formatAge(oldestAge)}` };
  }
  const newestAge = ageHours(nowMs, Math.max(...mtimes));
  return { pass: newestAge >= FAILED_EVENT_RECENT_H, detail: `${files.length} failed · newest ${formatAge(newestAge)}` };
}

export async function runHealth({
  env = process.env,
  nowMs = Date.now(),
  fetchFn = fetch,
  execFile = execFileSync,
  stdout = console.log,
} = {}) {
  const HOME = env.NEUROLINK_HOME || CONFIG.home;
  const VAULT = env.NEUROLINK_VAULT || CONFIG.vault;
  const LOG = env.NEUROLINK_LOG || path.join(HOME, 'neuron-log.jsonl');
  const RAG = env.NEUROLINK_RAG_URL || 'http://localhost:8920';
  const QUEUE = env.NEUROLINK_REFLECT_QUEUE || CONFIG.reflectQueue;
  const SELFTEST_LOG = env.NEUROLINK_SELFTEST_LOG || path.join(HOME, 'selftest-log.jsonl');
  const REFRESH_LOG = env.NEUROLINK_REFRESH_LOG || logFile('neurolink-refresh.log');
  const LAUNCHCTL = env.NEUROLINK_LAUNCHCTL_CMD || 'launchctl';
  const LAUNCHD_DIR = env.NEUROLINK_LAUNCHD_DIR || path.join(HOME, 'ops', 'launchd');
  const STATUS_FILE = path.join(HOME, 'health-status.json');
  const now = new Date(nowMs);
  const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const checks = [], flags = [];
  const ok = (name, pass, detail = '') => checks.push({ name, pass, detail });

  // Loaded/reachable checks deliberately stay separate from useful-output checks below.
  let ragOk = false, ragInfo = '';
  try {
    const response = await fetchFn(`${RAG.replace(/\/$/, '')}/health`);
    if (response.ok) {
      const data = await response.json();
      ragOk = true;
      ragInfo = `${data.chunks} chunks · claude: ${data.claude ? 'on' : 'off'}`;
    }
  } catch {}
  ok('RAG service reachable (loaded)', ragOk, ragInfo);
  if (!ragOk) flags.push('RAG server down — start: node rag-server.mjs');

  let idxFresh = false, idxDetail = '';
  let idxMtime;
  try { idxMtime = fs.statSync(path.join(HOME, 'rag-index.json')).mtimeMs; }
  catch { idxDetail = 'no index file'; }
  if (idxMtime !== undefined) {
    try {
      let newest = 0;
      for (const dir of CONFIG.freshnessDirs) {
        const full = path.join(VAULT, dir);
        if (!fs.existsSync(full)) continue;
        for (const file of fs.readdirSync(full)) {
          if (!file.endsWith('.md') || file === 'Self-Test.md' || file === 'Log.md') continue;
          newest = Math.max(newest, fs.statSync(path.join(full, file)).mtimeMs);
        }
      }
      const lagH = Math.max(0, (newest - idxMtime) / HOUR);
      idxFresh = lagH <= RAG_REFRESH_LAG_SLA_H;
      if (lagH === 0) idxDetail = 'up to date';
      else if (idxFresh) idxDetail = `${formatLag(lagH)} behind newest note · within ${RAG_REFRESH_LAG_SLA_H}h refresh window`;
      else idxDetail = `${formatLag(lagH)} behind newest note · exceeds ${RAG_REFRESH_LAG_SLA_H}h refresh SLA`;
    } catch { idxDetail = 'eligible note metadata unreadable'; }
  }
  ok('RAG index fresh', idxFresh, idxDetail);
  if (!idxFresh) flags.push('RAG index stale — rebuild: node rag-index.mjs');

  let vdFresh = true, vdDetail = '';
  try {
    const vm = fs.statSync(path.join(HOME, 'vault-data.js')).mtimeMs;
    const idxMtime = fs.statSync(path.join(HOME, 'rag-index.json')).mtimeMs;
    vdFresh = vm >= idxMtime - HOUR;
    vdDetail = vdFresh ? 'up to date' : 'stale';
  } catch { vdFresh = false; vdDetail = 'missing'; }
  ok('cockpit data fresh', vdFresh, vdDetail);

  let patternCount = 0;
  try { patternCount = fs.readdirSync(path.join(VAULT, '_brain', 'patterns')).filter(file => /patterns(-\d+)?\.md$/.test(file)).length; } catch {}
  ok('pattern notes present', patternCount > 0, `${patternCount} notes`);

  let mocOk = false;
  try { mocOk = fs.readFileSync(path.join(VAULT, '_brain', 'patterns', 'Patterns — MOC.md'), 'utf8').includes('## Runs'); } catch {}
  ok('Patterns MOC intact', mocOk);

  const neuronLog = readJsonLines(LOG);
  ok('neuron-log valid', neuronLog.valid, `${neuronLog.count} runs`);

  let tasteOk = false;
  try { tasteOk = fs.readFileSync(path.join(VAULT, '_brain', 'patterns', 'Taste Profile.md'), 'utf8').includes('<!-- AUTO-END'); } catch {}
  ok('taste profile intact', tasteOk);

  const definitions = serviceDefinitions(LAUNCHD_DIR);
  let loaded = [], launchctlFailed = false;
  try {
    const output = execFile(LAUNCHCTL, ['list'], { encoding: 'utf8', timeout: 5000 });
    loaded = definitions.labels.filter(label => output.includes(label));
  } catch { launchctlFailed = true; }
  const missing = definitions.labels.filter(label => !loaded.includes(label));
  const agentsOk = !launchctlFailed && definitions.files > 0
    && definitions.labels.length === definitions.files && missing.length === 0;
  const agentInfo = `${loaded.length}/${definitions.files} loaded${missing.length ? ` · missing: ${missing.join(', ')}` : ''}`;
  ok('launchd services loaded', agentsOk, agentInfo);
  if (!agentsOk) flags.push('not all defined Neurolink launchd services are loaded');

  const reflection = componentOutcome(neuronLog.entries, {
    filter: entry => ['pattern', 'memory', 'link', 'reflect'].includes(entry.neuron),
    success: entry => ['wrote', 'ok'].includes(outcomeOf(entry)),
    maxAgeH: REFLECTION_MAX_AGE_H,
    nowMs,
  });
  ok('reflection recent useful outcome', reflection.pass, reflection.detail);
  if (!reflection.pass) flags.push('reflection has no recent successful useful outcome');

  const selftest = readJsonLines(SELFTEST_LOG);
  const selftestLast = latestByTs(selftest.entries);
  let selftestPass = false, selftestDetail = 'not yet run';
  if (selftestLast?.ts) {
    const ageH = ageHours(nowMs, selftestLast.ts);
    const ratio = selftestLast.total ? selftestLast.passed / selftestLast.total : 0;
    selftestPass = ageH < SELFTEST_MAX_AGE_H && ratio >= 0.8;
    selftestDetail = `${selftestLast.passed ?? 0}/${selftestLast.total ?? 0} passed · ${formatAge(ageH)} ago`;
  }
  ok('self-test fresh outcome', selftestPass, selftestDetail);
  if (!selftestPass) flags.push('self-test is stale, missing, or below 80%');

  const refresh = refreshOutcome(REFRESH_LOG, nowMs);
  ok('refresh recent successful outcome', refresh.pass, refresh.detail);
  if (!refresh.pass) flags.push('refresh has no recent completed success');

  const traceMiner = componentOutcome(neuronLog.entries, {
    filter: entry => entry.neuron === 'trace-miner',
    success: entry => ['wrote', 'skipped'].includes(outcomeOf(entry)),
    maxAgeH: TRACE_MINER_MAX_AGE_H,
    nowMs,
  });
  ok('Trace-Miner recent successful outcome', traceMiner.pass, traceMiner.detail);
  if (!traceMiner.pass) flags.push('Trace-Miner has no recent successful run');

  const pending = queueAgeCheck(QUEUE, nowMs, 'pending');
  ok('pending reflection queue age', pending.pass, pending.detail);
  if (!pending.pass) flags.push('reflection queue has pending work older than 1h');

  const failedEvents = queueAgeCheck(`${QUEUE}.failed`, nowMs, 'failed');
  ok('failed reflection event age', failedEvents.pass, failedEvents.detail);
  if (!failedEvents.pass) flags.push('reflection queue has a failed event from the last 48h');

  ok('health monitor alive', true, 'running');

  const passN = checks.filter(check => check.pass).length;
  const healthPct = Math.round(passN / checks.length * 100);
  const criticalChecks = new Set([
    'RAG service reachable (loaded)',
    'RAG index fresh',
    'launchd services loaded',
    'reflection recent useful outcome',
    'self-test fresh outcome',
    'refresh recent successful outcome',
    'Trace-Miner recent successful outcome',
    'pending reflection queue age',
    'failed reflection event age',
  ]);
  const criticalFailed = checks.filter(check => !check.pass && criticalChecks.has(check.name));
  const alert = healthPct < 80 || criticalFailed.length > 0;
  const status = { ts: nowMs, date: TODAY, checks, health_pct: healthPct, flags, alert };
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));

  stdout(`🩺 brain health — ${healthPct}% (${passN}/${checks.length})${alert ? ' ⚠️ ALERT' : ' ✅'}`);
  for (const check of checks) stdout(`  ${check.pass ? '✅' : '❌'} ${check.name}${check.detail ? ' — ' + check.detail : ''}`);
  if (flags.length) {
    stdout('⚠️ flags:');
    for (const flag of flags) stdout('  - ' + flag);
  }
  return status;
}

// Compare real paths: started through a symlinked folder, argv[1] is the link path but import.meta.url is the real one.
const realPath = p => { try { return fs.realpathSync(p); } catch { return p; } };
const isMain = process.argv[1] && realPath(path.resolve(process.argv[1])) === realPath(fileURLToPath(import.meta.url));
if (isMain) await runHealth();