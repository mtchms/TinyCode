const $=id=>document.getElementById(id),worker=new Worker('./generator_worker.bundle.js',{type:'module'});
let loaded=false,busy=false,lastText='';
function showPlan(text){$('plan').hidden=!text;$('plan-text').textContent=text||'';}
function state(){
  $('load').disabled=loaded||busy;$('generate').disabled=!loaded||busy;$('stop').disabled=!loaded||!busy;
  $('threads').disabled=loaded||busy;$('copy').disabled=!lastText.trim();
}
function start(type){
  if(type==='generate'&&!$('request').value.trim()){$('status').textContent='Опишите, какой код нужен.';return;}
  busy=true;if(type==='generate'){$('output').textContent='';lastText='';$('stats').textContent='';showPlan('');}
  $('status').textContent='Подготовка…';state();worker.postMessage({type,request:$('request').value,threads:Number($('threads').value)});
}
$('load').onclick=()=>start('load');$('generate').onclick=()=>start('generate');
$('stop').onclick=()=>worker.postMessage({type:'stop'});
$('copy').onclick=async()=>{await navigator.clipboard.writeText(lastText);$('copy').textContent='Скопировано';};
$('request').addEventListener('keydown',e=>{if(e.ctrlKey&&e.key==='Enter'&&loaded&&!busy)start('generate');});
worker.onmessage=({data})=>{
  if(data.type==='status')$('status').textContent=data.text;
  if(data.type==='ready'){loaded=true;busy=false;$('status').textContent=`Модель готова · ${data.loadSeconds.toFixed(2)} с · ${data.cached?'из кэша':'первая загрузка'}`;state();}
  if(data.type==='token'){lastText=data.text;$('output').textContent=data.text;showPlan(data.plan);$('stats').textContent=`${data.tokens} токенов · ${data.elapsed.toFixed(2)} с`;state();}
  if(data.type==='done'){
    busy=false;lastText=data.text;$('output').textContent=data.text;showPlan(data.plan);$('copy').textContent='Скопировать код';
    $('status').textContent=data.stats.cancelled?'Генерация остановлена':data.stats.truncated?'Достигнут предел длины ответа':'';
    $('stats').textContent=`${data.stats.generatedTokens} токенов · ${data.stats.seconds.toFixed(2)} с · ${data.stats.tokensPerSecond.toFixed(1)} ток/с\nПервый токен: ${data.stats.firstTokenSeconds.toFixed(2)} с`;state();
  }
  if(data.type==='error'){busy=false;$('status').textContent=data.text;state();}
};
fetch('./public/generator/examples.json').then(r=>r.json()).then(rows=>{
  function markExample(){for(const [i,b] of [...$('examples').children].entries())b.setAttribute('aria-pressed',String($('request').value===rows[i].request));}
  for(const [index,row] of rows.entries()){const button=document.createElement('button');button.textContent=`Пример ${index+1}`;button.title=row.request;
    button.onclick=()=>{if(busy)return;$('request').value=row.request;$('output').textContent='';$('stats').textContent='';lastText='';showPlan('');state();markExample();};$('examples').append(button);}
  if(rows.length)$('request').value=(rows.find(r=>r.request==='check if a number is prime')||rows[0]).request;
  markExample();$('request').addEventListener('input',markExample);
});
