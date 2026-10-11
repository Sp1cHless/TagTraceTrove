import {copyFileSync,mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';import {createMemoryDatabase} from '../../src/database/testing.js';
import {applyAllMigrations} from '../../src/database/migrations.js';import {inspectDatabase} from '../../src/database/doctor.js';
import {setGalleryPartition} from '../../src/repositories/partition-repository.js';
it('043 preserves journal tombstone high water triggers and diagnoses missing scope only at applied version',()=>{
 const db=createMemoryDatabase(),dir=mkdtempSync(join(tmpdir(),'t3-partition43-'));const source=fileURLToPath(new URL('../../src/database/migrations/',import.meta.url));
 try{
  for(const name of readdirSync(source).filter(name=>/^\d+_.+\.sql$/u.test(name)&&parseInt(name)<=42))copyFileSync(join(source,name),join(dir,name));
  applyAllMigrations(db,dir);expect(inspectDatabase(db).ok).toBe(true);
  db.prepare("INSERT INTO entries(title,type) VALUES('Legacy work','Comic')").run();
  const uid=db.prepare('SELECT sync_uid FROM entries').pluck().get();
  db.prepare("INSERT INTO sync_changes(seq,entity_kind,entity_uid,change_kind,resource_version) VALUES(10000,'entry',?,'delete',2)").run(uid);
  db.prepare("INSERT INTO sync_tombstones(entity_kind,entity_uid,deleted_version,change_seq) VALUES('entry',?,2,10000)").run(uid);
  const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
  const tombstones=db.prepare('SELECT * FROM sync_tombstones').all();
  expect(applyAllMigrations(db).applied).toEqual([43]);expect(db.prepare('SELECT * FROM sync_tombstones').all()).toEqual(tombstones);
  for(const trigger of triggers as Array<{name:string;sql:string}>)expect(db.prepare("SELECT sql FROM sqlite_master WHERE name=?").pluck().get(trigger.name)?.toString().replace(/\r\n?/gu,'\n')).toBe(trigger.sql.replace(/\r\n?/gu,'\n'));
  expect(db.prepare('SELECT count(*) FROM gallery_settings').pluck().get()).toBe(0);
  setGalleryPartition(db,'Comic',true);expect(db.prepare("SELECT seq FROM sync_changes WHERE entity_kind='gallery_partition'").pluck().get()).toBeGreaterThan(10000);
  expect(inspectDatabase(db).ok).toBe(true);db.exec('DROP TABLE gallery_partition_scopes');expect(inspectDatabase(db).issues).toContain('missing required table: gallery_partition_scopes');
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
