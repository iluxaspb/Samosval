import {fail,map} from './tabel-access.mjs';
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0&&value<Number.MAX_SAFE_INTEGER;
export const CONTROL_PERMISSIONS=Object.freeze({'truck.create':'manage_trucks','truck.update':'manage_trucks','truck.delete':'manage_trucks','object.create':'manage_objects','object.update':'manage_objects','object.delete':'manage_objects','line.add':'edit_line','line.remove':'edit_line','shift.object':'edit_line'});
export function normalizeControl(input){
  if(!map(input)||!id(input.id)||!Object.hasOwn(CONTROL_PERMISSIONS,input.type))throw fail('invalid-control-operation');
  const op={id:input.id,type:input.type};
  if(input.type.startsWith('truck.')||input.type.startsWith('object.')){
    if(!id(input.recordId)||!integer(input.expectedRevision)||(input.type.endsWith('.create')?input.expectedRevision!==0:input.expectedRevision<1))throw fail('invalid-control-revision');
    Object.assign(op,{recordId:input.recordId,expectedRevision:input.expectedRevision});
    if(!input.type.endsWith('.delete')){
      if(!map(input.data))throw fail('invalid-control-data');
      if(input.type.startsWith('truck.')){
        const {brand,number,defaultVol,isGAI}=input.data;
        if(typeof brand!=='string'||!brand.trim()||brand.length>150||typeof number!=='string'||!number.trim()||number.length>80||typeof isGAI!=='boolean'||!Number.isFinite(defaultVol)||defaultVol<0||defaultVol>1000)throw fail('invalid-truck');
        op.data={brand:brand.trim(),number:number.trim(),defaultVol:isGAI?0:defaultVol,isGAI};
      }else{
        if(typeof input.data.name!=='string'||!input.data.name.trim()||input.data.name.length>500)throw fail('invalid-object');
        op.data={name:input.data.name.trim()};
        if(input.data.startDate!==undefined){
          const date=input.data.startDate;
          if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw fail('invalid-object-start-date');
          op.data.startDate=date;
        }
      }
    }
  }else{
    if(!id(input.shiftId))throw fail('invalid-shift-id');op.shiftId=input.shiftId;
    if(input.type==='shift.object'){
      if(!id(input.objectId)||!(input.expectedObjectId===''||id(input.expectedObjectId)))throw fail('invalid-object');
      Object.assign(op,{objectId:input.objectId,expectedObjectId:input.expectedObjectId});
    }else{
      if(!id(input.truckId)||!integer(input.expectedRevision)||!integer(input.expectedTtnRevision))throw fail('invalid-line-intent');
      Object.assign(op,{truckId:input.truckId,expectedRevision:input.expectedRevision,expectedTtnRevision:input.expectedTtnRevision});
    }
  }
  return op;
}
export function membershipStatus(op,before,actor,now=Date.now()){
  if(before&&before.shiftId!==op.shiftId)throw fail('status-shift-mismatch',409);
  if(Number(before?.cycleRevision||0)!==op.expectedRevision||Number(before?.ttnRevision||0)!==op.expectedTtnRevision)throw fail('line-intent-changed',409);
  const adding=op.type==='line.add';
  if(!!before?.onLine===adding)throw fail(adding?'already-on-line':'not-on-line',409);
  return {...(before||{}),id:op.truckId,shiftId:op.shiftId,onLine:adding,
    arriveStatus:null,arriveTimestamp:null,arriveBy:null,loadedAfterArrive:false,
    cycleRevision:op.expectedRevision+1,ttnRevision:op.expectedTtnRevision+1,
    ...(adding?{addedAt:now,addedBy:actor}:{removedAt:now,removedBy:actor})};
}
