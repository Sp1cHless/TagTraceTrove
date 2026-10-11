import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/database/connection.js';

it.each(['expiry','eviction','restart','utf8-budget','utf8-session'])('downloads a real verified full snapshot after %s loses the server baseline', async (reason) => {
  const paths=['../../../web/src/api/gallery.js','../../../web/src/api/client.js','../../../web/src/offline/snapshot-store.js','../../../web/src/offline/offline-sync.js'];
  const [gallery,client,snapshots,sync]=await Promise.all(paths.map(path=>import(path)));
  let db=createMigratedMemoryDatabase(); const directory=await mkdtemp(join(tmpdir(),'t3-delta-'));
  try {
    const entry=createEntry(db,{title:'Before',type:'game'}); let app=createApiApp(db);
    if(reason==='utf8-budget') {
      db.exec("INSERT INTO producers(id,name) VALUES(1,'Base')");
      db.prepare('UPDATE producers SET name=? WHERE id=1').run('界'.repeat(6*1024*1024));
    }
    const requests:string[]=[];
    const api=gallery.createGalleryApi(client.createApiClient({baseUrl:'http://fallback.test/api/',fetchImplementation:async(input:RequestInfo|URL,init?:RequestInit)=>{requests.push(String(input));return app.request(String(input),init);}}));
    expect((await api.getSyncCapabilities()).featureFlags.completeSnapshotDelta).toBe(true);
    const store=snapshots.createMemorySnapshotStore();
    expect((await sync.downloadOfflineSnapshot({api,store})).ok).toBe(true);
    if(reason==='expiry') vi.spyOn(Date,'now').mockReturnValue(Date.now()+300001);
    if(reason==='utf8-budget') for(let index=0;index<3;index++) rememberSnapshot(db,buildSyncSnapshot(db,{media:'thumbnails'}),'thumbnails');
    if(reason==='eviction') for(let index=0;index<16;index++) rememberSnapshot(db,buildSyncSnapshot(db,{media:'thumbnails'}),'thumbnails');
    if(reason==='restart') { const filename=join(directory,'library.db'); await db.backup(filename); db.close(); db=openDatabase(filename); app=createApiApp(db); }
    if(reason==='utf8-session') {
      db.exec("INSERT INTO producers(id,name) VALUES(1,'Base')");
      db.prepare('UPDATE producers SET name=? WHERE id=1').run('界'.repeat(17*1024*1024));
    }
    db.prepare('UPDATE entries SET title=? WHERE id=?').run('After',entry.id); requests.length=0;
    expect((await sync.downloadOfflineSnapshot({api,store})).ok).toBe(true);
    expect(requests.filter(url=>url.includes('/sync/delta'))).toHaveLength(1);
    expect(requests.filter(url=>url.includes('/sync/snapshot'))).toHaveLength(1);
    expect(requests.some(url=>url.includes('/sync/ack'))).toBe(false);
    expect((await snapshots.readActiveSnapshot(store))?.snapshot.payload).toEqual(buildSyncSnapshot(db,{media:'thumbnails'}).payload);
  } finally {vi.restoreAllMocks();db.close();await rm(directory,{recursive:true,force:true});}
});
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { buildSyncSnapshot } from '../../src/sync/sync-service.js';
import { rememberSnapshot } from '../../src/sync/snapshot-delta.js';
import { createApiApp } from '../../src/http/app.js';

