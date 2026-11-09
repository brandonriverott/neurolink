#!/usr/bin/env node
/* ============================================================
   trace-miner.mjs — the AGENT-TRACE reflective neuron (design v5).

   Reflects over AGENT PRODUCTION TRACES and proposes memory/prompt/config
   fixes for HUMAN REVIEW. It never applies anything.

   Module shape (5.1): every exported helper takes explicit arguments and
   reads NO module config. config.mjs is imported dynamically inside
   loadConfig(), called only from main(). --selftest runs before any config
   load. main() is gated by the health.mjs realpath isMain idiom.

   See engine/README.md for the input-status contract, the receipt keys,
   the caps, the scheduler template and the rollout gates.

   HARD RULES (by design, do not relax):
     • NEVER auto-applies a change. Output is a review queue for the owner.
     • NEVER edits safety rules itself. It may PROPOSE + FLAG them (is_safety_rule),
       but money / guardrail / deny-by-default / single-writer changes are for a
       human to apply, per the safety-review caveat.
     • Proposes fixes to MEMORY / PROMPTS / CONFIG, never code behavior.
     • EXCEPTION — loop-harness and builder-review clusters ONLY: it MAY propose a
       deterministic check (a guardrails.sh tripwire, verify.sh step, rule check, test,
       or breaker rule) as the fix — repeated build/review failures should be promoted to
       code, not prompts. These stay REVIEW-ONLY proposals like everything else. For
       Hermes errors.log items the memory/prompt/config-only rule stands unchanged.
   ============================================================ */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY = 864e5;
const REVIEW_MAX_AGE_MS = 7 * DAY;

// ---- legacy finding shapes (unchanged; pinned by --selftest) ----
const LIST_PREFIX = String.raw`^\s*(?:(?:\d+|[A-Z])\.\s*|[-*]\s*)?\**\s*(?:CRITICAL|HIGH|MEDIUM|LOW)\b`;
const LIST_FINDING = new RegExp(LIST_PREFIX);
const LIST_STATUS = new RegExp(LIST_PREFIX + String.raw`\s*,\s*(.*)$`);
const TABLE_FINDING = /^\s*\|\s*\d+,\s*(?:CRITICAL|HIGH|MEDIUM|LOW)\b/;
export function findingStatus(line) {
  if (TABLE_FINDING.test(line)) return line.split('|')[2] || '';
  const m = line.match(LIST_STATUS);
  return m ? m[1].slice(0, 40) : '';
}
export const isClosedStatus = status => /^\W*closed\b/i.test(status);

