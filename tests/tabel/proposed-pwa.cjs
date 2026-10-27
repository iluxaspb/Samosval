// Test the proposed bytes in memory, without modifying protected release files.
const fs=require('node:fs'),path=require('node:path');
const read=fs.readFileSync;
fs.readFileSync=function(file,...args){
  const target=String(file).replace(/^\.\//,'');
  if(target==='sw-test.js')return read.call(this,'test-app/tabel/proposals/sw-test.CANDIDATE.js',...args);
  if(target==='test-app/build-manifest.json')return read.call(this,'test-app/tabel/proposals/build-manifest.CANDIDATE.json',...args);
  return read.call(this,file,...args);
};
require('../pwa/service-worker.cjs');
