import {AsyncLocalStorage} from 'node:async_hooks';
import {fail} from './tabel-access.mjs';
import {currentNasWriterPermit} from './test-writer-guard.mjs';
const context=new AsyncLocalStorage(),ws=process.env.WORKSPACE_ID||'main_workspace';
// Every HTTP write transaction locks the dataset before profile/row locks.
// A restore takes the exclusive form, blocking both current and stale clients.
export function installDatasetGuard(pool){
 pool.on('connect',client=>{const raw=client.query.bind(client);client.query=function(query,...args){
  const text=typeof query==='string'?query:query?.text,ctx=context.getStore(),
    permit=currentNasWriterPermit();
  if(!/^BEGIN\b/i.test(text||'')||/READ ONLY/i.test(text)||(!ctx&&!permit))
   return raw(query,...args);
  return (async()=>{const result=await raw(query,...args);
   // SET LOCAL never survives COMMIT or connection reuse. SQL 016 rejects
   // every tracked write without these values once the gate is armed.
   if(permit)await raw(
    "SELECT set_config('samosval.writer_permit_id',$1,true), set_config('samosval.writer_epoch',$2,true)",
    [permit.permitId,String(permit.epoch)]);
   if(ctx){
    await raw('SELECT '+(ctx.exclusive?'pg_advisory_xact_lock':'pg_advisory_xact_lock_shared')+'(hashtext($1))',['dataset:'+ws]);
    const epoch=Number((await raw('SELECT restore_epoch FROM workspaces WHERE id=$1',[ws])).rows[0]?.restore_epoch||0);
    if(ctx.expected!==String(epoch))throw fail('dataset-restored-reload',409);
   }
   return result;
  })();
 };});
}
export async function datasetRequest(pool,req,res,handler){
 try{
  const epoch=Number((await pool.query('SELECT restore_epoch FROM workspaces WHERE id=$1',[ws])).rows[0]?.restore_epoch||0);
  res.setHeader('X-Samosval-Epoch',String(epoch));
  return await context.run({expected:String(req.headers['x-samosval-epoch']??'0'),exclusive:req.method==='POST'&&new URL(req.url,'http://localhost').pathname==='/api/v1/backups'},handler);
 }catch(e){if(!res.headersSent){res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"database-unavailable"}');}}
}
