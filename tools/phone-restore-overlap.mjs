import assert from 'node:assert/strict';
import {until} from './phone-cdp.mjs';

// SQL gates exist only on the private synthetic pool. No server hooks/changes.
export async function restoreOverlap(pool, transport) {
 // A request may reject while SQL observation is polling. Observe immediately
 // to avoid an unhandled rejection; awaiting the original still propagates it.
 const request=(...args)=>{const work=transport(...args);work.catch(()=>{});return work;};
 const evidence=[];
 const activity=async fragment=>(await pool.query(`SELECT pid,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND position($1 in query)>0`,[fragment])).rows;
 const waitBlocked=async(fragment,pid)=>{let found;await until(async()=>{found=(await activity(fragment)).find(r=>r.blockers.includes(pid));return !!found;},'SQL gate '+fragment);return found;};
 for(const order of ['phone-first','restore-first']){
  await pool.query("DELETE FROM truck_phones WHERE truck_id='synthetic_delete'");
  const epoch=Number((await pool.query("SELECT restore_epoch FROM workspaces WHERE id='main_workspace'")).rows[0].restore_epoch);
  const saved=await request('/api/v1/backups',{id:'overlap_save_'+order,type:'backup.create',backupType:'manual',description:'Synthetic SQL gate'},epoch);
  assert.equal(saved.status,200);
  if(order==='restore-first')await pool.query("INSERT INTO truck_phones VALUES('main_workspace','synthetic_delete','+12025550118')");
  const gate=await pool.connect();let phone,restore;
  try{
   await gate.query('BEGIN');const pid=(await gate.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   const patch={truckId:'synthetic_delete',phone:'+12025550119'};
   const restoreBody={id:'overlap_restore_'+order,type:'backup.restore',backupId:saved.data.result.meta.id,sections:{base:true}};
   if(order==='phone-first'){
    await gate.query('LOCK TABLE truck_phones IN ACCESS EXCLUSIVE MODE');
    phone=request('/api/v1/truck-phones',patch,epoch);
    const writer=await waitBlocked('INSERT INTO truck_phones',pid);
    restore=request('/api/v1/backups',restoreBody,epoch);
    const restorer=await waitBlocked('pg_advisory_xact_lock(',writer.pid);
    evidence.push({order,writer,restorer});
    await gate.query('COMMIT');
    const result=await phone;assert.equal(result.status,200);assert.ok(result.data.phones.some(r=>r.truckId===patch.truckId&&r.phone===patch.phone));
    assert.equal((await restore).status,200);
   }else{
    await gate.query('LOCK TABLE workspace_service_receipts IN ACCESS EXCLUSIVE MODE');
    restore=request('/api/v1/backups',restoreBody,epoch);
    const restorer=await waitBlocked('INSERT INTO workspace_service_receipts',pid);
    // Restore already owns the exclusive dataset lock; writer must queue.
    phone=request('/api/v1/truck-phones',patch,epoch);
    const writer=await waitBlocked('pg_advisory_xact_lock_shared(',restorer.pid);
    // GET is intentionally read-only, not dataset-advisory-locked: it must
    // return the committed pre-restore snapshot while restore is held.
    const read=await request('/api/v1/truck-phones',undefined,epoch);
    assert.equal(read.status,200);assert.ok(read.data.phones.some(r=>r.truckId===patch.truckId&&r.phone==='+12025550118'));
    evidence.push({order,writer,restorer,read});
    await gate.query('COMMIT');assert.equal((await restore).status,200);
    const result=await phone;assert.equal(result.status,409);assert.equal(result.data.error,'dataset-restored-reload');
   }
   const rows=await pool.query("SELECT * FROM truck_phones WHERE truck_id='synthetic_delete'");assert.equal(rows.rowCount,0);
   const now=Number((await pool.query("SELECT restore_epoch FROM workspaces WHERE id='main_workspace'")).rows[0].restore_epoch);assert.equal(now,epoch+1);
   const read=await request('/api/v1/truck-phones',undefined,now);assert.equal(read.status,200);assert.equal(read.data.phones.some(r=>r.truckId==='synthetic_delete'),false);
  }finally{await gate.query('ROLLBACK');gate.release();await Promise.allSettled([phone,restore].filter(Boolean));}
 }
 // GET has no dataset advisory lock. Prove its old committed snapshot while
 // a restore is really queued on the same table, rather than inventing a 409.
 await pool.query("DELETE FROM truck_phones WHERE truck_id='synthetic_delete'");
 let epoch=Number((await pool.query("SELECT restore_epoch FROM workspaces WHERE id='main_workspace'")).rows[0].restore_epoch);
 const saved=await request('/api/v1/backups',{id:'get_overlap_save',type:'backup.create',backupType:'manual',description:'GET snapshot gate'},epoch);assert.equal(saved.status,200);
 await pool.query("INSERT INTO truck_phones VALUES('main_workspace','synthetic_delete','+12025550119')");
 const gate=await pool.connect();let read,restore;
 try{
  await gate.query('BEGIN');await gate.query('LOCK TABLE truck_phones IN ACCESS EXCLUSIVE MODE');
  const pid=(await gate.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  read=request('/api/v1/truck-phones',undefined,epoch);
  const reader=await waitBlocked('SELECT p.truck_id,p.phone',pid);
  restore=request('/api/v1/backups',{id:'get_overlap_restore',type:'backup.restore',backupId:saved.data.result.meta.id,sections:{base:true}},epoch);
  const restorer=await waitBlocked('LOCK TABLE truck_phones',pid);
  evidence.push({order:'GET-first',reader,restorer});await gate.query('COMMIT');
  const result=await read;assert.equal(result.status,200);assert.ok(result.data.phones.some(r=>r.truckId==='synthetic_delete'&&r.phone==='+12025550119'));
  assert.equal((await restore).status,200);
  assert.equal((await pool.query("SELECT * FROM truck_phones WHERE truck_id='synthetic_delete'")).rowCount,0);
 }finally{await gate.query('ROLLBACK');gate.release();await Promise.allSettled([read,restore].filter(Boolean));}
 return evidence;
}