// ---- the single choke point for EVERY string the miner writes (M1) ----
// Replace every CR/LF/U+2028/U+2029 run with one space, collapse spaces,
// escape a leading # or triple-backtick run, then cap. Non-strings go
// through String(); null/undefined become empty.
export function flatten(v, cap = 400) {
  let s = (v === null || v === undefined) ? '' : String(v);
  s = s.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/ {2,}/g, ' ');
  s = s.trim();                 // M-A: trim FIRST, then escape (leading # / ``` run is escaped)
  s = s.replace(/^(#+|`{3,})/, '\\$1');
  if (s.length > cap) s = s.slice(0, cap);
  return s;
}

// ---- G1: verdict normalization (5.2 step 6 + N6) ----
const VERDICT_WORDS = [
  'CHANGES REQUESTED', 'CHANGES_REQUIRED', 'CHANGES_REQUESTED', 'CHANGES REQUIRED',
  'UNVERIFIED', 'BLOCKED', 'BLOCK', 'PASSED', 'PASS', 'FAILED', 'FAIL',
]; // longest-first for prefix matching
const CANON = {
  PASS: 'PASS', PASSED: 'PASS', FAIL: 'FAIL', FAILED: 'FAIL',
  BLOCK: 'BLOCKED', BLOCKED: 'BLOCKED', UNVERIFIED: 'UNVERIFIED',
  CHANGES_REQUIRED: 'CHANGES REQUESTED', CHANGES_REQUESTED: 'CHANGES REQUESTED',
  'CHANGES REQUIRED': 'CHANGES REQUESTED', 'CHANGES REQUESTED': 'CHANGES REQUESTED',
};
const prefixAtBoundary = upper => {
  for (const w of VERDICT_WORDS) {
    if (upper.startsWith(w)) {
      const rest = upper.slice(w.length);
      if (rest === '' || !/[A-Za-z_]/.test(rest[0])) return { canon: CANON[w], rest };
    }
  }
  return null;
};
export function normalizeVerdict(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const strip = s => s.replace(/[*`]/g, ''); // strip * and backticks, keep underscores
  // Pass A — VERDICT lines in first 10 lines.
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const m = strip(lines[i]).match(/^\s*#*\s*VERDICT\s*:?\s*(.+)$/i);
    if (!m) continue;
    const pm = prefixAtBoundary(m[1].toUpperCase());
    if (!pm) continue;                       // line does not normalize -> skip, keep scanning
    const rest = pm.rest.replace(/^\s+/, '');
    if (/^[|/]/.test(rest)) continue;        // ambiguous -> does not count
    if (/^(WITH|BUT|EXCEPT)\b/.test(rest)) return 'UNVERIFIED'; // N6
    return pm.canon;
  }
  // Pass B — heading "… review: <verdict>" lines, exact single verdict only.
  for (const line of lines) {
    const m = line.match(/^#+\s.*\breview\s*:\s*(.+)$/i);
    if (!m) continue;
    const captured = m[1].trim().replace(/[.,;:!?)\]]+$/g, '').trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(CANON, captured)) return CANON[captured];
  }
  // Pass C — leading uppercase verdict word in first 8 lines (case-sensitive).
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const s = strip(lines[i]).replace(/^[\s#>\-]+/, '');
    let hit = null;
    for (const w of VERDICT_WORDS) {
      if (!s.startsWith(w)) continue;
      const nc = s[w.length];
      if (nc !== undefined && !/[ .,:\-\u2014]/.test(nc)) continue;
      const after = s.slice(w.length).replace(/^\s+/, '');
      if (/^[|/]/.test(after)) break;         // ambiguous
      hit = { canon: CANON[w], after };
      break;
    }
    if (!hit) continue;
    if (/^(WITH|BUT|EXCEPT)\b/i.test(hit.after)) return 'UNVERIFIED'; // N6
    return hit.canon;
  }
  return null;                               // ignored
}

// ---- G1: findings (5.2 step 7) ----
const EXCLUDE_PHRASE = /^(none( of note)?|nothing|nil|n\/a|no (blocking |major |minor |blocker |critical )?(blockers?|majors?|minors?|issues?|findings?|problems?)( (found|remaining|observed|identified|of note))?)(\s+(observed|found|identified|remaining))?\W*$/i;
const NEW_FINDING = /^\s*(?:[-*]\s*)?(?:\[[^\]]+\]\s*)?(Blocker|Major|Minor)\b\s*(?:[A-Z]?\d+)?(?:\s*[\[(]closed[\])])?\s*[.:)\-—]\s*(.+)$/i;
const P_FINDING = /^\s*(?:[-*]\s*)?\[P([0-3])\]\s*(.+)$/i;
function extractFindings(text) {
  const seen = new Set(), out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/[*`]/g, '');
    const closedMarker = /[\[(]closed[\])]/.test(raw.slice(0, 60)) || /status:\s*closed/i.test(raw);
    const candidates = [];
    const nm = line.match(NEW_FINDING);
    if (nm && !closedMarker) {
      const t = (nm[2] || '').trim();
      if (t && !EXCLUDE_PHRASE.test(t)) candidates.push(t);
    }
    const pm = line.match(P_FINDING);
    if (pm && !closedMarker) {
      const t = (pm[2] || '').trim();
      if (t && !EXCLUDE_PHRASE.test(t)) candidates.push(`P${pm[1]}: ${t}`);
    }
    if ((LIST_FINDING.test(line) || TABLE_FINDING.test(line)) && !isClosedStatus(findingStatus(line))) {
      const t = line.trim();
      if (t && !EXCLUDE_PHRASE.test(t)) candidates.push(t);
    }
    for (const c of candidates) {
      const key = c.slice(0, 300);
      if (key && !seen.has(key)) { seen.add(key); out.push(key); }
    }
    if (out.length >= 12) break;
  }
  return out.slice(0, 12).map(t => t.slice(0, 300));
}
const SKIP_DIRS = new Set(['wt', 'worktree', 'frozen', 'inputs', 'scratch', 'logs', 'node_modules']);
const REVIEW_FILE = /^REVIEW.*\.md$/i;
const EXCLUDE_NAME = /^REVIEW[-_]?(BRIEF|REQUEST|PROMPT|INSTRUCTIONS?)/i;
const LEGACY_DIR = /-review-r\d+$/;
const PRIVATE_MATCH = (re, folder, file, text) =>
  re.test(folder) || re.test(file) || re.test(text);
const jobName = folder => folder.replace(/-\d{8}$/, '').replace(/-review$/, '');
const generationOf = file => {
  let m = file.match(/[-_]G(\d+)/i);
  if (m) return Number(m[1]);
  m = file.match(/REVIEW-(\d+)\.md/i);
  return m ? Number(m[1]) : null;
};

