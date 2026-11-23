import test from 'node:test';

if (process.env.ISOLATED_DB_SIGNAL_FIXTURE === '1') {
  process.removeAllListeners('SIGTERM');
  process.kill(process.pid, 'SIGTERM');
}

test('signal fixture is inert without its explicit marker', () => {});
