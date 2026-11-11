import {createHash,randomUUID} from 'node:crypto';
import {fail,map} from './tabel-access.mjs';
import {ROLES,roleView,profileView,registrationDraft,normalizeIdentityOperation,defaultNickname,credentialDraft,normalizePassword} from './identity-rules.mjs';
import {hashPassword,verifyPassword,signSession,verifySession,hashToken,TOKEN_TTL} from './auth-local.mjs';
import {loadSessionSecret} from './auth-config.mjs';
const profile=async(client,uid,lock='')=>(await client.query('SELECT uid,email,display_name,role,status,revision,protected,profile FROM app_users WHERE uid=$1 '+lock,[uid])).rows[0];
const active=row=>row?.status==='active'&&!row.profile?.deleted;
// Заглушка для проверки пароля неизвестной почты: время ответа не должно
// показывать, существует ли учётная запись.
const DUMMY_CREDENTIAL=Object.freeze({algorithm:'scrypt-sha256',salt:'0'.repeat(16),hash:'0'.repeat(128)});
export const HARD_DELETE_DISPLAY_NAME='Удалённый пользователь';
export const ANONYMOUS_UID='deleted-user';
const tombstoneEmail=uid=>'deleted+'+createHash('sha256').update(uid).digest('hex').slice(0,32)+'@local.invalid';
// В журнал устройств попадают только обезличенные признаки, без адресов и токенов.
function deviceRow(info){
  if(!map(info))return null;
  const out={};
  for(const key of ['userAgent','platform','label','model','appVersion']){
    const value=info[key];
    if(typeof value==='string'&&value.trim())out[key]=value.trim().slice(0,200);
  }
  return Object.keys(out).length?out:null;
}
const sessionView=row=>({id:row.id,device:row.device_info||null,createdAt:new Date(row.created_at).getTime(),expiresAt:new Date(row.expires_at).getTime(),revokedAt:row.revoked_at?new Date(row.revoked_at).getTime():null,active:!row.revoked_at&&new Date(row.expires_at).getTime()>Date.now()});

async function stateLock(client){
  const state=(await client.query('SELECT initialized,owner_uid FROM identity_state WHERE id=1 FOR UPDATE')).rows[0];
  if(!state?.initialized)throw fail('identity-not-ready',409);return state;
}
async function recordAudit(client,op,uid,before,after){
  await client.query('INSERT INTO identity_audit(operation_id,uid,type,target_uid,before_data,after_data) VALUES ($1,$2,$3,$4,$5,$6)',[op.id,uid,op.type,op.uid||null,before,after]);
}
// Необратимое удаление внутри уже открытой транзакции вызывающего: секреты и
// живые сессии стираются, а следы операций обезличиваются. Рабочие данные
// (смены, журналы линии, статусы самосвалов, записи табеля) не затрагиваются.
async function applyHardDeleteCleanup(client,uid){
  await client.query('DELETE FROM user_credentials WHERE uid=$1',[uid]);
  await client.query('DELETE FROM user_sessions WHERE uid=$1',[uid]);
  await client.query('DELETE FROM password_reset_tokens WHERE uid=$1',[uid]);
  await client.query('DELETE FROM registration_requests WHERE uid=$1',[uid]);
  await client.query('DELETE FROM identity_receipts WHERE uid=$1',[uid]);
  // Журналы и квитанции сохраняют факт и вид операции, но не человека и не данные.
  await client.query('UPDATE identity_audit SET uid=$2,target_uid=NULL,before_data=NULL,after_data=NULL WHERE uid=$1 OR target_uid=$1',[uid,ANONYMOUS_UID]);
  await client.query('UPDATE line_audit SET uid=$2 WHERE uid=$1',[uid,ANONYMOUS_UID]);
  await client.query("UPDATE line_operation_receipts SET uid=$2,result='{}'::jsonb WHERE uid=$1",[uid,ANONYMOUS_UID]);
  await client.query("UPDATE tabel_receipts SET uid=$2,payload='{}'::jsonb WHERE uid=$1",[uid,ANONYMOUS_UID]);
  await client.query("UPDATE shift_operation_receipts SET uid=$2,result='{}'::jsonb WHERE uid=$1",[uid,ANONYMOUS_UID]);
  await client.query("UPDATE control_operation_receipts SET uid=$2,result='{}'::jsonb WHERE uid=$1",[uid,ANONYMOUS_UID]);
  await client.query('UPDATE control_audit SET uid=$2,before_data=NULL,after_data=NULL WHERE uid=$1',[uid,ANONYMOUS_UID]);
  await client.query("UPDATE history_receipts SET uid=$2,result='{}'::jsonb WHERE uid=$1",[uid,ANONYMOUS_UID]);
  await client.query('UPDATE history_audit SET uid=$2 WHERE uid=$1',[uid,ANONYMOUS_UID]);
  await client.query("UPDATE workspace_service_receipts SET uid=$2,result='{}'::jsonb WHERE uid=$1",[uid,ANONYMOUS_UID]);
  await client.query('UPDATE workspace_service_audit SET uid=$2,before_data=NULL,after_data=NULL WHERE uid=$1',[uid,ANONYMOUS_UID]);
  await client.query("UPDATE server_control_jobs SET uid=$2,request='{}'::jsonb,detail='{}'::jsonb WHERE uid=$1",[uid,ANONYMOUS_UID]);
  await client.query('UPDATE server_authority_events SET uid=$2 WHERE uid=$1',[uid,ANONYMOUS_UID]);
  await client.query('UPDATE server_authority SET updated_by=$2 WHERE updated_by=$1',[uid,ANONYMOUS_UID]);
  await client.query('UPDATE line_history SET uid=$2,game_actor=NULL WHERE uid=$1',[uid,ANONYMOUS_UID]);
}
function tombstoneProfile(now,actorUid){
  return {deleted:true,hardDeleted:true,hardDeletedAt:now,updatedAt:now,updatedBy:actorUid};
}
async function assertNotLastAdmin(client){
  const admins=Number((await client.query("SELECT count(*) AS n FROM app_users WHERE role='admin' AND status='active' AND profile->>'deleted' IS DISTINCT FROM 'true'")).rows[0].n);
  if(admins<=1)throw fail('last-active-admin',409);
}