export function scanBuilderReviews(roots = [], opts = {}) {
  const now = opts.now ?? Date.now();
  const privateName = opts.privateName || /(?!)/;
  const maxAgeMs = opts.maxAgeMs ?? REVIEW_MAX_AGE_MS;
  const capFolders = opts.capFolders ?? 200;
  const capGlobal = opts.capGlobal ?? 20;
  const capPerJob = opts.capPerJob ?? 2;
  const items = [], rootStatuses = [], truncated = [];

  for (const root of roots) {
    let dirents;
    try { dirents = fs.readdirSync(root, { withFileTypes: true }); }
    catch (e) {
      const status = e.code === 'ENOENT'
        ? inputStatus({ kind: 'missing', path: root })
        : inputStatus({ kind: 'unreadable', code: e.code, path: root });
      rootStatuses.push({ root, status, n: 0, ignored: 0, cleanPass: 0, excluded: 0, unreadable: 0, candidateFiles: 0 });
      continue;
    }
    const counts = { ignored: 0, cleanPass: 0, excluded: 0, unreadable: 0, candidateFiles: 0 };
    const found = [];
    const legacyDirs = dirents.filter(d => d.isDirectory() && LEGACY_DIR.test(d.name)).map(d => d.name);
    const newDirs = dirents.filter(d => d.isDirectory() && !SKIP_DIRS.has(d.name) && !LEGACY_DIR.test(d.name)).map(d => d.name);
    // newest first by mtime; visit at most capFolders
    const withMtime = newDirs.map(name => {
      let mt = 0; try { mt = fs.statSync(path.join(root, name)).mtimeMs; } catch {}
      return { name, mt };
    }).sort((a, b) => b.mt - a.mt);
    if (withMtime.length > capFolders) truncated.push('review folders 200');
    const visit = withMtime.slice(0, capFolders);

    for (const { name } of visit) {
      const folderPath = path.join(root, name);
      let files;
      try { files = fs.readdirSync(folderPath, { withFileTypes: true }); }
      catch (e) { counts.unreadable++; console.error(`trace-miner: cannot read review folder ${name}: ${e.code || e}`); continue; }
      for (const f of files) {
        if (!f.isFile() || !REVIEW_FILE.test(f.name) || EXCLUDE_NAME.test(f.name)) continue;
        const fp = path.join(folderPath, f.name);
        let st;
        try { st = fs.statSync(fp); } catch (e) { counts.unreadable++; continue; }
        if (st.mtimeMs < now - maxAgeMs) continue;       // 7-day window
        counts.candidateFiles++;                          // m3: count BEFORE the size skip
        if (st.size > 200000) { counts.ignored++; continue; }
        let text;
        try { text = fs.readFileSync(fp, 'utf8'); }
        catch (e) { counts.unreadable++; continue; }
        if (PRIVATE_MATCH(privateName, name, f.name, text)) { counts.excluded++; continue; }
        const verdict = normalizeVerdict(text);
        if (!verdict) { counts.ignored++; continue; }
        const findings = extractFindings(text);
        if (verdict === 'PASS' && findings.length === 0) { counts.cleanPass++; continue; }
        found.push({ job: jobName(name), verdict, findings, generation: generationOf(f.name), source: 'review-file', mtime: st.mtimeMs });
      }
    }

    // legacy pass: *-review-rN/RESULT.md, same privacy filter + shared caps
    for (const name of legacyDirs) {
      const fp = path.join(root, name, 'RESULT.md');
      let st, lines;
      try { st = fs.statSync(fp); lines = fs.readFileSync(fp, 'utf8').split('\n'); }
      catch (e) {
        if (e.code !== 'ENOENT') {                        // M-B: ENOENT = no RESULT.md, skipped quietly
          counts.unreadable++;                            // M9(a): only real read errors count
          console.error(`trace-miner: cannot read ${fp}: ${e.code || e}`);
        }
        continue;
      }
      if (st.mtimeMs < now - maxAgeMs) continue;
      const text = lines.join('\n');
      if (PRIVATE_MATCH(privateName, name, 'RESULT.md', text)) { counts.excluded++; continue; }
      const verdict = (lines.slice(0, 8).find(l => /\b(PASS|FAIL|CHANGES REQUIRED|BLOCKED)\b/i.test(l)) || '')
        .replace(/^#+\s*/, '').slice(0, 160);
      const findings = lines.filter(l => (LIST_FINDING.test(l) || TABLE_FINDING.test(l)) && !isClosedStatus(findingStatus(l)))
        .slice(0, 12).map(l => l.trim().slice(0, 300));
      const cleanPass = /\bPASS\b/i.test(verdict) && !/\b(FAIL|CHANGES REQUIRED|BLOCKED)\b/i.test(verdict);
      if (cleanPass && !findings.length) { counts.cleanPass++; continue; }
      const m = name.match(/^(.*)-review-r(\d+)$/);
      found.push({ job: m ? m[1] : name, round: m ? Number(m[2]) : null, verdict, findings, source: 'review-round', mtime: st.mtimeMs });
    }

    // per-job cap: rank non-PASS before PASS, then newest
    const byJob = new Map();
    for (const it of found) { if (!byJob.has(it.job)) byJob.set(it.job, []); byJob.get(it.job).push(it); }
    let perJobCut = false;
    for (const [, arr] of byJob) {
      arr.sort((a, b) => {
        const an = a.verdict === 'PASS' ? 1 : 0, bn = b.verdict === 'PASS' ? 1 : 0;
        if (an !== bn) return an - bn;
        return b.mtime - a.mtime;
      });
      if (arr.length > capPerJob) { perJobCut = true; arr.length = capPerJob; }
      for (const it of arr) items.push(it);
    }
    if (perJobCut) truncated.push('reviews per job 2');

    const n = found.length;                              // items found before global cap
    const allIgnored = counts.candidateFiles > 0 && n === 0 && counts.cleanPass === 0 && counts.ignored > 0;
    const extras = [
      { key: 'ignored', label: 'ignored', count: counts.ignored },
      { key: 'cleanPass', label: 'clean PASS', count: counts.cleanPass },
      { key: 'excluded', label: 'excluded', count: counts.excluded },
      { key: 'unreadable', label: 'unreadable', count: counts.unreadable },
    ];
    const status = inputStatus({ kind: 'ok', n, extras, allIgnored });
    rootStatuses.push({ root, status, n, ...counts });
  }

  // global cap 20 by mtime, shared with legacy
  items.sort((a, b) => b.mtime - a.mtime);
  if (items.length > capGlobal) { truncated.push('reviews 20'); items.length = capGlobal; }
  const reviewItems = items.map(({ mtime, ...rest }) => rest);
  return { items: reviewItems, rootStatuses, truncated: [...new Set(truncated)] };
}

// ---- G2: errors.log ----
const tail = (file, n) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n); } catch { return []; } };
function hermesClusters(lines) {
  const norm = s => s
    .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[.,]\d+/g, '<ts>')
    .replace(/thread=\S+/g, 'thread=<t>')
    .replace(/\[\d{8}_\d{6}_[a-f0-9]+\]/g, '[<sid>]')
    .replace(/req_[A-Za-z0-9]+/g, 'req_<id>')
    .replace(/\d+/g, 'N').trim();
  const counts = new Map(), sample = new Map();
  for (const l of lines) {
    if (!/WARNING|ERROR/.test(l)) continue;
    const k = norm(l).slice(0, 220);
    counts.set(k, (counts.get(k) || 0) + 1);
    if (!sample.has(k)) sample.set(k, l.slice(0, 320));
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
    .map(([cluster, count]) => ({ count, cluster, sample: sample.get(cluster) }));
}
export function readErrorsLog(file) {
  const abs = path.resolve(file);
  try { fs.statSync(file); }
  catch (e) {
    return { clusters: [], status: e.code === 'ENOENT'
      ? inputStatus({ kind: 'missing', path: abs })
      : inputStatus({ kind: 'unreadable', code: e.code, path: abs }) };
  }
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { clusters: [], status: inputStatus({ kind: 'unreadable', code: e.code, path: abs }) }; }
  const clusters = hermesClusters(raw.split('\n').filter(Boolean).slice(-500));
  return { clusters, status: inputStatus({ kind: 'ok', n: clusters.length, unit: 'clusters' }) };
}

