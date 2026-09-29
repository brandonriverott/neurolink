#!/usr/bin/env node
/* ============================================================
   run-neuron.mjs — the self-growing, self-LEARNING neuron loop.

   Each run:
     1. read SIGNALS from past patterns (passive — no clicks needed):
        explicit verdict > deleted > externally-linked > stale-ignored
     2. refresh the Taste Profile (learned prefs + your hand-typed steers)
     3. retrieve context via RAG (recency+importance+relevance) → reason via `claude -p`  (your subscription)
        conditioned on your taste + 1 deliberate WILDCARD (anti-yes-man)
     4. write findings to _brain/patterns/  (grows PREDICTIVE region)
     5. auto-group: link the note into Patterns — MOC (the weekly digest)
     6. log the run so the next run compounds

   Usage:  node neurons/run-neuron.mjs pattern
   Cadence: WEEKLY recommended (richer, less redundant). Uncapped per run,
   quality-gated. Safe: writes only NEW files; never mutates your notes.
   Privacy: hard-excludes any note matching config privateNamePattern.
   ============================================================ */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { drain, finish } from './reflect-queue.mjs';
import { evidenceLink, resolveNotePath, validateMemoryConsolidation } from './evidence-paths.mjs';
import { CONFIG, PRIVATE_NAME, projectLink } from '../config.mjs';

const OWNER = CONFIG.ownerName;
const OWNER_UP = OWNER.toUpperCase();
const PROJECT_LINK = projectLink('Neurolink Brain');
const VAULT = CONFIG.vault;
const HOME = CONFIG.home;
const PATTERNS_DIR = path.join(VAULT, '_brain', 'patterns');
const MOC = path.join(PATTERNS_DIR, 'Patterns — MOC.md');
const TASTE = path.join(PATTERNS_DIR, 'Taste Profile.md');
const LOG = process.env.NEUROLINK_LOG || path.join(HOME, 'neuron-log.jsonl');
const RAG = process.env.NEUROLINK_RAG_URL || 'http://localhost:8920';   // #1: neuron retrieves context via the RAG server (recency+importance+relevance)
const CLAUDE_CMD = process.env.NEUROLINK_CLAUDE_CMD || 'claude';
const EXCLUDE_DIRS = new Set(['.obsidian', '.git', '.trash', 'node_modules', 'templates', '_archive', '_attachments']);
const EXCLUDE_PATH = CONFIG.neuronExcludePaths;
const EXCLUDE_NAME = PRIVATE_NAME;
const STALE_DAYS = 14;
const TASTE_MARK = '<!-- AUTO-END · the neuron rewrites everything above; your steers below are preserved -->';

const now = new Date();
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

// ---------- helpers ----------
const stripFm = t => { if (t.startsWith('---')) { const e = t.indexOf('\n---', 3); if (e !== -1) return t.slice(e + 4); } return t; };
const prettify = b => b.replace(/\.md$/i, '').replace(/—/g, '·').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());
const normalizePatternTitle = title => String(title ?? '').normalize('NFKC').toLowerCase()
  .replace(/['’‘`]/gu, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();
const ago = ms => { const s = (Date.now() - ms) / 1000; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd'; };
const callClaude = p => execFileSync(CLAUDE_CMD, ['-p', p], { encoding: 'utf8', maxBuffer: 1 << 24, cwd: '/tmp', timeout: 180000, killSignal: 'SIGKILL' });   // cwd OUTSIDE ~/Desktop so the claude child needs no Full Disk Access (only `node` is granted); 180s cap so a hung claude -p can't freeze the whole launchd run — callers' try/catch degrade gracefully — see scheduled/README.md
function parseJSON(raw) { let s = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, ''); const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a !== -1) s = s.slice(a, b + 1); return JSON.parse(s); }
const logRun = e => fs.appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...e }) + '\n');
function skipped(neuron, reason, extra = {}) {
  const result = { outcome: 'skipped', reason, ...extra };
  try {
    logRun({ neuron, wrote: null, count: 0, skipped: reason, ...result });
  } catch (e) {
    const logReason = `could not log ${neuron} skip: ${String(e).slice(0, 160)}`;
    console.error('  ✗', logReason);
    return { outcome: 'failed', reason: logReason };
  }
  return result;
}
function failed(neuron, reason, extra = {}) {
  const result = { outcome: 'failed', reason, ...extra };
  try { logRun({ neuron, wrote: null, count: 0, ...result }); }
  catch (e) { console.error(`  ✗ could not log ${neuron} failure:`, String(e).slice(0, 160)); }
  return result;
}
// DAILY-cadence freshness gate: ts of the last run that ACTUALLY wrote patterns (0 if none).
// Using the last GENERATION (not the last run) lets a slow trickle accumulate across skipped
// days instead of resetting each day — so the brain still fires when enough has piled up.
function lastGenTs() {
  try {
    const ls = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    for (let i = ls.length - 1; i >= 0; i--) if (ls[i].wrote) return ls[i].ts || 0;
  } catch {}
  return 0;
}
function brainLog(line) { try { fs.appendFileSync(path.join(VAULT, '_brain', 'log.md'), `\n## [${TODAY}] neuron | ${line}\n`); } catch {} }

function walkMd(onFile) {
  (function w(dir) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name); const rel = path.relative(VAULT, full).toLowerCase();
      if (e.isDirectory()) { if (EXCLUDE_DIRS.has(e.name) || EXCLUDE_PATH.some(x => rel === x || rel.startsWith(x + '/'))) continue; w(full); }
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md') && !EXCLUDE_NAME.test(e.name)) onFile(full);
    }
  })(VAULT);
}

function recentNotes(days = 21, max = 28) {
  const cutoff = Date.now() - days * 864e5; const out = [];
  walkMd(full => {
    const rel = path.relative(VAULT, full);
    if (rel.startsWith('_brain/patterns/')) return;          // don't pattern-on our own output
    let st; try { st = fs.statSync(full); } catch { return; }
    if (st.mtimeMs >= cutoff) out.push({ path: full, rel, title: prettify(path.basename(full)), mtime: st.mtimeMs });
  });
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, max).map(n => {
    let body = ''; try { body = stripFm(fs.readFileSync(n.path, 'utf8')); } catch {}
    if (EXCLUDE_NAME.test(body)) body = '';
    n.snippet = body.replace(/\s+/g, ' ').trim().slice(0, 600); return n;
  }).filter(n => n.snippet.length > 40);
}

