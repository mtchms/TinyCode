// Verified downloads shared by both modes. Model caching is optional, never a
// second live consumer of the network stream (Response.clone/tee).
const CACHE = 'tinycode-verified-model-chunks-v2';
function key(url, sha, part) {
  const u = new URL(url);
  u.searchParams.set('tinycode_sha', sha);
  u.searchParams.set('tinycode_part', String(part));
  return u.href;
}
async function hash(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}

export async function downloadModel({url, size, sha256, progress=()=>{},
  fetcher=globalThis.fetch, storage=globalThis.caches, chunkSize=16*1024*1024, maxAttempts=3}) {
  let cache;
  try { cache = await storage?.open(CACHE); } catch { /* private mode/quota */ }
  const marker = key(url, sha256, 'complete');
  const bytes = new Uint8Array(size);
  if (cache) {
    try {
      const saved = await cache.match(marker);
      if (saved) {
        const info = await saved.json();
        if (info.size !== size || !Number.isSafeInteger(info.chunkSize) || info.chunkSize <= 0) throw Error('Invalid cache index');
        for (let offset=0, part=0; offset<size; offset+=info.chunkSize, part++) {
          const response = await cache.match(key(url, sha256, part));
          if (!response) throw Error('Incomplete cache');
          const data = new Uint8Array(await response.arrayBuffer());
          if (data.length !== Math.min(info.chunkSize, size-offset)) throw Error('Incomplete cache chunk');
          bytes.set(data, offset);
          progress(`Чтение модели из кэша: ${Math.min(99, Math.floor((offset+data.length)/size*100))}%`);
        }
        progress('Проверка целостности модели…');
        if (await hash(bytes) !== sha256) throw Error('Invalid cached checksum');
        return {bytes, cached:true};
      }
    } catch { await cache.delete(marker).catch(()=>{}); }
  }
  let received=0, lastError;
  for (let attempt=0; attempt<maxAttempts && received<size; attempt++) {
    let reader;
    try {
      if (attempt) progress(`Повтор загрузки ${attempt+1}/${maxAttempts}…`);
      const headers = received ? {Range:`bytes=${received}-`} : {};
      const response = await fetcher(url, {headers, cache:'no-store', credentials:'omit'});
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      if (response.status===206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
        if (!range || Number(range[1])!==received || Number(range[3])!==size) { received=0; throw Error('Неверный диапазон файла модели'); }
      } else received=0; // Server ignored Range: restart without duplicating bytes.
      reader = response.body.getReader();
      while (true) {
        let item;
        try { item = await reader.read(); }
        catch (error) {
          // Some browsers error on the final EOF even after delivering all
          // bytes. Accept ONLY after the full size AND SHA-256 are verified.
          if (received===size) break;
          throw error;
        }
        if (item.done) break;
        if (received+item.value.length>size) { received=0; throw Error('Размер модели больше ожидаемого'); }
        bytes.set(item.value, received); received+=item.value.length;
        progress(`Загрузка модели: ${Math.min(99, Math.floor(received/size*100))}%`);
      }
      if (received<size) throw Error('Поток загрузки оборвался');
    } catch (error) { lastError=error; }
    finally {
      if (reader) { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
    }
  }
  if (received!==size) throw Error(`Не удалось скачать модель: ${lastError?.message || 'неполный файл'}. Нажмите «Загрузить модель» для повтора.`);
  progress('Проверка целостности модели…');
  if (await hash(bytes)!==sha256) throw Error('Файл модели повреждён: SHA-256 не совпал. Повторите загрузку.');
  if (cache) {
    try {
      progress('Сохранение проверенной модели в кэш…');
      // Bounded copies instead of cloning a 650 MB response while downloading.
      for (let offset=0, part=0; offset<size; offset+=chunkSize, part++) {
        await cache.put(key(url, sha256, part), new Response(bytes.subarray(offset, Math.min(offset+chunkSize,size))));
      }
      await cache.put(marker, new Response(JSON.stringify({size, chunkSize})));
    } catch { await cache.delete(marker).catch(()=>{}); /* still usable in RAM */ }
  }
  return {bytes, cached:false};
}
