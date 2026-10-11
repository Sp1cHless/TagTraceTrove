// @vitest-environment node
import { expect, it } from 'vitest';
import { indexedDB } from 'fake-indexeddb';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createPendingSyncOperation } from '../src/offline/outbox-store.js';
import { restorePendingWork } from '../src/offline/pending-work-restore.js';
export const identity = { clientId: 'client', libraryId: '11111111-1111-4111-8111-111111111111', syncEpoch: 'epoch' };
export const operation = createPendingSyncOperation({ ...identity, entityKind:'entry', entityUid:'22222222-2222-4222-8222-222222222222', operationKind:'entry.update', baseVersion:1, baseValues:{title:'old'}, payload:{title:'new'} });
it('restores durable rows, cold reopens and does not overwrite newer retry state', async () => {
 const databaseName = crypto.randomUUID();
 const store = createIndexedDbOfflineStore({ indexedDB, databaseName });
 const text = JSON.stringify({format:'t3-pending-work-v1',exportedAt:new Date().toISOString(),operations:[operation],media:[]});
 await restorePendingWork(text, identity, store);
 await store.update(operation.opId,{status:'conflict',lastError:'newer'});
 await restorePendingWork(text,identity,store);
 store.close();
 const reopened = createIndexedDbOfflineStore({indexedDB,databaseName});
 expect(await reopened.list()).toEqual([{...operation,status:'conflict',lastError:'newer'}]);
 reopened.close();
});
