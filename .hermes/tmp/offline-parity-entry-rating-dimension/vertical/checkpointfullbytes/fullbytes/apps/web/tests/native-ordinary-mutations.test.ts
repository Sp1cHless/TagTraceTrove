// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { GalleryApi } from '../src/api/gallery.js';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { nativeMutationContract } from '@t3/shared';
import { createNativeTransfers } from '../src/offline/native-background-transfer.js';
import { originalMutationEnvelope } from '../src/offline/sync-mutation-plan.js';

it('ordinary Producer, Directory and Collection facade commits automatically stage immutable originals through the actual bridge', async () => {
 const store=createIndexedDbOfflineStore({indexedDB:new IDBFactory(),databaseName:'ordinary-native'});
 const producerUid='99999999-9999-4999-8999-999999999999';
 const snapshot={header:{libraryId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',syncEpoch:'epoch',snapshotSeq:1,changeSeq:1,generatedAt:'now',sqliteSchemaVersion:35,snapshotFormatVersion:2,counts:{entries:0,producers:1,entryContents:0,entryTags:0,collections:0},checksum:'stored'},payload:{entries:[],producers:[{id:9,syncUid:producerUid,syncVersion:1,name:'Author',occupation:null,artworkRef:null,content:null}],entryProducers:[],tags:[],tagGroups:[],entryTags:[],producerTags:[],producerTagAssignments:[],entryContents:[],ratingSlots:[],entryRatingValues:[],producerRatingValues:[],collections:[],collectionMembers:[],authorDirectories:[],authorDirectorySets:[{producerId:9,syncUid:'92929292-9292-4292-8292-929292929292',syncVersion:1}],authorDirectoryEntries:[],entryUsage:[],viewLaterEntries:[],viewLaterProducers:[],gallerySettings:[],mediaRefs:[]}};
 await store.writeGeneration(1,JSON.stringify(snapshot));await store.writeMeta('activeGeneration','1');
 for(const flag of ['offlineProducerProfile','offlineAuthorDirectories','offlineCollectionManagement'])await store.writeMeta(`capability.${flag}`,'1');
 const call=vi.fn(async (method:string,args:Record<string,unknown>)=>{void args;return method==='status'?{protocolVersion:1,planVersion:1,operationKinds:Object.keys(nativeMutationContract)}:{};});
 const native=createNativeTransfers(store,{call});
 const api=createOfflineAwareGalleryApi({} as GalleryApi,store,{nativeTransfers:native});
 await api.preferOfflineSnapshot!();
 await api.updateAuthor(9,{name:'Edited'});
 await api.createAuthorDirectory(9,{title:'Directory'});
 await api.createCollection({kind:'producer',title:'Collection'});
 const rows=await store.list();expect(rows.map(row=>row.operationKind)).toEqual(['producer.update','author.directories.set','collection.create']);
 const staged=call.mock.calls.filter(([method])=>method==='stageOperation').map(([,args])=>JSON.parse(String(args.body)));
 for(const row of rows)expect(staged).toContainEqual(originalMutationEnvelope(row));
 expect(call.mock.calls.filter(([method])=>method==='activate').length).toBeGreaterThanOrEqual(3);
 expect(new Set(rows.map(row=>row.clientId)).size).toBe(1);store.close();
});
