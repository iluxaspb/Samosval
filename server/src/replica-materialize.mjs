import { fail, map } from './tabel-access.mjs';

// Материализация изменений Firebase -> PostgreSQL.
//
// Журнал репликации (replica_stream) сам по себе не делает резерв пригодным:
// без этой функции строки копились в журнале, а рабочие таблицы оставались
// пустыми. Здесь каждая операция зеркала применяется к тем же таблицам, из
// которых читает API Ubuntu, в той же транзакции, что и запись в журнал.
//
// Таблицы хранят полный документ Firestore в payload jsonb, поэтому
// преобразование сводится к выбору ключей, которые нужны для чтения.

const docId = path => String(path || '').split('/').filter(Boolean).pop() || '';
const asObject = value => (map(value) ? value : {});

// Резерв не должен падать из-за порядка доставки: зависимые строки
// (статус/рейс ссылаются на смену) создаём заглушкой, настоящий документ
// смены придёт следом и перезапишет payload.
async function ensureShift(client, ws, shiftId) {
  if (!shiftId) return;
  await client.query(
    'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,false,$3::jsonb) ON CONFLICT (workspace_id,shift_id) DO NOTHING',
    [ws, shiftId, '{}']
  );
}

function permissionRows(payload) {
  const rows = [];
  for (const [role, permissions] of Object.entries(asObject(payload))) {
    if (!map(permissions)) continue;
    for (const [field, prefix] of [['tabs', 'tab_'], ['actions', '']]) {
      const values = permissions[field];
      if (!Array.isArray(values)) continue;
      for (const action of new Set(values)) {
        if (typeof action !== 'string' || !action) continue;
        rows.push([role, prefix + action]);
      }
    }
  }
  return rows;
}

/**
 * Применяет одну операцию зеркала к рабочим таблицам резерва.
 * Возвращает true, если операция относится к известной коллекции.
 */
