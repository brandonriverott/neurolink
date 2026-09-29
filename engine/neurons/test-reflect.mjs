/* test-reflect.mjs — invariants for the event queue. Run: node neurons/test-reflect.mjs
   Proves: drain empties the watched dir; finish never leaves anything in queue/.processing;
   a failed event lands in .failed (the no-infinite-refire guarantee). */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { drain, finish, procDir, failDir } from './reflect-queue.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reflectq-'));
const Q = path.join(tmp, 'reflect-queue');
const ls = d => { try { return fs.readdirSync(d).filter(n => !n.startsWith('.')); } catch { return []; } };
const drop = (name, body = 'x') => { fs.mkdirSync(Q, { recursive: true }); fs.writeFileSync(path.join(Q, name), body); };

// 1. empty queue → drain returns nothing
assert.deepEqual(drain(Q), [], 'empty queue yields no events');

// 2. drain moves real events out of the watched dir into .processing
drop('event-a.txt'); drop('event-b.txt');
const ev = drain(Q);
assert.equal(ev.length, 2, 'both events drained');
assert.deepEqual(ls(Q), [], 'watched dir empty after drain');
assert.equal(ls(procDir(Q)).length, 2, 'events now in .processing');

// 3. success path: finish deletes processed, leaves everything empty
finish(Q, ev, []);
assert.deepEqual(ls(Q), [], 'queue empty after success');
assert.deepEqual(ls(procDir(Q)), [], '.processing empty after success');
assert.deepEqual(ls(failDir(Q)), [], 'nothing failed');

// 4. poison path: a failed event lands in .failed, nothing stranded → no refire
drop('event-bad.txt');
const ev2 = drain(Q);
finish(Q, [], ev2);                 // simulate neuron error → all to .failed
assert.deepEqual(ls(Q), [], 'queue empty after failure');
assert.deepEqual(ls(procDir(Q)), [], '.processing empty after failure');
assert.deepEqual(ls(failDir(Q)), ['event-bad.txt'], 'poison event preserved in .failed');

// 5. dot-files in the watched dir are ignored (so .processing/.failed sidecars never count as events)
fs.writeFileSync(path.join(Q, '.DS_Store'), 'junk');
assert.deepEqual(drain(Q), [], 'dotfiles are not events');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('✓ all reflect-queue invariants hold');
