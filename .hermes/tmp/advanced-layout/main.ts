import { createApp, h } from 'vue';
import GalleryApp from '../../../apps/web/src/GalleryApp.vue';
import AuthorPage from '../../../apps/web/src/AuthorPage.vue';
import '../../../apps/web/src/styles/theme.css';
import { createIndexedDbOfflineStore } from '../../../apps/web/src/offline/indexeddb-snapshot-store';
import { createOfflineAwareGalleryApi } from '../../../apps/web/src/offline/offline-api';
import { createGalleryApi } from '../../../apps/web/src/api/gallery';
import { createApiClient } from '../../../apps/web/src/api/client';
import { offlineSnapshot } from '../../../apps/web/tests/fixtures/pending-entry-tags';
import { setLocale } from '../../../apps/web/src/i18n';
setLocale(new URLSearchParams(location.search).get('locale') === 'zh' ? 'zh-CN' : 'en');
const snapshot=offlineSnapshot();snapshot.header.sqliteSchemaVersion=41;
snapshot.payload.entries[0]!.durationSeconds=470;snapshot.payload.producers[0]!.galleryAnchor='game';snapshot.payload.producers[0]!.artworkRef=null;
snapshot.payload.ratingSlots.push({id:80,syncUid:'80808080-8080-4080-8080-808080808080',subjectKind:'author_self',entryType:'game',name:'Fresh voice',sortOrder:0});
snapshot.payload.ratingLayouts!.push({syncUid:'83838383-8383-4383-8383-838383838383',syncVersion:1,subjectKind:'author_self',entryType:'game'});
const store=createIndexedDbOfflineStore({databaseName:`isolated-quick-author-${crypto.randomUUID()}`});
await store.writeGeneration(1,JSON.stringify(snapshot));await store.writeMeta('activeGeneration','1');
for(const flag of ['offlineMutations','offlineEntryCreate','offlineEntryDuration','offlineAuthorSelfRatings','offlineRatingSlotDelete','offlineRatingSlotLayout','offlineProducerRating','offlineProducerProfile','offlineUsageEvents'])await store.writeMeta(`capability.${flag}`,'1');
const client=createApiClient({baseUrl:'http://isolated.invalid/api',fetchImplementation:async()=>{throw new TypeError('Fixture offline: no external API request allowed');}});
const api=createOfflineAwareGalleryApi(createGalleryApi(client),store,{clientId:'browser-fixture'});await api.preferOfflineSnapshot!();
const long='LongUnbrokenFixtureName'.repeat(8); const url='https://'+long+'.invalid/'+long;
Object.assign(api, {
 suggestTags: async()=>[{id:21,name:long}],
 previewPendingWorkRestore: async()=>({operationCount:2,mediaCount:1,binaryBytes:42,scope:long,addedOperations:2,addedMedia:1}),
 listTaxonomyAliases: async()=>[{id:1,vocabulary:'entry',alias:long,canonicalName:''},{id:2,vocabulary:'entry',alias:long,canonicalName:long}],
 listUnassignedTags: async()=>[],
 listSourceLibrary: async()=>[{sourceKey:'fixture',sourceName:long,hosts:[url],entryCount:2,entryUrlCount:2,state:'invalid'}],
 probeSourceTarget: async()=>({ok:true,adapterKey:'fixture',displayName:long,origin:url}),
 resumeNativeTransfers: async()=>({active:1,completed:2,held:3,remainingOperations:4,foregroundReason:long}),
});
const run={id:1,status:'review',counts:{processed:1,matched:1,ambiguous:0,noMatch:0,errors:0,total:1}};
Object.assign(api,{createSourceMaintenanceRun:async()=>run,startSourceMaintenanceRun:async()=>run,getSourceMaintenanceRun:async()=>run,listSourceMaintenanceItems:async()=>({items:[{entryId:1,entryTitleSnapshot:long,originUrls:[url],candidates:[{url,title:long,band:'exact-safe',reasons:[long]}]}],total:1})});
const authors=await api.listAuthors();
createApp({render:()=>new URLSearchParams(location.search).get('page')==='author'?h(AuthorPage,{api,authors}):h(GalleryApp,{api,offlineStore:store})}).mount('#app');
Object.assign(window,{fixture:{api,store,isolated:true}});
