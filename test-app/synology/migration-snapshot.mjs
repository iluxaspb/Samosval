export function stableSnapshot(value){
  function normalize(item){
    if(item&&typeof item.toJSON==='function')return normalize(item.toJSON());
    if(Array.isArray(item))return item.map(normalize);
    if(item&&typeof item==='object')return Object.fromEntries(Object.keys(item).sort().map(key=>[key,normalize(item[key])]));
    return item;
  }
  return JSON.stringify(normalize(value));
}

export function validateMigrationSnapshot(payload){
  if(payload?.format!=='samosval-test-migration'||payload.version!==1||payload.firebaseProjectId!=='samosval-offline'||payload.workspaceId!=='main_workspace')throw new Error('Неверный формат или источник тестовых данных');
  const data=payload.data;
  if(!data||!Array.isArray(data.shift)||data.shift.length!==1||data.shift[0].id!=='current'||typeof data.shift[0].data?.id!=='string'||!data.shift[0].data.id)throw new Error('Текущая смена отсутствует или повреждена');
  if(!Array.isArray(data.permissions)||data.permissions.length!==1||data.permissions[0].id!=='permissions')throw new Error('Права доступа не попали в копию');
  const counts={};
  for(const name of ['trucks','objects','archive','trash','logs','truckStatus','notifications','audit','plugins','patches','coinTransactions','tabelNextRecords','tabelNextMeta','users','registrationRequests','permissions','appConfig','shift']){
    if(!Array.isArray(data[name]))throw new Error('Не прочитан раздел: '+name);
    const ids=new Set();
    for(const record of data[name]){
      if(typeof record?.id!=='string'||!record.id||record.id.includes('/')||!record.data||typeof record.data!=='object'||Array.isArray(record.data)||ids.has(record.id))throw new Error('Повреждённая запись или повтор ID: '+name);
      ids.add(record.id);
    }
    counts[name]=data[name].length;
  }
  if(!data.users.some(record=>record.id===payload.exportedBy&&record.data.role==='admin'&&record.data.status==='active'))throw new Error('В копии нет активного администратора, выполнившего экспорт');
  const trucks=new Set(data.trucks.map(record=>record.id));
  for(const record of data.truckStatus)if(!trucks.has(record.id))throw new Error('Статус ссылается на отсутствующую машину');
  return counts;
}
