import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

const prelude = String.raw`
import importlib.util,io,json,math,os,pathlib,struct,sys,tempfile,types
spec=importlib.util.spec_from_file_location('asr', 'vm/transcribe_audio.py')
asr=importlib.util.module_from_spec(spec);spec.loader.exec_module(asr)
def failure(code, action):
 try: action()
 except asr.TranscriptionError as error: assert error.code == code, (error.code,code)
 else: raise AssertionError('Expected '+code)
def model_dir(root):
 # Runner temp paths can contain an alias; valid fixtures must satisfy the
 # production guard that rejects model directories reached through aliases.
 directory=pathlib.Path(root).resolve()/'model';directory.mkdir()
 for name in asr.MODEL_FILES: (directory/name).write_bytes(b'x')
 assert asr.local_model(directory)==directory
 return directory
class FakeArray(list):
 def copy(self): return FakeArray(self)
class FakeNP:
 float32='float32'
 @staticmethod
 def frombuffer(data,dtype,count): return FakeArray(struct.unpack('<'+'f'*count, data[:count*4]))
 @staticmethod
 def concatenate(chunks): return FakeArray(value for chunk in chunks for value in chunk)
 @staticmethod
 def isfinite(values): return types.SimpleNamespace(all=lambda:all(math.isfinite(value) for value in values))
 @staticmethod
 def max(values): return max(values)
 @staticmethod
 def abs(values): return [abs(value) for value in values]
class Frame:
 def __init__(self,values,samples=None):
  self.samples=len(values) if samples is None else samples
  self.planes=[struct.pack('<'+'f'*len(values),*values)]
class Streams(list):
 @property
 def audio(self):return [stream for stream in self if stream.type=='audio']
class FakeAV:
 def __init__(self,frames,format='ogg',streams=1,error=False,flush=None):
  self.frames=frames;self.options=None;self.closed=False;self.format=types.SimpleNamespace(name=format)
  self.streams=Streams([types.SimpleNamespace(type='audio')]*streams);self.error=error;self.flush=flush
 def open(self,source,**options):self.options=options;assert isinstance(source,io.BytesIO);return self
 def __enter__(self):return self
 def __exit__(self,*args):self.closed=True
 def decode(self,**options):
  assert options=={'audio':0}
  yield from self.frames
  if self.error:raise ValueError('private decoder details')
 def AudioResampler(self,**options):
  assert options=={'format':'fltp','layout':'mono','rate':16000}
  return types.SimpleNamespace(resample=lambda frame:([self.flush] if self.flush else []) if frame is None else [frame])
`;

function python(source, options={}) {
 const result=spawnSync(process.env.PYTHON||'python',['-c',prelude+'\n'+source],{cwd:process.cwd(),encoding:'utf8',shell:false,timeout:20000,...options});
 assert.ifError(result.error);
 return result;
}
function succeeds(source) {
 const result=python(source);
 assert.equal(result.status,0,result.stderr);
}

test('local ASR reads at most 10 MiB plus one byte and rejects missing or oversized data',()=>succeeds(String.raw`
class Counted(io.BytesIO):
 def read(self,count):assert count==asr.MAX_BYTES+1;return super().read(count)
assert asr.read_audio(Counted(b'a'))==b'a'
assert len(asr.read_audio(Counted(b'a'*asr.MAX_BYTES)))==asr.MAX_BYTES
failure('invalid_audio',lambda:asr.read_audio(Counted(b'')))
failure('invalid_audio',lambda:asr.read_audio(Counted(b'a'*(asr.MAX_BYTES+1))))
`));

test('local ASR decodes all frames and resampler tail to mono16k in memory',()=>succeeds(String.raw`
av=FakeAV([Frame([0.1,-0.2]),Frame([0.3])],flush=Frame([0.4]))
audio,duration=asr.decode_audio(b'ogg',av,FakeNP)
assert len(audio)==4 and abs(duration-4/16000)<1e-12
assert av.closed and av.options['options']['protocol_whitelist']=='pipe'
assert abs(audio[-1]-0.4)<0.0001
`));

test('local ASR rejects playlists, no audio, excessive streams, malformed frames and silence',()=>succeeds(String.raw`
for av,code in [(FakeAV([],format='hls'),'invalid_audio'),(FakeAV([],streams=0),'invalid_audio'),
                (FakeAV([],streams=9),'invalid_audio'),(FakeAV([Frame([0.2])],error=True),'invalid_audio'),
                (FakeAV([]),'no_speech'),(FakeAV([Frame([0.,0.])]),'no_speech'),
                (FakeAV([Frame([float('nan')])]),'invalid_audio')]:
 failure(code,lambda:asr.decode_audio(b'bytes',av,FakeNP))
 assert av.closed
failure('invalid_audio',lambda:asr.decode_audio(b'',FakeAV([]),FakeNP))
`));

test('local ASR rejects more than ten minutes without returning a truncated recording',()=>succeeds(String.raw`
av=FakeAV([Frame([0.1]),Frame([],samples=asr.MAX_SECONDS*asr.SAMPLE_RATE)])
failure('too_long',lambda:asr.decode_audio(b'bytes',av,FakeNP))
assert av.closed
av=FakeAV([Frame([0.1])],flush=Frame([],samples=asr.MAX_SECONDS*asr.SAMPLE_RATE))
failure('too_long',lambda:asr.decode_audio(b'bytes',av,FakeNP))
`));

