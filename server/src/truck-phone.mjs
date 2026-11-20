import {fail,map} from './tabel-access.mjs';
export function normalizePhone(value){
 if(typeof value!=='string'||value.length>40||!/^[+0-9 ()-]*$/.test(value))throw fail('invalid-phone');
 const phone=value.replace(/[ ()-]/g,'');
 if(phone!==''&&!/^\+[1-9][0-9]{7,14}$/.test(phone))throw fail('invalid-phone');
 return phone;
}
export function phonePatch(value){
 if(!map(value)||Object.keys(value).some(k=>!['truckId','phone'].includes(k))||typeof value.truckId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value.truckId))throw fail('invalid-phone-patch');
 const phone=normalizePhone(value.phone);
 if(!phone)throw fail('phone-required');
 return {truckId:value.truckId,phone};
}
export async function phoneAccess(client,uid,action){
 const user=(await client.query('SELECT role,status FROM app_users WHERE uid=$1 FOR SHARE',[uid])).rows[0];
 if(!user||user.status!=='active')throw fail('forbidden',403);
 if(user.role==='admin')return;
 const rows=(await client.query('SELECT action FROM role_permissions WHERE role=$1 AND allowed=true FOR SHARE',[user.role])).rows;
 const rights=new Set(rows.map(r=>r.action));
 if(!rights.has('view_truck_phone')||!rights.has(action))throw fail('forbidden',403);
}
export async function truckPhones(pool,uid,input){
 const patch=input===undefined?null:phonePatch(input),client=await pool.connect();
 try{
  await client.query('BEGIN');
  await phoneAccess(client,uid,patch?'add_truck_phone':'view_truck_phone');
  if(patch){
   const truck=(await client.query("SELECT payload FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2 FOR UPDATE",[process.env.WORKSPACE_ID||'main_workspace',patch.truckId])).rows[0];
   if(!truck||truck.payload.deleted)throw fail('truck-not-available',409);
   const saved=await client.query('INSERT INTO truck_phones(workspace_id,truck_id,phone) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING truck_id',[process.env.WORKSPACE_ID||'main_workspace',patch.truckId,patch.phone]);
   if(!saved.rowCount)throw fail('phone-already-exists',409);
  }
  const rows=(await client.query("SELECT p.truck_id,p.phone FROM truck_phones p JOIN line_trucks t USING(workspace_id,truck_id) WHERE p.workspace_id=$1 AND t.payload->>'deleted' IS DISTINCT FROM 'true'",[process.env.WORKSPACE_ID||'main_workspace'])).rows;
  await client.query('COMMIT');return {source:'ubuntu',phones:rows.map(r=>({truckId:r.truck_id,phone:r.phone}))};
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
