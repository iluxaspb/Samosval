// Optional read-only source overlay for before/after regression evidence.
// DATA_SAFETY_SOURCE_ROOT points at an untouched checkout; fixtures and tests
// still run from this checkout. No files are copied, rebuilt or mutated.
const fs=require('node:fs'),path=require('node:path');
if(process.env.DATA_SAFETY_SOURCE_ROOT){
 const root=path.resolve(__dirname,'../..','test-app/src');
 const replacement=path.resolve(process.env.DATA_SAFETY_SOURCE_ROOT,'test-app/src');
 if(!fs.statSync(replacement).isDirectory())throw Error('Source checkout must include test-app/src');
 const read=fs.readFileSync;
 fs.readFileSync=function(file,...args){
  if(typeof file==='string'){
   const absolute=path.resolve(file);
   if(absolute.startsWith(root+path.sep))return read.call(this,path.join(replacement,path.relative(root,absolute)),...args);
  }
  return read.call(this,file,...args);
 };
}