test('local ASR recognizes English and Chinese with the local CPU int8 model and no downloads',()=>succeeds(String.raw`
with tempfile.TemporaryDirectory() as temporary:
 directory=model_dir(temporary)
 for language,parts in [('en',['hello','world']),('zh',['你好','世界'])]:
  called=[]
  class Model:
   def __init__(self,path,**options):
    assert path==str(directory)
    assert options==dict(device='cpu',compute_type='int8',cpu_threads=2,num_workers=1,local_files_only=True)
    called.append('model')
   def transcribe(self,audio,**options):
    assert audio=='decoded' and options['language'] is None and options['task']=='transcribe'
    assert options['vad_filter'] is True and options['condition_on_previous_text'] is False
    return [types.SimpleNamespace(text=' '+part+' ') for part in parts],types.SimpleNamespace(language=language)
  result=asr.transcribe(b'bytes',directory,decoder=lambda data:('decoded',3.25),model_factory=Model)
  assert result==dict(text=' '.join(parts),language=language,duration=3.25) and called==['model']
`));

test('local ASR finishes validation and decoding before allocating model memory',()=>succeeds(String.raw`
def never(*args,**kwargs):raise AssertionError('Model must not be loaded')
with tempfile.TemporaryDirectory() as temporary:
 directory=model_dir(temporary)
 def reject(data):raise asr.TranscriptionError('invalid_audio')
 failure('invalid_audio',lambda:asr.transcribe(b'bytes',directory,decoder=reject,model_factory=never))
 failure('too_long',lambda:asr.transcribe(b'bytes',directory,decoder=lambda data:('audio',601),model_factory=never))
 for duration in [0,float('nan'),float('inf')]:
  failure('invalid_audio',lambda:asr.transcribe(b'bytes',directory,decoder=lambda data:('audio',duration),model_factory=never))
 (directory/'tokenizer.json').unlink()
 failure('unavailable',lambda:asr.transcribe(b'bytes',directory,decoder=lambda data:('audio',1),model_factory=never))
 failure('unavailable',lambda:asr.local_model(pathlib.Path(temporary)/'missing'))
`));

test('local ASR rejects empty, oversized or invalid model outputs instead of partial text',()=>succeeds(String.raw`
with tempfile.TemporaryDirectory() as temporary:
 directory=model_dir(temporary)
 for texts,language,code in [(['  '],'en','no_speech'),(['x'*(asr.MAX_TEXT+1)],'en','failed'),
                            (['中'*45000],'zh','failed'),(['okay'],'invalid-language','failed')]:
  class Model:
   def __init__(self,*args,**options):pass
   def transcribe(self,*args,**options):return [types.SimpleNamespace(text=text) for text in texts],types.SimpleNamespace(language=language)
  failure(code,lambda:asr.transcribe(b'bytes',directory,decoder=lambda data:('audio',1),model_factory=Model))
 class Broken:
  def __init__(self,*args,**options):raise RuntimeError('private exception contents')
 failure('failed',lambda:asr.transcribe(b'bytes',directory,decoder=lambda data:('audio',1),model_factory=Broken))
`));

test('ASR CLI emits only JSON and suppresses native stdout, stderr and private exception text',()=>{
 const success=python(String.raw`
asr.resource_limits=lambda:None
def recognize(*args):
 os.write(1,b'private native stdout');os.write(2,b'private native stderr')
 return dict(text='你好 hello',language='zh',duration=2)
asr.transcribe=recognize
sys.stdin=io.TextIOWrapper(io.BytesIO(b'bytes'));sys.argv=['asr','--model-dir','unused']
sys.exit(asr.main())
`);
 assert.equal(success.status,0,success.stderr);assert.deepEqual(JSON.parse(success.stdout),{text:'你好 hello',language:'zh',duration:2});assert.equal(success.stderr,'');
 const failure=python(String.raw`
asr.resource_limits=lambda:None
def recognize(*args):
 os.write(1,b'private native stdout');os.write(2,b'private native stderr')
 print('private buffered stdout',end='');print('private buffered stderr',end='',file=sys.stderr)
 raise RuntimeError('secret transcript or filename')
asr.transcribe=recognize
sys.stdin=io.TextIOWrapper(io.BytesIO(b'bytes'));sys.argv=['asr','--model-dir','unused']
sys.exit(asr.main())
`);
 assert.equal(failure.status,1);assert.equal(failure.stdout,'');assert.deepEqual(JSON.parse(failure.stderr),{error:'failed'});
});

test('ASR dependency lock pins every wheel and installer verifies exact model hashes before replacement',()=>{
 const lock=fs.readFileSync('vm/transcription-requirements.txt','utf8'),lines=lock.split(/\r?\n/).filter(line=>line&&!line.startsWith('#'));
 assert.ok(lines.length>=7);for(const line of lines)assert.match(line,/^[\w-]+==[\d.]+ --hash=sha256:[0-9a-f]{64}$/);
 assert.ok(lines.some(line=>line.startsWith('faster-whisper==1.2.1 ')));
 const script=fs.readFileSync('vm/install-transcription.sh','utf8');
 assert.match(script,/--require-hashes/);assert.match(script,/--only-binary=:all:/);assert.match(script,/536b0662742c02347bc0e980a01041f333bce120/);
 assert.match(script,/3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671/);
 assert.ok(script.indexOf('if not model_valid(model)')<script.indexOf('os.replace(root, backup)'));
 assert.match(script,/os\.replace\(backup, root\)/);assert.match(script,/os\.O_NOFOLLOW/);assert.match(script,/root\.exists\(\) or root\.is_symlink\(\)/);
 succeeds(String.raw`
import ast
source=pathlib.Path('vm/install-transcription.sh').read_text().split("<<'PY'\n",1)[1].rsplit('\nPY',1)[0]
ast.parse(source)
`);
});
