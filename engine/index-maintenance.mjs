import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {CONFIG, PRIVATE_NAME as EXCLUDE_NAME, regionFor} from './config.mjs';
export const MODEL = 'Xenova/all-MiniLM-L6-v2';
const EXCLUDE_DIRS = new Set(['.obsidian', '.git', '.trash', 'node_modules', 'templates', '_archive', '_attachments']);
// Vault-relative folders never indexed (config indexExcludePaths). Keep _inbox there: a proposal queue is
// receipts, not truth, rewritten every few minutes; indexing it forced constant rebuilds (2026-09-23).
const EXCLUDE_PATH = CONFIG.indexExcludePaths.map(x => x.toLowerCase());
const CHUNK_CHARS = 900;
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const statKey = st => [st.size, st.mtimeMs, st.ctimeMs, st.ino];

// Metadata scans never follow child symlinks or read excluded content. Any I/O
// failure aborts the refresh so an unavailable folder cannot erase good results.
export function scanVault(vault) {
  const files = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      const abs=path.join(dir,e.name), rel=path.relative(vault,abs).split(path.sep).join('/');
      if(e.isDirectory()) {
        if(EXCLUDE_DIRS.has(e.name)||EXCLUDE_PATH.some(x=>rel.toLowerCase()===x||rel.toLowerCase().startsWith(x+'/')))continue;
        walk(abs);
      } else if(e.isFile()&&e.name.toLowerCase().endsWith('.md')&&!EXCLUDE_NAME.test(e.name)) {
        files.push({abs,rel,key:statKey(fs.statSync(abs))});
      }
    }
  }
  walk(vault);
  return {files,fingerprint:sha(JSON.stringify(files.map(({rel,key})=>[rel,...key])))};
}

export function validateIndex(idx, model, vault) {
  if (!idx || idx.model!==model || !Number.isInteger(idx.dim) || idx.dim<1 || !Array.isArray(idx.chunks) ||
      !Number.isFinite(idx.builtAt) || fs.realpathSync(idx.vault)!==fs.realpathSync(vault))throw Error('Index model, shape or vault identity mismatch');
  for(const c of idx.chunks) {
    if(typeof c.file!=='string'||path.isAbsolute(c.file)||c.file.split(/[\\/]/).includes('..')||typeof c.text!=='string'||
      !Array.isArray(c.vec)||c.vec.length!==idx.dim||!c.vec.every(Number.isFinite))throw Error('Invalid index chunk');
  }
  return idx;
}

// Vectors were ~87% of the index (2026-10-07) and float32 values print as ~18-digit doubles; 6 decimals keeps
// the cosine ranking and halves the file, keeping it under Node's max string length (readFile/JSON.stringify fail past it).
// Only `vec` is rounded: mtime/statKey floats are cache keys. Re-rounding a rounded value changes nothing.
const r6=x=>Math.round(x*1e6)/1e6;
const roundVecs=(k,v)=>k==='vec'&&Array.isArray(v)?v.map(r6):v;
const DISK_HEADROOM=256*1024*1024;
export function atomicIndex(out,index) {
  const json=JSON.stringify(index,roundVecs),bytes=json.length;
  // The temp copy sits beside the old file until rename: refuse up front instead of dying mid-write with ENOSPC.
  // String length estimates the bytes; the 256 MiB margin covers multi-byte UTF-8 text (~0.6 MB on 2026-10-07).
  const st=fs.statfsSync(path.dirname(out)),free=st.bavail*st.bsize;
  if(free<bytes+DISK_HEADROOM){
    const mib=n=>(n/1048576).toFixed(1);
    const e=Error(`INSUFFICIENT_DISK: index write needs ${mib(bytes+DISK_HEADROOM)} MiB (${mib(bytes)} MiB + 256 MiB headroom), ${mib(free)} MiB free`);
    e.code='INDEX_DISK_LOW';throw e;
  }
  const temp=out+'.'+crypto.randomUUID()+'.tmp';
  try {
    const fd=fs.openSync(temp,'wx',0o600);
    try {fs.writeFileSync(fd,json);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temp,out);
  } finally {if(fs.existsSync(temp))fs.unlinkSync(temp);}
}

// macOS has no Node flock API. A tiny stdlib helper locks an fd opened by
// the FDA-granted Node parent; it never reads the vault. The kernel releases
// the lock after a crash. Keep the lock inode, avoiding unlink/acquire races.
export async function withIndexLock(out,task) {
  const fd=fs.openSync(out+'.lock','a+',0o600);
  const script='import fcntl,sys\ntry: fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(75)\nprint("LOCKED",flush=True)\nsys.stdin.buffer.read()\n';
  const child=spawn('/usr/bin/python3',['-u','-c',script],{stdio:['pipe','pipe','ignore',fd]});
  const exited=new Promise(resolve=>{child.once('exit',code=>resolve(code));child.once('error',()=>resolve(125));});
  try {
    await new Promise((resolve,reject)=>{
      child.stdout.once('data',data=>data.toString().trim()==='LOCKED'?resolve():reject(Error('Invalid OS lock receipt')));
      child.once('error',reject);
      child.once('exit',code=>{const e=Error(code===75?'Index refresh already running':'OS index lock unavailable');e.code=code===75?'INDEX_BUSY':'INDEX_LOCK_ERROR';reject(e);});
    });
    fs.ftruncateSync(fd,0);fs.writeSync(fd,JSON.stringify({pid:process.pid,startedAt:Date.now()}));
    return await task();
  }finally{child.stdin.end();await exited;fs.closeSync(fd);}
}

