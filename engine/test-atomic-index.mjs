/* test-atomic-index.mjs — index writes round only vectors to 6 decimals and refuse to start without disk room.
   Run: node test-atomic-index.mjs
   Uses a throwaway copy with its own config and vault, so it never touches your real index or notes. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { pathToFileURL } from 'node:url';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-index-')));
const MiB = 1048576;
const decimals = x => (String(x).split('.')[1] || '').length;
const tmpFiles = dir => fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
// Pretend the disk has exactly `free` bytes available while fn (sync or async) runs; record temp-file creation.
async function withFakeDisk(free, fn) {
  const statfs = fs.statfsSync, open = fs.openSync, seen = { statfsDirs: [], tmpOpens: 0 };
  fs.statfsSync = dir => { seen.statfsDirs.push(dir); return { ...statfs(dir), bavail: free, bsize: 1 }; };
  fs.openSync = (p, ...rest) => { if (String(p).endsWith('.tmp')) seen.tmpOpens++; return open(p, ...rest); };
  try { await fn(); return seen; } finally { fs.statfsSync = statfs; fs.openSync = open; }
}

try {
  const engine = path.join(tmp, 'engine'), vault = path.join(tmp, 'vault');
  fs.mkdirSync(engine); fs.mkdirSync(vault);
  for (const f of ['index-maintenance.mjs', 'config.mjs']) fs.copyFileSync(path.join(import.meta.dirname, f), path.join(engine, f));
  fs.writeFileSync(path.join(engine, 'neurolink.config.json'), JSON.stringify({ vault, home: tmp, logDir: tmp }));
  const { atomicIndex, buildIndex, validateIndex, MODEL } = await import(pathToFileURL(path.join(engine, 'index-maintenance.mjs')));

  // 1. Only `vec` arrays are rounded; every other float is written exactly.
  const out = path.join(engine, 'unit.json');
  const index = {
    builtAt: 1759853412345.6787, other: 0.123456789012345,
    manifest: { 'a.md': { key: [4096, 1759853412345.6787, 1759853412346.1234567, 987654321] } },
    chunks: [{ mtime: 0.987654321987654, vec: [0.12345678901234567, -0.9876543210987654, 1e-9, 0.5, -0.0000004, 0.30000001192092896] }],
    entries: [{ key: 'f'.repeat(64), vec: [0.11111111111111, -0.22222277777777] }],
  };
  atomicIndex(out, index);
  const text = fs.readFileSync(out, 'utf8'), back = JSON.parse(text); // valid JSON
  assert.deepStrictEqual(back.chunks[0].vec, [0.123457, -0.987654, 0, 0.5, 0, 0.3], 'chunk vectors rounded to 6 decimals');
  assert.deepStrictEqual(back.entries[0].vec, [0.111111, -0.222223], 'checkpoint vectors rounded to 6 decimals');
  for (const v of [...back.chunks[0].vec, ...back.entries[0].vec]) assert.ok(decimals(v) <= 6, `${v} has at most 6 decimals`);
  assert.strictEqual(back.builtAt, index.builtAt, 'builtAt untouched');
  assert.strictEqual(back.other, index.other, 'other floats untouched');
  assert.strictEqual(back.chunks[0].mtime, index.chunks[0].mtime, 'chunk mtime untouched');
  assert.deepStrictEqual(back.manifest, index.manifest, 'manifest stat keys untouched');
  assert.strictEqual(index.chunks[0].vec[0], 0.12345678901234567, 'the in-memory index is not modified');
  atomicIndex(out, back);
  assert.strictEqual(fs.readFileSync(out, 'utf8'), text, 'rounding again changes nothing');
  assert.deepStrictEqual(tmpFiles(engine), [], 'no temp file left behind');

  // 2. The disk check runs before any temp file exists; the limit is serialized string length + 256 MiB.
  const size = text.length, sameSize = { ...back, other: 0.123456789012346 };
  let seen = await withFakeDisk(size + 256 * MiB, () => atomicIndex(out, back));
  assert.deepStrictEqual(seen.statfsDirs, [engine], 'free space is checked on the index folder');
  assert.strictEqual(seen.tmpOpens, 1, 'exactly enough room: the write goes ahead');
  seen = await withFakeDisk(size + 256 * MiB - 1, () => assert.throws(() => atomicIndex(out, sameSize), e =>
    e.code === 'INDEX_DISK_LOW' && /^INSUFFICIENT_DISK: index write needs \d+\.\d MiB \(\d+\.\d MiB \+ 256 MiB headroom\), \d+\.\d MiB free$/.test(e.message)));
  assert.strictEqual(seen.tmpOpens, 0, 'one byte short: no temp file is created');
  assert.strictEqual(fs.readFileSync(out, 'utf8'), text, 'refused write leaves the old file intact');
  assert.deepStrictEqual(tmpFiles(engine), [], 'refused write leaves no temp file');

  // 3. Through buildIndex: vectors land rounded, stat keys stay exact, reused vectors are stable, low disk keeps the old index.
  const idxFile = path.join(engine, 'rag-index.json');
  const embedder = async texts => texts.map((t, i) => Array.from(new Float32Array(8).map((_, j) => Math.sin(t.length + i * 7 + j + 0.123456789))));
  const note = (name, body) => fs.writeFileSync(path.join(vault, name), `# ${name}\n\n${body} — a note long enough to be indexed as its own chunk.\n`);
  note('one.md', 'First'); note('two.md', 'Second');
  const first = await buildIndex({ vault, out: idxFile, embedder, full: true, log: () => {} });
  const disk1 = validateIndex(JSON.parse(fs.readFileSync(idxFile, 'utf8')), MODEL, vault);
  assert.strictEqual(disk1.chunks.length, 2);
  for (const c of disk1.chunks) {
    const mem = first.chunks.find(x => x.file === c.file);
    assert.ok(c.vec.every(v => decimals(v) <= 6), 'built vectors have at most 6 decimals');
    assert.ok(c.vec.some((v, j) => v !== mem.vec[j]), 'full-precision vectors were actually rounded');
    assert.ok(c.vec.every((v, j) => Math.abs(v - mem.vec[j]) <= 5e-7 + 1e-12), 'rounding error is at most half a millionth');
    assert.strictEqual(c.mtime, mem.mtime, 'chunk mtime untouched');
    assert.deepStrictEqual(disk1.manifest[c.file], first.manifest[c.file], 'manifest stat key and hash untouched');
  }
  note('three.md', 'Third');
  await buildIndex({ vault, out: idxFile, embedder, log: () => {} });
  const disk2 = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
  assert.strictEqual(disk2.chunks.length, 3);
  for (const c of disk1.chunks) assert.deepStrictEqual(disk2.chunks.find(x => x.file === c.file).vec, c.vec, 'reused vectors are written unchanged');
  const before = fs.readFileSync(idxFile, 'utf8');
  note('four.md', 'Fourth');
  await withFakeDisk(1024, () => assert.rejects(buildIndex({ vault, out: idxFile, embedder, log: () => {} }),
    e => e.code === 'INDEX_DISK_LOW' && e.message.startsWith('INSUFFICIENT_DISK:')));
  assert.strictEqual(fs.readFileSync(idxFile, 'utf8'), before, 'low disk keeps the previous index');
  assert.deepStrictEqual(tmpFiles(engine), [], 'low disk leaves no temp file');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('✓ index writes round only vectors, stay exact elsewhere, and refuse to start without disk room');
