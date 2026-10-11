import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createFacet, createSection } from '../../src/repositories/layout-repository.js';
import { buildSyncCapabilities, buildSyncSnapshot } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';
import { createNodeSqliteMemoryDatabase } from './node-sqlite-adapter.js';

async function fixture() {
  const db = createNodeSqliteMemoryDatabase(); applyAllMigrations(db);
  const entry = createEntry(db, { title: 'Seed', type: 'comic' });
  const section = createSection(db, { entryType: 'comic', name: 'Tags' });
  const facet = createFacet(db, { sectionId: section.id, name: 'Theme' });
  const paths = ['../../../web/src/offline/offline-api.js', '../../../web/src/offline/indexeddb-snapshot-store.js', '../../../web/src/offline/snapshot-store.js', '../../../web/node_modules/fake-indexeddb/build/esm/index.js'];
  const [facade, indexed, snapshots, fake] = await Promise.all(paths.map(path => import(path)));
  const factory = new fake.IDBFactory(), databaseName = randomUUID();
  let store = indexed.createIndexedDbOfflineStore({ indexedDB: factory, databaseName });
  await store.writeGeneration(1, JSON.stringify(buildSyncSnapshot(db))); await store.writeMeta(snapshots.ACTIVE_GENERATION_KEY, '1');
  const sent: Array<{ opId: string; body: string }> = [];
  const online = { getSyncCapabilities: async () => buildSyncCapabilities(db, 'test'), fetchSyncSnapshot: async () => buildSyncSnapshot(db),
    replaySyncOperation: async (op: Parameters<typeof replaySyncOperation>[1]) => { sent.push({ opId: op.opId, body: JSON.stringify(op) }); return replaySyncOperation(db, op); } };
  const options = { clientId: 'tag-flow', randomUUID };
  let api = facade.createOfflineAwareGalleryApi(online, store, options); await api.getSyncCapabilities({ replay: false });
  return { db, entry, section, facet, sent, online, get store() { return store; }, get api() { return api; },
    reopen() { store.close(); store = indexed.createIndexedDbOfflineStore({ indexedDB: factory, databaseName }); api = facade.createOfflineAwareGalleryApi(online, store, options); },
    close() { store.close(); db.close(); } };
}

it('real SQL durable pending Facet creation and new Tag placement survives cold reopen and verified cleanup', async () => {
 const f = await fixture();
 try {
  const local = await f.api.enqueueOfflineEntryCreate({ title: 'Facet Draft', type: 'comic', uploadDate: null, pageCount: null, ratings: [], viewLater: false, coverFile: null, previewFile: null });
  const parent = (await f.store.list())[0];
  await f.api.createFacet({ sectionId: f.section.id, name: 'Offline Facet' });
  const options = await f.api.getPendingOfflineEntryTagOptions(local.localKey);
  const facet = options.facets.find((row: {name: string}) => row.name === 'Offline Facet');
  expect(facet.id).toBeLessThan(0);
  await f.api.enqueueOfflinePendingEntryTagCreate(local.localKey, 'Facet Tag', facet.id);
  expect((await f.store.list())[0]).toEqual(parent);
  f.reopen(); await f.api.flushOfflineOutbox();
  expect(await f.store.list()).toEqual([]);
  expect(f.db.prepare("SELECT COUNT(*) FROM entry_tags et JOIN tag_groups f ON f.id=et.facet_id WHERE f.name='Offline Facet'").pluck().get()).toBe(1);
 } finally { f.close(); }
});

it('rejects a future captured shared-layout revision instead of treating baseVersion as decoration', async () => {
 const f = await fixture(); try {
  await f.api.createFacet({sectionId: f.section.id, name: 'Future'});
  const row = (await f.store.list())[0];
  const {status: _status, createdAt: _created, lastAttemptAt: _attempt, lastError: _error, ...operation} = row;
  void _status; void _created; void _attempt; void _error;
  const result = replaySyncOperation(f.db, {...operation, baseVersion: operation.baseVersion + 100});
  expect(result.status).toBe('conflict');
  expect(f.db.prepare("SELECT COUNT(*) FROM tag_groups WHERE name='Future'").pluck().get()).toBe(0);
 } finally {f.close();}
});

