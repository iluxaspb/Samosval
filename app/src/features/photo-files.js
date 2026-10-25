
(function(){
  'use strict';
  const MAX_EDGE=3072,MAX_BYTES=12*1024*1024;
  const error=text=>new Error(text);
  function canvas(w,h){const out=document.createElement('canvas');out.width=w;out.height=h;if(!out.getContext('2d',{alpha:false,willReadFrequently:true}))throw error('Не удалось подготовить изображение. Откройте камеру телефона.');return out;}
  function checkPixels(source){
    if(source.width<16||source.height<16)throw error('Камера вернула пустой кадр. Повторите снимок или откройте камеру телефона.');
    const sample=canvas(32,32),ctx=sample.getContext('2d');ctx.drawImage(source,0,0,32,32);const data=ctx.getImageData(0,0,32,32).data;let max=0;
    for(let i=0;i<data.length;i+=4)if(data[i+3])max=Math.max(max,data[i],data[i+1],data[i+2]);
    if(max<=3)throw error('Кадр полностью чёрный. Проверьте объектив и освещение или используйте камеру телефона.');
  }
  function copy(source,width,height){
    if(!Number.isFinite(width)||!Number.isFinite(height)||width<16||height<16)throw error('Камера не передала изображение. Повторите снимок.');
    const scale=Math.min(1,MAX_EDGE/Math.max(width,height)),out=canvas(Math.round(width*scale),Math.round(height*scale)),ctx=out.getContext('2d');ctx.drawImage(source,0,0,out.width,out.height);
    // Force a CPU-owned pixel copy before a video track, ImageBitmap or source canvas is released.
    const pixels=ctx.getImageData(0,0,out.width,out.height);ctx.putImageData(pixels,0,0);checkPixels(out);return out;
  }
  async function decode(blob){
    if(!blob?.size)throw error('Пустой файл фотографии. Сделайте новый снимок.');
    if(typeof Image==='function'){
      const url=URL.createObjectURL(blob);let img;
      try{img=await new Promise((resolve,reject)=>{const image=new Image();const timer=setTimeout(()=>reject(error('Не удалось прочитать фото. Используйте JPEG.')),10000);image.onload=()=>{clearTimeout(timer);resolve(image);};image.onerror=()=>{clearTimeout(timer);reject(error('Файл фотографии повреждён или его формат не поддерживается.'));};image.src=url;});return copy(img,img.naturalWidth,img.naturalHeight);}
      finally{if(img)img.src='';URL.revokeObjectURL(url);}
    }
    if(typeof createImageBitmap==='function'){const bitmap=await createImageBitmap(blob,{imageOrientation:'from-image'});try{return copy(bitmap,bitmap.width,bitmap.height);}finally{bitmap.close?.();}}
    throw error('Браузер не может прочитать фотографию. Откройте страницу в обычном браузере телефона.');
  }
  async function validate(blob,expected){
    if(blob?.type!=='image/jpeg'||blob.size<128||blob.size>MAX_BYTES)throw error('Не удалось получить корректный JPEG до 12 МБ. Повторите снимок.');
    const head=new Uint8Array(await blob.slice(0,3).arrayBuffer()),tail=new Uint8Array(await blob.slice(-2).arrayBuffer());
    if(head[0]!==255||head[1]!==216||head[2]!==255||tail[0]!==255||tail[1]!==217)throw error('Файл JPEG повреждён. Он не будет отправлен в облако.');
    const decoded=await decode(blob);try{if(expected&&(decoded.width!==expected.width||decoded.height!==expected.height))throw error('Размер сохранённого фото изменился. Повторите снимок.');return {width:decoded.width,height:decoded.height};}finally{decoded.width=decoded.height=1;}
  }
  function dataBlob(value){const parts=value.split(','),raw=atob(parts[1]),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);return new Blob([bytes],{type:'image/jpeg'});}
  async function encode(source){
    checkPixels(source);const expected={width:source.width,height:source.height};let firstError;
    try{const blob=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(error('Камера не завершила сохранение JPEG.')),10000);source.toBlob(value=>{clearTimeout(timer);value?resolve(value):reject(error('Не удалось создать JPEG.'));},'image/jpeg',.92);});await validate(blob,expected);return blob;}catch(e){firstError=e;}
    try{const blob=dataBlob(source.toDataURL('image/jpeg',.9));await validate(blob,expected);return blob;}catch(e){throw firstError;}
  }
  function filename(meta){return (String(meta.name||'Фото').replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]+/g,'_').slice(0,60)||'Фото')+'_'+new Date(meta.shotAt||Date.now()).toISOString().replace(/[:.]/g,'-')+'.jpg';}
  function download(blob,name){
    if(!blob?.size)throw error('Снимок не найден на устройстве.');
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name||'Фото.jpg';a.style.display='none';document.body.append(a);a.click();a.remove();
    // This URL belongs to the download, never to the camera dialog lifecycle.
    setTimeout(()=>URL.revokeObjectURL(url),120000);
  }
  window.PhotoFiles={copy,decode,validate,encode,checkPixels,download,filename,MAX_EDGE};
})();
