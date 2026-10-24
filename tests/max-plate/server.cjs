const assert=require('node:assert/strict'),{createMaxPlateSupport,CONTRACT}=require('../../server/max-plate-support.cjs');
const png=Buffer.alloc(40);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.write('IHDR',12);png.writeUInt32BE(600,16);png.writeUInt32BE(144,20);
const body={contract:CONTRACT,request_id:'q_1',chat_id:'-12345',text:'⚡ Погрузка\n🚛 А123ВС178',image:{mime_type:'image/png',content_base64:png.toString('base64')}};
const calls=[],response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});let ready=false;
const mock=async(url,options)=>{calls.push({url,options});if(url.includes('/uploads?'))return response({url:'https://iu.oneme.ru/uploadImage?secret=fixture'});if(url.includes('iu.oneme.ru'))return response({photos:{one:{token:'uploaded-image-token'}}});if(!ready){ready=true;return response({code:'attachment.not.ready'},400);}return response({message:{body:{mid:'mid-1'}}});};
(async()=>{
 const sender=createMaxPlateSupport({botToken:'fake-server-only-token',fetchImpl:mock,pause:async()=>{}});
 const [a,b]=await Promise.all([sender.send(body),sender.send(body)]);assert.deepEqual(a,b);assert.equal(a.message_id,'mid-1');assert.equal(calls.filter(c=>c.url.includes('/uploads?')).length,1);
 const posts=calls.filter(c=>c.url.includes('/messages?'));assert.equal(posts.length,2);for(const p of posts){const json=JSON.parse(p.options.body);assert.equal(json.text,body.text);assert.equal(json.attachments[0].type,'image');assert.equal(json.attachments[0].payload.token,'uploaded-image-token');assert(!json.document);assert.equal(p.options.headers.Authorization,'fake-server-only-token');}
 assert(calls[1].options.body instanceof FormData);assert.equal(calls[1].options.body.get('data').type,'image/png');await sender.send(body);assert.equal(calls.length,4);
 await assert.rejects(sender.send({...body,text:'Changed'}),e=>e.status===409);await sender.send({...body,request_id:'q_2'});assert.equal(calls.filter(c=>c.url.includes('/uploads?')).length,1);
 await assert.rejects(sender.send({...body,request_id:'q_3',image:{mime_type:'image/png',content_base64:'PHN2Zz4='}}),e=>e.status===400);
 const unsafe=createMaxPlateSupport({botToken:'fake',fetchImpl:async()=>response({url:'https://other.invalid/upload'})});await assert.rejects(unsafe.send(body),/Unexpected MAX upload host/);
 const invalidAck=createMaxPlateSupport({botToken:'fake',fetchImpl:async(url)=>url.includes('/uploads?')?response({url:'https://iu.oneme.ru/uploadImage'}):url.includes('iu.oneme.ru')?response({photos:{one:{token:'token'}}}):response({success:true})});await assert.rejects(invalidAck.send(body),/did not confirm/);
 console.log('PASS relay: authenticated-token format, multipart PNG upload, image attachment plus text, not-ready retry, reusable upload token, same-process replay/concurrency, validation and upload-host restriction');
})().catch(e=>{console.error(e);process.exitCode=1;});
