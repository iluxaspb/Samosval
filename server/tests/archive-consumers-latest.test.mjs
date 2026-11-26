// Task 10 (P10): потребители читают ровно последнюю финализированную ревизию
// архива (design §4.6 строка 243, §5.2 строка 578), а явные history/revision
// API отдают точные байты каждой ревизии и ничего не меняют.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import pg from 'pg';

import {applyMigrationsThrough,requireIsolatedDatabase,resetIsolatedDatabase} from './helpers/isolated-db.mjs';
import {listArchiveSeries,readArchiveHistory,readArchiveRevision,readLatestFinalizedArchive} from '../src/archive-latest.mjs';
import {readArchiveEntries,readArchiveSnapshot} from '../src/archive-read.mjs';
import {readBackups,submitBackup} from '../src/backup-store.mjs';
import {readRestoredContext} from '../src/restored-context-store.mjs';

const connectionString=process.env.TEST_DATABASE_URL;
let approved=false;
if(connectionString&&process.env.SAMOSVAL_ISOLATED_TEST==='1'){
  try{requireIsolatedDatabase(connectionString);approved=true;}catch{}
}

const sha=value=>createHash('sha256').update(value).digest('hex');
const bytesOf=value=>Buffer.from(JSON.stringify(value),'utf8');

const WS='workspace_p10_latest';
const ADMIN='admin_p10';
const EDITOR='editor_p10';
const TRUCK='truck_p10';
const IMPORT_SHA=sha('p10-import');
const SHIFT_A='shift_archive_p10_a';
const SHIFT_B='shift_archive_p10_b';
const SHIFT_C='shift_archive_p10_c';
const ARCHIVE_A='archive_p10_a';
const ARCHIVE_B='archive_p10_b';
const ARCHIVE_C='archive_p10_c';
const OPEN_CTX='ctx_p10_open';

// Ровно те таблицы, чтение которых обязано быть без записи.
const READ_ONLY_TABLES=['shifts','line_logs','line_truck_statuses','shift_archives','archive_overrides',
  'shift_archive_series','shift_archive_revisions','archive_revision_publications',
  'restored_shift_contexts','restored_context_logs','restored_context_history','archive_operation_receipts',
  'archive_audit','workspace_backups'];

const archivePayload=(archiveId,revision)=>({
  sourceShiftId:`shift_${archiveId}`,
  objectId:'site',objectName:'Объект',date:'23.11.2026',
  activeLineIds:[TRUCK],ttnStatus:{[TRUCK]:'pending'},
  logs:[{id:`${archiveId}_rev${revision}`,truckId:TRUCK,timestamp:1000+revision,volume:revision*10,isGAI:false}],
  totalTrips:1,totalVolume:revision*10,
});

let pool;

async function withClient(fn){
  const client=await pool.connect();
  try{return await fn(client);}finally{client.release();}
}

// Серия + цепочка ревизий + указатель latest (или без него). Данные — прямым SQL
// по схеме P6: Task 9 (finalize) в другой ветке и на его код опираться нельзя.
async function seedSeries(client,{archiveId,sourceShiftId,revisions=[1],pointer=null,location='archive'}){
  await client.query(
    'INSERT INTO shift_archive_series(workspace_id,archive_id,source_shift_id,current_location) VALUES($1,$2,$3,$4)',
    [WS,archiveId,sourceShiftId,location],
  );
  const created=[];
  let previous=null;
  for(const revision of revisions){
    const bytes=bytesOf(archivePayload(archiveId,revision)),digest=sha(bytes);
    await client.query(
      `INSERT INTO shift_archive_revisions(
         workspace_id,archive_id,archive_revision,previous_revision,previous_sha256,
         payload_bytes,payload_sha256,payload_schema_version,source_kind,source_locator,created_by_uid)
       VALUES($1,$2,$3,$4,$5,$6,$7,2,'legacy-import',$8,$9)`,
      [WS,archiveId,revision,previous?.revision??null,previous?.sha256??null,bytes,digest,
        `fixture:${archiveId}:${revision}`,ADMIN],
    );
    previous={revision,sha256:digest,bytes};
    created.push(previous);
  }
  const latest=pointer===null?null:created.find(item=>item.revision===pointer);
  if(pointer!==null){
    if(!latest)throw new Error(`fixture pointer ${pointer} has no revision`);
    await client.query(
      'UPDATE shift_archive_series SET latest_finalized_revision=$3,latest_finalized_sha256=$4 WHERE workspace_id=$1 AND archive_id=$2',
      [WS,archiveId,pointer,latest.sha256],
    );
  }
  return created;
}