it.each(['pending', 'synced', 'manual-reuse', 'canonical-origin-reuse'] as const)('SQL %s Facet commit-response-loss cold reopen exact retry move remove readd and numeric receipt cleanup', async kind => {
 const f = await fixture(); try {
  const local = kind !== 'synced' ? await f.api.enqueueOfflineEntryCreate({title:'Owner',type:'comic',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null}) : null;
  await f.api.createFacet({sectionId:f.section.id,name:'Shared'});
  const rows = await f.store.list(), origin = rows.find((row: {operationKind:string}) => row.operationKind==='entry.facet.create');
  if(kind==='canonical-origin-reuse') expect(replaySyncOperation(f.db,{...origin,opId:randomUUID(),entityUid:randomUUID(),clientId:'other-client'}).status).toBe('applied');
  const detail = local ? await f.api.getPendingOfflineEntryTagOptions(local.localKey) : await f.api.getEntry(f.entry.id);
  const facet = local ? detail.facets.find((row: {name:string})=>row.name==='Shared') : detail.sections.flatMap((row: {facets:Array<{id:number;name:string}>})=>row.facets).find((row: {name:string})=>row.name==='Shared');
  if(kind==='manual-reuse') createFacet(f.db,{sectionId:f.section.id,name:'Shared'});
  f.db.prepare('INSERT INTO tags (name,normalized_name) VALUES (?,?)').run('Canonical','canonical');
  if(local) await f.api.enqueueOfflinePendingEntryTagCreate(local.localKey,'Canonical',facet.id);
  else await f.api.assignEntryTag(f.entry.id,{name:'Canonical',facetId:facet.id});
  const transport=f.online.replaySyncOperation; let lost=false;
  f.online.replaySyncOperation=async op=>{const result=await transport(op); if(!lost && op.operationKind==='entry.facet.create'){lost=true;throw new TypeError('committed response lost');}return result;};
  await f.api.flushOfflineOutbox(); f.reopen();
  if(local){
   await f.api.enqueueOfflinePendingEntryTags(local.localKey,[{name:'Canonical',facetId:f.facet.id}]);
   await f.api.enqueueOfflinePendingEntryTags(local.localKey,[]);
   await f.api.enqueueOfflinePendingEntryTagCreate(local.localKey,'Canonical',facet.id);
  } else {
   const d=await f.api.getEntry(f.entry.id), tag=d.sections.flatMap((section:{facets:Array<{tags:Array<{id:number;name:string}>}>})=>section.facets.flatMap(facet=>facet.tags)).find((tag:{name:string})=>tag.name==='Canonical');
   await f.api.moveEntryTag(f.entry.id,tag.id,f.facet.id); await f.api.removeEntryTag(f.entry.id,tag.id); await f.api.assignEntryTag(f.entry.id,{name:'Canonical',facetId:facet.id});
  }
  await f.api.flushOfflineOutbox(); expect(await f.store.list()).toEqual([]);
  const retries=f.sent.filter(row=>row.opId===origin.opId); expect(retries).toHaveLength(2);expect(retries[0]?.body).toBe(retries[1]?.body);
  const receipt=JSON.parse(f.db.prepare('SELECT result_json FROM sync_operation_receipts WHERE op_id=?').pluck().get(origin.opId) as string);
  expect(receipt).toMatchObject({opId:origin.opId,status:'applied',entityId:expect.any(Number)});
  expect(f.db.prepare("SELECT facet_id FROM entry_tags WHERE tag_id=(SELECT id FROM tags WHERE name='Canonical')").pluck().get()).toBe(receipt.entityId);
  if(kind==='canonical-origin-reuse'){
   expect(f.db.prepare('SELECT COUNT(*) FROM sync_offline_created_entry_facets').pluck().get()).toBe(2);
   expect(f.db.prepare('SELECT sync_uid FROM tag_groups WHERE id=?').pluck().get(receipt.entityId)).not.toBe(origin.entityUid);
  }
  const changed=JSON.parse(retries[0]!.body); changed.payload.name='Changed'; expect(replaySyncOperation(f.db,changed).status).toBe('failed');
 }finally{f.close();}
});
it('SQL disjoint shared-layout edits and Entry metadata are preserved by Facet insertion and dependent assignment', async()=>{
 const f=await fixture();try{
  await f.api.createFacet({sectionId:f.section.id,name:'Offline'});
  const facet=(await f.api.getEntry(f.entry.id)).sections.flatMap((row:{facets:Array<{id:number;name:string}>})=>row.facets).find((row:{name:string})=>row.name==='Offline');
  await f.api.assignEntryTag(f.entry.id,{name:'Local Tag',facetId:facet.id});
  const remote=createFacet(f.db,{sectionId:f.section.id,name:'Unseen',sortOrder:77});
  f.db.prepare('UPDATE entries SET title=? WHERE id=?').run('Remote title',f.entry.id);
  await f.api.flushOfflineOutbox();expect(await f.store.list()).toEqual([]);
  expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.entry.id)).toBe('Remote title');
  expect(f.db.prepare('SELECT sort_order FROM tag_groups WHERE id=?').pluck().get(remote.id)).toBe(77);
 }finally{f.close();}
});
it('SQL unseen concurrent Entry assignment conflicts rather than erasing it',async()=>{
 const f=await fixture();try{
  await f.api.createFacet({sectionId:f.section.id,name:'Offline'});
  const facet=(await f.api.getEntry(f.entry.id)).sections.flatMap((row:{facets:Array<{id:number;name:string}>})=>row.facets).find((row:{name:string})=>row.name==='Offline');
  await f.api.assignEntryTag(f.entry.id,{name:'Local Tag',facetId:facet.id});
  const tag=Number(f.db.prepare('INSERT INTO tags(name,normalized_name) VALUES (?,?)').run('Remote','remote').lastInsertRowid);
  f.db.prepare('INSERT INTO entry_tags(entry_id,tag_id,facet_id) VALUES (?,?,?)').run(f.entry.id,tag,f.facet.id);
  await f.api.flushOfflineOutbox(); expect((await f.store.list()).some((row:{status:string})=>row.status==='conflict')).toBe(true);
  expect(f.db.prepare('SELECT COUNT(*) FROM entry_tags WHERE entry_id=? AND tag_id=?').pluck().get(f.entry.id,tag)).toBe(1);
 }finally{f.close();}
});
it('SQL Facet receipt failure rolls back origin row layout journal and Facet together',async()=>{
 const f=await fixture();try{
  await f.api.createFacet({sectionId:f.section.id,name:'Rollback'});
  const before=f.db.prepare('SELECT COUNT(*) FROM sync_entry_taxonomy_changes').pluck().get();
  f.db.exec("CREATE TRIGGER fail_facet_receipt BEFORE INSERT ON sync_operation_receipts BEGIN SELECT RAISE(ABORT,'forced receipt failure'); END");
  await f.api.flushOfflineOutbox();
  expect(f.db.prepare("SELECT COUNT(*) FROM tag_groups WHERE name='Rollback'").pluck().get()).toBe(0);
  expect(f.db.prepare('SELECT COUNT(*) FROM sync_offline_created_entry_facets').pluck().get()).toBe(0);
  expect(f.db.prepare('SELECT COUNT(*) FROM sync_entry_taxonomy_changes').pluck().get()).toBe(before);
  expect(f.db.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(0);
 }finally{f.close();}
});

it('disposable schema-34 doctor detects a missing Facet origin registry and probe explicitly covers it', async()=>{
 const {inspectDatabase}=await import('../../src/database/doctor.js');
 const {runDatabaseProbe}=await import('../../src/database/probe.js');
 const f=await fixture();try{
  expect(runDatabaseProbe().checks).toContainEqual(expect.objectContaining({name:'schema-34 Entry Tag and Facet origin registries',passed:true}));
  f.db.exec('DROP TABLE sync_offline_created_entry_facets');
  const doctorDb = Object.create(f.db) as typeof f.db;
  doctorDb.pragma = (query: string) => f.db.prepare(`PRAGMA ${query}`).all();
  expect(inspectDatabase(doctorDb).issues).toContain('missing required table: sync_offline_created_entry_facets');
 }finally{f.close();}
});
it.each(['uid','client','type','receipt-op-id','wrong-kind','numeric'] as const)('SQL atomically rejects forged Facet origin %s',async wrong=>{
 const f=await fixture();try{
  await f.api.createFacet({sectionId:f.section.id,name:'Offline'});
  const facet=(await f.api.getEntry(f.entry.id)).sections.flatMap((row:{facets:Array<{id:number;name:string}>})=>row.facets).find((row:{name:string})=>row.name==='Offline');
  await f.api.assignEntryTag(f.entry.id,{name:'Tag',facetId:facet.id});
  const operations=(await f.store.list()).map((row:{status:string;createdAt:string;lastAttemptAt:string|null;lastError:string|null})=>{const{status:_s,createdAt:_c,lastAttemptAt:_a,lastError:_e,...op}=row;void _s;void _c;void _a;void _e;return op;});
  const origin=operations.find((row:{operationKind:string})=>row.operationKind==='entry.facet.create'), assignment=operations.at(-1);
  for(const op of operations.slice(0,-1)) expect(replaySyncOperation(f.db,op).status).toBe('applied');
  if(wrong==='uid') assignment.payload.facetCreates[0].facetUid=randomUUID();
  if(wrong==='client') assignment.clientId='foreign';
  if(wrong==='type') f.db.prepare('UPDATE sync_offline_created_entry_facets SET entry_type=? WHERE create_op_id=?').run('game',origin.opId);
  if(wrong==='receipt-op-id') f.db.prepare("UPDATE sync_operation_receipts SET result_json=json_set(result_json,'$.opId',?) WHERE op_id=?").run(randomUUID(),origin.opId);
  if(wrong==='numeric') f.db.prepare("UPDATE sync_operation_receipts SET result_json=json_set(result_json,'$.entityId',9999) WHERE op_id=?").run(origin.opId);
  if(wrong==='wrong-kind') assignment.payload.facetCreates[0].createOpId=operations.find((row:{operationKind:string})=>row.operationKind==='entry.tag.create').opId;
  expect(replaySyncOperation(f.db,assignment).status).not.toBe('applied');
  expect(f.db.prepare('SELECT COUNT(*) FROM entry_tags WHERE entry_id=?').pluck().get(f.entry.id)).toBe(0);
 }finally{f.close();}
});

it('retains a global Facet origin while an uncovered same-type peer remains then cleans the final applied timeline',async()=>{
 const f=await fixture();try{
  await f.api.createFacet({sectionId:f.section.id,name:'Shared'});
  const facet=(await f.api.getEntry(f.entry.id)).sections.flatMap((row:{facets:Array<{id:number;name:string}>})=>row.facets).find((row:{name:string})=>row.name==='Shared');
  await f.api.assignEntryTag(f.entry.id,{name:'Shared Tag',facetId:facet.id});
  const peer=await f.api.enqueueOfflineEntryCreate({title:'Peer',type:'comic',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null});
  await f.api.enqueueOfflinePendingEntryTagCreate(peer.localKey,'Shared Tag',facet.id);
  const origin=(await f.store.list()).find((row:{operationKind:string})=>row.operationKind==='entry.facet.create');
  await f.store.writeMeta('capability.offlinePendingEntryTags','0'); await f.api.flushOfflineOutbox();
  expect((await f.store.list()).some((row:{opId:string})=>row.opId===origin.opId)).toBe(true);
  await f.store.writeMeta('capability.offlinePendingEntryTags','1'); f.reopen(); await f.api.flushOfflineOutbox();expect(await f.store.list()).toEqual([]);
  expect(f.db.prepare('SELECT COUNT(*) FROM entry_tags').pluck().get()).toBe(2);
 }finally{f.close();}
});
it('rotated library epoch rejects a previously valid Facet chain atomically',async()=>{
 const {rotateSyncEpoch}=await import('../../src/sync/sync-service.js');const f=await fixture();try{
  await f.api.createFacet({sectionId:f.section.id,name:'Old epoch'});await f.api.assignEntryTag(f.entry.id,{name:'Old Tag',facetId:(await f.api.getEntry(f.entry.id)).sections.flatMap((row:{facets:Array<{id:number;name:string}>})=>row.facets).find((row:{name:string})=>row.name==='Old epoch').id});
  rotateSyncEpoch(f.db);await f.api.flushOfflineOutbox();expect(f.db.prepare("SELECT COUNT(*) FROM tag_groups WHERE name='Old epoch'").pluck().get()).toBe(0);expect(f.db.prepare('SELECT COUNT(*) FROM sync_offline_created_entry_facets').pluck().get()).toBe(0);expect(f.db.prepare('SELECT COUNT(*) FROM entry_tags').pluck().get()).toBe(0);
 }finally{f.close();}
});

it('canonical Tag numeric reuse retains Facet and Tag creation references through a partial refresh and source remove readd',async()=>{
 const f=await fixture();try{
  await f.api.createFacet({sectionId:f.section.id,name:'Shared'});
  const facet=(await f.api.getEntry(f.entry.id)).sections.flatMap((row:{facets:Array<{id:number;name:string}>})=>row.facets).find((row:{name:string})=>row.name==='Shared');
  f.db.prepare('INSERT INTO tags(name,normalized_name) VALUES (?,?)').run('Shared Tag','shared tag');
  await f.api.assignEntryTag(f.entry.id,{name:'Shared Tag',facetId:facet.id});
  const peer=await f.api.enqueueOfflineEntryCreate({title:'Peer',type:'comic',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null});await f.api.enqueueOfflinePendingEntryTagCreate(peer.localKey,'Shared Tag',facet.id);
  const tagOrigin=(await f.store.list()).find((row:{operationKind:string})=>row.operationKind==='entry.tag.create');
  await f.store.writeMeta('capability.offlinePendingEntryTags','0');await f.api.flushOfflineOutbox();f.reopen();
  const d=await f.api.getEntry(f.entry.id),tag=d.sections.flatMap((row:{facets:Array<{tags:Array<{id:number;name:string}>}>})=>row.facets.flatMap(facet=>facet.tags)).find((row:{name:string})=>row.name==='Shared Tag');
  await f.api.removeEntryTag(f.entry.id,tag.id);await f.api.assignEntryTag(f.entry.id,{name:'Shared Tag',facetId:facet.id});
  expect((await f.store.list()).at(-1).payload.tagCreates).toEqual([{tagUid:tagOrigin.entityUid,createOpId:tagOrigin.opId}]);
  await f.store.writeMeta('capability.offlinePendingEntryTags','1');await f.api.flushOfflineOutbox();expect(await f.store.list()).toEqual([]);
 }finally{f.close();}
});

it.each(['numeric','opId','section-kind'] as const)('Facet facade refuses forged applied receipt %s identity before durable cleanup',async wrong=>{
 const f=await fixture();try{
  await f.api.createFacet({sectionId:f.section.id,name:'Receipt Facet'});
  const transport=f.online.replaySyncOperation;
  f.online.replaySyncOperation=async op=>{const result=await transport(op);return op.operationKind==='entry.facet.create'?{...result,...(wrong==='opId'?{opId:randomUUID()}:{entityId:wrong==='numeric'?99999:f.section.id})}:result;};
  await f.api.flushOfflineOutbox();expect(await f.store.list()).toHaveLength(1);
 }finally{f.close();}
});
