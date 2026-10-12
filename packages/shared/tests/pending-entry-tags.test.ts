import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  syncEntryTagLayoutRowSchema,
  syncReplayOperationSchema,
  syncTagGroupRowSchema,
  syncTagRowSchema,
} from '../src/index.js';

it('accepts pending tags only with zero version and parent UUID, preserving legacy validation', () => {
  const op = { opId: randomUUID(), clientId: 'test', libraryId: randomUUID(), syncEpoch: randomUUID(), entityKind: 'entry', entityUid: randomUUID(), clientCreatedAt: '2026-09-25T00:00:00Z', operationKind: 'entry.tags.set', baseVersion: 0, baseValues: { tags: [] }, payload: { parentCreateOpId: randomUUID(), tags: [{ name: 'Known', facetId: 1 }] } };
  expect(syncReplayOperationSchema.safeParse(op).success).toBe(true);
  expect(syncReplayOperationSchema.safeParse({ ...op, baseVersion: 1 }).success).toBe(false);
  expect(syncReplayOperationSchema.safeParse({ ...op, payload: { tags: op.payload.tags } }).success).toBe(false);
  expect(syncReplayOperationSchema.safeParse({ ...op, baseVersion: 1, payload: { tags: op.payload.tags } }).success).toBe(true);
  expect(syncReplayOperationSchema.safeParse({ ...op, payload: { ...op.payload, parentCreateOpId: 'bad' } }).success).toBe(false);
  expect(syncReplayOperationSchema.safeParse({ ...op, payload: { ...op.payload, tags: [{ name: 'Known', facetId: 1 }, { name: 'KNOWN', facetId: 2 }] } }).success).toBe(false);
  expect(syncReplayOperationSchema.safeParse({ ...op, payload: { ...op.payload, tags: [] } }).success).toBe(false);
});

it('accepts stable Entry Tag and Facet creates with causal complete-set references', () => {
  const identity = {
    clientId: 'tag-board', libraryId: randomUUID(), syncEpoch: randomUUID(),
    clientCreatedAt: '2026-10-03T00:00:00Z',
  };
  const tagUid = randomUUID();
  const facetUid = randomUUID();
  const sectionUid = randomUUID();
  const tagCreate = {
    ...identity, opId: randomUUID(), entityKind: 'entry_tag', entityUid: tagUid,
    operationKind: 'entry.tag.create', baseVersion: 0, baseValues: {},
    payload: { name: ' School   Life ' },
  };
  const facetCreate = {
    ...identity, opId: randomUUID(), entityKind: 'entry_facet', entityUid: facetUid,
    operationKind: 'entry.facet.create', baseVersion: 4,
    baseValues: { entryType: 'comic', sectionUid },
    payload: { entryType: 'comic', sectionUid, name: ' Theme ' },
  };
  const assignment = {
    ...identity, opId: randomUUID(), entityKind: 'entry', entityUid: randomUUID(),
    operationKind: 'entry.tags.set', baseVersion: 7,
    baseValues: { tags: [] },
    payload: {
      tags: [{ name: 'School Life', tagUid, facetUid }],
      tagCreates: [{ tagUid, createOpId: tagCreate.opId }],
      facetCreates: [{ facetUid, createOpId: facetCreate.opId }],
    },
  };

  expect(syncReplayOperationSchema.safeParse(tagCreate).success).toBe(true);
  expect(syncReplayOperationSchema.safeParse(facetCreate).success).toBe(true);
  expect(syncReplayOperationSchema.safeParse(assignment).success).toBe(true);
  expect(syncReplayOperationSchema.safeParse({
    ...assignment,
    payload: { ...assignment.payload, tagCreates: undefined },
  }).success).toBe(false);
  expect(syncReplayOperationSchema.safeParse({
    ...assignment,
    payload: { ...assignment.payload, facetCreates: [{ facetUid, createOpId: assignment.opId }] },
  }).success).toBe(false);
  expect(syncReplayOperationSchema.safeParse({
    ...facetCreate,
    payload: { ...facetCreate.payload, entryType: 'game' },
  }).success).toBe(false);
  // A Facet queued inside a layout original has no facet-create to declare: the
  // server resolves it from tag_groups.sync_uid and the planner orders it.
  const layoutFacetUid = randomUUID();
  expect(syncReplayOperationSchema.safeParse({
    ...assignment,
    payload: { tags: [{ name: 'School Life', tagUid, facetUid: layoutFacetUid }], tagCreates: [{ tagUid, createOpId: tagCreate.opId }] },
  }).success).toBe(true);
  // A declared dependency that nothing references is still refused.
  expect(syncReplayOperationSchema.safeParse({
    ...assignment,
    payload: { ...assignment.payload, facetCreates: [...assignment.payload.facetCreates, { facetUid: layoutFacetUid, createOpId: facetCreate.opId }] },
  }).success).toBe(false);
});

it('parses stable Entry Tag vocabulary and shared layout snapshot identities', () => {
  const tagUid = randomUUID();
  const facetUid = randomUUID();
  const layoutUid = randomUUID();
  expect(syncTagRowSchema.parse({ id: 1, syncUid: tagUid, name: 'Theme', normalizedName: 'theme' }))
    .toEqual({ id: 1, syncUid: tagUid, name: 'Theme', normalizedName: 'theme' });
  expect(syncTagGroupRowSchema.parse({
    id: 2, syncUid: facetUid, entryType: 'comic', name: 'Mood',
    groupKind: 'facet', parentId: 1, sortOrder: 0,
  })).toMatchObject({ syncUid: facetUid, groupKind: 'facet' });
  expect(syncEntryTagLayoutRowSchema.parse({
    entryType: 'comic', syncUid: layoutUid, syncVersion: 3,
  })).toEqual({ entryType: 'comic', syncUid: layoutUid, syncVersion: 3 });
  // Old persisted snapshot generations remain readable.
  expect(syncTagRowSchema.safeParse({ id: 1, name: 'Theme', normalizedName: 'theme' }).success).toBe(true);
});
