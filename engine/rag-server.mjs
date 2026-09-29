#!/usr/bin/env node
/* ============================================================
   rag-server.mjs — the brain's backend.
   - loads rag-index.json into memory (packed Float32 matrix)
   - embeds queries on-device (MiniLM)
   - GET /search?q=&k=  → hybrid (semantic + keyword) + wikilink graph-expand
   - POST /chat         → RAG → Claude (only if ANTHROPIC_API_KEY set; else retrieval-only)
   - serves the cockpit at /  (so chat fetches are same-origin)

   Run:  node rag-server.mjs      then open http://localhost:8920
   ============================================================ */
import { execFile } from 'node:child_process';
import { pipeline } from '@huggingface/transformers';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { scanVaultGraph } from './vault-graph.mjs';
import { LiveIndex } from './live-index.mjs';
import { jevRerank } from './jev-rerank.mjs';
import { CONFIG } from './config.mjs';

// live graph for the HD brain — scanned on demand, cached briefly (opens are rare)
let _graphCache = null, _graphAt = 0;
function liveGraph() {
  if (_graphCache && Date.now() - _graphAt < 15000) return _graphCache;
  _graphCache = scanVaultGraph(); _graphAt = Date.now();
  return _graphCache;
}

const DIR = import.meta.dirname;
const PORT = 8920;
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const STOP = new Set('the a an of to in on for and or is are was were be been it this that with as at by from i you he she they we my your our me him her them his their its can could would should do does did how what who why when where which'.split(' '));

console.log('loading index…');
const liveIndex=new LiveIndex({out:path.join(DIR,'rag-index.json'),vault:CONFIG.vault,model:MODEL,
  refresh:()=>new Promise((resolve,reject)=>execFile(process.execPath,[path.join(DIR,'rag-index.mjs')],{cwd:DIR,timeout:20*60*1000,maxBuffer:2*1024*1024},err=>err?reject(err):resolve()))});
await liveIndex.load();
console.log(`✓ ${liveIndex.health().chunks} chunks · dim ${liveIndex.health().dim} · model ${MODEL}`);
liveIndex.start();

console.log('loading embedder…');
const embed = await pipeline('feature-extraction', MODEL);
async function embedQuery(q) {
  const out = await embed([q], { pooling: 'mean', normalize: true });
  return out.data; // Float32Array(DIM), normalized
}

async function retrieve(q, k, includeSelf = false) {
  const searchIndex=liveIndex.search;
  const direct = searchIndex.exact(q, k, { includeSelf });
  if (direct !== null) return direct;
  return searchIndex.search(await embedQuery(q), terms(q), k, { query: q, includeSelf });
}
function terms(q) { return [...new Set(q.toLowerCase().match(/[a-z0-9]{2,}/g) || [])].filter(t => !STOP.has(t)); }

