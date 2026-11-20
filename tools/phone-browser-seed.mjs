import pg from '../server/node_modules/pg/lib/index.js';import {scryptSync,randomBytes} from 'node:crypto';
const pool=new pg.Pool({host:process.env.PGHOST,database:process.env.POSTGRES_DB,user:process.env.POSTGRES_USER});
if(!process.env.PGHOST?.includes('/browser-fix.'))throw Error('isolated fixture socket required');
try{
 for(const role of ['admin','viewer']){const uid='synthetic_'+role,salt=randomBytes(16).toString('hex');const hash=scryptSync('Synthetic-only-889!',salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024}).toString('hex');await pool.query("INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$1,$3,'active')",[uid,role+'@example.test',role]);await pool.query('INSERT INTO user_credentials(uid,password_hash,salt) VALUES($1,$2,$3)',[uid,hash,salt]);}
 await pool.query("UPDATE identity_state SET initialized=true,owner_uid='synthetic_admin' WHERE id=1");
 await pool.query("INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES('main_workspace','synthetic_truck',$1)",[{brand:'Synthetic',number:'QA889',defaultVol:20,isGAI:false}]);
}finally{await pool.end();}
