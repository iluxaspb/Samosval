import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {adminUrl, applyMigrationsThrough, requireIsolatedDatabase, seedParallelShiftFixture} from './helpers/isolated-db.mjs';

// 030: нормализованные ревизии статуса машины всегда совпадают с payload.
//
// Дефект, который ловит этот тест: v1-путь операций линии обновлял только
// payload, а v2-снимок читает колонки cycle_revision/ttn_revision. Клиент
// получал из снимка устаревшую ревизию, отправлял её в CAS и получал 409
// «Погрузка уже учтена или прибытие изменилось» на ровном месте.
//
// Проверяем именно свойство таблицы, а не соглашение между хранилищами:
// любой писатель (v1 line-store, история/undo, control, replica) получает
// синхронные колонки. Манифест даёт базовую схему 024; 025 ставит тест, затем
// создаёт расхождение «колонка 1 против payload 5» (ровно как v1-запись), и
// только после этого ставится 030 — так проверяется и триггер, и backfill.

const WORKSPACE = 'main_workspace';

const connectionString = process.env.TEST_DATABASE_URL;
let approved = false;
if (connectionString && process.env.SAMOSVAL_ISOLATED_TEST === '1') {
  try { requireIsolatedDatabase(connectionString); approved = true; } catch {}
}

test('payload revisions mirror into normalized status columns', {skip: approved ? false : 'needs the isolated cluster'}, async () => {
  const suffix = 'mirror_' + randomUUID().replaceAll('-', '').slice(0, 12);
  // Фикстура пишет смены в форме 024: схема 025 ставит guard на payload,
  // поэтому порядок как в legacy-тестах — сначала данные, потом 025.
  const ids = await seedParallelShiftFixture({suffix, workspaceId: WORKSPACE});
  await applyMigrationsThrough(25);
  const pool = new pg.Pool({connectionString: adminUrl().href, max: 2});
  pool.on('error', () => {});
  try {
    // 0. До 030 колонки и payload расходятся: ровно так выглядела живая база,
    //    где v1-запись обновила только payload. Колонка осталась прежней.
    const drifted = await pool.query(
      `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,cycle_revision,ttn_revision,payload)
       VALUES($1,$2,$3,1,1,$4::jsonb)
       RETURNING cycle_revision,ttn_revision`,
      [WORKSPACE, ids.truckId, ids.shiftAId, {
        id: ids.truckId,
        truckId: ids.truckId,
        shiftId: ids.shiftAId,
        onLine: true,
        arriveStatus: null,
        cycleRevision: 5,
        ttnRevision: 2,
      }],
    );
    assert.equal(Number(drifted.rows[0].cycle_revision), 1, 'до 030 колонка не следует за payload');

    await applyMigrationsThrough(30);

    // 1. Разовый backfill чинит уже рассинхронизированную строку по payload:
    //    именно payload сравнивают доменные правила.
    const backfilled = await pool.query(
      `SELECT cycle_revision,ttn_revision FROM line_truck_statuses
        WHERE workspace_id=$1 AND truck_id=$2`,
      [WORKSPACE, ids.truckId],
    );
    assert.equal(Number(backfilled.rows[0].cycle_revision), 5);
    assert.equal(Number(backfilled.rows[0].ttn_revision), 2);

    // 2. INSERT без колонок: BEFORE INSERT выводит их из payload.
    await pool.query(
      `DELETE FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2`,
      [WORKSPACE, ids.truckId],
    );
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

    // 3. Обновление только payload — ровно то, что делает v1 line-store.
    const updated = await pool.query(
      `UPDATE line_truck_statuses
          SET payload = jsonb_set(payload,'{cycleRevision}','8')
        WHERE workspace_id=$1 AND truck_id=$2
        RETURNING cycle_revision`,
      [WORKSPACE, ids.truckId],
    );
    assert.equal(Number(updated.rows[0].cycle_revision), 8);

    // 4. Нечисловая ревизия не переписывает колонку и не роняет запись:
    //    легаси-импорт и восстановление резервной копии должны проходить.
    const nonNumeric = await pool.query(
      `UPDATE line_truck_statuses
          SET payload = jsonb_set(payload,'{cycleRevision}','"восемь"')
        WHERE workspace_id=$1 AND truck_id=$2
        RETURNING cycle_revision`,
      [WORKSPACE, ids.truckId],
    );
    assert.equal(Number(nonNumeric.rows[0].cycle_revision), 8);

    // 5. Payload без ревизии (старая строка) колонку не обнуляет.
    const withoutRevision = await pool.query(
      `UPDATE line_truck_statuses
          SET payload = payload - 'cycleRevision'
        WHERE workspace_id=$1 AND truck_id=$2
        RETURNING cycle_revision`,
      [WORKSPACE, ids.truckId],
    );
    assert.equal(Number(withoutRevision.rows[0].cycle_revision), 8);

    // 6. Если писатель прислал колонку и payload по-разному, побеждает
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
