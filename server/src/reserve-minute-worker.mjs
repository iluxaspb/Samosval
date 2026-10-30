// TEST 4.1: concrete adapter composition. No background timer is started.
// A trusted supervisor may invoke poll() at 60-second intervals ONLY after
// schema, bootstrap, Firebase credentials, recovery and write fencing are ready.
import {createPostgresOutbox} from './reserve-postgres-outbox.mjs';
import {createMinuteFirestoreStore} from './reserve-minute-firestore.mjs';
import {createMinuteReplicaRunner} from './reserve-minute-replication.mjs';
import {createMinuteReservePoller} from './reserve-minute-poller.mjs';
export function createReserveMinuteWorker({pool,firestore,verifyCheckpoint,now=Date.now}={}){
  const outbox=createPostgresOutbox({pool,verifyCheckpoint});
  const storage=createMinuteFirestoreStore({firestore});
  const runner=createMinuteReplicaRunner({
    readPending:(after,limit)=>outbox.readPending(after,limit),
    putImmutable:batch=>storage.putImmutable(batch),
    readBack:id=>storage.readBack(id),
    persistReceipt:details=>outbox.persistReceipt(details),
    now
  });
  const poller=createMinuteReservePoller({
    runner,readReceipt:()=>outbox.readReceipt(),now
  });
  return Object.freeze({
    poll:options=>poller.poll(options),
    readReceipt:()=>outbox.readReceipt(),
    initializeReceipt:checkpoint=>outbox.initializeReceipt(checkpoint),
    get busy(){return poller.busy;}
  });
}
