/* ============================================================
   vault-graph.mjs — single source of truth for the brain's graph.
   Scans the live Obsidian vault and returns the FULL graph:
     nodes  : every note 1:1  {id,title,region,degree,mtime}  (+ tag neurons)
     edges  : every resolved wikilink 1:1  [sourceIdx, targetIdx]
     regions: per-region summary (count/recent/recentNotes) for HUD + chat
     recentActivity, recentAgentRuns, totals, generatedAt
   Used by BOTH gen-vault-data.js (writes vault-data.js) and
   rag-server.mjs (serves live /graph) so they can never disagree.
   Privacy: hard-excludes any note matching config privateNamePattern from all output.
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, PRIVATE_NAME as EXCLUDE_NAME, regionFor } from './config.mjs';

export const VAULT = CONFIG.vault;
export { regionFor };
// '.claude' (dot) = installed skills/tooling, NOT brain content → excluded.
// '_claude' (underscore) = Claude's memory about the owner → kept (prefrontal).
const EXCLUDE_DIRS = new Set(['.obsidian', '.git', '.trash', 'node_modules', '.claude']);
const WEEK = 7 * 24 * 60 * 60 * 1000;

// 10 regions (anatomy lives in brain.html; names/subs here, keys must match)
export const REGION_META = {
  prefrontal: { name: 'PREFRONTAL',         sub: 'decisions · planning' },
  concept:    { name: 'CONCEPT LAYER',      sub: 'knowledge · wiki' },
  predictive: { name: 'PREDICTIVE',         sub: 'patterns · emerging' },
  assoc:      { name: 'ASSOCIATION CORTEX', sub: 'people · relationships' },
  hippo:      { name: 'HIPPOCAMPUS',        sub: 'memory · daily' },
  brainstem:  { name: 'BRAINSTEM',          sub: 'identity · philosophy' },
  language:   { name: 'LANGUAGE',           sub: 'content · brand' },
  sensory:    { name: 'SENSORY CORTEX',     sub: 'capture · inbox' },
  motor:      { name: 'MOTOR CORTEX',       sub: 'business · ops' },
  feature:    { name: 'FEATURE LAYER',      sub: 'signals · tags' },
};

function prettify(base) {
  return base.replace(/\.md$/i, '')
    .replace(/—/g, '·').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

// a wikilink target → lookup key (basename, no alias/heading/ext, lowercased)
function linkKey(link) {
  let s = String(link).split('|')[0].split('#')[0].trim();
  s = s.split('/').pop().replace(/\.md$/i, '').toLowerCase();
  return s;
}

// ---- Obsidian graph color groups = the REAL sections (path/tag/file queries) ----
// First matching group (in file order) wins — order groups specific→broad on purpose.
function loadColorGroups() {
  try {
    const raw = fs.readFileSync(path.join(VAULT, '.obsidian', 'graph.json'), 'utf8');
    return (JSON.parse(raw).colorGroups || [])
      .map(g => ({ query: String(g.query || '').trim(),
        rgb: [(g.color.rgb >> 16) & 255, (g.color.rgb >> 8) & 255, g.color.rgb & 255] }))
      .filter(g => g.query);
  } catch { return []; }
}
const COLOR_GROUPS = loadColorGroups();
const UNSORTED = { query: '(unsorted)', rgb: [136, 146, 160] };

function groupName(query) {
  const q = query.trim();
  if (q.startsWith('path:')) return q.slice(5).replace(/"/g, '').trim()
    .split('/').map(s => s.replace(/[-_]+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase())).join(' / ');
  if (q.startsWith('tag:')) return '#' + q.slice(4).replace('#', '').trim();
  if (q.startsWith('file:')) return q.slice(5).replace(/"/g, '').replace(/[—-]/g, ' ').trim() + ' hubs';
  return q;
}
function groupFamily(query) {
  const q = query.toLowerCase();
  const hit = CONFIG.colorFamilyRules.find(([needle]) => q.includes(needle));
  return hit ? hit[1] : 4; // hubs: index / moc / map / vault-sun / unsorted
}
function matchGroup(rel, base, tags) {
  const rl = rel.toLowerCase(), bl = base.toLowerCase();
  for (const g of COLOR_GROUPS) {
    const q = g.query;
    if (q.startsWith('path:')) { const p = q.slice(5).replace(/"/g, '').trim().toLowerCase(); if (p && rl.startsWith(p)) return g; }
    else if (q.startsWith('tag:')) { const t = q.slice(4).trim().toLowerCase(); if (tags.includes(t)) return g; }
    else if (q.startsWith('file:')) { const f = q.slice(5).replace(/"/g, '').trim().toLowerCase(); if (f && bl.includes(f)) return g; }
  }
  return null;
}

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.isDirectory()) { if (!EXCLUDE_DIRS.has(e.name)) walk(path.join(dir, e.name), out); }
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md') && !EXCLUDE_NAME.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
}

function recentAgentRuns() {
  // last few real generations from the neuron loop (pattern/link), for "agent flares"
  try {
    const lines = fs.readFileSync(path.join(CONFIG.home, 'neuron-log.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(r => r && r.wrote && Array.isArray(r.titles) && r.titles.length);
    return lines.slice(-4).map(r => ({ ts: r.ts, neuron: r.neuron, wrote: r.wrote, titles: r.titles, wildcard: r.wildcard || null }));
  } catch { return []; }
}

export function scanVaultGraph() {
  const NOW = Date.now();
  const files = [];
  walk(VAULT, files);

  // ---- pass 1: read every note, map basename→index ----
  const recs = [];                 // {rel, base, title, region, mtime, rawLinks[], tags[]}
  const keyToIdx = new Map();       // basename key → node index (last wins on dupes)
  for (const abs of files) {
    let st, content;
    try { st = fs.statSync(abs); content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const rel = path.relative(VAULT, abs);
    const base = path.basename(abs);
    const rawLinks = (content.match(/\[\[([^\]]+)\]\]/g) || []).map(m => m.slice(2, -2));
    const tags = (content.match(/(?:^|\s)#[a-zA-Z][\w/-]+/g) || []).map(t => t.trim());
    const idx = recs.length;
    recs.push({ rel, base, title: prettify(base), region: regionFor(rel), mtime: st.mtimeMs, rawLinks, tags });
    keyToIdx.set(base.replace(/\.md$/i, '').toLowerCase(), idx);
  }

  // ---- nodes: notes 1:1, each tagged with its real Obsidian color group ----
  const nodes = recs.map(r => {
    const g = matchGroup(r.rel, r.base, r.tags.map(t => t.toLowerCase())) || UNSORTED;
    return { id: r.rel, title: r.title, region: r.region, group: groupName(g.query),
      groupKey: g.query, color: g.rgb, family: groupFamily(g.query), mtime: r.mtime, degree: 0 };
  });

  // ---- edges: resolve every wikilink to a real target ----
  const edgeSet = new Set();        // "a-b" (a<b) dedupe
  const edges = [];
  let totalWikilinks = 0;
  for (let i = 0; i < recs.length; i++) {
    for (const link of recs[i].rawLinks) {
      totalWikilinks++;
      const j = keyToIdx.get(linkKey(link));
      if (j === undefined || j === i) continue;
      const a = Math.min(i, j), b = Math.max(i, j), key = a + '-' + b;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key); edges.push([a, b]);
      nodes[a].degree++; nodes[b].degree++;
    }
  }

  // ---- group summary: the real Obsidian color groups (legend + sectors) ----
  const gmap = new Map();
  for (const n of nodes) {
    let e = gmap.get(n.groupKey);
    if (!e) { e = { key: n.groupKey, name: n.group, color: n.color, family: n.family, count: 0 }; gmap.set(n.groupKey, e); }
    e.count++;
  }
  const groups = [...gmap.values()].sort((a, b) => a.family - b.family || b.count - a.count);

  // ---- distinct tags (kept only for the region back-compat count) ----
  const tagStat = new Map();
  for (const r of recs) for (const t of r.tags) {
    const s = tagStat.get(t) || { count: 0, latest: 0 };
    s.count++; if (r.mtime > s.latest) s.latest = r.mtime;
    tagStat.set(t, s);
  }

  // ---- region summary (chat keyword fallback back-compat) ----
  const regions = {};
  for (const k of Object.keys(REGION_META)) regions[k] = { count: 0, recent: 0, notes: [] };
  for (const r of recs) {
    const g = regions[r.region]; g.count++;
    if (NOW - r.mtime < WEEK) g.recent++;
    g.notes.push({ name: r.title, mtime: r.mtime });
  }
  regions.feature.count = tagStat.size; // feature lobe = distinct tags
  for (const k of Object.keys(regions)) {
    regions[k].notes.sort((a, b) => b.mtime - a.mtime);
    regions[k].recentNotes = regions[k].notes.slice(0, 6).map(n => ({ name: n.name, mtime: n.mtime }));
    delete regions[k].notes;
  }

  // ---- global recent activity feed ----
  const recentActivity = recs.slice().sort((a, b) => b.mtime - a.mtime).slice(0, 14)
    .map(r => ({ name: r.title, region: r.region, mtime: r.mtime, id: r.rel }));

  return {
    generatedAt: NOW,
    vaultName: path.basename(VAULT),   // brain.html uses it for obsidian:// links
    totalNeurons: recs.length,
    totalSynapses: totalWikilinks,
    edgeCount: edges.length,
    regionCount: Object.keys(REGION_META).length,
    groupCount: groups.length,
    nodes,
    edges,
    groups,
    regions,
    recentActivity,
    recentAgentRuns: recentAgentRuns(),
  };
}
