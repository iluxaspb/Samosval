import {fail} from './tabel-access.mjs';
import {listArchiveSeries,listLatestFinalizedArchives} from './archive-latest.mjs';
const WS=process.env.WORKSPACE_ID||'main_workspace';

// Провенанс всегда присутствует в записи: у legacy-документа без серии его нет,
// и это выражается явным `null`, а не отсутствием ключа (consumer не должен
// различать формы по `in`/`undefined`).
const noProvenance={archiveId:null,archiveSha256:null};

// Запись корзины — ровно та форма, которую пишет `archive.trash` и читает UI
// (`working-test/source/core/10-archive.js`: `i.shift.*`, сортировка по
// `deletedAt`). Байты — immutable latest finalized, `deletedAt/deletedBy*` —
// метаданные размещения из override, провенанс — аддитивно рядом.
function trashEntry(entry,override){
  const meta=override&&typeof override==='object'?override:{};
  return {
    shift:entry,
    deletedAt:Number.isFinite(meta.deletedAt)?meta.deletedAt:null,
    deletedBy:typeof meta.deletedBy==='string'?meta.deletedBy:null,
    deletedByUid:typeof meta.deletedByUid==='string'?meta.deletedByUid:null,
    id:entry.id,revision:entry.revision,
    archiveId:entry.archiveId,archiveSha256:entry.archiveSha256,
  };
}

// Единственный read-path архива (design §4.6, §5.2): список, default open,
// PNG-совместимый экспорт, analytics, material и tabel-проекция получают ровно
// `(archiveId, revision, sha256)` из `latest_finalized_*` на момент своей
// транзакции. Ни один consumer не выбирает «первую» или «максимальную» ревизию.
export async function readArchiveEntries(client,ws=WS){
    const state=(await client.query('SELECT initialized,import_sha256 FROM identity_state WHERE id=1')).rows[0];
    if(!state?.initialized||!state.import_sha256)throw fail('archive-not-ready',409);
    const source=(await client.query('SELECT workspace_id,source_project,exported_at FROM migration_imports WHERE sha256=$1',[state.import_sha256])).rows[0];
    if(!source||source.workspace_id!==ws||!['samosval-offline','samosval-test'].includes(source.source_project))throw fail('archive-source-mismatch',409);
    const archives=new Map(),trash=new Map();
    // 1. Авторитетные серии: только latest_finalized_* и точная ревизия по нему.
    const series=await listArchiveSeries(client,ws),seriesIds=new Set(series.map(row=>row.archiveId));
    for(const latest of await listLatestFinalizedArchives(client,ws)){
      // Серия без финализации не даёт default-записи: подставлять её первую или
      // максимальную ревизию запрещено.
      const entry={...latest.payload,id:latest.archiveId,revision:latest.revision,archiveId:latest.archiveId,archiveSha256:latest.sha256};
      if(latest.currentLocation==='trash')trash.set(latest.archiveId,trashEntry(entry,null));
      else archives.set(latest.archiveId,entry);
    }
    // 2. Совместимость до миграции архива: серии ещё нет — источником остаётся
    // pre-revision документ (одна immutable-запись, выбирать нечего).
    const prefix='workspaces/'+ws+'/archive/';
    const original=(await client.query('SELECT document_path,payload FROM migration_documents WHERE import_sha256=$1 AND left(document_path,length($2))=$2 ORDER BY document_path',[state.import_sha256,prefix])).rows;
    for(const row of original){const id=row.document_path.slice(prefix.length);if(!id||id.includes('/'))throw fail('invalid-archive-import',409);if(seriesIds.has(id))continue;archives.set(id,{...row.payload,id,revision:1,...noProvenance});}
    const current=(await client.query('SELECT archive_id,payload FROM shift_archives WHERE workspace_id=$1 ORDER BY archive_id',[ws])).rows;
    for(const row of current){if(seriesIds.has(row.archive_id))continue;if(archives.has(row.archive_id))throw fail('archive-id-conflict',409);archives.set(row.archive_id,{...row.payload,id:row.archive_id,revision:1,...noProvenance});}
    const trashPrefix='workspaces/'+ws+'/trash/';
    const trashRows=(await client.query('SELECT document_path,payload FROM migration_documents WHERE import_sha256=$1 AND left(document_path,length($2))=$2 ORDER BY document_path',[state.import_sha256,trashPrefix])).rows;
    for(const row of trashRows){const id=row.document_path.slice(trashPrefix.length);if(!id||id.includes('/'))throw fail('invalid-trash-import',409);if(seriesIds.has(id))continue;trash.set(id,{...row.payload,id,revision:1,...noProvenance});}
    for(const row of (await client.query('SELECT record_id,location,payload,revision FROM archive_overrides WHERE workspace_id=$1 ORDER BY record_id',[ws])).rows){
      if(seriesIds.has(row.record_id)){
        // У серии override задаёт только catalog placement (архив/корзина):
        // байты, ревизия и sha256 всегда остаются из latest finalized. Для
        // корзины из override берутся лишь `deletedAt/deletedBy*` — форма
        // ответа та же, что у legacy-записи.
        const entry=archives.get(row.record_id)??trash.get(row.record_id)?.shift;
        if(!entry)continue;
        archives.delete(row.record_id);trash.delete(row.record_id);
        if(row.location==='archive')archives.set(row.record_id,entry);
        else if(row.location==='trash')trash.set(row.record_id,trashEntry(entry,row.payload));
        continue;
      }
      archives.delete(row.record_id);trash.delete(row.record_id);
      if(row.location==='archive')archives.set(row.record_id,{...row.payload,id:row.record_id,revision:Number(row.revision),...noProvenance});
      if(row.location==='trash')trash.set(row.record_id,{...row.payload,id:row.record_id,revision:Number(row.revision),...noProvenance});
    }
    return {archives:[...archives.values()],trash:[...trash.values()],importedAt:Number(source.exported_at)};
}
export async function readArchiveSnapshot(pool,uid,ws=WS){
  const client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const actor=(await client.query('SELECT role,status,profile FROM app_users WHERE uid=$1',[uid])).rows[0];
    if(!actor||actor.status!=='active'||actor.profile?.deleted)throw fail('forbidden',403);
    if(actor.role!=='admin'&&!(await client.query("SELECT 1 FROM role_permissions WHERE role=$1 AND action IN ('tab_archive','tab_analytics') AND allowed=true LIMIT 1",[actor.role])).rowCount)throw fail('forbidden',403);
    const data=await readArchiveEntries(client,ws);
    await client.query('COMMIT');
    return {format:'samosval-archive-snapshot',version:1,source:'ubuntu',workspaceId:ws,...data};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
