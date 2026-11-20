// QA-only DOM correlation; unrelated shell dialogs are not phone forms.
export function installPhoneFormQA(){
 let before,truckId,pinned;
 const forms=()=>[...document.querySelectorAll('dialog')].filter(d=>d.isConnected&&d.querySelector('form input[name=phone]'));
 window.qaPhoneForm={
  begin(id){
   if(pinned?.isConnected||forms().length)throw Error('previous phone form not removed');
   before=new Set(document.querySelectorAll('dialog'));truckId=id;pinned=null;
  },
  pin(id){
   const candidates=forms();
   if(!before||id!==truckId||candidates.length!==1||!candidates[0].open||before.has(candidates[0]))throw Error('ambiguous or stale phone form');
   pinned=candidates[0];window.qaPhoneDialog=pinned;window.qaPhoneTruckId=id;
  },
  current(){
   const candidates=forms();
   if(!pinned?.isConnected||!pinned.open||candidates.length!==1||candidates[0]!==pinned||window.qaPhoneDialog!==pinned||window.qaPhoneTruckId!==truckId)throw Error('stale QA phone form');
   return pinned;
  }
 };
}

// QA-only observation: never retain credentials, headers, raw bodies or phone numbers.
export function installPhoneEvidence(){
 const original=window.fetch.bind(window);
 window.__qaPhoneHTTP=[];
 window.fetch=async(input,options)=>{
  const url=new URL(typeof input==='string'?input:input.url,location.href);
  if(url.origin!==location.origin||url.pathname!=='/api/v1/truck-phones')return original(input,options);
  const method=options?.method||(input instanceof Request?input.method:'GET');
  const record={sequence:__qaPhoneHTTP.length+1,method,status:null};
  if(method==='POST'){
   let body;try{body=JSON.parse(options?.body);}catch{}
   record.truckId=['synthetic_truck','synthetic_empty','synthetic_delete'].includes(body?.truckId)?body.truckId:'unrecognized';
   record.expectedPhone=body?.phone?.replace(/[ ()-]/g,'')==='+12025550100';
  }
  __qaPhoneHTTP.push(record);
  try{
   const response=await original(input,options);record.status=response.status;
   // Observe a clone without delaying delivery to the application.
   void response.clone().json().then(data=>{
    record.ubuntu=data?.source==='ubuntu';record.validPhones=Array.isArray(data?.phones);
    record.expectedRows=Array.isArray(data?.phones)?data.phones.filter(r=>r.truckId==='synthetic_truck'&&r.phone==='+12025550100').length:0;
   },()=>{record.invalidJSON=true;});
   return response;
  }catch(error){record.transportFailure=true;throw error;}
 };
}
