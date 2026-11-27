import pg from '../server/node_modules/pg/lib/index.js';
import {scryptSync,randomBytes,createHash} from 'node:crypto';
import {readlinkSync} from 'node:fs';
import {TABS} from '../server/src/identity-rules.mjs';

// Synthetic fixture for the parallel-shift phone acceptance (task 29C).
//
// The fixture owns identities, one object, trucks, settings, authority and
// epoch. It deliberately creates NO shift: day/night shifts are created by the
// browser scenario through the real v2 UI, so a seeded singleton shift could
// never be mistaken for a tested one.
const pool=new pg.Pool({host:process.env.PGHOST,database:process.env.POSTGRES_DB,user:process.env.POSTGRES_USER});
if(!process.env.PGHOST?.includes('/browser-fix.'))throw Error('isolated fixture socket required');
if(!/^net:\[[0-9]+\]$/.test(process.env.PHONE_HOST_NS||'')||readlinkSync('/proc/self/ns/net')===process.env.PHONE_HOST_NS||process.env.POSTGRES_DB!=='samosval_test')throw Error('isolated synthetic database required');

const PASSWORD='Synthetic-only-889!';
const users=[
 {uid:'synthetic_admin',email:'admin@example.test',name:'Администратор',role:'admin'},
 {uid:'synthetic_foreman_a',email:'foreman-a@example.test',name:'Прораб Дня',role:'foreman'},
 {uid:'synthetic_foreman_b',email:'foreman-b@example.test',name:'Прораб Ночи',role:'foreman'}
];
const trucks={
 synthetic_truck_a:{brand:'Synthetic A',number:'QA901',defaultVol:20,isGAI:false},
 synthetic_truck_b:{brand:'Synthetic B',number:'QA902',defaultVol:10,isGAI:false}
};
const objects={synthetic_site:{name:'Невский проспект',startDate:'23.11.2026'}};
// Rights the scenario exercises: line reads, shift creation, membership, line
// actions, closing. `force_transfer_truck` stays at its migration default
// (foreman: off, admin: bypass) so the transfer is performed by admin.
const foremanActions=[...TABS.filter(t=>t!=='admin'&&t!=='backup').map(t=>'tab_'+t),
 'start_shift','close_shift','edit_line','action_arrive','action_load','action_ttn',
 'line_timer_reset','manage_trucks','manage_shift_members','view_card_stats','view_header'];

try{
 await pool.query('BEGIN');
 for(const user of users){
  const salt=randomBytes(16).toString('hex');
  const hash=scryptSync(PASSWORD,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024}).toString('hex');
  await pool.query('INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$3,$4,$5)',
   [user.uid,user.email,user.name,user.role,'active']);
  await pool.query('INSERT INTO user_credentials(uid,password_hash,salt) VALUES($1,$2,$3)',[user.uid,hash,salt]);
 }
 const sha=createHash('sha256').update('phone-parallel-synthetic-import-v1').digest('hex');
 await pool.query("INSERT INTO migration_imports(sha256,workspace_id,source_project,exported_at,counts) VALUES($1,'main_workspace','samosval-offline',1,$2)",
  [sha,{trucks:Object.keys(trucks).length,objects:Object.keys(objects).length,shift:0,logs:0}]);
 for(const [id,payload] of Object.entries(trucks)){
  await pool.query('INSERT INTO migration_documents VALUES($1,$2,$3)',[sha,`workspaces/main_workspace/trucks/${id}`,payload]);
  await pool.query("INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES('main_workspace',$1,$2)",[id,payload]);
 }
 for(const [id,payload] of Object.entries(objects)){
  await pool.query('INSERT INTO migration_documents VALUES($1,$2,$3)',[sha,`workspaces/main_workspace/objects/${id}`,payload]);
  await pool.query("INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES('main_workspace',$1,$2)",[id,payload]);
 }
 await pool.query("INSERT INTO workspace_settings(workspace_id,payload) VALUES('main_workspace',$1)",[{cycleMinutes:15}]);
 await pool.query('INSERT INTO workspace_services_state VALUES($1,$2)',['main_workspace',sha]);
 await pool.query("UPDATE identity_state SET initialized=true,owner_uid='synthetic_admin',import_sha256=$1 WHERE id=1",[sha]);
 await pool.query("UPDATE server_authority SET provider='ubuntu',generation=3 WHERE workspace_id='main_workspace'");
 await pool.query("UPDATE workspaces SET restore_epoch=7 WHERE id='main_workspace'");
 for(const action of foremanActions){
  await pool.query('INSERT INTO role_permissions(role,action,allowed) VALUES($1,$2,true) ON CONFLICT(role,action) DO UPDATE SET allowed=true',['foreman',action]);
 }
 await pool.query('COMMIT');
 console.log('Synthetic parallel seed: admin + two foremen, one object, two trucks, settings, epoch=7 generation=3, no shift');
}catch(error){await pool.query('ROLLBACK');throw error;
}finally{await pool.end();}
