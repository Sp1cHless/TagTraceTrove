import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';
import { upsertTaxonomyAlias } from '../../src/repositories/taxonomy-repository.js';

describe('link author by name', () => {
  it('links the existing Author instead of creating a duplicate', async () => {
    const database = createMigratedMemoryDatabase();
    try {
      const author = createProducer(database, { name: 'yuki' });
      const entry = createEntry(database, { title: 'Work', type: 'comic' });
      const app = createApiApp(database);

      const response = await app.request(`/api/entries/${entry.id}/producers/link-by-name`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'yuki' }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        entryId: entry.id,
        producerId: author.id,
        producerName: 'yuki',
        created: false,
      });
      // 关键:没有产生第二个同名作者
      expect(database.prepare('SELECT COUNT(*) FROM producers').pluck().get()).toBe(1);
      expect(database.prepare('SELECT producer_id FROM entry_producers WHERE entry_id = ?')
        .pluck().get(entry.id)).toBe(author.id);
    } finally {
      database.close();
    }
  });

  it('matches regardless of case, full-width forms and surrounding spaces', async () => {
    const database = createMigratedMemoryDatabase();
    try {
      const author = createProducer(database, { name: 'Yuki' });
      const entry = createEntry(database, { title: 'Work', type: 'comic' });
      const app = createApiApp(database);
      for (const typed of ['yuki', '  YUKI ', 'Ｙｕｋｉ']) {
        const response = await app.request(`/api/entries/${entry.id}/producers/link-by-name`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: typed }),
        });
        expect(response.status, typed).toBe(200);
        expect(await response.json()).toMatchObject({ producerId: author.id, created: false });
      }
      expect(database.prepare('SELECT COUNT(*) FROM producers').pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it('resolves a dictionary alias to its canonical Author', async () => {
    const database = createMigratedMemoryDatabase();
    try {
      const author = createProducer(database, { name: '雪' });
      upsertTaxonomyAlias(database, {
        vocabulary: 'producer', partition: 'authors', alias: 'yuki', canonicalName: '雪',
      });
      const entry = createEntry(database, { title: 'Work', type: 'comic' });
      const app = createApiApp(database);

      const response = await app.request(`/api/entries/${entry.id}/producers/link-by-name`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'yuki' }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        producerId: author.id,
        producerName: '雪',
        created: false,
        matchedAlias: 'yuki',
      });
      expect(database.prepare('SELECT COUNT(*) FROM producers').pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it('creates only when nothing matches, and is idempotent on repeat', async () => {
    const database = createMigratedMemoryDatabase();
    try {
      const entry = createEntry(database, { title: 'Work', type: 'comic' });
      const app = createApiApp(database);
      const post = (name: string) => app.request(`/api/entries/${entry.id}/producers/link-by-name`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });

      const first = await post('Brand New Author');
      expect(await first.json()).toMatchObject({ created: true, producerName: 'Brand New Author' });
      const second = await post('Brand New Author');
      expect(await second.json()).toMatchObject({ created: false });
      // 第二次是关联,不是再建一个
      expect(database.prepare('SELECT COUNT(*) FROM producers').pluck().get()).toBe(1);
      expect(database.prepare('SELECT COUNT(*) FROM entry_producers').pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it('rejects a blank name and a missing Entry', async () => {
    const database = createMigratedMemoryDatabase();
    try {
      const entry = createEntry(database, { title: 'Work', type: 'comic' });
      const app = createApiApp(database);
      const blank = await app.request(`/api/entries/${entry.id}/producers/link-by-name`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '   ' }),
      });
      expect(blank.status).toBe(400);

      const missing = await app.request('/api/entries/999999/producers/link-by-name', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'yuki' }),
      });
      expect(missing.status).toBe(404);
      expect(database.prepare('SELECT COUNT(*) FROM producers').pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it('keeps the author list deduplicated when a work already credits the author', async () => {
    const database = createMigratedMemoryDatabase();
    try {
      const author = createProducer(database, { name: '雪' });
      const entry = createEntry(database, { title: 'Work', type: 'comic' });
      linkEntryProducer(database, entry.id, author.id);
      const app = createApiApp(database);

      const response = await app.request(`/api/entries/${entry.id}/producers/link-by-name`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '雪' }),
      });
      expect(response.status).toBe(200);
      expect(database.prepare('SELECT COUNT(*) FROM entry_producers').pluck().get()).toBe(1);
      const detail = await (await app.request(`/api/entries/${entry.id}`)).json() as { producers: unknown[] };
      expect(detail.producers).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});