// external backlinks → which pattern notes did the owner (or other notes) link to?
function externalBacklinkMap() {
  const counts = {};
  walkMd(full => {
    const rel = path.relative(VAULT, full);
    if (rel.startsWith('_brain/patterns/')) return;          // ignore MOC/self links
    if (rel === '_brain/log.md') return;                     // the neuron writes these itself — not genuine interest
    if (rel.startsWith('_claude/')) return;                  // machine-authored zone (learning candidates/review/rejected + Claude memory) — its copies backlink patterns; counting them self-inflates "valued"
    let t = ''; try { t = fs.readFileSync(full, 'utf8'); } catch { return; }
    for (const m of t.matchAll(/\[\[([^\]|#]+)/g)) {
      const base = m[1].split('/').pop().toLowerCase().replace(/\.md$/, '');
      counts[base] = (counts[base] || 0) + 1;
    }
  });
  return counts;
}

// ---------- passive signal reader ----------
function readSignals() {
  const approved = [], rejected = [], valued = [], ignored = [];
  let priorTitles = [];
  // 1. deleted = generated-then-gone (from the log)
  let logged = [];
  try { logged = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
  for (const e of logged) for (const tt of (e.titles || [])) priorTitles.push(tt);
  priorTitles = [...new Set(priorTitles)];
  const existingFiles = fs.existsSync(PATTERNS_DIR) ? fs.readdirSync(PATTERNS_DIR) : [];
  for (const e of logged) {
    if (e.wrote && !fs.existsSync(path.join(VAULT, e.wrote))) for (const tt of (e.titles || [])) rejected.push(tt); // file deleted
  }
  // 2. per-note signals on surviving pattern notes
  const backlinks = externalBacklinkMap();
  for (const f of existingFiles) {
    if (!/patterns\.md$|patterns-\d+\.md$/.test(f)) continue;
    const p = path.join(PATTERNS_DIR, f); let t = '', st;
    try { t = fs.readFileSync(p, 'utf8'); st = fs.statSync(p); } catch { continue; }
    const titles = [...t.matchAll(/^###\s+(?:🎲\s*)?(.+)$/gm)].map(m => m[1].trim());
    priorTitles.push(...titles);
    const fm = (t.match(/^verdict:\s*(\w+)/m) || [])[1] || (/#approved/.test(t) ? 'approved' : /#rejected/.test(t) ? 'rejected' : '');
    const base = f.toLowerCase().replace(/\.md$/, '');
    const linked = (backlinks[base] || 0) > 0;
    const stale = (Date.now() - st.mtimeMs) > STALE_DAYS * 864e5;
    for (const tt of titles) {
      if (fm === 'approved') approved.push(tt);
      else if (fm === 'rejected') rejected.push(tt);
      else if (linked) valued.push(tt);
      else if (stale) ignored.push(tt);
    }
  }
  const uniq = a => [...new Set(a)];
  return { priorTitles: uniq(priorTitles), approved: uniq(approved), rejected: uniq(rejected), valued: uniq(valued), ignored: uniq(ignored) };
}

function readSteers() {
  try {
    const t = fs.readFileSync(TASTE, 'utf8');
    const after = t.split(TASTE_MARK)[1] || '';
    return after.split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('>') && l.length > 3);
  } catch { return []; }
}

function writeTasteProfile(sig, steers) {
  const list = (a, n = 12) => a.length ? a.slice(0, n).map(x => `- ${x}`).join('\n') : '- _(none yet)_';
  const md = `---
type: taste-profile
tags: [neuron, taste, predictive, emerging]
updated: ${TODAY}
---

# 🎯 Neuron Taste Profile

> What the brain has learned about which patterns you value — inferred **passively** from your behavior (links, edits, deletes, explicit verdicts) plus your steers. The Pattern Neuron reads this every run. Part of [[_brain/patterns/Patterns — MOC|Patterns]].

## Learned signals (auto — regenerated each run)

**👍 You VALUE these** (approved, or linked from other notes):
${list([...sig.approved, ...sig.valued])}

**👎 You IGNORE / REJECT these** (deleted, or untouched ${STALE_DAYS}+ days):
${list([...sig.rejected, ...sig.ignored])}

*Signal counts: ${sig.approved.length} approved · ${sig.valued.length} linked · ${sig.rejected.length} rejected · ${sig.ignored.length} ignored.*

${TASTE_MARK}

## ✍️ Your steers (edit freely — the neuron obeys these)

${steers.length ? steers.map(s => `- ${s}`).join('\n') : `- _(none yet — type preferences here, e.g. "less obvious stuff", "more business↔philosophy links", "always tie to a concrete next step")_`}
`;
  fs.writeFileSync(TASTE, md);
}

function updateMOC(noteRel, summary, titles, unit = 'patterns') {
  let head = `---
type: moc
tags: [moc, neuron, patterns, predictive, orb]
updated: ${TODAY}
---

# 🧬 Patterns — MOC

> Sub-orb hub for the **Pattern Neuron's** emergent insights. Every run links here so they cluster as one group. Your 30-second review surface: skim the runs, act on what lands, delete what doesn't (the neuron learns from both). Taste: [[_brain/patterns/Taste Profile]] · Project: ${projectLink('Neurolink Brain')}.

## Runs
`;
  let rows = '';
  try { const ex = fs.readFileSync(MOC, 'utf8'); const i = ex.indexOf('## Runs'); if (i !== -1) rows = ex.slice(i + 7).trim(); } catch {}
  const linkName = path.basename(noteRel).replace(/\.md$/, '');
  const newRow = `- **${TODAY}** — [[${noteRel.replace(/\.md$/, '')}|${linkName}]] · ${titles.length} ${unit} · _${(summary || '').slice(0, 120)}_`;
  fs.writeFileSync(MOC, head + '\n' + newRow + (rows ? '\n' + rows : '') + '\n');
}

function nextFreePath() {
  let p = path.join(PATTERNS_DIR, `${TODAY}-patterns.md`); let n = 2;
  while (fs.existsSync(p)) { p = path.join(PATTERNS_DIR, `${TODAY}-patterns-${n}.md`); n++; }
  return p;
}
function linkFor(title, notes) {
  const resolved = resolveNotePath(title, notes, VAULT);
  return resolved.ok ? evidenceLink({ evidenceRel: resolved.rel, evidenceTitle: resolved.title }) : `**${title}**`;
}

// ---------- #1: RAG-scored context (recency + importance + relevance) ----------
async function ragSearch(query, k = 24) {
  try {
    const r = await fetch(`${RAG}/search?q=${encodeURIComponent(query)}&k=${k}`);
    if (!r.ok) throw new Error('status ' + r.status);
    const d = await r.json();
    return (d.hits || []).map(h => ({ rel: h.file, title: h.title, region: h.region, mtime: h.mtime, snippet: h.snippet, relevance: h.score || 0 }));
  } catch { return null; }   // RAG offline → caller falls back to recency-only
}
async function rateImportance(cands) {
  // one batched claude -p call → importance 1..10 per note (Generative Agents "importance" signal)
  const list = cands.map((c, i) => `${i + 1}. ${c.title} :: ${(c.snippet || '').slice(0, 110).replace(/\s+/g, ' ')}`).join('\n');
  const prompt = `Rate how IMPORTANT/poignant each note is to ${OWNER}'s evolving knowledge & identity on a 1-10 scale (1 = trivial/ephemeral chatter, 10 = core/defining/decision-grade). Return ONLY JSON: {"ratings":[{"n":1,"score":7}, ...]} keyed to the numbers below.\n\n${list}`;
  try {
    const res = parseJSON(callClaude(prompt));
    const map = {};
    for (const r of (res.ratings || [])) { const c = cands[(+r.n) - 1]; if (c) map[c.rel] = Math.max(1, Math.min(10, +r.score || 5)); }
    return map;
  } catch { return null; }
}
// merge RAG hits + recent notes → score by recency+importance+relevance → top-K
async function gatherContext(recent, steers) {
  const query = recent.slice(0, 8).map(n => n.title).join(', ') + (steers.length ? ' · ' + steers.join(' · ') : '');
  const hits = await ragSearch(query, 24);
  if (!hits) {
    const scored = recent.map(n => ({ rel: n.rel, title: n.title, region: n.rel.split('/')[0], mtime: n.mtime, snippet: n.snippet }));
    return { scored, mode: 'recency-only (RAG offline — run rag-server.mjs)' };
  }
  const filtered = hits.filter(h => !h.rel.startsWith('_brain/patterns/'));  // self-read guard is now ENFORCED server-side in rag-server.mjs /search (self-read-safe by default); this stays as harmless defense-in-depth
  const byRel = {};
  for (const h of filtered) byRel[h.rel] = { ...h };
  for (const n of recent) {
    if (!byRel[n.rel]) byRel[n.rel] = { rel: n.rel, title: n.title, region: n.rel.split('/')[0], mtime: n.mtime, snippet: n.snippet, relevance: 0.4 };
    else if (!byRel[n.rel].snippet) byRel[n.rel].snippet = n.snippet;
  }
  const cands = Object.values(byRel).filter(c => c.snippet && c.snippet.length > 30);
  const imp = await rateImportance(cands);
  const maxRel = Math.max(0.01, ...cands.map(c => c.relevance || 0));
  const NOW = Date.now();
  for (const c of cands) {
    c.recencyN = Math.exp(-((NOW - (c.mtime || NOW)) / 864e5) / 30);   // ~30-day decay
    c.relevanceN = (c.relevance || 0) / maxRel;
    c.importanceN = imp ? (imp[c.rel] || 5) / 10 : 0.5;
    c.score = 0.35 * c.recencyN + 0.40 * c.relevanceN + 0.25 * c.importanceN;
  }
  cands.sort((a, b) => b.score - a.score);
  return { scored: cands.slice(0, 22), mode: `RAG · recency+importance+relevance (${imp ? 'LLM-rated importance' : 'flat importance'})` };
}

// ---------- PATTERN NEURON ----------
async function patternNeuron(opts = {}) {
  console.log('🧠 pattern neuron');
  const notes = recentNotes();
  if (!notes.length) { console.log('  no recent notes; skipping.'); return skipped('pattern', 'no recent notes'); }
  // Freshness gate (daily cadence): only (re)generate when enough has changed since the last
  // actual generation, so quiet days stay silent — no barrel-scraping, no taste-signal pollution.
  // The self-test still runs every day. Tune MIN_FRESH if it feels too eager / too quiet.
  const MIN_FRESH = 6;                       // was 3 — raise the bar so quiet stretches stay silent
  // 2026-08-12: 20h -> 6h at the owner's request (think more often).
  // Measured first: over the prior 30 days this gate blocked 10 of 36 runs (28%) while only 7
  // runs wrote anything. 6h caps generation at 4/day — still under the 6-12/day that historically
  // drove the paraphrase-rejects, and MIN_FRESH below is the real brake on quiet days (it needs 6
  // changed notes regardless of elapsed time), so this does NOT make it fire on a dead vault.
  // Keep in sync with FLOOR_SECONDS in the vault's .git/hooks/post-commit — that hook deliberately
  // mirrors this value so the trigger can never outpace the neuron's own cooldown.
  const MIN_INTERVAL_MS = 6 * 3600e3;        // was 20h; over-firing (6-12/day) was the #1 driver of paraphrase-rejects
  const since = lastGenTs();
  const freshCount = notes.filter(n => n.mtime > since).length;
  if (!opts.force && since && (Date.now() - since) < MIN_INTERVAL_MS) {
    console.log(`  last generated run was ${ago(since)} ago (<20h) — skipping to avoid over-firing; self-test still runs.`);
    return skipped('pattern', 'too-soon (<20h)');
  }
  if (!opts.force && since && freshCount < MIN_FRESH) {
    console.log(`  only ${freshCount} new/changed note(s) since last patterns (need ${MIN_FRESH}) — skipping generation; self-test still runs.`);
    return skipped('pattern', `thin (${freshCount} fresh)`, { freshCount });
  }
  console.log(`  ${freshCount} new/changed note(s) since last patterns — generating.`);
  const sig = readSignals();
  const steers = readSteers();
  writeTasteProfile(sig, steers);
  console.log(`  recent:${notes.length}  prior:${sig.priorTitles.length}  signals(👍${sig.approved.length + sig.valued.length}/👎${sig.rejected.length + sig.ignored.length})  steers:${steers.length}`);

  const tasteBlock =
`${sig.approved.length || sig.valued.length ? `Patterns ${OWNER} VALUED (make more like these):\n- ${[...sig.approved, ...sig.valued].slice(0, 12).join('\n- ')}\n` : ''}` +
`${sig.rejected.length || sig.ignored.length ? `Patterns ${OWNER} IGNORED/REJECTED (avoid this style):\n- ${[...sig.rejected, ...sig.ignored].slice(0, 12).join('\n- ')}\n` : ''}` +
`${steers.length ? `${OWNER}'s explicit steers (OBEY these):\n- ${steers.join('\n- ')}\n` : ''}`;

  const { scored, mode } = await gatherContext(notes, steers);
  console.log(`  context: ${scored.length} notes via ${mode}`);
  const context = scored.map(n => `## ${n.title}  (${(n.region || n.rel.split('/')[0])} · ${ago(n.mtime)} ago)\n${n.snippet}`).join('\n\n');
  const prompt =
`You are the PATTERN NEURON of ${OWNER}'s second brain — a recurring agent that finds emerging themes across their knowledge so it compounds and adapts to their taste.

Find NON-OBVIOUS patterns across the retrieved notes below — selected by relevance + recency + importance, so they span new AND old material. Each pattern MUST bridge two genuinely DISTANT domains, coin a sharp compressed handle, name a specific system or dollar consequence, and cite >=2 of the EXACT retrieved note titles below as evidence — or discard it.

FIRST-OF-KIND ONLY. Return AT MOST 3 patterns, and return FEWER — even ZERO ({"patterns":[]}) — rather than padding. An empty run is the CORRECT, valued output when nothing is genuinely new this run. Restating a claim already made in a prior run with fresh wording is the #1 thing ${OWNER} rejects: dedup on the CLAIM, not the title.

${sig.priorTitles.length ? `Already found in prior runs — do NOT repeat these, and do NOT restate their underlying CLAIM in new words (dedup on the claim, not the title):\n- ${sig.priorTitles.slice(0, 50).join('\n- ')}\n` : ''}
${tasteBlock ? `\nWHAT ${OWNER_UP} VALUES (learned from their behavior — bias toward this, but do NOT become a yes-man):\n${tasteBlock}` : ''}
You MAY include AT MOST ONE "wildcard" — a contrarian/left-field observation that ignores their learned preferences (set "wildcard": true) — but ONLY if it clears the same first-of-kind bar above. Do NOT force one; omit it when nothing wild is genuinely worth saying.

Return ONLY valid JSON (no prose, no fences):
{"patterns":[{"title":"short title","insight":"2-3 sentences","evidence":["exact Note Title","exact Note Title"],"why_it_matters":"1 sentence","suggested_action":"1 concrete step","wildcard":false}],"summary":"1 sentence on this run's theme"}

${opts.scope ? `THIS RUN WAS TRIGGERED BY A SPECIFIC EVENT — focus your analysis on what it implies, not a blind sweep:\n${opts.scope}\n\n` : ''}RETRIEVED NOTES:
${context}`;

  console.log('  reasoning via claude -p …');
  let res; try { res = parseJSON(callClaude(prompt)); } catch (e) {
    const reason = `claude/parse failed: ${String(e).slice(0, 200)}`;
    console.error('  ✗', reason);
    return failed('pattern', reason);
  }
  const proposed = (res.patterns || []).slice(0, 3);   // hard cap — fewer-but-sharper beats padded paraphrase
  if (!proposed.length) { console.log('  no new patterns (thin material) — nothing written.'); return skipped('pattern', 'no new patterns (thin material)'); }

  const seenTitles = new Set(sig.priorTitles.map(normalizePatternTitle).filter(Boolean));
  const pats = [];
  let duplicateCount = 0;
  for (const pattern of proposed) {
    const normalizedTitle = normalizePatternTitle(pattern.title);
    if (normalizedTitle && seenTitles.has(normalizedTitle)) {
      duplicateCount++;
      continue;
    }
    if (normalizedTitle) seenTitles.add(normalizedTitle);
    pats.push(pattern);
  }
  if (duplicateCount) console.log(`  rejected ${duplicateCount} duplicate pattern title(s) before write.`);
  if (!pats.length) {
    console.log('  all proposed pattern titles duplicate prior patterns — nothing written.');
    return skipped('pattern', 'all proposed pattern titles duplicate prior patterns', { duplicateCount });
  }

  fs.mkdirSync(PATTERNS_DIR, { recursive: true });
  const file = nextFreePath();
  let md = `---\ntype: pattern\ntags: [pattern, neuron, predictive, emerging]\ncreated: ${TODAY}\nsource: pattern-neuron\nverdict: \n---\n\n# Pattern Neuron — ${TODAY}\n\n> 🌱 ${res.summary || ''}\n> _Review: set \`verdict: approved\` / \`verdict: rejected\` in frontmatter, or just delete this note — the neuron learns either way._\n\n## Patterns\n`;
  for (const p of pats) {
    const ev = (p.evidence || []).map(t => linkFor(t, scored)).join(' · ');
    md += `\n### ${p.wildcard ? '🎲 ' : ''}${p.title}\n- **Insight:** ${p.insight}\n- **Evidence:** ${ev || '—'}\n- **Why it matters:** ${p.why_it_matters || '—'}\n- **Suggested action:** ${p.suggested_action || '—'}${p.wildcard ? '\n- _(wildcard — deliberately against your usual taste)_' : ''}\n`;
  }
  md += `\n## Grouping\n[[_brain/patterns/Patterns — MOC|Patterns]] · [[_brain/patterns/Taste Profile]]\n\n---\n*Neuron run ${TODAY} · ${scored.length} notes retrieved via ${mode} · ${PROJECT_LINK}*\n`;
  fs.writeFileSync(file, md);

  // Write candidate to the learning gate for review (additive — wrapped so a failure here
  // can NEVER crash the pattern write/MOC/log flow above & below).
  try {
    const candidateDir = path.join(VAULT, '_claude', 'learning', 'candidates');
    fs.mkdirSync(candidateDir, { recursive: true });
    const slug = path.basename(file).replace(/\.md$/i, '');
    const evidenceLink = path.relative(VAULT, file).replace(/\.md$/i, '');
    const candidateFrontmatter = `---
type: candidate
submitted_by: pattern-neuron
submitted: ${TODAY}
category: pattern
confidence: high
evidence:
  - "[[${evidenceLink}]]"
action_proposed: >
  Promote this pattern to active memory and incorporate into Hermes behavior.
---

`;
    const candidatePath = path.join(candidateDir, `${slug}.md`);
    fs.writeFileSync(candidatePath, candidateFrontmatter + md, 'utf8');
    console.log(`  ✓ candidate → ${path.relative(VAULT, candidatePath)}`);
  } catch (e) {
    console.error('  ⚠ candidate write failed (pattern still saved):', String(e).slice(0, 200));
  }

  const rel = path.relative(VAULT, file);
  updateMOC(rel, res.summary, pats.map(p => p.title));
  logRun({ neuron: 'pattern', outcome: 'wrote', outputPath: rel, wrote: rel, count: pats.length, duplicateCount, titles: pats.map(p => p.title), wildcard: pats.find(p => p.wildcard)?.title || null });
  brainLog(`pattern neuron: ${pats.length} patterns → [[${rel.replace(/\.md$/, '')}]] (taste 👍${sig.approved.length + sig.valued.length}/👎${sig.rejected.length + sig.ignored.length})`);
  console.log(`  ✓ wrote ${pats.length} patterns → ${rel}`);
  for (const p of pats) console.log(`     ${p.wildcard ? '🎲' : '•'} ${p.title}`);
  console.log(`  ✓ grouped into Patterns — MOC · taste profile refreshed`);
  return { outcome: 'wrote', outputPath: rel, count: pats.length, duplicateCount };
}

// ---------- SELF-TEST (immune system + grounded strength gauge) ----------
// Deterministic health checks + a hit-rate grounded in the owner's behavior.
// NO self-grading (model never judges its own quality), NO code self-modification.
// Self-heal = FLAG only (operational fixes are suggested, never auto-applied).
async function selftest(opts = {}) {
  // The neuron may be invoked every couple hours; run the health HEARTBEAT at most ~once/day
  // (explicit `selftest` arg forces it). Keeps _brain/log.md + selftest-log from getting spammy.
  if (!opts.force) {
    try {
      const ls = fs.readFileSync(path.join(HOME, 'selftest-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
      const lastTs = ls.length ? (JSON.parse(ls[ls.length - 1]).ts || 0) : 0;
      if (lastTs && (Date.now() - lastTs) < 20 * 3600 * 1000) { console.log('🩺 self-test skipped (ran <20h ago)'); return; }
    } catch {}
  }
  console.log('🩺 neuron self-test');
  const checks = [], flags = [];
  const ok = (name, pass, detail) => checks.push({ name, pass, detail: detail || '' });

  // newest CONTENT note (exclude the neuron's own output) — for freshness checks
  let newest = 0;
  walkMd(f => { const rel = path.relative(VAULT, f); if (rel.startsWith('_brain/patterns/') || rel === '_brain/log.md') return; try { const m = fs.statSync(f).mtimeMs; if (m > newest) newest = m; } catch {} });

  // 1. claude CLI present
  let claudeOk = false; try { execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' }); claudeOk = true; } catch {}
  ok('claude CLI available', claudeOk);
  if (!claudeOk) flags.push('claude CLI not found → neuron cannot reason (install/login claude)');

  // 2. RAG server reachable
  let ragOk = false, ragInfo = '';
  try { const r = await fetch(`${RAG}/health`); if (r.ok) { const d = await r.json(); ragOk = true; ragInfo = `${d.chunks} chunks`; } } catch {}
  ok('RAG server reachable', ragOk, ragInfo);
  if (!ragOk) flags.push('RAG server down → neuron falls back to recency-only (start: node rag-server.mjs)');

  // 3. RAG index freshness (vs newest content note)
  let idxFresh = true, idxDetail = '';
  try { const im = fs.statSync(path.join(HOME, 'rag-index.json')).mtimeMs; idxFresh = im >= newest; idxDetail = idxFresh ? 'up to date' : `stale by ~${Math.round((newest - im) / 36e5)}h`; }
  catch { idxFresh = false; idxDetail = 'no index file'; }
  ok('RAG index fresh', idxFresh, idxDetail);
  if (!idxFresh) flags.push('RAG index stale → rebuild: node rag-index.mjs');

  // 4. cockpit data freshness
  let vdFresh = true, vdDetail = '';
  try { const vm = fs.statSync(path.join(HOME, 'vault-data.js')).mtimeMs; vdFresh = vm >= newest; vdDetail = vdFresh ? 'up to date' : `stale by ~${Math.round((newest - vm) / 36e5)}h`; }
  catch { vdFresh = false; vdDetail = 'missing'; }
  ok('cockpit data fresh', vdFresh, vdDetail);
  if (!vdFresh) flags.push('vault-data.js stale → refresh: node gen-vault-data.js');

  // build a resolver of existing vault notes (rel + basename, lowercased)
  const existRel = new Set(), existBase = new Set();
  walkMd(f => { const rel = path.relative(VAULT, f).replace(/\.md$/i, ''); existRel.add(rel.toLowerCase()); existBase.add(path.basename(rel).toLowerCase()); });

  // 5. pattern-note integrity + dead-link check
  const files = fs.existsSync(PATTERNS_DIR) ? fs.readdirSync(PATTERNS_DIR).filter(f => /patterns(-\d+)?\.md$/.test(f)) : [];
  let totalPatterns = 0, deadLinks = 0, withWildcard = 0; const allTitles = [];
  for (const f of files) {
    let t = ''; try { t = fs.readFileSync(path.join(PATTERNS_DIR, f), 'utf8'); } catch { continue; }
    const titles = [...t.matchAll(/^###\s+(?:🎲\s*)?(.+)$/gm)].map(m => m[1].trim());
    totalPatterns += titles.length; allTitles.push(...titles);
    if (/🎲/.test(t)) withWildcard++;
    for (const m of t.matchAll(/\[\[([^\]|#]+)/g)) {
      const raw = m[1].trim(); const tgt = raw.toLowerCase().replace(/\.md$/, '');
      // ponytail: also accept on-disk hits so valid links into _archive/_attachments (excluded from the health walk) don't false-flag
      if (!existRel.has(tgt) && !existBase.has(tgt.split('/').pop()) && !fs.existsSync(path.join(VAULT, raw.replace(/\.md$/i, '') + '.md'))) deadLinks++;
    }
  }
  ok('pattern notes present', files.length > 0, `${files.length} notes · ${totalPatterns} patterns`);
  ok('evidence links resolve', deadLinks === 0, deadLinks === 0 ? 'all resolve' : `${deadLinks} dead`);
  if (deadLinks > 0) flags.push(`${deadLinks} dead wikilink(s) in pattern notes → review (NOT auto-edited)`);
  ok('wildcard present', files.length === 0 || withWildcard > 0, `${withWildcard}/${files.length} notes`);

  // 6. dedup integrity
  const dup = allTitles.filter((t, i) => allTitles.indexOf(t) !== i);
  ok('no repeated pattern titles', dup.length === 0, dup.length ? `${dup.length} repeat(s)` : 'unique');
  if (dup.length) flags.push(`${dup.length} repeated pattern title(s) → dedup may be slipping`);

  // 7. taste profile + steers preserved
  let tasteOk = false, steerN = 0;
  try { const tt = fs.readFileSync(TASTE, 'utf8'); tasteOk = tt.includes(TASTE_MARK); steerN = readSteers().length; } catch {}
  ok('taste profile intact', tasteOk, `${steerN} steer(s)`);
  if (!tasteOk) flags.push('Taste Profile missing its steers marker → may have been clobbered');

  // 8. MOC + log integrity
  let mocOk = false; try { mocOk = fs.readFileSync(MOC, 'utf8').includes('## Runs'); } catch {}
  ok('Patterns MOC intact', mocOk);
  let logOk = true, logN = 0;
  try { const ls = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean); logN = ls.length; ls.forEach(l => JSON.parse(l)); } catch { logOk = false; }
  ok('neuron-log valid', logOk, `${logN} runs`);

  // ---- grounded hit-rate (the owner's behavior, not self-opinion) ----
  const sig = readSignals();
  const pos = sig.approved.length + sig.valued.length, neg = sig.rejected.length + sig.ignored.length, graded = pos + neg;
  const hitRate = graded ? Math.round(pos / graded * 100) : null;

  // trend log + read history
  const snap = { ts: Date.now(), date: TODAY, passed: checks.filter(c => c.pass).length, total: checks.length, deadLinks, totalPatterns, pos, neg, hitRate };
  try { fs.appendFileSync(path.join(HOME, 'selftest-log.jsonl'), JSON.stringify(snap) + '\n'); } catch {}
  let prior = []; try { prior = fs.readFileSync(path.join(HOME, 'selftest-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}

  // ---- write scorecard note ----
  const passN = checks.filter(c => c.pass).length, healthPct = Math.round(passN / checks.length * 100);
  const L = [];
  L.push('---', 'type: self-test', 'tags: [neuron, self-test, predictive, health]', `updated: ${TODAY}`, '---', '',
    '# 🩺 Neuron Self-Test', '',
    "> The brain's **immune system + strength gauge** — deterministic health checks plus a *grounded* hit-rate (based on YOUR behavior, never the model's self-opinion). Re-run: `node neurons/run-neuron.mjs selftest`. Part of [[_brain/patterns/Patterns — MOC|Patterns]].", '',
    `**Health: ${healthPct}% — ${passN}/${checks.length} checks pass** · ${TODAY}`, '',
    '## Checks', '| Check | Status | Detail |', '|---|---|---|');
  for (const c of checks) L.push(`| ${c.name} | ${c.pass ? '✅' : '❌'} | ${c.detail} |`);
  L.push('', '## Strength — grounded hit-rate');
  if (hitRate === null) L.push("- _Cold start — hit-rate appears once you've linked/acted-on (👍) or deleted/ignored (👎) some patterns._", `- Patterns generated to date: **${totalPatterns}**`);
  else L.push(`- **Hit-rate: ${hitRate}%** — ${pos} valued · ${neg} rejected/ignored (of ${graded} graded)`, `- Patterns generated to date: **${totalPatterns}**`);
  const tr = prior.filter(p => p.hitRate != null).slice(-6).map(p => p.hitRate + '%').join(' → ');
  if (tr) L.push(`- Hit-rate trend: ${tr}`);
  if (flags.length) { L.push('', '## ⚠️ Flags — review (never auto-fixed)'); for (const f of flags) L.push(`- ${f}`); }
  else L.push('', '## ✅ No flags — brain healthy.');
  L.push('', '---', `*Self-test ${TODAY} · ${passN}/${checks.length} pass · grounded hit-rate · ${PROJECT_LINK}*`, '');
  fs.mkdirSync(PATTERNS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PATTERNS_DIR, 'Self-Test.md'), L.join('\n'));

  // console
  console.log(`  health: ${healthPct}% (${passN}/${checks.length})`);
  for (const c of checks) console.log(`     ${c.pass ? '✅' : '❌'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
  console.log(`  strength: ${hitRate === null ? 'cold start (no signal yet)' : hitRate + '% hit-rate'} · ${totalPatterns} patterns to date`);
  if (flags.length) { console.log('  ⚠️ flags (review, not auto-fixed):'); for (const f of flags) console.log('     - ' + f); }
  console.log('  ✓ wrote Self-Test.md');
  brainLog(`self-test: ${healthPct}% health · ${flags.length} flag(s) · hit-rate ${hitRate === null ? 'n/a' : hitRate + '%'}`);
}

// ---------- LINK NEURON (proposes missing wikilinks — the "red strings") ----------
const norm = s => s.split('/').pop().toLowerCase().replace(/\.md$/, '').replace(/[—_-]+/g, ' ').replace(/\s+/g, ' ').trim();

function buildLinkGraph() {                   // set of "normA|normB" (sorted) = an existing wikilink pair
  const linked = new Set();
  walkMd(full => {
    const nA = norm(path.basename(full));
    let t = ''; try { t = fs.readFileSync(full, 'utf8'); } catch { return; }
    for (const m of t.matchAll(/\[\[([^\]|#]+)/g)) { const nT = norm(m[1]); if (nT && nT !== nA) linked.add([nA, nT].sort().join('|')); }
  });
  return linked;
}
function priorProposedPairs() {               // don't re-propose pairs we already suggested
  const set = new Set();
  const files = fs.existsSync(PATTERNS_DIR) ? fs.readdirSync(PATTERNS_DIR).filter(f => /links(-\d+)?\.md$/.test(f)) : [];
  for (const f of files) {
    let t = ''; try { t = fs.readFileSync(path.join(PATTERNS_DIR, f), 'utf8'); } catch { continue; }
    for (const m of t.matchAll(/^###\s+\[\[([^\]|#]+)\]\][^\n\[]*\[\[([^\]|#]+)\]\]/gm)) set.add([norm(m[1]), norm(m[2])].sort().join('|'));
  }
  return set;
}

async function linkNeuron(opts = {}) {
  console.log('🔗 link neuron');
  if (!opts.force) {                          // weekly-ish (the every-2h `all` would otherwise spam it)
    try {
      const ls = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      let last = 0; for (let i = ls.length - 1; i >= 0; i--) if (ls[i].neuron === 'link' && ls[i].reason !== 'ran <7d ago') { last = ls[i].ts || 0; break; }
      if (last && (Date.now() - last) < 7 * 864e5) { console.log('  skipped (ran <7d ago)'); return skipped('link', 'ran <7d ago'); }
    } catch {}
  }
  const focus = recentNotes(21, 18);
  if (!focus.length) { console.log('  no recent notes; skipping.'); return skipped('link', 'no recent notes'); }
  const linked = buildLinkGraph(), already = priorProposedPairs();
  const cand = new Map();
  for (const f of focus) {
    const nF = norm(path.basename(f.rel));
    const hits = await ragSearch(`${f.title}. ${f.snippet}`, 8);
    if (!hits) { console.log('  RAG offline — skipping link run (start rag-server.mjs).'); return skipped('link', 'RAG offline'); }
    for (const h of hits) {
      if (h.rel.startsWith('_brain/patterns/')) continue;       // never propose links to neuron output
      const nH = norm(path.basename(h.rel));
      if (!nH || nH === nF || (h.relevance || 0) < 0.3) continue;
      const key = [nF, nH].sort().join('|');
      if (linked.has(key) || already.has(key)) continue;
      const prev = cand.get(key);
      if (!prev || (h.relevance || 0) > prev.score)
        cand.set(key, { a: { title: f.title, rel: f.rel, snippet: f.snippet }, b: { title: h.title, rel: h.rel, snippet: h.snippet }, score: h.relevance || 0 });
    }
  }
  const pairs = [...cand.values()].sort((x, y) => y.score - x.score).slice(0, 24);
  if (!pairs.length) { console.log('  no new unlinked neighbors — nothing to propose.'); return skipped('link', 'no new unlinked neighbors'); }
  console.log(`  ${pairs.length} candidate link(s) — vetting via claude -p …`);

  const list = pairs.map((p, i) => `${i + 1}. "${p.a.title}" <> "${p.b.title}"\n   A: ${(p.a.snippet || '').slice(0, 150).replace(/\s+/g, ' ')}\n   B: ${(p.b.snippet || '').slice(0, 150).replace(/\s+/g, ' ')}`).join('\n');
  const prompt = `You connect notes in ${OWNER}'s second brain. Below are pairs of notes that are semantically similar but NOT yet wikilinked. For each, decide if a wikilink would genuinely help — they share a real concept, person, decision, or thread, not just surface words. Be selective; skip noise. Return ONLY JSON: {"links":[{"n":1,"useful":true,"reason":"<=12 words why"}]}\n\n${opts.scope ? `Triggering event for this run (favor links that relate to it):\n${opts.scope}\n\n` : ''}${list}`;
  let vet; try { vet = parseJSON(callClaude(prompt)); } catch (e) {
    const reason = `claude/parse failed: ${String(e).slice(0, 150)}`;
    console.error('  ✗', reason);
    return failed('link', reason);
  }
  const verdict = {}; if (vet) for (const v of (vet.links || [])) verdict[+v.n] = v;
  const approved = pairs.map((p, i) => ({ ...p, v: verdict[i + 1] })).filter(p => p.v && p.v.useful);
  if (!approved.length) { console.log('  claude vetted all candidates as weak — nothing proposed.'); return skipped('link', 'all candidates vetted as weak'); }

  fs.mkdirSync(PATTERNS_DIR, { recursive: true });
  let file = path.join(PATTERNS_DIR, `${TODAY}-links.md`), k = 2;
  while (fs.existsSync(file)) { file = path.join(PATTERNS_DIR, `${TODAY}-links-${k}.md`); k++; }
  let md = `---\ntype: link-proposals\ntags: [link, neuron, predictive, emerging]\ncreated: ${TODAY}\nsource: link-neuron\n---\n\n# 🔗 Link Neuron — ${TODAY}\n\n> Notes that are related but **not yet wikilinked**. Nothing is auto-applied — the neuron only proposes; add the ones that land. Part of [[_brain/patterns/Patterns — MOC|Patterns]].\n\n## Proposed connections (${approved.length})\n`;
  for (const p of approved) {
    const a = p.a.rel.replace(/\.md$/i, ''), b = p.b.rel.replace(/\.md$/i, '');
    md += `\n### [[${a}|${p.a.title}]] ⇄ [[${b}|${p.b.title}]]\n- **Why:** ${p.v?.reason || 'strong semantic overlap (unvetted)'}\n- **Add to [[${a}|${p.a.title}]]:** \`[[${b}|${p.b.title}]]\`\n`;
  }
  md += `\n## Grouping\n[[_brain/patterns/Patterns — MOC|Patterns]]\n\n---\n*Link neuron ${TODAY} · ${approved.length} proposed · never auto-applied · ${PROJECT_LINK}*\n`;
  fs.writeFileSync(file, md);
  const rel = path.relative(VAULT, file);
  updateMOC(rel, `${approved.length} proposed wikilinks`, approved, 'proposed links');
  logRun({ neuron: 'link', outcome: 'wrote', outputPath: rel, wrote: rel, count: approved.length });
  brainLog(`link neuron: ${approved.length} proposed links → [[${rel.replace(/\.md$/, '')}]]`);
  console.log(`  ✓ wrote ${approved.length} proposed links → ${rel}`);
  for (const p of approved) console.log(`     • ${p.a.title} ⇄ ${p.b.title}`);
  return { outcome: 'wrote', outputPath: rel, count: approved.length };
}

// ---------- MEMORY NEURON (episodic→semantic rollup — "what happened, decided, changed, learned") ----------
function lastMemoryTs() {
  try {
    const ls = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    for (let i = ls.length - 1; i >= 0; i--) if (ls[i].neuron === 'memory' && ls[i].wrote) return ls[i].ts || 0;
  } catch {}
  return 0;
}

async function memoryNeuron(opts = {}) {
  console.log('💾 memory neuron');
  // 7-day self-guard (like link neuron)
  if (!opts.force) {
    try {
      const ls = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      let last = 0; for (let i = ls.length - 1; i >= 0; i--) if (ls[i].neuron === 'memory' && ls[i].reason !== 'ran <7d ago') { last = ls[i].ts || 0; break; }
      if (last && (Date.now() - last) < 7 * 864e5) { console.log('  skipped (ran <7d ago)'); return skipped('memory', 'ran <7d ago'); }
    } catch {}
  }

  // Gather episodic material: recent notes (7d), excluding patterns, _claude (machine-authored), and Log.md
  const cutoff = Date.now() - 7 * 864e5;
  const episodic = [];
  walkMd(full => {
    const rel = path.relative(VAULT, full);
    if (rel.startsWith('_brain/patterns/')) return;
    if (rel.startsWith('_claude/')) return;           // machine-authored zone — not real episodic experience
    if (rel === 'Log.md') return;
    let st; try { st = fs.statSync(full); } catch { return; }
    if (st.mtimeMs < cutoff) return;
    let body = ''; try { body = stripFm(fs.readFileSync(full, 'utf8')); } catch {}
    if (EXCLUDE_NAME.test(body)) return;
    const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 800);
    if (snippet.length < 50) return;
    episodic.push({ path: full, rel, title: prettify(path.basename(full)), mtime: st.mtimeMs, snippet });
  });
  episodic.sort((a, b) => b.mtime - a.mtime);
  if (!episodic.length) { console.log('  no recent episodic notes; skipping.'); return skipped('memory', 'no recent episodic notes'); }

  // Freshness gate: need >=5 changed notes since last consolidation
  const since = lastMemoryTs();
  const freshCount = since ? episodic.filter(n => n.mtime > since).length : episodic.length;
  if (!opts.force && since && freshCount < 5) {
    console.log(`  only ${freshCount} new note(s) since last consolidation (need 5) — skipping.`);
    return skipped('memory', `thin (${freshCount} fresh)`, { freshCount });
  }
  console.log(`  ${freshCount} episodic note(s) — consolidating.`);

  // RAG for related older context (what has the owner already captured about these topics?)
  const query = episodic.slice(0, 8).map(n => n.title).join(', ');
  const hits = await ragSearch(query, 16);
  const olderContext = hits ? hits.filter(h => !h.rel.startsWith('_brain/patterns/')).slice(0, 8).map(h => `- ${h.title}: ${(h.snippet || '').slice(0, 120)}`).join('\n') : '(RAG offline)';

  const sourceNotes = episodic.slice(0, 20);
  const episodeBlock = sourceNotes.map(n => `## ${n.title}  (${ago(n.mtime)} ago)\nCanonical source path: ${n.rel}\n${n.snippet}`).join('\n\n');

  const prompt = `You are the MEMORY NEURON of ${OWNER}'s second brain. Your job is NOT to find patterns (that's the Pattern Neuron). Your job is to CONSOLIDATE — produce a factual, durable record of what happened this week so future sessions and agents can catch up quickly.

Based on the episodic notes below, write a CONSOLIDATION that captures:
1. KEY DECISIONS — what ${OWNER} decided (with evidence)
2. WHAT CHANGED — code deployed, systems built, vault restructured, new artifacts
3. WHAT WAS LEARNED — insights, gotchas, corrections, things that surprised them
4. OPEN THREADS — things started but not finished, things waiting on ${OWNER}

Be FACTUAL and SPECIFIC. No interpretation, no "patterns," no psychology. Just what happened. Each bullet must cite one EPISODIC NOTE using its exact canonical source path shown below. Never invent, shorten, or guess a path. If the episodic notes are thin on a category, omit it rather than padding.

Return ONLY valid JSON (no prose, no fences):
{"decisions":[{"item":"1 sentence","evidence":"canonical/source/path.md"}],"changes":[{"item":"1 sentence","evidence":"canonical/source/path.md"}],"learned":[{"item":"1 sentence","evidence":"canonical/source/path.md"}],"open_threads":[{"item":"1 sentence","evidence":"canonical/source/path.md"}],"summary":"1 sentence on what this week was about"}

RELATED OLDER CONTEXT (for reference — don't repeat, just use to avoid re-stating known facts):
${olderContext}

${opts.scope ? `THIS RUN WAS TRIGGERED BY A SPECIFIC EVENT — weight the consolidation toward it:\n${opts.scope}\n\n` : ''}EPISODIC NOTES (last 7 days):
${episodeBlock}`;

  console.log('  reasoning via claude -p …');
  let res; try { res = parseJSON(callClaude(prompt)); } catch (e) {
    const reason = `claude/parse failed: ${String(e).slice(0, 200)}`;
    console.error('  ✗', reason);
    return failed('memory', reason);
  }

  const validated = validateMemoryConsolidation(res, sourceNotes, VAULT);
  for (const rejected of validated.rejected) {
    const where = `${rejected.section}${rejected.index == null ? '' : `[${rejected.index}]`}`;
    const candidates = rejected.candidates?.length ? `; candidates: ${rejected.candidates.join(', ')}` : '';
    console.warn(`  ⚠ rejected ${where}: ${rejected.reason}${candidates}`);
  }
  const { decisions, changes, learned, open_threads: openThreads } = validated.sections;
  const allItems = [...decisions, ...changes, ...learned, ...openThreads];
  if (!allItems.length) {
    console.log(`  no valid consolidated items (${validated.rejected.length} rejected) — nothing written.`);
    return skipped('memory', 'no valid grounded items', { rejected: validated.rejected.length });
  }

  fs.mkdirSync(PATTERNS_DIR, { recursive: true });
  let file = path.join(PATTERNS_DIR, `${TODAY}-consolidation.md`), k = 2;
  while (fs.existsSync(file)) { file = path.join(PATTERNS_DIR, `${TODAY}-consolidation-${k}.md`); k++; }

  const section = (title, items) => items.length ? `\n## ${title}\n${items.map(i => `- ${i.item} — ${evidenceLink(i)}`).join('\n')}` : '';
  const md = `---
type: consolidation
tags: [consolidation, neuron, memory, predictive]
created: ${TODAY}
source: memory-neuron
---

# 💾 Memory Consolidation — ${TODAY}

> ${validated.summary || 'Weekly consolidation of episodic notes into permanent memory.'}
> Part of [[_brain/patterns/Patterns — MOC|Patterns]]. Auto-generated — review and delete stale items.

${section('Key Decisions', decisions)}
${section('What Changed', changes)}
${section('What Was Learned', learned)}
${section('Open Threads', openThreads)}

## Grouping
[[_brain/patterns/Patterns — MOC|Patterns]]

---
*Memory neuron ${TODAY} · ${episodic.length} episodic notes consolidated · ${allItems.length} items · ${PROJECT_LINK}*
`;
  fs.writeFileSync(file, md);
  const rel = path.relative(VAULT, file);
  updateMOC(rel, validated.summary, allItems.map(i => i.item), 'items consolidated');
  logRun({ neuron: 'memory', outcome: 'wrote', outputPath: rel, wrote: rel, count: allItems.length, rejected: validated.rejected.length });
  brainLog(`memory neuron: ${allItems.length} items consolidated → [[${rel.replace(/\.md$/, '')}]]`);
  console.log(`  ✓ wrote ${allItems.length} consolidated items → ${rel}`);
  console.log(`  ✓ grouped into Patterns — MOC`);
  return { outcome: 'wrote', outputPath: rel, count: allItems.length };
}

const NEURONS = { pattern: patternNeuron, memory: memoryNeuron, link: linkNeuron, selftest };

// ---------- EVENT-TRIGGERED REFLECT (Pattern → Memory → Link; NEVER selftest) ----------
// Fired by launchd QueueDirectories when reflect-queue/ is non-empty. No event = no run,
// no claude -p, no patterns. Each neuron's own freshness guard stays as the second layer.
async function reflectRun() {
  // Non-TCC location: launchd's QueueDirectories watcher CANNOT see into ~/Desktop (TCC-protected;
  // only the FDA-granted `node` binary can read it, not launchd itself), so the watched queue must
  // live outside Desktop. ~/.neurolink is home-root and watchable. node (FDA) reads/writes it fine.
  const QUEUE = CONFIG.reflectQueue;
  const events = drain(QUEUE);                       // empties watched dir immediately
  if (!events.length) {
    console.log('no events, skipped');
    logRun({ neuron: 'reflect', wrote: null, count: 0, skipped: 'no events' });
    return;
  }
  // validate payloads — empty/unreadable = poison, straight to .failed (no neuron run)
  const valid = [], poison = [], ids = [], payloads = [];
  for (const f of events) {
    let body = null; try { body = fs.readFileSync(f, 'utf8').trim(); } catch {}
    if (body) { valid.push(f); ids.push(path.basename(f)); payloads.push(body); }
    else poison.push(f);
  }
  if (!valid.length) {
    finish(QUEUE, [], poison);
    console.log(`reflect: ${poison.length} poison event(s) → .failed, nothing to reflect on`);
    logRun({ neuron: 'reflect', events: poison.map(p => path.basename(p)), ran: [], outcome: 'poison→.failed' });
    return;
  }
  const scope = payloads.join('\n---\n').slice(0, 2000);
  console.log(`reflect: ${valid.length} event(s) — ${ids.join(', ')}`);

  const requested = ['pattern', 'memory', 'link'];
  const ran = [], results = [];
  for (const n of requested) {
    let result;
    try {
      result = await NEURONS[n]({ scope });              // no force → internal guards still gate
      if (!result || !['wrote', 'skipped', 'failed'].includes(result.outcome)) {
        result = failed(n, 'neuron returned no explicit outcome');
      }
    } catch (e) {
      const reason = String(e?.stack || e).slice(0, 300);
      console.error(`neuron ${n} failed:`, reason);
      result = failed(n, reason);
    }
    ran.push(n);
    results.push({ neuron: n, ...result });
    if (result.outcome === 'failed') break;
  }
  const acceptable = results.length === requested.length && results.every(result => result.outcome === 'wrote' || result.outcome === 'skipped');
  // any failed/missing neuron result → ALL events to .failed (queue drains, no refire); else delete processed
  if (!acceptable) finish(QUEUE, [], [...valid, ...poison]);
  else finish(QUEUE, valid, poison);

  const outcome = acceptable ? 'ok' : 'failed→.failed';
  logRun({ neuron: 'reflect', events: ids, ran, results, outcome });
  brainLog(`reflect: ${valid.length} event(s) [${ids.join(', ')}] → ran ${ran.join('+') || 'none'} · ${outcome}`);
  console.log(`reflect done · ran ${ran.join('+') || 'none'} · ${outcome}`);
}

const which = (process.argv[2] || 'pattern').toLowerCase();
if (which === 'reflect') {
  try { await reflectRun(); }
  catch (e) { console.error('reflect run failed:', String(e?.stack || e).slice(0, 300)); }
} else {
  for (const n of (which === 'all' ? Object.keys(NEURONS) : [which])) {
    if (!NEURONS[n]) { console.error(`unknown neuron: ${n}`); continue; }
    // Per-neuron isolation: one neuron throwing must NOT abort the others —
    // especially the selftest (the immune system), which runs last in NEURONS order.
    try {
      await NEURONS[n](which === 'all' ? {} : { force: true });
    } catch (e) {
      console.error(`neuron ${n} failed:`, String(e?.stack || e).slice(0, 300));
    }
  }
}
console.log('done.');
