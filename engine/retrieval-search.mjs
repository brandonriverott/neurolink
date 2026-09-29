import { evidenceFor, mayRetrieve, literalNotePaths, openingContext, wantsCurrentContext, contextSnippet, contextStatus } from './retrieval-policy.mjs';

// Pure search over an already-loaded index. Safe to import in isolated tests.
export function createSearchIndex({ meta, matrix, dim, vaultRoot = '', now = () => new Date() }) {
  const byFile = new Map();
  for (const m of meta) { if (!byFile.has(m.file)) byFile.set(m.file, []); byFile.get(m.file).push(m); }
  const files = [...byFile.keys()];

  // Track historical section boundaries across chunks, rather than trusting a
  // heading copied onto the next chunk by an older indexer. Current retrieval
  // may use a matching active passage but must never promote archived sections.
  const activeMeta=new Map();
  for(const chunks of byFile.values()) {
    let historicalDepth=null;
    for(const m of chunks) {
      const lines=[];
      for(const line of m.text.split('\n')) {
        const h=line.match(/^\s*(#{1,6})\s+(.+)/);
        if(h) {
          if(historicalDepth!==null&&h[1].length<=historicalDepth)historicalDepth=null;
          if(/^(historical(?:\b|\/)|superseded(?:\b|\/))/i.test(h[2]))historicalDepth=h[1].length;
        }
        if(historicalDepth===null)lines.push(line);
      }
      const text=lines.join('\n').trim();
      if(text)activeMeta.set(m,{...m,text,lc:text.toLowerCase(),heading:text.match(/^\s*#{1,6}\s+(.+)/m)?.[1]||m.heading});
    }
  }

  function makeHit(m, score, semantic, snippet, retrievalMode, historical = false) {
    let evidence = evidenceFor(m.file);
    if (historical && evidence.evidence_tier === 'vault_note') evidence = {
      evidence_tier: 'historical_support', guidance_status: 'corroboration_required',
      evidence_notice: 'Historical passage from the requested note. Do not treat it as current guidance without checking supersession.',
    };
    const status = contextStatus(snippet, m.heading);
    // Existing consumers may whitelist hit fields. Carry the evidence warning in
    // the snippet as well, so dropping new metadata cannot silently erase it.
    const displayed = evidence.evidence_tier === 'vault_note' ? snippet : `[${evidence.evidence_notice}]\n${snippet}`;
    const partialNotice = '[Partial preview: read the full source note before relying on its complete instructions.]\n';
    const boundedSnippet = displayed.length > 1000 ? `${partialNotice}${displayed.slice(0, 999 - partialNotice.length)}…` : displayed;
    return {
      file: m.file, title: m.title, region: m.region, heading: m.heading,
      mtime: m.mtime, score, semantic, snippet: boundedSnippet, retrieval_mode: retrievalMode,
      source_context: displayed,
      ...evidence, content_status: historical ? 'historical_lookup' : status,
    };
  }

  function exact(query, k, options = {}) {
    const matched = literalNotePaths(query, files, vaultRoot);
    if (!matched.length) return latestHealth(query, k);
    return matched.filter(file => mayRetrieve(file, query, { ...options, literal: true })).slice(0, k).map(file => {
      const chunks = byFile.get(file);
      // A literal path with an actual topic asks for that passage. A bare path
      // still returns the qualified opening. Dates/old-history requests retain
      // their evidence label; a new section is never promoted to standing policy.
      const remainder=(vaultRoot?query.replace(vaultRoot.replace(/\/$/,'')+'/'+file,'').replace(vaultRoot.replace(/\/$/,'')+'/'+file.replace(/\.md$/,''),''):query).replace(file,'').replace(file.replace(/\.md$/,''),'').toLowerCase();
      const words=[...new Set(remainder.match(/\d{4}-\d{2}(?:-\d{2})?|[a-z0-9]{3,}/g)||[])]
        .filter(w=>!['the','what','why','how','was','were','did','read','show','note','source','from','this','that','current','latest','active','today','now','please'].includes(w));
      const historical=!wantsCurrentContext(query)&&/\b(history|historical|earlier|previous|old|original)\b|\b\d{4}-\d{2}(?:-\d{2})?\b/i.test(remainder);
      const candidates=(wantsCurrentContext(query)?chunks.map(m=>activeMeta.get(m)).filter(Boolean):chunks).map((m,order)=>({m,order,score:words.reduce((n,w)=>n+(`${m.heading}\n${m.text}`.toLowerCase().includes(w)?(/^\d/.test(w)?4:1):0),0)}))
        .sort((a,b)=>b.score-a.score||a.order-b.order);
      if(candidates[0]?.score>0) return makeHit(candidates[0].m,1,0,
        contextSnippet(candidates[0].m.text,words,3200),historical?'literal_note_historical_passage':'literal_note_topic_passage',historical);
      // Legacy adapter requires finite numeric fields. score=1 means literal
      // match confidence; semantic=0 means no embedding score was computed.
      return makeHit(chunks[0], 1, 0, openingContext(chunks), 'literal_note_path');
    });
  }

  function latestHealth(query, k) {
    // Deterministic access to dated health evidence. Standing authority/policy
    // requests must continue through the normal source-policy filter instead.
    if (!/\b(latest|current|today|newest)\b/i.test(query) || !/\bhealth\b/i.test(query) ||
      !/\b(vault|reports?)\b/i.test(query) ||
      /\b(authority|policy|policies|workflow|rules|contract|historical|history|previous|earlier|original)\b/i.test(query) ||
      /\b\d{4}-\d{2}(?:-\d{2})?\b/.test(query)) return null;
    const supplied = now();
    const today = typeof supplied === 'string' && validDate(supplied) ? supplied :
      supplied instanceof Date && Number.isFinite(supplied.getTime()) ?
        `${supplied.getFullYear()}-${String(supplied.getMonth() + 1).padStart(2, '0')}-${String(supplied.getDate()).padStart(2, '0')}` : null;
    if (!today) throw new Error('Invalid date supplied to indexed health retrieval');
    const reports = files.flatMap(file => {
      // Exact standard filename only. Deep sweeps, PM variants, and Full Audit
      // variants never displace the standard daily report or become a tie-break.
      const match = file.match(/^_claude\/health\/Vault Health — (\d{4}-\d{2}-\d{2})\.md$/);
      return match && validDate(match[1]) && match[1] <= today ? [{ file, date: match[1] }] : [];
    }).sort((a, b) => b.date.localeCompare(a.date) || a.file.localeCompare(b.file));
    if (!reports.length || k < 1) return [];
    const selected = reports[0], chunks = byFile.get(selected.file);
    const notice = `Indexed report dated ${selected.date}, latest standard report available through ${today}. This is not a live health check.`;
    const hit = makeHit(chunks[0], 1, 0, `${notice}\n\n${openingContext(chunks)}`, 'latest_indexed_health_report');
    return [{ ...hit, report_date: selected.date, as_of_date: today, content_status: 'indexed_report_not_live' }];
  }

  function search(qvec, qterms, k, { query = '', includeSelf = false } = {}) {
    const direct = exact(query, k, { includeSelf });
    if (direct !== null) return direct;
    let maxKw = 1;
    const scored = [];
    for (let i = 0; i < meta.length; i++) {
      const m = wantsCurrentContext(query)?activeMeta.get(meta[i]):meta[i];
      if (!m)continue;
      if (!mayRetrieve(m.file, query, { includeSelf })) continue;
      let dot = 0;
      for (let d = 0; d < dim; d++) dot += qvec[d] * matrix[i * dim + d];
      const lc = m.lc ?? m.text.toLowerCase();
      let kw = 0;
      for (const t of qterms) if (lc.includes(t)) kw++;
      maxKw = Math.max(maxKw, kw);
      scored.push({ i, sem: dot, kw });
    }
    for (const s of scored) s.score = s.sem + 0.30 * (s.kw / maxKw);
    scored.sort((a, b) => b.score - a.score);
    const pool = scored.slice(0, 60);
    const topTitles = new Set(pool.slice(0, 12).map(s => meta[s.i].title));
    for (const s of pool) if ((meta[s.i].links || []).some(l => topTitles.has(prettyTitle(l)))) s.score += 0.05;
    pool.sort((a, b) => b.score - a.score);
    const seen = new Set(), hits = [];
    for (const s of pool) {
      const m = wantsCurrentContext(query)?activeMeta.get(meta[s.i]):meta[s.i];
      if (seen.has(m.file)) continue;
      seen.add(m.file);
      // Keep the passage that won retrieval. Replacing it with the beginning
      // silently hid appended current receipts. Source labels still require full
      // read-back, and explicit canonical-path retrieval retains its opening.
      hits.push(makeHit(m,+s.score.toFixed(4),+s.sem.toFixed(4),contextSnippet(m.text,qterms), 'ranked_passage'));
      if (hits.length >= k) break;
    }
    return hits;
  }
  return { exact, search };
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function prettyTitle(link) {
  const base = link.split('/').pop();
  return base.replace(/—/g, '·').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());
}
