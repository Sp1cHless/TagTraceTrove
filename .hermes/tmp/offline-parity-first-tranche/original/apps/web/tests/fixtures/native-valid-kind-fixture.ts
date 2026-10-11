import { COLLECTION_ORDER_SCOPE_UIDS, nativeMutationContract, syncReplayOperationSchema } from '@t3/shared';
import { createPendingSyncOperation, type PendingSyncOperationInput } from '../../src/offline/outbox-store.js';
const uid = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const third = '33333333-3333-4333-8333-333333333333';
type Shape = Pick<PendingSyncOperationInput, 'baseVersion' | 'baseValues' | 'payload'> & { entityUid?: string };
// Defense coverage, using the existing production queue builder with complete bodies.
export const shapes: Record<string, Shape> = {
 'gallery.order.set': { entityUid: '00000000-0000-4000-8000-000000000037', baseVersion: 1, baseValues: {orderedTypes: ['comic','game']}, payload: {orderedTypes: ['game','comic']} },
 'entry.update': { baseVersion: 1, baseValues: { title: 'before' }, payload: { title: 'after' } },
 'entry.create': { baseVersion: 0, baseValues: {}, payload: { title: 'new', type: 'comic', uploadDate: null, pageCount: null, ratings: [], viewLater: false } },
 'entry.content.append': { baseVersion: 0, baseValues: {}, payload: { parentCreateOpId: second, content: { syncUid: third, contentType: 'text', content: 'new' } } },
 'entry.usage': { baseVersion: 0, baseValues: {}, payload: { event: 'view' } },
 'entry.view-later.set': { baseVersion: 1, baseValues: { present: false }, payload: { present: true } },
 'entry.rating.set': { baseVersion: 1, baseValues: { slotUid: second, stars: null }, payload: { slotUid: second, stars: 3 } },
 'entry.authors.set': { baseVersion: 1, baseValues: { producerUids: [] }, payload: { producerUids: [second] } },
 'entry.author.create-and-link': { baseVersion: 1, baseValues: { producerUids: [] }, payload: { producerUid: second, name: 'Author' } },
 'entry.tag.create': { baseVersion: 0, baseValues: {}, payload: { name: 'Tag' } },
 'entry.facet.create': { baseVersion: 1, baseValues: { entryType: 'comic', sectionUid: second }, payload: { entryType: 'comic', sectionUid: second, name: 'Facet' } },
 'entry.tags.set': { baseVersion: 1, baseValues: { tags: [] }, payload: { tags: [{ name: 'Tag', facetId: 1 }] } },
 'entry.contents.set': { baseVersion: 1, baseValues: { contents: [] }, payload: { contents: [{ syncUid: second, contentType: 'text', content: 'new', sortOrder: 0 }] } },
 'producer.view-later.set': { baseVersion: 1, baseValues: { present: false }, payload: { present: true } },
 'producer.rating.set': { baseVersion: 1, baseValues: { slotUid: second, stars: null }, payload: { slotUid: second, stars: 3 } },
 'producer.update': { baseVersion: 1, baseValues: { name: 'before' }, payload: { name: 'after' } },
 'producer.tags.set': { baseVersion: 1, baseValues: { tags: [] }, payload: { tags: [{ syncUid: second, name: 'Tag' }] } },
 'rating-layout.slots.set': { baseVersion: 1, baseValues: { slots: [] }, payload: { slots: [{ syncUid: second, name: 'Quality', sortOrder: 0 }] } },
 'author.directories.set': { baseVersion: 1, baseValues: { directories: [] }, payload: { directories: [{ syncUid: second, title: 'Directory', description: '', sortOrder: 0, entries: [] }] } },
 'collection.create': { baseVersion: 0, baseValues: {}, payload: { kind: 'entry', title: 'Collection', description: '', nsfw: false, parentUid: null, galleryType: null } },
 'collection.entry.set': { baseVersion: 1, baseValues: { entryUid: second, present: false }, payload: { entryUid: second, present: true } },
 'collection.order.set': { entityUid: COLLECTION_ORDER_SCOPE_UIDS.entry, baseVersion: 2, baseValues: { kind: 'entry', collections: [{ syncUid: second, syncVersion: 1, sortOrder: 0 }, { syncUid: third, syncVersion: 1, sortOrder: 1 }] }, payload: { kind: 'entry', orderedCollectionUids: [third, second] } },
 'collection.producer.set': { baseVersion: 1, baseValues: { producerUid: second, present: false }, payload: { producerUid: second, present: true } },
 'collection.update': { baseVersion: 1, baseValues: { title: 'before' }, payload: { title: 'after' } },
};


export function validKindRows(libraryId = uid, syncEpoch = 'epoch') {
 return Object.entries(shapes).map(([kind, shape]) => {
 const contract = nativeMutationContract[kind as keyof typeof nativeMutationContract];
 const row = createPendingSyncOperation({clientId: uid, libraryId, syncEpoch, entityKind: contract.entityKind, entityUid: shape.entityUid ?? uid, operationKind: kind, baseVersion: shape.baseVersion, baseValues: shape.baseValues, payload: shape.payload});
 const {status,lastAttemptAt,lastError,...body}=row;void status;void lastAttemptAt;void lastError;
 syncReplayOperationSchema.parse(body);return body;
 });
}
