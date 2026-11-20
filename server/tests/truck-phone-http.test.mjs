import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {once} from 'node:events';import pg from 'pg';import {signSession} from '../src/auth-local.mjs';
test('real HTTP phone auth, ACL, epoch, authority, legacy read and field isolation',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});const secret='89'.repeat(32),origin='http://127.0.0.1:18099';let child;
 const tokens={};const ids=['http_admin','http_viewer','http_disabled'];
 try{
 for(const [uid,role,status] of [[ids[0],'admin','active'],[ids[1],'viewer','active'],[ids[2],'viewer','disabled']]){
 await pool.query('INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$1,$1,$2,$3)',[uid,role,status]);
 await pool.query("INSERT INTO user_sessions(id,uid,token_hash,expires_at) VALUES($1,$1,$1,now()+interval '1 hour')",[uid]);tokens[uid]=await signSession({uid,sid:uid},{secret,type:'access'});
 }
 await pool.query("INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES('main_workspace','http_truck','{}')");
 await pool.query("UPDATE workspaces SET restore_epoch=7 WHERE id='main_workspace'");
 await pool.query("UPDATE server_authority SET provider='ubuntu',generation=3 WHERE workspace_id='main_workspace'");
 child=spawn(process.execPath,['server/src/index.mjs'],{env:{...process.env,AUTH_SESSION_SECRET:secret,FIREBASE_PROJECT_ID:'synthetic-phone-qa',WORKSPACE_ID:'main_workspace',PORT:'18099',ALLOWED_ORIGINS:origin},stdio:'ignore'});
 for(let i=0;i<100;i++){try{await fetch(origin+'/health/live');break;}catch{await new Promise(r=>setTimeout(r,50));}}
 const req=(uid,body,extra={},path='/api/v1/truck-phones')=>fetch(origin+path,{method:body?'POST':'GET',headers:{Origin:origin,...(uid?{Authorization:'Bearer '+tokens[uid]}:{}),'X-Samosval-Epoch':'7','X-Samosval-Generation':'3','Content-Type':'application/json',...extra},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await req(null)).status,401);assert.equal((await req(ids[2])).status,401);
 assert.equal((await req(ids[0],null,{Origin:'https://evil.invalid'})).status,403);
 assert.equal((await req(ids[1])).status,403);
 const patch={truckId:'http_truck',phone:'+123456789'};
 assert.equal((await req(ids[0],patch,{'X-Samosval-Epoch':'6'})).status,409);
 assert.equal((await req(ids[0],patch,{'X-Samosval-Generation':'2'})).status,409);
 assert.equal((await req(ids[0],{...patch,brand:'evil'})).status,400);
 assert.equal((await req(ids[0],patch)).status,200);
 assert.equal((await (await req(ids[0])).json()).phones[0].phone,patch.phone);
 for(const path of ['/api/v1/catalog','/api/v1/line/snapshot']){const res=await req(ids[0],null,{},path);assert.equal(res.status,200);assert.equal((await res.text()).includes(patch.phone),false);}
 await pool.query("INSERT INTO role_permissions(role,action,allowed) VALUES('viewer','view_truck_phone',true) ON CONFLICT(role,action) DO UPDATE SET allowed=true");
 assert.equal((await req(ids[1])).status,200);assert.equal((await req(ids[1],patch)).status,403);
 await pool.query("DELETE FROM role_permissions WHERE role='viewer' AND action='view_truck_phone'");assert.equal((await req(ids[1])).status,403);
 }finally{
 if(child){child.kill();await once(child,'exit');}
 await pool.query("DELETE FROM line_trucks WHERE workspace_id='main_workspace' AND truck_id='http_truck'");await pool.query('DELETE FROM app_users WHERE uid=ANY($1)',[ids]);await pool.query("UPDATE workspaces SET restore_epoch=0 WHERE id='main_workspace'");await pool.query("UPDATE server_authority SET provider='ubuntu',generation=1 WHERE workspace_id='main_workspace'");await pool.end();
 }
});
