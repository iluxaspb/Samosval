import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {seedObjects} from '../scripts/seed-objects.mjs';
test('PostgreSQL object promotion validates source and preserves imported fields',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL}),sha=randomBytes(32).toString('hex'),id='seed_'+sha.slice(0,24),path='workspaces/main_workspace/objects/'+id;
  let copied=false;
  // Имя БД тест узнаёт у самой цели и передаёт явно: production-гард
  // seedObjects не ослаблен, он по-прежнему требует совпадения имени.
  const database=(await pool.query('SELECT current_database() AS name')).rows[0].name;
  try {
    // import-таблицы приходят из манифестной фикстуры `import-schema`: она
    // проверяет точные имена, FK и пустоту до старта теста. Создавать их здесь
    // нельзя — у app-роли нет CREATE на schema public.
    await pool.query("INSERT INTO migration_imports(sha256,workspace_id,source_project,exported_at,counts) VALUES ($1,'main_workspace','samosval-offline',1,'{\"objects\":1}')",[sha]);
    const payload={name:'Original object',nested:{retained:true},createdBy:'Original creator'};
    await pool.query('INSERT INTO migration_documents(import_sha256,document_path,payload) VALUES ($1,$2,$3)',[sha,path,payload]);
    await t.test('missing import and count mismatch fail without promoting data',async()=>{
      await assert.rejects(seedObjects(pool,{sha256:'0'.repeat(64),expectedDatabase:database}),{code:'wrong-import-source'});
      await pool.query("UPDATE migration_imports SET counts='{\"objects\":2}' WHERE sha256=$1",[sha]);
      await assert.rejects(seedObjects(pool,{sha256:sha,expectedDatabase:database}),{code:'object-count-mismatch'});
      await pool.query("UPDATE migration_imports SET counts='{\"objects\":1}' WHERE sha256=$1",[sha]);
    });
    await t.test('one atomic promotion retains payload; second seed cannot overwrite it',async()=>{
      const result=await seedObjects(pool,{sha256:sha,expectedDatabase:database});copied=true;
      assert.equal(result.objects,1);
      assert.deepEqual((await pool.query("SELECT payload FROM workspace_objects WHERE workspace_id='main_workspace' AND object_id=$1",[id])).rows[0].payload,payload);
      await assert.rejects(seedObjects(pool,{sha256:sha,expectedDatabase:database}),{code:'target-not-empty'});
    });
  }finally{
    if(copied)await pool.query("DELETE FROM workspace_objects WHERE workspace_id='main_workspace' AND object_id=$1",[id]);
    await pool.query('DELETE FROM migration_documents WHERE import_sha256=$1',[sha]);
    await pool.query('DELETE FROM migration_imports WHERE sha256=$1',[sha]);
    await pool.end();
  }
});
