import json,re,difflib,hashlib
from pathlib import Path
R=Path('D:/Project/TagTraceTrove/.hermes/tmp');s=(R/'recovery2-candidate.ts').read_text(); C=json.loads((R/'recovery-candidates.json').read_text()); report=[]
# Fragment boundaries identified by multiple original lines, never numerical source offsets alone.
for id,sid,start,end,text in C:
 if id<129500 or id>130253:continue
 rows=[(int(n),line.rstrip('\r')) for n,line in re.findall(r'^(\d+)\|(.*)$',text,re.M)]
 runs=[]
 for n,line in rows:
  if not runs or n!=runs[-1][-1][0]+1:runs.append([])
  runs[-1].append((n,line))
 for run in runs:
  if len(run)<10 or run[-1][0]<=1929:continue
  ls=[l for n,l in run];ls=[l.replace('SyncReplayOperation','SyncReplayRequest').replace('return syncReplayOperationSchema.parse(wireFields(operation));','return syncReplayRequestSchema.parse(wireFields(operation));') for l in ls]
  # only matching boundaries wholly after preserved prefix
  best=None
  for k in [8,6,5,4,3]:
   left='\n'.join(ls[:k]);right='\n'.join(ls[-k:])
   if s.count(left)==1 and s.count(right)==1:
    a=s.index(left);b=s.index(right)+len(right)
    if a<b and s[:a].count('\n')>=1929 and b-a<max(len('\n'.join(ls))*3,10000):best=(a,b);break
  if best is None:
   report.append({'message':id,'range':[run[0][0],run[-1][0]],'status':'unanchored'});continue
  a,b=best; old=s[a:b]; new='\n'.join(ls)
  if old==new:report.append({'message':id,'range':[run[0][0],run[-1][0]],'status':'exact'});continue
  diff='\n'.join(difflib.unified_diff(old.splitlines(),new.splitlines(),lineterm=''))
  report.append({'message':id,'range':[run[0][0],run[-1][0]],'status':'recovered_snapshot','delta_lines':len(new.splitlines())-len(old.splitlines()),'diff':diff})
  s=s[:a]+new+s[b:]
# Reapply the logged successful Gallery patches AFTER older snapshots, so older reads cannot erase new logic.
import ast
calls=json.loads((R/'recovery2-calls.json').read_text())
for callid in [129808,130048]:
 code=next(x['args']['code'] for x in calls if x['id']==callid)
 nodes=[n for n in ast.walk(ast.parse(code)) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id==('p' if callid==129808 else 'patch')]
 for idx,n in enumerate(nodes):
  if callid==130048 and idx==0:continue # observed False: never replay failed deletion
  try:
   if callid==129808:
    path,old,new=map(ast.literal_eval,n.args)
    if not path.endswith('/offline-api.ts'):continue
   else:old=ast.literal_eval(n.args[1]);new=ast.literal_eval(n.args[2])
  except:continue
  if old == '    async createCollection(input) {' and '    async setGalleryOrder(orderedTypes) {' in s:continue
  old=old.replace('SyncReplayOperation','SyncReplayRequest');new=new.replace('SyncReplayOperation','SyncReplayRequest')
  if new and new in s:continue
  if old in s:s=s.replace(old,new,1)
# Remove optional-state duplicate using observed successful parent patch.
old=next(x['args']['old_string'] for x in calls if x['id']==130076)
if old in s:s=s.replace(old,'',1)
# apply successful post-snapshot projection literals to recovered facade only
import ast
calls=json.loads((R/'recovery2-calls.json').read_text())
code=next(x['args']['code'] for x in calls if x['id']==130141)
for node in ast.walk(ast.parse(code)):
 if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id=='patch':
  try:old=ast.literal_eval(node.args[1]);new=ast.literal_eval(node.args[2]);all_=ast.literal_eval(node.args[3]) if len(node.args)>3 else False
  except:continue
  if s.find(old)>=len((R/'offline-api-truncated-preserved.ts').read_text().rstrip()):s=s.replace(old,new,-1 if all_ else 1)
assert s.splitlines()[:1929]==(R/'offline-api-truncated-preserved.ts').read_text().splitlines()
(R/'recovery2-snapshot-candidate.ts').write_text(s,encoding='utf8')
(R/'recovery2-snapshot-evidence.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
print('lines',len(s.splitlines()),'sha256',hashlib.sha256(s.encode()).hexdigest())
print([(x['message'],x['range'],x['status'],x.get('delta_lines')) for x in report])
