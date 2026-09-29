// config.mjs — the ONE place for anything personal. Your real values live in neurolink.config.json next to this
// file; it is gitignored and never published. neurolink.config.example.json shows the shape. Env vars still win.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = import.meta.dirname;
const readJson = name => {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`${name}: ${e.message}`); }
};
// Fail closed: without your private config the private-name filter would be empty, so notes you excluded could
// reach the index, the brain map and neuron prompts. Stop instead. A broken JSON file or bad pattern also stops
// here on purpose (fix the config, then restart). To try the engine with the example values, copy it first.
const file = readJson('neurolink.config.json');
if (!file) {
  throw new Error(`neurolink: ${path.join(DIR, 'neurolink.config.json')} is missing — ` +
    'copy neurolink.config.example.json to neurolink.config.json and fill in your own values');
}
const expand = p => (typeof p === 'string' ? p.replace(/^~(?=\/|$)/, os.homedir()) : p);
const env = process.env;

export const CONFIG = Object.freeze({
  ownerName: file.ownerName || 'the owner',
  vault: expand(env.NEUROLINK_VAULT || file.vault || '~/Documents/Vault'),
  home: expand(env.NEUROLINK_HOME || file.home || DIR),
  reflectQueue: expand(env.NEUROLINK_REFLECT_QUEUE || file.reflectQueue || '~/.neurolink/reflect-queue'),
  logDir: expand(file.logDir || '~/Library/Logs'),
  hermesHome: expand(env.NEUROLINK_HERMES || file.hermesHome || '~/.hermes'),
  loopLedger: expand(env.LOOP_LEDGER_FILE || file.loopLedger || ''),
  reviewRoots: (env.NEUROLINK_REVIEW_ROOTS ? env.NEUROLINK_REVIEW_ROOTS.split(':') : file.reviewRoots || []).map(expand).filter(Boolean),
  // Read as "<ownerName>'s <stackDescription>" in the trace-miner prompt.
  stackDescription: file.stackDescription || 'Hermes multi-agent stack',
  // Extra addresses the search server listens on besides 127.0.0.1 (e.g. a Tailscale IP). Never 0.0.0.0.
  listenHosts: (file.listenHosts || []).filter(h => h && h !== '0.0.0.0'),
  // Vault-relative folders never indexed / never read by the neurons.
  indexExcludePaths: file.indexExcludePaths || ['_inbox'],
  neuronExcludePaths: file.neuronExcludePaths || [],
  // Case-insensitive pattern: any note whose file name (or indexed text) matches is kept out of every output.
  // Put private names here, in neurolink.config.json only. Empty = no name filter.
  privateNamePattern: file.privateNamePattern || '',
  // Ordered [folderPrefix, region] rules for the brain map; first match wins, lowercase prefixes.
  regionRules: file.regionRules || [
    ['_claude/', 'prefrontal'], ['_brain/wiki/', 'concept'], ['_brain/patterns/', 'predictive'],
    ['daily/', 'hippo'], ['_brain/', 'hippo'], ['personal/people/', 'assoc'], ['personal/', 'sensory'],
  ],
  defaultRegion: file.defaultRegion || 'concept',
  // Vault note the neurons link their footers to (no .md). Empty = plain text, no link.
  projectNote: file.projectNote || '',
  // Folders health.mjs checks for recently changed notes.
  freshnessDirs: file.freshnessDirs || ['daily', '_brain/patterns', '_claude'],
  // Ordered [substring, family] rules that sort Obsidian colour groups in the brain legend; unmatched = 4.
  colorFamilyRules: file.colorFamilyRules || [
    ['personal', 1], ['_brain', 2], ['_claude', 3], ['daily', 3], ['template', 3], ['_attachment', 3],
  ],
});
export const projectLink = label =>
  CONFIG.projectNote ? `[[${CONFIG.projectNote}|${label}]]` : label;

// A regex that never matches when no private pattern is set.
export const PRIVATE_NAME = CONFIG.privateNamePattern ? new RegExp(CONFIG.privateNamePattern, 'i') : /(?!)/;
export const regionFor = rel => {
  const p = rel.toLowerCase();
  const hit = CONFIG.regionRules.find(([prefix]) => p.startsWith(prefix));
  return hit ? hit[1] : CONFIG.defaultRegion;
};
export const vaultName = () => path.basename(CONFIG.vault);
export const logFile = name => path.join(CONFIG.logDir, name);
