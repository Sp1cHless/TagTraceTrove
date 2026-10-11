import sqlite3,json,re
from pathlib import Path
db=sqlite3.connect('file:C:/Users/hzy/AppData/Local/hermes/state.db?mode=ro',uri=True)
rows=db.execute("select id,session_id,role,content,tool_calls,tool_call_id,tool_name from messages order by id").fetchall()
calls={}; candidates=[]
for id,sid,role,c,tc,tid,name in rows:
 if tc:
  try:
   for item in json.loads(tc):
    f=item.get('function',{});a=json.loads(f.get('arguments','{}'));calls[item.get('id')]=(f.get('name'),a,id)
  except:pass
 if role!='tool' or not c:continue
 call=calls.get(tid)
 if call and call[0]=='read_file' and 'offline-api.ts' in str(call[1].get('path','')):
  try:o=json.loads(c);text=o.get('content','')
  except:text=c
  numbered=re.findall(r'^(\d+)\|(.*)$',text,re.M)
  if numbered:candidates.append((id,sid,int(numbered[0][0]),int(numbered[-1][0]),text))
 if name=='execute_code' and 'offline-api.ts' in c:
  try:o=json.loads(c);text=o.get('output','')
  except:text=c
  for seg in re.split(r'(?:^|\n)(?:[\w:/\\. -]*?offline-api\.ts)\s*',text)[1:]:
   seg=re.split(r'\n(?:apps/|packages/|D:/Project/)',seg)[0]
   numbered=re.findall(r'^(\d+)\|(.*)$',seg,re.M)
   if numbered:candidates.append((id,sid,int(numbered[0][0]),int(numbered[-1][0]),seg))
print('CANDIDATES',len(candidates))
for id,sid,start,end,text in candidates[-100:]:print(id,sid,start,end)
Path('D:/Project/TagTraceTrove/.hermes/tmp/recovery-candidates.json').write_text(json.dumps(candidates),encoding='utf-8')
