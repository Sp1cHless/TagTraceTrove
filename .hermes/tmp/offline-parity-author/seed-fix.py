from pathlib import Path
import hashlib,json
r=Path('.');backup=r/'.hermes/tmp/offline-parity-author/seed-fix-before';backup.mkdir(exist_ok=True); work={}
def edit(p,o,n):
 path=r/p;b=work.get(p,(None,path.read_bytes()))[1];a=o.encode();z=n.encode()
 if b.count(a)!=1:a=o.replace('\n','\r\n').encode();z=n.replace('\n','\r\n').encode()
 assert b.count(a)==1,(p,o[:90]);work[p]=(work[p][0] if p in work else path.read_bytes(),b.replace(a,z))
p='apps/web/tests/offline-author-parity.integration.test.ts'
edit(p,'const receipt=await f.online.replaySyncOperation(collision as typeof body);','f.connect();const receipt=await f.online.replaySyncOperation!(collision as typeof body);f.disconnect();')
edit(p,'f.online.replaySyncOperation(op as never)','f.online.replaySyncOperation!(op as never)')
p='apps/server/src/database/doctor.ts'
edit(p,'  return { ok: issues.length === 0, issues };',"""  if (currentSchemaVersion >= 42) {
    if (!producerColumns.has('directory_set_seed_uid')) issues.push('missing required column: producers.directory_set_seed_uid');
    for (const trigger of ['producers_directory_seed_immutable','author_directory_sets_sync_insert']) if (!syncTriggers.has(trigger)) issues.push(`missing required trigger: ${trigger}`);
    if (producerColumns.has('directory_set_seed_uid') && database.prepare(`SELECT 1 FROM producers p LEFT JOIN author_directory_sets s ON s.producer_id=p.id WHERE p.directory_set_seed_uid IS NOT NULL AND (s.sync_uid IS NULL OR s.sync_uid<>p.directory_set_seed_uid COLLATE NOCASE) LIMIT 1`).get()) issues.push('Directory seed binding mismatch');
  }
  return { ok: issues.length === 0, issues };""")
p='apps/server/src/database/probe.ts'
edit(p,"  check('database doctor clean', () => inspectDatabase(database).ok);", """  check('standalone Author independent Directory seed insert and immutable binding', () => {
    const seed='aaaaaaa1-1111-4111-8111-111111111111';
    const id=Number(database.prepare('INSERT INTO producers (name,directory_set_seed_uid) VALUES (?,?)').run('Directory seed probe',seed).lastInsertRowid);
    const set=database.prepare('SELECT sync_uid AS uid,sync_version AS version FROM author_directory_sets WHERE producer_id=?').get(id) as {uid:string;version:number};
    let immutable=false;try {database.prepare('UPDATE producers SET directory_set_seed_uid=NULL WHERE id=?').run(id);}catch {immutable=true;}
    return set.uid===seed && set.version===1 && immutable && buildSyncCapabilities(database).featureFlags.offlineStandaloneAuthorDirectorySeed===true && inspectDatabase(database).ok;
  });
  check('database doctor clean', () => inspectDatabase(database).ok);""")
p='apps/web/src/offline/pending-work-restore.ts'
edit(p,'  const media: StagedMediaUpload[] = [];\n  const liveUploads',"""  const seededScopes=new Map<string,string>();
  for (const row of union) if (row.operationKind==='producer.create' && typeof row.payload.directorySetUid==='string') {
    const scope=uid(row.payload.directorySetUid);const producer=uid(row.entityUid);
    if (scope===producer || seededScopes.has(scope) && seededScopes.get(scope)!==producer) throw new Error('Directory seed identity collision');
    const known=payload.authorDirectorySets?.find(set=>uid(set.syncUid)===scope);
    const owner=payload.producers.find(owner=>owner.id===known?.producerId);
    if (known && owner?.syncUid?.toLowerCase()!==producer) throw new Error('Directory seed belongs to a foreign Producer');
    seededScopes.set(scope,producer);
  }
  const media: StagedMediaUpload[] = [];\n  const liveUploads""")
# Add seeded variant separately: original all-kind legacy fixture stays byte compatible.
p='apps/web/tests/fixtures/native-valid-kind-fixture.ts'
edit(p,'export function validKindRows',"export const seededAuthorVariant: Shape = {...shapes['producer.create']!,payload:{...shapes['producer.create']!.payload,directorySetUid:second}};\n\nexport function validKindRows")
for p,(b,n) in work.items():
 assert (r/p).read_bytes()==b;pback=backup/p;pback.parent.mkdir(parents=True,exist_ok=True);pback.write_bytes(b)
for p,(b,n) in work.items():(r/p).write_bytes(n)
print('applied fixes',len(work))
