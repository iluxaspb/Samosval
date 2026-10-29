// Read production script bundles for parity tests without changing the runtime.
const fs=require('node:fs'),path=require('node:path');
const read=fs.readFileSync.bind(fs);
module.exports=function(root=path.resolve(__dirname,'..')){
 return read(path.join(root,'index.html'),'utf8')
 .replace(/<script\b([^>]*?)\ssrc="(\.\/app\/build\/[^"]+)"([^>]*)><\/script>/g,
   (_,before,url,after)=>'<script'+before+after+'>'+read(path.join(root,url),'utf8').replace(/<\/script/gi,'<\\/script')+'</script>');
};
