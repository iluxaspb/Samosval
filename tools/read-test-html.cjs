// Compatibility reader for source-oriented regression tests. Runtime uses external files.
const fs=require('node:fs'),path=require('node:path');
const read=fs.readFileSync.bind(fs);
module.exports=function(root=path.resolve(__dirname,'..')) {
 return read(path.join(root,'index-test.html'),'utf8')
 .replace(/<script\b([^>]*?)\ssrc="(\.\/test-app\/[^\"]+)"([^>]*)><\/script>/g,(_,before,url,after)=>'<script'+before+after+'>'+read(path.join(root,url),'utf8').replace(/<\/script/gi,'<\\/script')+'</script>')
 .replace(/<link rel="stylesheet"([^>]*?) href="(\.\/test-app\/[^\"]+)"\s*>/g,(_,attrs,url)=>'<style'+attrs+'>'+read(path.join(root,url),'utf8')+'</style>');
};
