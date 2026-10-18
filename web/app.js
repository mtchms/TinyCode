const $=id=>document.getElementById(id),worker=new Worker('./worker.bundle.js?v=download-v2',{type:'module'});
let loaded=false,busy=false,report=null,loadInfo=null,examples=[];
function state(){$('generate').disabled=!loaded||busy;$('load').disabled=loaded||busy;$('threads').disabled=loaded||busy;$('stop').disabled=!busy||!loaded;}
function display(text){
  let value=text.replace(/^Steps:\s*/,''),summary='';
  if(value.includes('Result expression:')){const parts=value.split('Result expression:');value=parts[0];summary=parts.slice(1).join('Result expression:').split('Summary:').slice(1).join('Summary:');}
  $('reasoning').textContent=value.trim();$('summary').textContent=summary.trim();
}
function run(type){busy=true;state();$('reasoning').textContent='';$('summary').textContent='';$('stats').textContent='';$('status').textContent='Подготовка…';worker.postMessage({type,threads:Number($('threads').value),code:$('code').value,maxTokens:768});}
$('load').onclick=()=>run('load');$('generate').onclick=()=>run('generate');$('stop').onclick=()=>worker.postMessage({type:'stop'});
$('code').addEventListener('keydown',e=>{if(e.ctrlKey&&e.key==='Enter'&&loaded&&!busy)run('generate');});
worker.onmessage=({data})=>{
  if(data.type==='status')$('status').textContent=data.text;
  if(data.type==='ready'){loaded=true;busy=false;loadInfo=data;$('status').textContent=`Модель готова · ${data.loadSeconds.toFixed(2)} с · ${data.cached?'из кэша':'первая загрузка'} · ${data.threads} потока`;state();}
  if(data.type==='token'){busy=true;state();display(data.text);$('stats').textContent=`${data.tokens} токенов · ${data.elapsed.toFixed(2)} с`;}
  if(data.type==='case'){busy=true;state();$('code').value=data.code;$('reasoning').textContent='';$('summary').textContent='';$('status').textContent=`Тест ${data.index}/${data.total}: ${data.name}`;}
  if(data.type==='done'){
    busy=false;state();display(data.text);const s=data.stats;
    $('stats').textContent=`${s.generatedTokens} токенов · ${s.seconds.toFixed(2)} с\nОбщая скорость: ${s.tokensPerSecond.toFixed(2)} ток/с\nПервый токен: ${s.firstTokenSeconds.toFixed(2)} с\nДекодирование: ${s.decodeTokensPerSecond?.toFixed(2)} ток/с`;
    $('status').textContent=s.cancelled?'Генерация остановлена':s.truncated?'Достигнут лимит контекста / ответа':'';
    report={load:loadInfo,result:data,userAgent:navigator.userAgent};
  }
  if(data.type==='error'){busy=false;state();$('status').textContent=data.text;}
};
function markExample(){for(const [i,b] of [...$('examples').children].entries())b.setAttribute('aria-pressed',String($('code').value===examples[i].code));}
function render(){$('examples').replaceChildren();for(const r of examples){const b=document.createElement('button');b.textContent=r.display_name||r.id;b.title=r.code.split('\n')[0];b.onclick=()=>{if(busy)return;$('code').value=r.code;$('reasoning').textContent='';$('summary').textContent='';$('stats').textContent='';markExample();};$('examples').append(b);}markExample();}
$('code').addEventListener('input',markExample);
fetch('./public/examples.json').then(r=>r.json()).then(rows=>{examples=rows;if(!$('code').value.trim()&&rows.length)$('code').value=(rows.find(r=>r.id==='demo-recursive-250')||rows[0]).code;render();});
// Read-only diagnostics for the local benchmark harness, not an inference API.
window.browserDemo={get report(){return report},get loaded(){return loaded},get busy(){return busy}};
