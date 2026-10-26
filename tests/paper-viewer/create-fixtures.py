from pathlib import Path
import json,re,base64
ROOT=Path(__file__).resolve().parents[2];SRC=ROOT/'test-app/src';OUT=Path(__file__).parent
BENCH=ROOT;PROD=ROOT/'index.html'
prod=PROD.read_text()
def section(text,start,end):
 a=text.index(start);return text[a:text.index(end,a)]
def badge(s):return s.replace('>ДУБЛИКАТ</span>',' title="Дубликат" aria-label="Дубликат">D</span>')
# Identical fixture content is used for benchmark, TEST and production renderers.
trucks=[{'id':'r','brand':'КАМАЗ','number':'А123ВС178','isGAI':False},{'id':'g','brand':'САМОСВАЛ ГАИ','number':'В456ЕК198','isGAI':True}]
logs=[{'id':'r1','shiftId':'current','truckId':'r','truckName':'КАМАЗ А123ВС178','volume':20,'timeStr':'09:15','timestamp':1000,'createdBy':'Оператор','createdByEmail':'operator@example.test','isGAI':False,'comment':'СВОЯ СМЕНА'}, {'id':'g1','shiftId':'current','truckId':'g','truckName':'САМОСВАЛ ГАИ В456ЕК198','volume':0,'timeStr':'10:30','timestamp':2000,'createdBy':'Оператор','createdByEmail':'operator@example.test','isGAI':True,'comment':'ГАИ СВОЕЙ СМЕНЫ'}]
state={'shift':{'id':'current','objectName':'Эталонный объект','startDate':'26.10.2026'},'users':[],'trucks':trucks,'logs':logs,'truckStatus':{'r':{'onLine':True,'shiftId':'current','ttnStatus':True,'ttnLogId':'r1'},'g':{'onLine':True,'shiftId':'current','ttnStatus':True,'ttnLogId':'g1'}},'archive':[
 {'id':'archive-a','objectName':'Эталонный объект','date':'26.10.2026','logs':logs,'activeLineIds':['r','g'],'ttnStatus':{'r':True,'g':True}},
 {'id':'archive-b','objectName':'АРХИВ Б','date':'24.10.2026','logs':[dict(logs[0],comment='ТОЛЬКО АРХИВ Б',volume=77,timeStr='22:22')],'activeLineIds':['r'],'ttnStatus':{'r':False}}], 'trash':[]}
stubs='''
let state=STATE;
const initialFixture=JSON.parse(JSON.stringify(state));
let showGAITable=false,viewingArchiveId=null,viewingArchiveGAITable=false,editingLogId=null,currentUserRole='admin',currentUserStatus='active',currentUid='fixture-admin',currentEmail='admin@example.test',currentUserNickname='Администратор';
window.fixtureErrors=[];window.fixtureToasts=[];window.fixtureWrites=[];window.fixturePermissions={gai:true,report:true,archive:true,edit:true};
function hasTabAccess(tab){return fixturePermissions[tab]!==false;}
function hasPermission(p){return p==='view_gai_report'?fixturePermissions.gai:p.startsWith('archive_')?fixturePermissions.edit:true;}
function canAdmin(){return true;}function offlinePendingOps(){return [];}
function requireEdit(){fixtureWrites.push('blocked');throw Error('No writes permitted in isolated fixture');}
function showError(message){fixtureErrors.push(message);}function showToastEl(message){fixtureToasts.push(message);}
function closeShift(){requireEdit();}function appConfirm(){requireEdit();}
window.__closedShiftDupEnabled=()=>true;
window.resetFixture=function(){state=JSON.parse(JSON.stringify(initialFixture));fixturePermissions.gai=true;fixturePermissions.archive=true;fixturePermissions.report=true;fixturePermissions.edit=true;closeArchiveModal();showGAITable=false;renderReport();renderArchive();};
'''.replace('STATE',json.dumps(state,ensure_ascii=False))
for mode in ['test','production']:
 # benchmark.html is a frozen, previously verified TEST3.1.21 reference fixture.
 # Do not regenerate it from the code under test.
 shell=(BENCH/'test-app/src/shell.html').read_text() if mode=='benchmark' else (prod if mode=='production' else (SRC/'shell.html').read_text())
 report=section(shell,'  <div id="tab-report"','  <div id="tab-archive"').replace('id="tab-report" class="tab-content"','id="tab-report" class="tab-content active"',1)
 modal=section(shell,'<div id="archiveModal"','<div id="selectorModal"')
 archive='<div id="fixture-archive"><h2>Архив</h2><input id="archiveSearchInput"><div id="archiveContainer"></div><div id="trashContainer"></div></div>'
 css=(BENCH/'test-app/src/styles/base.css').read_text() if mode=='benchmark' else (SRC/'styles/base.css').read_text()
 css=re.sub(r'@import[^;]+;','',css)
 font=base64.b64encode((BENCH/'test-app/vendor/caveat-0.ttf').read_bytes()).decode()
 css="@font-face{font-family:Caveat;font-style:normal;font-weight:100 900;src:url(data:font/ttf;base64,"+font+") format('truetype')}\n"+css
 if mode!='production':css+=(SRC/'styles/archive-test-layout-20261025.css').read_text()
 reports=(SRC/'core/13-reports.js').read_text() if mode=='test' else (badge(section(prod,'  // === ОТЧЕТ HTML ===','  // === АРХИВ ===')) if mode=='production' else (BENCH/'test-app/src/core/13-reports.js').read_text())
 if mode=='production':
  a=prod.index('  // === АРХИВ ===');b=prod.index('\n  // ===',a+25);archives=badge(prod[a:b])
 else:archives=(SRC/'core/14-archive.js').read_text()
 viewer=(BENCH/'test-app/src/features/summary-viewer.js').read_text() if mode=='benchmark' else (SRC/'features/summary-viewer.js').read_text()
 scripts=[stubs,(SRC/'core/05-formatting.js').read_text(),reports,archives,viewer,(SRC/'features/summary-hold.js').read_text(),'renderReport();renderArchive();']
 html='''<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src data:; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'"><title>Изолированная проверка бумажных листов</title><style>'''+css+'''</style><script src="/test-app/vendor/html2pdf-0.10.1.bundle.min.js"></script></head><body data-perms-ready="1"><main class="container">'''+report+archive+'''</main>'''+modal+''.join('<script>'+s.replace('</script','<\\/script')+'</script>' for s in scripts)+'</body></html>'
 (OUT/(mode+'.html')).write_text(html)
 print(mode,len(html))
