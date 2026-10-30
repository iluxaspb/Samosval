import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
test('TEST shell, published candidate and offline cache contain all connection modules',()=>{
  const html=read('index-test.html'),shell=read('test-app/source/shell.html');
  const manifest=JSON.parse(read('test-app/build-manifest.json'));
  const sw=read('sw-test.js');
  const records=JSON.parse(sw.match(/^const RECORDS = (.*);$/m)[1]);
  assert.deepEqual(records,manifest.assets);
  assert.equal(html.match(/name="test-app-build" content="([^"]+)"/)[1],manifest.version);
  assert.ok(sw.includes("const VERSION = '"+manifest.version+"';"));
  for(const page of [html,shell]){
    assert.equal(page.match(/id="test-server-connection"/g)?.length,1);
    assert.ok(page.includes('src="./test-app/synology/connection-host.js"'));
  }
  for(const path of ['index-test.html','test-app/synology/connection-host.js','test-app/synology/connection-panel.mjs','test-app/synology/connection-state.mjs']){
    const entry=manifest.assets.filter(x=>x.url==='./'+path);
    assert.equal(entry.length,1,path);
    assert.equal(entry[0].sha256,createHash('sha256').update(read(path)).digest('hex'),path);
  }
});