// ---- G3: loop-ledger freshness (5.4 + N3) ----
function clusterLoop(rows) {
  const norm = s => String(s || '').replace(/\d{8}-\d{6}/g, '<run>').replace(/\d+/g, 'N').slice(0, 200);
  const counts = new Map(), sample = new Map();
  for (const r of rows) {
    const k = `${r.verdict} :: ${norm(r.detail)}`;
    counts.set(k, (counts.get(k) || 0) + 1);
    if (!sample.has(k)) sample.set(k, { run: r.run, task_slug: r.task_slug, detail: r.detail, iterations: r.iterations });
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([cluster, count]) => ({ count, cluster, sample: sample.get(cluster) }));
}
const isoDate = ts => new Date(ts).toISOString().slice(0, 10);
function rowTimestamp(r) {
  const cands = [];
  const numeric = v => {
    if (typeof v === 'number' && isFinite(v)) return v < 1e11 ? v * 1000 : v;
    if (typeof v === 'string' && v.trim()) {
      const n = v.replace(/([+-]\d{2})(\d{2})\s*$/, '$1:$2');   // N3: %z +HHMM
      const t = Date.parse(n);
      if (!isNaN(t)) return t;
    }
    return null;
  };
  for (const key of ['ts', 'time']) if (r[key] != null) { const t = numeric(r[key]); if (t != null) cands.push(t); }
  if (typeof r.run === 'string') {
    const m = r.run.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
    if (m) { const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]); if (!isNaN(d.getTime())) cands.push(d.getTime()); }
  }
  return cands.length ? Math.max(...cands) : null;
}
export function loopFailures(ledgerPath, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxAgeDays = Number(opts.maxAgeDays) > 0 ? Number(opts.maxAgeDays) : 21;
  const limitMs = maxAgeDays * DAY;
  if (!ledgerPath) return { clusters: [], status: inputStatus({ kind: 'not-configured' }) };
  let raw;
  try { raw = fs.readFileSync(ledgerPath, 'utf8'); }
  catch (e) {
    return { clusters: [], status: e.code === 'ENOENT'
      ? inputStatus({ kind: 'missing', path: ledgerPath })
      : inputStatus({ kind: 'unreadable', code: e.code, path: ledgerPath }) };
  }
  const rows = raw.split('\n').filter(Boolean).slice(-200)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (rows.length === 0) return { clusters: [], status: inputStatus({ kind: 'ok', n: 0 }) };
  const dated = [];
  let undated = 0;
  for (const r of rows) { const ts = rowTimestamp(r); if (ts == null) undated++; else dated.push({ r, ts }); }
  const withinLimit = ts => ts >= now - limitMs && ts <= now + DAY;
  const freshDated = dated.filter(d => withinLimit(d.ts));
  if (dated.length === 0)
    return { clusters: [], status: inputStatus({ kind: 'stale', detail: `no dated rows, limit ${maxAgeDays}d`, path: ledgerPath }) };
  if (freshDated.length === 0) {
    const newest = Math.max(...dated.map(d => d.ts));
    return { clusters: [], status: inputStatus({ kind: 'stale', detail: `newest ${isoDate(newest)}, limit ${maxAgeDays}d`, path: ledgerPath }) };
  }
  let older = 0;
  const failures = [];
  for (const { r, ts } of dated) {
    if (r.verdict === 'PASS') continue;
    if (!withinLimit(ts)) { older++; continue; }
    failures.push(r);
  }
  const clusters = clusterLoop(failures);
  const extras = [];
  if (older > 0) extras.push({ key: 'older', label: `older than ${maxAgeDays}d`, count: older });
  if (undated > 0) extras.push({ key: 'undated', label: 'undated', count: undated });
  return { clusters, status: inputStatus({ kind: 'ok', n: clusters.length, extras }) };
}

