#!/usr/bin/env python3
"""Local TLS frontend: API proxy only to loopback in the isolated namespace."""
import http.server,http.client,ssl,sys,pathlib,os
root=pathlib.Path(sys.argv[1]).resolve();os.chdir(root)
class Handler(http.server.SimpleHTTPRequestHandler):
 def proxy(self):
  c=http.client.HTTPConnection('127.0.0.1',18099,timeout=20)
  body=self.rfile.read(int(self.headers.get('Content-Length','0')))
  c.request(self.command,self.path,body,dict(self.headers));r=c.getresponse()
  self.send_response(r.status)
  for k,v in r.getheaders():
   if k.lower() not in ('transfer-encoding','connection','content-length'):self.send_header(k,v)
  data=r.read();self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data);c.close()
 def do_GET(self):
  if self.path.startswith(('/api/','/health/')):return self.proxy()
  return super().do_GET()
 def do_POST(self):return self.proxy()
 def do_OPTIONS(self):return self.proxy()
s=http.server.ThreadingHTTPServer(('127.0.0.1',18499),Handler)
ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(sys.argv[2],sys.argv[3]);s.socket=ctx.wrap_socket(s.socket,server_side=True);s.serve_forever()
