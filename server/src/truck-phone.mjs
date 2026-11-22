import {fail,map} from './tabel-access.mjs';
export function normalizePhone(value){
 if(typeof value!=='string'||value.length>40||!/^[+0-9 ()-]*$/.test(value))throw fail('invalid-phone');
 const phone=value.replace(/[ ()-]/g,'');
 if(phone!==''&&!/^\+[1-9][0-9]{7,14}$/.test(phone))throw fail('invalid-phone');
 return phone;
}
// The driver name is optional: empty means "no name", anything else is a short
// human label (letters of any alphabet, digits, space, dot, hyphen, apostrophe).
export function normalizeDriverName(value){
 if(value===undefined||value===null)return null;
 if(typeof value!=='string')throw fail('invalid-driver-name');
 const raw=value.trim();
 if(raw==='')return null;
 if(/[\u0000-\u001F\u007F]/.test(raw))throw fail('invalid-driver-name');
 const name=raw.replace(/\s+/g,' ');
 if(name.length>80||!/^[\p{L}\p{N} .'-]+$/u.test(name))throw fail('invalid-driver-name');
 return name;
}
export function phonePatch(value){
 if(!map(value)||Object.keys(value).some(k=>!['truckId','phone','driverName'].includes(k))||typeof value.truckId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value.truckId))throw fail('invalid-phone-patch');
 const phone=normalizePhone(value.phone);
 if(!phone)throw fail('phone-required');
 return {truckId:value.truckId,phone,driverName:normalizeDriverName(value.driverName)};
}
export async function phoneAccess(client,uid,action,{lock=true}={}){
 const user=(await client.query('SELECT role,status FROM app_users WHERE uid=$1'+(lock?' FOR SHARE':''),[uid])).rows[0];
 if(!user||user.status!=='active')throw fail('forbidden',403);
 if(user.role==='admin')return;
 const rows=(await client.query('SELECT action FROM role_permissions WHERE role=$1 AND allowed=true'+(lock?' FOR SHARE':''),[user.role])).rows;
 const rights=new Set(rows.map(r=>r.action));
 if(!rights.has('view_truck_phone')||!rights.has(action))throw fail('forbidden',403);
}
export async function truckPhones(pool,uid,input){
 const patch=input===undefined?null:phonePatch(input),client=await pool.connect(),workspace=process.env.WORKSPACE_ID||'main_workspace';
 try{
  // A plain list read takes a snapshot only: a read-only transaction takes no dataset
  // advisory lock, so a running restore cannot block it. Writes keep the locking BEGIN.
  const readOnly=!patch;
  await client.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
  await phoneAccess(client,uid,readOnly?'view_truck_phone':'add_truck_phone',{lock:!readOnly});
  if(patch){
   const truck=(await client.query("SELECT payload FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2 FOR UPDATE",[workspace,patch.truckId])).rows[0];
   if(!truck||truck.payload.deleted)throw fail('truck-not-available',409);
   // One row per truck: saving again replaces both the number and the driver name.
   await client.query('INSERT INTO truck_phones(workspace_id,truck_id,phone,driver_name) VALUES($1,$2,$3,$4) ON CONFLICT (workspace_id,truck_id) DO UPDATE SET phone=EXCLUDED.phone, driver_name=EXCLUDED.driver_name',[workspace,patch.truckId,patch.phone,patch.driverName]);
  }
  const rows=(await client.query("SELECT p.truck_id,p.phone,p.driver_name FROM truck_phones p JOIN line_trucks t USING(workspace_id,truck_id) WHERE p.workspace_id=$1 AND t.payload->>'deleted' IS DISTINCT FROM 'true'",[workspace])).rows;
  await client.query('COMMIT');return {source:'ubuntu',phones:rows.map(r=>({truckId:r.truck_id,phone:r.phone,driverName:typeof r.driver_name==='string'?r.driver_name:null}))};
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