// ---- G4: prior proposals (5.5) ----
const PROPOSAL_FILE = /^(\d{4})-(\d{2})-(\d{2})-trace-proposals(?:-\d+)?\.md$/i;
const STATE_LINE = /^\s*-\s*\[([ xX])\]\s*\*\*Apply\*\*\s*·\s*\[([ xX])\]\s*\*\*Reject\*\*\s*$/;
function parseProposalFile(text, filename, now) {
  const lines = text.split(/\r?\n/);
  const dm = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  const date = dm ? dm[1] : '';
  const daysAgo = date ? Math.max(0, Math.round((now - new Date(date + 'T00:00:00').getTime()) / DAY)) : 999;
  const fence = new Array(lines.length).fill(false);
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { fence[i] = true; open = !open; }
    else fence[i] = open;
  }
  const accepted = [];
  let prev = 0;
  for (let i = 0; i < lines.length; i++) {
    if (fence[i]) continue;
    const m = lines[i].match(/^##\s+(\d+)\.\s+(.+)$/);
    if (!m) continue;
    if (Number(m[1]) !== prev + 1) continue;
    const title = m[2].replace(/\s*🔒 SAFETY\s*$/, '').trim().slice(0, 120);
    accepted.push({ i, title });
    prev = Number(m[1]);
  }
  const items = [];
  for (let a = 0; a < accepted.length; a++) {
    const sec = accepted[a];
    const sl = lines[sec.i + 1] || '';
    let state = 'pending';
    const sm = sl.match(STATE_LINE);
    if (sm) { const apply = sm[1] !== ' ', reject = sm[2] !== ' '; state = reject ? 'rejected' : (apply ? 'applied' : 'pending'); }
    const end = a + 1 < accepted.length ? accepted[a + 1].i : lines.length;
    let lesson = '';
    for (let j = sec.i + 1; j < end; j++) {
      if (/^\s*-\s*\*\*Lesson draft/i.test(lines[j])) {
        for (let k = j + 1; k < Math.min(end, lines.length); k++) {
          if (/^\s*```/.test(lines[k])) { if (k + 1 < lines.length) lesson = lines[k + 1].trim().slice(0, 120); break; }
        }
        break;
      }
    }
    items.push({ title: sec.title, state, lesson, date, daysAgo });
  }
  return items;
}
export function readPriorProposals(dir, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxAgeMs = (opts.maxAgeDays ?? 30) * DAY;
  const cap = opts.cap ?? 200;
  let names;
  try { names = fs.readdirSync(dir); }
  catch (e) {
    return { items: [], truncated: [], status: e.code === 'ENOENT'
      ? inputStatus({ kind: 'none-yet' })
      : inputStatus({ kind: 'unreadable', code: e.code, path: dir }) };
  }
  const files = names.filter(n => PROPOSAL_FILE.test(n))
    .map(n => ({ n, t: (m => new Date(+m[1], +m[2] - 1, +m[3]).getTime())(n.match(/^(\d{4})-(\d{2})-(\d{2})/)) }))
    .filter(f => f.t >= now - maxAgeMs && f.t <= now + DAY)
    .sort((a, b) => b.t - a.t);
  if (files.length === 0) return { items: [], truncated: [], status: inputStatus({ kind: 'none-yet' }) };
  let unreadable = 0, items = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(dir, f.n), 'utf8'); }
    catch (e) { unreadable++; console.error(`trace-miner: cannot read prior proposal ${f.n}: ${e.code || e}`); continue; }
    items.push(...parseProposalFile(text, f.n, now));
    if (items.length >= cap) break;
  }
  items = items.slice(0, cap);
  const extras = unreadable > 0 ? [{ key: 'unreadable', label: 'unreadable', count: unreadable }] : [];
  return { items, truncated: [], status: inputStatus({ kind: 'ok', n: items.length, extras }) };
}

// ---- G4: title similarity (5.5) ----
const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'not']);
export function normTitle(title) {
  return String(title == null ? '' : title).toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
    .filter(t => !STOPWORDS.has(t)).join(' ');
}
export function jaccard(a, b) {
  const A = new Set(String(a).split(/\s+/).filter(Boolean));
  const B = new Set(String(b).split(/\s+/).filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = new Set([...A, ...B]).size;
  return union ? inter / union : 0;
}
export function dropRepeats(proposals, history, opts = {}) {
  const kept = [], dropped = [], near = [];
  const hist = history.map(h => {
    const days = h.daysAgo ?? 999;
    const decided = (h.state === 'applied' || h.state === 'rejected') && days <= 30;
    return { title: h.title, n: normTitle(h.title), days, recent: days <= 7, decided };
  }).filter(h => h.recent || h.decided);
  for (const p of proposals) {
    const title = String(p.title == null ? '' : p.title).slice(0, 120);
    const pn = normTitle(title);
    let best = null;
    if (pn) for (const h of hist) {
      const s = jaccard(pn, h.n);
      if (s > 0 && (!best || s > best.score)) best = { score: s, h };
    }
    if (best && best.score >= 0.6) {
      dropped.push({ title: flatten(title, 120), matched: flatten(best.h.title, 120),
        relation: best.h.decided ? 'decided' : 'recent', days: best.h.days });
    } else {
      kept.push(p);
      if (best && best.score >= 0.4)
        near.push({ title: flatten(title, 120), matched: flatten(best.h.title, 120), jaccard: Math.round(best.score * 1000) / 1000 });
    }
  }
  return { kept, dropped, near: near.slice(0, 10), truncated: [] };
}

// ---- G2: input status (5.3) ----
export function inputStatus(state) {
  switch (state.kind) {
    case 'ok': {
      const parts = [state.unit ? `${state.n} ${state.unit}` : String(state.n)];
      for (const e of state.extras || []) if (e.count > 0) parts.push(`${e.count} ${e.label}`);
      const text = `ok (${parts.join(', ')})`;
      const unreadable = (state.extras || []).reduce((s, e) => s + (e.key === 'unreadable' ? e.count : 0), 0);
      return { text, attention: unreadable > 0 || state.allIgnored === true };
    }
    case 'missing': return { text: `missing ${state.path}`, attention: true };
    case 'unreadable': return { text: `unreadable (${state.code}) ${state.path}`, attention: true };
    case 'stale': return { text: `stale (${state.detail}) ${state.path}`, attention: true };
    case 'not-configured': return { text: 'not configured', attention: false };
    case 'none-yet': return { text: 'none yet', attention: false };
    default: return { text: 'not configured', attention: false };
  }
}

// ---- G4: render (5.1 + M1) ----
export function renderMd(proposals, opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const inputsText = flatten(opts.inputsText || '', 4000);
  const dropped = opts.dropped || [];
  const fm = `---\ntype: trace-proposals\ntags: [neurolink, agents, review]\ncreated: ${today}\nsource: trace-miner\nstatus: pending-review\n---\n`;
  let banner = `# Agent Trace Proposals — ${today}\n\n> ⚠️ **REVIEW ONLY — nothing here has been applied.** The trace-miner neuron read agent failure traces (${inputsText}) and proposes the fixes below. Vet each against the CURRENT state (some may already be fixed), then apply by hand. **Items flagged 🔒 touch safety/money — never auto-apply; you approve those explicitly.**`;
  if (dropped.length) {
    const titles = dropped.slice(0, 5).map(d => flatten(d.title, 120));
    banner += ` · dropped ${dropped.length} similar proposal(s) (score >= 0.6): ${titles.join('; ')}`;
  }
  banner += '\n';
  const body = proposals.map((p, i) => {
    const safe = p.is_safety_rule ? ' 🔒 SAFETY' : '';
    const lines = [
      `## ${i + 1}. ${flatten(p.title, 120)}${safe}`,
      `- [ ] **Apply** · [ ] **Reject**`,
      `- **Affected:** ${flatten(p.affected, 400)}`,
      `- **Confidence:** ${flatten(p.confidence, 400)} · **Risk:** ${flatten(p.risk, 400)}`,
      `- **Evidence:** ${flatten(p.evidence, 400)}`,
      `- **Root cause:** ${flatten(p.root_cause, 400)}`,
      `- **Proposed fix:** ${flatten(p.proposed_fix, 400)}`,
    ];
    if (p.lesson_draft) lines.push(`- **Lesson draft (for LESSONS.md):**\n\`\`\`\n${flatten(p.lesson_draft, 400)}\n\`\`\``);
    return lines.join('\n');
  }).join('\n\n');
  return `${fm}${banner}\n${body}\n`;
}

// ---- prompt (5.5 prior-proposals block) ----
function buildPrompt(hermes, reviews, loop, prior, ownerName, stackDescription) {
  const truncated = [];
  const decided = prior.filter(p => p.state === 'applied' || p.state === 'rejected');
  const recent = prior.filter(p => p.daysAgo <= 7 && p.state !== 'applied' && p.state !== 'rejected');
  const lessons = prior.filter(p => p.lesson);
  const older = prior.filter(p => p.daysAgo > 7 && p.state !== 'applied' && p.state !== 'rejected' && p.daysAgo <= 30);
  const lines = [];
  const push = (arr, max, fmt) => { let c = 0; for (const p of arr) { if (c >= max) break; lines.push(fmt(p)); c++; } return arr.length - c; };
  let cut = 0;
  cut += push(decided, 20, p => `- ${flatten(p.title, 120)} [decided: ${p.state}]`);
  cut += push(recent, 25, p => `- ${flatten(p.title, 120)}`);
  cut += push(lessons, 10, p => `- already-drafted lesson: ${flatten(p.lesson, 120)}`);
  const remaining = Math.max(0, 60 - lines.length);
  cut += push(older, remaining, p => `- ${flatten(p.title, 120)}`);
  if (lines.length > 60) lines.length = 60;
  if (lines.length === 0) lines.push('- (nothing yet)');
  if (cut > 0) truncated.push('prior titles 60');
  // review block cap: 24000 chars, oldest dropped first (items are newest-first)
  let promptReviews = reviews.slice();
  while (promptReviews.length && JSON.stringify(promptReviews, null, 1).length > 24000) promptReviews.pop();
  if (promptReviews.length < reviews.length) truncated.push('review block 24000');
  const priorBlock = `=== ALREADY PROPOSED (do not repeat; a proposal with a very similar title is discarded after your reply) ===\n${lines.join('\n')}`;
  const text = `You are the trace-miner neuron for ${ownerName}'s ${stackDescription}. You are given RECENT agent failure traces and the builders' review findings. Find RECURRING, FIXABLE problems whose root cause is the agents' MEMORY / SYSTEM-PROMPTS / CONFIG — or, for builder reviews, the builders' instructions and checks — and propose concrete fixes for a HUMAN to review.

Return ONLY a JSON array. Each element:
{
  "title": "short problem name",
  "affected": "which agent(s)/file(s): e.g. ~/.hermes/config.yaml, a builder's SOUL.md, the project's CLAUDE.md",
  "evidence": "the recurring trace + how often (cite the count)",
  "root_cause": "why it happens — memory/prompt/config, not infra",
  "proposed_fix": "concrete change: which file + line/section + the exact edit",
  "confidence": "low|med|high",
  "risk": "blast radius if applied",
  "is_safety_rule": true|false,  // true if it touches money / guardrails / deny-by-default / single-writer — FLAG, never assume auto-apply
  "lesson_draft": "optional string — a paste-ready LESSONS.md entry (see rules)"
}

RULES:
- Propose memory/prompt/config fixes only — never code-logic changes (except the deterministic-check exception below).
- These are PROPOSALS for human review. Never assume they will be auto-applied.
- If a recurring failure is transient infra (rate-limit 429, network, broken pipe, "service overloaded", upstream 5xx), DO NOT propose a prompt change — either skip it or add it with confidence "low" and root_cause "infra/transient".
- Some failures may ALREADY be fixed. If a trace looks like an already-resolved issue, still list it but mark confidence "low" and note "verify already-fixed" in root_cause. A builder-review finding the same job's later round marked closed is resolved for that job, but still counts toward a recurring KIND of mistake.
- For any cluster recurring >=2x — loop-harness clusters AND the same kind of builder-review finding across 2+ reviews (count distinct reviews, not rounds re-reporting one finding) — ALSO fill "lesson_draft": ONE dated imperative LESSONS.md entry (generalizable — "always check Y", never "fix file X"), ready to paste. Still never for a one-off or for transient infra. For builder reviews, recurrence means DISTINCT "job" values: later rounds of the same job re-report and re-check that job's findings, so several rounds of one job count as ONE occurrence.
- EXCEPTION scoped to loop-harness and builder-review clusters ONLY: you MAY propose a deterministic check (a guardrails.sh tripwire, verify.sh step, a repo rule check or test, or a breaker rule) as the fix — repeated build/review failures should be promoted to code, not prompts. These remain REVIEW-ONLY proposals like everything else. For Hermes errors.log items the existing memory/prompt/config-only rule stands unchanged.
- Do NOT draft lessons for one-off failures or transient infra (auth outage, port collision) that is already fixed — check the count.
- Max 8 proposals, highest recurrence first. If nothing meaningful recurs, return [].

${priorBlock}

TRACE DATA
=== Hermes recurring failures (normalized, with counts) ===
${JSON.stringify(hermes, null, 1)}
=== Builder cross-review findings (${reviews.length} reviews; newest first; verdict + findings not marked closed) ===
${JSON.stringify(promptReviews, null, 1)}
=== Loop-harness build failures (coding loop; count = recurrences) ===
${JSON.stringify(loop, null, 1)}`;
  return { text, truncated };
}

// ---- dynamic config (5.1) ----
async function loadConfig() {
  const { CONFIG, PRIVATE_NAME } = await import('../config.mjs');
  return {
    VAULT: CONFIG.vault, HOME: CONFIG.home, HERMES: CONFIG.hermesHome,
    OUT_DIR: path.join(CONFIG.vault, '_claude', 'learning', 'trace-proposals'),
    LOG: process.env.NEUROLINK_LOG || path.join(CONFIG.home, 'neuron-log.jsonl'),
    LEDGER: CONFIG.loopLedger, REVIEW_ROOTS: CONFIG.reviewRoots,
    PRIVATE_NAME, ownerName: CONFIG.ownerName, stackDescription: CONFIG.stackDescription,
    loopLedgerMaxAgeDays: CONFIG.loopLedgerMaxAgeDays,
    CLAUDE_CMD: process.env.NEUROLINK_CLAUDE_CMD || 'claude',
    DRY: process.argv.includes('--dry'),
  };
}
const parseJSON = raw => {
  let s = String(raw).trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const a = s.indexOf('['), b = s.lastIndexOf(']'), oa = s.indexOf('{'), ob = s.lastIndexOf('}');
  if (a !== -1 && (a < oa || oa === -1)) s = s.slice(a, b + 1);
  else if (oa !== -1) s = s.slice(oa, ob + 1);
  return JSON.parse(s);
};

// ---- failed-receipt input context (m2: restores the base inputContext key;
//      design 5.3 only ADDS keys, so this is added, not removed) ----
const boundedText = value => (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 320);
function boundedInputContext({ hermes, reviews, loop }) {
  const cluster = item => ({
    count: item.count,
    ...(item.cluster ? { cluster: boundedText(item.cluster) } : {}),
    sample: boundedText(item.sample),
  });
  return {
    counts: { hermes: hermes.length, reviews: reviews.length, loop: loop.length },
    hermes: hermes.slice(0, 2).map(cluster),
    reviews: reviews.slice(0, 2).map(boundedText),
    loop: loop.slice(0, 2).map(cluster),
  };
}

async function main() {
  const cfg = await loadConfig();
  const now = new Date();
  const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const callClaude = p => execFileSync(cfg.CLAUDE_CMD, ['-p', p], { encoding: 'utf8', maxBuffer: 1 << 24, cwd: '/tmp', timeout: 180000, killSignal: 'SIGKILL' });
  const logRun = e => {
    if (cfg.DRY) { console.log(`(dry run: ${e.outcome} receipt not written)`); return true; }
    try { fs.appendFileSync(cfg.LOG, JSON.stringify({ ts: Date.now(), neuron: 'trace-miner', ...e }) + '\n'); return true; }
    catch (error) { console.error('trace-miner receipt logging failed:', String(error).slice(0, 200)); return false; }
  };
  const atomicWrite = (name, content) => {
    fs.mkdirSync(cfg.OUT_DIR, { recursive: true });
    const tmp = path.join(cfg.OUT_DIR, `.${name}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, path.join(cfg.OUT_DIR, name));
  };

  // inputs
  const errRes = readErrorsLog(path.join(cfg.HERMES, 'logs', 'errors.log'));
  const scan = scanBuilderReviews(cfg.REVIEW_ROOTS, { now: now.getTime(), privateName: cfg.PRIVATE_NAME });
  const loopRes = loopFailures(cfg.LEDGER, { now: now.getTime(), maxAgeDays: cfg.loopLedgerMaxAgeDays });
  const priorRes = readPriorProposals(cfg.OUT_DIR, { now: now.getTime(), maxAgeDays: 30 });

  const inputParts = [`errors.log: ${errRes.status.text}`];
  if (cfg.REVIEW_ROOTS.length === 0) inputParts.push('reviews: not configured');
  else for (const rs of scan.rootStatuses) inputParts.push(`reviews ${rs.root}: ${rs.status.text}`);
  inputParts.push(`loop ledger: ${loopRes.status.text}`);
  inputParts.push(`prior proposals: ${priorRes.status.text}`);
  const inputsLine = 'inputs: ' + inputParts.join(' · ');
  console.log(inputsLine);                                  // before any model call (5.3)

  const statuses = [errRes.status, loopRes.status, priorRes.status, ...scan.rootStatuses.map(r => r.status)];
  const attention = statuses.some(s => s.attention);
  const receiptInputs = {
    hermes: errRes.status.text,
    reviews: cfg.REVIEW_ROOTS.length === 0 ? [] : scan.rootStatuses.map(r => ({ root: r.root, status: r.status.text })),
    loop: loopRes.status.text,
    prior: priorRes.status.text,
  };
  const bp = buildPrompt(errRes.clusters, scan.items, loopRes.clusters, priorRes.items, cfg.ownerName, cfg.stackDescription);
  const truncated = [...new Set([...scan.truncated, ...priorRes.truncated, ...bp.truncated])];
  const drops0 = { dropped: [], near: [] };
  const baseReceipt = extra => ({ ...extra, inputs: receiptInputs, dropped: drops0.dropped, near: drops0.near, truncated });

  const writeStatus = (outcome, reason) => {
    const lines = [
      `# trace-miner status — ${outcome} — ${TODAY}`,
      `date: ${TODAY}`,
      `outcome: ${outcome}`,
      `reason: ${flatten(reason, 400)}`,
      'inputs:',
      ...inputParts.map(s => flatten(s, 1000)),
    ];
    try { atomicWrite(`${TODAY}-trace-miner-status.md`, lines.join('\n') + '\n'); }
    catch (e) { console.error(`trace-miner: could not write status file: ${e.code || e}`); } // M7: caught
  };
  const skipped = reason => {
    if (cfg.DRY) { console.log(`dry: would skip (${flatten(reason, 200)})`); return; }
    logRun(baseReceipt({ outcome: 'skipped', reason: flatten(reason, 320), wrote: null, count: 0 }));
    if (attention) writeStatus('skipped', reason);
  };
  const failed = (error) => {
    const detail = typeof error?.stderr === 'string' && error.stderr.trim() ? error.stderr.trim() : error?.message || String(error);
    const reason = `claude/parse failed: ${detail}`.slice(0, 320);
    if (cfg.DRY) { console.log(`dry: would skip (${reason})`); process.exit(1); } // m1: --dry keeps exit 1
    console.error('✗', reason);
    // m2: restore the base inputContext key on the failed receipt (add, don't remove).
    const failedReceipt = baseReceipt({ outcome: 'failed', reason, wrote: null, count: 0,
      inputContext: boundedInputContext({ hermes: errRes.clusters, reviews: scan.items, loop: loopRes.clusters }) });
    logRun(failedReceipt);
    if (attention) writeStatus('failed', reason);
    process.exit(1);
  };

  const signal = errRes.clusters.length + scan.items.length + loopRes.clusters.length;
  if (!signal) { skipped('no trace signal — nothing to mine.'); return; }

  let proposals;
  try { proposals = parseJSON(callClaude(bp.text)); }
  catch (e) { failed(e); return; }
  if (!Array.isArray(proposals)) proposals = proposals.proposals || [];
  if (!proposals.length) { skipped('claude found nothing meaningful recurring.'); return; }

  const history = priorRes.items.map(p => ({ title: p.title, state: p.state, daysAgo: p.daysAgo }));
  const drop = dropRepeats(proposals, history, { now: now.getTime() });
  const finalTruncated = [...new Set([...truncated, ...drop.truncated])];
  const receipt = extra => ({ ...extra, inputs: receiptInputs, dropped: drop.dropped, near: drop.near, truncated: finalTruncated });

  if (drop.kept.length === 0) {                            // all dropped
    if (cfg.DRY) { console.log('dry: would skip (all proposals already proposed/decided)'); return; }
    logRun(receipt({ outcome: 'skipped', reason: 'all proposals already proposed/decided', wrote: null, count: 0 }));
    if (attention) writeStatus('skipped', 'all proposals already proposed/decided');
    return;
  }

  if (cfg.DRY) {
    console.log(`dry: would write ${drop.kept.length} proposal(s), dropped ${drop.dropped.length}`);
    return;                                              // no file, no status, no receipt
  }

  const md = renderMd(drop.kept, { today: TODAY, inputsText: inputsLine, dropped: drop.dropped });
  let name = `${TODAY}-trace-proposals.md`, n = 2;
  while (fs.existsSync(path.join(cfg.OUT_DIR, name))) { name = `${TODAY}-trace-proposals-${n}.md`; n++; }
  atomicWrite(name, md);                                 // M7: proposal write failure stays uncaught
  console.log(`✓ wrote ${drop.kept.length} proposal(s) → ${name}`);
  logRun(receipt({ outcome: 'wrote', outputPath: path.join(cfg.OUT_DIR, name), wrote: path.join(cfg.OUT_DIR, name), count: drop.kept.length }));
}

// ---- --selftest: config-free, 11 finding shapes (6.1) ----
if (process.argv.includes('--selftest')) {
  const cases = [
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
  for (const [line, closed] of cases) {
    if (!(LIST_FINDING.test(line) || TABLE_FINDING.test(line))) throw new Error(`not recognised: ${line}`);
    if (isClosedStatus(findingStatus(line)) !== closed) throw new Error(`wrong status: ${line}`);
  }
  console.log(`selftest ok — ${cases.length} finding shapes`);
  process.exit(0);
}

// ---- isMain guard (health.mjs:284-285) ----
const realPath = p => { try { return fs.realpathSync(p); } catch { return p; } };
const isMain = process.argv[1] && realPath(path.resolve(process.argv[1])) === realPath(fileURLToPath(import.meta.url));
if (isMain) await main();
