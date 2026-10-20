#!/usr/bin/env python3
import base64,json,mimetypes,pathlib,uuid,os,re
from http.server import BaseHTTPRequestHandler,HTTPServer
from desktop import act,screenshot
from control import command
ROOT=pathlib.Path('/home/dant/work')

def load_protocol():
    home = pathlib.Path(__file__).resolve().parents[1]
    # Source checkout and the installed ~/dant/vm helper use the same manifest.
    candidates = (home/'resources/config/protocol.json', home/'app/resources/config/protocol.json')
    for candidate in candidates:
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding='utf-8'))
    raise RuntimeError('The desktop bridge protocol configuration is missing')

PROTOCOL=load_protocol()
PATHS=PROTOCOL['paths']

def guest_bind(environment=None):
    environment = os.environ if environment is None else environment
    host = environment.get('DANT_GUEST_HOST',PROTOCOL['loopbackHost'])
    if host == '':
        host = PROTOCOL['loopbackHost']
    if not isinstance(host,str) or host not in PROTOCOL['loopbackHosts']:
        raise ValueError('DANT_GUEST_HOST must be 127.0.0.1 or localhost')
    raw_port = environment.get('DANT_GUEST_PORT',str(PROTOCOL['guestPort']))
    if raw_port == '':
        raw_port = str(PROTOCOL['guestPort'])
    if not isinstance(raw_port,str) or re.fullmatch(r'[1-9][0-9]{0,4}',raw_port) is None or not 1 <= int(raw_port) <= 65535:
        raise ValueError('DANT_GUEST_PORT must be an integer from 1 to 65535')
    return host,int(raw_port)

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def send(self,data,kind='application/json',status=200):
        raw=json.dumps(data).encode() if kind=='application/json' else data
        try:
            self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
        except (BrokenPipeError,ConnectionResetError):
            # A cancelled screen request must not trigger another reply to the
            # same closed socket or an HTTP-server traceback.
            self.close_connection=True
    def do_GET(self):
        try:
            if self.path==PATHS['screen']: self.send(screenshot(),'image/png')
            elif self.path==PATHS['health']:self.send({'ok':True})
            else:self.send({'error':'Not found'},status=404)
        except Exception as e:self.send({'error':str(e)},status=500)
    def do_POST(self):
        try:
            length=int(self.headers.get('Content-Length',0))
            if length>36*1024*1024:raise ValueError('Too large')
            body=json.loads(self.rfile.read(length))
            if self.path==PATHS['input']:
                if not isinstance(body.get('sessionId'),str):raise ValueError('A confirmed desktop session is required')
                result=act(body,body['sessionId']);result.update(command({'action':'status'}));self.send(result)
            elif self.path==PATHS['control']:self.send(command(body))
            elif self.path==PATHS['file']:
                folder=ROOT/'uploads';folder.mkdir(exist_ok=True)
                name=pathlib.Path(body['name'].replace('\\','/')).name
                target=folder/(str(uuid.uuid4())+'-'+name);target.write_bytes(base64.b64decode(body['data'],validate=True));self.send({'path':str(target)})
            elif self.path==PATHS['readFile']:
                target=pathlib.Path(body['path']).resolve()
                if not target.is_relative_to(ROOT):raise ValueError('Only work directory artifacts may be shared')
                if target.stat().st_size>25*1024*1024:raise ValueError('File exceeds 25 MB')
                data=target.read_bytes();self.send({'data':base64.b64encode(data).decode(),'name':target.name,'type':mimetypes.guess_type(target)[0] or 'application/octet-stream','size':len(data)})
            else:self.send({'error':'Not found'},status=404)
        except Exception as e:self.send({'error':str(e)},status=400)
def main():
    bind=guest_bind()
    ROOT.mkdir(parents=True,exist_ok=True)
    HTTPServer(bind,Handler).serve_forever()

if __name__=='__main__':main()
