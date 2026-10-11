// Parent-owned read-only production probe; isolated SQL/assets, no formal API.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMigratedMemoryDatabase } from '../../../apps/server/src/database/testing.ts';
import { createEntry } from '../../../apps/server/src/repositories/entry-repository.ts';
import { createApiApp } from '../../../apps/server/src/http/app.ts';
import { createMemoryOfflineStore } from '../../../apps/web/src/offline/memory-offline-store.ts';
import { createOfflineAwareGalleryApi } from '../../../apps/web/src/offline/offline-api.ts';
import { createGalleryApi } from '../../../apps/web/src/api/gallery.ts';
import { createApiClient } from '../../../apps/web/src/api/client.ts';
const db=createMigratedMemoryDatabase();
const assetRoot=mkdtempSync(join(tmpdir(),'t3-parent-online-no-copy-'));
try {
 const entry=createEntry(db,{title:'Disposable online entry',type:'comic'});
 const app=createApiApp(db,{assetRoot});
 const store=createMemoryOfflineStore();
 const paths:string[]=[];
 const online=createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
  const url=new URL(String(input));paths.push(url.pathname);return app.request(url.pathname+url.search,init);
 }}));
 const api=createOfflineAwareGalleryApi(online,store,{clientId:'parent-online-no-copy',randomUUID});
 await api.getSyncCapabilities({replay:false});
 const detail=await api.getEntry(entry.id);
 assert.equal(detail.id,entry.id);
 assert.equal((await store.captureSnapshot()).active,null,'Probe requires online/no downloaded copy');
 console.log('Real isolated API loaded Entry online; no installed snapshot. Paths:',paths);
 await assert.doesNotReject(()=>api.deleteEntry(entry.id),'Ordinary online deletion must not require a downloaded offline copy');
 assert.equal(db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(entry.id),0);
 console.log('ONLINE_NO_COPY_PASS');
} finally { db.close();rmSync(assetRoot,{recursive:true,force:true}); }
