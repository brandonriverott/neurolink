/* test-health.mjs — health.mjs must run its checks when started through a symlinked folder, not exit silently.
   Run: node test-health.mjs
   Uses a throwaway copy with its own config and home, so it never touches your real brain files. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'health-')));
const real = path.join(tmp, 'engine');
fs.mkdirSync(real);
for (const f of ['health.mjs', 'config.mjs']) fs.copyFileSync(path.join(import.meta.dirname, f), path.join(real, f));
fs.writeFileSync(path.join(real, 'neurolink.config.json'), JSON.stringify({ vault: tmp, home: tmp, logDir: tmp }));
fs.symlinkSync(real, path.join(tmp, 'link'));

const env = {
  ...process.env, NEUROLINK_HOME: tmp, NEUROLINK_VAULT: tmp, NEUROLINK_REFLECT_QUEUE: path.join(tmp, 'q'),
  NEUROLINK_RAG_URL: 'http://127.0.0.1:9', NEUROLINK_LAUNCHCTL_CMD: 'false', NEUROLINK_LAUNCHD_DIR: tmp,
  NEUROLINK_LOG: path.join(tmp, 'neuron-log.jsonl'), NEUROLINK_SELFTEST_LOG: path.join(tmp, 'selftest-log.jsonl'),
  NEUROLINK_REFRESH_LOG: path.join(tmp, 'refresh.log'),
};
const run = (...args) => execFileSync(process.execPath, args, { env, encoding: 'utf8' });

try {
  assert.match(run(path.join(real, 'health.mjs')), /brain health/, 'direct run prints the report');
  assert.match(run(path.join(tmp, 'link', 'health.mjs')), /brain health/, 'run through a symlink prints the report');
  const url = pathToFileURL(path.join(tmp, 'link', 'health.mjs')).href;
  assert.doesNotMatch(run('--input-type=module', '-e', `await import(${JSON.stringify(url)})`), /brain health/,
    'importing health.mjs does not run it');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('✓ health.mjs runs directly and through a symlink, and not when imported');
