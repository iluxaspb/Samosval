// Estimates for a Firebase Spark project shared with the existing application.
// These are NOT live quota measurements. Firestore does not expose remaining
// project-wide reads/writes to an unbilled client or the NAS Admin SDK.
export const SPARK_STANDARD_FREE_LIMITS=Object.freeze({
  storageBytes:1024*1024*1024,
  readsPerDay:50000,
  writesPerDay:20000,
  deletesPerDay:20000
});
export const SPARK_MAX_BOOTSTRAP_ROWS=6000;
export const SPARK_MAX_BOOTSTRAP_ROW_BYTES=900000;

export function estimateSparkSnapshot(rowCount){
  if(!Number.isSafeInteger(rowCount)||rowCount<0)throw new TypeError('spark-invalid-row-count');
  // Each row is written once, then independently fetched to verify the full
  // initial generation; metadata and ownership may require additional reads.
  return {documentWrites:rowCount+1,documentReadsAtLeast:rowCount+2};
}
export function assertSparkBootstrapBudget(rowCount,{maxRows=SPARK_MAX_BOOTSTRAP_ROWS}={}){
  if(!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>SPARK_MAX_BOOTSTRAP_ROWS)
    throw new TypeError('spark-invalid-bootstrap-limit');
  const estimate=estimateSparkSnapshot(rowCount);
  if(rowCount>maxRows)throw Object.assign(new Error('replica-spark-bootstrap-budget-exceeded'),{
    code:'replica-spark-bootstrap-budget-exceeded'
  });
  return estimate;
}
export function estimateSparkForwardBatch({events,materializedUpserts,deletes=0}){
  for(const n of [events,materializedUpserts,deletes]){
    if(!Number.isSafeInteger(n)||n<0)throw new TypeError('spark-invalid-batch-count');
  }
  if(materializedUpserts+deletes>events)throw new TypeError('spark-invalid-batch-count');
  return {documentWrites:1+events+materializedUpserts,
    documentDeletes:deletes,documentReadsAtLeast:2};
}
