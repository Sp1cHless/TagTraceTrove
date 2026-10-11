import sqlite3,json,types,sys,traceback
from pathlib import Path as RealPath
root=RealPath('D:/Project/TagTraceTrove')
target=root/'apps/web/src/offline/offline-api.ts'
source=(root/'.hermes/tmp/offline-api-recovery-baseline.ts').read_text()
fail=[];changes=[];current_id=0
class P:
 def __init__(self,p):self.p=RealPath(p.p if isinstance(p,P) else p)
 def __truediv__(self,x):return P(self.p/x)
 def __str__(self):return str(self.p)
 def read_text(self,*a,**kw):return source if self.p.resolve()==target.resolve() else self.p.read_text(*a,**kw)
 def write_text(self,s,*a,**kw):
  global source
  if self.p.resolve()==target.resolve():source=s
  return len(s)
 def write_bytes(self,*a,**kw):return 0
 def mkdir(self,*a,**kw):return None
 def glob(self,s):return [P(x) for x in self.p.glob(s)]
 def rglob(self,s):return [P(x) for x in self.p.rglob(s)]
 @property
 def name(self):return self.p.name
 @property
 def parent(self):return P(self.p.parent)
 def __getattr__(self,x):
  if x in ['unlink','rename','replace','open','touch']:raise RuntimeError('forbidden')
  return getattr(self.p,x)
def patch(path,old_string,new_string,replace_all=False,**kw):
 global source
 if RealPath(str(path)).resolve()!=target.resolve():return {'success':True,'diff':''}
 old=old_string.replace('\r\n','\n');new=new_string.replace('\r\n','\n')
 if source.count(old)==1 or (replace_all and old in source):source=source.replace(old,new,-1 if replace_all else 1);changes.append(current_id);return {'success':True,'diff':''}
 if new and new in source:return {'success':True,'diff':''}
 fail.append((current_id,'patch',source.count(old),old[:160]));return {'success':False,'diff':''}
def write_file(path,content,*a,**kw):
 P(path).write_text(content);return {'success':True,'verified':True}
def read_file(path,offset=1,limit=2000):
 s=P(path).read_text().splitlines();return {'content':'\n'.join(f'{i+1}|{line}' for i,line in enumerate(s) if offset-1<=i<offset-1+limit),'total_lines':len(s)}
def terminal(*a,**kw):return {'output':'','exit_code':0}
def search_files(*a,**kw):return {'matches':[]}
mod=types.ModuleType('hermes_tools')
for k,v in list(globals().items()):
 if k in ['patch','write_file','read_file','terminal','search_files']:setattr(mod,k,v)
sys.modules['hermes_tools']=mod
pathmod=types.ModuleType('pathlib');pathmod.Path=P;sys.modules['pathlib']=pathmod
db=sqlite3.connect('file:C:/Users/hzy/AppData/Local/hermes/state.db?mode=ro',uri=True)
seen=set()
for current_id,tc in db.execute('select id,tool_calls from messages where role="assistant" and timestamp>=1791093480 and id<130141 order by id'):
 try:items=json.loads(tc or '[]')
 except:continue
 for item in items:
  if item['id'] in seen:continue
  seen.add(item['id'])
  try:a=json.loads(item['function']['arguments'])
  except:continue
  name=item['function']['name']
  if name=='patch' and str(a.get('path','')).endswith('offline-api.ts') and a.get('mode','replace')=='replace':patch(a['path'],a['old_string'],a['new_string'],a.get('replace_all',False))
  if name=='execute_code' and 'offline-api.ts' in a.get('code','') and any(x in a['code'] for x in ['patch(','write_text','write_file']):
   # Recovery is in-memory. All writes to every other file are inert.
   try:exec(a['code'],{'__builtins__':__builtins__,'print':lambda *a,**kw:None})
   except Exception as e:fail.append((current_id,'exec',str(e)))
(root/'.hermes/tmp/offline-api-reconstructed.ts').write_text(source)
(root/'.hermes/tmp/offline-api-recovery-errors.json').write_text(json.dumps(fail,indent=2))
print('changes',len(changes),'lines',len(source.splitlines()),'failures',fail)
