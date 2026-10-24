// Real browser rendering of the release's admin markup with a local account fixture.
const fs=require('fs'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom');
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright');
const html=fs.readFileSync('index-test.html','utf8'),parsed=new JSDOM(html);
const css=[...parsed.window.document.querySelectorAll('style')].map(s=>s.outerHTML).join('\n');
const admin=parsed.window.document.querySelector('#tab-admin').outerHTML;
const scripts=[...parsed.window.document.scripts];
const report=scripts.find(s=>s.id==='work-report').textContent,core=scripts.find(s=>s.id==='test-review-core').textContent;
const profile=scripts.find(s=>s.textContent.startsWith('window.TEST_REVIEW_RELEASE=')).textContent;
parsed.window.close();
(async()=>{let browser;try{
 browser=await chromium.launch({headless:true,executablePath:process.env.REVIEW_BROWSER,args:['--no-sandbox']});
 for(const viewport of [{width:375,height:812},{width:1280,height:900}]){
  const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(8000);
  await page.setContent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'+css+admin);
  await page.addScriptTag({content:fs.readFileSync('tests/timesheet/fixture.js','utf8')});
  await page.addScriptTag({content:`var appConfig={testReviewFlags:{}};function canAdmin(){return currentUserRole==='admin';}function renderConflictAuthorPatch(){};var appConfigRef={set:async()=>{}};function switchAdminTab(tab,b){document.querySelectorAll('.admin-section').forEach(x=>x.classList.remove('active'));document.getElementById('admin-sub-'+tab).classList.add('active');}document.body.dataset.permsReady='1';document.getElementById('tab-admin').classList.add('active');`});
  await page.addScriptTag({content:profile});await page.addScriptTag({content:core});await page.addScriptTag({content:report});
  assert.equal(errors.length,0,errors.join('\n'));assert(await page.evaluate(()=>!!window.WorkReport),'Report initialized');await page.getByRole('button',{name:'Отчёт о работе',exact:true}).click();
  assert(await page.getByRole('heading',{name:'Наш дальнейший план'}).isVisible());
  const entry=page.locator('#admin-sub-workreport [data-report-id="conflict_author"]');
  await entry.locator('summary').click();assert(await entry.locator('textarea').isVisible());
  assert((await page.locator('#admin-sub-workreport').evaluate(el=>el.scrollWidth<=el.clientWidth+1)),'Report must fit screen width');
  await page.evaluate(()=>{currentUserRole='viewer';renderAll();});
  assert.equal(await page.locator('#admin-sub-workreport').textContent(),'');
  await page.evaluate(()=>{currentUserRole='admin';renderAll();});
  assert.equal(errors.length,0,errors.join('\n'));
  if(process.env.REVIEW_SCREENSHOT&&viewport.width===375){await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:process.env.REVIEW_SCREENSHOT});}
  await page.close();console.log('PASS release owner report '+viewport.width+'px: visible plan, expandable checks, no overflow, role isolation, no JS errors');
 }
 }finally{await browser?.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