export async function applyReplicaDocument(client, ws, operation) {
  const payload = asObject(operation.payload);
  const collection = String(payload.collection || '');
  const path = String(payload.path || '');
  const id = docId(path);
  const deleted = operation.kind === 'doc.delete';
  if (!id) return false;
  const data = asObject(payload.data);

  switch (collection) {
    case 'shift': {
      if (deleted) {
        await client.query('DELETE FROM shifts WHERE workspace_id=$1 AND shift_id=$2', [ws, id]);
        return true;
      }
      await client.query(
        `INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (workspace_id,shift_id)
         DO UPDATE SET is_active=EXCLUDED.is_active, payload=EXCLUDED.payload`,
        [ws, id, data.isActive === true, JSON.stringify(data)]
      );
      return true;
    }
    case 'trucks': {
      if (deleted) {
        await client.query('DELETE FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2', [ws, id]);
        return true;
      }
      await client.query(
        `INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES ($1,$2,$3::jsonb)
         ON CONFLICT (workspace_id,truck_id)
         DO UPDATE SET payload=EXCLUDED.payload, revision=line_trucks.revision+1`,
        [ws, id, JSON.stringify(data)]
      );
      return true;
    }
    case 'truckStatus': {
      if (deleted) {
        await client.query('DELETE FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2', [ws, id]);
        return true;
      }
      const shiftId = String(data.shiftId || '');
      if (!shiftId) throw fail('replica-status-without-shift');
      await ensureShift(client, ws, shiftId);
      await client.query(
        `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (workspace_id,truck_id)
         DO UPDATE SET shift_id=EXCLUDED.shift_id, payload=EXCLUDED.payload`,
        [ws, id, shiftId, JSON.stringify(data)]
      );
      return true;
    }
    case 'logs': {
      if (deleted) {
        await client.query('DELETE FROM line_logs WHERE workspace_id=$1 AND log_id=$2', [ws, id]);
        return true;
      }
      const shiftId = String(data.shiftId || '');
      const truckId = String(data.truckId || '');
      if (!shiftId || !truckId) throw fail('replica-log-without-shift');
      await ensureShift(client, ws, shiftId);
      // Рейс без строки самосвала тоже должен читаться: создаём заглушку.
      await client.query(
        'INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES ($1,$2,$3::jsonb) ON CONFLICT (workspace_id,truck_id) DO NOTHING',
        [ws, truckId, JSON.stringify({ id: truckId, name: data.truckName || '' })]
      );
      await client.query(
        `INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES ($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT (workspace_id,log_id)
         DO UPDATE SET shift_id=EXCLUDED.shift_id, truck_id=EXCLUDED.truck_id, payload=EXCLUDED.payload`,
        [ws, id, shiftId, truckId, JSON.stringify(data)]
      );
      return true;
    }
    case 'objects': {
      if (deleted) {
        await client.query('DELETE FROM workspace_objects WHERE workspace_id=$1 AND object_id=$2', [ws, id]);
        return true;
      }
      await client.query(
        `INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES ($1,$2,$3::jsonb)
         ON CONFLICT (workspace_id,object_id)
         DO UPDATE SET payload=EXCLUDED.payload, revision=workspace_objects.revision+1`,
        [ws, id, JSON.stringify(data)]
      );
      return true;
    }
    case 'users': {
      if (deleted) {
        await client.query('DELETE FROM app_users WHERE uid=$1', [id]);
        return true;
      }
      const email = String(data.email || '');
      const role = String(data.role || 'driver');
      const status = ['active', 'pending', 'disabled'].includes(data.status) ? data.status : 'pending';
      if (!email) return false;
      await client.query(
        `INSERT INTO app_users(uid,email,display_name,role,status,profile) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT (uid)
         DO UPDATE SET email=EXCLUDED.email, display_name=EXCLUDED.display_name, role=EXCLUDED.role,
                       status=EXCLUDED.status, profile=EXCLUDED.profile, revision=app_users.revision+1`,
        [id, email, String(data.nickname || data.displayName || email), role, status, JSON.stringify(data)]
      );
      return true;
    }
    case 'settings': {
      if (id === 'permissions' && !deleted) {
        // Права ролей в резерве — производная от общего документа настроек.
        const rows = permissionRows(data);
        await client.query('DELETE FROM role_permissions WHERE role = ANY($1::text[])', [
          [...new Set(rows.map(row => row[0]))]
        ]);
        for (const [role, action] of rows) {
          await client.query(
            'INSERT INTO role_permissions(role,action,allowed) VALUES ($1,$2,true) ON CONFLICT (role,action) DO UPDATE SET allowed=true',
            [role, action]
          );
        }
        return true;
      }
      if (id === 'appConfig' && !deleted) {
        const existing = (await client.query('SELECT payload FROM workspace_settings WHERE workspace_id=$1', [ws])).rows[0];
        const merged = { ...(existing?.payload || {}), ...data };
        await client.query(
          `INSERT INTO workspace_settings(workspace_id,payload) VALUES ($1,$2::jsonb)
           ON CONFLICT (workspace_id) DO UPDATE SET payload=EXCLUDED.payload, revision=workspace_settings.revision+1`,
          [ws, JSON.stringify(merged)]
        );
        return true;
      }
      return false;
    }
    case 'archive': {
      if (deleted) {
        await client.query('DELETE FROM shift_archives WHERE workspace_id=$1 AND archive_id=$2', [ws, id]);
        return true;
      }
      const shiftId = String(data.shiftId || id);
      await client.query(
        `INSERT INTO shift_archives(workspace_id,archive_id,shift_id,payload) VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (workspace_id,archive_id)
         DO UPDATE SET payload=EXCLUDED.payload`,
        [ws, id, shiftId, JSON.stringify(data)]
      );
      return true;
    }
    default:
      // audit/notifications/trash/plugins в резерв не материализуем: это не
      // рабочие данные линии, а производные журналы.
      return false;
  }
}