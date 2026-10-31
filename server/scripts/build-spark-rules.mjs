// Construct an Emulator-only Firestore ruleset without mutating the
// deployed/default Firestore Rules. The fragment is never deployed by CI.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const base=readFileSync(resolve(root,'firestore-v3.rules'),'utf8');
const fragment=readFileSync(resolve(root,'docs/firestore-spark-line-readonly.fragment.rules'),'utf8');
const destination=process.argv[2];
if(!destination)throw Error('spark-rules-output-required');
if(!base.includes('service cloud.firestore')||
 !fragment.includes('match /samosval_test_replica/{controlDoc}')||
 fragment.includes('allow write: if true'))throw Error('spark-rules-input-invalid');
const end=/\n  \}\s*\n\}\s*$/;
if(!end.test(base))throw Error('spark-rules-base-structure-unknown');
const merged=base.replace(end,'\n'+fragment.split('\n').map(x=>'    '+x).join('\n')+'\n  }\n}\n');
writeFileSync(resolve(destination),merged);
console.log('EMULATOR_ONLY_SPARK_RULES_CREATED',resolve(destination));
