from pathlib import Path
import re,base64,json
root=Path(__file__).resolve().parents[2];src=root/'test-app/src'
shell=(src/'shell.html').read_text();report=shell[shell.index('  <div id="tab-report"'):shell.index('  <div id="tab-archive"')]
report=report.replace('id="tab-report" class="tab-content"','id="tab-report" class="tab-content active"',1)
css=(src/'styles/base.css').read_text();css=re.sub(r'@import[^;]+;','',css)
font=base64.b64encode((root/'test-app/vendor/caveat-0.ttf').read_bytes()).decode()
css="@font-face{font-family:Caveat;font-style:normal;font-weight:100 900;src:url(data:font/ttf;base64,"+font+") format('truetype')}\n"+css
state={'shift':{'id':'fixture-shift','objectName':'Проверка сводки — локальные данные','startDate':'26.10.2026'},'users':[],'trucks':[{'id':'regular','brand':'КАМАЗ (обычный)','number':'А123ВС178','isGAI':False},{'id':'gai','brand':'САМОСВАЛ ГАИ','number':'В456ЕК198','isGAI':True}],'logs':[{'id':'regular-log','shiftId':'fixture-shift','truckId':'regular','truckName':'КАМАЗ А123ВС178','volume':20,'timeStr':'09:15','timestamp':1000,'createdBy':'Оператор','createdByEmail':'operator@example.test','isGAI':False},{'id':'gai-log','shiftId':'fixture-shift','truckId':'gai','truckName':'САМОСВАЛ ГАИ В456ЕК198','volume':0,'timeStr':'10:30','timestamp':2000,'createdBy':'Оператор','createdByEmail':'operator@example.test','isGAI':True}],'truckStatus':{'regular':{'onLine':True,'ttnStatus':True,'ttnLogId':'regular-log'},'gai':{'onLine':True}},'archive':[]}
stubs='''// Isolated fixture: data/auth/backend only. Real report rendering and viewer/hold initialization below.
let state = STATE;
let showGAITable=false,editingLogId=null,currentUserRole='admin',currentUserStatus='active',currentUid='fixture-admin',currentEmail='admin@example.test',currentUserNickname='Администратор';
function hasTabAccess(){return true;} function hasPermission(){return true;} function canAdmin(){return true;}
function offlinePendingOps(){return [];} function requireEdit(){showError('Изолированная проверка: запись отключена');return false;}
function showError(message){document.getElementById('fixture-status').textContent=message;} function showToastEl(message){showError(message);}
function closeShift(){showError('Изолированная проверка: запись отключена');}
window.__summaryFixture={network:'disabled',auth:'active admin stub',data:'two local trucks / two trips'};
'''.replace('STATE',json.dumps(state,ensure_ascii=False))
scripts=[stubs,(src/'core/05-formatting.js').read_text(),(src/'core/13-reports.js').read_text(),(src/'features/summary-viewer.js').read_text(),(src/'features/summary-hold.js').read_text(),'renderReport();']
html='''<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'"><title>Локальная проверка сводки — TEST hotfix</title><style>'''+css+'''</style></head><body data-perms-ready="1" data-release-admin="1"><main class="container"><h1 style="font-size:20px;margin-bottom:8px">Сводка</h1><p id="fixture-status" style="font-size:12px;color:#94a3b8;margin-bottom:12px">Локальная проверка: реальные листы и обработчики, без Firebase и сети. Маленький листик справа: удерживать 0,8 с.</p>'''+report+'''</main>'''+''.join('<script>'+s.replace('</script','<\\/script')+'</script>' for s in scripts)+'</body></html>'
p=root/'tests/full-audit/summary-visual.html';p.parent.mkdir(parents=True,exist_ok=True);p.write_text(html)
print(str(p),len(html),'bytes')
