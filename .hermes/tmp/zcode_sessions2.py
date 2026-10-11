import sqlite3, datetime

DB = r"C:\Users\hzy\.zcode\cli\db\db.sqlite"
con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
cur = con.cursor()

def ts(v):
    if v is None:
        return "-"
    try:
        n = float(v)
        if n > 1e11:
            n = n / 1000.0
        return datetime.datetime.utcfromtimestamp(n).strftime("%m-%d %H:%M")
    except Exception:
        return str(v)[:16]

rows = cur.execute(
    "SELECT id, project_id, title, task_type, time_created, time_updated, time_archived, parent_id "
    "FROM session WHERE project_id LIKE 'tagtracetrove%' ORDER BY time_updated DESC LIMIT 25"
).fetchall()
print("project sessions (most recently updated first):")
for r in rows:
    print(f"{ts(r['time_updated'])}  upd | {ts(r['time_created'])} crt | arch={r['time_archived']} | {r['task_type']} | {r['id']} | {r['title']!r}")

print()
print("=== dwf_run detail ===")
for r in cur.execute("SELECT id,name,parent_session_id,cwd,status,failure_json,result_json,spent_tokens,time_created,time_updated FROM dwf_run ORDER BY time_created"):
    print(f"{ts(r['time_created'])} -> {ts(r['time_updated'])} | {r['status']:10} | {r['name']!r} | session={r['parent_session_id']} | tokens={r['spent_tokens']}")
    if r['failure_json']:
        print("    FAIL:", str(r['failure_json'])[:400])
    if r['result_json']:
        print("    RESULT bytes:", len(str(r['result_json'])))