it.each(['valid','corrupt','dropped','reordered','metadata'])('handles an exact HTTP surrogate split: %s', async (mode) => {
  const paths=['../../../web/src/api/gallery.js','../../../web/src/api/client.js','../../../web/src/offline/snapshot-store.js','../../../web/src/offline/offline-sync.js'];
  const [gallery,client,stores,sync]=await Promise.all(paths.map(path=>import(path)));
  const db=createMigratedMemoryDatabase();
  try {
    const entry=createEntry(db,{title:'Base',type:'game'}); const app=createApiApp(db);
    const pages:Array<{chunk:string;offset:number}>=[]; const requests:string[]=[];
    let tamper=false;
    const api=gallery.createGalleryApi(client.createApiClient({baseUrl:'http://split.test/api/',fetchImplementation:async(input:RequestInfo|URL,init?:RequestInit)=>{
      requests.push(String(input)); const response=await app.request(String(input),init);
      if(tamper && String(input).includes('/sync/delta') && response.ok) {
        const page=await response.json(); pages.push({chunk:page.chunk,offset:page.offset});
        if(mode==='corrupt' && page.offset===0) page.chunk=page.chunk.replace('xxxxx','yyyyy');
        if(mode==='dropped' && page.offset===0) page.chunk=page.chunk.slice(1);
        if(mode==='reordered' && page.offset>0) page.offset=0;
        if(mode==='metadata' && page.offset>0) page.target.checksum='wrong-checksum';
        return Response.json(page);
      }
      return response;
    }}));
    expect((await api.getSyncCapabilities()).featureFlags.completeSnapshotDelta).toBe(true);
    const store=stores.createMemorySnapshotStore(); expect((await sync.downloadOfflineSnapshot({api,store})).ok).toBe(true);
    const base=(await stores.readActiveSnapshot(store))!.snapshot;
    db.prepare('UPDATE entries SET title=? WHERE id=?').run('x'.repeat(40000),entry.id);
    const probe=await api.fetchSnapshotDelta({libraryId:base.header.libraryId,syncEpoch:base.header.syncEpoch,protocolVersion:1,clientId:'probe',media:'thumbnails',baseChecksum:base.header.checksum,baseChangeSeq:base.header.changeSeq!,offset:0});
    const start=probe.chunk.indexOf('xxxxx'); expect(start).toBeGreaterThan(0);
    const title='x'.repeat(16383-start)+'😀'+'z'.repeat(40000);
    db.prepare('UPDATE entries SET title=? WHERE id=?').run(title,entry.id);
    const before=await stores.readActiveSnapshot(store); requests.length=0;tamper=true;
    const result=await sync.downloadOfflineSnapshot({api,store});
    expect(pages[0]!.chunk.charCodeAt(16383)).toBe(0xd83d);
    if(mode==='valid') {
      expect(pages[1]!.chunk.charCodeAt(0)).toBe(0xde00);
      expect(result.ok).toBe(true);
      expect((await stores.readActiveSnapshot(store))!.snapshot.payload.entries[0].title).toBe(title);
      expect(requests.filter(url=>url.includes('/sync/ack'))).toHaveLength(1);
    } else {
      expect(result.ok).toBe(false);
      expect(await stores.readActiveSnapshot(store)).toEqual(before);
      expect(requests.some(url=>url.includes('/sync/ack'))).toBe(false);
    }
    expect(requests.some(url=>url.includes('/sync/snapshot'))).toBe(false);
  } finally {db.close();}
});

