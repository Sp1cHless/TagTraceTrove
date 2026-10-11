// @vitest-environment jsdom
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { indexedDB } from 'fake-indexeddb';
import { mount } from '@vue/test-utils';
import OfflineLibrarySettings from '../src/components/OfflineLibrarySettings.vue';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createGalleryApi } from '../src/api/gallery.js';
import { createApiClient } from '../src/api/client.js';
import { readActiveSnapshot } from '../src/offline/snapshot-store.js';
import type { SyncDeltaRequest } from '@t3/shared';

// A disposable in-memory SQL server in Node avoids Vite's browser rewrite
// of migration file URLs while exercising real HTTP from mounted Settings.
async function startDisposableServer() {
  const source = `
    import { createServer } from 'node:http';
    import { createMigratedMemoryDatabase } from './apps/server/src/database/testing.ts';
    import { createEntry } from './apps/server/src/repositories/entry-repository.ts';
    import { createApiApp } from './apps/server/src/http/app.ts';
    const db = createMigratedMemoryDatabase();
    createEntry(db, { title: 'Before', type: 'game' });
    const app = createApiApp(db);
    const server = createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const response = await app.fetch(new Request('http://127.0.0.1' + req.url, {
        method: req.method, headers: req.headers,
        ...(body.length ? { body } : {})
      }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)));
  `;
  const child = spawn(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', '--input-type=module', '-e', source], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let error = '';
  child.stderr.on('data', chunk => { error += String(chunk); });
  const port = await Promise.race([
    once(child.stdout, 'data').then(([chunk]) => String(chunk)),
    once(child, 'exit').then(() => { throw new Error(`Disposable server failed: ${error}`); }),
  ]);
  return { child, baseUrl: `http://127.0.0.1:${port}/api/` };
}

it.each(['advertised', 'legacy-omitted', 'legacy-false'] as const)('mounted real SQL HTTP Settings Download/Update uses %s capabilities without a client override', async (mode) => {
  const server = await startDisposableServer();
  const store = createIndexedDbOfflineStore({ indexedDB, databaseName: `advertised-settings-${crypto.randomUUID()}` });
  const calls: Array<{ url: string; body: unknown }> = [];
  const online = createGalleryApi(createApiClient({ baseUrl: server.baseUrl, fetchImplementation: async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined });
    const response = await fetch(url, init);
    // Only the explicit older-server fixtures change the wire advertisement.
    if (mode !== 'advertised' && url.includes('/sync/capabilities')) {
      const value = await response.json();
      if (mode === 'legacy-omitted') delete value.featureFlags.completeSnapshotDelta;
      else value.featureFlags.completeSnapshotDelta = false;
      return Response.json(value);
    }
    return response;
  } }));
  const api = createOfflineAwareGalleryApi(online, store);
  const wrapper = mount(OfflineLibrarySettings, { props: { api, store } });
  try {
    const caps = await online.getSyncCapabilities();
    expect(caps.featureFlags.completeSnapshotDelta).toBe(mode === 'advertised' ? true : mode === 'legacy-false' ? false : undefined);
    await wrapper.get('[data-testid="offline-media-mode"]').setValue('metadata');
    await wrapper.get('[data-testid="offline-download"]').trigger('click');
    await vi.waitFor(async () => expect((await readActiveSnapshot(store))?.snapshot.payload.entries[0]?.title).toBe('Before'));
    await vi.waitFor(() => expect(wrapper.get('[data-testid="offline-download"]').attributes('disabled')).toBeUndefined());
    const base = (await readActiveSnapshot(store))!;
    expect(calls.filter(row => row.url.includes('/sync/snapshot'))).toHaveLength(1);
    expect(await store.readMeta('capability.completeSnapshotDelta')).toBe(mode === 'advertised' ? '1' : '0');
    await online.updateEntry(1, { title: 'After' });
    calls.length = 0;
    await wrapper.get('[data-testid="offline-download"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.get('[data-testid="offline-download"]').attributes('disabled')).toBeUndefined());
    const active = (await readActiveSnapshot(store))!;
    expect(active.snapshot.payload.entries[0]?.title).toBe('After');
    expect(active.generationId).toBeGreaterThan(base.generationId);
    expect(calls.filter(row => row.url.includes('/sync/delta'))).toHaveLength(mode === 'advertised' ? 1 : 0);
    expect(calls.filter(row => row.url.includes('/sync/snapshot'))).toHaveLength(mode === 'advertised' ? 0 : 1);
    const acks = calls.filter(row => row.url.includes('/sync/ack'));
    expect(acks).toHaveLength(mode === 'advertised' ? 1 : 0);
    if (mode === 'advertised') {
      const request = calls.find(row => row.url.includes('/sync/delta'))!.body as SyncDeltaRequest;
      expect(request.baseChecksum).toBe(base.snapshot.header.checksum);
      expect(request.baseChangeSeq).toBe(base.snapshot.header.changeSeq);
      expect(acks[0]!.body).toMatchObject({ clientId: request.clientId, cursorSeq: active.snapshot.header.changeSeq });
      expect(await store.readMeta('t3.offline-client-id')).toBe(request.clientId);
    }
    expect(await store.readMeta('pendingSnapshotAck')).toBeNull();
    expect(wrapper.get('[data-testid="offline-status"]').text()).not.toMatch(/changed during|stale|error|失败/iu);
  } finally { wrapper.unmount(); store.close(); server.child.kill(); await once(server.child, 'exit'); }
});

