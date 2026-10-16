import * as ort from 'onnxruntime-web/wasm';
import {getEncoding} from 'js-tiktoken';
import {encodeFor} from './generator_encoding.js';

let session,encoding,manifest,loading,cancelled=false;
const send=(type,value={})=>postMessage({type,...value});
const prompt=request=>manifest.output_format==='plan_then_code'?'Write a short plan, then simple Python code.\nRequest: '+request.trim()+'\nPlan:\n':'Write simple Python code for this request. Output only Python code.\nRequest: '+request.trim()+'\nPython:\n';
const parts=raw=>manifest.output_format==='plan_then_code'?{text:raw.includes('Python:\n')?raw.split('Python:\n').slice(1).join('Python:\n').trim():'',plan:raw.split('Python:\n')[0].trim()}:{text:raw,plan:''};
const encodePrompt=text=>encodeFor(text,encoding,manifest.tokenization);

async function initialize(threads=4){
  if(session)return;
  if(loading)return loading;
  loading=(async()=>{
    const started=performance.now();
    const meta=await fetch('./public/generator/manifest.json');
    if(!meta.ok)throw Error('Модель пока не подготовлена');
    manifest=await meta.json();encoding=getEncoding('gpt2');
    const cache=await caches.open('codegenerator-model');
    const url=manifest.model_url || new URL(`./public/generator/${manifest.model_file}?v=${manifest.model_sha256}`,self.location).href;
    let response=await cache.match(url);const cached=!!response;
    if(!response)response=await fetch(url);
    if(!response.ok)throw Error('Не удалось загрузить модель');
    const storing=cached?Promise.resolve():cache.put(url,response.clone()).catch(()=>{});
    const bytes=new Uint8Array(manifest.bytes),reader=response.body.getReader();let received=0;
    while(true){const {done,value}=await reader.read();if(done)break;bytes.set(value,received);received+=value.length;
      send('status',{text:`${cached?'Чтение из кэша':'Загрузка модели'}: ${Math.round(received/manifest.bytes*100)}%`});}
    if(received!==manifest.bytes)throw Error('Файл модели загружен не полностью');
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    if(hash!==manifest.model_sha256)throw Error('Контрольная сумма модели не совпала');
    ort.env.wasm.wasmPaths=new URL('./node_modules/onnxruntime-web/dist/',self.location).href;
    ort.env.wasm.numThreads=self.crossOriginIsolated?threads:1;
    send('status',{text:'Подготовка модели…'});
    session=await ort.InferenceSession.create(bytes,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
    await storing;send('ready',{loadSeconds:(performance.now()-started)/1000,cached,threads:ort.env.wasm.numThreads});
  })();
  try{await loading;}catch(e){loading=null;throw e;}
}

async function generate(request,maxTokens=256){
  let ids=encodePrompt(prompt(request));
  if(ids.length>manifest.context-16)throw Error('Сократите запрос: он превышает контекст модели');
  const inputLength=ids.length,budget=Math.min(maxTokens,manifest.context-inputLength);
  let offset=0,past=Array.from({length:24},()=>new ort.Tensor('float32',new Float32Array(0),[1,12,0,64]));
  let text='',rawText='',plan='',first=null,finished=false;const tokens=[],start=performance.now();
  try{
    for(let step=0;step<budget&&!cancelled;step++){
      const feeds={ids:new ort.Tensor('int64',BigInt64Array.from(ids,BigInt),[1,ids.length]),
        positions:new ort.Tensor('int64',BigInt64Array.from(ids,(_,i)=>BigInt(offset+i)),[ids.length])};
      past.forEach((v,i)=>feeds[`past_${i}`]=v);
      const output=await session.run(feeds);Object.values(feeds).forEach(v=>v.dispose());
      past=Array.from({length:24},(_,i)=>output[`present_${i}`]);
      const logits=output.logits.data;let token=0;
      if(manifest.tokenization==='space_bpe'){
        token=manifest.generation_tokens[0];
        for(const i of manifest.generation_tokens)if(logits[i]>logits[token])token=i;
      }else for(let i=1;i<50257;i++)if(logits[i]>logits[token])token=i;
      output.logits.dispose();offset+=ids.length;if(first===null)first=performance.now();
      if(token===50256){finished=true;break;}
      tokens.push(token);ids=[token];rawText=encoding.decode(tokens);({text,plan}=parts(rawText));
      send('token',{text,plan,tokens:tokens.length,elapsed:(performance.now()-start)/1000});
      if(step%4===3)await new Promise(resolve=>setTimeout(resolve,0));
    }
  }finally{past.forEach(v=>v.dispose());}
  const seconds=(performance.now()-start)/1000;
  const result={request,text,rawText,plan,tokens,stats:{seconds,generatedTokens:tokens.length,firstTokenSeconds:((first??performance.now())-start)/1000,
    tokensPerSecond:tokens.length/seconds,finished,cancelled,truncated:!finished&&!cancelled,backend:'wasm-cpu',threads:ort.env.wasm.numThreads,
    onnxSha256:manifest.model_sha256,sourceExecuted:false}};
  send('done',result);return result;
}
self.onmessage=async({data})=>{
  if(data.type==='stop'){cancelled=true;return;}
  try{
    cancelled=false;await initialize(data.threads||4);
    if(data.type==='generate')await generate(data.request,data.maxTokens||256);
    if(data.type==='benchmark'){
      const cases=await (await fetch(data.casesFile)).json(),results=[];
      for(const row of cases){if(cancelled)break;send('case',{id:row.id,request:row.request});const result=await generate(row.request,256);results.push({...result,id:row.id});}
      send('benchmark',{results});
    }
  }catch(e){send('error',{text:String(e.message||e)});}
};
