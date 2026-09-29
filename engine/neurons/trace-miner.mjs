#!/usr/bin/env node
/* ============================================================
   trace-miner.mjs — the AGENT-TRACE reflective neuron.

   Neurolink's other neurons reflect over the VAULT (notes). This one reflects
   over AGENT PRODUCTION TRACES — where the Hermes agents actually failed — and
   proposes memory/prompt/config fixes for HUMAN REVIEW. It closes the loop the
   LangSmith-Engine demo describes ("traces → signal → reviewed memory → better
   behavior"), on the owner's own stack (a subscription model CLI, no API key).

   Reads (bounded, read-only; locations come from config.mjs):
     <hermesHome>/logs/errors.log     recurring WARNING/ERROR (normalized + counted)
     <reviewRoots>/*-review-rN/RESULT.md  builder cross-reviews
                                          (verdict + severity findings not closed, last 7 days)
       (replaced two retired reviewer-bot logs on 2026-09-29 — those bots
        stopped writing and left the route)
     <loopLedger>                     build-loop terminal outcomes (non-PASS,
                                          clustered by verdict + normalized detail)

   Writes (proposals ONLY — never applied):
     <vault>/_claude/learning/trace-proposals/YYYY-MM-DD-trace-proposals.md

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

   Usage:  node neurons/trace-miner.mjs [--dry]
     --dry   gather + reason + print the markdown, but write nothing (for testing)
   Cadence: DAILY or WEEKLY. Degrades gracefully (try/catch, 180s claude cap).
   ============================================================ */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.mjs';

const VAULT  = CONFIG.vault;
const HOME   = CONFIG.home;
const HERMES = CONFIG.hermesHome;
const OUT_DIR = path.join(VAULT, '_claude', 'learning', 'trace-proposals');
const LOG = process.env.NEUROLINK_LOG || path.join(HOME, 'neuron-log.jsonl');
const CLAUDE_CMD = process.env.NEUROLINK_CLAUDE_CMD || 'claude';
const DRY = process.argv.includes('--dry');

const now = new Date();
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

// Same proven pattern as run-neuron.mjs: cwd /tmp so the claude child needs no Full
// Disk Access (only `node` is granted it); 180s cap so a hung claude -p can't freeze a launchd run.
const callClaude = p => execFileSync(CLAUDE_CMD, ['-p', p], { encoding: 'utf8', maxBuffer: 1 << 24, cwd: '/tmp', timeout: 180000, killSignal: 'SIGKILL' });
const logRun = e => {
  // --dry writes nothing — not even a receipt (health.mjs would count a dry "skipped" entry as a real success).
  if (DRY) { console.log(`(dry run: ${e.outcome} receipt not written)`); return true; }
  try { fs.appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...e }) + '\n'); return true; }
  catch (error) { console.error('✗ trace-miner receipt logging failed:', String(error).slice(0, 200)); return false; }
};

// Failure receipts retain enough of the input to reproduce what the reasoner saw,
// without copying whole production traces into the neuron log.
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
function failedReceipt(error, input) {
  const detail = typeof error?.stderr === 'string' && error.stderr.trim()
    ? error.stderr.trim()
    : error?.message || String(error);
  const reason = `claude/parse failed: ${detail}`.slice(0, 320);
  logRun({
    neuron: 'trace-miner',
    outcome: 'failed',
    wrote: null,
    count: 0,
    reason,
    inputContext: boundedInputContext(input),
  });
  return reason;
}

// Extract the first JSON array (or object) from a possibly-fenced claude reply.
function parseJSON(raw) {
  let s = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  const oa = s.indexOf('{'), ob = s.lastIndexOf('}');
  if (a !== -1 && (a < oa || oa === -1)) s = s.slice(a, b + 1);
  else if (oa !== -1) s = s.slice(oa, ob + 1);
  return JSON.parse(s);
}

