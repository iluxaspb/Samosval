// Version labels must describe the loaded release, not a legacy feature's release number.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const release=fs.readFileSync('test-app/src/features/release-history.js','utf8');
const current=release.match(/version:'([^']+)'/)[1];let replacement;
const dialogs=new Map();
const element=()=>({children:[],events:{},setAttribute(){},addEventListener(name,fn){this.events[name]=fn;},append(...nodes){this.children.push(...nodes);},showModal(){this.open=true;},focus(){this.focused=true;},close(){this.open=false;this.events.close?.();},remove(){dialogs.delete(this.id);}});
const document={
  createElement:element,body:{append:node=>dialogs.set(node.id,node)},getElementById:id=>dialogs.get(id),
  head:{appendChild(){}},querySelector:selector=>{assert.equal(selector,'.version-text');return {replaceWith:node=>replacement=node};}
};
const context={window:{},document};vm.runInNewContext(release,context);
assert.equal(replacement.textContent,'Версия '+current);
assert.equal(replacement.className,'version-text');assert.equal(replacement.type,'button');
assert.equal(context.window.TEST_APP_RELEASE.version,current);
assert.equal(context.window.TEST_APP_RELEASE.label,'Тест '+current.split(' · ')[0]);
assert(Object.isFrozen(context.window.TEST_APP_RELEASE));
replacement.events.click();assert.equal(dialogs.size,0,'Unknown permissions must not expose history');
context.permissionsLoaded=true;context.canAdmin=()=>false;
replacement.events.click();assert.equal(dialogs.size,0,'Non-admin must not open history');
context.permissionsLoaded=false;context.canAdmin=()=>true;
replacement.events.click();assert.equal(dialogs.size,0,'Unloaded permissions must not open history');
context.permissionsLoaded=true;replacement.events.click();
assert.equal(dialogs.size,1,'Active admin can open history');
const dialog=dialogs.get('releaseHistoryDialog');assert.equal(dialog.open,true);
replacement.events.click();assert.equal(dialogs.get('releaseHistoryDialog'),dialog,'Repeated click must not create duplicate dialogs');
const headings=dialog.children[1].children.filter(node=>node.children.length===2).map(node=>node.children[0].textContent);
for(const version of ['3.1.22','3.1.21','3.1.20','3.1.19','3.1.18'])assert(headings.some(text=>text.startsWith(version+' · тест')),'Release history is retained: '+version);
dialog.close();assert.equal(dialogs.size,0);assert.equal(replacement.focused,true);
replacement.events.click();assert.notEqual(dialogs.get('releaseHistoryDialog'),dialog,'Closing must allow reopening');
dialogs.get('releaseHistoryDialog').close();
vm.runInNewContext(fs.readFileSync('test-app/src/features/review-config.js','utf8'),context);
assert.equal(context.window.TEST_REVIEW_RELEASE.label,context.window.TEST_APP_RELEASE.label);
assert(fs.readFileSync('test-app/src/shell.html','utf8').includes('Версия '+current));
assert(fs.readFileSync('test-app/src/features/timesheet-app.js','utf8').includes("window.TEST_APP_RELEASE?.label||'Тест'"));
assert(/\.version-text\s*\{[^}]*color:\s*#e11d48/.test(fs.readFileSync('test-app/src/styles/base.css','utf8')));
console.log('PASS header, reports and timesheet share one immutable current release; red label and retained history; admin gate, repeated click, close/reopen');
