import * as ort from 'onnxruntime-web/wasm';
import {getEncoding} from 'js-tiktoken';

let session, py, encoding, manifest, cancelled=false, loading;
const send = (type, value={}) => postMessage({type,...value});

async function initialize(threads=4) {
  if(session) return;
  if(loading) return loading;
  loading=(async()=>{
    const started=performance.now();
    manifest=await (await fetch('./public/manifest.json')).json();
    send('status',{text:'Загрузка Python AST и токенизатора…'});
    const {loadPyodide}=await import('./node_modules/pyodide/pyodide.mjs?v=1');
    py=await loadPyodide({indexURL:new URL('./node_modules/pyodide/',self.location).href});
    py.runPython(await (await fetch('./public/preprocess.py')).text());
    encoding=getEncoding('gpt2');
    const cache=await caches.open('codenarrator-browser-model');
    const url=manifest.model_url || new URL(`./public/${manifest.model_file||'model.fp32.onnx'}?v=${manifest.model_sha256}`,self.location).href;
    let response=await cache.match(url);
    const cached=!!response;
    if(!response) response=await fetch(url);
    if(!response.ok) throw Error(`Не удалось загрузить веса: HTTP ${response.status}`);
    // Store the response in parallel; no remote model or inference requests.
    const storing=!cached ? cache.put(url,response.clone()).catch(()=>{}) : Promise.resolve();
    const bytes=new Uint8Array(manifest.bytes), reader=response.body.getReader();
    let received=0;
    while(true){
      const {value,done}=await reader.read(); if(done) break;
      bytes.set(value,received); received+=value.length;
      send('status',{text:`${cached?'Чтение из кэша':'Загрузка весов'}: ${Math.round(received/manifest.bytes*100)}% · ${Math.round(received/1e6)} МБ`});
    }
    if(received!==manifest.bytes) throw Error('Файл модели загружен не полностью');
    send('status',{text:'Проверка SHA-256 весов…'});
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    if(hash!==manifest.model_sha256) throw Error('Контрольная сумма модели не совпала');
    ort.env.wasm.wasmPaths=new URL('./node_modules/onnxruntime-web/dist/',self.location).href;
    ort.env.wasm.numThreads=self.crossOriginIsolated ? threads : 1;
    send('status',{text:`Подготовка модели · WASM CPU · ${ort.env.wasm.numThreads} потока…`});
    session=await ort.InferenceSession.create(bytes,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
    await storing;
    send('ready',{loadSeconds:(performance.now()-started)/1000,cached,threads:ort.env.wasm.numThreads,manifest});
  })();
  try {await loading;} catch(e){loading=null;throw e;}
}

function prepare(code){
  py.globals.set('browser_source',code);
  const data=JSON.parse(py.runPython('prepare(browser_source)'));
  const ids=encoding.encode(data.prompt,[],[]);
  return {...data,ids:ids.length?ids:[50256]};
}
function restore(text,mapping){
  py.globals.set('browser_output',text);
  py.globals.set('browser_mapping_json',JSON.stringify(mapping));
  return py.runPython('restore_names(browser_output, json.loads(browser_mapping_json))');
}

async function generate(code,maxTokens=768,reference=null){
  const prepared=prepare(code), inputIds=prepared.ids;
  if(inputIds.length>992) throw Error('Текст превышает доступный контекст модели. Сократите ввод.');
  const budget=Math.min(maxTokens,1024-inputIds.length);
  let ids=inputIds, offset=0, past=Array.from({length:24},()=>new ort.Tensor('float32',new Float32Array(0),[1,12,0,64]));
  const tokens=[],started=performance.now(); let first=null,finished=false,text='';
  const stepTimes=[];
  try {
    for(let step=0;step<budget&&!cancelled;step++){
      const feeds={ids:new ort.Tensor('int64',BigInt64Array.from(ids,BigInt),[1,ids.length]),positions:new ort.Tensor('int64',BigInt64Array.from(ids,(_,i)=>BigInt(offset+i)),[ids.length])};
      if(manifest.snippet_adapter)feeds.snippet_mode=new ort.Tensor('float32',new Float32Array([prepared.input_mode==='snippet'?1:0]),[1]);
      past.forEach((tensor,i)=>feeds[`past_${i}`]=tensor);
      const before=performance.now(), output=await session.run(feeds);
      stepTimes.push(performance.now()-before);
      Object.values(feeds).forEach(t=>t.dispose());
      past=Array.from({length:24},(_,i)=>output[`present_${i}`]);
      const logits=output.logits.data;
      let token=0; for(let i=1;i<50257;i++)if(logits[i]>logits[token])token=i;
      output.logits.dispose();
      offset+=ids.length;
      if(first===null)first=performance.now();
      if(token===50256){finished=true;break;}
      tokens.push(token);ids=[token];
      text=restore(encoding.decode(tokens),prepared.mapping);
      send('token',{text,tokens:tokens.length,elapsed:(performance.now()-started)/1000});
      // WASM promises alone can starve the worker's message queue. Yield a task
      // so Stop is handled during decoding, rather than after the full answer.
      if(step%4===3) await new Promise(resolve=>setTimeout(resolve,0));
    }
  }finally{past.forEach(t=>t.dispose());}
  const seconds=(performance.now()-started)/1000;
  const stats={seconds,inputTokens:inputIds.length,generatedTokens:tokens.length,tokensPerSecond:tokens.length/seconds,
    firstTokenSeconds:(first-started)/1000,decodeTokensPerSecond:stepTimes.length>1?(stepTimes.length-1)/(stepTimes.slice(1).reduce((a,b)=>a+b,0)/1000):null,
    finished,cancelled,truncated:!finished&&!cancelled,inputMode:prepared.input_mode,backend:'wasm-cpu',threads:ort.env.wasm.numThreads,
    checkpointSha256:manifest.checkpoint_sha256,onnxSha256:manifest.model_sha256,
    exactReferenceMatch:reference?JSON.stringify(tokens)===JSON.stringify(reference):null};
  send('done',{text,stats}); return {code,text,stats,tokens};
}

self.onmessage=async({data})=>{
  if(data.type==='stop'){cancelled=true;return;}
  try{
    cancelled=false;
    await initialize(data.threads||4);
    if(data.type==='generate') await generate(data.code,data.maxTokens);
    if(data.type==='benchmark'){
      const cases=await(await fetch(data.casesFile||'./public/verification_cases.json')).json(),results=[];
      for(const item of cases){
        if(cancelled)break;
        send('case',{name:item.name,code:item.code,index:results.length+1,total:cases.length});
        const result=await generate(item.code,768,item.tokens);results.push({...result,id:item.id,name:item.name});
      }
      send('benchmark',{results,userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,crossOriginIsolated:self.crossOriginIsolated});
    }
  }catch(e){send('error',{text:String(e.stack||e)});}
};
