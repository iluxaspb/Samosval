import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const types={'.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.webmanifest':'application/manifest+json'};
const server=createServer(async(req,res)=>{try{const name=new URL(req.url,'http://local').pathname,file=path.join(root,name==='/'?'index.html':name);let body=await readFile(file);if(name==='/app.js')body=body.toString()+'\nglobalThis.__editorTest={imageData,flush:()=>saveChain,get state(){return state}};';res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});res.end(body)}catch{res.writeHead(404);res.end()}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:393,height:852},isMobile:true,hasTouch:true}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.locator('[data-action="editor"]').click();
 await page.locator('#props [data-action="field-select"]').first().click();
 await page.locator('[data-action="field-edit"]').click();
 const panel=page.locator('#field-toolbar');
 for(const size of [{width:393,height:852},{width:852,height:393},{width:320,height:568}]){
  await page.setViewportSize(size);await panel.scrollIntoViewIfNeeded();
  const box=await panel.boundingBox();assert.ok(box.height<=size.height/3+1,JSON.stringify({size,box}));
  assert.ok(box.width<=size.width);assert.equal(await page.locator('#modal').evaluate(el=>el.open),false);
 }
 await page.setViewportSize({width:393,height:852});
 await page.getByRole('tab',{name:'Параметры',exact:true}).click();
 assert.ok((await panel.boundingBox()).height<=852/3+1);
 await page.getByRole('tab',{name:'Оформление',exact:true}).click();
 // A second field can be selected on the sheet while the panel remains open.
 const secondFieldId=await page.locator('#sheet [data-field]').nth(1).getAttribute('data-field');
 await page.locator('#sheet [data-field]').nth(1).click();
 assert.equal(await page.locator('#sheet .field.sel').getAttribute('data-field'),secondFieldId);
 assert.equal(await panel.isVisible(),true);
 await page.locator('[data-prop="bold"]').check();
 assert.equal(await page.locator('#sheet .field.sel').evaluate(el=>el.style.fontWeight),'700');
 await page.locator('[data-action="field-close"]').click();assert.equal(await panel.isVisible(),false);
 await page.locator('[data-action="template-settings"]').click();
 const input=page.locator('input[name="background"]');assert.match(await input.getAttribute('accept'),/\.jpg,\.jpeg/);
 await page.locator('#background-all-files').check();assert.equal(await input.getAttribute('accept'),null);
 const jpeg=await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=24;c.height=16;c.getContext('2d').fillRect(0,0,24,16);const blob=await new Promise(r=>c.toBlob(r,'image/jpeg'));return [...new Uint8Array(await blob.arrayBuffer())]});
 await input.setInputFiles({name:'scan.JPEG',mimeType:'',buffer:Buffer.from(jpeg)});
 await page.locator('#template-form [type="submit"]').click();await page.waitForFunction(()=>!document.querySelector('#modal').open);
 assert.match(await page.locator('#sheet img').getAttribute('src'),/^data:image\/jpeg;base64,/);
 const validation=await page.evaluate(async bytes=>{const result={};for(const mime of ['', 'application/octet-stream','image/jpg']){result[mime]=(await __editorTest.imageData(new File([new Uint8Array(bytes)],'scan.jpeg',{type:mime}))).startsWith('data:image/jpeg;')}for(const [name,bytes] of [['text',[65,66,67]],['damaged',[255,216,255,0]]]){try{await __editorTest.imageData(new File([new Uint8Array(bytes)],'fake.jpg',{type:'image/jpeg'}));result[name]=false}catch{result[name]=true}}return result},jpeg);
 assert.ok(Object.values(validation).every(Boolean));
 await page.evaluate(()=>__editorTest.flush());await page.reload();await page.locator('[data-action="editor"]').click();assert.match(await page.locator('#sheet img').getAttribute('src'),/^data:image\/jpeg;base64,/);
 assert.deepEqual(errors,[]);await mkdir(path.join(root,'test-artifacts'),{recursive:true});
 await page.locator('#props [data-action="field-select"]').first().click();await page.locator('[data-action="field-edit"]').click();await page.screenshot({path:path.join(root,'test-artifacts','compact-editor-mobile.png')});
 console.log(JSON.stringify({compactThirdScreen:true,nonmodalFieldSelection:true,allFilesFallback:true,jpegWithoutMimeImportedAndPersisted:true,mislabeledMimeDecoded:true,invalidImagesRejected:true,pageErrors:errors}));
}finally{await browser.close();await new Promise(r=>server.close(r))}
