import { expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { setGalleryOrder } from '../../src/repositories/gallery-order-repository.js';
import { createApiApp } from '../../src/http/app.js';

it('cold-restarts through a lost committed receipt, verified delta and durable ACK before cleanup', async () => {
 const paths=['../../../web/src/api/gallery.js','../../../web/src/api/client.js','../../../web/src/offline/offline-api.js','../../../web/src/offline/indexeddb-snapshot-store.js','../../../web/src/offline/offline-sync.js','../../../web/node_modules/fake-indexeddb/build/esm/index.js'];
 const [gallery,client,facade,stores,sync,idb]=await Promise.all(paths.map(path=>import(path)));
 const {indexedDB}=idb;const db=createMigratedMemoryDatabase();const name=`gallery-flow-${crypto.randomUUID()}`;
 let store=stores.createIndexedDbOfflineStore({indexedDB,databaseName:name});
 try {
  for(const type of ['Alpha','Hidden','Zebra'])createEntry(db,{title:type,type});
  db.prepare('INSERT INTO gallery_settings(entry_type,nsfw) VALUES(?,1)').run('Hidden');
  setGalleryOrder(db,['Zebra','Hidden','Alpha']);const app=createApiApp(db);
  const requests:string[]=[];const bodies:string[]=[];let lose=false;let failAck=false;
  const online=gallery.createGalleryApi(client.createApiClient({baseUrl:'http://gallery.test/api/',fetchImplementation:async(input:RequestInfo|URL,init?:RequestInit)=>{
   const url=String(input);requests.push(url);if(failAck && url.includes('/sync/ack'))throw new TypeError('ACK transport lost');
   const response=await app.request(url,init);
   if(url.includes('/sync/replay')){bodies.push(String(init?.body));if(lose){lose=false;throw new TypeError('committed receipt lost');}}
   return response;
  }}));
  const options={clientId:'gallery-phone'};let api=facade.createOfflineAwareGalleryApi(online,store,options);
  await api.getSyncCapabilities({replay:false});expect((await sync.downloadOfflineSnapshot({api,store})).ok).toBe(true);
  await api.preferOfflineSnapshot();await api.setGalleryOrder(['Alpha','Hidden','Zebra']);await api.setGalleryOrder(['Hidden','Alpha','Zebra']);
  const queued=await store.list();expect(queued).toHaveLength(2);
  lose=true;await api.flushOfflineOutbox();expect(await store.list()).toHaveLength(2);
  store.close();store=stores.createIndexedDbOfflineStore({indexedDB,databaseName:name});api=facade.createOfflineAwareGalleryApi(online,store,options);
  await api.preferOfflineSnapshot();expect((await api.listGalleries()).map((row:{type:string})=>row.type)).toEqual(['Hidden','Alpha','Zebra']);
  failAck=true;await api.flushOfflineOutbox();expect(await store.list()).toHaveLength(2);
  failAck=false;await api.flushOfflineOutbox();expect(await store.list()).toEqual([]);
  expect(bodies[0]).toBe(bodies[1]);
  expect(requests.some(url=>url.includes('/sync/delta'))).toBe(true);expect(requests.some(url=>url.includes('/sync/ack'))).toBe(true);
  expect(db.prepare('SELECT sync_version FROM gallery_order_scope').pluck().get()).toBe(4);
  expect((await online.listGalleries()).map((row:{type:string})=>row.type)).toEqual(['Hidden','Alpha','Zebra']);
 }finally{store.close();db.close();}
});
