import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {applyMigrationsThrough, seedParallelShiftFixture} from './helpers/isolated-db.mjs';

// 030: нормализованные ревизии статуса машины всегда совпадают с payload.
//
// Дефект, который ловит этот тест: v1-путь операций линии обновлял только
// payload, а v2-снимок читает колонки cycle_revision/ttn_revision. Клиент
// получал из снимка устаревшую ревизию, отправлял её в CAS и получал 409
// «Погрузка уже учтена или прибытие изменилось» на ровном месте.
//
// Проверяем именно свойство таблицы, а не соглашение между хранилищами:
// любой писатель (v1 line-store, история/undo, control, replica) получает
// синхронные колонки.

const WORKSPACE = 'main_workspace';

test('payload revisions mirror into normalized status columns', {skip: !process.env.TEST_DATABASE_URL}, async () => {
  const suffix = 'mirror_' + randomUUID().replaceAll('-', '').slice(0, 12);
  await applyMigrationsThrough(24);
  const ids = await seedParallelShiftFixture({suffix, workspaceId: WORKSPACE});
  await applyMigrationsThrough(30);

  const pool = new pg.Pool({connectionString: process.env.TEST_DATABASE_URL, max: 2});
  pool.on('error', () => {});
  try {
    // 1. INSERT без колонок: BEFORE INSERT выводит их из payload.
    const inserted = await pool.query(
      `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload)
       VALUES($1,$2,$3,$4::jsonb)
       RETURNING status_revision,cycle_revision,ttn_revision`,
      [WORKSPACE, ids.truckId, ids.shiftAId, {
        id: ids.truckId,
        truckId: ids.truckId,
        shiftId: ids.shiftAId,
        onLine: true,
        arriveStatus: null,
        cycleRevision: 7,
        ttnRevision: 3,
      }],
    );
    assert.equal(Number(inserted.rows[0].cycle_revision), 7);
    assert.equal(Number(inserted.rows[0].ttn_revision), 3);
    assert.equal(Number(inserted.rows[0].status_revision), 1, 'status_revision stays the writer-owned counter');

    // 2. Обновление только payload — ровно то, что делает v1 line-store.
    const updated = await pool.query(
      `UPDATE line_truck_statuses
          SET payload = jsonb_set(payload,'{cycleRevision}','8')
        WHERE workspace_id=$1 AND truck_id=$2
        RETURNING cycle_revision`,
      [WORKSPACE, ids.truckId],
    );
    assert.equal(Number(updated.rows[0].cycle_revision), 8);

    // 3. Нечисловая ревизия не переписывает колонку и не роняет запись:
    //    легаси-импорт и восстановление резервной копии должны проходить.
    const nonNumeric = await pool.query(
      `UPDATE line_truck_statuses
          SET payload = jsonb_set(payload,'{cycleRevision}','"восемь"')
        WHERE workspace_id=$1 AND truck_id=$2
        RETURNING cycle_revision`,
      [WORKSPACE, ids.truckId],
    );
    assert.equal(Number(nonNumeric.rows[0].cycle_revision), 8);

    // 4. Payload без ревизии (старая строка) колонку не обнуляет.
    const withoutRevision = await pool.query(
      `UPDATE line_truck_statuses
          SET payload = payload - 'cycleRevision'
        WHERE workspace_id=$1 AND truck_id=$2
        RETURNING cycle_revision`,
      [WORKSPACE, ids.truckId],
    );
    assert.equal(Number(withoutRevision.rows[0].cycle_revision), 8);

    // 5. Если писатель прислал колонку и payload по-разному, побеждает
    //    payload: именно его сравнивают доменные правила.
    const bothWays = await pool.query(
      `UPDATE line_truck_statuses
          SET payload = jsonb_set(payload,'{cycleRevision}','11'),
              cycle_revision = 9
        WHERE workspace_id=$1 AND truck_id=$2
        RETURNING cycle_revision`,
      [WORKSPACE, ids.truckId],
    );
    assert.equal(Number(bothWays.rows[0].cycle_revision), 11);
  } finally {
    await pool.end();
  }
});
