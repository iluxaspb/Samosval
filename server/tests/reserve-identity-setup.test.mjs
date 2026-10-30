import test from 'node:test';
import assert from 'node:assert/strict';
import {setupReserveIdentity,identityPlan,PROJECT,ACCOUNT,EMAIL,ROLE} from '../scripts/reserve-identity-setup.mjs';
const env={RESERVE_SETUP_CONFIRMATION:`${PROJECT}/${ACCOUNT}`,RESERVE_OPERATOR_ACCOUNT:'operator@example.test'};
function fixture({existing=false,role=false,extra=false,disabled=false,operator='operator@example.test',lostReply=false}={}){
  let present=existing,bound=role,lose=lostReply;const calls=[];
  const account=()=>({email:EMAIL,projectId:PROJECT,disabled});
  const run=async args=>{
    calls.push(args);const command=args.slice(0,3).join(' ');
    if(args[0]==='auth')return [{account:operator}];
    if(args[0]==='projects'&&args[1]==='describe')return {projectId:PROJECT,lifecycleState:'ACTIVE'};
    if(args[1]==='get-iam-policy')return {bindings:[...(bound?[{role:ROLE,members:[`serviceAccount:${EMAIL}`]}]:[]),...(extra?[{role:'roles/editor',members:[`serviceAccount:${EMAIL}`]}]:[])]};
    if(command==='iam service-accounts list')return present?[account()]:[];
    if(command==='iam service-accounts create'){present=true;return account();}
    if(command==='iam service-accounts describe')return account();
    if(args[1]==='add-iam-policy-binding'){bound=true;if(lose){lose=false;throw Error('lost-reply');}return {};}
    throw Error('unexpected-command');
  };
  return {run,calls};
}
const writes=h=>h.calls.filter(c=>c[1]==='add-iam-policy-binding'||c[2]==='create');
test('default plan never claims configured credentials or enabled failover',()=>{
  assert.equal(identityPlan().createsPrivateKey,false);assert.equal(identityPlan().enablesFailover,false);
});
test('explicit scope and expected active operator are required before mutation',async()=>{
  const h=fixture();
  for(const patch of [{RESERVE_SETUP_CONFIRMATION:''},{RESERVE_OPERATOR_ACCOUNT:''},{FIREBASE_PROJECT_ID:'production'}])
    await assert.rejects(setupReserveIdentity({env:{...env,...patch},run:h.run}));
  assert.equal(h.calls.length,0);
  const other=fixture({operator:'wrong@example.test'});
  await assert.rejects(setupReserveIdentity({env,run:other.run}),/operator-not-active/);assert.equal(writes(other).length,0);
});
test('new account receives exactly the TEST data role and is read back',async()=>{
  const h=fixture(),result=await setupReserveIdentity({env,run:h.run});
  assert.equal(writes(h).length,2);assert.equal(result.status,'service-account-and-project-role-verified');
  assert.equal(result.serverCredentialConfigured,false);assert.equal(result.checkpointVerified,false);
  assert.ok(writes(h).at(-1).includes(`--role=${ROLE}`));
  assert.equal(h.calls.some(c=>c.includes('keys')),false);
});
test('rerun reuses existing account and binding without extra mutations',async()=>{
  const h=fixture({existing:true,role:true});await setupReserveIdentity({env,run:h.run});assert.equal(writes(h).length,0);
});
test('disabled account or excessive preexisting project role fails closed',async()=>{
  for(const options of [{existing:true,disabled:true},{extra:true}]){
    const h=fixture(options);await assert.rejects(setupReserveIdentity({env,run:h.run}));assert.equal(writes(h).length,0);
  }
});
test('retry after a lost IAM reply verifies the applied change without creating it again',async()=>{
  const h=fixture({lostReply:true});await assert.rejects(setupReserveIdentity({env,run:h.run}),/lost-reply/);
  const count=writes(h).length;await setupReserveIdentity({env,run:h.run});assert.equal(writes(h).length,count);
});
