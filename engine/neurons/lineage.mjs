#!/usr/bin/env node
/* lineage.mjs — provenance for Pattern Neuron run notes: frontmatter, evidence resolution, retraction check.
   Pure functions; config.mjs is only loaded (lazily) by the command line when NEUROLINK_VAULT is unset.
   Check: node neurons/lineage.mjs check [--json]   (exit 0 none broken · 1 broken · 2 vault unreadable) */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNotePath } from './evidence-paths.mjs';

// Bump when the pattern prompt or the write rules change.
export const PATTERN_GENERATOR_VERSION = '2026-11-16.1';

const yamlStr = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const pad = n => String(n).padStart(2, '0');
const localStamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

// Resolve the model's cited titles with the shared resolver; de-duplicated by note path.
export function resolveEvidence(titles, notes, vaultRoot) {
  const resolved = [], unresolved = [], seen = new Set();
  for (const value of Array.isArray(titles) ? titles : []) {
    const r = resolveNotePath(value, notes, vaultRoot);
    if (!r.ok) { unresolved.push({ value, reason: r.reason }); continue; }
    if (seen.has(r.rel)) continue;
    seen.add(r.rel);
    resolved.push({ rel: r.rel, title: r.title });
  }
  return { resolved, unresolved };
}

// `verdict: ` MUST stay the last line: both verdict readers let \s* run across the line break, so any key after an empty verdict would be read as the verdict.
export function patternFrontmatter({ derivedFrom, now, llmCommand }) {
  const created = localStamp(now);
  const lines = [...new Set(derivedFrom)].sort().map(r => `  - "[[${yamlStr(r)}]]"`);
  return [
    '---', 'type: pattern', 'tags: [pattern, neuron, predictive, emerging]',
    `created: ${created}`, `last_confirmed: ${created}`, 'source: pattern-neuron',
    'provenance: INFERRED', 'confidence: uncertain', 'confidence_score: 0.4', 'volatility: normal',
    'generator: pattern-neuron', `generator_version: "${PATTERN_GENERATOR_VERSION}"`,
    `generator_llm: "${yamlStr(path.basename(String(llmCommand)))}"`,
    ...(lines.length ? ['derived_from:', ...lines] : ['derived_from: []']),
    'verdict: ', '---',
  ].join('\n');
}

const SUPERSEDED = /^\s*>\s*(?:\*\*|⚠️\s*|⚠\s*)?SUPERSEDED\b/im;   // same banner vault-note writes

function sourcesOf(text) {
  const fm = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const lines = fm[1].split('\n');
  const i = lines.findIndex(l => /^derived_from:/.test(l));
  if (i === -1) return null;
  const rest = lines[i].slice('derived_from:'.length).trim();
  if (rest) {   // inline list: comma-separated, entries may be quoted; anything else is reported, not skipped
    const inline = rest.match(/^\[([\s\S]*)\]$/);
    if (!inline) return { items: [], unparsed: rest };
    return { items: (inline[1].match(/"(?:[^"\\]|\\.)*"|[^,\s][^,]*/g) || []).map(x => x.trim()), unparsed: null };
  }
  const items = [];
  for (const l of lines.slice(i + 1)) {
    const m = l.match(/^\s*-\s+(.*?)\s*$/);
    if (!m) break;
    items.push(m[1]);
  }
  return { items, unparsed: null };
}

// Reduce one derived_from entry to a vault-relative path without .md, or null if unsafe.
function entryPath(raw) {
  let v = raw;
  if (/^"[\s\S]*"$/.test(v)) v = v.slice(1, -1).replace(/\\(["\\])/g, '$1');
  const w = v.match(/^\[\[([\s\S]*)\]\]$/);
  if (w) v = w[1];
  v = v.split('|')[0].split('#')[0].trim().replace(/\.md$/i, '');
  if (!v || /[\0\r\n]/.test(v) || path.posix.isAbsolute(v) || path.isAbsolute(v) || v.split(/[\\/]/).includes('..')) return null;
  return v;
}

function patternsCiting(text, rel) {
  const hits = [];
  let heading = null;
  for (const l of text.split('\n')) {
    const h = l.match(/^###\s+(?:🎲\s*)?(.+)$/);
    if (h) heading = h[1].trim();
    else if (heading && /^-\s+\*\*Evidence:\*\*/.test(l) && (l.includes(`[[${rel}|`) || l.includes(`[[${rel}]]`)) && !hits.includes(heading)) hits.push(heading);
  }
  return hits;
}

// Read-only. Reports pattern notes whose derived_from sources are missing or carry a SUPERSEDED banner.
export function checkLineage(vaultRoot) {
  if (!fs.statSync(vaultRoot).isDirectory()) throw new Error(`not a directory: ${vaultRoot}`);
  const dir = path.join(vaultRoot, '_brain', 'patterns');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /patterns(-\d+)?\.md$/.test(f)).sort() : [];
  const result = { checked: 0, legacy: 0, broken: [] };
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const parsed = sourcesOf(text);
    if (!parsed) { result.legacy++; continue; }
    result.checked++;
    const note = `_brain/patterns/${f}`;
    if (parsed.unparsed) result.broken.push({ note, target: parsed.unparsed, reason: 'unparsed', patterns: [] });
    for (const raw of parsed.items) {
      const rel = entryPath(raw);
      let reason = null;
      if (!rel) reason = 'unsafe';
      else {
        const file = path.join(vaultRoot, `${rel}.md`);
        let st = null; try { st = fs.statSync(file); } catch {}
        if (!st || !st.isFile()) reason = 'missing';
        else if (SUPERSEDED.test(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').slice(0, 4000))) reason = 'superseded';
      }
      if (reason) result.broken.push({ note, target: rel || raw, reason, patterns: rel ? patternsCiting(text, rel) : [] });
    }
  }
  return result;
}

export const lineageSummary = r => `lineage: ${r.checked} checked · ${r.broken.length} broken · ${r.legacy} legacy (no lineage, skipped)`;

async function main(args) {
  if (args[0] !== 'check') { console.error('usage: node neurons/lineage.mjs check [--json]'); return 2; }
  let result;
  try {
    const vault = process.env.NEUROLINK_VAULT || (await import('../config.mjs')).CONFIG.vault;
    result = checkLineage(vault);
  } catch (e) { console.error(`lineage: vault could not be read: ${String(e.message || e).slice(0, 200)}`); return 2; }
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(lineageSummary(result));
    for (const b of result.broken) console.log(`${b.note} -> ${b.target} (${b.reason}) · patterns: ${b.patterns.join(', ') || '(unknown)'}`);
  }
  return result.broken.length ? 1 : 0;
}

// Compare real paths: started through a symlinked folder, argv[1] is the link path but import.meta.url is the real one.
const realPath = p => { try { return fs.realpathSync(p); } catch { return p; } };
const isMain = process.argv[1] && realPath(path.resolve(process.argv[1])) === realPath(fileURLToPath(import.meta.url));
if (isMain) process.exitCode = await main(process.argv.slice(2));
