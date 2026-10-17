#!/usr/bin/env python3
"""VM-only desktop control. CLI used by dant and the local guest HTTP service."""
import argparse, os, json, subprocess, sys, time, tempfile
os.environ.setdefault('DISPLAY', ':0')
def run(*args, data=None):
    return subprocess.run(args, input=data, capture_output=True, check=True, timeout=10).stdout
def point(x,y):
    return str(max(0,min(int(x),4096))),str(max(0,min(int(y),4096)))
def button(value):
    return str({0:1,1:2,2:3}.get(int(value),1))
def act(action):
    kind=action.get('type')
    if kind=='click':
        run('xdotool','mousemove',*point(action['x'],action['y']))
        run('xdotool','click',button(action.get('button',0)))
    elif kind=='drag':
        start=point(action['startX'],action['startY'])
        end=point(action['endX'],action['endY'])
        mouse_button=button(action.get('button',0))
        run('xdotool','mousemove',*start)
        try:
            run('xdotool','mousedown',mouse_button)
            run('xdotool','mousemove','--sync',*end)
            time.sleep(0.1)
        finally:
            # Release even when movement fails, so takeover never leaves a
            # mouse button held down in the guest session.
            run('xdotool','mouseup',mouse_button)
    elif kind=='key':
        key=action['key']
        if not isinstance(key,str) or len(key)>80 or key.startswith('-'): raise ValueError('Invalid key')
        run('xdotool','key','--clearmodifiers',key)
    elif kind=='text':
        value=str(action['text'])
        if len(value)>100000: raise ValueError('Text too large')
        # xclip owns the selection until the application requests it.
        subprocess.run(['xclip','-selection','clipboard'],input=value.encode(),check=True,timeout=3)
        run('xdotool','key','--clearmodifiers','ctrl+v')
    elif kind=='scroll':
        run('xdotool','click','--repeat',str(min(12,max(1,abs(int(action['delta']))))),'4' if action['delta']<0 else '5')
    else: raise ValueError('Unsupported action')
    return {'ok':True}
def screenshot():
    # Xvfb builds may omit DPMS. Disabling a missing optional extension must
    # not prevent screenshots from being returned.
    for args in [('xset','s','off'),('xset','-dpms')]:
        subprocess.run(args,capture_output=True,timeout=10,check=False)
    with tempfile.TemporaryDirectory() as folder:
        target=folder+'/screen.png'
        run('scrot','-z',target)
        return open(target,'rb').read()
if __name__=='__main__':
    p=argparse.ArgumentParser(description='dant desktop: screenshot PATH | click X Y | drag X1 Y1 X2 Y2 | text TEXT | key ctrl+l | scroll N')
    p.add_argument('action',choices=['screenshot','click','drag','text','key','scroll']);p.add_argument('args',nargs='*');a=p.parse_args()
    if a.action=='screenshot':
        target=a.args[0] if a.args else '/home/dant/work/screen.png'
        open(target,'wb').write(screenshot());print(target)
    else:
        payload={'type':a.action}
        if a.action=='click':payload.update(x=int(a.args[0]),y=int(a.args[1]))
        elif a.action=='drag':payload.update(startX=int(a.args[0]),startY=int(a.args[1]),endX=int(a.args[2]),endY=int(a.args[3]))
        elif a.action=='scroll':payload['delta']=int(a.args[0])
        else:payload[a.action]=' '.join(a.args)
        print(json.dumps(act(payload)))
