/* test-lineage.mjs — pattern lineage: frontmatter, evidence resolution, retraction check.
   Run: node neurons/test-lineage.mjs   (needs no neurolink.config.json) */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { PATTERN_GENERATOR_VERSION, checkLineage, patternFrontmatter, resolveEvidence } from './lineage.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-'));
const V = path.join(tmp, 'vault');
const put = (rel, text, root = V) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const note = (rel, title) => ({ rel, title });

// 1. patternFrontmatter
const now = new Date(2026, 10, 16, 6, 6, 21);
const fm = patternFrontmatter({ derivedFrom: ['b/two', 'a/one', 'b/two', 'q/"x"\\y'], now, llmCommand: '/opt/bin/llm-hermes.sh' });
const lines = fm.split('\n');
assert.equal(lines[0], '---');
assert.equal(lines.at(-1), '---');
assert.equal(lines.at(-2), 'verdict: ', 'verdict is the last key, empty, trailing space kept');
const val = k => (lines.find(l => l.startsWith(`${k}: `)) || '').slice(k.length + 2);
assert.equal(val('created'), '2026-11-16T06:06:21');
assert.equal(val('last_confirmed'), '2026-11-16T06:06:21');
assert.equal(val('provenance'), 'INFERRED');
assert.equal(val('confidence'), 'uncertain');
assert.equal(val('confidence_score'), '0.4');
assert.equal(val('volatility'), 'normal');
assert.equal(val('source'), 'pattern-neuron');
assert.equal(val('type'), 'pattern');
assert.equal(val('generator'), 'pattern-neuron');
assert.equal(val('generator_version'), `"${PATTERN_GENERATOR_VERSION}"`);
assert.equal(val('generator_llm'), '"llm-hermes.sh"', 'base name only');
assert.ok(lines.includes('derived_from:'));
assert.deepEqual(lines.filter(l => l.startsWith('  - ')), ['  - "[[a/one]]"', '  - "[[b/two]]"', '  - "[[q/\\"x\\"\\\\y]]"'], 'sorted, unique, YAML-escaped');
for (const bad of ['validated', 'promoted_by', 'review_due']) assert.ok(!lines.some(l => l.startsWith(`${bad}:`)), `no ${bad}`);

// 2. verdict regressions (JS reader in run-neuron.mjs; Python reader in file-verdicts.py sees the block without fences)
const full = `${fm}\n\n# Pattern Neuron — 2026-11-16\n`;
assert.equal(full.match(/^verdict:\s*(\w+)/m), null, 'empty verdict must not capture the next line');
assert.equal(lines.slice(1, -1).join('\n').match(/^verdict:\s*(.*)$/m)[1], '', 'python-style read is empty');
assert.equal(full.replace(/^verdict: $/m, 'verdict: approved').match(/^verdict:\s*(\w+)/m)[1], 'approved');

// 3. resolveEvidence
put('bakery/Sourdough Starter.md', 'x'); put('bakery/Oven Log.md', 'x'); put('a/Same Title.md', 'x'); put('b/Same Title.md', 'x');
const notes = [note('bakery/Sourdough Starter.md', 'Sourdough Starter'), note('bakery/Oven Log.md', 'Oven Log'), note('a/Same Title.md', 'Same Title'), note('b/Same Title.md', 'Same Title')];
let r = resolveEvidence(['Sourdough Starter', 'Oven Log'], notes, V);
assert.deepEqual(r.resolved.map(x => x.rel), ['bakery/Sourdough Starter', 'bakery/Oven Log']);
r = resolveEvidence(['Sourdough Starter', 'Not A Real Note'], notes, V);
assert.equal(r.resolved.length, 1); assert.equal(r.unresolved.length, 1); assert.equal(r.unresolved[0].value, 'Not A Real Note');
r = resolveEvidence(['Sourdough Starter', 'sourdough starter', 'bakery/Sourdough Starter'], notes, V);
assert.equal(r.resolved.length, 1, 'same note cited twice counts once');
r = resolveEvidence(['Same Title', 'Oven Log'], notes, V);
assert.deepEqual(r.resolved.map(x => x.rel), ['bakery/Oven Log']);
assert.match(r.unresolved[0].reason, /ambiguous/, 'a title matching two notes is unresolved');
assert.deepEqual(resolveEvidence(undefined, notes, V), { resolved: [], unresolved: [] });

