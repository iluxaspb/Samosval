// Общий секрет подписи сессий. Загружается только при старте API, поэтому
// импорт модулей в тестах не печатает предупреждений и не тратит энтропию.
import {randomBytes} from 'node:crypto';
import {assertSessionSecret} from './auth-local.mjs';

let cached=null,pending=null;

export async function loadSessionSecret(env=process.env){
  if(cached)return cached;
  if(pending)return pending;
  pending=(async()=>{
    const configured=env.AUTH_SESSION_SECRET;
    if(configured===undefined||configured===''){
      // Секрет не задан: генерируем один раз на процесс. После перезапуска
      // выданные токены станут недействительны, поэтому предупреждаем явно.
      cached=randomBytes(32).toString('hex');
      console.error('[auth] AUTH_SESSION_SECRET не задан: сгенерирован временный секрет сессий на этот запуск. Сессии не переживут перезапуск API.');
      return cached;
    }
    // Заданный, но неверный секрет не подменяем: иначе подпись молча ослабнет.
    cached=await assertSessionSecret(configured);
    return cached;
  })();
  try{return await pending;}catch(e){pending=null;throw e;}
}
export function resetSessionSecretCache(){
  cached=null;pending=null;
}
