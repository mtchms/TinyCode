export function encodeFor(text,encoding,mode='bpe'){
  if(mode==='dual_bpe'){
    const prefix='Write a short plan, then simple Python code.\nRequest: ',suffix='\nPlan:\n';
    if(text.startsWith(prefix)&&text.endsWith(suffix)){
      const request=text.slice(prefix.length,-suffix.length);
      return [...encoding.encode(prefix+request+'\nVerbatim request:\n',[],[]),...encodeFor(request,encoding,'space_bpe'),...encoding.encode(suffix,[],[])];
    }
    return encoding.encode(text,[],[]);
  }
  return mode==='space_bpe'
    ? text.split(/([ \t\r\n\v\f]+)/).filter(Boolean).flatMap(part=>encoding.encode(part,[],[]))
    : encoding.encode(text,[],[]);
}
