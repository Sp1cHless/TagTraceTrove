from pathlib import Path
import hashlib,json,difflib
r=Path('D:/Project/TagTraceTrove');t=r/'.hermes/tmp/offline-parity-author';sha=lambda b:hashlib.sha256(b).hexdigest();watch=json.loads((t/'seed-closure-watch.json').read_text());changes={}
def guard():
 bad=[n for n,h in watch.items() if not (r/n).exists() or sha((r/n).read_bytes())!=h]
 assert not bad,('EXTERNAL DRIFT STOP',bad)
def edit(n,o,z):
 b=changes.get(n,(r/n).read_bytes());a=o.encode();v=z.encode()
 if b.count(a)!=1:a=o.replace('\n','\r\n').encode();v=z.replace('\n','\r\n').encode()
 assert b.count(a)==1,(n,o[:100],b.count(a));changes[n]=b.replace(a,v)
guard()
base='apps/server/tests/integration/'
for name,old in [('author-resource-sync','expect(capabilities.sqliteSchemaVersion).toBe(41);'),('backup-restore','expect(version.version).toBe(41);'),('offline-entry-tag-vocabulary','expect(applyAllMigrations(database).currentVersion).toBe(41);'),('tag-facet-library-lifecycle',"expect(restored.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get()).toBe(41);")]:edit(base+name+'.integration.test.ts',old,old.replace('41','42'))
p=base+'author-resource-sync.integration.test.ts';edit(p,'offlineAuthorDirectories: true,','offlineAuthorDirectories: true,\n      offlineStandaloneAuthorDirectorySeed: true,')
p=base+'migration-runner.integration.test.ts'
edit(p,"import { copyFileSync", "import { createHash } from 'node:crypto';\nimport { copyFileSync")
edit(p,'30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41], currentVersion: 41 });','30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42], currentVersion: 42 });')
edit(p,'{ applied: [], currentVersion: 41 }','{ applied: [], currentVersion: 42 }')
edit(p,"expect(database.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get()).toBe(41);", """expect(database.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get()).toBe(42);
      for (const row of database.prepare('SELECT name, checksum FROM schema_migrations').all() as Array<{name: string; checksum: string}>) {
        const sql = readFileSync(join(sourceMigrationsDirectory, row.name), 'utf8').replace(/\\r\\n?/gu, '\\n');
        expect(row.checksum).toBe(createHash('sha256').update(sql).digest('hex'));
      }""")
# One remaining complete upgrade list belongs to the populated v31 boundary.
edit(p,'40, 41], currentVersion: 41 });','40, 41, 42], currentVersion: 42 });')
p=base+'tag-facet-origin-convergence.integration.test.ts';edit(p,'40, 41], currentVersion: 41 });','40, 41, 42], currentVersion: 42 });')
p=base+'sync.integration.test.ts';edit(p,'expect(capabilities.sqliteSchemaVersion).toBe(41);','expect(capabilities.sqliteSchemaVersion).toBe(42);')
# Assert exact source of baseline shift, not an unexplained count change.
edit(p,"    'Endfield',\n  );\n}","""    'Endfield',
  );
  // Schema 42 journals the independent Directory-set INSERT before the Producer.
  expect(database.prepare(`SELECT seq, entity_kind AS kind, change_kind AS changeKind,
    resource_version AS version FROM sync_changes ORDER BY seq`).all()).toEqual([
    {seq: 1, kind: 'author_directory_set', changeKind: 'create', version: 1},
    {seq: 2, kind: 'producer', changeKind: 'create', version: 1},
    {seq: 3, kind: 'entry', changeKind: 'create', version: 1},
    {seq: 4, kind: 'entry', changeKind: 'update', version: 2},
    {seq: 5, kind: 'entry_content', changeKind: 'create', version: 1},
    {seq: 6, kind: 'entry', changeKind: 'update', version: 3},
  ]);
}""")
# Scope numerical sequence changes to the exact test, preserving Entry versions.
def block(title,end,transform):
 b=changes[p];s=b.decode();start=s.index("  it('"+title);stop=s.index("  it('"+end,start);old=s[start:stop];new=transform(old);edit(p,old,new)
block('replays one Entry patch idempotently and reports field conflicts','rolls back the Entry and journal when receipt persistence fails',lambda s:s.replace('serverSeq: 7,','serverSeq: 8,').replace('serverSeq: 6,','serverSeq: 7,').replace("FROM sync_changes').pluck().get()).toBe(6)","FROM sync_changes').pluck().get()).toBe(7)"))
for title,end in [('rolls back the Entry and journal when receipt persistence fails','rolls back rating, Entry revision, and journal when receipt persistence fails'),('rolls back usage and its journal change when receipt persistence fails','rolls back an offline create and its registry when receipt persistence fails'),('rolls back an offline create and its registry when receipt persistence fails','keeps receipts, journal and tombstones across a server restart')]:
 def transform(s):
  s=s.replace('    database.exec(`\n      CREATE TRIGGER',"    const beforeJournal = database.prepare('SELECT * FROM sync_changes ORDER BY seq').all();\n    const beforeSequence = database.prepare(\"SELECT seq FROM sqlite_sequence WHERE name='sync_changes'\").get();\n    database.exec(`\n      CREATE TRIGGER")
  return s.replace("    expect(database.prepare('SELECT COUNT(*) FROM sync_changes').pluck().get()).toBe(5);", "    expect(database.prepare('SELECT * FROM sync_changes ORDER BY seq').all()).toEqual(beforeJournal);\n    expect(database.prepare(\"SELECT seq FROM sqlite_sequence WHERE name='sync_changes'\").get()).toEqual(beforeSequence);")
 block(title,end,transform)
block('keeps receipts, journal and tombstones across a server restart','captures the snapshot atomically and bumps the seq monotonically',lambda s:s.replace('serverSeq: 6,','serverSeq: 7,').replace("FROM sync_changes').pluck().get()).toBe(7)","FROM sync_changes').pluck().get()).toBe(8)").replace('changeSeq: 7,','changeSeq: 8,'))
block('captures the snapshot atomically and bumps the seq monotonically','preserves offline browse ordering and taxonomy alias rows',lambda s:s.replace('third.header.changeSeq).toBe(6)','third.header.changeSeq).toBe(7)').replace('header.changeSeq).toBe(5)','header.changeSeq).toBe(6)'))
guard()
ledger={}
for n,b in changes.items():
 orig=(r/n).read_bytes();assert sha(orig)==watch[n];assert (t/'seed-closure-start'/n).read_bytes()==orig
 ledger[n]={'before':sha(orig),'after':sha(b)}
for n,b in changes.items():
 assert sha((r/n).read_bytes())==watch[n];(r/n).write_bytes(b);watch[n]=sha(b)
 diff=''.join(difflib.unified_diff((t/'seed-closure-start'/n).read_bytes().decode().splitlines(True),b.decode().splitlines(True),fromfile=n+' before',tofile=n+' after'));q=t/'seed-closure-diffs'/ (n+'.diff');q.parent.mkdir(parents=True,exist_ok=True);q.write_text(diff)
(t/'seed-closure-edit-ledger.json').write_text(json.dumps(ledger,indent=2));(t/'seed-closure-watch.json').write_text(json.dumps(watch,indent=2));print('patched',len(changes))
