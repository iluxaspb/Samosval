const fs=require('fs'),assert=require('node:assert/strict'),vm=require('vm');
const html=fs.readFileSync('index.html','utf8'),patch=fs.readFileSync('patches/max-plate-notifications-v1.js','utf8');
const marker='<!-- MAX PLATE PNG PATCH START -->',end='<!-- MAX PLATE PNG PATCH END -->';assert.equal(html.split(marker).length,2);assert.equal(html.split(end).length,2);assert(html.includes(patch.trim()));
const original=html.replace(/<!-- MAX PLATE PNG PATCH START -->[\s\S]*?<!-- MAX PLATE PNG PATCH END -->\n?/,''),bytes=Buffer.from(original);
assert.equal(require('node:crypto').createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex'),'c3f32d73d9419e92db8f9ab1e2d09d0e918b1760','Original HTML must remain byte-for-byte unchanged outside the appended patch');
let count=0;for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)){new vm.Script(m[1]);count++;}
for(const m of html.matchAll(/\(0, eval\)\(("(?:[^"\\]|\\.)*")\)/g))new vm.Script(JSON.parse(m[1]));
assert(patch.includes("item.type !== 'text'"));assert(!patch.includes('platform-api'));assert(!patch.includes('firebase.firestore'));
console.log('PASS original HTML and baked patch syntax ('+count+' scripts); client contains no direct MAX bot calls or Firestore writes');
