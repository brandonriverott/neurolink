/* reflect-queue.mjs — atomic queue mechanics for the event-triggered neuron loop.
   Kept tiny and side-effect-only-on-fs so test-reflect.mjs can drive it against temp dirs.

   Layout:
     reflect-queue/             ← launchd QueueDirectories watches THIS; holds ONLY event files
     reflect-queue.processing/  ← in-flight events (SIBLING dir, drained here immediately)
     reflect-queue.failed/      ← poison / neuron-errored events (SIBLING, kept for inspection)

   NOTE: the sidecars are SIBLINGS, not children. launchd's QueueDirectories counts ANY entry
   (including dot-dirs like .processing) as making the watched dir non-empty, which would refire
   the job forever. Keeping sidecars outside the watched dir lets drain() leave it truly empty so
   launchd stops. (Verified against real launchd 2026-06-26 — it does NOT ignore dotfiles here.)
*/
import fs from 'node:fs';
import path from 'node:path';

export const procDir = q => `${q}.processing`;
export const failDir = q => `${q}.failed`;

// Atomically move every pending event from the watched dir into .processing and
// return the in-flight event paths (including any orphans from a crashed prior run).
// Emptying the watched dir up front is the "events arriving mid-run aren't lost"
// + "launchd can't refire on in-flight work" guarantee.
export function drain(queueDir) {
  const proc = procDir(queueDir), fail = failDir(queueDir);
  for (const d of [queueDir, proc, fail]) fs.mkdirSync(d, { recursive: true });
  let pending = [];
  try { pending = fs.readdirSync(queueDir, { withFileTypes: true }).filter(e => e.isFile() && !e.name.startsWith('.')); } catch {}
  for (const e of pending) {
    try { fs.renameSync(path.join(queueDir, e.name), path.join(proc, e.name)); } catch {}
  }
  let names = [];
  try { names = fs.readdirSync(proc).filter(n => !n.startsWith('.')); } catch {}
  return names.map(n => path.join(proc, n));
}

// Delete succeeded events; move failed ones to .failed. ALWAYS leaves .processing
// empty so a poison entry can never cause an infinite refire loop.
export function finish(queueDir, succeeded = [], failed = []) {
  const fail = failDir(queueDir);
  fs.mkdirSync(fail, { recursive: true });
  for (const f of failed) { try { fs.renameSync(f, path.join(fail, path.basename(f))); } catch {} }
  for (const f of succeeded) { try { fs.unlinkSync(f); } catch {} }
}