async function counters(client){
  const counts={};
  for(const table of READ_ONLY_TABLES){
    counts[table]=Number((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
  }
  counts.pointerA=(await client.query(
    'SELECT latest_finalized_revision::text AS revision,latest_finalized_sha256 FROM shift_archive_series WHERE workspace_id=$1 AND archive_id=$2',
    [WS,ARCHIVE_A],
  )).rows[0];
  counts.pointerC=(await client.query(
    'SELECT latest_finalized_revision::text AS revision,latest_finalized_sha256 FROM shift_archive_series WHERE workspace_id=$1 AND archive_id=$2',
    [WS,ARCHIVE_C],
  )).rows[0];
  return counts;
}

test.before(async()=>{
  if(!approved)return;
  await resetIsolatedDatabase();
  await applyMigrationsThrough(25);
  pool=new pg.Pool({connectionString,max:4});
  await withClient(async client=>{
    await client.query('CREATE TABLE IF NOT EXISTS migration_imports (sha256 text PRIMARY KEY,workspace_id text NOT NULL,source_project text NOT NULL,exported_at bigint NOT NULL,imported_at timestamptz NOT NULL DEFAULT now(),counts jsonb NOT NULL)');
    await client.query('CREATE TABLE IF NOT EXISTS migration_documents (import_sha256 text NOT NULL REFERENCES migration_imports(sha256),document_path text NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(import_sha256,document_path))');
    await client.query('INSERT INTO workspaces(id) VALUES($1)',[WS]);
    for(const [uid,role] of [[ADMIN,'admin'],[EDITOR,'archivist']]){
      await client.query("INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$1,$3,'active')",[uid,`${uid}@example.test`,role]);
    }
    for(const action of ['tab_archive','tab_analytics'])await client.query("INSERT INTO role_permissions(role,action,allowed) VALUES('archivist',$1,true)",[action]);
    await client.query('INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES($1,$2,$3)',[WS,TRUCK,{id:TRUCK,name:TRUCK}]);
    await client.query('INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES($1,$2,$3)',[WS,'site',{id:'site',name:'Объект'}]);
    await client.query("INSERT INTO migration_imports(sha256,workspace_id,source_project,exported_at,counts) VALUES($1,$2,'samosval-offline',1700000000000,'{}')",[IMPORT_SHA,WS]);
    await client.query('UPDATE identity_state SET initialized=true,import_sha256=$1 WHERE id=1',[IMPORT_SHA]);

    // A: две финализированные ревизии, latest = 2.
    await seedSeries(client,{archiveId:ARCHIVE_A,sourceShiftId:SHIFT_A,revisions:[1,2],pointer:2});
    // B: серия в корзине, latest = 1 (placement не скрывает chain от history/backup).
    await seedSeries(client,{archiveId:ARCHIVE_B,sourceShiftId:SHIFT_B,revisions:[1],pointer:1,location:'trash'});
    // C: серия без финализации: ревизия есть, указателя нет.
    await seedSeries(client,{archiveId:ARCHIVE_C,sourceShiftId:SHIFT_C,revisions:[1],pointer:null});

    // Ловушки: live-строка смены, рейсы линии и legacy-архив с другими объёмами.
    await client.query('INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,false,$3)',
      [WS,SHIFT_A,{payloadSchemaVersion:2,id:SHIFT_A,shiftId:SHIFT_A,objectId:'site',objectName:'Объект',
        startDate:'26.11.2026',date:'2026-11-26',workShift:'day',type:'day',state:'historical',isActive:false,
        startedAt:Date.UTC(2026,10,26,5,0,0),startedBy:'Прораб',startedByUid:ADMIN}]);
    await client.query('INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES($1,$2,$3,$4,$5)',
      [WS,'line_trap_log',SHIFT_A,TRUCK,{id:'line_trap_log',shiftId:SHIFT_A,truckId:TRUCK,timestamp:1,volume:999999}]);
    await client.query('INSERT INTO shift_archives(workspace_id,archive_id,shift_id,payload) VALUES($1,$2,$3,$4)',
      [WS,ARCHIVE_A,SHIFT_A,{sourceShiftId:SHIFT_A,logs:[{id:'legacy_trap',truckId:TRUCK,timestamp:1,volume:777777}],totalTrips:1,totalVolume:777777}]);
    // Legacy-строка для НЕфинализированной серии: даже она не даёт default-записи,
    // иначе «нет latest» тихо подменялось бы старой копией архива.
    await client.query('INSERT INTO shift_archives(workspace_id,archive_id,shift_id,payload) VALUES($1,$2,$3,$4)',
      [WS,ARCHIVE_C,SHIFT_C,{sourceShiftId:SHIFT_C,logs:[{id:'legacy_c_trap',truckId:TRUCK,timestamp:1,volume:333333}],totalTrips:1,totalVolume:333333}]);

    // Открытый restored-контекст поверх latest A: чтение контекста — это P8, а не
    // latest архива, и указатель оно двигать не имеет права.
    await client.query(
      `INSERT INTO restored_shift_contexts(
         workspace_id,restored_context_id,archive_id,source_shift_id,mode,context_state,
         original_opened_by_uid,original_opened_by_name_snapshot,original_identity_resolution,
         original_shift_type,original_shift_type_resolution,
         restored_by_uid,restored_by_name_snapshot,restored_at,
         archive_revision,context_revision,restore_operation_id,
         source_state_snapshot,source_shift_revision,opened_at_snapshot,object_id,object_name,work_date)
       VALUES($1,$2,$3,$4,'parallel','open',$5,'Старый Автор','source','day','source',$5,'Восстановивший',now(),
              2,1,'op_restore_p10','{"source":"archive"}'::jsonb,7,now(),'site','Объект',DATE '2026-11-23')`,
      [WS,OPEN_CTX,ARCHIVE_A,SHIFT_A,ADMIN],
    );
  });
});

test.after(async()=>{if(pool)await pool.end();});

test('default consumers read exactly the latest finalized revision',{skip:!approved},async t=>{
  await t.test('resolver reads only latest_finalized_* and the exact revision',async()=>{
    await withClient(async client=>{
      const latest=await readLatestFinalizedArchive(client,WS,ARCHIVE_A);
      const expected=bytesOf(archivePayload(ARCHIVE_A,2));
      assert.equal(latest.archiveId,ARCHIVE_A);
      assert.equal(latest.revision,2);
      assert.equal(latest.sha256,sha(expected));
      assert.deepEqual(latest.payloadBytes,expected);
      assert.equal(latest.payload.logs[0].id,ARCHIVE_A+'_rev2');
      assert.equal(latest.sourceShiftId,SHIFT_A);
      assert.equal(latest.currentLocation,'archive');
      assert.ok(Number.isFinite(Date.parse(latest.finalizedAt)),'finalizedAt is the revision created_at');
      // Не «первая» ревизия и не «максимальная» догадка.
      assert.notEqual(latest.sha256,sha(bytesOf(archivePayload(ARCHIVE_A,1))));
      // Неизвестный архив — null, а не исключение и не выдуманная запись.
      assert.equal(await readLatestFinalizedArchive(client,WS,'archive_p10_absent'),null);
    });
  });

  await t.test('archive list and default open (snapshot/PNG/analytics path) show latest',async()=>{
    const snapshot=await readArchiveSnapshot(pool,EDITOR,WS);
    const entry=snapshot.archives.find(row=>row.id===ARCHIVE_A);
    assert.ok(entry,'series A is in the default list');
    assert.equal(entry.revision,2);
    assert.equal(entry.archiveId,ARCHIVE_A);
    assert.equal(entry.archiveSha256,sha(bytesOf(archivePayload(ARCHIVE_A,2))));
    assert.equal(entry.logs[0].id,ARCHIVE_A+'_rev2');
    assert.equal(entry.totalVolume,20);
    // Trash placement виден только в корзине.
    assert.equal(snapshot.archives.some(row=>row.id===ARCHIVE_B),false);
    assert.equal(snapshot.trash.some(row=>row.id===ARCHIVE_B),true);
    assert.equal(snapshot.trash.find(row=>row.id===ARCHIVE_B).revision,1);
  });

  await t.test('backup projection carries latest plus the full exact chain',async()=>{
    const created=await submitBackup(pool,ADMIN,{id:'p10_backup',type:'backup.create',backupType:'manual',description:'Task 10'},WS);
    const backup=await readBackups(pool,ADMIN,created.result.meta.id,WS);
    const entry=backup.payload.data.archive.find(row=>row.id===ARCHIVE_A);
    assert.equal(entry.data.revision,2);
    assert.equal(entry.data.archiveSha256,sha(bytesOf(archivePayload(ARCHIVE_A,2))));
    const chain=backup.payload.data.archiveRevisions.find(row=>row.id===ARCHIVE_A);
    assert.ok(chain,'backup keeps the immutable chain, not only latest');
    assert.deepEqual(chain.revisions.map(row=>row.revision),[1,2]);
    for(const revision of chain.revisions){
      const exact=bytesOf(archivePayload(ARCHIVE_A,revision.revision));
      assert.equal(revision.sha256,sha(exact));
      assert.deepEqual(Buffer.from(revision.payloadBase64,'base64'),exact);
      assert.equal(sha(Buffer.from(revision.payloadBase64,'base64')),revision.sha256);
    }
    // Trash placement не скрывает цепочку от full backup.
    assert.ok(backup.payload.data.archiveRevisions.some(row=>row.id===ARCHIVE_B));
  });
});

test('explicit revision and history are exact, ordered and read-only',{skip:!approved},async t=>{
  await t.test('history returns original plus every revision in order',async()=>{
    await withClient(async client=>{
      const history=await readArchiveHistory(client,WS,ARCHIVE_A);
      assert.equal(history.archiveId,ARCHIVE_A);
      assert.equal(history.sourceShiftId,SHIFT_A);
      assert.equal(history.latestFinalizedRevision,2);
      assert.deepEqual(history.revisions.map(row=>row.revision),[1,2]);
      for(const row of history.revisions){
        const exact=bytesOf(archivePayload(ARCHIVE_A,row.revision));
        assert.deepEqual(row.payloadBytes,exact);
        assert.equal(row.sha256,sha(exact));
        assert.equal(sha(row.payloadBytes),row.sha256);
      }
      // Deterministic order: повторное чтение даёт тот же порядок и байты.
      const again=await readArchiveHistory(client,WS,ARCHIVE_A);
      assert.deepEqual(again.revisions.map(row=>row.revision),[1,2]);
      assert.deepEqual(again.revisions.map(row=>row.sha256),history.revisions.map(row=>row.sha256));
    });
  });

  await t.test('explicit revision read returns the exact immutable bytes of the first revision',async()=>{
    await withClient(async client=>{
      const first=await readArchiveRevision(client,WS,ARCHIVE_A,1);
      const exact=bytesOf(archivePayload(ARCHIVE_A,1));
      assert.equal(first.revision,1);
      assert.equal(first.previousRevision,null);
      assert.equal(first.previousSha256,null);
      assert.deepEqual(first.payloadBytes,exact);
      assert.equal(first.sha256,sha(exact));
      assert.equal(first.payload.logs[0].id,ARCHIVE_A+'_rev1');
      assert.equal((await readArchiveRevision(client,WS,ARCHIVE_A,2)).revision,2);
      assert.equal(await readArchiveRevision(client,WS,ARCHIVE_A,9),null);
      assert.equal(await readArchiveRevision(client,WS,'archive_p10_absent',1),null);
      // Явное чтение не сдвинуло default pointer.
      assert.equal((await readLatestFinalizedArchive(client,WS,ARCHIVE_A)).revision,2);
    });
  });

  await t.test('history of a trashed series stays available',async()=>{
    await withClient(async client=>{
      const history=await readArchiveHistory(client,WS,ARCHIVE_B);
      assert.equal(history.currentLocation,'trash');
      assert.deepEqual(history.revisions.map(row=>row.revision),[1]);
      assert.deepEqual(history.revisions[0].payloadBytes,bytesOf(archivePayload(ARCHIVE_B,1)));
    });
  });
});

test('open context and trash placement never move latest_finalized_*',{skip:!approved},async t=>{
  await t.test('open restored context reads its base revision, not latest',async()=>{
    await withClient(async client=>{
      const before=await readLatestFinalizedArchive(client,WS,ARCHIVE_A);
      const context=await readRestoredContext(client,{workspaceId:WS,restoredContextId:OPEN_CTX});
      assert.equal(context.archiveRevision,2);
      assert.equal(context.latestFinalizedRevision,2);
      assert.equal(context.baseIsLatest,true);
      assert.equal(context.archiveSha256,before.sha256);
      const after=await readLatestFinalizedArchive(client,WS,ARCHIVE_A);
      assert.deepEqual({revision:after.revision,sha256:after.sha256},{revision:before.revision,sha256:before.sha256});
    });
  });

  await t.test('trash row for another archive and an archive override do not shift the pointer',async()=>{
    await withClient(async client=>{
      // Legacy-строка корзины в том же workspace.
      await client.query(
        "INSERT INTO archive_overrides(workspace_id,record_id,location,payload,revision) VALUES($1,$2,'trash',$3,2)",
        [WS,ARCHIVE_B,archivePayload(ARCHIVE_B,1)],
      );
      // Override для серии задаёт только placement: байты остаются latest.
      await client.query(
        "INSERT INTO archive_overrides(workspace_id,record_id,location,payload,revision) VALUES($1,$2,'archive',$3,9)",
        [WS,ARCHIVE_A,{logs:[{id:'override_trap',volume:555555}],totalVolume:555555}],
      );
      // Более новая ревизия 3 существует в цепочке, но указатель latest всё ещё 2:
      // default-чтение обязано идти по указателю, а не по максимальной ревизии.
      const third=bytesOf(archivePayload(ARCHIVE_A,3));
      await client.query(
        `INSERT INTO shift_archive_revisions(
           workspace_id,archive_id,archive_revision,previous_revision,previous_sha256,
           payload_bytes,payload_sha256,payload_schema_version,source_kind,source_locator,created_by_uid)
         VALUES($1,$2,3,2,$3,$4,$5,2,'legacy-import',$6,$7)`,
        [WS,ARCHIVE_A,sha(bytesOf(archivePayload(ARCHIVE_A,2))),third,sha(third),`fixture:${ARCHIVE_A}:3`,ADMIN],
      );
      const pointer=(await client.query(
        'SELECT latest_finalized_revision::text AS revision,latest_finalized_sha256 FROM shift_archive_series WHERE workspace_id=$1 AND archive_id=$2',
        [WS,ARCHIVE_A],
      )).rows[0];
      assert.deepEqual(pointer,{revision:'2',latest_finalized_sha256:sha(bytesOf(archivePayload(ARCHIVE_A,2)))});

      const snapshot=await readArchiveSnapshot(pool,EDITOR,WS);
      const entry=snapshot.archives.find(row=>row.id===ARCHIVE_A);
      assert.equal(entry.revision,2);
      assert.equal(entry.archiveSha256,sha(bytesOf(archivePayload(ARCHIVE_A,2))));
      assert.equal(entry.logs[0].id,ARCHIVE_A+'_rev2');
      assert.equal(JSON.stringify(entry).includes('override_trap'),false);
      assert.equal(JSON.stringify(entry).includes('555555'),false);
      assert.equal(JSON.stringify(entry).includes(ARCHIVE_A+'_rev3'),false,'a newer non-finalized revision is never the default');
      // Явная история при этом видит всю цепочку, включая ревизию 3.
      const history=await readArchiveHistory(client,WS,ARCHIVE_A);
      assert.deepEqual(history.revisions.map(row=>row.revision),[1,2,3]);
      assert.equal(history.latestFinalizedRevision,2);
      assert.equal(snapshot.trash.some(row=>row.id===ARCHIVE_B),true);
      assert.equal(snapshot.archives.some(row=>row.id===ARCHIVE_B),false);
    });
  });
});

test('unfinalized series has no default entry and never falls back to max revision',{skip:!approved},async t=>{
  await t.test('resolver and consumers return null/empty for an unfinalized series',async()=>{
    await withClient(async client=>{
      assert.equal(await readLatestFinalizedArchive(client,WS,ARCHIVE_C),null);
      const history=await readArchiveHistory(client,WS,ARCHIVE_C);
      assert.equal(history.latestFinalizedRevision,null);
      assert.deepEqual(history.revisions.map(row=>row.revision),[1]);
      const entries=await readArchiveEntries(client,WS);
      assert.equal(entries.archives.some(row=>row.id===ARCHIVE_C),false);
      assert.equal(entries.trash.some(row=>row.id===ARCHIVE_C),false);
      const snapshot=await readArchiveSnapshot(pool,EDITOR,WS);
      assert.equal(snapshot.archives.some(row=>row.id===ARCHIVE_C),false);
      assert.equal(JSON.stringify(snapshot).includes(ARCHIVE_C+'_rev1'),false);
      // Список серий честно показывает, что серия есть, но не финализирована.
      const series=(await listArchiveSeries(client,WS)).find(row=>row.archiveId===ARCHIVE_C);
      assert.equal(series.latestFinalizedRevision,null);
      assert.equal(series.latestFinalizedSha256,null);
    });
  });
});

test('consumers never substitute live line rows for archive revision bytes',{skip:!approved},async t=>{
  await t.test('line_logs and legacy shift_archives traps stay invisible',async()=>{
    await withClient(async client=>{
      const entries=await readArchiveEntries(client,WS);
      const entry=entries.archives.find(row=>row.id===ARCHIVE_A);
      assert.equal(entry.logs[0].id,ARCHIVE_A+'_rev2');
      assert.equal(entry.totalVolume,20);
      const text=JSON.stringify(entries);
      for(const trap of ['line_trap_log','999999','legacy_trap','777777','legacy_c_trap','333333'])assert.equal(text.includes(trap),false,`${trap} leaked into the archive list`);
      const snapshot=JSON.stringify(await readArchiveSnapshot(pool,EDITOR,WS));
      for(const trap of ['line_trap_log','999999','legacy_trap','777777','legacy_c_trap','333333'])assert.equal(snapshot.includes(trap),false,`${trap} leaked into the archive snapshot`);
    });
  });
});

test('reading archives writes nothing',{skip:!approved},async t=>{
  await t.test('row counts and latest pointers are identical before and after',async()=>{
    const before=await withClient(counters);
    await withClient(async client=>{
      await readArchiveEntries(client,WS);
      await readLatestFinalizedArchive(client,WS,ARCHIVE_A);
      await readArchiveRevision(client,WS,ARCHIVE_A,1);
      await readArchiveHistory(client,WS,ARCHIVE_A);
      await readArchiveHistory(client,WS,ARCHIVE_B);
      await listArchiveSeries(client,WS);
    });
    await readArchiveSnapshot(pool,EDITOR,WS);
    const after=await withClient(counters);
    assert.deepEqual(after,before);
  });
});
