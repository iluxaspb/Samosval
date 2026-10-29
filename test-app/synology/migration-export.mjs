import { firebaseTestConfig } from './firebase-test-config.mjs';
import { validateMigrationSnapshot } from './migration-snapshot.mjs';

const EXPECTED_PROJECT='samosval-offline', WORKSPACE='main_workspace';
if(firebaseTestConfig.projectId!==EXPECTED_PROJECT)throw new Error('Неверный Firebase-проект');
const app=firebase.initializeApp(firebaseTestConfig), auth=app.auth(), db=app.firestore();
const $=id=>document.getElementById(id), exportButton=$('export');
const tell=text=>$('status').textContent=text;
const collection=async path=>{
  const snapshot=await db.collection(path).get({source:'server'});
  if(snapshot.metadata.fromCache)throw new Error('Получен кеш вместо данных сервера: '+path);
  return snapshot.docs.map(doc=>({id:doc.id,data:doc.data()})).sort((a,b)=>a.id.localeCompare(b.id));
};
const documentRecord=async(path,required=true)=>{
  const doc=await db.doc(path).get({source:'server'});
  if(doc.metadata.fromCache)throw new Error('Получен кеш вместо данных сервера: '+path);
  if(!doc.exists){if(required)throw new Error('Нет обязательного документа: '+path);return [];}
  return [{id:doc.id,data:doc.data()}];
};
async function requireAdmin(){
  const user=auth.currentUser;
  if(!user)throw new Error('Войдите в учётную запись администратора');
  const profile=await documentRecord('users/'+user.uid);
  if(profile[0].data.status!=='active'||profile[0].data.role!=='admin')throw new Error('Нужна активная учётная запись администратора');
  return user;
}
const workspacePath='workspaces/'+WORKSPACE+'/';
const lineSnapshot=async()=>({
  shift:await documentRecord(workspacePath+'shift/current'),
  logs:await collection(workspacePath+'logs'),
  truckStatus:await collection(workspacePath+'truckStatus')
});
auth.onAuthStateChanged(async user=>{
  $('login').hidden=!!user;exportButton.disabled=true;
  $('account').textContent=user?'Выполнен вход: '+(user.email||user.uid):'Войдите в тестовое приложение';
  if(!user){tell('Ожидание входа администратора.');return;}
  try{await requireAdmin();exportButton.disabled=false;tell('Администратор подтверждён. Можно создать проверенную копию.');}
  catch(error){tell(error.message);}
});
$('login').addEventListener('submit',async event=>{
  event.preventDefault();
  try{await auth.signInWithEmailAndPassword($('email').value,$('password').value);$('password').value='';}
  catch(error){tell('Ошибка входа: '+error.message);}
});
exportButton.addEventListener('click',async()=>{
  exportButton.disabled=true;
  try{
    const user=await requireAdmin();tell('Чтение текущей смены и данных с сервера…');
    const before=await lineSnapshot();
    const data={...before};
    const names=['trucks','objects','archive','trash','notifications','audit','plugins','patches','coinTransactions','tabelNextRecords','tabelNextMeta'];
    for(const name of names){tell('Чтение раздела: '+name);data[name]=await collection(workspacePath+name);}
    data.users=await collection('users');
    data.registrationRequests=await collection('registration_requests');
    data.permissions=await documentRecord('settings/permissions');
    data.appConfig=await documentRecord('settings/appConfig',false);
    data.appConfig_test=await documentRecord('settings/appConfig_test',false);
    const after=await lineSnapshot();
    if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Во время экспорта изменились рейсы или смена. Повторите экспорт, когда операторы закончат действие.');
    if(auth.currentUser?.uid!==user.uid)throw new Error('Учётная запись изменилась во время экспорта');
    await requireAdmin();
    const payload={format:'samosval-test-migration',version:1,firebaseProjectId:EXPECTED_PROJECT,workspaceId:WORKSPACE,exportedAt:Date.now(),exportedBy:user.uid,excluded:['Firebase Storage files','tabelNextPresence','backups'],data};
    const counts=validateMigrationSnapshot(payload);
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
    const link=document.createElement('a'),url=URL.createObjectURL(blob);
    link.href=url;link.download='Samosval_TEST_migration_'+new Date(payload.exportedAt).toISOString().slice(0,10)+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    tell('Копия проверена и скачана.\n'+Object.entries(counts).map(([key,value])=>key+': '+value).join('\n')+'\nFirebase Storage требует отдельного переноса. Приложение пока не переключено.');
  }catch(error){tell('Экспорт остановлен: '+error.message);}
  finally{exportButton.disabled=false;}
});
