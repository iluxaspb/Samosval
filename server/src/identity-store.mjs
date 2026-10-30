import {createHash} from 'node:crypto';
import {fail} from './tabel-access.mjs';
import {ROLES,roleView,profileView,registrationDraft,normalizeIdentityOperation,defaultNickname} from './identity-rules.mjs';
const profile=async(client,uid,lock='')=>(await client.query('SELECT uid,email,display_name,role,status,revision,protected,profile FROM app_users WHERE uid=$1 '+lock,[uid])).rows[0];
const active=row=>row?.status==='active'&&!row.profile?.deleted;
async function stateLock(client){
  const state=(await client.query('SELECT initialized,owner_uid FROM identity_state WHERE id=1 FOR UPDATE')).rows[0];
  if(!state?.initialized)throw fail('identity-not-ready',409);return state;
}
async function recordAudit(client,op,uid,before,after){
  await client.query('INSERT INTO identity_audit(operation_id,uid,type,target_uid,before_data,after_data) VALUES ($1,$2,$3,$4,$5,$6)',[op.id,uid,op.type,op.uid||null,before,after]);
}
export async function readSession(pool,uid){
  const client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const row=await profile(client,uid);
    const rows=active(row)?(await client.query('SELECT action,allowed FROM role_permissions WHERE role=$1 AND allowed=true',[row.role])).rows:[];
    const ready=(await client.query('SELECT initialized FROM identity_state WHERE id=1')).rows[0]?.initialized===true;
    await client.query('COMMIT');
    return {format:'samosval-session',version:1,source:'synology',workspaceId:process.env.WORKSPACE_ID||'main_workspace',identityReady:ready,profile:profileView(row),permissions:active(row)?roleView(row.role,rows):{tabs:[],actions:[]}};
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
    if(!row){
      await client.query("INSERT INTO app_users(uid,email,display_name,role,status,profile) VALUES ($1,$2,$3,'viewer','pending',$4)",[draft.uid,draft.email,draft.nickname,{createdAt:now}]);
      row=await profile(client,draft.uid);
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
    await client.query('COMMIT');return {format:'samosval-members',version:1,source:'synology',members:rows.map(r=>({uid:r.uid,email:r.email,nickname:r.display_name,role:r.role,status:r.status}))};
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
    await client.query('COMMIT');return {format:'samosval-admin-access',version:1,source:'synology',users:users.filter(u=>!u.deleted),deletedUsers:users.filter(u=>u.deleted),requests,permissions};
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
        if(op.type==='user.delete'){changed.status='disabled';changed.profile.deleted=true;await client.query('DELETE FROM registration_requests WHERE uid=$1',[op.uid]);}
        if(op.type==='user.restore'){
          if(!target.profile.deleted)throw fail('account-not-deleted',409);
          changed.status='disabled';changed.profile.deleted=false;
        }
      }
      if(target.role==='admin'&&active(target)&&!(changed.role==='admin'&&active(changed))){
        if(Number((await client.query("SELECT count(*) AS n FROM app_users WHERE role='admin' AND status='active' AND profile->>'deleted' IS DISTINCT FROM 'true'")).rows[0].n)<=1)throw fail('last-active-admin',409);
      }
      changed.profile.updatedAt=Date.now();changed.profile.updatedBy=uid;
      await client.query('UPDATE app_users SET display_name=$2,role=$3,status=$4,profile=$5,revision=revision+1 WHERE uid=$1',[op.uid,changed.display_name,changed.role,changed.status,changed.profile]);
      changed.revision=Number(target.revision)+1;after=profileView(changed);
    }
    const result={outcome:'confirmed',operationId:op.id,result:after};
    await recordAudit(client,op,uid,before,after);
    await client.query('UPDATE identity_receipts SET result=$2 WHERE operation_id=$1',[op.id,result]);
    await client.query('COMMIT');return result;
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
