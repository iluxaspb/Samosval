'use strict';
// Run against a captured pre-integration checkout and (optionally) post-reset HTML.
// No baseline is inferred from mutable builds, release versions or remote state.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'../..'),baseline=process.argv[2],production=process.argv[3]||path.join(root,'index.html');
assert(baseline,'Usage: node tests/selector-reset/preservation.cjs /path/to/pre-integration-tree [/path/to/post-reset-index.html]');
const read=(base,file)=>fs.readFileSync(path.join(base,file)),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function parts(bytes){
  const source=bytes.toString(),matches=[...source.matchAll(/function openSelectorModal\(\) \{[^\n]*\}/g)];assert.equal(matches.length,1);
  const m=matches[0],start=Buffer.byteLength(source.slice(0,m.index)),end=start+Buffer.byteLength(m[0]);
  return {prefix:bytes.subarray(0,start),function:m[0],suffix:bytes.subarray(end)};
}
for(const file of ['index.html','test-app/src/core/15-directory-views.js']){
  const before=read(baseline,file),after=file==='index.html'?fs.readFileSync(production):read(root,file),b=parts(before),a=parts(after);
  assert.deepEqual(a.prefix,b.prefix,file+': preceding bytes changed');assert.deepEqual(a.suffix,b.suffix,file+': following bytes changed');
  const reset="const search=document.getElementById('truckSearchInput');if(search)search.value='';";
  const expected=file==='index.html'?b.function.replace('return; document','return; '+reset+' document'):b.function.replace("if(appConfig?.testReviewFlags?.selector_reset!==false){"+reset+'}',reset);
  assert.equal(a.function,expected,'The only function change must make query reset unconditional after its guard');
  console.log(JSON.stringify({file,beforeSha256:sha(before),afterSha256:sha(after),outsideFunctionBytes:b.prefix.length+b.suffix.length,outsideFunctionSha256:sha(Buffer.concat([b.prefix,b.suffix])),outsideFunctionByteIdentical:true}));
}
function core(base){const context={module:{exports:{}}};vm.runInNewContext(read(base,'test-app/src/features/test-review-core.js').toString(),context);return JSON.parse(JSON.stringify(context.module.exports.patches));}
assert.deepEqual(core(root),core(baseline).filter(p=>p.id!=='selector_reset'),'All unrelated registry metadata must be identical');
const registryFile='test-app/src/features/test-review-core.js',beforeRegistry=read(baseline,registryFile).toString();
const expectedRegistry=beforeRegistry.replace(/^    \['selector_reset',[^\n]*\n/m,'').replace("selector_reset:'prepared',",'').replace("'selector_reset',",'');
assert.equal(read(root,registryFile).toString(),expectedRegistry,'Registry code must only remove the accepted definition, status and switchability entry');
const configFile='test-app/src/features/review-config.js';assert.equal(read(root,configFile).toString(),read(baseline,configFile).toString().replace('"selector_reset",',''),'Only accepted release feature entry may change');
console.log('PASS exact scope: production and TEST only one function; all 43 other patch objects byte-equivalent in serialized content; unrelated registry/config code unchanged');
