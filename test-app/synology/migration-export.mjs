import { createLineTransport } from './line-transport.mjs?v=20261030.6';
import { firebaseTestConfig } from './firebase-test-config.mjs';
import { validateMigrationSnapshot, stableSnapshot } from './migration-snapshot.mjs?v=20261030.5';

const EXPECTED_PROJECT='samosval-offline', WORKSPACE='main_workspace';
if(firebaseTestConfig.projectId!==EXPECTED_PROJECT)throw new Error('Неверный Firebase-проект');
const app=firebase.initializeApp(firebaseTestConfig), auth=app.auth(), db=app.firestore();
const $=id=>document.getElementById(id), exportButton=$('export');
const tell=text=>$('status').textContent=text;
const collection=async path=>{
  const snapshot=await db.collection(path).get({source:'server'}).catch(error=>{throw new Error(path+': '+(error.code||error.message));});
  if(snapshot.metadata.fromCache)throw new Error('Получен кеш вместо данных сервера: '+path);
  return snapshot.docs.map(doc=>({id:doc.id,data:doc.data()})).sort((a,b)=>a.id.localeCompare(b.id));
};
const documentRecord=async(path,required=true)=>{
  const doc=await db.doc(path).get({source:'server'}).catch(error=>{throw new Error(path+': '+(error.code||error.message));});
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
    const after=await lineSnapshot();
    if(stableSnapshot(before)!==stableSnapshot(after))throw new Error('Во время экспорта изменились рейсы или смена. Повторите экспорт, когда операторы закончат действие.');
    if(auth.currentUser?.uid!==user.uid)throw new Error('Учётная запись изменилась во время экспорта');
    await requireAdmin();
    const payload={format:'samosval-test-migration',version:1,firebaseProjectId:EXPECTED_PROJECT,workspaceId:WORKSPACE,exportedAt:Date.now(),exportedBy:user.uid,excluded:['Firebase Storage files','tabelNextPresence','backups','legacy settings/appConfig_test (not used by active build)'],data};
    const counts=validateMigrationSnapshot(payload);
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
    const link=document.createElement('a'),url=URL.createObjectURL(blob);
    link.href=url;link.download='Samosval_TEST_migration_'+new Date(payload.exportedAt).toISOString().slice(0,10)+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    tell('Копия проверена и скачана.\n'+Object.entries(counts).map(([key,value])=>key+': '+value).join('\n')+'\nFirebase Storage требует отдельного переноса. Приложение пока не переключено.');
  }catch(error){tell('Экспорт остановлен: '+error.message);}
  finally{exportButton.disabled=false;}
});

$('check-api').addEventListener('click',async()=>{
  $('check-api').disabled=true;
  try{
    const user=await requireAdmin();
    const response=await fetch('https://iluxa.synology.me:18443/api/v1/line/snapshot',{headers:{Authorization:'Bearer '+await user.getIdToken()},cache:'no-store',redirect:'error',credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('Synology HTTP '+response.status);
    const snapshot=await response.json();
    if(snapshot.format!=='samosval-line-snapshot'||snapshot.source!=='synology')throw new Error('Неверный ответ API');
    tell('Synology: ответ подтверждён по HTTPS.\nСмена: '+(snapshot.shift?.id||'закрыта')+'\nМашин в справочнике: '+snapshot.trucks.length+'\nСтатусов: '+snapshot.statuses.length+'\nЗаписей рейсов: '+snapshot.logs.length+'\nИнтервал: '+snapshot.cycleMinutes+' мин.\nОсновная страница приложения пока не переключена.');
  }catch(error){tell('Проверка Synology: '+error.message);}
  finally{$('check-api').disabled=false;}
});

$('probe').addEventListener('click',async()=>{
  $('probe').disabled=true;
  const truckId='synology_probe_20261030';
  try{
    const user=await requireAdmin(),baseUrl='https://iluxa.synology.me:18443';
    const token=force=>user.getIdToken(force);
    const read=async()=>{const response=await fetch(baseUrl+'/api/v1/line/snapshot',{headers:{Authorization:'Bearer '+await token(false)},cache:'no-store',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('Чтение: HTTP '+response.status);return response.json();};
    const before=await read(),status=before.statuses.find(s=>s.id===truckId);
    if(!before.shift?.isActive||!status||Number(status.cycleRevision||0)!==0||status.lastLoadTimestamp)throw new Error('Нужна отдельная подготовленная тестовая машина NAS. Реальные машины не изменены.');
    const make=(type,st)=>({id:'nas_probe_20261030_'+crypto.randomUUID().replaceAll('-',''),type,truckId,shiftId:before.shift.id,createdAt:Date.now(),expectedRevision:Number(st.cycleRevision||0),expectedTtnRevision:Number(st.ttnRevision||0),arrivalTimestamp:Number(st.arriveTimestamp||0),lastLoadTimestamp:Number(st.lastLoadTimestamp||0),wantArrived:type==='arrive',collect:false,cycleMinutes:before.cycleMinutes});
    const transport=createLineTransport({baseUrl,getIdToken:token});
    const arrival=await transport.submit(make('arrive',status));
    if(arrival.outcome!=='confirmed')throw new Error('Приезд отклонён: '+arrival.reason);
    tell('Приезд сохранён. Отправка двух одновременных погрузок…');
    const operations=[make('load',arrival.status),make('load',arrival.status)];
    const results=await Promise.all(operations.map(op=>transport.submit(op)));
    if(results.filter(r=>r.outcome==='confirmed').length!==1||results.filter(r=>r.outcome==='rejected').length!==1)throw new Error('Нарушена защита от двух погрузок');
    const winner=operations[results.findIndex(r=>r.outcome==='confirmed')];
    const replay=await transport.submit(winner);
    if(replay.outcome!=='confirmed'||replay.replayed!==true)throw new Error('Повтор не вернул прежнюю квитанцию');
    const lostResponse=createLineTransport({baseUrl,getIdToken:token,fetchImpl:async(...args)=>{await fetch(...args);throw new TypeError('simulated-response-loss');}});
    let retained=false;try{await lostResponse.submit(winner);}catch(error){retained=error.uncertain===true;}
    if(!retained)throw new Error('Потеря ответа ошибочно отмечена как сохранение');
    const recovered=await transport.submit(winner);
    if(recovered.replayed!==true)throw new Error('Повтор после потери ответа не распознан');
    let conflict=false;try{await transport.submit({...winner,createdAt:winner.createdAt+1});}catch(error){conflict=error.status===409;}
    if(!conflict)throw new Error('Разное содержимое с тем же ID не отклонено');
    const after=await read(),logs=after.logs.filter(log=>log.truckId===truckId),current=after.statuses.find(s=>s.id===truckId);
    if(logs.length!==1||current?.loadedAfterArrive!==true||Number(current.cycleRevision)!==2)throw new Error('Итоговый статус или число рейсов не совпали');
    tell('ПРОВЕРКА ЗАПИСИ НА NAS ПРОШЛА\nПриезд сохранён.\nДве одновременные погрузки: засчитана одна.\nПовтор вернул прежнюю квитанцию.\nПосле имитации потери ответа повтор не создал дубль.\nИзменённая операция с тем же ID отклонена (409).\nВ базе один тестовый рейс, статус согласован.\nИспользована только отдельная тестовая машина NAS.');
  }catch(error){tell('Проверка остановлена: '+error.message);}
  finally{$('probe').disabled=false;}
});
