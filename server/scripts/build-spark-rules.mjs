// Construct an Emulator-only Firestore ruleset without mutating the
// deployed/default Firestore Rules. The fragment is never deployed by CI.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const base=readFileSync(resolve(root,'firestore-v3.rules'),'utf8');
const fragment=readFileSync(resolve(root,'docs/firestore-spark-line-readonly.fragment.rules'),'utf8');
const experimental=process.env.SPARK_EXPERIMENTAL_WRITES==='1';
const writeFragment=experimental?readFileSync(resolve(root,
 'docs/firestore-spark-line-write-experimental.fragment.rules'),'utf8'):'';
const promotion=process.env.SPARK_EXPERIMENTAL_PROMOTION==='1';
const promotionFragment=promotion?readFileSync(resolve(root,
 'docs/firestore-spark-client-promotion.experimental.fragment.rules'),'utf8'):'';
const destination=process.argv[2];
if(!destination)throw Error('spark-rules-output-required');
if(writeFragment&&!writeFragment.includes('match /samosval_test_replica/v1/{typedCollection}/{documentId}'))
 throw Error('spark-experimental-rules-invalid');
if(!base.includes('service cloud.firestore')||
 !fragment.includes('match /samosval_test_replica/{controlDoc}')||
 fragment.includes('allow write: if true'))throw Error('spark-rules-input-invalid');
const end=/\n  \}\s*\n\}\s*$/;
if(!end.test(base))throw Error('spark-rules-base-structure-unknown');
if(promotionFragment&&!promotionFragment.includes('match /samosval_test_replica/write_owner'))
 throw Error('spark-promotion-rules-invalid');
const parts=[fragment,...(experimental?[writeFragment]:[]),...(promotion?[promotionFragment]:[])];
const merged=base.replace(end,'\n'+parts.map(f=>f.split('\n').map(x=>'    '+x).join('\n')).join('\n')+'\n  }\n}\n');
writeFileSync(resolve(destination),merged);
console.log('EMULATOR_ONLY_SPARK_RULES_CREATED',resolve(destination));
