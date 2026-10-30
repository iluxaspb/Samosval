// TEST ONLY. Transactional outbox reader and compare-and-set Firestore cursor.
// The PostgreSQL row trigger runs within the SAME transaction as every business
// mutation; a locked singleton counter imposes actual COMMIT order.
// This adapter never uploads to Firebase or grants shared write authority.
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const sequence=x=>Number.isSafeInteger(x)&&x>=0;
const head=x=>x&&sequence(x.sequence)&&hash(x.hash);
const asSequence=x=>{
  const n=Number(x);
  if(!sequence(n)||String(n)!==String(x))throw Error('outbox-sequence-not-safe');
  return n;
};
function requireTest(db) {
  if(db!=='samosval_test')throw Error('test-database-required');
}
export function createPostgresOutbox({pool,verifyCheckpoint}={}){
  if(typeof pool?.connect!=='function'||typeof pool?.query!=='function'||
     typeof verifyCheckpoint!=='function')throw TypeError('invalid-postgres-outbox');
  async function checkTest(client) {
    requireTest((await client.query('SELECT current_database() AS name')).rows[0]?.name);
  }
  return Object.freeze({
    async readReceipt(){
      const c=await pool.connect();
      try{
        await checkTest(c);
        const r=(await c.query('SELECT sequence::text AS sequence,hash FROM reserve_replica_receipt WHERE singleton=true')).rows[0];
        return r?{sequence:asSequence(r.sequence),hash:r.hash}:null;
      }finally{c.release();}
    },
    async readPending(after,limit){
      if(!sequence(after)||!Number.isSafeInteger(limit)||limit<1||limit>501)
        throw TypeError('invalid-outbox-range');
      const c=await pool.connect();
      try{
        await checkTest(c);
        const result=await c.query(`SELECT sequence::text AS sequence,table_name,action,
               row_key::text AS row_key_json,row_data::text AS row_data_json
             FROM reserve_replica_outbox WHERE sequence>$1 ORDER BY sequence LIMIT $2`,[after,limit]);
        return result.rows.map((row,i)=>{
          const n=asSequence(row.sequence);
          // A retained outbox must start at exactly the acknowledged cursor.
          // Missing/removed rows are a hard failure; never silently skip them.
          if(n!==after+i+1)throw Error('outbox-sequence-gap');
          if(typeof row.row_key_json!=='string'||
             row.action==='upsert'&&typeof row.row_data_json!=='string'||
             row.action==='delete'&&row.row_data_json!==null)
            throw Error('invalid-outbox-row');
          if(!/^[a-z][a-z0-9_]*$/.test(row.table_name))throw Error('invalid-outbox-table');
          return {
            sequence:n,operationId:'nas-change-'+n,
            rowId:row.table_name+':'+n,
            table:row.table_name,
            action:row.action,
            // JSON text is intentional: parsing into JS Number can round
            // PostgreSQL bigint/numeric values and silently corrupt backups.
            row:row.action==='delete'?null:{postgresJson:row.row_data_json},
            keyJson:row.row_key_json,
            projectId:'samosval-offline',workspaceId:'main_workspace'
          };
        });
      }finally{c.release();}
    },
    async initializeReceipt(checkpoint){
      if(!head(checkpoint)||!await verifyCheckpoint(checkpoint))
        throw Error('outbox-bootstrap-not-verified');
      const c=await pool.connect();
      try{
        await c.query('BEGIN');
        await checkTest(c);
        // A snapshot must be captured at exactly this committed high-water.
        const position=asSequence((await c.query(
          'SELECT last_sequence::text AS last_sequence FROM reserve_outbox_cursor WHERE singleton=true'
        )).rows[0]?.last_sequence);
        if(position!==checkpoint.sequence)throw Error('outbox-bootstrap-head-changed');
        await c.query(`INSERT INTO reserve_replica_receipt(singleton,sequence,hash)
                        VALUES(true,$1,$2) ON CONFLICT(singleton) DO NOTHING`,
          [checkpoint.sequence,checkpoint.hash]);
        const r=(await c.query(
          'SELECT sequence::text AS sequence,hash FROM reserve_replica_receipt WHERE singleton=true FOR UPDATE'
        )).rows[0];
        if(asSequence(r.sequence)!==checkpoint.sequence||r.hash!==checkpoint.hash)
          throw Error('outbox-bootstrap-conflict');
        await c.query('COMMIT');
        return checkpoint;
      }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
    },
    async persistReceipt({receipt,previous,batchId}){
      if(!head(previous)||!head(receipt)||receipt.hash!==batchId||
         receipt.sequence<=previous.sequence)throw Error('invalid-outbox-receipt');
      const c=await pool.connect();
      try{
        await checkTest(c);
        const result=await c.query(`UPDATE reserve_replica_receipt
          SET sequence=$1,hash=$2,updated_at=now()
          WHERE singleton=true AND sequence=$3 AND hash=$4
          RETURNING sequence::text AS sequence,hash`,
          [receipt.sequence,receipt.hash,previous.sequence,previous.hash]);
        if(result.rowCount===1)return receipt;
        // Replayed immutable packet can recover from lost SQL commit reply.
        const row=(await c.query('SELECT sequence::text AS sequence,hash FROM reserve_replica_receipt WHERE singleton=true')).rows[0];
        if(row&&asSequence(row.sequence)===receipt.sequence&&row.hash===receipt.hash)return receipt;
        throw Error('outbox-receipt-cas-conflict');
      }finally{c.release();}
    }
  });
}