it('materializes every populated SQL payload array through the actual HTTP delta client', async () => {
  const paths=['../../../web/src/api/gallery.js','../../../web/src/api/client.js','../../../web/src/offline/snapshot-delta.js','../../../web/src/offline/snapshot-store.js'];
  const [gallery,client,delta,stores]=await Promise.all(paths.map(path=>import(path)));
  const db=createMigratedMemoryDatabase();
  try {
    const entry=createEntry(db,{title:'Seed',type:'game'});
    const base=buildSyncSnapshot(db,{media:'thumbnails'}); rememberSnapshot(db,base,'thumbnails');
    db.exec(`
      INSERT INTO producers(id,name,artwork_ref) VALUES(1,'作者😀','/producer.webp');
      INSERT INTO entry_producers(entry_id,producer_id) VALUES(${entry.id},1);
      INSERT INTO tags(id,name,normalized_name) VALUES(1,'Tag','tag');
      INSERT INTO tag_groups(id,entry_type,name,group_kind) VALUES(100,'game','Section','section');
      INSERT INTO tag_groups(id,entry_type,name,group_kind,parent_id) VALUES(101,'game','Facet','facet',100);
      INSERT INTO entry_tags(entry_id,tag_id,facet_id) VALUES(${entry.id},1,101);
      INSERT INTO producer_tags(id,name,normalized_name) VALUES(1,'Producer tag','producer tag');
      INSERT INTO producer_tag_assignments(producer_id,tag_id) VALUES(1,1);
      INSERT INTO taxonomy_aliases(vocabulary,partition,alias_name,normalized_alias,canonical_name,normalized_canonical) VALUES('entry','tags','Alias','alias','Tag','tag');
      INSERT INTO entry_contents(entry_id,content_type,content,sort_order) VALUES(${entry.id},'text','Content😀',2);
      INSERT INTO rating_slots(id,sync_uid,subject_kind,entry_type,name) VALUES(100,'11111111-1111-4111-8111-111111111111','entry','game','Entry stars'),(101,'22222222-2222-4222-8222-222222222222','producer','game','Producer stars');
      INSERT INTO entry_rating_values(slot_id,entry_id,stars) VALUES(100,${entry.id},3.5);
      INSERT INTO producer_rating_values(slot_id,producer_id,stars) VALUES(101,1,4);
      INSERT INTO collections(id,kind,title,gallery_type) VALUES(100,'entry','Parent','game'),(102,'producer','Authors',NULL);
      INSERT INTO collections(id,kind,title,parent_id) VALUES(101,'entry','Child',100);
      INSERT INTO collection_entries(collection_id,entry_id) VALUES(101,${entry.id});
      INSERT INTO collection_producers(collection_id,producer_id) VALUES(102,1);
      INSERT INTO author_directories(id,producer_id,title) VALUES(100,1,'Directory');
      INSERT INTO author_directory_entries(directory_id,producer_id,entry_id) VALUES(100,1,${entry.id});
      INSERT INTO entry_usage(entry_id,view_count,like_count) VALUES(${entry.id},5,2) ON CONFLICT(entry_id) DO UPDATE SET view_count=5,like_count=2;
      INSERT INTO view_later_entries(entry_id,position) VALUES(${entry.id},0);
      INSERT INTO view_later_producers(producer_id,position) VALUES(1,0);
      INSERT INTO gallery_settings(entry_type,nsfw) VALUES('game',1) ON CONFLICT(entry_type) DO UPDATE SET nsfw=1;
      UPDATE entries SET cover_ref='/cover.webp',preview_refs='["/preview.webp"]' WHERE id=${entry.id};
    `);
    const expected=buildSyncSnapshot(db,{media:'thumbnails'}).payload;
    for (const [key,rows] of Object.entries(expected)) if (Array.isArray(rows)) expect(rows.length, key).toBeGreaterThan(0);
    const requests:string[]=[]; const app=createApiApp(db);
    const api=gallery.createGalleryApi(client.createApiClient({baseUrl:'http://payload.test/api/',fetchImplementation:async(input:RequestInfo|URL,init?:RequestInit)=>{requests.push(String(input));return app.request(String(input),init);}}));
    const caps=await api.getSyncCapabilities();
    expect(caps.featureFlags.completeSnapshotDelta).toBe(true);
    const candidate=await delta.fetchSnapshotCandidate(api,{generationId:1,snapshot:base},caps,'payload');
    expect(candidate.acknowledgement).toBeDefined();
    expect(candidate.snapshot.payload).toEqual(expected);
    expect(await stores.verifyChecksum(candidate.snapshot,candidate.snapshot.header.checksum)).toBe(true);
    expect(requests.some(url=>url.includes('/sync/snapshot'))).toBe(false);
    const members=candidate.snapshot.payload.collectionMembers;
    expect(members.find((row:{entryId?:number})=>row.entryId)?.producerId).toBeUndefined();
    expect(members.find((row:{producerId?:number})=>row.producerId)?.entryId).toBeUndefined();
    const cursor=Number(db.prepare('SELECT MAX(seq) FROM sync_changes').pluck().get());
    db.exec("UPDATE taxonomy_aliases SET canonical_name='Changed',normalized_canonical='changed'; UPDATE gallery_settings SET nsfw=0;");
    expect(Number(db.prepare('SELECT MAX(seq) FROM sync_changes').pluck().get())).toBe(cursor);
    requests.length=0;
    const unjournaled=await delta.fetchSnapshotCandidate(api,{generationId:2,snapshot:candidate.snapshot},caps,'payload');
    expect(unjournaled.acknowledgement).toBeDefined();
    expect(unjournaled.snapshot.header.changeSeq).toBe(cursor);
    // Mutate the already-populated matrix, preserving owner/FK invariants.
    db.exec(`
      INSERT INTO entry_contents(entry_id,content_type,content,sort_order) VALUES(${entry.id},'text','Second',0),(${entry.id},'text','Removed',3);
      UPDATE entry_contents SET sort_order=4,content='Updated😀' WHERE content='Content😀';
      DELETE FROM entry_contents WHERE content='Removed';
      UPDATE tag_groups SET name='Renamed facet',sort_order=9 WHERE id=101;
      UPDATE entry_rating_values SET stars=1 WHERE slot_id=100;
      DELETE FROM producer_rating_values WHERE slot_id=101;
      DELETE FROM producer_tag_assignments WHERE producer_id=1;
      UPDATE author_directories SET title='Renamed directory',sort_order=8 WHERE id=100;
      DELETE FROM author_directory_entries WHERE directory_id=100;
      UPDATE collections SET title='Renamed child' WHERE id=101;
      DELETE FROM collection_entries WHERE collection_id=101;
      DELETE FROM view_later_entries WHERE entry_id=${entry.id};
      UPDATE entries SET preview_refs='["/preview-2.webp","/preview.webp"]' WHERE id=${entry.id};
    `);
    const mutated=await delta.fetchSnapshotCandidate(api,{generationId:3,snapshot:unjournaled.snapshot},caps,'mutation');
    expect(mutated.snapshot.payload).toEqual(buildSyncSnapshot(db,{media:'thumbnails'}).payload);
    expect(mutated.snapshot.payload.entryContents.map((row:{content:string})=>row.content)).toEqual(['Second','Updated😀']);
    expect(await stores.verifyChecksum(mutated.snapshot,mutated.snapshot.header.checksum)).toBe(true);
    expect(mutated.snapshot.payload.collectionMembers.every((row:object)=>!Object.hasOwn(row,'entryId'))).toBe(true);
    expect(mutated.snapshot.header.counts).toEqual(buildSyncSnapshot(db,{media:'thumbnails'}).header.counts);
    expect(requests.some(url=>url.includes('/sync/snapshot'))).toBe(false);
  } finally {db.close();}
});
