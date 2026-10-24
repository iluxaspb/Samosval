// Publish the review/report independently of the unreleased 3.2 ledger and roles.
const fs=require('fs');
let html=fs.readFileSync('index-test.html','utf8');
const profile={label:'Тест 3.1.3 · отчёт и авторы отметок',features:['conflict_author','admin_report'],note:'В этой публикации включены подробные уведомления о повторных действиях и отчёт с планом. Табель 3.2, новые роли и сброс старшим прорабом подготовлены в отдельной ветке test-v3-3 и ждут правил тестовой базы. Они здесь не включены.'};
const review='<!-- WORK REVIEW START -->\n<script>window.TEST_REVIEW_RELEASE='+JSON.stringify(profile)+';</script>\n'+['test-review-core','work-report'].map(name=>'<script id="'+name+'">\n'+fs.readFileSync('assets/'+name+'.js','utf8').replace(/<\/script/gi,'<\\/script')+'\n</script>').join('\n')+'\n<!-- WORK REVIEW END -->';
if(html.includes('<!-- WORK REVIEW START -->'))html=html.replace(/<!-- WORK REVIEW START -->[\s\S]*?<!-- WORK REVIEW END -->/,()=>review);else html=html.replace('<!-- TIMESHEET MODULE START -->',()=>review+'\n<!-- TIMESHEET MODULE START -->');
html=html.replaceAll('Версия 3.1.2 · тест','Версия 3.1.3 · тест').replace('<span class="ts-version">Тест 3.1.2</span>','<span class="ts-version">Тест 3.1.3</span>');
if(!html.includes("{version:'3.1.3 · тест'"))html=html.replace('const releases=[',`const releases=[\n    {version:'3.1.3 · тест',title:'Отчёт о работе и авторы отметок',items:['В админке появился полный отчёт: выполненное, незавершённое, ограничения и дальнейший план.','Для каждого согласованного пункта есть описание, проверка и шаблон сообщения о проблеме.','Повторный приезд, погрузка и ТТН показывают автора сохранённого действия, если имя есть в записи.','Новые роли и табель 3.2 сохранены отдельно и не включены до проверки правил базы.','Основная страница и механизм синхронизации не изменялись.']},`);
fs.writeFileSync('index-test.html',html);
console.log('Built test 3.1.3: report + author notifications; no role or ledger migration');
