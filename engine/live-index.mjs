import fs from 'node:fs';
import {createSearchIndex} from './retrieval-search.mjs';
import {scanVault,validateIndex} from './index-maintenance.mjs';

// Snapshot replacement is atomic from the request handler's perspective. A bad
// or half-written external index never displaces the last validated snapshot.
// Each rebuild re-parses the ~500 MB index on the main thread, which froze the
// server for minutes on a swapping Mac (2026-09-23), so rebuilds are rate-limited.
// ponytail: fixed gap; a binary vector file loaded off-thread is the real upgrade.
const MIN_REFRESH_GAP_MS = 10 * 60 * 1000;
export class LiveIndex {
  constructor({out,vault,model,refresh,log=console.log}) {
    Object.assign(this,{out,vault,model,refresh,log});this.snapshot=null;this.error=null;this.busy=false;this.timer=null;this.checkedAt=null;this.observedFingerprint=null;this.version=null;this.lastRefreshAt=0;
  }
  async load() {
    try {
      const stat=fs.statSync(this.out),version=`${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      if(this.snapshot&&version===this.version)return false;
      const idx=validateIndex(JSON.parse(await fs.promises.readFile(this.out,'utf8')),this.model,this.vault);
      const matrix=new Float32Array(idx.chunks.length*idx.dim);
      const meta=idx.chunks.map((c,i)=>{matrix.set(c.vec,i*idx.dim);return {file:c.file,title:c.title,region:c.region,heading:c.heading,mtime:c.mtime,text:c.text,lc:c.text.toLowerCase(),links:c.links||[]};});
      const search=createSearchIndex({meta,matrix,dim:idx.dim,vaultRoot:idx.vault});
      this.snapshot={search,chunks:meta.length,dim:idx.dim,builtAt:idx.builtAt,fingerprint:idx.fingerprint};
      this.version=version;this.error=null;return true;
    }catch(e){this.error=e.message;throw e;}
  }
  get search(){if(!this.snapshot)throw Error('Index has not loaded');return this.snapshot.search;}
  health(){return {chunks:this.snapshot?.chunks||0,dim:this.snapshot?.dim||0,index_built_at:this.snapshot?.builtAt||null,
    source_scan_at:this.checkedAt,refresh_in_progress:this.busy,
    freshness:this.error?'error':this.snapshot?.fingerprint&&this.observedFingerprint===this.snapshot.fingerprint?'current':this.busy?'refreshing':'unchecked_or_stale',
    ...(this.error?{index_error:this.error}:{})};}
  async tick(){
    if(this.busy)return;this.busy=true;
    try {
      let diskInvalid=false;try{await this.load();}catch{diskInvalid=true;}
      const scan=scanVault(this.vault);this.observedFingerprint=scan.fingerprint;this.checkedAt=Date.now();
      const due=diskInvalid||Date.now()-this.lastRefreshAt>=MIN_REFRESH_GAP_MS;
      if((diskInvalid||this.snapshot?.fingerprint!==scan.fingerprint)&&this.refresh){if(due){this.lastRefreshAt=Date.now();await this.refresh();await this.load();}}
      else if(diskInvalid)throw Error('Disk index is invalid and no refresh runner is available');
      this.error=null;
    }catch(e){this.error=e.message;this.log('Index freshness check: '+e.message);}
    finally{this.busy=false;}
  }
  start(ms=60000){if(!this.timer){this.timer=setInterval(()=>void this.tick(),ms);this.timer.unref();void this.tick();}}
  stop(){clearInterval(this.timer);this.timer=null;}
}