// ---- Claude reasoning via claude -p headless (subscription, no API key) ----
const CLAUDE_VIA_CLI = true;
function callClaudeAsync(prompt) {
  return new Promise((resolve, reject) => {
    execFile('claude', ['-p', prompt], { encoding: 'utf8', maxBuffer: 1 << 24, cwd: '/tmp', timeout: 120000, killSignal: 'SIGKILL' }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}
async function answerWithClaude(question, hits) {
  const context = hits.map((h, n) => `[${n + 1}] ${h.title}${h.heading ? ' › ' + h.heading : ''} (${h.file})\nEvidence: ${h.evidence_tier}; ${h.guidance_status}; ${h.content_status}. ${h.evidence_notice}\n${h.snippet}`).join('\n\n');
  const prompt = `You are ${CONFIG.ownerName}'s second brain. Answer ONLY from the provided context from their Obsidian vault. Cite sources as [n]. If the context doesn't cover it, say so plainly. Rejected and pending evidence is never active guidance; receipts and historical sources do not prove current state. Respect each source evidence label and say when current state needs verification. Be concise and direct.\n\nQuestion: ${question}\n\nContext from the vault:\n${context}`;
  return await callClaudeAsync(prompt);
}

// ---- http ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
function serveFile(res, file) {
  try {
    const buf = fs.readFileSync(path.join(DIR, file));
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'text/plain' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
}
function json(res, obj, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Listen on this machine plus any extra addresses from config listenHosts (e.g. a Tailscale IP for a
// second computer) — never on the open local network: /chat runs Claude (2026-09-23).
const HOSTS = ['127.0.0.1', ...CONFIG.listenHosts];
const SAME_HOSTS = new Set([...HOSTS, 'localhost'].map(h => `${h}:${PORT}`.toLowerCase()));
const SAME_ORIGINS = new Set([...SAME_HOSTS].map(h => `http://${h}`));

// A browser page from another site must not read vault text, run Claude, or trigger Jev here
// (no CORS headers are sent, and cross-site browser requests are refused outright). The brain's
// own pages are same-origin; hooks, a second computer and other scripts send neither header.
// Link clicks to the brain page stay allowed: the linking page cannot read it.
// The Host check stops DNS rebinding: a hostile domain re-pointed at this machine looks same-origin
// to the browser, but its requests still carry that domain as Host.
function foreign(req, page) {
  const o = req.headers.origin, site = req.headers['sec-fetch-site'];
  return !SAME_HOSTS.has((req.headers.host || '').toLowerCase()) || (o && !SAME_ORIGINS.has(o)) || (site && site !== 'same-origin' && site !== 'none' && !(page && req.headers['sec-fetch-mode'] === 'navigate'));
}

async function handle(req, res) {
  // Every response: no framing (clickjacking), no MIME sniffing, no cross-site <script>/<img> reads.
  res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (foreign(req, u.pathname === '/' || u.pathname === '/brain.html')) return json(res, { error: 'forbidden origin' }, 403);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (u.pathname === '/' || u.pathname === '/brain.html') return serveFile(res, 'brain.html');
  // vault-data.js is not served: plain-http addresses (e.g. Tailscale) send no Sec-Fetch-*, so another
  // site's <script src> could read the whole graph. brain.html reads /graph live and tolerates its 404.
  if (u.pathname === '/graph') { try { return json(res, liveGraph()); } catch (e) { return json(res, { error: String(e) }, 500); } }
  if (u.pathname === '/health') return json(res, { ok: true, ...liveIndex.health(), model: MODEL, claude: CLAUDE_VIA_CLI });
  if (u.pathname === '/health/full') {
    try {
      const raw = fs.readFileSync(path.join(DIR, 'health-status.json'), 'utf8');
      const st = JSON.parse(raw);
      if (st.ts && (Date.now() - st.ts) > 6 * 3600 * 1000) return json(res, { error: 'health monitor stale', lastRun: st.ts, age_hours: Math.round((Date.now() - st.ts) / 3600000) });
      return json(res, st);
    } catch { return json(res, { error: 'health monitor not running or no status file' }, 503); }
  }

  if (u.pathname === '/search') {
    // Paid Jev reranks only for callers on the 127.0.0.1 listener (local hooks). Browsers always
    // send Sec-Fetch-* to 127.0.0.1, so foreign() already refuses other sites there; over plain-http
    // listenHosts they send none, and another site's <img> would look like a script. The socket can't be faked.
    // Checked before q so a refused request never reaches retrieval or Jev.
    const rerank = (u.searchParams.get('rerank') || '') === 'jev';
    if (rerank && req.socket.localAddress !== '127.0.0.1') return json(res, { error: 'rerank=jev is only served on 127.0.0.1' }, 403);
    const q = (u.searchParams.get('q') || '').trim();
    const k = Math.min(20, Math.max(1, +(u.searchParams.get('k') || 8)));
    if (!q) return json(res, { error: 'missing q' }, 400);
    // self-read guard is ON by default; ?includeSelf=1 opts a caller back in
    const includeSelf = /^(1|true|yes)$/i.test(u.searchParams.get('includeSelf') || '');
    const t0 = Date.now();
    let hits;try{hits=await retrieve(q,k,includeSelf);}catch(e){return json(res,{error:String(e)},503);}
    // ?rerank=jev → Jev scores every passage and reorders (fail-open). Owner decision 2026-09-22.
    let jev;
    if (rerank) { try { ({ hits, jev } = await jevRerank(q, hits)); } catch (e) { jev = { error: String(e) }; } }
    return json(res, { q, ms: Date.now() - t0, selfReadGuard: !includeSelf, ...(jev ? { jev } : {}), hits });
  }

  if (u.pathname === '/chat' && req.method === 'POST') {
    let raw = ''; for await (const c of req) raw += c;
    let q = ''; try { q = (JSON.parse(raw || '{}').q || '').trim(); } catch {}
    if (!q) return json(res, { error: 'missing q' }, 400);
    const hits = await retrieve(q, 8);  // self-read guard: brain never reasons over its own past output
    if (!CLAUDE_VIA_CLI) return json(res, { mode: 'retrieval-only', q, hits });
    try { const answer = await answerWithClaude(q, hits); return json(res, { mode: 'claude', q, answer, hits }); }
    catch (e) { return json(res, { mode: 'retrieval-only', q, hits, error: String(e) }); }
  }

  res.writeHead(404); res.end('not found');
}

const servers = [];
let stopping = false;
function listenOn(host) {
  // Any throw in handle (e.g. new URL on a request for '//') must answer, not become an
  // unhandled rejection that exits the process — any web page could send that request.
  const server = http.createServer((req, res) => handle(req, res).catch(e => { console.error('handler error', req.method, req.url, e); if (!res.headersSent) json(res, { error: 'server error' }, 500); else res.destroy(); }));
  // Tailscale may not be up yet at boot; keep retrying without taking down localhost.
  server.once('error', e => { console.log(`listen ${host}:${PORT} failed (${e.code}); retrying in 60s`); if (!stopping) setTimeout(() => listenOn(host), 60000).unref(); });
  server.listen(PORT, host, () => { servers.push(server); console.log(`🧠 Neurolink brain server  →  http://${host}:${PORT}`); });
}
HOSTS.forEach(listenOn);
console.log(`   /search?q=…   /chat (POST)   /health`);
console.log(`   Claude reasoning: ENABLED via claude -p (subscription, no API key)\n`);

// Supported future shutdowns stop accepting work and let in-flight requests
// and the current index subprocess finish instead of forcing a restart.
process.once('SIGTERM',()=>{stopping=true;liveIndex.stop();servers.forEach(s=>s.close());});
