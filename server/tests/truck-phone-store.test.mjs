import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {truckPhones} from '../src/truck-phone.mjs';
import {readCatalog,submitControl} from '../src/control-store.mjs';
test('phone ACL, reload, limited writes and legacy catalog isolation',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
 const ws='phone_fixture',uid='phone_limited',admin='phone_admin';process.env.WORKSPACE_ID=ws;
 try{
 await pool.query('INSERT INTO workspaces(id) VALUES($1) ON CONFLICT DO NOTHING',[ws]);
 await pool.query("INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,'limited@example.test','Limited','phone_role','active'),($2,'admin@example.test','Admin','admin','active')",[uid,admin]);
 await pool.query("INSERT INTO line_trucks(workspace_id,truck_id,payload,revision) VALUES($1,'t1',$2,1)",[ws,{brand:'Synthetic',number:'QA',defaultVol:20,isGAI:false}]);
 await assert.rejects(truckPhones(pool,uid),{code:'forbidden'});
 await assert.rejects(truckPhones(pool,uid,{truckId:'t1',phone:'+79991234567'}),{code:'forbidden'});
 for(const action of ['view_truck_phone','add_truck_phone','tab_trucks'])await pool.query('INSERT INTO role_permissions(role,action,allowed) VALUES($1,$2,true)',['phone_role',action]);
 await assert.rejects(truckPhones(pool,uid,{truckId:'t1',phone:'+79991234567',brand:'evil'}),{code:'invalid-phone-patch'});
 await truckPhones(pool,uid,{truckId:'t1',phone:'+7 (999) 123-45-67',driverName:'  Иван   Петров '});
 const first=(await truckPhones(pool,uid)).phones;
 assert.equal(first[0].phone,'+79991234567');
 assert.equal(first[0].driverName,'Иван Петров');
 // A repeated write is an upsert now: the row is replaced, no 409 and no duplicate.
 await truckPhones(pool,uid,{truckId:'t1',phone:'+79991234568',driverName:'Пётр Сидоров'});
 const second=(await truckPhones(pool,uid)).phones;
 assert.equal(second.length,1);
 assert.equal(second[0].phone,'+79991234568');
 assert.equal(second[0].driverName,'Пётр Сидоров');
 // Omitting the name clears it, and a rejected name changes nothing.
 await assert.rejects(truckPhones(pool,uid,{truckId:'t1',phone:'+79991234568',driverName:'<img src=x>'}),{code:'invalid-driver-name'});
 await truckPhones(pool,uid,{truckId:'t1',phone:'+79991234568'});
 assert.equal((await truckPhones(pool,uid)).phones[0].driverName,null);
 assert.equal((await truckPhones(pool,uid)).phones[0].phone,'+79991234568');
 const catalogText=JSON.stringify(await readCatalog(pool,uid,ws));assert.equal(catalogText.includes('+7999'),false);assert.equal(catalogText.includes('Иван Петров'),false);assert.equal(catalogText.includes('Сидоров'),false);
 assert.equal((await pool.query('SELECT payload FROM line_trucks WHERE workspace_id=$1',[ws])).rows[0].payload.brand,'Synthetic');
 await assert.rejects(submitControl(pool,uid,{id:'evil',type:'truck.update',recordId:'t1',expectedRevision:1,data:{brand:'evil',number:'evil',defaultVol:1,isGAI:false}},ws),{code:'forbidden'});
 await pool.query("UPDATE role_permissions SET allowed=false WHERE role='phone_role' AND action='view_truck_phone'");
 await assert.rejects(truckPhones(pool,uid),{code:'forbidden'});
 }finally{
 await pool.query('DELETE FROM truck_phones WHERE workspace_id=$1',[ws]);
 await pool.query('DELETE FROM line_trucks WHERE workspace_id=$1',[ws]);
 await pool.query("DELETE FROM role_permissions WHERE role='phone_role'");
 await pool.query('DELETE FROM app_users WHERE uid=ANY($1)',[[uid,admin]]);
 await pool.query('DELETE FROM workspaces WHERE id=$1',[ws]);await pool.end();
 }
});
