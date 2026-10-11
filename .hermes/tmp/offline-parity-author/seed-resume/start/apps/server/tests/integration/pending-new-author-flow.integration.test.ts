import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { buildSyncCapabilities, buildSyncSnapshot } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';

it('reconciles real SQL create unlink relink after committed Producer response loss and facade restart', async () => {
  const db = createMigratedMemoryDatabase();
  try {
    createEntry(db, {title:'Seed',type:'comic'});
    expect(buildSyncCapabilities(db,'test').featureFlags.offlinePendingEntryAuthorCreate).toBe(true);
    const modules=['../../../web/src/offline/offline-api.js','../../../web/src/offline/snapshot-store.js','../../../web/src/offline/outbox-store.js','../../../web/src/offline/media-outbox-store.js'];
    const [facade,snapshots,outboxes,media]=await Promise.all(modules.map(path=>import(path)));
    const outbox=outboxes.createMemoryOutboxStore();
    const store={...snapshots.createMemorySnapshotStore(),...outbox,...media.createMemoryMediaOutboxStore((op:Parameters<typeof replaySyncOperation>[1])=>outbox.enqueue(op))};
    await store.writeGeneration(1,JSON.stringify(buildSyncSnapshot(db)));await store.writeMeta(snapshots.ACTIVE_GENERATION_KEY,'1');
    let lost=false;
    const sent: Array<{opId:string;body:string}>=[];
    const online={getSyncCapabilities:async()=>buildSyncCapabilities(db,'test'),fetchSyncSnapshot:async()=>buildSyncSnapshot(db),
      replaySyncOperation:async(op:Parameters<typeof replaySyncOperation>[1])=>{
        sent.push({opId:op.opId,body:JSON.stringify(op)});
        const result=replaySyncOperation(db,op);
        if(!lost&&op.operationKind==='entry.author.create-and-link'){lost=true;throw new TypeError('committed response lost');}
        return result;
      }};
    const options={clientId:'new-author-flow',randomUUID};
    const api=facade.createOfflineAwareGalleryApi(online,store,options);await api.getSyncCapabilities({replay:false});
    const created=await api.enqueueOfflineEntryCreate({title:'New',type:'comic',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null});
    const author=await api.enqueueOfflinePendingEntryAuthorCreate(created.localKey,'New Author');
    await api.enqueueOfflinePendingEntryAuthors(created.localKey,[]);
    await api.enqueueOfflinePendingEntryAuthors(created.localKey,[author.producerUid]);
    const rows=await store.list();await api.flushOfflineOutbox();expect(await store.list()).toHaveLength(4);
    const restart=facade.createOfflineAwareGalleryApi(online,store,options);
    expect((await restart.listPendingOfflineEntryCreates())[0].authors).toEqual([author]);
    await restart.flushOfflineOutbox();expect(await store.list()).toEqual([]);
    const entryId=db.prepare('SELECT id FROM entries WHERE sync_uid=?').pluck().get(created.localKey.slice(6));
    const producerId=db.prepare('SELECT id FROM producers WHERE sync_uid=?').pluck().get(author.producerUid);
    expect(db.prepare('SELECT COUNT(*) FROM producers WHERE sync_uid=?').pluck().get(author.producerUid)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM entries WHERE sync_uid=?').pluck().get(created.localKey.slice(6))).toBe(1);
    expect(db.prepare('SELECT producer_id FROM entry_producers WHERE entry_id=?').pluck().all(entryId)).toEqual([producerId]);
    const retries=sent.filter(row=>row.opId===rows[1].opId);expect(retries).toHaveLength(2);expect(retries[0]?.body).toBe(retries[1]?.body);
    expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(4);
  } finally {db.close();}
});
