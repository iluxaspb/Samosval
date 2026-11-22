// QA-only auth adapter: fixture deliberately starts at a restored epoch (>0).
// Real app auth omits epoch; do not alter or bypass the production guard.
export function installAuthFixtureTransport(){
 const original=window.fetch.bind(window);
 window.__qaAuthHTTP=[];
 // Literal protocol codes from index.mjs auth routes, identity-store/rules and
 // dataset-guard. Never log arbitrary server strings, even code-shaped ones.
 const codes=new Set(['dataset-restored-reload','identity-not-ready','identity-email-required','email-already-exists','invalid-request','invalid-credentials','invalid-password','invalid-nickname','account-disabled','pending-approval','origin-not-allowed','server-error','invalid-json','unsupported-media-type','invalid-session','invalid-session-id','invalid-reset-token','body-too-large','database-unavailable','unauthorized','forbidden']);
 window.fetch=async(input,options)=>{
  const url=new URL(typeof input==='string'?input:input.url,location.href);
  if(url.origin!==location.origin||!/^\/api\/v1\/auth\/[a-z-]+$/.test(url.pathname))return original(input,options);
  // Learn, do not hard-code or spoof, the current synthetic dataset epoch.
  const probe=await original('/health/live',{cache:'no-store'});
  const epoch=probe.headers.get('X-Samosval-Epoch');
  if(!probe.ok||!/^\d+$/.test(epoch||''))throw Error('QA auth epoch probe failed');
  const headers=new Headers(options?.headers||(input instanceof Request?input.headers:undefined));headers.set('X-Samosval-Epoch',epoch);
  const response=await original(input,{...options,headers});
  const diagnostic={route:url.pathname,status:response.status,epoch};
  if(!response.ok){let data;try{data=await response.clone().json();}catch{}diagnostic.code=codes.has(data?.error)?data.error:'unrecognized-error';}
  window.__qaAuthHTTP.push(diagnostic);
  console.info('QA auth HTTP '+JSON.stringify(diagnostic));
  return response;
 };
}
