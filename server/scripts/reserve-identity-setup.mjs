// Run on a trusted host with an already-authorized Google Cloud CLI.
// Default is a side-effect-free plan. No keys, login, deployment or failover.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';

const execute=promisify(execFile);
export const PROJECT='samosval-offline';
export const ACCOUNT='samosval-test-reserve';
export const EMAIL=`${ACCOUNT}@${PROJECT}.iam.gserviceaccount.com`;
export const ROLE='roles/datastore.user';
const MEMBER=`serviceAccount:${EMAIL}`;
export function identityPlan(){
  return {projectId:PROJECT,serviceAccount:EMAIL,role:ROLE,
    scope:'All Firestore data in this TEST project; not Auth, Storage or production',
    createsPrivateKey:false,enablesFailover:false};
}
export async function runGcloud(args){
  try{
    const {stdout}=await execute('gcloud',[...args,`--project=${PROJECT}`,'--format=json','--quiet'],
      {timeout:60000,maxBuffer:4*1024*1024,env:{...process.env,CLOUDSDK_CORE_DISABLE_PROMPTS:'1'}});
    return stdout.trim()?JSON.parse(stdout):null;
  }catch{
    // Do not copy CLI stderr, credential values or HTTP traces into logs.
    throw Error('google-cloud-command-failed; inspect trusted CLI locally');
  }
}
function validatePolicy(policy){
  if(!policy||!Array.isArray(policy.bindings))throw Error('invalid-project-policy');
  const bindings=policy.bindings.filter(b=>b.members?.includes(MEMBER));
  if(bindings.some(b=>b.role!==ROLE||b.condition))throw Error('unexpected-existing-access; review-required');
  return bindings.some(b=>b.role===ROLE&&!b.condition);
}
function validateAccount(account){
  if(account?.email!==EMAIL||account.projectId!==PROJECT||account.disabled)
    throw Error('unexpected-or-disabled-service-account');
}
export async function setupReserveIdentity({env=process.env,run=runGcloud}={}){
  if(env.RESERVE_SETUP_CONFIRMATION!==`${PROJECT}/${ACCOUNT}`||!env.RESERVE_OPERATOR_ACCOUNT)
    throw Error('explicit-test-identity-setup-required');
  if(env.FIREBASE_PROJECT_ID&&env.FIREBASE_PROJECT_ID!==PROJECT)
    throw Error('test-project-required');
  const identities=await run(['auth','list','--filter=status:ACTIVE']);
  if(!Array.isArray(identities)||identities.length!==1||identities[0].account!==env.RESERVE_OPERATOR_ACCOUNT)
    throw Error('expected-google-operator-not-active');
  const project=await run(['projects','describe',PROJECT]);
  if(project?.projectId!==PROJECT||project.lifecycleState!=='ACTIVE')throw Error('test-project-not-active');
  // Check existing rights before creating anything. Never replace the project policy.
  let hasRole=validatePolicy(await run(['projects','get-iam-policy',PROJECT]));
  const accounts=await run(['iam','service-accounts','list']);
  if(!Array.isArray(accounts))throw Error('invalid-service-account-list');
  const existing=accounts.find(a=>a.email===EMAIL);
  if(existing)validateAccount(existing);
  else{
    await run(['iam','service-accounts','create',ACCOUNT,
      '--display-name=Samosval TEST reserve','--description=Synology TEST Firestore reserve only']);
    validateAccount(await run(['iam','service-accounts','describe',EMAIL]));
  }
  if(!hasRole)await run(['projects','add-iam-policy-binding',PROJECT,
    `--member=${MEMBER}`,`--role=${ROLE}`,'--condition=None']);
  hasRole=validatePolicy(await run(['projects','get-iam-policy',PROJECT]));
  if(!hasRole)throw Error('reserve-role-not-confirmed');
  return {...identityPlan(),status:'service-account-and-project-role-verified',
    serverCredentialConfigured:false,checkpointVerified:false};
}
async function main(){
  const args=process.argv.slice(2);
  if(args.length>1||args.length===1&&!['--plan','--apply'].includes(args[0]))throw Error('usage: --plan | --apply');
  const result=args[0]==='--apply'?await setupReserveIdentity():identityPlan();
  console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
