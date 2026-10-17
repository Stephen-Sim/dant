#!/usr/bin/env python3
import base64,json,mimetypes,pathlib,uuid,os
from http.server import BaseHTTPRequestHandler,HTTPServer
from desktop import act,screenshot
from control import command
ROOT=pathlib.Path('/home/dant/work');ROOT.mkdir(parents=True,exist_ok=True)
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def send(self,data,kind='application/json',status=200):
        raw=json.dumps(data).encode() if kind=='application/json' else data
        self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    def do_GET(self):
        try:
            if self.path=='/screen': self.send(screenshot(),'image/png')
            elif self.path=='/health':self.send({'ok':True})
            else:self.send({'error':'Not found'},status=404)
        except Exception as e:self.send({'error':str(e)},status=500)
    def do_POST(self):
        try:
            length=int(self.headers.get('Content-Length',0))
            if length>36*1024*1024:raise ValueError('Too large')
            body=json.loads(self.rfile.read(length))
            if self.path=='/input':
                if not isinstance(body.get('sessionId'),str):raise ValueError('A confirmed desktop session is required')
                result=act(body,body['sessionId']);result.update(command({'action':'status'}));self.send(result)
            elif self.path=='/control':self.send(command(body))
            elif self.path=='/file':
                folder=ROOT/'uploads';folder.mkdir(exist_ok=True)
                name=pathlib.Path(body['name'].replace('\\','/')).name
                target=folder/(str(uuid.uuid4())+'-'+name);target.write_bytes(base64.b64decode(body['data'],validate=True));self.send({'path':str(target)})
            elif self.path=='/read-file':
                target=pathlib.Path(body['path']).resolve()
                if not target.is_relative_to(ROOT):raise ValueError('Only work directory artifacts may be shared')
                if target.stat().st_size>25*1024*1024:raise ValueError('File exceeds 25 MB')
                data=target.read_bytes();self.send({'data':base64.b64encode(data).decode(),'name':target.name,'type':mimetypes.guess_type(target)[0] or 'application/octet-stream','size':len(data)})
            else:self.send({'error':'Not found'},status=404)
        except Exception as e:self.send({'error':str(e)},status=400)
HTTPServer(('127.0.0.1',int(os.environ.get('DANT_GUEST_PORT','4319'))),Handler).serve_forever()