// regionFor (folder → brain region) comes from config.mjs regionRules.
function prettify(base) {
  return base.replace(/\.md$/i, '').replace(/—/g, '·').replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());
}
function stripFrontmatter(t) {
  if (t.startsWith('---')) { const e = t.indexOf('\n---', 3); if (e !== -1) return t.slice(e + 4); }
  return t;
}
function extractLinks(t) {
  const out = new Set(); const re = /\[\[([^\]|#]+)/g; let m;
  while ((m = re.exec(t))) out.add(m[1].trim());
  return [...out].slice(0, 30);
}
function chunkNote(text, title) {
  const body = stripFrontmatter(text);
  const paras = body.split(/\n{2,}/);
  const chunks = []; let cur = ''; let heading = '';
  const flush = () => { const s = cur.trim(); if (s.length >= 25) chunks.push({ heading, text: s }); cur = ''; };
  for (let p of paras) {
    const h = p.match(/^#{1,6}\s+(.+)$/m);
    if ((h || (cur + '\n\n' + p).length > CHUNK_CHARS) && cur) flush();
    if (h) heading = h[1].replace(/[#*`>]/g, '').trim().slice(0, 80);
    cur += (cur ? '\n\n' : '') + p;
    if (cur.length > CHUNK_CHARS) flush();
  }
  flush();
  return chunks;
}

export async function buildIndex({vault,out,embedder,model=MODEL,full=false,log=console.log}) {
  const scan=scanVault(vault); let prev;
  try{prev=validateIndex(JSON.parse(fs.readFileSync(out,'utf8')),model,vault);}catch{}
  if(!full&&prev?.fingerprint===scan.fingerprint)return prev;
  const oldByFile=new Map();
  if(!full&&prev)for(const c of prev.chunks){if(!oldByFile.has(c.file))oldByFile.set(c.file,[]);oldByFile.get(c.file).push(c);}
  const chunks=[],pending=[],manifest={};
  for(const f of scan.files) {
    const prior=oldByFile.get(f.rel)||[];const oldMeta=prev?.manifest?.[f.rel];
    if(!full&&oldMeta&&JSON.stringify(oldMeta.key)===JSON.stringify(f.key)) {
      manifest[f.rel]=oldMeta;chunks.push(...prior);continue;
    }
    const content=fs.readFileSync(f.abs,'utf8');const hash=sha(content);
    if(JSON.stringify(statKey(fs.statSync(f.abs)))!==JSON.stringify(f.key))throw Error('Source changed while indexing; retry with current files');
    manifest[f.rel]={key:f.key,sha256:hash};
    if(!full&&prior.length&&((oldMeta&&oldMeta.sha256===hash)||(!prev?.manifest&&prior[0].mtime===f.key[1]))) {
      chunks.push(...prior.map(c=>({...c,mtime:f.key[1]})));continue;
    }
    const title=prettify(path.basename(f.abs)),region=regionFor(f.rel),links=extractLinks(content);
    for(const c of chunkNote(content,title))if(!EXCLUDE_NAME.test(c.text))pending.push({file:f.rel,title,region,heading:c.heading,mtime:f.key[1],text:c.text,links});
  }
  let dim=prev?.dim||384;
  for(let i=0;i<pending.length;i+=32) {
    const batch=pending.slice(i,i+32);const vectors=await embedder(batch.map(c=>`${c.title}${c.heading?' › '+c.heading:''}\n${c.text}`));
    if(!Array.isArray(vectors)||vectors.length!==batch.length)throw Error('Embedding batch mismatch');
    dim=vectors[0].length;
    for(let j=0;j<batch.length;j++)batch[j].vec=Array.from(vectors[j]);
    if(i%256===0)log(`embedded ${Math.min(i+32,pending.length)}/${pending.length}`);
  }
  chunks.push(...pending);chunks.forEach((c,i)=>c.id=i);
  // A long rebuild must not overwrite an index with a snapshot already stale.
  if(scanVault(vault).fingerprint!==scan.fingerprint)throw Error('Vault changed during build; previous index retained and refresh will retry');
  const index={schema:2,dim,model,builtAt:Date.now(),fullBuiltAt:full?Date.now():prev?.fullBuiltAt||null,vault,
    fingerprint:scan.fingerprint,manifest,chunks};
  validateIndex(index,model,vault);atomicIndex(out,index);
  log(`indexed ${scan.files.length} notes; ${pending.length} embedded; ${chunks.length} chunks`);
  return index;
}
