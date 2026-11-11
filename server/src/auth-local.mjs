// Локальная аутентификация без внешних зависимостей.
// Только node:crypto. Пароли необратимы (scrypt), токены подписаны HMAC-SHA256,
// в базе хранится лишь SHA-256 от токена.
import {createHash,createHmac,randomBytes,scrypt as scryptCallback,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {FIREBASE_SCRYPT_ALGORITHM,verifyFirebaseScrypt} from './firebase-scrypt.mjs';

export const PASSWORD_ALGORITHM='scrypt-sha256';
// Параметры scrypt зафиксированы, чтобы хеш можно было перепроверить годы спустя.
export const SCRYPT_PARAMS=Object.freeze({N:16384,r:8,p:1,keylen:64,maxmem:64*1024*1024});
export const PASSWORD_MIN_LENGTH=8;
export const PASSWORD_MAX_LENGTH=512;
export const TOKEN_TYPES=Object.freeze(['access','refresh','reset']);
// exp и iat — миллисекунды Unix (Date.now()), как и остальные времена в API.
export const TOKEN_TTL=Object.freeze({
  access:15*60*1000,            // 15 минут: короткоживущий ключ к API
  refresh:30*24*60*60*1000,     // 30 дней: продление сессии на устройстве
  reset:60*60*1000              // 1 час: ссылка восстановления пароля
});
const TOKEN_MAX_LENGTH=4096,CLOCK_SKEW_MS=5*60*1000,SALT_BYTES=8,TOKEN_BYTES=32;
const failSecret=()=>Object.assign(new Error('invalid-session-secret'),{code:'invalid-session-secret',status:500});
const scrypt=(password,salt,keylen,options)=>new Promise((resolve,reject)=>{
  scryptCallback(password,salt,keylen,options,(error,key)=>error?reject(error):resolve(key));
});
const b64url=value=>Buffer.from(value).toString('base64url');
const sha256=value=>createHash('sha256').update(value).digest('hex');

// Общий секрет сессий: непустая hex-строка не короче 32 байт (64 hex-символа).
export async function assertSessionSecret(secret){
  if(typeof secret!=='string'||!/^[0-9a-fA-F]{64,}$/.test(secret))throw failSecret();
  return secret;
}
export async function hashPassword(password){
  if(typeof password!=='string')throw Object.assign(new Error('invalid-password'),{code:'invalid-password',status:400});
  const salt=randomBytes(SALT_BYTES).toString('hex');
  const hash=await scrypt(password,salt,SCRYPT_PARAMS.keylen,{N:SCRYPT_PARAMS.N,r:SCRYPT_PARAMS.r,p:SCRYPT_PARAMS.p,maxmem:SCRYPT_PARAMS.maxmem});
  return {algorithm:PASSWORD_ALGORITHM,salt,hash:hash.toString('hex')};
}
// Кэш конфига Firebase SCRYPT: загружается один раз при первой проверке пароля
// этого типа. Секретные поля не выводятся в логи.
let firebaseScryptConfigCache=null,firebaseScryptConfigPending=null;
async function loadFirebaseScryptConfig(){
  if(firebaseScryptConfigCache)return firebaseScryptConfigCache;
  if(firebaseScryptConfigPending)return firebaseScryptConfigPending;
  firebaseScryptConfigPending=(async()=>{
    const paths=[process.env.FIREBASE_HASH_CONFIG_PATH,'/secrets/firebase-hash-config.json'].filter(Boolean);
    for(const p of paths){
      try{
        const raw=await readFile(p,'utf8');
        const cfg=JSON.parse(raw);
        if(cfg&&typeof cfg.signerKey==='string'&&cfg.signerKey.length>0&&typeof cfg.saltSeparator==='string'&&Number.isSafeInteger(cfg.rounds)&&Number.isSafeInteger(cfg.memoryCost)){
          console.log(`[auth] firebase-scrypt config loaded from ${p} (algorithm=${cfg.algorithm}, rounds=${cfg.rounds}, memoryCost=${cfg.memoryCost}, signerKeyLen=${cfg.signerKey.length})`);
          return cfg;
        }
      }catch{}
    }
    console.error('[auth] firebase-scrypt config not found: login with firebase-scrypt passwords will fail');
    return null;
  })();
  try{firebaseScryptConfigCache=await firebaseScryptConfigPending;return firebaseScryptConfigCache;}catch(e){firebaseScryptConfigPending=null;throw e;}
}
// Любая повреждённая запись даёт false, а не исключение: иначе ошибка формата
// стала бы подсказкой о состоянии учётной записи.
export async function verifyPassword(password,credential){
  try{
    if(typeof password!=='string'||!password)return false;
    if(!credential||typeof credential!=='object')return false;
    const {salt,hash,algorithm}=credential;
    if(typeof salt!=='string'||typeof hash!=='string'||!salt||!hash)return false;
    if(algorithm===FIREBASE_SCRYPT_ALGORITHM){
      const cfg=await loadFirebaseScryptConfig();
      if(!cfg)return false;
      return verifyFirebaseScrypt(password,{hash,salt,algorithm:FIREBASE_SCRYPT_ALGORITHM},cfg);
    }
    if(algorithm!==undefined&&algorithm!==PASSWORD_ALGORITHM)return false;
    if(!/^[0-9a-f]+$/i.test(hash)||hash.length!==SCRYPT_PARAMS.keylen*2)return false;
    if(!/^[0-9a-f]+$/i.test(salt))return false;
    const actual=await scrypt(password,salt,SCRYPT_PARAMS.keylen,{N:SCRYPT_PARAMS.N,r:SCRYPT_PARAMS.r,p:SCRYPT_PARAMS.p,maxmem:SCRYPT_PARAMS.maxmem});
    const expected=Buffer.from(hash,'hex');
    return expected.length===actual.length&&timingSafeEqual(expected,actual);
  }catch{return false;}
}
export async function generateToken(bytes=TOKEN_BYTES){
  const size=Number.isSafeInteger(bytes)&&bytes>=16&&bytes<=64?bytes:TOKEN_BYTES;
  return randomBytes(size).toString('hex');
}
// Токен = base64url(JSON) + "." + base64url(HMAC-SHA256 от encoded payload).
export async function signSession(payload,options={}){
  const {secret,type,ttlMs}=options;
  await assertSessionSecret(secret);
  if(!TOKEN_TYPES.includes(type))throw Object.assign(new Error('invalid-token-type'),{code:'invalid-token-type',status:400});
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Object.assign(new Error('invalid-token-payload'),{code:'invalid-token-payload',status:400});
  if(typeof payload.uid!=='string'||!payload.uid)throw Object.assign(new Error('invalid-token-payload'),{code:'invalid-token-payload',status:400});
  if(payload.type!==undefined&&payload.type!==type)throw Object.assign(new Error('invalid-token-type'),{code:'invalid-token-type',status:400});
  const ttl=Number.isSafeInteger(ttlMs)&&ttlMs>0?ttlMs:TOKEN_TTL[type];
  const now=Date.now();
  const claims={...payload,type,iat:now,exp:now+ttl};
  const encoded=b64url(JSON.stringify(claims));
  const signature=b64url(createHmac('sha256',secret).update(encoded).digest());
  return encoded+'.'+signature;
}
// Возвращает проверенные claims либо null. Подпись сравнивается за постоянное
// время; истёкший, чужой по типу или повреждённый токен не принимается.
export async function verifySession(token,options={}){
  try{
    const {secret,type}=options;
    await assertSessionSecret(secret);
    if(typeof token!=='string'||token.length===0||token.length>TOKEN_MAX_LENGTH)return null;
    const parts=token.split('.');
    if(parts.length!==2||!parts[0]||!parts[1])return null;
    const [encoded,signature]=parts;
    const expected=Buffer.from(b64url(createHmac('sha256',secret).update(encoded).digest()));
    const actual=Buffer.from(signature);
    if(expected.length!==actual.length||!timingSafeEqual(expected,actual))return null;
    const claims=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
    if(!claims||typeof claims!=='object'||Array.isArray(claims))return null;
    if(typeof claims.uid!=='string'||!claims.uid||claims.uid.length>128)return null;
    if(!TOKEN_TYPES.includes(claims.type))return null;
    if(type!==undefined&&claims.type!==type)return null;
    if(!Number.isSafeInteger(claims.exp)||!Number.isSafeInteger(claims.iat))return null;
    if(claims.exp<=Date.now())return null;
    if(claims.iat>Date.now()+CLOCK_SKEW_MS)return null;
    return claims;
  }catch{return null;}
}
export async function hashToken(token){
  if(typeof token!=='string'||!token)throw Object.assign(new Error('invalid-token'),{code:'invalid-token',status:400});
  return sha256(token);
}