// 4. checkLineage
const L = path.join(tmp, 'lv');
put('src/a.md', 'plain source a', L);
put('src/b.md', 'This old plan was superseded last year, but nothing replaces it.', L);
put('src/c.md', 'source c', L);
const patternNote = srcs => `${patternFrontmatter({ derivedFrom: srcs, now, llmCommand: 'x' })}\n\n# Pattern Neuron\n\n## Patterns\n\n### Alpha\n- **Evidence:** [[src/a|A]] · [[src/b|B]]\n\n### 🎲 Beta\n- **Evidence:** [[src/b|B]] · [[src/c|C]]\n`;
put('_brain/patterns/2026-11-10-patterns.md', '---\ntype: pattern\nverdict: \n---\n\n### Old\n- **Evidence:** [[src/gone|Gone]]\n', L);
put('_brain/patterns/2026-11-16-patterns.md', patternNote(['src/a', 'src/b', 'src/c']), L);
put('_brain/patterns/Taste Profile.md', 'not a pattern note', L);
let c = checkLineage(L);
assert.deepEqual([c.checked, c.legacy, c.broken.length], [1, 1, 0], 'clean note passes; note without derived_from is legacy; body "superseded" does not trigger');
fs.rmSync(path.join(L, 'src/a.md'));
c = checkLineage(L);
assert.equal(c.broken.length, 1);
assert.deepEqual(c.broken[0], { note: '_brain/patterns/2026-11-16-patterns.md', target: 'src/a', reason: 'missing', patterns: ['Alpha'] });
put('src/a.md', 'source a back', L);
put('src/c.md', '﻿> **SUPERSEDED** by [[src/a]]\n\nsource c', L);
c = checkLineage(L);
assert.deepEqual(c.broken.map(b => [b.target, b.reason, b.patterns]), [['src/c', 'superseded', ['Beta']]]);
put('src/c.md', '> ⚠️ superseded by something newer', L);
assert.equal(checkLineage(L).broken[0].reason, 'superseded', 'case-insensitive, warning-sign form');

// 5. path safety: entries outside the vault are reported and never read
put('outside.md', '> **SUPERSEDED**\n', tmp);
put('src/c.md', 'source c', L);
put('_brain/patterns/2026-11-17-patterns.md', `---\ntype: pattern\nderived_from:\n  - "[[../../etc/passwd]]"\n  - "[[../outside]]"\n  - "${path.join(tmp, 'outside')}"\n  - "[[src/a]]"\nverdict: \n---\n\n### Safe\n- **Evidence:** [[src/a|A]]\n`, L);
c = checkLineage(L);
const unsafe = c.broken.filter(b => b.note.includes('11-17'));
assert.equal(unsafe.length, 3);
assert.ok(unsafe.every(b => b.reason === 'unsafe' && b.patterns.length === 0), 'traversal and absolute paths are refused before any read');
assert.throws(() => checkLineage(path.join(tmp, 'nope')), 'unreadable vault throws');

// 6. derived_from shapes: unindented list, inline list, unparseable value
const M = path.join(tmp, 'mv');
put('src/ok.md', 'fine', M);
const shaped = (name, body) => put(`_brain/patterns/${name}-patterns.md`, `---\ntype: pattern\n${body}\nverdict: \n---\n\n### T\n- **Evidence:** [[src/gone|G]] · [[src/ok|O]]\n`, M);
shaped('a', 'derived_from:\n- "[[src/gone]]"\n- "[[src/ok]]"');
shaped('b', 'derived_from: ["[[src/gone]]", "[[src/ok]]"]');
shaped('c', 'derived_from: []');
shaped('d', 'derived_from: some free text');
c = checkLineage(M);
const by = n => c.broken.filter(b => b.note.endsWith(`/${n}-patterns.md`)).map(b => [b.target, b.reason, b.patterns]);
assert.deepEqual(by('a'), [['src/gone', 'missing', ['T']]], 'unindented list items are read');
assert.deepEqual(by('b'), [['src/gone', 'missing', ['T']]], 'inline list is read');
assert.deepEqual(by('c'), [], 'empty inline list is an empty list');
assert.deepEqual(by('d'), [['some free text', 'unparsed', []]], 'unreadable value is reported');
assert.equal(c.checked, 4);

// 7. CLI started through a symlinked folder must still run (argv[1] is the link, import.meta.url the real path)
fs.symlinkSync(import.meta.dirname, path.join(tmp, 'link'));
const cli = spawnSync(process.execPath, [path.join(tmp, 'link', 'lineage.mjs'), 'check'], { env: { ...process.env, NEUROLINK_VAULT: M }, encoding: 'utf8' });
assert.equal(cli.status, 1, 'broken source -> exit 1 via symlink');
assert.match(cli.stdout, /lineage: 4 checked · 3 broken/);
assert.match(cli.stdout, /src\/gone \(missing\)/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('✓ all lineage invariants hold');
