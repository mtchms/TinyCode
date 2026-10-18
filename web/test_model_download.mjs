import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {downloadModel} from './model_download.js';
const bytes=Uint8Array.from({length:71},(_,i)=>i);
const sha256=createHash('sha256').update(bytes).digest('hex');
const defaults={url:'https://example.com/model.onnx',size:bytes.length,sha256,storage:undefined};
function stream(parts, failure=false, status=200, headers={}) {
  let index=0;
  return new Response(new ReadableStream({pull(controller){
    if(index<parts.length)controller.enqueue(parts[index++]);
    else if(failure)controller.error(new TypeError('Error in input stream'));
    else controller.close();
  }}),{status,headers});
}
function storage({fail=false}={}) {
  const entries=new Map();
  return {entries,open:async()=>({
    match:async key=>entries.get(key)?.clone(),
    delete:async key=>entries.delete(key),
    put:async(key,response)=>{if(fail)throw Error('QuotaExceededError');entries.set(key,new Response(await response.arrayBuffer()));},
  })};
}
test('accepts complete bytes despite final stream error ONLY after SHA-256 passes',async()=>{
  const messages=[];
  const r=await downloadModel({...defaults,fetcher:async()=>stream([bytes],true),progress:t=>messages.push(t)});
  assert.deepEqual(r.bytes,bytes);assert.equal(r.cached,false);
  assert(!messages.some(t=>t.includes('100%')));
});
test('resumes a truncated transfer with an exact Range request',async()=>{
  let calls=0;
  const r=await downloadModel({...defaults,fetcher:async(url,options)=>{
    if(calls++===0)return stream([bytes.slice(0,23)],true);
    assert.equal(options.headers.Range,'bytes=23-');
    return stream([bytes.slice(23)],false,206,{'Content-Range':'bytes 23-70/71'});
  }});
  assert.deepEqual(r.bytes,bytes);assert.equal(calls,2);
});
test('restarts cleanly when the server ignores Range',async()=>{
  let calls=0;
  const r=await downloadModel({...defaults,fetcher:async()=>calls++===0?stream([bytes.slice(0,23)],true):stream([bytes])});
  assert.deepEqual(r.bytes,bytes);assert.equal(calls,2);
});
test('a full-sized corrupt stream is never accepted',async()=>{
  const bad=bytes.slice();bad[0]=255;
  await assert.rejects(downloadModel({...defaults,fetcher:async()=>stream([bad],true)}),/SHA-256/);
});
test('unavailable or full cache does not prevent model loading',async()=>{
  for(const cache of [storage({fail:true}),{open:async()=>{throw Error('SecurityError');}}]){
    const r=await downloadModel({...defaults,storage:cache,fetcher:async()=>stream([bytes]),chunkSize:16});
    assert.deepEqual(r.bytes,bytes);
  }
});
test('verified chunk cache avoids any second network request',async()=>{
  const cache=storage();let calls=0;
  const options={...defaults,storage:cache,chunkSize:16,fetcher:async()=>{calls++;return stream([bytes]);}};
  await downloadModel(options);
  const r=await downloadModel(options);
  assert.equal(r.cached,true);assert.equal(calls,1);assert.deepEqual(r.bytes,bytes);
});
test('corrupt cached chunk is discarded and downloaded again',async()=>{
  const cache=storage();let calls=0;
  const options={...defaults,storage:cache,chunkSize:16,fetcher:async()=>{calls++;return stream([bytes]);}};
  await downloadModel(options);
  const key=[...cache.entries.keys()].find(k=>k.endsWith('tinycode_part=0'));
  cache.entries.set(key,new Response(new Uint8Array(16)));
  const r=await downloadModel(options);
  assert.equal(r.cached,false);assert.equal(calls,2);assert.deepEqual(r.bytes,bytes);
});
test('repeated incomplete streams stop with a retryable download error',async()=>{
  let calls=0;
  await assert.rejects(downloadModel({...defaults,fetcher:async()=>{calls++;return stream([bytes.slice(0,8)],true);}}),/Не удалось скачать модель/);
  assert.equal(calls,3);
});
