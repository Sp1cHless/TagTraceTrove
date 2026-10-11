import sqlite3, os, json

DB = r"C:\Users\hzy\.zcode\cli\db\db.sqlite"
con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
cur = con.cursor()

tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
print("TABLES:", tables)

for t in tables:
    try:
        cols = [r[1] for r in cur.execute(f"PRAGMA table_info({t})")]
    except Exception as e:
        print(t, "ERR", e)
        continue
    n = cur.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
    print(f"\n== {t} ({n} rows)")
    print("   cols:", cols)
