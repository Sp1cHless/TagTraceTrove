import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { createEntry, deleteEntry } from '../../src/repositories/entry-repository.js';
import { createProducer, deleteProducer } from '../../src/repositories/producer-repository.js';
import {
  addViewLaterEntry,
  addViewLaterProducer,
  listViewLaterEntryIds,
  listViewLaterProducerIds,
  mergeViewLaterEntries,
  removeViewLaterEntry,
  removeViewLaterProducer,
} from '../../src/repositories/view-later-repository.js';

type TestDatabase = ReturnType<typeof createMigratedMemoryDatabase>;
const databases: TestDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('shared View later (real SQL)', () => {
  it('keeps one ordered, idempotent list and cascades deleted Entries', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const first = createEntry(database, { title: 'First', type: 'comic' });
    const second = createEntry(database, { title: 'Second', type: 'comic' });
    const third = createEntry(database, { title: 'Third', type: 'comic' });

    addViewLaterEntry(database, second.id);
    addViewLaterEntry(database, second.id);
    addViewLaterEntry(database, first.id);
    expect(listViewLaterEntryIds(database)).toEqual([second.id, first.id]);

    mergeViewLaterEntries(database, [first.id, 999, third.id, third.id]);
    expect(listViewLaterEntryIds(database)).toEqual([second.id, first.id, third.id]);

    removeViewLaterEntry(database, second.id);
    removeViewLaterEntry(database, second.id);
    expect(listViewLaterEntryIds(database)).toEqual([first.id, third.id]);

    deleteEntry(database, first.id);
    expect(listViewLaterEntryIds(database)).toEqual([third.id]);
    expect(() => addViewLaterEntry(database, 999)).toThrow('entry not found');
  });

  it('keeps an ordered, idempotent Author list and cascades deleted Authors', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const first = createProducer(database, { name: 'First Author' });
    const second = createProducer(database, { name: 'Second Author' });

    addViewLaterProducer(database, second.id);
    addViewLaterProducer(database, second.id);
    addViewLaterProducer(database, first.id);
    expect(listViewLaterProducerIds(database)).toEqual([second.id, first.id]);

    removeViewLaterProducer(database, second.id);
    removeViewLaterProducer(database, second.id);
    expect(listViewLaterProducerIds(database)).toEqual([first.id]);

    deleteProducer(database, first.id);
    expect(listViewLaterProducerIds(database)).toEqual([]);
    expect(() => addViewLaterProducer(database, 999)).toThrow('producer not found');
  });

  it('exposes list, idempotent mutation, and merge routes', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const first = createEntry(database, { title: 'First', type: 'comic' });
    const second = createEntry(database, { title: 'Second', type: 'comic' });
    const author = createProducer(database, { name: 'Saved Author' });
    const app = createApiApp(database);

    const initial = await app.request('/api/view-later');
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ entryIds: [], producerIds: [] });

    const added = await app.request(`/api/view-later/${first.id}`, { method: 'PUT' });
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({ entryIds: [first.id], producerIds: [] });

    const repeated = await app.request(`/api/view-later/${first.id}`, { method: 'PUT' });
    expect(await repeated.json()).toEqual({ entryIds: [first.id], producerIds: [] });

    const merged = await app.request('/api/view-later/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryIds: [first.id, second.id] }),
    });
    expect(merged.status).toBe(200);
    expect(await merged.json()).toEqual({ entryIds: [first.id, second.id], producerIds: [] });

    const authorAdded = await app.request(`/api/view-later/producers/${author.id}`, { method: 'PUT' });
    expect(authorAdded.status).toBe(200);
    expect(await authorAdded.json()).toEqual({
      entryIds: [first.id, second.id],
      producerIds: [author.id],
    });

    const authorRemoved = await app.request(`/api/view-later/producers/${author.id}`, { method: 'DELETE' });
    expect(authorRemoved.status).toBe(200);
    expect(await authorRemoved.json()).toEqual({
      entryIds: [first.id, second.id],
      producerIds: [],
    });

    const removed = await app.request(`/api/view-later/${first.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ entryIds: [second.id], producerIds: [] });

    const missing = await app.request('/api/view-later/999', { method: 'PUT' });
    expect(missing.status).toBe(404);
  });
});
