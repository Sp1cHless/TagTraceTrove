import sqlite3,json,ast,re
from pathlib import Path
DB=sqlite3.connect('file:C:/Users/hzy/AppData/Local/hermes/state.db?mode=ro',uri=True)
source=Path('.hermes/tmp/offline-api-recovery-baseline.ts').read_text()
seen=set();applied=[];failed=[]
for id,tid,name,text,ts in DB.execute('select id,tool_call_id,tool_name,content,timestamp from messages where role="tool" and timestamp>=1791093480 and id<130141 order by id'):
 if tid in seen:continue
 seen.add(tid)
 try:o=json.loads(text)
 except:continue
 outputs=[]
 if name=='patch':outputs=[o]
 if name=='execute_code':
  for line in o.get('output','').splitlines():
   start=line.find("{'success':")
   if start>=0:
    try:outputs.append(ast.literal_eval(line[start:]))
    except:pass
 for output in outputs:
  diff=output.get('diff','')
  if not output.get('success') or not diff or 'offline-api.ts' not in diff:continue
  if not diff.splitlines()[0].endswith('offline-api.ts'):continue
  ok=True
  for hunk in re.split(r'^@@[^\n]*\n',diff,flags=re.M)[1:]:
   old=[];new=[]
   for line in hunk.splitlines():
    if line.startswith(' '):old.append(line[1:]);new.append(line[1:])
    elif line.startswith('-'):old.append(line[1:])
    elif line.startswith('+'):new.append(line[1:])
   old='\n'.join(old);new='\n'.join(new)
   if source.count(old)==1:source=source.replace(old,new,1)
   elif new in source:pass
   else:failed.append((id,old[:150],source.count(old)));ok=False
  if ok:applied.append(id)
Path('.hermes/tmp/offline-api-reconstructed.ts').write_text(source)
print('applied',applied,'failed',failed,'lines',len(source.splitlines()))