const tail = (file, n) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n); } catch { return []; } };
const readJsonl = (file, n) => tail(file, n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// Hermes failures: keep WARNING/ERROR lines, normalize volatile tokens (timestamps,
// thread ids, session ids, numbers) so the same failure collapses to one cluster, then count.
function hermesFailures() {
  const norm = s => s
    .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[.,]\d+/g, '<ts>')
    .replace(/thread=\S+/g, 'thread=<t>')
    .replace(/\[\d{8}_\d{6}_[a-f0-9]+\]/g, '[<sid>]')
    .replace(/req_[A-Za-z0-9]+/g, 'req_<id>')
    .replace(/\d+/g, 'N')
    .trim();
  const counts = new Map(), sample = new Map();
  for (const l of tail(path.join(HERMES, 'logs', 'errors.log'), 500)) {
    if (!/WARNING|ERROR/.test(l)) continue;
    const k = norm(l).slice(0, 220);
    counts.set(k, (counts.get(k) || 0) + 1);
    if (!sample.has(k)) sample.set(k, l.slice(0, 320));
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
    .map(([cluster, count]) => ({ count, cluster, sample: sample.get(cluster) }));
}

// Builder cross-reviews: builder bots review each other's work, and each round leaves <job>-review-rN/RESULT.md
// under a config reviewRoots folder (rounds whose RESULT.md exists only on another machine are not seen). Keep the
// verdict line plus the severity-tagged finding lines that are not marked closed (partly/not closed are kept).
// A clean PASS with nothing open carries no failure signal.
const REVIEW_ROOTS = CONFIG.reviewRoots;
// 7 days: the job runs daily, so a longer window re-sends the same rounds (and re-proposes the same fixes) for weeks.
// ponytail: a time window, not a seen-set; add a high-water mark if repeats still annoy.
const REVIEW_MAX_AGE_MS = 7 * 864e5;
// Finding shapes: list items ("3. HIGH, PARTLY CLOSED (…)", "7. MEDIUM, OPEN (…)", "1. **HIGH — …**",
// "A. **MEDIUM — …**", or a bare "**MEDIUM — …**" line) and table rows ("| 1, HIGH, topic | **Partly closed** | …").
// The status is its own field: the text right after "SEVERITY," in a list item, or the second cell of a table row.
// A finding is closed only when that status STARTS with "closed"; "partly closed", "open" and no status at all stay
// open, and the description is never searched (so "not fail-closed" in a title stays open).
const LIST_PREFIX = String.raw`^\s*(?:(?:\d+|[A-Z])\.\s*|[-*]\s*)?\**\s*(?:CRITICAL|HIGH|MEDIUM|LOW)\b`;
const LIST_FINDING = new RegExp(LIST_PREFIX);
const LIST_STATUS = new RegExp(LIST_PREFIX + String.raw`\s*,\s*(.*)$`);
const TABLE_FINDING = /^\s*\|\s*\d+,\s*(?:CRITICAL|HIGH|MEDIUM|LOW)\b/;
function findingStatus(line) {
  if (TABLE_FINDING.test(line)) return line.split('|')[2] || '';
  const m = line.match(LIST_STATUS);
  return m ? m[1].slice(0, 40) : '';
}
const isClosedStatus = status => /^\W*closed\b/i.test(status);
function builderReviews() {
  const cutoff = Date.now() - REVIEW_MAX_AGE_MS, out = [];
  for (const root of REVIEW_ROOTS) {
    const readFailed = (what, e) => { if (e?.code !== 'ENOENT') console.error(`✗ builder reviews: cannot read ${what}: ${e?.code || e}`); };
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter(d => /-review-r\d+$/.test(d)); } catch (e) { readFailed(root, e); continue; }
    for (const d of dirs) {
      const file = path.join(root, d, 'RESULT.md');   // some rounds have no Mac RESULT.md (ENOENT) — skipped quietly
      let st, lines;
      try { st = fs.statSync(file); if (st.mtimeMs < cutoff) continue; lines = fs.readFileSync(file, 'utf8').split('\n'); }
      catch (e) { readFailed(file, e); continue; }
      const verdict = (lines.slice(0, 8).find(l => /\b(PASS|FAIL|CHANGES REQUIRED|BLOCKED)\b/i.test(l)) || '')
        .replace(/^#+\s*/, '').slice(0, 160);
      const findings = lines
        .filter(l => (LIST_FINDING.test(l) || TABLE_FINDING.test(l)) && !isClosedStatus(findingStatus(l)))
        .slice(0, 12).map(l => l.trim().slice(0, 300));
      const cleanPass = /\bPASS\b/i.test(verdict) && !/\b(FAIL|CHANGES REQUIRED|BLOCKED)\b/i.test(verdict);
      if (cleanPass && !findings.length) continue;
      const [, job, round] = d.match(/^(.*)-review-r(\d+)$/);   // rounds of one job re-report the same findings
      out.push({ job, round: Number(round), mtime: st.mtimeMs, verdict, findings });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 20).map(({ mtime, ...r }) => r);
}

// Loop-harness failures: a build loop can append one structured JSON line per terminal outcome
// ({verdict, detail, run, task_slug, iterations}) to config loopLedger. Non-PASS only, clustered by
// verdict + normalized detail so the same failure counts as one recurring cluster. No ledger = no loop signal.
const LEDGER = CONFIG.loopLedger;
function loopFailures() {
  const norm = s => String(s || '').replace(/\d{8}-\d{6}/g, '<run>').replace(/\d+/g, 'N').slice(0, 200);
  const counts = new Map(), sample = new Map();
  for (const r of readJsonl(LEDGER, 200)) {
    if (!r.verdict || r.verdict === 'PASS') continue;
    const k = `${r.verdict} :: ${norm(r.detail)}`;
    counts.set(k, (counts.get(k) || 0) + 1);
    if (!sample.has(k)) sample.set(k, { run: r.run, task_slug: r.task_slug, detail: r.detail, iterations: r.iterations });
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([cluster, count]) => ({ count, cluster, sample: sample.get(cluster) }));
}

function buildPrompt(hermes, reviews, loop) {
  return `You are the trace-miner neuron for ${CONFIG.ownerName}'s ${CONFIG.stackDescription}. You are given RECENT agent failure traces and the builders' review findings. Find RECURRING, FIXABLE problems whose root cause is the agents' MEMORY / SYSTEM-PROMPTS / CONFIG — or, for builder reviews, the builders' instructions and checks — and propose concrete fixes for a HUMAN to review.

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

TRACE DATA
=== Hermes recurring failures (normalized, with counts) ===
${JSON.stringify(hermes, null, 1)}
=== Builder cross-review findings (${reviews.length} reviews; newest first; verdict + findings not marked closed) ===
${JSON.stringify(reviews, null, 1)}
=== Loop-harness build failures (coding loop; count = recurrences) ===
${JSON.stringify(loop, null, 1)}`;
}

function renderMd(proposals, counts) {
  const fm = `---\ntype: trace-proposals\ntags: [neurolink, agents, review]\ncreated: ${TODAY}\nsource: trace-miner\nstatus: pending-review\n---\n`;
  const banner = `# Agent Trace Proposals — ${TODAY}\n\n> ⚠️ **REVIEW ONLY — nothing here has been applied.** The trace-miner neuron read agent failure traces (Hermes errors.log: ${counts.hermes} clusters · builder reviews: ${counts.reviews} · loop-harness: ${counts.loop}) and proposes the fixes below. Vet each against the CURRENT state (some may already be fixed), then apply by hand. **Items flagged 🔒 touch safety/money — never auto-apply; you approve those explicitly.**\n`;
  const body = proposals.map((p, i) => {
    const safe = p.is_safety_rule ? ' 🔒 SAFETY' : '';
    const lines = [
      `## ${i + 1}. ${p.title || 'untitled'}${safe}`,
      `- [ ] **Apply** · [ ] **Reject**`,
      `- **Affected:** ${p.affected || '?'}`,
      `- **Confidence:** ${p.confidence || '?'} · **Risk:** ${p.risk || '?'}`,
      `- **Evidence:** ${p.evidence || '?'}`,
      `- **Root cause:** ${p.root_cause || '?'}`,
      `- **Proposed fix:** ${p.proposed_fix || '?'}`,
    ];
    if (p.lesson_draft) lines.push(`- **Lesson draft (for LESSONS.md):**\n\`\`\`\n${p.lesson_draft}\n\`\`\``);
    return lines.join('\n');
  }).join('\n\n');
  return `${fm}${banner}\n${body}\n`;
}

function main() {
  const hermes = hermesFailures();
  const reviews = builderReviews();
  const loop = loopFailures();
  const signal = hermes.length + reviews.length + loop.length;
  console.log(`signal: ${hermes.length} hermes clusters, ${reviews.length} builder reviews, ${loop.length} loop`);
  if (!signal) {
    const reason = 'no trace signal — nothing to mine.';
    console.log(reason);
    logRun({ neuron: 'trace-miner', outcome: 'skipped', reason, wrote: null, count: 0 });
    return;
  }

  console.log('reasoning via claude -p …');
  let proposals;
  try { proposals = parseJSON(callClaude(buildPrompt(hermes, reviews, loop))); }
  catch (e) {
    const reason = failedReceipt(e, { hermes, reviews, loop });
    console.error('✗', reason);
    process.exit(1);
  }
  if (!Array.isArray(proposals)) proposals = proposals.proposals || [];
  if (!proposals.length) {
    const reason = 'claude found nothing meaningful recurring.';
    console.log(reason);
    logRun({ neuron: 'trace-miner', outcome: 'skipped', reason, wrote: null, count: 0 });
    return;
  }

  const md = renderMd(proposals, { hermes: hermes.length, reviews: reviews.length, loop: loop.length });
  if (DRY) {
    console.log('\n----- DRY RUN (not written) -----\n');
    console.log(md);
    logRun({ neuron: 'trace-miner', outcome: 'skipped', reason: 'dry run — proposal rendered but not written', wrote: null, count: proposals.length, dry: true });
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  let file = path.join(OUT_DIR, `${TODAY}-trace-proposals.md`), n = 2;
  while (fs.existsSync(file)) { file = path.join(OUT_DIR, `${TODAY}-trace-proposals-${n}.md`); n++; }
  fs.writeFileSync(file, md);
  console.log(`✓ wrote ${proposals.length} proposal(s) → ${file}`);
  logRun({ neuron: 'trace-miner', outcome: 'wrote', outputPath: file, wrote: file, count: proposals.length });
}

// `node neurons/trace-miner.mjs --selftest` — pins the review-finding status parser (no model call, no writes).
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

main();
