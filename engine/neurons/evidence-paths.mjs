import fs from 'node:fs';
import path from 'node:path';

export const MEMORY_SECTIONS = ['decisions', 'changes', 'learned', 'open_threads'];

const slash = value => value.split(path.sep).join('/');
const withoutMarkdownExtension = value => value.replace(/\.md$/i, '');
const comparable = value => withoutMarkdownExtension(value).normalize('NFC').toLowerCase();

function evidenceReference(value) {
  if (typeof value !== 'string') return null;
  let reference = value.trim();
  const wikilink = reference.match(/^\[\[([^\]]+)\]\]$/);
  if (wikilink) reference = wikilink[1].split('|', 1)[0].trim();
  if (!reference || /[\r\n]/.test(reference)) return null;
  reference = slash(reference).replace(/^\.\//, '');
  if (path.posix.isAbsolute(reference) || reference.split('/').includes('..')) return null;
  return withoutMarkdownExtension(reference);
}

function canonicalRecord(note, vaultRoot) {
  if (!note || typeof note.rel !== 'string' || !note.rel.trim()) return null;
  const requested = slash(note.rel.trim()).replace(/^\.\//, '');
  if (path.posix.isAbsolute(requested) || requested.split('/').includes('..')) return null;

  let rootReal;
  let sourceReal;
  try {
    rootReal = fs.realpathSync(vaultRoot);
    const source = path.resolve(vaultRoot, requested);
    if (!fs.statSync(source).isFile()) return null;
    sourceReal = fs.realpathSync(source);
  } catch {
    return null;
  }

  const canonical = path.relative(rootReal, sourceReal);
  if (canonical === '..' || canonical.startsWith(`..${path.sep}`) || path.isAbsolute(canonical)) return null;
  const rel = withoutMarkdownExtension(slash(canonical));
  if (!rel || /[\[\]|#\r\n]/.test(rel)) return null;
  const title = typeof note.title === 'string' && note.title.trim()
    ? note.title.trim()
    : path.posix.basename(rel);
  return { rel, title };
}

export function resolveNotePath(value, notes, vaultRoot) {
  const reference = evidenceReference(value);
  if (!reference) return { ok: false, reason: 'evidence must be a non-empty note title or canonical relative path' };

  const byRel = new Map();
  for (const note of Array.isArray(notes) ? notes : []) {
    const record = canonicalRecord(note, vaultRoot);
    if (record) byRel.set(record.rel, record);
  }
  const records = [...byRel.values()].sort((a, b) => a.rel.localeCompare(b.rel));
  const wanted = comparable(reference);
  const hasPath = reference.includes('/');
  const matches = records.filter(record => {
    if (hasPath) return comparable(record.rel) === wanted;
    return comparable(record.title) === wanted || comparable(path.posix.basename(record.rel)) === wanted;
  });

  if (matches.length === 1) return { ok: true, ...matches[0] };
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `ambiguous evidence source "${value}"`,
      candidates: matches.map(match => match.rel),
    };
  }
  return { ok: false, reason: `evidence source not found: "${value}"` };
}

function itemText(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text || null;
}

export function validateMemoryConsolidation(result, sourceNotes, vaultRoot) {
  const sections = Object.fromEntries(MEMORY_SECTIONS.map(name => [name, []]));
  const rejected = [];
  const response = result && typeof result === 'object' && !Array.isArray(result) ? result : {};

  for (const section of MEMORY_SECTIONS) {
    const rawItems = response[section];
    if (rawItems == null) continue;
    if (!Array.isArray(rawItems)) {
      rejected.push({ section, index: null, reason: `${section} must be an array` });
      continue;
    }

    rawItems.forEach((raw, index) => {
      const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? itemText(raw.item) : null;
      if (!item) {
        rejected.push({ section, index, reason: 'item must be a non-empty string' });
        return;
      }
      if (typeof raw.evidence !== 'string' || !raw.evidence.trim()) {
        rejected.push({ section, index, item, reason: 'evidence must be a non-empty string' });
        return;
      }

      const resolved = resolveNotePath(raw.evidence, sourceNotes, vaultRoot);
      if (!resolved.ok) {
        rejected.push({ section, index, item, evidence: raw.evidence, ...resolved });
        return;
      }
      sections[section].push({ item, evidenceRel: resolved.rel, evidenceTitle: resolved.title });
    });
  }

  return {
    sections,
    rejected,
    summary: typeof response.summary === 'string' ? response.summary.replace(/\s+/g, ' ').trim() : '',
  };
}

export function evidenceLink(item) {
  if (!item || typeof item.evidenceRel !== 'string' || typeof item.evidenceTitle !== 'string') {
    throw new TypeError('evidenceLink requires a validated consolidation item');
  }
  return `[[${item.evidenceRel}|${item.evidenceTitle}]]`;
}
