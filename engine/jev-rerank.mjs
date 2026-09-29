// jev-rerank.mjs — optional second-stage rerank of Neurolink hits by Jev (TypeSafe System One).
// Sends vault text to Jev — only enable it if you are OK with that (the owner approved it on 2026-09-22).
// Measured 2026-09-22 (20 recall probes): right-note@3 15→17/20, answer-text@1 9→12/20, +~0.6 s.
// Fail-open: any error or timeout returns the original order with `jev: {error}` so retrieval never breaks.
// ponytail: one call per query; score = expected value on the 0-3 criteria scale (a float); a key file / env override if ~/.zshrc ever changes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const CRITERIA = ['Unrelated', 'Same topic, does not contain the answer', 'Contains part of the answer', 'Directly contains the answer'];

export function jevKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    const m = fs.readFileSync(path.join(os.homedir(), '.zshrc'), 'utf8').match(/^export TYPESAFE_API_KEY="([^"]+)"/m);
    return m ? m[1] : '';
  } catch { return ''; }
}

export async function jevRerank(q, hits, { timeoutMs = 1800 } = {}) {  // under the hook's 2.5 s first attempt
  const key = jevKey();
  if (!key) return { hits, jev: { error: 'no TYPESAFE_API_KEY' } };
  const passages = {}, questions = {};
  hits.forEach((h, i) => {
    passages['p' + i] = String(h.source_context || h.snippet || '').slice(0, 1000);
    questions['p' + i] = { type: 'score', instructions: `How well does \`passages.p${i}\` answer \`question\`?`, criteria: CRITERIA };
  });
  const t0 = Date.now();
  try {
    const r = await fetch(JEV_URL, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state: { question: q, passages }, questions }),
    });
    if (!r.ok) return { hits, jev: { error: 'http ' + r.status, ms: Date.now() - t0 } };
    const data = await r.json();
    const scored = hits.map((h, i) => ({ ...h, jev_score: data.answers?.['p' + i]?.score ?? 0, base_rank: i + 1 }));
    scored.sort((a, b) => (b.jev_score - a.jev_score) || (a.base_rank - b.base_rank));
    return { hits: scored, jev: { model: data.model, ms: Date.now() - t0 } };
  } catch (e) {
    return { hits, jev: { error: String(e?.name === 'TimeoutError' ? 'timeout' : e), ms: Date.now() - t0 } };
  }
}
