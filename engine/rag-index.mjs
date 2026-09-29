#!/usr/bin/env node
// Vault indexer: builds rag-index.json from the vault in your config.
import path from 'node:path';
import {buildIndex,withIndexLock,MODEL} from './index-maintenance.mjs';
import {CONFIG} from './config.mjs';
const vault=CONFIG.vault;
const out=path.join(import.meta.dirname,'rag-index.json');
let embed;
try {
  await withIndexLock(out,()=>buildIndex({vault,out,full:process.argv.includes('--full'),embedder:async texts=>{
    if(!embed){const {pipeline}=await import('@huggingface/transformers');embed=await pipeline('feature-extraction',MODEL);}
    const result=await embed(texts,{pooling:'mean',normalize:true});
    return texts.map((_,i)=>Array.from(result.data.slice(i*result.dims[1],(i+1)*result.dims[1])));
  }}));
}catch(e){console.error(e.message);process.exitCode=e.code==='INDEX_BUSY'?75:1;}
