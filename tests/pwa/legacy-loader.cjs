const fs=require('node:fs'),path=require('node:path'),read=fs.readFileSync;
const target=path.resolve(__dirname,'../../index-test.html');
const html=require('../../tools/read-test-html.cjs')();
fs.readFileSync=function(file,options){
 if(typeof file==='string'&&path.resolve(file)===target)return (options==='utf8'||options?.encoding==='utf8')?html:Buffer.from(html);
 return read.apply(this,arguments);
};
