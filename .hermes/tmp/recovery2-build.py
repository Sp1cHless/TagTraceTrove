import json,re,ast,difflib,hashlib,sqlite3
from pathlib import Path
R=Path('D:/Project/TagTraceTrove'); T=R/'.hermes/tmp'; report={}; calls=json.loads((T/'recovery2-calls.json').read_text(encoding='utf8'))
s=(T/'offline-api-reconstructed.ts').read_text(encoding='utf8'); prefix=(T/'offline-api-truncated-preserved.ts').read_text(encoding='utf8')
assert len(s.splitlines())>4900 and len(prefix.splitlines())==1929
needle='\n'.join(prefix.splitlines()[-15:]);assert s.count(needle)==1
s=prefix.rstrip()+'\n'+s.split(needle)[1].lstrip('\n')
# Current prefix already uses the actual logged request-union rewrite; apply same logged transform to suffix.
s=s.replace('SyncReplayOperation','SyncReplayRequest').replace('return syncReplayOperationSchema.parse(wireFields(operation));','return syncReplayRequestSchema.parse(wireFields(operation));')
report['prefix']={'lines':1929,'sha256':hashlib.sha256(prefix.encode()).hexdigest(),'anchor':needle}
# Read snapshots captured immediately before incident worker changes.
C=json.loads((T/'recovery-candidates.json').read_text(encoding='utf8')); numbered={}
for id,sid,start,end,text in C:
 if id in [130128,130130,130132]:
  for n,line in re.findall(r'^(\d+)\|(.*)$',text,re.M):numbered[int(n)]=line.rstrip('\r')
facade='\n'.join(numbered[i] for i in range(4077,4214));assert facade.startswith('  const facade: GalleryApi = {')
a=s.index('  const facade: GalleryApi = {');b=s.index('    preferOfflineSnapshot,',a)
s=s[:a]+facade+'\n'+s[b:]
report['facade_snapshot']={'messages':[130128,130130],'original_range':[4077,4213]}
# The original genuine patch script records successful cache-retention mutations; apply AST literals only.
code=next(x['args']['code'] for x in calls if x['id']==130141)
changes=[];fail=[]
for node in ast.walk(ast.parse(code)):
 if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id=='patch':
  try:old=ast.literal_eval(node.args[1]);new=ast.literal_eval(node.args[2]);all_=ast.literal_eval(node.args[3]) if len(node.args)>3 else False
  except:continue
  if new and new in s:pass
  elif old in s:s=s.replace(old,new,-1 if all_ else 1);changes.append(old[:70])
  else:fail.append(old[:100])
report['projection_mutations']={'applied':changes,'unmatched':fail}
# Recover Gallery enqueue and override from genuine successful AST literals, no new logic.
code=next(x['args']['code'] for x in calls if x['id']==129808)
for node in ast.walk(ast.parse(code)):
 if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id=='p' and len(node.args)==3:
  try:path,old,new=map(ast.literal_eval,node.args)
  except:continue
  if not path.endswith('/offline-api.ts'):continue
  if old == '    async createCollection(input) {' and '    async setGalleryOrder(orderedTypes) {' in s:continue
  old=old.replace('SyncReplayOperation','SyncReplayRequest');new=new.replace('SyncReplayOperation','SyncReplayRequest')
  if new and new in s:continue
  if old in s:s=s.replace(old,new,1)
  else:fail.append(['gallery',old[:100]])
# Apply genuine final Gallery fixes, skip explicitly failed first delete.
code=next(x['args']['code'] for x in calls if x['id']==130048)
nodes=[node for node in ast.walk(ast.parse(code)) if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id=='patch']
for node in nodes[1:]:
 old=ast.literal_eval(node.args[1]);new=ast.literal_eval(node.args[2]);
 if old in s:s=s.replace(old,new,1)
 elif new in s:pass
 else:fail.append(['gallery-final',old[:100]])
# Successful parent Gallery capability patch may remove duplicate inside options.state.
for x in calls:
 if x['name']=='patch' and x['id']==130076:
  a=x['args'];old=a['old_string'];new=a['new_string']
  if old in s:s=s.replace(old,new,1)
  elif new and new in s:pass
  else:fail.append(['parent-gallery',old[:100]])
assert s.startswith(prefix.splitlines()[0]) and len(s.splitlines())>5000
(T/'recovery2-candidate.ts').write_text(s,encoding='utf8')
report['candidate']={'lines':len(s.splitlines()),'sha256':hashlib.sha256(s.encode()).hexdigest(),'path':str(T/'recovery2-candidate.ts'),'failures':fail}
(T/'recovery2-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(report,ensure_ascii=False,indent=2))
