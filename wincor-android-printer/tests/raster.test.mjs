import test from 'node:test';
import assert from 'node:assert/strict';
import {rasterBytes} from '../core.js';

const header=[27,64,27,116,1,27,54,27,82,0,27,91,48,37,116,27,108,1,13,27,91,51,57,33,112,27,51,24];
// Frozen v0.1 encoder, independent from the optimized implementation.
function legacy(rgba,width,height){const out=[...header];for(let y=0;y<height;y+=24){out.push(13,27,42,39,width&255,width>>8);for(let x=0;x<width;x++)for(let group=0;group<3;group++){let v=0;for(let bit=0;bit<8;bit++){const py=y+group*8+bit,idx=(py*width+x)*4;if(py<height&&rgba[idx+3]>128&&(.2126*rgba[idx]+.7152*rgba[idx+1]+.0722*rgba[idx+2])<150)v|=128>>bit}out.push(v)}if(y+24<height)out.push(13,10)}out.push(12,27,64);return Uint8Array.from(out)}

// Parse command framing, then consume payload by its declared length. In
// particular, payload bytes 10, 12, 13 and 27 must never become commands.
function decode(bytes){
  assert.deepEqual(Array.from(bytes.slice(0,header.length)),header);
  let i=header.length,x=0,y=0,forms=0,blocks=0;const ink=[];
  while(i<bytes.length){
    const c=bytes[i++];
    if(c===13){x=0;continue}
    if(c===10){y+=24;continue}
    if(c===12){forms++;continue}
    assert.equal(c,27,'unexpected command');const op=bytes[i++];
    if(op===64){assert.equal(i,bytes.length,'reset must end page');continue}
    if(op===36){x=3*(bytes[i++]+256*bytes[i++]);continue}
    assert.equal(op,42);assert.equal(bytes[i++],39);
    const count=bytes[i++]+256*bytes[i++];assert.ok(count>0);
    assert.ok(i+count*3<=bytes.length);blocks++;
    for(let col=0;col<count;col++){
      for(let group=0;group<3;group++){
        const value=bytes[i++];
        for(let bit=0;bit<8;bit++)if(value&(128>>bit))ink.push(`${x+col},${y+group*8+bit}`);
      }
    }
    x+=count;
  }
  assert.equal(forms,1);
  return {ink:ink.sort(),y,forms,blocks};
}
function white(w,h){return new Uint8ClampedArray(w*h*4).fill(255)}
function pixel(data,w,x,y,r=0,g=r,b=r,a=255){data.set([r,g,b,a],(y*w+x)*4)}
function compare(data,w,h){
  const old=legacy(data,w,h),next=rasterBytes(data,w,h),before=decode(old),after=decode(next);
  assert.deepEqual(after.ink,before.ink);assert.equal(after.y,before.y);assert.equal(after.forms,before.forms);
  assert.ok(next.length<=old.length);
  const expected=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const p=(y*w+x)*4;
    if(data[p+3]>128&&data[p]*.2126+data[p+1]*.7152+data[p+2]*.0722<150)expected.push(`${x},${y}`);
  }
  assert.deepEqual(after.ink,expected.sort());
  return {old:old.length,next:next.length,blocks:after.blocks};
}

test('empty A4 emits no graphics while preserving paper feed and form end',()=>{
  const r=compare(white(1488,2105),1488,2105);
  assert.equal(r.blocks,0);assert.ok(r.next<250);
});
test('sparse pixels keep positions across empty bands and partial final band',()=>{
  const w=513,h=145,data=white(w,h);
  for(const [x,y] of [[0,0],[512,23],[1,24],[350,97],[512,144]])pixel(data,w,x,y);
  compare(data,w,h);
});
test('opaque white, transparency, luminance threshold and control-like bitmap bytes',()=>{
  const w=31,h=49,data=white(w,h);
  for(let x=0;x<w;x++)for(let y=0;y<h;y++){
    const levels=[0,149,150,255];const n=(x+y)%4;
    pixel(data,w,x,y,levels[n],levels[n],levels[n],x%5===0?128:255);
  }
  compare(data,w,h);
});
test('dense image remains byte-for-byte identical to legacy transport',()=>{
  const w=257,h=73,data=white(w,h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)pixel(data,w,x,y);
  assert.deepEqual(rasterBytes(data,w,h),legacy(data,w,h));compare(data,w,h);
});
test('seeded sparse shapes preserve all pixels at varied dimensions',()=>{
  let seed=81017;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed};
  for(const [w,h] of [[1,1],[1,25],[7,24],[255,48],[256,71],[513,239]]){
    const data=white(w,h);
    for(let n=0;n<100;n++)pixel(data,w,rand()%w,rand()%h);
    compare(data,w,h);
  }
});
test('representative sparse A4 with six text-like runs shrinks by at least 90%',t=>{
  const w=1488,h=2105,data=white(w,h);
  for(const [left,top,count] of [[410,100,10],[1025,100,4],[70,185,24],[360,312,18],[930,700,18],[1060,1400,9]]){
    for(let c=0;c<count;c++)for(let y=0;y<16;y++)for(let x=0;x<8;x++)
      if(x===0||x===7||y===0||y===15||(x+y+c)%5===0)pixel(data,w,left+c*10+x,top+y);
  }
  const r=compare(data,w,h);assert.ok(r.next<r.old*.1);
  t.diagnostic(`Synthetic sparse A4: ${r.old} -> ${r.next} bytes; saved ${(100*(1-r.next/r.old)).toFixed(1)}%.`);
});
