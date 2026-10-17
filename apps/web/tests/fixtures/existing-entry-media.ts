import type { SyncSnapshot } from '@t3/shared';

export const libraryId = '11111111-1111-4111-8111-111111111111';
export const entryUid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export function fixture(): SyncSnapshot {
 return {header:{libraryId,syncEpoch:'epoch',snapshotSeq:1,changeSeq:1,generatedAt:'2026-10-04',sqliteSchemaVersion:35,snapshotFormatVersion:2,counts:{entries:1,producers:0,entryContents:0,entryTags:0,collections:0},checksum:'stored'},payload:{entries:[{id:1,syncUid:entryUid,syncVersion:1,title:'Existing',type:'game',coverRef:null,previewRef:null,previewRefs:[],pageCount:null,uploadDate:null,createdAt:'2026-10-04',updatedAt:'2026-10-04'}],producers:[],entryProducers:[],tags:[],tagGroups:[],entryTags:[],producerTags:[],producerTagAssignments:[],entryContents:[],ratingSlots:[],entryRatingValues:[],producerRatingValues:[],collections:[],collectionMembers:[],authorDirectories:[],authorDirectoryEntries:[],entryUsage:[],viewLaterEntries:[],viewLaterProducers:[],gallerySettings:[],mediaRefs:[]}};
}
