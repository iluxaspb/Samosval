// A full, consistent snapshot for the TEST line. Never use client-supplied roles.
export async function readLineSnapshot(pool, uid, workspaceId = process.env.WORKSPACE_ID || 'main_workspace') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const profile = (await client.query(
      'SELECT display_name, role, status FROM app_users WHERE uid=$1', [uid]
    )).rows[0];
    if (!profile || profile.status !== 'active') {
      throw Object.assign(new Error('forbidden'), { status: 403 });
    }
    if (profile.role !== 'admin') {
      const permission = (await client.query(
        "SELECT allowed FROM role_permissions WHERE role=$1 AND action='tab_line'", [profile.role]
      )).rows[0];
      if (permission?.allowed !== true) throw Object.assign(new Error('forbidden'), { status: 403 });
    }
    const shifts = (await client.query(
      'SELECT shift_id, payload FROM shifts WHERE workspace_id=$1 AND is_active=true ORDER BY shift_id LIMIT 2',
      [workspaceId]
    )).rows;
    // Never guess which shift owns the line if the imported data is inconsistent.
    if (shifts.length > 1) throw Object.assign(new Error('multiple-active-shifts'), { status: 409 });
    const shift = shifts[0];
    const trucks = (await client.query(
      'SELECT truck_id, payload FROM line_trucks WHERE workspace_id=$1 ORDER BY truck_id', [workspaceId]
    )).rows.map(row => ({ ...row.payload, id: row.truck_id }));
    let statuses = [], logs = [];
    if (shift) {
      statuses = (await client.query(
        'SELECT truck_id, payload FROM line_truck_statuses WHERE workspace_id=$1 AND shift_id=$2 ORDER BY truck_id',
        [workspaceId, shift.shift_id]
      )).rows.map(row => ({ ...row.payload, id: row.truck_id, shiftId: shift.shift_id }));
      logs = (await client.query(
        'SELECT log_id, truck_id, payload FROM line_logs WHERE workspace_id=$1 AND shift_id=$2 ORDER BY log_id',
        [workspaceId, shift.shift_id]
      )).rows.map(row => ({ ...row.payload, id: row.log_id, truckId: row.truck_id, shiftId: shift.shift_id }));
    }
    const workspace = (await client.query('SELECT cycle_minutes FROM workspaces WHERE id=$1', [workspaceId])).rows[0];
    if (!workspace) throw Object.assign(new Error('workspace-not-ready'), { status: 409 });
    await client.query('COMMIT');
    return {
      format: 'samosval-line-snapshot', version: 1, workspaceId,
      source: 'synology',
      shift: shift ? { ...shift.payload, id: shift.shift_id, isActive: true } : null,
      trucks, statuses, logs, cycleMinutes: workspace.cycle_minutes
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
