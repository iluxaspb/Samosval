import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readLineSnapshot } from '../src/line-read.mjs';

test('line snapshot access, workspace isolation and concurrent consistency in PostgreSQL',
  { skip: !process.env.TEST_DATABASE_URL }, async t => {
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 });
    const prefix = 'read_' + randomUUID().replaceAll('-', '');
    const ws = prefix, other = prefix + '_other', uid = prefix + '_admin', role = prefix + '_operator';
    const reader = prefix + '_reader', disabled = prefix + '_disabled';
    const truck = 'truck', current = 'current', old = 'old';
    const q = (text, args) => pool.query(text, args);
    try {
      await q('INSERT INTO workspaces(id,cycle_minutes) VALUES ($1,60),($2,15)', [ws, other]);
      for (const [id, userRole, status] of [[uid, 'admin', 'active'], [reader, role, 'active'], [disabled, 'admin', 'disabled']]) {
        await q('INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,$2,$3,$4,$5)',
          [id, 'fixture@example.test', 'Fixture', userRole, status]);
      }
      await q('INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,true,$3),($1,$4,false,$5),($6,$2,true,$3)',
        [ws, current, { id: 'wrong-payload-id', objectName: 'TEST' }, old, { id: old }, other]);
      await q('INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES ($1,$2,$3),($4,$2,$5)',
        [ws, truck, { id: 'wrong-payload-id', number: 'TEST' }, other, { number: 'OTHER' }]);
      await q('INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES ($1,$2,$3,$4)',
        [ws, truck, current, { onLine: true, cycleRevision: 1 }]);
      await q('INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES ($1,$2,$3,$4,$5),($6,$2,$7,$4,$5)',
        [ws, 'old-log', old, truck, { timestamp: 1 }, other, current]);

      await t.test('unknown accounts and disabled administrators receive no data', async () => {
        for (const id of ['missing_' + prefix, disabled]) {
          await assert.rejects(readLineSnapshot(pool, id, ws), { status: 403 });
        }
      });
      await t.test('line tab permission is default deny and revocation takes effect', async () => {
        await assert.rejects(readLineSnapshot(pool, reader, ws), { status: 403 });
        await q('INSERT INTO role_permissions(role,action,allowed) VALUES ($1,$2,true)', [role, 'tab_line']);
        assert.equal((await readLineSnapshot(pool, reader, ws)).shift.id, current);
        await q('UPDATE role_permissions SET allowed=false WHERE role=$1', [role]);
        await assert.rejects(readLineSnapshot(pool, reader, ws), { status: 403 });
      });
      await t.test('only current workspace and shift are returned with database IDs', async () => {
        const snapshot = await readLineSnapshot(pool, uid, ws);
        assert.equal(snapshot.cycleMinutes, 60);
        assert.equal(snapshot.source, 'synology');
        assert.equal(snapshot.shift.id, current);
        assert.equal(snapshot.trucks.length, 1);
        assert.equal(snapshot.trucks[0].id, truck);
        assert.equal(snapshot.trucks[0].number, 'TEST');
        assert.equal(snapshot.statuses.length, 1);
        assert.equal(snapshot.statuses[0].shiftId, current);
        assert.deepEqual(snapshot.logs, []);
        assert.equal(JSON.stringify(snapshot).includes('fixture@example.test'), false);
      });
      await t.test('a concurrent committed load cannot produce a mixed snapshot', async () => {
        let changed = false;
        const interleaved = { connect: async () => {
          const client = await pool.connect();
          return { release: () => client.release(), query: async (text, args) => {
            const result = await client.query(text, args);
            if (!changed && text.includes('SELECT shift_id, payload')) {
              changed = true;
              const writer = await pool.connect();
              try {
                await writer.query('BEGIN');
                await writer.query('UPDATE line_truck_statuses SET payload=$2 WHERE workspace_id=$1',
                  [ws, { onLine: true, cycleRevision: 2 }]);
                await writer.query('INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES ($1,$2,$3,$4,$5)',
                  [ws, 'new-log', current, truck, { timestamp: 2 }]);
                await writer.query('COMMIT');
              } catch (error) { await writer.query('ROLLBACK'); throw error; }
              finally { writer.release(); }
            }
            return result;
          } };
        } };
        const before = await readLineSnapshot(interleaved, uid, ws);
        assert.equal(changed, true);
        assert.equal(before.statuses[0].cycleRevision, 1);
        assert.deepEqual(before.logs, []);
        const after = await readLineSnapshot(pool, uid, ws);
        assert.equal(after.statuses[0].cycleRevision, 2);
        assert.deepEqual(after.logs.map(log => log.id), ['new-log']);
      });
      await t.test('two active shifts are reported as inconsistent, never guessed', async () => {
        await q('UPDATE shifts SET is_active=true WHERE workspace_id=$1 AND shift_id=$2', [ws, old]);
        await assert.rejects(readLineSnapshot(pool, uid, ws), { status: 409, message: 'multiple-active-shifts' });
        await q('UPDATE shifts SET is_active=false WHERE workspace_id=$1', [ws]);
      });
      await t.test('closed line returns no previous shift statuses or trips', async () => {
        const snapshot = await readLineSnapshot(pool, uid, ws);
        assert.equal(snapshot.shift, null);
        assert.deepEqual(snapshot.statuses, []);
        assert.deepEqual(snapshot.logs, []);
      });
      await t.test('unprepared workspace fails instead of presenting an empty successful line', async () => {
        await assert.rejects(readLineSnapshot(pool, uid, prefix + '_missing'),
          { status: 409, message: 'workspace-not-ready' });
      });
    } finally {
      // Only namespaced fixtures in the disposable test database.
      for (const table of ['line_logs', 'line_truck_statuses', 'line_trucks', 'shifts']) {
        await q(`DELETE FROM ${table} WHERE workspace_id IN ($1,$2)`, [ws, other]);
      }
      await q('DELETE FROM workspaces WHERE id IN ($1,$2)', [ws, other]);
      await q('DELETE FROM app_users WHERE uid IN ($1,$2,$3)', [uid, reader, disabled]);
      await q('DELETE FROM role_permissions WHERE role=$1', [role]);
      await pool.end();
    }
  });
