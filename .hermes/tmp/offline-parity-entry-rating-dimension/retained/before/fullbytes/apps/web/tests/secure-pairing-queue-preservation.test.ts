// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils';
import { expect, it, vi } from 'vitest';
import { indexedDB } from 'fake-indexeddb';
import SecurePairingSettings from '../src/components/SecurePairingSettings.vue';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createPendingSyncOperation } from '../src/offline/outbox-store.js';
import { offlineSnapshot } from './fixtures/pending-entry-tags.js';
import { ACTIVE_GENERATION_KEY } from '../src/offline/snapshot-store.js';

it('explicit recovery UI and rejected recovery preserve exact snapshot and immutable queued edits across cold IndexedDB reopen', async () => {
 const databaseName = `t3-pairing-preserve-${crypto.randomUUID()}`;
 const store = createIndexedDbOfflineStore({ indexedDB, databaseName });
 const bytes = JSON.stringify(offlineSnapshot());
 await store.writeGeneration(1, bytes); await store.writeMeta(ACTIVE_GENERATION_KEY, '1');
 const operation = createPendingSyncOperation({ clientId: 'client-1', libraryId: 'library-1', syncEpoch: 'epoch-1', entityKind: 'entry', entityUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', operationKind: 'entry.update', baseVersion: 1, baseValues: { title: 'before' }, payload: { title: 'queued' } });
 await store.enqueue(operation);
 const queued = await store.list();
 let reject = true;
 vi.stubGlobal('fetch', vi.fn(async (path: string) => {
  if (path.endsWith('/status')) return Response.json({ csrf: 'csrf', devices: [], recovery: { libraryId: 'library-1', message: 'certificate changed' } });
  return Response.json({ recovered: !reject }, { status: reject ? 409 : 200 });
 }));
 const wrapper = mount(SecurePairingSettings);
 try {
  await wrapper.findAll('button').find(button => button.text() === 'Authorized devices')!.trigger('click'); await flushPromises();
  await wrapper.get('[data-testid="confirm-library"]').setValue('library-1');
  await wrapper.get('[data-testid="confirm-owner"]').setValue('0');
  const reset = wrapper.findAll('button').find(button => button.text().includes('Confirm replace certificate'))!;
  await reset.trigger('click'); await flushPromises(); expect(wrapper.get('[role="alert"]').text()).toContain('rejected');
  reject = false; await reset.trigger('click'); await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('queued edits were kept');
  store.close();
  const reopened = createIndexedDbOfflineStore({ indexedDB, databaseName });
  try {
   expect(await reopened.list()).toEqual(queued);
   expect(await reopened.readGeneration(1)).toBe(bytes);
   expect(await reopened.readMeta(ACTIVE_GENERATION_KEY)).toBe('1');
  } finally { reopened.close(); }
 } finally {
  wrapper.unmount(); store.close(); vi.unstubAllGlobals();
  await new Promise<void>((resolve, rejectDelete) => { const request = indexedDB.deleteDatabase(databaseName); request.onsuccess = () => resolve(); request.onerror = () => rejectDelete(request.error); });
 }
});
