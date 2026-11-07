import test from 'node:test';
import assert from 'node:assert/strict';
import {initial,clone,newTripField,fontStyle,fontCss,canvasFont,applyTemplateFont,makeJob,validate} from '../core.js';

test('legacy fields default to Arial without italic in every rendering mode',()=>{
 const f={size:11,bold:false};
 assert.deepEqual(fontStyle(f),{fontFamily:'Arial',size:11,bold:false,italic:false});
 assert.match(fontCss(f),/font-family:Arial, sans-serif.*font-style:normal/);
 assert.match(canvasFont(f),/^normal normal 27.5px Arial, sans-serif$/);
 assert.doesNotThrow(()=>validate(initial()));
});
test('all-field font changes current template and new defaults, keeps geometry and other templates',()=>{
 const state=initial(),template=state.templates[0],other=clone(template);other.id='other';state.templates.push(other);
 const positions=template.fields.map(({x,y,w})=>({x,y,w}));
 const style={fontFamily:'Times New Roman',size:14,bold:true,italic:true};
 applyTemplateFont(template,style);
 assert.ok(template.fields.every(f=>JSON.stringify(fontStyle(f))===JSON.stringify(style)));
 assert.deepEqual(template.fields.map(({x,y,w})=>({x,y,w})),positions);
 assert.equal(fontStyle(other.fields[0]).fontFamily,'Arial');
 assert.deepEqual(fontStyle(newTripField(template.fontDefaults)),style);
 template.fields[0].fontFamily='Courier New';template.fields[0].italic=false;
 assert.equal(template.fields[1].fontFamily,'Times New Roman');
 assert.equal(template.fields[1].italic,true);
});
test('history and restored backups preserve fonts despite later changes',()=>{
 const state=initial();state.trucks.push({id:'truck',plate:'А123АА'});
 applyTemplateFont(state.templates[0],{fontFamily:'Courier New',size:15,bold:true,italic:true});
 const job=makeJob(state,['truck'],'2026-11-07',1);state.jobs.push(job);
 applyTemplateFont(state.templates[0],{fontFamily:'Arial',size:10,bold:false,italic:false});
 const restored=validate(clone(state));
 assert.deepEqual(fontStyle(restored.jobs[0].template.fields[0]),{fontFamily:'Courier New',size:15,bold:true,italic:true});
 assert.match(canvasFont(restored.jobs[0].template.fields[0]),/^italic bold 37.5px Courier New, monospace$/);
 assert.match(fontCss(restored.jobs[0].template.fields[0]),/font-style:italic/);
});
test('invalid imported fonts are rejected and renderer never injects unknown CSS families',()=>{
 const state=initial();state.templates[0].fields[0].fontFamily='Arial;position:fixed';
 assert.throws(()=>validate(state),/шрифт/);
 assert.equal(fontStyle(state.templates[0].fields[0]).fontFamily,'Arial');
 assert.throws(()=>applyTemplateFont(state.templates[0],{fontFamily:'Arial',size:NaN}),/размер/);
 assert.throws(()=>applyTemplateFont(state.templates[0],{fontFamily:'Arial',size:73}),/размер/);
});
