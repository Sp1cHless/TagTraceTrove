import sqlite3,json
from pathlib import Path
D=sqlite3.connect('file:C:/Users/hzy/AppData/Local/hermes/state.db?mode=ro',uri=True)
rows=D.execute('select id,role,content,tool_calls,tool_call_id,tool_name,timestamp from messages where timestamp>=1791093480 order by id').fetchall()
results={r[4]:r for r in rows if r[1]=='tool'}
out=[]; seen=set()
for id,role,c,tc,tid,name,ts in rows:
 if not tc:continue
 try:items=json.loads(tc)
 except:continue
 for item in items:
  if item.get('id') in seen:continue
  seen.add(item.get('id'))
  f=item.get('function',{});a=f.get('arguments','');n=f.get('name','')
  if 'offline-api.ts' not in a:continue
  if n not in ['execute_code','terminal','patch','write_file']:continue
  if id>130300:continue
  res=results.get(item.get('id'))
  out.append({'id':id,'name':n,'args':json.loads(a),'result_id':res[0] if res else None,'result':res[2] if res else None})
Path('D:/Project/TagTraceTrove/.hermes/tmp/recovery2-calls.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf8')
for x in out:
 a=x['args'];s=a.get('code',a.get('command',a.get('old_string','')))
 if x['name']=='write_file' or any(t in s for t in ['write_text','write_file(','patch(','str.replace','s.replace','text.replace']):
  print(x['id'],x['name'],x['result_id'],s[:160].replace('\n',' '))