export async function readSession(pool,uid){
  const client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const row=await profile(client,uid);
    const rows=active(row)?(await client.query('SELECT action,allowed FROM role_permissions WHERE role=$1 AND allowed=true',[row.role])).rows:[];
    const ready=(await client.query('SELECT initialized FROM identity_state WHERE id=1')).rows[0]?.initialized===true;
    const auth=(await client.query('SELECT provider,generation,updated_at FROM server_authority WHERE workspace_id=$1',[process.env.WORKSPACE_ID||'main_workspace'])).rows[0];
    await client.query('COMMIT');
    return {format:'samosval-session',version:1,source:'ubuntu',workspaceId:process.env.WORKSPACE_ID||'main_workspace',identityReady:ready,profile:profileView(row),permissions:active(row)?roleView(row.role,rows):{tabs:[],actions:[]},authority:auth?{provider:auth.provider,generation:Number(auth.generation),updatedAt:auth.updated_at?new Date(auth.updated_at).getTime():null}:null};
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
export async function registerPending(pool,identity,input){
  const draft=registrationDraft(identity,input),client=await pool.connect();
  try{
    await client.query('BEGIN');await stateLock(client);
    let row=await profile(client,draft.uid,'FOR UPDATE');
    if(row?.profile.deleted)throw fail('account-disabled',403);
    if(row&&row.status!=='pending'){
      if(!active(row))throw fail('account-disabled',403);
      await client.query('COMMIT');return {profile:profileView(row),created:false};
    }
    const now=Date.now(),created=!row;
    // Первый пользователь в пустом резерве становится активным администратором:
    // иначе после переключения на Ubuntu подтвердить учётные записи некому.
    const empty = !row && !(await client.query('SELECT 1 FROM app_users LIMIT 1')).rowCount;
    if(!row){
      await client.query("INSERT INTO app_users(uid,email,display_name,role,status,profile) VALUES ($1,$2,$3,$4,$5,$6)",
        [draft.uid,draft.email,draft.nickname,empty?'admin':'viewer',empty?'active':'pending',{createdAt:now}]);
      row=await profile(client,draft.uid);
    }
    if(empty){
      await recordAudit(client,{id:'register_'+createHash('sha256').update(draft.uid).digest('hex'),type:'registration.bootstrap-admin',uid:draft.uid},draft.uid,null,profileView(row));
      await client.query('COMMIT');
      return {profile:profileView(row),created:true,bootstrap:true};
    }
    const request={uid:row.uid,email:row.email,nickname:row.display_name,status:'pending',createdAt:row.profile.createdAt||now};
    await client.query('INSERT INTO registration_requests(uid,payload) VALUES ($1,$2) ON CONFLICT DO NOTHING',[row.uid,request]);
    if(created)await recordAudit(client,{id:'register_'+createHash('sha256').update(draft.uid).digest('hex'),type:'registration.create',uid:draft.uid},draft.uid,null,profileView(row));
    await client.query('COMMIT');return {profile:profileView(row),created};
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
export async function readMembers(pool,uid){
  const client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if(!active(await profile(client,uid)))throw fail('forbidden',403);
    const rows=(await client.query("SELECT uid,email,display_name,role,status FROM app_users WHERE status IN ('active','disabled') AND profile->>'deleted' IS DISTINCT FROM 'true' ORDER BY uid")).rows;
    await client.query('COMMIT');return {format:'samosval-members',version:1,source:'ubuntu',members:rows.map(r=>({uid:r.uid,email:r.email,nickname:r.display_name,role:r.role,status:r.status}))};
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
export async function readAdministration(pool,uid){
  const client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const actor=await profile(client,uid);if(!active(actor)||actor.role!=='admin')throw fail('forbidden',403);
    const users=(await client.query('SELECT uid,email,display_name,role,status,revision,protected,profile FROM app_users ORDER BY uid')).rows.map(profileView);
    const requests=(await client.query('SELECT uid,payload,revision FROM registration_requests ORDER BY uid')).rows.map(r=>({uid:r.uid,email:r.payload.email,nickname:r.payload.nickname,status:'pending',createdAt:r.payload.createdAt||null,revision:Number(r.revision)}));
    // Recover legacy pending profiles even if an old request document is absent.
    for(const user of users.filter(u=>u.status==='pending'&&!u.deleted))if(!requests.some(r=>r.uid===user.uid))requests.push({uid:user.uid,email:user.email,nickname:user.nickname,status:'pending',revision:0});
    const all=(await client.query('SELECT role,action,allowed FROM role_permissions')).rows;
    const versions=(await client.query('SELECT role,revision FROM role_permission_versions')).rows;
    const permissions=Object.fromEntries(ROLES.filter(r=>r!=='admin').map(role=>[role,{...roleView(role,all.filter(r=>r.role===role)),revision:Number(versions.find(r=>r.role===role)?.revision||0)}]));
    await client.query('COMMIT');return {format:'samosval-admin-access',version:1,source:'ubuntu',users:users.filter(u=>!u.deleted),deletedUsers:users.filter(u=>u.deleted),requests,permissions};
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
export async function identityOperation(pool,uid,input){
  const op=normalizeIdentityOperation(input),hash=createHash('sha256').update(JSON.stringify(op)).digest('hex'),client=await pool.connect();
  try{
    await client.query('BEGIN');const state=await stateLock(client);
    const actor=await profile(client,uid,'FOR SHARE');if(!active(actor)||actor.role!=='admin')throw fail('forbidden',403);
    const inserted=await client.query("INSERT INTO identity_receipts(operation_id,uid,request_hash,result) VALUES ($1,$2,$3,'{}') ON CONFLICT DO NOTHING RETURNING operation_id",[op.id,uid,hash]);
    if(!inserted.rowCount){
      const old=(await client.query('SELECT uid,request_hash,result FROM identity_receipts WHERE operation_id=$1',[op.id])).rows[0];
      if(!old||old.uid!==uid||old.request_hash!==hash)throw fail('operation-id-reused',409);
      await client.query('COMMIT');return {...old.result,replayed:true};
    }
    let before,after;
    if(op.type==='permissions.replace'){
      const version=(await client.query('SELECT revision FROM role_permission_versions WHERE role=$1 FOR UPDATE',[op.role])).rows[0];
      if(Number(version?.revision||0)!==op.expectedRevision)throw fail('permissions-changed',409);
      before={role:op.role,revision:Number(version.revision),rows:(await client.query('SELECT action,allowed FROM role_permissions WHERE role=$1 ORDER BY action',[op.role])).rows};
      await client.query('UPDATE role_permissions SET allowed=false WHERE role=$1',[op.role]);
      for(const action of [...op.permissions.tabs.map(t=>'tab_'+t),...op.permissions.actions])await client.query('INSERT INTO role_permissions(role,action,allowed) VALUES ($1,$2,true) ON CONFLICT(role,action) DO UPDATE SET allowed=true',[op.role,action]);
      await client.query('UPDATE role_permission_versions SET revision=revision+1 WHERE role=$1',[op.role]);
      after={role:op.role,revision:op.expectedRevision+1,permissions:op.permissions};
    }else{
      const target=await profile(client,op.uid,'FOR UPDATE');if(!target)throw fail('profile-not-found',409);
      const isDecision=op.type.startsWith('registration.');
      if(Number(target.revision)!==(isDecision?op.expectedProfileRevision:op.expectedRevision))throw fail('profile-changed',409);
      before=profileView(target);let changed={...target,profile:{...target.profile}};
      if(isDecision){
        const request=(await client.query('SELECT payload,revision FROM registration_requests WHERE uid=$1 FOR UPDATE',[op.uid])).rows[0];
        if(Number(request?.revision||0)!==op.expectedRevision||target.status!=='pending'||target.profile.deleted)throw fail('registration-changed',409);
        if(request&&(request.payload.uid!==target.uid||request.payload.email!==target.email))throw fail('registration-identity-mismatch',409);
        before={profile:before,request:request?.payload||null};
        changed.status=op.type==='registration.approve'?'active':'disabled';
        if(op.type==='registration.approve')changed.role=op.role;
        Object.assign(changed.profile,{decisionAt:Date.now(),decisionBy:uid,rejectionReason:op.type==='registration.reject'?op.reason:null});
        await client.query('DELETE FROM registration_requests WHERE uid=$1',[op.uid]);
      }else if(op.type==='user.nickname'){
        changed.display_name=op.nickname||defaultNickname(target.email);
      }else{
        if((target.protected||target.uid===state.owner_uid)&&(op.type==='user.delete'||op.type==='user.role'&&op.role!=='admin'||op.type==='user.access'&&!op.enabled))throw fail('protected-owner',409);
        if(op.uid===uid&&(op.type==='user.delete'||op.type==='user.role'&&op.role!=='admin'||op.type==='user.access'&&!op.enabled))throw fail('self-access-change',409);
        if(target.profile.deleted&&op.type!=='user.restore')throw fail('account-deleted',409);
        if(op.type==='user.role')changed.role=op.role;
        if(op.type==='user.access'){
          if(target.status==='pending')throw fail('pending-requires-decision',409);
          changed.status=op.enabled?'active':'disabled';if(op.enabled)changed.profile.rejectionReason=null;
        }
        if(op.type==='user.delete'){
          changed.status='disabled';changed.profile.deleted=true;
          if(op.hard!==false)changed.profile.hardDeleted=true;
          else await client.query('DELETE FROM registration_requests WHERE uid=$1',[op.uid]);
        }
        if(op.type==='user.restore'){
          if(!target.profile.deleted)throw fail('account-not-deleted',409);
          changed.status='disabled';changed.profile.deleted=false;
        }
      }
      if(target.role==='admin'&&active(target)&&!(changed.role==='admin'&&active(changed))){
        if(Number((await client.query("SELECT count(*) AS n FROM app_users WHERE role='admin' AND status='active' AND profile->>'deleted' IS DISTINCT FROM 'true'")).rows[0].n)<=1)throw fail('last-active-admin',409);
      }
      const hardDelete=op.type==='user.delete'&&op.hard!==false;
      if(hardDelete){
        // Профиль заменяется целиком: исходные персональные поля не сохраняются.
        const now=Date.now();
        await applyHardDeleteCleanup(client,op.uid);
        changed.profile=tombstoneProfile(now,uid);changed.status='disabled';
        changed.display_name=HARD_DELETE_DISPLAY_NAME;changed.email=tombstoneEmail(op.uid);
        await client.query('UPDATE app_users SET display_name=$2,email=$3,role=$4,status=$5,profile=$6,revision=revision+1 WHERE uid=$1',[op.uid,changed.display_name,changed.email,changed.role,changed.status,changed.profile]);
      }else{
        changed.profile.updatedAt=Date.now();changed.profile.updatedBy=uid;
        await client.query('UPDATE app_users SET display_name=$2,role=$3,status=$4,profile=$5,revision=revision+1 WHERE uid=$1',[op.uid,changed.display_name,changed.role,changed.status,changed.profile]);
      }
      changed.revision=Number(target.revision)+1;after=profileView(changed);
      if(hardDelete){before=null;auditOp={...op,type:'user.hard-delete',uid:null};}
    }
    const result={outcome:'confirmed',operationId:op.id,result:after};
    await recordAudit(client,op,uid,before,after);
    await client.query('UPDATE identity_receipts SET result=$2 WHERE operation_id=$1',[op.id,result]);
    await client.query('COMMIT');return result;
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
