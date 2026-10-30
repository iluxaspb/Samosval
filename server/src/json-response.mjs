import {createHash} from 'node:crypto';
// Call only after endpoint authorization and data validation. Validators are
// scoped to the actual response bytes, including each user's permission filters.
export function sendJson(res,status,body) {
  const text=JSON.stringify(body),headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
  const req=res.req;
  if(status===200&&req?.method==='GET'&&String(req.url||'').startsWith('/api/v1/')){
    const tag='"'+createHash('sha256').update(text).digest('hex')+'"';headers.ETag=tag;
    if(req.headers['if-none-match']===tag){res.writeHead(304,headers);res.end();return;}
  }
  res.writeHead(status,headers);res.end(text);
}
