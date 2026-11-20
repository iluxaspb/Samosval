import pg from '../server/node_modules/pg/lib/index.js';import {scryptSync,randomBytes,createHash} from 'node:crypto';
import {readlinkSync} from 'node:fs';
import {ROLES,TABS} from '../server/src/identity-rules.mjs';
const pool=new pg.Pool({host:process.env.PGHOST,database:process.env.POSTGRES_DB,user:process.env.POSTGRES_USER});
if(!process.env.PGHOST?.includes('/browser-fix.'))throw Error('isolated fixture socket required');
if(readlinkSync('/proc/self/ns/net')===readlinkSync('/proc/1/ns/net')||process.env.POSTGRES_DB!=='samosval_test')throw Error('isolated synthetic database required');
try{
 await pool.query('BEGIN');
 for(const role of [...ROLES,'pending','disabled']){const uid='synthetic_'+role,salt=randomBytes(16).toString('hex');const hash=scryptSync('Synthetic-only-889!',salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024}).toString('hex');await pool.query('INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$1,$3,$4)',[uid,role+'@example.test',ROLES.includes(role)?role:'viewer',ROLES.includes(role)?'active':role]);await pool.query('INSERT INTO user_credentials(uid,password_hash,salt) VALUES($1,$2,$3)',[uid,hash,salt]);}
 const sha=createHash('sha256').update('phone-896-synthetic-import-v1').digest('hex');
 await pool.query("INSERT INTO migration_imports(sha256,workspace_id,source_project,exported_at,counts) VALUES($1,'main_workspace','synthetic-phone-qa',1,$2)",[sha,{trucks:3,objects:1,shift:1,logs:1}]);
 const docs={trucks:{synthetic_truck:{brand:'Synthetic',number:'QA896',defaultVol:20,isGAI:false},synthetic_empty:{brand:'Empty',number:'QA897',defaultVol:10,isGAI:false},synthetic_delete:{brand:'Delete',number:'QA898',defaultVol:15,isGAI:false}},objects:{synthetic_site:{name:'Synthetic site'}},shift:{current:{id:'synthetic_shift',isActive:true,objectId:'synthetic_site',objectName:'Synthetic site',activeLineIds:['synthetic_truck','synthetic_empty'],date:'20.11.2026'}},logs:{synthetic_log:{truckId:'synthetic_truck',shiftId:'synthetic_shift',timestamp:1795186800000,volume:20,comment:'Synthetic baseline'}}};
 for(const [collection,rows] of Object.entries(docs))for(const [id,payload] of Object.entries(rows))await pool.query('INSERT INTO migration_documents VALUES($1,$2,$3)',[sha,`workspaces/main_workspace/${collection}/${id}`,payload]);
 for(const [id,data] of Object.entries(docs.trucks))await pool.query("INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES('main_workspace',$1,$2)",[id,data]);
 await pool.query("INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES('main_workspace','synthetic_site',$1)",[docs.objects.synthetic_site]);
 await pool.query("INSERT INTO shifts VALUES('main_workspace','synthetic_shift',true,$1)",[docs.shift.current]);
 for(const id of docs.shift.current.activeLineIds)await pool.query("INSERT INTO line_truck_statuses VALUES('main_workspace',$1,'synthetic_shift',$2)",[id,{arrived:false,ttnStatus:'pending'}]);
 await pool.query("INSERT INTO line_logs VALUES('main_workspace','synthetic_log','synthetic_shift','synthetic_truck',$1)",[docs.logs.synthetic_log]);
 await pool.query("INSERT INTO workspace_settings(workspace_id,payload) VALUES('main_workspace',$1)",[{cycleMinutes:15}]);
 await pool.query("INSERT INTO workspace_services_state VALUES('main_workspace',$1)",[sha]);
 await pool.query("UPDATE identity_state SET initialized=true,owner_uid='synthetic_admin',import_sha256=$1 WHERE id=1",[sha]);
 await pool.query("UPDATE server_authority SET provider='ubuntu',generation=3 WHERE workspace_id='main_workspace'");
 await pool.query("UPDATE workspaces SET restore_epoch=7 WHERE id='main_workspace'");
 for(const role of ROLES.filter(r=>r!=='admin'))for(const action of [...TABS.filter(t=>t!=='admin').map(t=>'tab_'+t),'view_truck_phone','call_truck_phone','add_truck_phone'])await pool.query('INSERT INTO role_permissions(role,action,allowed) VALUES($1,$2,true) ON CONFLICT(role,action) DO UPDATE SET allowed=true',[role,action]);
 await pool.query('COMMIT');
 console.log('Synthetic seed: five active roles, pending/disabled, import metadata, three trucks, object, active shift, statuses, trip, epoch=7 generation=3');
}catch(error){await pool.query('ROLLBACK');throw error;
}finally{await pool.end();}
