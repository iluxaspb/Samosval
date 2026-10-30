import {fail,map} from './tabel-access.mjs';
export const ROLES=Object.freeze(['admin','foreman','master','lopater','viewer']);
export const TABS=Object.freeze(['line','timesheet','report','archive','trucks','analytics','backup','admin']);
export const ACTIONS=Object.freeze(['timesheet_edit','timesheet_manage','timesheet_export','start_shift','close_shift','edit_line','action_arrive','action_load','action_ttn','undo_action','edit_logs','manage_trucks','manage_objects','archive_edit','archive_delete','import_backup','view_card_stats','view_header','undo_any','view_gai_report','view_reis_in_ticker','history_view','history_undo_own','history_undo_any','history_redo_own','history_redo_any']);
const uid=value=>typeof value==='string'&&value.length>0&&value.length<=128;
const revision=(value,zero=false)=>Number.isSafeInteger(value)&&value>=(zero?0:1)&&value<Number.MAX_SAFE_INTEGER;
export function defaultNickname(email){
  const name=String(email||'').split('@')[0].slice(0,80);return name?name.charAt(0).toUpperCase()+name.slice(1):'Пользователь';
}
export function identityClaims(decoded){
  if(!map(decoded)||!uid(decoded.uid))return null;
  return {uid:decoded.uid,email:typeof decoded.email==='string'?decoded.email:null,emailVerified:decoded.email_verified===true};
}
export function registrationDraft(identity,input={}){
  if(!uid(identity?.uid)||typeof identity.email!=='string'||!identity.email.includes('@')||identity.email.length>320||/\s/.test(identity.email))throw fail('identity-email-required');
  if(!map(input)||input.nickname!==undefined&&(typeof input.nickname!=='string'||input.nickname.length>80))throw fail('invalid-nickname');
  const name=(input.nickname||'').trim()||defaultNickname(identity.email);
  return {uid:identity.uid,email:identity.email,nickname:name,role:'viewer',status:'pending'};
}
export function normalizeIdentityOperation(input){
  if(!map(input)||typeof input.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.id)||input.id.startsWith('register_'))throw fail('invalid-identity-operation');
  const types=['user.nickname','user.role','user.access','user.delete','user.restore','registration.approve','registration.reject','permissions.replace'];
  if(!types.includes(input.type))throw fail('invalid-identity-operation');
  const op={id:input.id,type:input.type};
  if(input.type==='permissions.replace'){
    if(!ROLES.includes(input.role)||input.role==='admin'||!revision(input.expectedRevision)||!map(input.permissions))throw fail('invalid-permissions');
    const {tabs,actions}=input.permissions;
    if(!Array.isArray(tabs)||!Array.isArray(actions)||tabs.some(x=>!TABS.includes(x)||x==='admin')||actions.some(x=>!ACTIONS.includes(x)))throw fail('invalid-permissions');
    return {...op,role:input.role,expectedRevision:input.expectedRevision,permissions:{tabs:[...new Set(tabs)].sort(),actions:[...new Set(actions)].sort()}};
  }
  if(!uid(input.uid)||!revision(input.expectedRevision,input.type.startsWith('registration.')))throw fail('invalid-profile-revision');
  Object.assign(op,{uid:input.uid,expectedRevision:input.expectedRevision});
  if(input.type.startsWith('registration.')){
    if(!revision(input.expectedProfileRevision))throw fail('invalid-profile-revision');
    op.expectedProfileRevision=input.expectedProfileRevision;
  }
  if(input.type==='user.role'||input.type==='registration.approve'){
    if(!ROLES.includes(input.role))throw fail('invalid-role');op.role=input.role;
  }
  if(input.type==='user.access'){
    if(typeof input.enabled!=='boolean')throw fail('invalid-access');op.enabled=input.enabled;
  }
  if(input.type==='user.nickname'){
    if(typeof input.nickname!=='string'||input.nickname.length>80)throw fail('invalid-nickname');op.nickname=input.nickname.trim();
  }
  if(input.type==='registration.reject'){
    if(input.reason!==undefined&&(typeof input.reason!=='string'||input.reason.length>1000))throw fail('invalid-reason');
    op.reason=(input.reason||'').trim()||'Заявка отклонена администратором.';
  }
  return op;
}
export function profileView(row){
  if(!row)return null;
  return {uid:row.uid,email:row.email,nickname:row.display_name,role:row.role,status:row.status,revision:Number(row.revision),protected:row.protected===true,deleted:row.profile?.deleted===true,rejectionReason:typeof row.profile?.rejectionReason==='string'?row.profile.rejectionReason:null};
}
export function roleView(role,rows){
  if(role==='admin')return {tabs:[...TABS],actions:[...ACTIONS]};
  const allowed=new Set(rows.filter(r=>r.allowed!==false).map(r=>r.action));
  return {tabs:TABS.filter(tab=>tab!=='admin'&&(allowed.has('tab_'+tab)||role==='foreman'&&tab==='timesheet')),actions:ACTIONS.filter(action=>allowed.has(action))};
}
