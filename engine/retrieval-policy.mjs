// Pure retrieval policy. No filesystem, model, network, or service side effects.
const PATH_BOUNDARY = /[\s`'"\[\](){}<>|]/;
const SELF_PREFIX = '_brain/patterns/';
// Only observed dated report/receipt names in this folder. Do not classify
// undated standing policy (especially Health-Check Decisions & Policy) as history.
const DATED_HEALTH_REPORT = /^_claude\/health\/(?:vault health — \d{4}-\d{2}-\d{2}(?:-pm| \(full audit\))?|vault deep sweep — (?:full — )?\d{4}-\d{2}-\d{2}|vault deep baseline audit — \d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}(?:-bounded-repair-receipt)?|proposal-dispositions-\d{4}-\d{2}-\d{2})\.md$/;

export function evidenceFor(file) {
  const f = file.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  if (/(?:^|\/)rejected(?:\/|$)/.test(f)) return {
    evidence_tier: 'negative_evidence', guidance_status: 'never_active_guidance',
    evidence_notice: 'Rejected material: negative evidence only. Do not treat it as accepted guidance.',
  };
  if (DATED_HEALTH_REPORT.test(f)) return {
    evidence_tier: 'operational_evidence', guidance_status: 'historical_receipt',
    evidence_notice: 'Dated vault-health report or repair receipt. It records conditions when written; rerun checks to establish current state.',
  };
  if (f.startsWith('_inbox/proposals/applied/') || /^_claude\/learning\/(?:promoted|accepted)\//.test(f)) return {
    evidence_tier: 'operational_evidence', guidance_status: 'historical_receipt',
    evidence_notice: 'Receipt of an earlier action or acceptance. Verify the canonical source and current state.',
  };
  if (f.startsWith('_inbox/') || /^_claude\/learning\/(?:candidates|review|pending|staged)\//.test(f)) return {
    evidence_tier: 'pending_intake', guidance_status: 'not_approved',
    evidence_notice: 'Pending or undecided material. It is not approved or validated guidance.',
  };
  if (f.startsWith(SELF_PREFIX) || f.startsWith('_claude/learning/')) return {
    evidence_tier: 'generated_output', guidance_status: 'not_validated',
    evidence_notice: 'Generated learning output. Verify acceptance and the canonical source before using it.',
  };
  if (/(?:^|\/)(?:_?raw|_?archive|archives|backups?)(?:\/|$)/.test(f)) return {
    evidence_tier: 'historical_support', guidance_status: 'corroboration_required',
    evidence_notice: 'Historical or raw source. Preserve its original date and corroborate current claims.',
  };
  // Owner rule 2026-09-28: ideas live in ideas/ or in notes named "... Ideas"; label them so no AI reads them as truth.
  if (/(?:^|\/)ideas\//.test(f) || /ideas\.md$/.test(f)) return {
    evidence_tier: 'idea', guidance_status: 'not_truth',
    evidence_notice: 'Idea or unverified proposal. Not a decision and not verified fact; use it only as a suggestion.',
  };
  return {
    evidence_tier: 'vault_note', guidance_status: 'check_source_context',
    evidence_notice: 'Vault note. Check dates, qualifications, and supersession before treating it as current authority.',
  };
}

export function wantsCurrentContext(query) {
  return /\b(current|latest|active|today|now)\b|\bas of\b/i.test(query);
}

export function mayRetrieve(file, query, { includeSelf = false, literal = false } = {}) {
  const f = file.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  // Keep the established self-output opt-in exactly explicit, even for literal paths.
  if (f.startsWith(SELF_PREFIX) && !includeSelf) return false;
  const tier = evidenceFor(file).evidence_tier;
  if (includeSelf || literal) return true;
  if (tier === 'negative_evidence') return /\b(reject(?:ed|ion|ions|s)?|refused|declined|negative evidence|failed assumptions)\b/i.test(query);
  if (tier === 'pending_intake') return /\b(pending|undecided|unapproved|candidate|candidates|propos(?:e|ed|al|als|ing)|intake)\b/i.test(query);
  if (tier === 'generated_output') return /\b(generated|reflection|learning output)\b/i.test(query);
  if (wantsCurrentContext(query) && ['historical_support', 'operational_evidence'].includes(tier)) return false;
  return true;
}

export function literalNotePaths(query, files, vaultRoot = '') {
  // Existing indexed paths only. This never opens arbitrary caller-supplied paths.
  const q = query.replace(/\\/g, '/');
  const root = vaultRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const found = [];
  for (const file of files) {
    const variants = [file];
    if (file.includes('/') && file.endsWith('.md')) variants.push(file.slice(0, -3));
    if (root) variants.push(`${root}/${file}`, ...(file.endsWith('.md') ? [`${root}/${file.slice(0, -3)}`] : []));
    for (const v of variants) {
      let from = 0;
      while (from < q.length) {
        const at = q.indexOf(v, from);
        if (at < 0) break;
        const before = at === 0 || PATH_BOUNDARY.test(q[at - 1]);
        const end = at + v.length;
        const after = end === q.length || PATH_BOUNDARY.test(q[end]) || q[end] === '#' || (q[end] === '.' && (end + 1 === q.length || PATH_BOUNDARY.test(q[end + 1])));
        if (before && after) { found.push({ file, at, length: v.length }); break; }
        from = at + 1;
      }
    }
  }
  found.sort((a, b) => a.at - b.at || b.length - a.length);
  return [...new Set(found.map(x => x.file))];
}

const HISTORICAL_BOUNDARY = /^\s*(?:#{1,6}\s+|>\s*\*\*)?(?:historical(?:\b|\/)|superseded(?:\b|\/)|superseded prior workflow records)/i;
const SECTION_HEADING = /^\s*#{1,6}\s+/;

export function openingContext(chunks, { maxChars = 3200 } = {}) {
  // The existing index retains original per-note chunk order. Recover an opening
  // from indexed text, without bypassing index privacy exclusions or touching disk.
  const lines = chunks.map(c => c.text).join('\n\n').split('\n');
  const kept = [];
  for (const line of lines) {
    if (HISTORICAL_BOUNDARY.test(line) && kept.some(x => x.trim())) break;
    kept.push(line);
    if (kept.join('\n').length >= maxChars) break;
  }
  const text = kept.join('\n').trim();
  return text.slice(0, maxChars) + (text.length > maxChars ? '…' : '');
}

export function contextStatus(text, heading = '') {
  const starts = text.trimStart().split('\n').slice(0, 4);
  if (HISTORICAL_BOUNDARY.test(heading) || starts.some(line => HISTORICAL_BOUNDARY.test(line))) return 'historical_section';
  if (/superseded as operating authority|historical note is superseded/i.test(text.slice(0, 900))) return 'superseded_redirect';
  return 'source_context_requires_readback';
}

export function contextSnippet(text, qterms, maxChars = 700) {
  const lc = text.toLowerCase();
  let at = -1;
  for (const t of qterms) { const p = lc.indexOf(t); if (p !== -1 && (at === -1 || p < at)) at = p; }
  // Preserve section openings and qualifying language instead of cutting just
  // before a matching link/reference and losing the meaning of the passage.
  const hasHeading = text.split('\n').slice(0, 3).some(line => SECTION_HEADING.test(line));
  const start = hasHeading || at < 0 ? 0 : Math.max(0, at - 180);
  let s = text.slice(start, start + maxChars).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '…' + s;
  if (start + maxChars < text.length) s += '…';
  return s;
}
