/* test-trace-miner.mjs — behavioural suite for trace-miner.mjs (design v5 §6.2, assertions 1-18).
   Plain node:assert, mirroring test-health.mjs. Run: node engine/neurons/test-trace-miner.mjs
   Optional filter arg (comma list of assertion numbers or goal tags G1..G5 / H) runs a subset.
   Every spawned run uses a throwaway engine copy + private config + a model stub, cleaned in finally. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HERE = import.meta.dirname;
const WT = path.resolve(HERE, '..', '..');
const FIXTURES = path.join(HERE, 'fixtures', 'trace-miner');
const NODE = process.execPath;
const NOW = Date.now();
const DAY = 864e5;
const PRIV = 'PRIVATEMARKER';

// Dynamic import so a missing/renamed export is a per-assertion RED, not a load abort.
let tm = {};
let importErr = null;
try { tm = await import(pathToFileURL(path.join(HERE, 'trace-miner.mjs')).href); }
catch (e) { importErr = e; tm = {}; }

const DEFAULT_REPLY = [{ title: 'A unique recurring fixable problem alpha', evidence: 'seen 2 times', confidence: 'low' }];
const allCtx = [];

function compose(...objs) { return Object.assign({}, ...objs); }

function copyTree(src, dst, mtimeMs) {
  fs.mkdirSync(dst, { recursive: true });
  const t = mtimeMs / 1000;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d, mtimeMs);
    else fs.copyFileSync(s, d);
    fs.utimesSync(d, t, t);
  }
  fs.utimesSync(dst, t, t);
}

function mkCtx(cfg = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tmtest-')));
  allCtx.push(tmp);
  const engine = path.join(tmp, 'engine');
  fs.mkdirSync(path.join(engine, 'neurons'), { recursive: true });
  fs.copyFileSync(path.join(HERE, 'trace-miner.mjs'), path.join(engine, 'neurons', 'trace-miner.mjs'));
  fs.copyFileSync(path.join(HERE, '..', 'config.mjs'), path.join(engine, 'config.mjs'));
  const config = {
    ownerName: 'Tester', stackDescription: 'test stack', logDir: tmp,
    privateNamePattern: cfg.privateNamePattern ?? PRIV,
    loopLedgerMaxAgeDays: cfg.loopLedgerMaxAgeDays ?? 21,
    vault: path.join(tmp, 'vault'), home: path.join(tmp, 'home'),
    hermesHome: path.join(tmp, 'hermes'), loopLedger: '', reviewRoots: [],
  };
  fs.writeFileSync(path.join(engine, 'neurolink.config.json'), JSON.stringify(config));
  const stub = path.join(tmp, 'stub.sh');
  fs.writeFileSync(stub, [
    '#!/bin/sh',
    'printf "\\n===CALL args:%s===\\n" "$*" >> "$TM_CAPTURE" 2>/dev/null',
    'echo 1 >> "$TM_COUNTER"',
    'if [ "${TM_RC:-0}" != "0" ]; then exit "$TM_RC"; fi',
    'cat "$TM_REPLY"',
    '',
  ].join('\n'));
  fs.chmodSync(stub, 0o755);
  const capture = path.join(tmp, 'capture.txt');
  const counter = path.join(tmp, 'counter.txt');
  const reply = path.join(tmp, 'reply.json');
  const log = path.join(tmp, 'neuron-log.jsonl');
  const outDir = path.join(tmp, 'vault', '_claude', 'learning', 'trace-proposals');
  const baseEnv = compose(process.env, {
    NEUROLINK_VAULT: path.join(tmp, 'vault'),
    NEUROLINK_HOME: path.join(tmp, 'home'),
    NEUROLINK_HERMES: path.join(tmp, 'hermes'),
    LOOP_LEDGER_FILE: '',
    NEUROLINK_REVIEW_ROOTS: '',
    NEUROLINK_LOG: log,
    NEUROLINK_CLAUDE_CMD: stub,
    TM_CAPTURE: capture, TM_COUNTER: counter, TM_REPLY: reply, TM_RC: '0',
  });
  const ctx = { tmp, engine, config, stub, capture, counter, reply, log, outDir, baseEnv, restored: [] };

  ctx.seedErrors = (content = 'WARNING something failed\nWARNING something failed\n') => {
    const p = path.join(tmp, 'hermes', 'logs', 'errors.log');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };
  ctx.errorsUnreadable = () => {
    const p = ctx.seedErrors('WARNING x\n');
    fs.chmodSync(p, 0o000); ctx.restored.push(p);
    return p;
  };
  ctx.seedReviews = (opts = {}) => {
    const root = path.join(tmp, 'reviews');
    copyTree(FIXTURES, root, NOW - 1 * DAY);
    const pe = path.join(root, 'proposals-example.md');
    if (fs.existsSync(pe)) fs.rmSync(pe);
    const oldT = (NOW - 20 * DAY) / 1000;
    const g = path.join(root, 'job-g-review-r1');
    if (fs.existsSync(g)) for (const f of fs.readdirSync(g)) fs.utimesSync(path.join(g, f), oldT, oldT);
    if (opts.oldCopy) {
      const of = path.join(root, 'job-old-review-20261001');
      fs.mkdirSync(of, { recursive: true });
      fs.copyFileSync(path.join(root, 'job-a-review-20261107', 'REVIEW-G1.md'), path.join(of, 'REVIEW-OLD.md'));
      fs.utimesSync(path.join(of, 'REVIEW-OLD.md'), oldT, oldT);
      fs.utimesSync(of, oldT, oldT);
    }
    if (opts.symlinkAndBig) {
      const jf = path.join(root, 'job-a-review-20261107');
      const target = path.join(jf, 'SYMLINK_TARGET.txt');
      fs.writeFileSync(target, 'VERDICT: FAIL\nMinor M1. SYMLINK_UNIQUE_MARKER_ZZZ\n');
      try { fs.symlinkSync(target, path.join(jf, 'REVIEW-SYMLINK.md')); } catch {}
      const big = path.join(root, 'job-f-review-20261103', 'REVIEW-BIG.md');
      fs.writeFileSync(big, 'VERDICT: FAIL\nMinor M1. BIGFILE_UNIQUE_MARKER_ZZZ ' + 'x'.repeat(210000));
    }
    if (opts.chmodOne) {
      const p = path.join(root, 'job-a-review-20261107', 'REVIEW-G1.md');
      fs.chmodSync(p, 0o000); ctx.restored.push(p);
    }
    return root;
  };
  ctx.ledger = (rows) => {
    const p = path.join(tmp, 'ledger.jsonl');
    fs.writeFileSync(p, rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    return p;
  };
  ctx.prior = (files) => {
    fs.mkdirSync(outDir, { recursive: true });
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(outDir, name), text);
    return outDir;
  };
  ctx.unwritableOut = () => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.chmodSync(outDir, 0o500); ctx.restored.push(outDir);
  };
  ctx.readOutputs = () => {
    let names = [];
    try { names = fs.readdirSync(outDir); } catch { names = []; }
    const all = {};
    for (const n of names) { try { all[n] = fs.readFileSync(path.join(outDir, n), 'utf8'); } catch {} }
    const proposalFiles = names.filter(n => /^\d{4}-\d{2}-\d{2}-trace-proposals(?:-\d+)?\.md$/i.test(n));
    const statusFiles = names.filter(n => /^\d{4}-\d{2}-\d{2}-trace-miner-status\.md$/i.test(n));
    const tmpFiles = names.filter(n => /\.tmp$/i.test(n) || /^\./.test(n));
    return { names, all, proposalFiles, statusFiles, tmpFiles };
  };
  ctx.spawn = (args = [], replyVal, overlays = {}) => {
    fs.writeFileSync(reply, typeof replyVal === 'string' ? replyVal : JSON.stringify(replyVal ?? DEFAULT_REPLY));
    const env = compose(baseEnv, overlays);
    let stdout = '', stderr = '', code = 0;
    const r = spawnSync(NODE, [path.join(engine, 'neurons', 'trace-miner.mjs'), ...args],
      { env, encoding: 'utf8', cwd: tmp, timeout: 30000 });
    stdout = r.stdout ? String(r.stdout) : '';
    stderr = r.stderr ? String(r.stderr) : '';
    if (r.error) stderr += String(r.error);
    code = (r.status == null) ? 1 : r.status;
    let captureText = '', counterN = 0, receipts = [];
    try { captureText = fs.readFileSync(capture, 'utf8'); } catch {}
    try { counterN = fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length; } catch {}
    try { receipts = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
    return { stdout, stderr, code, captureText, counterN, receipts, ctx };
  };
  return ctx;
}

function cleanup() {
  for (const tmp of allCtx) {
    for (const p of (mkCtx._restored || [])) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ---- verification cases for verdict & finding shapes ----
const VERDICT_CASES = [
  ['VERDICT: **PASS**', 'PASS'],
  ['VERDICT: PASS.', 'PASS'],
  ['**VERDICT:** PASS', 'PASS'],
  ['**VERDICT**: PASS', 'PASS'],
  ['VERDICT: CHANGES_REQUIRED', 'CHANGES REQUESTED'],
  ['VERDICT: CHANGES REQUESTED', 'CHANGES REQUESTED'],
  ['VERDICT: BLOCK — see findings', 'BLOCKED'],
  ['VERDICT: PASS | FAIL', null],
  ['PASS — generation 1, independent static review.', 'PASS'],
  ['# Generation 1 review: BLOCK', 'BLOCKED'],
  ['# Code review: pass-through cache\nVERDICT: FAIL', 'FAIL'],
  ['# Review: Failed login handling\nVERDICT: PASS', 'PASS'],
  ['# Review: Failed login handling', null],
  ['PASS/FAIL gate notes', null],
  ['Fail-safe behaviour is missing', null],
  ['VERDICT: PASS WITH BLOCKERS', 'UNVERIFIED'],   // N6
  ['PASS with required changes', 'UNVERIFIED'],    // N6
];
// [line, expectedFindingCount]
const FINDING_CASES = [
  ['**Blocker:** none.', 0],
  ['Major: No issues', 0],
  ['Minor: n/a', 0],
  ['Blocker: none observed.', 0],
  ['Major: no issues found', 0],
  ['Blocker: No rollback when the write fails', 1],
  ['**Major**: real issue', 1],
  ['Major: Closed sessions leak tokens', 1],
  ['[P2] closed-loop check is missing', 1],
  ['Minor: No major issues found', 0],
  ['Major: no blocking issues', 0],
];
const CLOSED_CASES = [
  'Minor M1 [closed]: done',
  '- [closed] Blocker: x',
  'Minor M1: [closed] x',
  'Major: x (closed)',
];
// 11 legacy selftest cases (findingStatus / isClosedStatus)
const SELFTEST_CASES = [
  ['3. HIGH, PARTLY CLOSED (`:10-20`). The input check covers one path only.', false],
  ['4. MEDIUM, CLOSED — `:30-35` now describes the rollback correctly.', true],
  ['3. HIGH, CLOSED for the reported masked-`ls` failure (`:40-48`).', true],
  ['7. MEDIUM, OPEN (`:50-60`). The diff check misses changed values.', false],
  ['1. **HIGH — Requests can be dropped after the socket is closed early**', false],
  ['3. HIGH — error handling is not fail-closed', false],
  ['A. **MEDIUM — a second run can still replace the pending job** (`:18`)', false],
  ['**MEDIUM — The timeout test still does not exercise the failure path** (`:98`)', false],
  ['2. **LOW, CLOSED** — the old note now matches the result', true],
  ['| 1, HIGH, job concurrency | **Partly closed** | `:70-80` separate groups', false],
  ['| 7, LOW, an outdated setup note whose topic runs long enough to push the status cell past eighty chars | **Closed** |', true],
];

// scanBuilderReviews probe: one job folder with one REVIEW-1.md
function probe(tm, verdictLine, findingLines, opts = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tmprobe-')));
  allCtx.push(tmp);
  const root = path.join(tmp, 'reviews');
  const jf = path.join(root, 'probe-review-20261101');
  fs.mkdirSync(jf, { recursive: true });
  const text = [verdictLine, ...findingLines].join('\n') + '\n';
  fs.writeFileSync(path.join(jf, 'REVIEW-1.md'), text);
  const t = (NOW - 1 * DAY) / 1000;
  fs.utimesSync(path.join(jf, 'REVIEW-1.md'), t, t);
  fs.utimesSync(jf, t, t);
  const res = tm.scanBuilderReviews([root], {
    now: NOW, maxAgeMs: 7 * DAY, privateName: opts.privateName || new RegExp(PRIV, 'i'),
  });
  return res;
}

// ===================== ASSERTIONS =====================
const TESTS = [];

TESTS.push({ n: 1, goal: 'G1', name: '1 G1 files — depth-1 REVIEW*.md scan, legacy, window, privacy, caps', fn: () => {
  const ctx = mkCtx();
  const root = ctx.seedReviews({ oldCopy: true, symlinkAndBig: true });
  const res = tm.scanBuilderReviews([root], { now: NOW, maxAgeMs: 7 * DAY, privateName: new RegExp(PRIV, 'i') });
  const items = res.items;
  const byJob = j => items.filter(i => i.job === j);
  assert.ok(byJob('job-a').length >= 1, 'job-a present');
  const a = byJob('job-a')[0];
  assert.equal(a.verdict, 'PASS');
  assert.equal(a.generation, 1);
  assert.ok(a.findings.length >= 2, 'job-a >=2 findings');
  assert.ok(a.findings.every(f => f.length > 3 && !/^none$/i.test(f.trim())), 'no empty phrases');
  assert.ok(byJob('job-b').length >= 1 && byJob('job-b')[0].verdict === 'UNVERIFIED', 'job-b UNVERIFIED');
  assert.ok(byJob('job-c').length >= 1 && byJob('job-c')[0].generation === 2, 'job-c from REVIEW-2.md only');
  assert.ok(!items.some(i => i.findings.some(f => /BRIEF_DECOY_MARKER/.test(f))), 'REVIEW-BRIEF not counted');
  assert.ok(byJob('job-d').length === 1 && byJob('job-d')[0].round === 1 && byJob('job-d')[0].source === 'review-round', 'job-d legacy round 1 read once');
  assert.ok(byJob('job-f').length >= 1 && byJob('job-f')[0].verdict === 'BLOCKED', 'job-f BLOCKED');
  assert.ok(byJob('job-f')[0].findings.some(f => /P2|re-proposes/.test(f)), 'job-f [P2] finding');
  assert.ok(byJob('job-h').length >= 1 && byJob('job-h')[0].verdict === 'PASS', 'job-h trailing verdict normalized');
  assert.ok(byJob('job-i').length >= 1 && byJob('job-i')[0].findings.some(f => /\[x\]\s*Reject/.test(f)), 'job-i tick text is part of a finding');
  assert.ok(byJob('job-k').length >= 1 && byJob('job-k')[0].verdict === 'FAIL', 'job-k FAIL');
  assert.ok(!items.some(i => i.job === 'job-g'), 'job-g excluded (20-day window)');
  assert.ok(!items.some(i => i.job === 'job-old'), '20-day copy excluded');
  assert.ok(!items.some(i => i.job === 'job-j'), 'job-j excluded by private-name filter');
  assert.ok(!JSON.stringify(items).includes('NESTED_DECOY_MARKER'), 'nested decoy never read');
  assert.ok(!JSON.stringify(items).includes('job-e'), 'no item from nested-only job-e');
  assert.ok(!JSON.stringify(items).includes('SYMLINK_UNIQUE_MARKER_ZZZ'), 'symlinked review not read (marker can fail)');
  assert.ok(!JSON.stringify(items).includes('BIGFILE_UNIQUE_MARKER_ZZZ'), 'over-200k file not read (marker can fail)');
  // legacy folder read once (job-l also private-excluded)
  assert.ok(byJob('job-d').length === 1, 'legacy folder read once only');
}});

TESTS.push({ n: 2, goal: 'G1', name: '2 G1 shapes — verdict cases (incl. N6) + finding shapes', fn: () => {
  for (const [text, want] of VERDICT_CASES) {
    assert.equal(tm.normalizeVerdict(text), want, `verdict: ${JSON.stringify(text)}`);
  }
  for (const [line, count] of FINDING_CASES) {
    const r = probe(tm, 'VERDICT: FAIL', [line]);
    const it = r.items.find(i => i.job === 'probe');
    assert.ok(it, `item for finding line: ${line}`);
    assert.equal(it.findings.length, count, `finding count for: ${line}`);
  }
  for (const line of CLOSED_CASES) {
    const r = probe(tm, 'VERDICT: PASS', [line]);
    const it = r.items.find(i => i.job === 'probe');
    assert.ok(!it, `closed finding must not keep a PASS alive: ${line}`);
    const st = r.rootStatuses[0];
    assert.ok(st.cleanPass >= 1, `closed finding counted as clean PASS: ${line}`);
  }
}});

TESTS.push({ n: 3, goal: 'G1', name: '3 G1 legacy — 11 selftests, legacy window/privacy, global cap 20', fn: () => {
  for (const [line, closed] of SELFTEST_CASES) {
    assert.equal(tm.isClosedStatus(tm.findingStatus(line)), closed, `selftest: ${line}`);
  }
  const ctx = mkCtx();
  const root = ctx.seedReviews({ oldCopy: true });
  const res = tm.scanBuilderReviews([root], { now: NOW, maxAgeMs: 7 * DAY, privateName: new RegExp(PRIV, 'i') });
  assert.ok(!res.items.some(i => i.job === 'job-g'), 'legacy window drops job-g');
  assert.ok(!res.items.some(i => i.job === 'job-l'), 'legacy private-name filter excludes job-l');
  // global cap 20 with 22 generated review folders
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tmcap-')));
  allCtx.push(tmp);
  const capRoot = path.join(tmp, 'reviews');
  fs.mkdirSync(capRoot, { recursive: true });
  for (let k = 0; k < 22; k++) {
    const jf = path.join(capRoot, `gen-${k}-review-20261101`);
    fs.mkdirSync(jf, { recursive: true });
    fs.writeFileSync(path.join(jf, 'REVIEW-1.md'), `VERDICT: FAIL\nMinor M${k}. generated finding ${k}.\n`);
    const t = (NOW - 1 * DAY) / 1000;
    fs.utimesSync(path.join(jf, 'REVIEW-1.md'), t, t);
  }
  const capRes = tm.scanBuilderReviews([capRoot], { now: NOW, maxAgeMs: 7 * DAY, privateName: /(?!)/ });
  assert.ok(capRes.items.length <= 20, 'global cap 20');
  assert.ok(capRes.truncated.some(x => /reviews 20/.test(x)), 'reviews 20 truncated label');
}});

// helper: dry run that prints inputs line; returns {stdout, counterN, ...}
function dry(setup, reply) {
  const ctx = mkCtx(setup.cfg || {});
  if (setup.errors) ctx.seedErrors();
  if (setup.errorsUnreadable) ctx.errorsUnreadable();
  const ov = {};
  if (setup.reviews !== undefined) ov.NEUROLINK_REVIEW_ROOTS = setup.reviews;
  else if (setup.seedReviews) ov.NEUROLINK_REVIEW_ROOTS = ctx.seedReviews(setup.seedReviewsOpts || {});
  if (setup.ledgerPath !== undefined) ov.LOOP_LEDGER_FILE = setup.ledgerPath;
  if (setup.ledgerRows) ov.LOOP_LEDGER_FILE = ctx.ledger(setup.ledgerRows);
  if (setup.emptyLedgerSetting) ov.LOOP_LEDGER_FILE = '';
  if (setup.prior) ctx.prior(setup.prior);
  return ctx.spawn(['--dry'], reply ?? DEFAULT_REPLY, ov);
}

TESTS.push({ n: 4, goal: 'G2', name: '4 G2 statuses — 12 spawned --dry cases', fn: () => {
  // (i) existing root
  let r = dry({ errors: true, seedReviews: true });
  assert.match(r.stdout, /inputs:/, 'inputs line printed');
  assert.match(r.stdout, /reviews .*: ok \(/, 'existing root ok');
  assert.equal(r.counterN, 1, 'stub called once with signal');
  // (ii) missing root
  r = dry({ errors: true, reviews: '/definitely/nonexistent/tm-root' });
  assert.match(r.stdout, /missing \/definitely\/nonexistent\/tm-root/, 'missing root');
  // (iii) ledger all 40 days old
  const oldRows = Array.from({ length: 5 }, (_, k) => ({ verdict: 'FAIL', detail: 'old ' + k, ts: NOW / 1000 - 40 * 86400 }));
  r = dry({ errors: true, ledgerRows: oldRows });
  assert.match(r.stdout, /stale \(/, 'old ledger stale');
  // (iv) empty ledger setting
  r = dry({ errors: true, emptyLedgerSetting: true });
  assert.match(r.stdout, /loop ledger: not configured/, 'empty ledger not configured');
  // (v) ledger rows with no timestamp
  r = dry({ errors: true, ledgerRows: [{ verdict: 'FAIL', detail: 'no date' }, { verdict: 'FAIL', detail: 'undated' }] });
  assert.match(r.stdout, /no dated rows/, 'no-dated-rows stale');
  // (vi) one chmod 0 file
  r = dry({ errors: true, seedReviews: true, seedReviewsOpts: { chmodOne: true } });
  assert.match(r.stdout, /unreadable/, 'U unreadable counted');
  assert.equal(r.counterN, 1, 'other review files still used -> signal');
  // (vii) root is a file
  const ctxF = mkCtx();
  const fileRoot = path.join(ctxF.tmp, 'a-file.txt');
  fs.writeFileSync(fileRoot, 'x');
  const rf = ctxF.spawn(['--dry'], DEFAULT_REPLY, { NEUROLINK_REVIEW_ROOTS: fileRoot });
  assert.match(rf.stdout, /unreadable \(ENOTDIR\)/, 'root-is-file ENOTDIR');
  // (viii) missing prior-proposals folder
  r = dry({ errors: true });
  assert.match(r.stdout, /prior proposals: none yet/, 'missing prior folder none yet');
  // (ix) empty reviewRoots
  r = dry({ errors: true, reviews: '' });
  assert.match(r.stdout, /reviews: not configured/, 'empty reviewRoots');
  // (x) private-name review excluded + absent from prompt
  r = dry({ errors: true, seedReviews: true });
  assert.match(r.stdout, /excluded/, 'excluded counted');
  assert.ok(!/PRIVATEMARKER/.test(r.captureText), 'private-name review text absent from prompt');
  // (xi) missing + unreadable errors.log, with a seeded review fixture
  r = dry({ seedReviews: true });
  assert.match(r.stdout, /errors\.log: missing/, 'missing errors.log status');
  assert.equal(r.counterN, 1, 'missing errors.log + review signal -> stub 1');
  const ctxU = mkCtx();
  ctxU.errorsUnreadable();
  const uroot = ctxU.seedReviews();
  const ru = ctxU.spawn(['--dry'], DEFAULT_REPLY, { NEUROLINK_REVIEW_ROOTS: uroot });
  assert.match(ru.stdout, /errors\.log: unreadable/, 'unreadable errors.log status');
  assert.equal(ru.counterN, 1, 'unreadable errors.log + review signal -> stub 1');
  // (xii) no-signal run
  r = dry({});
  assert.equal(r.counterN, 0, 'no-signal -> no model call');
  assert.match(r.stdout, /no trace signal/, 'no-signal skipped reason');
}});

TESTS.push({ n: 5, goal: 'G3', name: '5 G3 ledger freshness — one fresh + 199 old, undated, fresh-mtime-old-rows', fn: () => {
  // direct loopFailures on a generated ledger
  const ctx = mkCtx();
  const old = Array.from({ length: 199 }, (_, k) => ({ verdict: 'FAIL', detail: 'stale ' + k, ts: (NOW - 40 * DAY) / 1000 }));
  const fresh = { verdict: 'FAIL', detail: 'fresh problem', ts: NOW / 1000 };
  const p = ctx.ledger([...old, fresh]);
  const lf = tm.loopFailures(p, { now: NOW, maxAgeDays: 21 });
  assert.equal(lf.clusters.length, 1, 'only fresh row failure remains');
  assert.match(lf.status.text, /older than 21d/, 'older count in status');
  assert.ok(lf.status.text.includes('199'), '199 older counted');
  // undated rows are dropped and counted as D undated when some rows are dated
  const p2 = ctx.ledger([{ verdict: 'FAIL', detail: 'dated', ts: NOW / 1000 }, { verdict: 'FAIL', detail: 'undated' }]);
  const lf2 = tm.loopFailures(p2, { now: NOW, maxAgeDays: 21 });
  assert.match(lf2.status.text, /undated/, 'undated counted');
  // fresh mtime + old rows -> stale (spawned dry)
  const ctx2 = mkCtx();
  const oldRows = Array.from({ length: 3 }, (_, k) => ({ verdict: 'FAIL', detail: 'o' + k, ts: (NOW - 40 * DAY) / 1000 }));
  const lp = ctx2.ledger(oldRows);
  fs.utimesSync(lp, Date.now() / 1000, Date.now() / 1000); // fresh mtime
  const r = ctx2.spawn(['--dry'], DEFAULT_REPLY, { LOOP_LEDGER_FILE: lp });
  assert.match(r.stdout, /stale \(/, 'fresh mtime + old rows still stale');
}});

function priorFixtureFile() {
  return fs.readFileSync(path.join(FIXTURES, 'proposals-example.md'), 'utf8');
}

TESTS.push({ n: 6, goal: 'G4', name: '6 G4 parser — readPriorProposals states, forged body/heading, lesson, caps', fn: () => {
  const ctx = mkCtx();
  const today = new Date(NOW);
  const d = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const dir = path.join(ctx.tmp, 'prior');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${d}-trace-proposals.md`), priorFixtureFile());
  const res = tm.readPriorProposals(dir, { now: NOW, maxAgeDays: 30 });
  const states = res.items.map(i => i.state);
  assert.ok(states.includes('rejected'), 'rejected state');
  assert.ok(states.includes('applied'), 'applied state');
  assert.ok(states.includes('pending'), 'pending state');
  // forged-body [x] Reject section stays pending
  const s3 = res.items.find(i => /Keep the ledger age limit/.test(i.title));
  assert.ok(s3 && s3.state === 'pending', 'forged-body tick section stays pending');
  // fenced forged heading yields no extra section / no state
  assert.ok(!res.items.some(i => /Forged-in-lesson/.test(i.title)), 'fenced forged heading yields no section');
  assert.equal(res.items.length, 3, 'exactly 3 real sections (numbering-break ignored)');
  // lesson is read
  assert.ok(res.items.some(i => i.lesson && /rename atomically/i.test(i.lesson)), 'lesson read');
  // numbering-break heading (## 7) ignored -> already covered by count === 3
  // unfenced forged heading with the next number is parsed (documented known limit)
  const dir2 = path.join(ctx.tmp, 'prior2');
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, `${d}-trace-proposals.md`),
    '## 1. Real\n- [ ] **Apply** · [ ] **Reject**\n\n## 2. Forged-next-number\n- [x] **Apply** · [ ] **Reject**\n');
  const res2 = tm.readPriorProposals(dir2, { now: NOW, maxAgeDays: 30 });
  assert.equal(res2.items.length, 2, 'unfenced forged heading with next number is parsed (known limit)');
  // titles capped at 120
  const dir3 = path.join(ctx.tmp, 'prior3');
  fs.mkdirSync(dir3, { recursive: true });
  fs.writeFileSync(path.join(dir3, `${d}-trace-proposals.md`), '## 1. ' + 'Z'.repeat(200) + '\n- [ ] **Apply** · [ ] **Reject**\n');
  const res3 = tm.readPriorProposals(dir3, { now: NOW, maxAgeDays: 30 });
  assert.ok(res3.items[0].title.length <= 120, 'title capped at 120 chars');
}});

TESTS.push({ n: 7, goal: 'G4', name: '7 G4 render — flatten forged model field + M1 banner dropped-title case', fn: () => {
  // (a) forged model field flattened so readPriorProposals finds only real sections, all pending
  const forged = 'Real title\n## 2. Forged\n- [x] **Apply** · [ ] **Reject**';
  const proposals = [
    { title: forged, evidence: 'e', confidence: 'low', risk: 'r' },
    { title: 'Second real title', evidence: 'e2' },
  ];
  const md = tm.renderMd(proposals, { today: '2026-11-08', inputsText: 'errors.log: ok (1 clusters)', dropped: [] });
  const ctx = mkCtx();
  const dir = path.join(ctx.tmp, 'prior');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-11-08-trace-proposals.md'), md);
  const parsed = tm.readPriorProposals(dir, { now: NOW, maxAgeDays: 30 });
  assert.equal(parsed.items.length, 2, 'exactly the two real sections');
  assert.ok(parsed.items.every(i => i.state === 'pending'), 'all real sections pending');
  assert.ok(parsed.items.some(i => /Second real title/.test(i.title)), 'real section 2 survives (title forge uses NEXT number)');
  // (c) NEXT number forged in a BODY field (evidence) — kills "evidence not flattened" mutant
  const forgedEvidence = 'evidence body\n## 2. Forged-in-evidence\n- [x] **Apply** · [ ] **Reject**';
  const mdC = tm.renderMd(
    [{ title: 'Alpha body-field title', evidence: forgedEvidence }, { title: 'Beta body-field title', evidence: 'e2' }],
    { today: '2026-11-08', inputsText: 'errors.log: ok (1 clusters)', dropped: [] }
  );
  const dirC = path.join(ctx.tmp, 'priorC');
  fs.mkdirSync(dirC, { recursive: true });
  fs.writeFileSync(path.join(dirC, '2026-11-08-trace-proposals.md'), mdC);
  const parsedC = tm.readPriorProposals(dirC, { now: NOW, maxAgeDays: 30 });
  assert.equal(parsedC.items.length, 2, 'exactly two real sections (evidence forge)');
  assert.ok(parsedC.items.every(i => i.state === 'pending'), 'all real sections pending (evidence forge)');
  assert.ok(!parsedC.items.some(i => /Forged-in-evidence/.test(i.title)), 'no section forged from evidence');
  // (d) a title whose NEXT line is a forged STATE line — kills "title not flattened" mutant
  const forgedState = 'Real\n- [x] **Apply** · [ ] **Reject**';
  const mdD = tm.renderMd(
    [{ title: forgedState, evidence: 'e' }, { title: 'Second real title', evidence: 'e2' }],
    { today: '2026-11-08', inputsText: 'errors.log: ok (1 clusters)', dropped: [] }
  );
  const dirD = path.join(ctx.tmp, 'priorD');
  fs.mkdirSync(dirD, { recursive: true });
  fs.writeFileSync(path.join(dirD, '2026-11-08-trace-proposals.md'), mdD);
  const parsedD = tm.readPriorProposals(dirD, { now: NOW, maxAgeDays: 30 });
  assert.equal(parsedD.items.length, 2, 'two real sections (forged state line in title)');
  assert.ok(parsedD.items.every(i => i.state === 'pending'), 'forged state line in title does not change state');
  // (b) M1 banner case: a dropped title containing \n## 1. forged -> no forged heading in file
  const md2 = tm.renderMd(
    [{ title: 'Genuine first proposal', evidence: 'e' }],
    { today: '2026-11-08', inputsText: 'errors.log: ok (1 clusters)', dropped: [{ title: 'Dropped\n## 1. forged\n- [x] **Apply** · [ ] **Reject**', matched: 'x', relation: 'recent', days: 1 }] }
  );
  const dir2 = path.join(ctx.tmp, 'prior2');
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, '2026-11-08-trace-proposals.md'), md2);
  const parsed2 = tm.readPriorProposals(dir2, { now: NOW, maxAgeDays: 30 });
  assert.equal(parsed2.items.length, 1, 'real section 1 only');
  assert.ok(/Genuine first proposal/.test(parsed2.items[0].title), 'real section 1 is the genuine one');
  assert.ok(!parsed2.items.some(i => /forged/.test(i.title)), 'no heading forged from dropped title');
}});

TESTS.push({ n: 8, goal: 'G4', name: '8 G4 drop — >=0.6 dropped, paraphrase near, false positive, empty token, empty history', fn: () => {
  const H = (title, state, daysAgo) => ({ title, state, daysAgo });
  // >=0.6 against 7-day title dropped
  let r = tm.dropRepeats([{ title: 'Guard the writer against a partial rename' }],
    [H('Guard the writer against a partial rename', 'pending', 2)], { now: NOW });
  assert.equal(r.kept.length, 0, '7-day repeat dropped');
  assert.equal(r.dropped.length, 1, 'drop recorded');
  // >=0.6 against applied title (30 days) dropped
  r = tm.dropRepeats([{ title: 'Guard the writer against a partial rename' }],
    [H('Guard the writer against a partial rename', 'applied', 20)], { now: NOW });
  assert.equal(r.kept.length, 0, 'applied repeat dropped');
  // clearly different title kept
  r = tm.dropRepeats([{ title: 'Completely unrelated database migration' }],
    [H('Guard the writer against a partial rename', 'pending', 2)], { now: NOW });
  assert.equal(r.kept.length, 1, 'different title kept');
  // 0.571 paraphrase kept + appears in near
  r = tm.dropRepeats([{ title: 'Unchanged iterations repeat without progress' }],
    [H('No-progress iterations repeat unchanged diffs', 'pending', 2)], { now: NOW });
  assert.equal(r.kept.length, 1, '0.571 paraphrase kept');
  assert.ok(r.near.length >= 1, 'paraphrase appears in near');
  // documented false positive: "before commit" vs "before push" dropped
  r = tm.dropRepeats([{ title: 'Check git status before commit' }],
    [H('Check git status before push', 'pending', 2)], { now: NOW });
  assert.equal(r.kept.length, 0, 'before commit/push false positive dropped');
  // empty-token title never matches -> kept
  r = tm.dropRepeats([{ title: 'the and of not' }],
    [H('the and of not', 'pending', 2)], { now: NOW });
  assert.equal(r.kept.length, 1, 'empty-token title kept');
  // nothing dropped with empty history
  r = tm.dropRepeats([{ title: 'Whatever title here' }], [], { now: NOW });
  assert.equal(r.dropped.length, 0, 'empty history drops nothing');
  // jaccard sanity
  assert.equal(tm.jaccard(tm.normTitle('a b c'), tm.normTitle('a b c')), 1);
}});

TESTS.push({ n: 9, goal: 'G4', name: '9 G4 prompt — ALREADY PROPOSED block, 60-line cap, review block 24000, per-job cap', fn: () => {
  // captured prompt contains ALREADY PROPOSED + decided marker, no nested decoy
  const ctx = mkCtx();
  const root = ctx.seedReviews();
  // seed prior with a decided title + a lesson
  const today = new Date(NOW);
  const d = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  ctx.prior({ [`${d}-trace-proposals.md`]:
    '## 1. An already decided title\n- [x] **Apply** · [ ] **Reject**\n- **Lesson draft (for LESSONS.md):**\n```\nAlways do the thing.\n```\n' });
  const r = ctx.spawn(['--dry'], DEFAULT_REPLY, { NEUROLINK_REVIEW_ROOTS: root });
  assert.match(r.captureText, /ALREADY PROPOSED/, 'prompt has prior block');
  assert.match(r.captureText, /decided: applied/, 'prompt has decided marker');
  assert.ok(!/NESTED_DECOY_MARKER/.test(r.captureText), 'nested decoy absent from prompt');
  // 100 prior titles -> 60-line block, decided titles + at least one lesson
  const ctx2 = mkCtx();
  const many = [];
  for (let k = 0; k < 100; k++) many.push(`## ${k+1}. Prior title number ${k}\n- [ ] **Apply** · [ ] **Reject**\n`);
  ctx2.prior({ [`${d}-trace-proposals.md`]: '## 1. A decided one\n- [x] **Apply** · [ ] **Reject**\n' });
  // build a single file with 100 + one decided; numbering must be consecutive
  let big = '## 1. A decided one\n- [x] **Apply** · [ ] **Reject**\n- **Lesson draft (for LESSONS.md):**\n```\nAlways lesson.\n```\n';
  for (let k = 2; k <= 101; k++) big += `## ${k}. Prior title number ${k}\n- [ ] **Apply** · [ ] **Reject**\n`;
  const ctx3 = mkCtx();
  ctx3.prior({ [`${d}-trace-proposals.md`]: big });
  const r3 = ctx3.spawn(['--dry'], DEFAULT_REPLY, { NEUROLINK_REVIEW_ROOTS: ctx3.seedReviews() });
  const block = r3.captureText.split('ALREADY PROPOSED')[1] || '';
  const lines = block.split('\n').filter(l => l.trim().startsWith('- '));
  assert.ok(lines.length <= 60, 'prior block <= 60 lines');
  assert.match(block, /decided: applied/, 'decided title present');
  assert.match(block, /already-drafted lesson/, 'lesson present');
  // review block 24000 + reviews per job 2 (wrote run, check receipt truncated)
  const ctx5 = mkCtx();
  const rr5 = ctx5.seedReviews();
  const longText = (verdict, tag) => {
    const lines = [verdict];
    for (let k = 1; k <= 12; k++) lines.push(`Minor M${k}. ${tag} finding ${k} ` + 'z'.repeat(280));
    return lines.join('\n') + '\n';
  };
  for (let g = 0; g < 22; g++) {
    const jf = path.join(rr5, `bulk-${g}-review-20261101`);
    fs.mkdirSync(jf, { recursive: true });
    fs.writeFileSync(path.join(jf, 'REVIEW-1.md'), longText('VERDICT: FAIL', 'bulk' + g));
    const t = (NOW - 1 * DAY) / 1000;
    fs.utimesSync(path.join(jf, 'REVIEW-1.md'), t, t);
  }
  const bigJob5 = path.join(rr5, 'job-big-review-20261101');
  fs.mkdirSync(bigJob5, { recursive: true });
  for (let k = 1; k <= 3; k++) fs.writeFileSync(path.join(bigJob5, `REVIEW-${k}.md`), longText('VERDICT: FAIL', 'big' + k));
  ctx5.seedErrors();
  const r5 = ctx5.spawn([], DEFAULT_REPLY, { NEUROLINK_REVIEW_ROOTS: rr5 });
  const last = r5.receipts[r5.receipts.length - 1];
  assert.ok(last && last.truncated.includes('review block 24000'), 'review block 24000 truncated');
  assert.ok(last && last.truncated.includes('reviews per job 2'), 'reviews per job 2 truncated');
}});

TESTS.push({ n: 10, goal: 'G4', name: '10 G4 spawned flows — mixed repeat/new reply and all-repeat reply', fn: () => {
  const today = new Date(NOW);
  const d = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const prior = `## 1. Repeated title here\n- [ ] **Apply** · [ ] **Reject**\n`;
  // one repeated + one new title
  const ctx = mkCtx();
  ctx.seedErrors();
  // use a date 2 days ago so it is within 7-day history but not "today" file
  const twoAgo = new Date(NOW - 2 * DAY);
  const d2 = `${twoAgo.getFullYear()}-${String(twoAgo.getMonth()+1).padStart(2,'0')}-${String(twoAgo.getDate()).padStart(2,'0')}`;
  ctx.prior({ [`${d2}-trace-proposals.md`]: prior });
  const reply = [{ title: 'Repeated title here', evidence: 'e' }, { title: 'A brand new distinct title', evidence: 'e' }];
  const r = ctx.spawn([], reply, {});
  const last = r.receipts[r.receipts.length - 1];
  assert.equal(last.dropped.length, 1, 'one drop in receipt');
  const outs = ctx.readOutputs();
  const todayFile = `${d}-trace-proposals.md`;
  assert.ok(outs.proposalFiles.includes(todayFile), 'today proposal file written');
  const text = outs.all[todayFile];
  assert.match(text, /dropped 1 similar proposal\(s\)/, 'banner has dropped count');
  assert.ok((text.match(/^## \d+\./gm) || []).length === 1, 'file has 1 proposal');
  // only repeated titles -> skipped
  const ctx2 = mkCtx();
  ctx2.seedErrors();
  ctx2.prior({ [`${d2}-trace-proposals.md`]: prior });
  const r2 = ctx2.spawn([], [{ title: 'Repeated title here', evidence: 'e' }], {});
  const last2 = r2.receipts[r2.receipts.length - 1];
  assert.equal(last2.outcome, 'skipped', 'all-repeat -> skipped');
  assert.match(last2.reason, /all proposals already proposed\/decided/, 'skip reason');
  assert.ok(!ctx2.readOutputs().proposalFiles.includes(`${d}-trace-proposals.md`), 'no today proposal file on all-repeat');
}});

TESTS.push({ n: 11, goal: 'G2', name: '11 G2 status file — written on skipped with attention, ignored by history, none without attention', fn: () => {
  // skipped (reply []) with a missing input -> status file
  const ctx = mkCtx();
  ctx.seedErrors();
  const r = ctx.spawn([], [], { NEUROLINK_REVIEW_ROOTS: '/definitely/nonexistent/tm-root' });
  const outs = ctx.readOutputs();
  assert.equal(outs.statusFiles.length, 1, 'status file written');
  assert.match(outs.all[outs.statusFiles[0]], /missing/, 'status file lists missing input');
  // readPriorProposals ignores the status file
  const pp = tm.readPriorProposals(ctx.outDir, { now: NOW, maxAgeDays: 30 });
  assert.ok(!pp.items.length, 'status file ignored by history');
  // no attention status -> no status file
  const ctx2 = mkCtx();
  ctx2.seedErrors();
  const r2 = ctx2.spawn([], [], {});
  assert.equal(ctx2.readOutputs().statusFiles.length, 0, 'no status file without attention');
}});

TESTS.push({ n: 12, goal: 'G5', name: '12 G5 same-day rerun (RED exemption) — one file, no -2, second skipped', fn: () => {
  const ctx = mkCtx();
  ctx.seedErrors();
  const reply = [{ title: 'Same day stable title', evidence: 'e' }];
  const r1 = ctx.spawn([], reply, {});
  const r2 = ctx.spawn([], reply, {});
  const outs = ctx.readOutputs();
  assert.equal(outs.proposalFiles.length, 1, 'exactly one proposal file');
  assert.ok(!outs.proposalFiles.some(n => /-2\.md$/.test(n)), 'no -2 file');
  assert.equal(outs.tmpFiles.length, 0, 'no .tmp file left behind');
  const last2 = r2.receipts[r2.receipts.length - 1];
  assert.equal(last2.outcome, 'skipped', 'second run skipped');
  assert.match(last2.reason, /all proposals already proposed\/decided/, 'second run skip reason');
}});

TESTS.push({ n: 13, goal: 'G5', name: '13 G5 plist — plutil -lint + exact fields', fn: () => {
  const plist = path.join(WT, 'engine', 'ops', 'launchd', 'com.brandon.neurolink-trace-miner.plist');
  assert.ok(fs.existsSync(plist), 'plist exists');
  const lint = spawnSync('/usr/bin/plutil', ['-lint', plist], { encoding: 'utf8' });
  assert.equal(lint.status, 0, 'plutil -lint exit 0');
  const conv = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' });
  assert.equal(conv.status, 0, 'plutil -convert json exit 0');
  const j = JSON.parse(conv.stdout);
  assert.equal(j.Label, 'com.brandon.neurolink-trace-miner');
  assert.ok(j.ProgramArguments.includes('/Users/brandon/.local/node/bin/node'), 'node path');
  assert.ok(j.ProgramArguments.includes('/Users/brandon/.neurolink/repo/engine/neurons/trace-miner.mjs'), 'script path');
  assert.equal(j.WorkingDirectory, '/Users/brandon/.neurolink/repo/engine');
  assert.equal(j.StartCalendarInterval.Hour, 9);
  assert.equal(j.StartCalendarInterval.Minute, 0);
  assert.equal(j.RunAtLoad, false);
  assert.equal(j.StandardOutPath, '/Users/brandon/Library/Logs/neurolink-trace-miner.log');
  assert.equal(j.StandardErrorPath, '/Users/brandon/Library/Logs/neurolink-trace-miner.log');
  assert.equal(j.EnvironmentVariables.PATH, '/Users/brandon/.local/node/bin:/Users/brandon/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(j.EnvironmentVariables.NEUROLINK_CLAUDE_CMD, '/Users/brandon/.neurolink/repo/engine/neurons/llm-hermes.sh');
}});

function checkIgnore(rel) {
  const r = spawnSync('git', ['-C', WT, 'check-ignore', '-q', rel], { encoding: 'utf8' });
  return r.status;
}

TESTS.push({ n: 14, goal: 'H', name: '14 Hygiene — .gitignore proofs (N10), example config (M2/N2), no config in worktree', fn: () => {
  // N10: check-ignore on missing path is sufficient; no throwaway file created
  assert.equal(checkIgnore('engine/neurons/test-trace-miner.mjs'), 1, 'test file NOT ignored');
  assert.equal(checkIgnore('engine/neurons/fixtures/trace-miner/job-a-review-20261107/REVIEW-G1.md'), 1, 'fixture NOT ignored');
  assert.equal(checkIgnore('engine/ops/launchd/com.brandon.neurolink-trace-miner.plist'), 1, 'plist NOT ignored');
  assert.equal(checkIgnore('engine/ops/launchd/com.example.private.plist'), 0, 'private plist ignored (missing path)');
  assert.equal(checkIgnore('engine/neurolink.config.json'), 0, 'private config ignored');
  // no engine/neurolink.config.json in worktree
  assert.ok(!fs.existsSync(path.join(WT, 'engine', 'neurolink.config.json')), 'no private config in worktree');
  // example config parses, exactly one reviewRoots key, ships no review root (M2), has age key
  const ex = JSON.parse(fs.readFileSync(path.join(WT, 'engine', 'neurolink.config.example.json'), 'utf8'));
  assert.equal(Object.keys(ex).filter(k => k === 'reviewRoots').length, 1, 'exactly one reviewRoots key');
  assert.ok(Array.isArray(ex.reviewRoots) && ex.reviewRoots.length === 0, 'M2: example ships WITHOUT a review root');
  assert.equal(ex.loopLedgerMaxAgeDays, 21, 'loopLedgerMaxAgeDays key present');
  // N2: an empty private-name pattern means no filter (config.mjs yields /(?!)/).
  // With it, job-j's PRIVATEMARKER finding is read and reaches the prompt.
  const n2 = mkCtx({ privateNamePattern: '' });
  n2.seedErrors();
  const n2root = n2.seedReviews();
  const n2r = n2.spawn(['--dry'], DEFAULT_REPLY, { NEUROLINK_REVIEW_ROOTS: n2root });
  assert.ok(/PRIVATEMARKER/.test(n2r.captureText), 'N2 empty pattern -> no filter (job-j included)');
}});

TESTS.push({ n: 15, goal: 'H', name: '15 Contract paths — []/nonzero/non-JSON, receipt keys, banner, --dry writes nothing', fn: () => {
  const ctx = mkCtx();
  ctx.seedErrors();
  // reply [] -> skipped, receipt carries inputs
  const r0 = ctx.spawn([], [], {});
  assert.equal(r0.receipts[r0.receipts.length - 1].outcome, 'skipped');
  assert.ok(r0.receipts[r0.receipts.length - 1].inputs, 'skipped receipt carries inputs');
  // nonzero exit -> failed, exit 1, receipt inputs, status file when attention exists
  const ctx1 = mkCtx();
  ctx1.seedErrors();
  const r1 = ctx1.spawn([], DEFAULT_REPLY, { TM_RC: '3', NEUROLINK_REVIEW_ROOTS: '/no/such/tm-root' });
  assert.equal(r1.code, 1, 'nonzero stub -> exit 1');
  assert.equal(r1.receipts[r1.receipts.length - 1].outcome, 'failed');
  assert.ok(r1.receipts[r1.receipts.length - 1].inputs, 'failed receipt carries inputs');
  assert.equal(ctx1.readOutputs().statusFiles.length, 1, 'failed + attention -> status file');
  // non-JSON reply -> failed
  const ctx2 = mkCtx();
  ctx2.seedErrors();
  const r2 = ctx2.spawn([], 'not json at all', {});
  assert.equal(r2.code, 1, 'non-JSON -> exit 1');
  assert.equal(r2.receipts[r2.receipts.length - 1].outcome, 'failed');
  // wrote receipt carries inputs, dropped, near, truncated
  const ctx3 = mkCtx();
  ctx3.seedErrors();
  const r3 = ctx3.spawn([], DEFAULT_REPLY, {});
  const w3 = r3.receipts[r3.receipts.length - 1];
  assert.equal(w3.outcome, 'wrote');
  for (const k of ['inputs', 'dropped', 'near', 'truncated']) assert.ok(k in w3, `wrote receipt has ${k}`);
  const outs3 = ctx3.readOutputs();
  const banner = outs3.all[outs3.proposalFiles[0]];
  assert.match(banner, /inputs:/, 'banner contains inputs text');
  assert.ok(!/loop-harness:/.test(banner), 'old fragment replaced');
  // --dry writes no proposal/status/receipt, prints dry line
  const ctx4 = mkCtx();
  ctx4.seedErrors();
  const r4 = ctx4.spawn(['--dry'], DEFAULT_REPLY, {});
  assert.match(r4.stdout, /dry: would write/, 'dry line printed');
  assert.equal(ctx4.readOutputs().proposalFiles.length, 0, 'dry: no proposal file');
  assert.equal(ctx4.readOutputs().statusFiles.length, 0, 'dry: no status file');
  assert.equal(r4.receipts.length, 0, 'dry: no receipt');
}});

TESTS.push({ n: 16, goal: 'H', name: '16 Truncated labels and edges — caps, unreadable prior, M7 vault-unwritable', fn: () => {
  // 22 folders -> reviews 20 ; 201 folders -> review folders 200
  const ctx = mkCtx();
  const root = path.join(ctx.tmp, 'reviews');
  fs.mkdirSync(root, { recursive: true });
  for (let k = 0; k < 201; k++) {
    const jf = path.join(root, `g-${k}-review-20261101`);
    fs.mkdirSync(jf, { recursive: true });
    fs.writeFileSync(path.join(jf, 'REVIEW-1.md'), `VERDICT: FAIL\nMinor M1. f ${k}\n`);
    const t = (NOW - 1 * DAY) / 1000;
    fs.utimesSync(path.join(jf, 'REVIEW-1.md'), t, t);
  }
  const res = tm.scanBuilderReviews([root], { now: NOW, maxAgeMs: 7 * DAY, privateName: /(?!)/ });
  assert.ok(res.truncated.includes('reviews 20'), 'reviews 20');
  assert.ok(res.truncated.includes('review folders 200'), 'review folders 200');
  // 100 prior titles -> prior titles 60
  const today = new Date(NOW);
  const d = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  let big = '';
  for (let k = 1; k <= 100; k++) big += `## ${k}. Prior ${k}\n- [ ] **Apply** · [ ] **Reject**\n`;
  const ctx2 = mkCtx();
  ctx2.seedErrors();
  ctx2.prior({ [`${d}-trace-proposals.md`]: big });
  const r2 = ctx2.spawn([], DEFAULT_REPLY, {});
  assert.ok(r2.receipts[r2.receipts.length - 1].truncated.includes('prior titles 60'), 'prior titles 60');
  // one unreadable prior file -> ok (N, 1 unreadable)
  const ctx3 = mkCtx();
  ctx3.prior({ [`${d}-trace-proposals.md`]: '## 1. X\n- [ ] **Apply** · [ ] **Reject**\n' });
  const bad = path.join(ctx3.outDir, `${d}-trace-proposals-2.md`);
  fs.writeFileSync(bad, '## 1. Y\n- [ ] **Apply** · [ ] **Reject**\n');
  fs.chmodSync(bad, 0o000); ctx3.restored.push(bad);
  const pp = tm.readPriorProposals(ctx3.outDir, { now: NOW, maxAgeDays: 30 });
  assert.match(pp.status.text, /unreadable/, 'unreadable prior counted');
  assert.equal(pp.status.attention, true, 'unreadable prior is attention');
  // empty prior folder -> none yet
  const ctx4 = mkCtx();
  const pp4 = tm.readPriorProposals(ctx4.outDir, { now: NOW, maxAgeDays: 30 });
  assert.equal(pp4.status.text, 'none yet', 'empty prior folder none yet');
  // M7: status-file write failure caught (stderr note, receipt still written, exit unchanged)
  const ctx5 = mkCtx();
  ctx5.seedErrors();
  ctx5.unwritableOut();
  const r5 = ctx5.spawn([], [], { NEUROLINK_REVIEW_ROOTS: '/no/such/tm-root' });
  assert.equal(r5.code, 0, 'status write failure: exit unchanged (0)');
  assert.match(r5.stderr, /status/i, 'one stderr note about status');
  assert.ok(r5.receipts.length >= 1, 'receipt still written');
  // M7: proposal write failure uncaught (non-zero, no receipt)
  const ctx6 = mkCtx();
  ctx6.seedErrors();
  ctx6.unwritableOut();
  const r6 = ctx6.spawn([], DEFAULT_REPLY, {});
  assert.notEqual(r6.code, 0, 'proposal write failure non-zero');
  assert.equal(r6.receipts.length, 0, 'proposal write failure -> no receipt');
}});

TESTS.push({ n: 17, goal: 'H', name: '17 Status classification — inputStatus attention vs intentional', fn: () => {
  const att = s => tm.inputStatus(s).attention;
  const txt = s => tm.inputStatus(s).text;
  assert.equal(att({ kind: 'ok', n: 0, extras: [{ key: 'unreadable', label: 'unreadable', count: 5 }] }), true, 'ok (0, 5 unreadable) attention');
  assert.equal(txt({ kind: 'ok', n: 0, extras: [{ key: 'unreadable', label: 'unreadable', count: 5 }] }), 'ok (0, 5 unreadable)');
  assert.equal(att({ kind: 'ok', n: 0, unit: 'clusters' }), false, 'ok (0 clusters) not attention');
  assert.equal(att({ kind: 'ok', n: 3, extras: [{ key: 'ignored', label: 'ignored', count: 1 }] }), false, 'ignored-only not attention');
  assert.equal(att({ kind: 'ok', n: 0, allIgnored: true, extras: [{ key: 'ignored', label: 'ignored', count: 2 }] }), true, 'M9(c) all-ignored root attention');
  assert.equal(att({ kind: 'none-yet' }), false, 'none yet not attention');
  assert.equal(att({ kind: 'not-configured' }), false, 'not configured not attention');
  assert.equal(att({ kind: 'missing', path: '/x' }), true, 'missing attention');
  assert.equal(att({ kind: 'unreadable', code: 'EPERM', path: '/x' }), true, 'unreadable attention');
  assert.equal(txt({ kind: 'unreadable', code: 'EPERM', path: '/x' }), 'unreadable (EPERM) /x');
  assert.equal(att({ kind: 'stale', detail: 'newest 2026-09-02, limit 21d', path: '/x' }), true, 'stale attention');
  assert.equal(att({ kind: 'ok', n: 0 }), false, 'ok (0) not attention');
}});

TESTS.push({ n: 18, goal: 'H', name: '18 Ledger edges — empty file ok (0), fresh PASS + old failures not stale, N3 ISO-8601 ts', fn: () => {
  const ctx = mkCtx();
  // existing empty file -> ok (0)
  const pEmpty = ctx.ledger([]);
  const le = tm.loopFailures(pEmpty, { now: NOW, maxAgeDays: 21 });
  assert.equal(le.status.text, 'ok (0)', 'empty ledger ok (0)');
  // fresh PASS rows with only old failures -> ok (0, K older), not stale
  const rows = [
    { verdict: 'PASS', detail: 'ok', ts: NOW / 1000 },
    { verdict: 'FAIL', detail: 'old', ts: (NOW - 40 * DAY) / 1000 },
  ];
  const p = ctx.ledger(rows);
  const lf = tm.loopFailures(p, { now: NOW, maxAgeDays: 21 });
  assert.match(lf.status.text, /^ok \(0,/, 'fresh PASS + old failures is ok (0, ...)');
  assert.ok(!/stale/.test(lf.status.text), 'not stale');
  assert.match(lf.status.text, /older than 21d/, 'older counted');
  // N3: ISO-8601 string ts (with offset) and run-field fallback both date rows
  const iso = new Date(NOW).toISOString().replace('Z', '+0000'); // %Y-%m-%dT%H:%M:%S%z shape
  const p3 = ctx.ledger([{ verdict: 'FAIL', detail: 'iso-dated', ts: iso }]);
  const lf3 = tm.loopFailures(p3, { now: NOW, maxAgeDays: 21 });
  assert.equal(lf3.clusters.length, 1, 'ISO-8601 ts dates the row (kept as fresh)');
  const run = (() => { const dt = new Date(NOW); const p2 = n => String(n).padStart(2,'0');
    return `${dt.getFullYear()}${p2(dt.getMonth()+1)}${p2(dt.getDate())}-${p2(dt.getHours())}${p2(dt.getMinutes())}${p2(dt.getSeconds())}`; })();
  const p4 = ctx.ledger([{ verdict: 'FAIL', detail: 'run-dated', run }]);
  const lf4 = tm.loopFailures(p4, { now: NOW, maxAgeDays: 21 });
  assert.equal(lf4.clusters.length, 1, 'run YYYYMMDD-HHMMSS dates the row');
}});


// ===================== CORRECTION BRIEF 1 ASSERTIONS (19-26) =====================
// B1 prompt/banner, M-A flatten, M-B / M9(a) legacy errors, m1/m2/m3, T2, m6.
// Each behaviour-change test (19-24) is RED on the frozen 969043e source; 25/26 are
// mutation-sensitive guards whose RED state is demonstrated by the mutant runs.

TESTS.push({ n: 19, goal: 'M-A', name: '19 M-A flatten trims BEFORE escaping — leading-space/newline ``` and ## cannot forge/hide sections', fn: () => {
  // direct flatten assertions (also kill the "escape removed" mutant)
  assert.ok(tm.flatten(' ```x').startsWith('\\'), 'leading-space ``` escaped after trim');
  assert.ok(tm.flatten('\n## 2. x').startsWith('\\'), 'leading-newline ## escaped after trim');
  assert.ok(tm.flatten('\n```').startsWith('\\'), 'leading-newline ``` escaped after trim');
  const ctx = mkCtx();
  const OPTS = { today: '2026-11-08', inputsText: 'errors.log: ok (1 clusters)', dropped: [] };
  const check = (lessons, tag) => {
    const proposals = ['Alpha', 'Beta', 'Gamma'].map((t, i) => ({ title: t, evidence: 'e' + i, lesson_draft: lessons[i] }));
    const md = tm.renderMd(proposals, OPTS);
    const dir = path.join(ctx.tmp, 'ma-' + tag);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-11-08-trace-proposals.md'), md);
    const parsed = tm.readPriorProposals(dir, { now: NOW, maxAgeDays: 30 });
    assert.equal(parsed.items.length, 3, `case ${tag}: all 3 sections still parse`);
    assert.ok(parsed.items.every(i => i.state === 'pending'), `case ${tag}: all 3 sections pending`);
    assert.ok(!parsed.items.some(i => /Forged/i.test(i.title)), `case ${tag}: no forged section`);
    for (const t of ['Alpha', 'Beta', 'Gamma'])
      assert.ok(parsed.items.some(i => i.title === t), `case ${tag}: real section ${t} present`);
  };
  check(['\n```\nAlways check alpha.\n```', '', ''], 'A');                 // common model format
  check([' ```', ' ## 2. Forged title that suppresses repeats', ''], 'B');   // fence-break + ## forge
  check([' ```', '\n## 2. Forged heading\nAlways check gamma.\n', ''], 'C'); // fence-break + newline ## forge
}});

TESTS.push({ n: 20, goal: 'M-B', name: '20 M-B / M9(a) legacy RESULT.md — ENOENT not attention, EACCES attention', fn: () => {
  const t = (NOW - 1 * DAY) / 1000;
  const mkRoot = () => {
    const ctx = mkCtx();
    const root = path.join(ctx.tmp, 'legacy');
    fs.mkdirSync(root, { recursive: true });
    return { ctx, root };
  };
  // (a) legacy folder with NO RESULT.md -> ENOENT -> not attention (M-B)
  {
    const { ctx, root } = mkRoot();
    const jf = path.join(root, 'job-enoe-review-r1');
    fs.mkdirSync(jf, { recursive: true });
    fs.writeFileSync(path.join(jf, 'REVIEW.md'), 'VERDICT: FAIL\n'); // legacy pass reads RESULT.md only
    fs.utimesSync(jf, t, t);
    const res = tm.scanBuilderReviews([root], { now: NOW, maxAgeMs: 7 * DAY, privateName: /(?!)/ });
    const st = res.rootStatuses[0].status;
    assert.equal(st.attention, false, 'ENOENT legacy folder is NOT attention (M-B)');
    assert.ok(!/unreadable/.test(st.text), 'ENOENT contributes no U unreadable count');
  }
  // (b) legacy RESULT.md chmod 0 -> EACCES -> attention (M9(a) non-ENOENT counted)
  {
    const { ctx, root } = mkRoot();
    const jf = path.join(root, 'job-eacc-review-r1');
    fs.mkdirSync(jf, { recursive: true });
    const rp = path.join(jf, 'RESULT.md');
    fs.writeFileSync(rp, 'VERDICT: FAIL\n1. HIGH, OPEN. something\n');
    fs.utimesSync(rp, t, t);
    fs.chmodSync(rp, 0o000);
    ctx.restored.push(rp);
    const res = tm.scanBuilderReviews([root], { now: NOW, maxAgeMs: 7 * DAY, privateName: /(?!)/ });
    const st = res.rootStatuses[0].status;
    assert.equal(st.attention, true, 'EACCES legacy is attention (M9(a) read error counted)');
    assert.match(st.text, /unreadable/, 'EACCES shows U unreadable');
  }
}});

TESTS.push({ n: 21, goal: 'B1', name: '21 B1 restored prompt RULES/schema + banner human caveat (negative guard)', fn: () => {
  const ctx = mkCtx();
  ctx.seedErrors();
  const r = ctx.spawn(['--dry'], DEFAULT_REPLY, {});
  const PHRASES = ['RULES', 'never code-logic', 'is_safety_rule', 'transient infra', 'deterministic check', 'DISTINCT'];
  const missing = PHRASES.filter(p => !r.captureText.includes(p));
  assert.deepEqual(missing, [], `built prompt missing phrases: ${missing.join(', ')}`);
  // banner human caveat (wrote run)
  const ctx2 = mkCtx();
  ctx2.seedErrors();
  ctx2.spawn([], DEFAULT_REPLY, {});
  const outs = ctx2.readOutputs();
  const banner = outs.all[outs.proposalFiles[0]] || '';
  assert.ok(banner.includes('Vet each against the CURRENT state'), 'banner: Vet each against the CURRENT state');
  assert.ok(banner.includes('never auto-apply') && banner.includes('safety/money'), 'banner: safety/money caveat present');
}});

TESTS.push({ n: 22, goal: 'm1', name: '22 m1 --dry keeps exit 1 on model/parse failure', fn: () => {
  const ctx = mkCtx();
  ctx.seedErrors();
  const r = ctx.spawn(['--dry'], DEFAULT_REPLY, { TM_RC: '3' });
  assert.equal(r.code, 1, '--dry model failure exits 1 (design 5.1)');
  assert.equal(ctx.readOutputs().proposalFiles.length, 0, '--dry writes no proposal file on failure');
  assert.equal(r.receipts.length, 0, '--dry writes no receipt');
}});

TESTS.push({ n: 23, goal: 'm2', name: '23 m2 failed receipt restores inputContext key (add, not remove)', fn: () => {
  const ctx = mkCtx();
  ctx.seedErrors();
  const r = ctx.spawn([], DEFAULT_REPLY, { TM_RC: '3' });
  assert.equal(r.code, 1);
  const last = r.receipts[r.receipts.length - 1];
  assert.equal(last.outcome, 'failed');
  assert.ok(last.inputs, 'failed receipt still has the new inputs key');
  assert.ok(last.inputContext && last.inputContext.counts, 'failed receipt carries restored inputContext key (m2)');
}});

TESTS.push({ n: 24, goal: 'm3', name: '24 m3 oversized-only root counts candidateFiles before size skip -> attention', fn: () => {
  const ctx = mkCtx();
  const root = path.join(ctx.tmp, 'oversized');
  const jf = path.join(root, 'job-big-review-20261101');
  fs.mkdirSync(jf, { recursive: true });
  const p = path.join(jf, 'REVIEW-1.md');
  fs.writeFileSync(p, 'VERDICT: FAIL\nMinor M1. ' + 'x'.repeat(210000));
  const t = (NOW - 1 * DAY) / 1000;
  fs.utimesSync(p, t, t);
  fs.utimesSync(jf, t, t);
  const res = tm.scanBuilderReviews([root], { now: NOW, maxAgeMs: 7 * DAY, privateName: /(?!)/ });
  const st = res.rootStatuses[0].status;
  assert.equal(st.attention, true, 'oversized-only root behaves like unparseable root (attention, m3)');
  assert.match(st.text, /ignored/, 'oversized file counted as ignored');
}});

TESTS.push({ n: 25, goal: 'T2', name: '25 T2 M9(b) unreadable prior FOLDER + M9(c) all-unparseable root via scanBuilderReviews itself', fn: () => {
  const t = (NOW - 1 * DAY) / 1000;
  // M9(b): OUT_DIR is a FILE -> ENOTDIR -> unreadable, attention (not "none yet")
  {
    const ctx = mkCtx();
    fs.mkdirSync(path.dirname(ctx.outDir), { recursive: true });
    fs.writeFileSync(ctx.outDir, 'i am a file, not a folder');
    const pp = tm.readPriorProposals(ctx.outDir, { now: NOW, maxAgeDays: 30 });
    assert.equal(pp.status.attention, true, 'unreadable prior-proposals FOLDER is attention (M9(b))');
    assert.match(pp.status.text, /unreadable \(ENOTDIR\)/, 'ENOTDIR reported as unreadable');
  }
  // M9(c): all-unparseable root via scanBuilderReviews (not by passing allIgnored to inputStatus)
  {
    const ctx = mkCtx();
    const root = path.join(ctx.tmp, 'allunparseable');
    const jf = path.join(root, 'job-x-review-20261101');
    fs.mkdirSync(jf, { recursive: true });
    const p = path.join(jf, 'REVIEW-1.md');
    fs.writeFileSync(p, 'This file has no verdict word at all.\nJust prose here.\n');
    fs.utimesSync(p, t, t);
    fs.utimesSync(jf, t, t);
    const res = tm.scanBuilderReviews([root], { now: NOW, maxAgeMs: 7 * DAY, privateName: /(?!)/ });
    const st = res.rootStatuses[0].status;
    assert.equal(st.attention, true, 'all-unparseable root is attention via scanBuilderReviews (M9(c))');
    assert.match(st.text, /ignored/, 'ignored counted');
  }
}});

TESTS.push({ n: 26, goal: 'm6', name: '26 m6 drop-threshold boundary (0.6, 0.625) + per-job PASS/non-PASS verdict rank', fn: () => {
  const H = (title) => ({ title, state: 'pending', daysAgo: 2 });
  // exactly 0.6 (3/5) -> dropped; kills the >=0.65 and >0.6 mutants
  let r = tm.dropRepeats([{ title: 'Alpha beta gamma delta' }], [H('Alpha beta gamma epsilon')], { now: NOW });
  assert.equal(tm.jaccard(tm.normTitle('Alpha beta gamma delta'), tm.normTitle('Alpha beta gamma epsilon')), 0.6, 'pair is exactly 0.6');
  assert.equal(r.kept.length, 0, 'exactly 0.6 dropped (>= 0.6 boundary)');
  // 0.625 (5/8, between 0.571 and 0.667) -> dropped
  r = tm.dropRepeats([{ title: 'alpha beta gamma delta epsilon zeta' }], [H('alpha beta gamma delta epsilon eta theta')], { now: NOW });
  assert.equal(r.kept.length, 0, '0.625 dropped');
  // per-job rank: a job mixing PASS and non-PASS keeps the non-PASS (oldest) file
  const ctx = mkCtx();
  const root = path.join(ctx.tmp, 'rank');
  const jf = path.join(root, 'rankjob-review-20261101');
  fs.mkdirSync(jf, { recursive: true });
  const mk = (name, verdict, finding, mt) => {
    const p = path.join(jf, name);
    fs.writeFileSync(p, `${verdict}\n${finding}\n`);
    fs.utimesSync(p, mt, mt);
  };
  const t0 = (NOW - 1 * DAY) / 1000;
  mk('REVIEW-1.md', 'VERDICT: FAIL', 'Minor M1. a real failure finding.', t0);        // oldest, non-PASS
  mk('REVIEW-2.md', 'VERDICT: PASS', 'Minor M1. a pass with a finding.', t0 + 1);      // middle, PASS
  mk('REVIEW-3.md', 'VERDICT: PASS', 'Minor M1. another pass finding.', t0 + 2);       // newest, PASS
  fs.utimesSync(jf, t0 + 2, t0 + 2);
  const res = tm.scanBuilderReviews([root], { now: NOW, maxAgeMs: 7 * DAY, privateName: /(?!)/ });
  const items = res.items.filter(i => i.job === 'rankjob');
  assert.equal(items.length, 2, 'per-job cap keeps 2 files');
  assert.ok(items.some(i => i.verdict === 'FAIL'), 'non-PASS file kept despite being oldest (verdict rank, M17)');
}});

// ===================== RUNNER =====================
function matches(t, filter) {
  if (!filter) return true;
  const toks = filter.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  return toks.some(tok => tok === String(t.n) || tok === t.goal.toUpperCase() || (tok === 'H' && t.goal === 'H'));
}

const filter = process.argv[2];
const selected = TESTS.filter(t => matches(t, filter));
let passed = 0;
const failed = [];
try {
  if (importErr) console.log(`(module import at RED: ${String(importErr.message).slice(0, 120)})`);
  for (const t of selected) {
    try { await t.fn(); console.log(`PASS ${t.name}`); passed++; }
    catch (e) { console.log(`FAIL ${t.name} :: ${e.message}`); failed.push(t.name); }
  }
} finally {
  // restore chmod'd files before removing temp dirs
  for (const p of []) {}
  for (const tmp of allCtx) {
    // best-effort: walk and chmod back anything 0o000
    const walk = d => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) { const f = path.join(d, e.name); try { if (e.isDirectory()) { try { fs.chmodSync(f, 0o700); } catch {} walk(f); } else { try { fs.chmodSync(f, 0o600); } catch {} } } catch {} } };
    walk(tmp);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}
console.log(`\n${passed}/${selected.length} assertions passed`);
if (failed.length) { console.log(`${failed.length} FAILED: ${failed.join(' | ')}`); process.exit(1); }
