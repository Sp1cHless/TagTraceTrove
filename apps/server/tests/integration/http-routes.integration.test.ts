import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { createEntryContent } from '../../src/repositories/entry-content-repository.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { assignEntryTag } from '../../src/repositories/entry-tag-repository.js';
import { createFacet, createSection } from '../../src/repositories/layout-repository.js';
import { setGalleryPartition } from '../../src/repositories/partition-repository.js';
import { createProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';
import { assignProducerTag } from '../../src/repositories/producer-tag-repository.js';

const databases: ReturnType<typeof createMigratedMemoryDatabase>[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('Entry HTTP routes', () => {
  it('creates, updates, and reads an Entry through shared contracts', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);

    const createResponse = await app.request('/api/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: ' Endfield ', type: 'game' }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { id: number; title: string };
    expect(created.title).toBe('Endfield');

    const updateResponse = await app.request(`/api/entries/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Arknights: Endfield' }),
    });
    expect(updateResponse.status).toBe(200);

    const detailResponse = await app.request(`/api/entries/${created.id}`);
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      id: created.id,
      title: 'Arknights: Endfield',
      type: 'game',
      producers: [],
      sections: [],
      contents: [],
    });
  });

  it('stores uploaded Entry media under the managed asset root', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const assetRoot = await mkdtemp(join(tmpdir(), 't3-assets-'));
    temporaryDirectories.push(assetRoot);
    const app = createApiApp(database, { assetRoot });
    const entry = createEntry(database, { title: 'Media Entry', type: 'comic' });
    const originalBytes = await sharp({
      create: { width: 1_200, height: 800, channels: 3, background: '#c62828' },
    }).png().toBuffer();
    const body = new FormData();
    body.set('file', new File([new Uint8Array(originalBytes)], 'cover.png', { type: 'image/png' }));

    const response = await app.request(`/api/entries/${entry.id}/media/cover`, {
      method: 'PUT',
      body,
    });

    expect(response.status).toBe(200);
    const updated = await response.json() as { coverRef: string };
    expect(updated.coverRef).toBe(`/api/assets/entries/${entry.id}/cover.png`);
    await expect(readFile(join(assetRoot, 'entries', String(entry.id), 'cover.png')))
      .resolves.toEqual(originalBytes);

    const assetResponse = await app.request(updated.coverRef);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get('content-type')).toContain('image/png');
    expect(assetResponse.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    const etag = assetResponse.headers.get('etag');
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(new Uint8Array(await assetResponse.arrayBuffer())).toEqual(new Uint8Array(originalBytes));

    const thumbnailResolver = await app.request(
      `/api/thumbnails/entries/${entry.id}/cover.png`,
      { redirect: 'manual' },
    );
    expect(thumbnailResolver.status).toBe(302);
    expect(thumbnailResolver.headers.get('cache-control')).toBe('no-cache');
    const thumbnailRef = thumbnailResolver.headers.get('location');
    expect(thumbnailRef).toMatch(
      new RegExp(`^/api/assets/entries/${entry.id}/thumbnails/cover\\.[a-f0-9]{16}\\.webp$`),
    );
    const thumbnailResponse = await app.request(thumbnailRef!);
    expect(thumbnailResponse.status).toBe(200);
    expect(thumbnailResponse.headers.get('content-type')).toContain('image/webp');
    expect(thumbnailResponse.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    const thumbnailBytes = new Uint8Array(await thumbnailResponse.arrayBuffer());
    const thumbnailMetadata = await sharp(thumbnailBytes).metadata();
    expect(thumbnailMetadata.width).toBe(512);
    expect(thumbnailMetadata.height).toBeLessThanOrEqual(512);

    const revalidatedResponse = await app.request(updated.coverRef, {
      headers: { 'If-None-Match': etag! },
    });
    expect(revalidatedResponse.status).toBe(304);
    expect(await revalidatedResponse.text()).toBe('');

    const replacementBytes = await sharp({
      create: { width: 1_200, height: 800, channels: 3, background: '#1565c0' },
    }).png().toBuffer();
    const replacementBody = new FormData();
    replacementBody.set('file', new File([new Uint8Array(replacementBytes)], 'cover.png', { type: 'image/png' }));
    await app.request(`/api/entries/${entry.id}/media/cover`, {
      method: 'PUT',
      body: replacementBody,
    });
    const changedResponse = await app.request(updated.coverRef, {
      headers: { 'If-None-Match': etag! },
    });
    expect(changedResponse.status).toBe(200);
    expect(changedResponse.headers.get('etag')).not.toBe(etag);
    expect(new Uint8Array(await changedResponse.arrayBuffer())).toEqual(new Uint8Array(replacementBytes));
    const changedThumbnailResolver = await app.request(
      `/api/thumbnails/entries/${entry.id}/cover.png`,
      { redirect: 'manual' },
    );
    expect(changedThumbnailResolver.headers.get('location')).not.toBe(thumbnailRef);
    expect((await app.request(thumbnailRef!)).status).toBe(404);
  });

  it('falls back to original media while an existing asset awaits thumbnail backfill', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const assetRoot = await mkdtemp(join(tmpdir(), 't3-assets-'));
    temporaryDirectories.push(assetRoot);
    const app = createApiApp(database, { assetRoot });
    const entry = createEntry(database, { title: 'Legacy Media', type: 'comic' });
    const directory = join(assetRoot, 'entries', String(entry.id));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'cover.png'), new Uint8Array([1, 2, 3]));

    const response = await app.request(`/api/thumbnails/entries/${entry.id}/cover.png`, {
      redirect: 'manual',
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`/api/assets/entries/${entry.id}/cover.png`);
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('previews a site export folder and commits its reviewed canonical mapping', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);
    const section = createSection(database, { entryType: 'comic', name: 'Imported' });
    const metadata = {
      source_site: '18comic.vip',
      items: [{
        source_site: '18comic.vip',
        source_id: '42',
        title: 'Imported work',
        detail_url: 'https://18comic.vip/album/42/',
        分类信息: { 作品: [], 登场人物: [], 分类标签: ['Color'], 作者: [] },
      }],
    };
    const previewBody = new FormData();
    previewBody.set('rootPath', 'metadata.json');
    previewBody.append('paths', 'metadata.json');
    previewBody.append('files', new File([JSON.stringify(metadata)], 'metadata.json', {
      type: 'application/json',
    }));

    const previewResponse = await app.request('/api/imports/site-probe/preview', {
      method: 'POST',
      body: previewBody,
    });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as { batch: unknown; entryCount: number };
    expect(preview.entryCount).toBe(1);

    const commitResponse = await app.request('/api/imports/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batch: preview.batch,
        mapping: {
          entryType: 'comic',
          canonicalTagFacetId: section.defaultFacetId,
          sourceContentType: 'source url',
          externalKeyContentType: 'external key',
          fieldMappings: {},
          ignoredFields: ['works', 'characters', 'authors'],
        },
      }),
    });
    expect(commitResponse.status).toBe(201);
    await expect(commitResponse.json()).resolves.toMatchObject({ entryCount: 1 });
    expect(database.prepare('SELECT title FROM entries').pluck().get()).toBe('Imported work');
  });

  it('derives Galleries from the type values of existing Entries', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);

    for (const input of [
      { title: 'Endfield', type: 'game' },
      { title: 'Hades II', type: 'game' },
      { title: 'Witch Hat Atelier', type: 'manga' },
    ]) {
      expect((await app.request('/api/entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })).status).toBe(201);
    }

    const response = await app.request('/api/galleries');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      { type: 'game', entryCount: 2, nsfw: false },
      { type: 'manga', entryCount: 1, nsfw: false },
    ]);
  });

  it('lists available Entry Tags for one type with usage counts', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);

    const section = await (await app.request('/api/sections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryType: 'game', name: 'Basics' }),
    })).json() as { defaultFacetId: number };

    for (const title of ['Endfield', 'Hades II']) {
      const entry = await (await app.request('/api/entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, type: 'game' }),
      })).json() as { id: number };
      await app.request(`/api/entries/${entry.id}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facetId: section.defaultFacetId, name: 'ARPG' }),
      });
      if (title === 'Endfield') {
        await app.request(`/api/entries/${entry.id}/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ facetId: section.defaultFacetId, name: 'Sci-fi' }),
        });
      }
    }

    const response = await app.request('/api/entry-tags?entryType=game');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      { id: expect.any(Number), name: 'ARPG', normalizedName: 'arpg', entryCount: 2 },
      { id: expect.any(Number), name: 'Sci-fi', normalizedName: 'sci-fi', entryCount: 1 },
    ]);
  });

  it('persists layout, tag placement, and Content through HTTP routes', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);

    const sectionResponse = await app.request('/api/sections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryType: 'game', name: '基本信息' }),
    });
    expect(sectionResponse.status).toBe(201);
    const section = await sectionResponse.json() as { id: number; defaultFacetId: number };

    const facetResponse = await app.request('/api/facets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sectionId: section.id, name: '游戏' }),
    });
    const facet = await facetResponse.json() as { id: number };

    const entryResponse = await app.request('/api/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Endfield', type: 'game' }),
    });
    const entry = await entryResponse.json() as { id: number };

    const tagResponse = await app.request(`/api/entries/${entry.id}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facetId: section.defaultFacetId, name: 'ARPG' }),
    });
    expect(tagResponse.status).toBe(201);
    const tag = await tagResponse.json() as { tagId: number };

    expect((await app.request(`/api/entries/${entry.id}/tags/${tag.tagId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetFacetId: facet.id }),
    })).status).toBe(200);

    expect((await app.request(`/api/entries/${entry.id}/tags/${tag.tagId}/name`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Action RPG' }),
    })).status).toBe(200);

    expect((await app.request(`/api/entries/${entry.id}/contents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'short review', content: '不错' }),
    })).status).toBe(201);

    const detail = await (await app.request(`/api/entries/${entry.id}`)).json();
    expect(detail).toMatchObject({
      sections: [{ facets: [{ name: '' }, { name: '游戏', tags: [{ name: 'Action RPG' }] }] }],
      contents: [{ contentType: 'short review', content: '不错' }],
    });

    const layoutResponse = await app.request('/api/layouts/game');
    expect(layoutResponse.status).toBe(200);
    await expect(layoutResponse.json()).resolves.toMatchObject([
      { id: section.id, facets: [{ name: '' }, { name: '游戏' }] },
    ]);
  });
});

describe('Producer HTTP routes', () => {
  it('writes Producers, links Entries, and searches both Tag vocabularies', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);

    const section = await (await app.request('/api/sections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryType: 'game', name: '基本信息' }),
    })).json() as { defaultFacetId: number };
    const entry = await (await app.request('/api/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Endfield', type: 'game' }),
    })).json() as { id: number };
    const entryTag = await (await app.request(`/api/entries/${entry.id}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facetId: section.defaultFacetId, name: 'ARPG' }),
    })).json() as { tagId: number };

    const producerResponse = await app.request('/api/producers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ' Hypergryph ', occupation: 'Developer' }),
    });
    expect(producerResponse.status).toBe(201);
    const producer = await producerResponse.json() as { id: number };

    expect((await app.request(`/api/entries/${entry.id}/producers/${producer.id}`, {
      method: 'PUT',
    })).status).toBe(200);

    const producerTagResponse = await app.request(`/api/producers/${producer.id}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Studio' }),
    });
    const producerTag = await producerTagResponse.json() as { tagId: number };

    const searchResponse = await app.request(
      `/api/producers?ownTagIds=${producerTag.tagId}&relatedEntryTagIds=${entryTag.tagId}`,
    );
    expect(searchResponse.status).toBe(200);
    await expect(searchResponse.json()).resolves.toEqual([
      { id: producer.id, name: 'Hypergryph', covers: [], galleryType: 'game', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false },
    ]);

    const filterOptionsResponse = await app.request('/api/producers/filter-options');
    expect(filterOptionsResponse.status).toBe(200);
    await expect(filterOptionsResponse.json()).resolves.toEqual({
      authorTags: [{ tagId: producerTag.tagId, name: 'Studio' }],
      workTags: [{ tagId: entryTag.tagId, name: 'ARPG' }],
    });

    const adultSection = createSection(database, { entryType: 'adult', name: 'Tags' });
    const adultEntry = createEntry(database, { title: 'Adult work', type: 'adult' });
    const adultAuthor = createProducer(database, { name: 'Adult author' });
    linkEntryProducer(database, adultEntry.id, adultAuthor.id);
    const adultAuthorTag = assignProducerTag(database, { producerId: adultAuthor.id, name: 'Adult author tag' });
    const adultWorkTag = assignEntryTag(database, {
      entryId: adultEntry.id,
      facetId: adultSection.defaultFacetId,
      name: 'Adult work tag',
    });
    setGalleryPartition(database, 'adult', true);

    await expect((await app.request('/api/producers/filter-options?includeNsfw=false')).json())
      .resolves.toEqual({
        authorTags: [{ tagId: producerTag.tagId, name: 'Studio' }],
        workTags: [{ tagId: entryTag.tagId, name: 'ARPG' }],
      });
    await expect((await app.request('/api/producers/filter-options?entryType=adult&includeNsfw=true')).json())
      .resolves.toEqual({
        authorTags: [{ tagId: adultAuthorTag.tagId, name: 'Adult author tag' }],
        workTags: [{ tagId: adultWorkTag.tagId, name: 'Adult work tag' }],
      });

    const detail = await (await app.request(`/api/entries/${entry.id}`)).json();
    expect(detail).toMatchObject({ producers: [{ id: producer.id, name: 'Hypergryph' }] });
  });

  it('reads Author details and persists Directory card organization', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);
    const author = createProducer(database, { name: 'Author', content: 'Note' });
    const first = createEntry(database, { title: 'First', type: 'manga', coverRef: 'first.webp' });
    const second = createEntry(database, { title: 'Second', type: 'manga', coverRef: 'second.webp' });
    linkEntryProducer(database, first.id, author.id);
    linkEntryProducer(database, second.id, author.id);
    const authorTag = assignProducerTag(database, { producerId: author.id, name: 'Illustrator' });

    expect((await app.request(`/api/producers/${author.id}/tags/${authorTag.tagId}/name`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Artist' }),
    })).status).toBe(200);

    const createDirectory = await app.request(`/api/producers/${author.id}/directories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Directory', entryIds: [first.id, second.id] }),
    });
    expect(createDirectory.status).toBe(201);
    const directory = await createDirectory.json() as { id: number };

    expect((await app.request(`/api/author-directories/${directory.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Manga', description: 'Selected works' }),
    })).status).toBe(200);

    expect((await app.request(
      `/api/producers/${author.id}/directories/${directory.id}/entries/${first.id}`,
      { method: 'DELETE' },
    )).status).toBe(200);

    const detail = await app.request(`/api/producers/${author.id}`);
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      id: author.id,
      name: 'Author',
      content: 'Note',
      tags: [{ name: 'Artist' }],
      looseEntries: [],
      looseEntryCount: 1,
      workCoverRefs: ['first.webp', 'second.webp'],
      directories: [{
        id: directory.id,
        title: 'Manga',
        description: 'Selected works',
        entries: [{ id: second.id, coverRef: 'second.webp' }],
      }],
    });
  });

  it('updates Producers and removes tags and Entry links', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);
    const entry = createEntry(database, { title: 'Endfield', type: 'game' });
    const producer = createProducer(database, { name: 'Hypergryph' });
    linkEntryProducer(database, entry.id, producer.id);
    const tag = assignProducerTag(database, { producerId: producer.id, name: 'Studio' });

    const update = await app.request(`/api/producers/${producer.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ occupation: 'Developer', content: 'Important note' }),
    });
    expect(update.status).toBe(200);
    await expect(update.json()).resolves.toMatchObject({
      id: producer.id,
      occupation: 'Developer',
      content: 'Important note',
    });

    await expect((await app.request(`/api/producers/${producer.id}/tags`)).json())
      .resolves.toEqual([expect.objectContaining({ tagId: tag.tagId, name: 'Studio' })]);
    expect((await app.request(`/api/producers/${producer.id}/tags/${tag.tagId}`, {
      method: 'DELETE',
    })).status).toBe(200);
    expect((await app.request(`/api/entries/${entry.id}/producers/${producer.id}`, {
      method: 'DELETE',
    })).status).toBe(200);

    await expect((await app.request(`/api/producers/${producer.id}/tags`)).json())
      .resolves.toEqual([]);
    const detail = await (await app.request(`/api/entries/${entry.id}`)).json();
    expect(detail).toMatchObject({ producers: [] });
  });
});

describe('HTTP error boundary', () => {
  it('returns stable validation, not-found, and conflict payloads', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);

    const invalid = await app.request('/api/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ', type: 'game' }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request' },
    });

    const missing = await app.request('/api/entries/999');
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      error: { code: 'NOT_FOUND', message: 'Entry not found' },
    });

    const section = await (await app.request('/api/sections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryType: 'game', name: '基本信息' }),
    })).json() as { defaultFacetId: number };
    const protectedFacet = await app.request(`/api/facets/${section.defaultFacetId}`, {
      method: 'DELETE',
    });
    expect(protectedFacet.status).toBe(409);
    await expect(protectedFacet.json()).resolves.toMatchObject({
      error: { code: 'CONFLICT' },
    });
    const entry = await (await app.request('/api/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Endfield', type: 'game' }),
    })).json() as { id: number };
    const tagBody = JSON.stringify({ facetId: section.defaultFacetId, name: 'ARPG' });
    await app.request(`/api/entries/${entry.id}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: tagBody,
    });
    const conflict = await app.request(`/api/entries/${entry.id}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: tagBody,
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: 'CONFLICT' },
    });
  });

  it('allows browser requests only from localhost origins by default', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);

    const local = await app.request('/api/entries/query', {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' },
      body: JSON.stringify({ entryType: 'game', conditions: [], page: 1, pageSize: 30 }),
    });
    expect(local.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');

    const remote = await app.request('/api/entries/query', {
      method: 'POST',
      headers: { Origin: 'https://example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ entryType: 'game', conditions: [], page: 1, pageSize: 30 }),
    });
    expect(remote.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('Entry management HTTP routes', () => {
  it('filters Entries and manages tags, Content, and layout', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);
    const section = createSection(database, { entryType: 'game', name: '基本信息' });
    const facet = createFacet(database, { sectionId: section.id, name: '游戏' });
    const entry = createEntry(database, { title: 'Endfield', type: 'game' });
    const tag = assignEntryTag(database, { entryId: entry.id, facetId: facet.id, name: 'ARPG' });
    const firstContent = createEntryContent(database, {
      entryId: entry.id,
      contentType: 'review',
      content: 'old',
    });
    const secondContent = createEntryContent(database, {
      entryId: entry.id,
      contentType: 'source url',
      content: 'https://example.test',
    });

    const search = await app.request('/api/entries/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entryType: 'game', conditions: [], includeTagIds: [tag.tagId], page: 1, pageSize: 30 }),
    });
    await expect(search.json()).resolves.toMatchObject({
      items: [
        { id: entry.id, title: 'Endfield', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null, viewCount: 0, likeCount: 0, lastViewedAt: null },
      ],
      total: 1,
    });
    await expect((await app.request(`/api/entries/${entry.id}/tags`)).json()).resolves.toEqual([
      expect.objectContaining({ tagId: tag.tagId, facetId: facet.id }),
    ]);

    expect((await app.request(`/api/contents/${firstContent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'updated' }),
    })).status).toBe(200);
    expect((await app.request(`/api/entries/${entry.id}/contents/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedContentIds: [secondContent.id, firstContent.id] }),
    })).status).toBe(200);
    expect((await app.request(`/api/contents/${secondContent.id}`, { method: 'DELETE' })).status)
      .toBe(200);
    expect((await app.request(`/api/entries/${entry.id}/tags/${tag.tagId}`, {
      method: 'DELETE',
    })).status).toBe(200);

    expect((await app.request(`/api/tag-groups/${facet.id}/name`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '玩法' }),
    })).status).toBe(200);
    expect((await app.request(`/api/tag-groups/${facet.id}/order`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sortOrder: 7 }),
    })).status).toBe(200);
    expect((await app.request(`/api/facets/${facet.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await app.request(`/api/sections/${section.id}`, { method: 'DELETE' })).status).toBe(200);

    const detail = await (await app.request(`/api/entries/${entry.id}`)).json();
    expect(detail).toMatchObject({
      sections: [],
      contents: [{ id: firstContent.id, content: 'updated', sortOrder: 1 }],
    });
  });
});

describe('Taxonomy HTTP routes', () => {
  it('creates, lists, and removes a generic alias', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);

    const createResponse = await app.request('/api/taxonomy-aliases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vocabulary: 'entry', alias: 'Bob', canonicalName: '鲍勃' }),
    });
    expect(createResponse.status).toBe(201);
    const alias = await createResponse.json() as { id: number };

    const listResponse = await app.request('/api/taxonomy-aliases?vocabulary=entry');
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject([
      { id: alias.id, vocabulary: 'entry', alias: 'Bob', canonicalName: '鲍勃' },
    ]);

    const importResponse = await app.request('/api/taxonomy-aliases/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aliases: [
          { vocabulary: 'entry', alias: 'Doctor', canonicalName: '博士' },
          { vocabulary: 'entry', alias: 'Kaltsit', canonicalName: '凯尔希' },
        ],
      }),
    });
    expect(importResponse.status).toBe(201);
    await expect(importResponse.json()).resolves.toHaveLength(2);

    expect((await app.request(`/api/taxonomy-aliases/${alias.id}`, { method: 'DELETE' })).status)
      .toBe(200);
    await expect((await app.request('/api/taxonomy-aliases')).json()).resolves.toHaveLength(2);
  });

  it('stores partition labels and keeps imported placeholder names without a canonical', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);

    const upsertResponse = await app.request('/api/taxonomy-aliases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vocabulary: 'entry',
        partition: 'characters',
        alias: 'bob',
        canonicalName: '鲍勃',
      }),
    });
    expect(upsertResponse.status).toBe(201);
    const created = await upsertResponse.json() as { partition: string };

    const importResponse = await app.request('/api/taxonomy-aliases/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aliases: [
          { vocabulary: 'producer', partition: 'authors', alias: 'alice', canonicalName: '' },
          { vocabulary: 'producer', partition: 'authors', alias: 'bob', canonicalName: '鮑勃' },
        ],
      }),
    });
    expect(importResponse.status).toBe(201);
    const imported = await importResponse.json() as Array<{ canonicalName: string }>;

    expect(created.partition).toBe('characters');
    expect(imported.find((alias) => alias.canonicalName === '')).toBeDefined();
    const list = await (await app.request('/api/taxonomy-aliases')).json() as Array<{
      vocabulary: string;
      partition: string;
      alias: string;
      canonicalName: string;
    }>;
    expect(list.find((alias) => alias.partition === 'authors')?.canonicalName).toBe('');
    // The completed 'producer' mapping from the second import row survived
    // (the entry-vocabulary 'bob' row is a separate vocabulary).
    expect(list.find((alias) => alias.vocabulary === 'producer' && alias.alias === 'bob')?.canonicalName)
      .toBe('鮑勃');
  });

  it('rejects a manual upsert with an empty canonical name', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);

    const response = await app.request('/api/taxonomy-aliases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vocabulary: 'entry', alias: 'bob', canonicalName: '' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('Producer merge HTTP routes', () => {
  it('plans and executes an identical-name merge and reports the change', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);

    const entry = await (await app.request('/api/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Banssee work', type: 'comic' }),
    })).json() as { id: number };
    const secondEntry = await (await app.request('/api/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Banssee work 2', type: 'comic' }),
    })).json() as { id: number };
    const first = await (await app.request('/api/producers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Banssee' }),
    })).json() as { id: number };
    const second = await (await app.request('/api/producers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Banssee' }),
    })).json() as { id: number };
    // Equal work counts (1:1) → keeper is the earliest id, i.e. `first`;
    // `second`'s work then genuinely relinks, exercising worksRelinked > 0.
    await app.request(`/api/entries/${entry.id}/producers/${first.id}`, { method: 'PUT' });
    await app.request(`/api/entries/${secondEntry.id}/producers/${second.id}`, { method: 'PUT' });

    const planResponse = await app.request('/api/producers/merge/plan', { method: 'POST' });
    expect(planResponse.status).toBe(200);
    const plan = await planResponse.json() as {
      plans: Array<{ canonicalName: string | null; keeper: { id: number }; others: unknown[] }>;
    };
    expect(plan.plans).toHaveLength(1);
    expect(plan.plans[0]).toMatchObject({ canonicalName: null, others: [{ id: second.id }] });

    const executeResponse = await app.request('/api/producers/merge', { method: 'POST' });
    expect(executeResponse.status).toBe(200);
    const executed = await executeResponse.json() as {
      backupPath: string | null;
      plans: Array<{ keeperId: number; keeperName: string; absorbedProducers: number; worksRelinked: number }>;
      totals: { deletedProducers: number; worksRelinked: number };
      foreignKeyCheckPass: boolean;
      doctorPass: boolean;
    };
    expect(executed.backupPath).toBeNull(); // in-memory database: no file backup
    expect(executed.plans).toHaveLength(1);
    expect(executed.plans[0]).toMatchObject({
      keeperId: first.id,
      keeperName: 'Banssee',
      absorbedProducers: 1,
      worksRelinked: 1,
    });
    expect(executed.totals).toMatchObject({ deletedProducers: 1, worksRelinked: 1 });
    expect(executed.foreignKeyCheckPass).toBe(true);
    expect(executed.doctorPass).toBe(true);

    // The surviving producer now owns both works; a second run has nothing to do.
    const detail = await (await app.request(`/api/entries/${entry.id}`)).json() as {
      producers: Array<{ id: number }>;
    };
    expect(detail.producers).toHaveLength(1);
    expect(detail.producers[0]!.id).toBe(first.id);
    const relinkedDetail = await (await app.request(`/api/entries/${secondEntry.id}`)).json() as {
      producers: Array<{ id: number }>;
    };
    expect(relinkedDetail.producers).toHaveLength(1);
    expect(relinkedDetail.producers[0]!.id).toBe(first.id);

    const again = await (await app.request('/api/producers/merge', { method: 'POST' })).json() as {
      plans: unknown[];
      totals: { deletedProducers: number };
    };
    expect(again.plans).toEqual([]);
    expect(again.totals.deletedProducers).toBe(0);
  });

  it('plans a dictionary-driven rename of a lone alias-spelled author', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);

    const producer = await (await app.request('/api/producers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bob' }),
    })).json() as { id: number };
    await app.request('/api/taxonomy-aliases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vocabulary: 'producer',
        partition: 'authors',
        alias: 'bob',
        canonicalName: '鲍勃',
      }),
    });

    const planResponse = await app.request('/api/producers/merge/plan', { method: 'POST' });
    const plan = await planResponse.json() as {
      plans: Array<{
        canonicalName: string | null;
        renamed: boolean;
        keeper: { id: number; name: string };
        others: unknown[];
      }>;
    };
    expect(plan.plans).toHaveLength(1);
    expect(plan.plans[0]).toMatchObject({
      canonicalName: '鲍勃',
      renamed: true,
      keeper: { id: producer.id, name: 'bob' },
      others: [],
    });

    const executed = await (await app.request('/api/producers/merge', { method: 'POST' })).json() as {
      plans: Array<{ renamedFrom: string | null; renamedTo: string | null }>;
    };
    expect(executed.plans[0]).toMatchObject({ renamedFrom: 'bob', renamedTo: '鲍勃' });
  });
});

describe('Layout and import HTTP routes', () => {
  it('reorders Section Facets through the HTTP route', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);

    const section = await (await app.request('/api/sections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryType: 'comic', name: 'Basic' }),
    })).json() as { id: number; defaultFacetId: number };

    const character = await (await app.request('/api/facets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sectionId: section.id, name: 'Character' }),
    })).json() as { id: number };

    const series = await (await app.request('/api/facets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sectionId: section.id, name: 'Series' }),
    })).json() as { id: number };

    const reorder = await app.request(`/api/sections/${section.id}/facets/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedFacetIds: [section.defaultFacetId, series.id, character.id] }),
    });
    expect(reorder.status).toBe(200);

    const layout = await (await app.request('/api/layouts/comic')).json() as Array<{
      facets: Array<{ name: string }>;
    }>;
    expect(layout[0]!.facets.map((facet) => facet.name)).toEqual(['', 'Series', 'Character']);
  });

  it('imports a Hitomi item and distributes fields to matching Facets with one clean Source URL', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);
    const basic = createSection(database, { entryType: 'comic', name: 'Basic Information' });
    const series = createFacet(database, { sectionId: basic.id, name: 'Series' });
    const characters = createFacet(database, { sectionId: basic.id, name: 'Characters' });
    const type = createFacet(database, { sectionId: basic.id, name: 'Type' });
    const language = createFacet(database, { sectionId: basic.id, name: 'Language' });
    const tags = createSection(database, { entryType: 'comic', name: 'Tags' });

    const url = 'https://hitomi.la/imageset/example-99.html';
    const commit = await app.request('/api/imports/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batch: {
          source: 'hitomi.la',
          warnings: [],
          entries: [{
            externalKey: 'hitomi.la:99',
            title: 'Work',
            tags: [{ name: 'Big Breasts' }],
            fields: {
              works: ['Azur Lane'],
              characters: ['Honolulu'],
              contentTypes: ['Image Set'],
              language: ['日本語'],
              authors: ['Akchu'],
            },
            sources: [{ label: 'hitomi.la', url }],
          }],
        },
        mapping: {
          entryType: 'comic',
          canonicalTagFacetId: tags.defaultFacetId,
          sourceContentType: 'Source URL',
          externalKeyContentType: 'External Key',
          fieldMappings: {
            works: { kind: 'tag', facetId: series.id },
            characters: { kind: 'tag', facetId: characters.id },
            contentTypes: { kind: 'tag', facetId: type.id },
            language: { kind: 'tag', facetId: language.id },
            authors: { kind: 'producer', createUnmatched: true, existingProducerIds: {} },
          },
          ignoredFields: [],
        },
      }),
    });
    expect(commit.status).toBe(201);
    const result = await commit.json() as { entries: Array<{ entryId: number }> };

    const detail = await (await app.request(`/api/entries/${result.entries[0]!.entryId}`)).json() as {
      contents: Array<{ contentType: string; content: string; id: number; sortOrder: number }>;
      producers: Array<{ name: string }>;
      sections: Array<{ name: string; facets: Array<{ name: string; tags: Array<{ name: string }> }> }>;
    };

    expect(detail.contents).toEqual([
      { contentType: 'Source URL', content: url, id: expect.any(Number), sortOrder: 0 },
    ]);
    const basicSection = detail.sections.find((section) => section.name === 'Basic Information')!;
    const tagsSection = detail.sections.find((section) => section.name === 'Tags')!;
    expect(basicSection.facets.find((facet) => facet.name === 'Series')!.tags.map((tag) => tag.name))
      .toEqual(['Azur Lane']);
    expect(basicSection.facets.find((facet) => facet.name === 'Characters')!.tags.map((tag) => tag.name))
      .toEqual(['Honolulu']);
    expect(basicSection.facets.find((facet) => facet.name === 'Type')!.tags.map((tag) => tag.name))
      .toEqual(['Image Set']);
    expect(basicSection.facets.find((facet) => facet.name === 'Language')!.tags.map((tag) => tag.name))
      .toEqual(['日本語']);
    expect(tagsSection.facets[0]!.tags.map((tag) => tag.name)).toEqual(['Big Breasts']);
    expect(detail.producers.map((producer) => producer.name)).toEqual(['Akchu']);
  });
});

describe('Layout template HTTP route', () => {
  it('applies the layout template from an Entry and reports relinks', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);
    const basic = createSection(database, { entryType: 'comic', name: 'Basic Information' });
    const series = createFacet(database, { sectionId: basic.id, name: 'Series' });
    const tags = createSection(database, { entryType: 'comic', name: 'Tags' });
    const entry = createEntry(database, { title: 'Work', type: 'comic' });
    assignEntryTag(database, { entryId: entry.id, facetId: series.id, name: 'Azur Lane' });
    void basic;
    void tags;

    const response = await app.request(`/api/entries/${entry.id}/template/apply`, { method: 'POST' });
    expect(response.status).toBe(200);
    const result = await response.json() as {
      entryType: string;
      entriesAffected: number;
      tagsRelinked: number;
      orphansMoved: number;
      sectionsRecreated: number;
      backupPath: string | null;
      foreignKeyCheckPass: boolean;
      doctorPass: boolean;
    };
    expect(result).toMatchObject({
      entryType: 'comic',
      entriesAffected: 1,
      tagsRelinked: 1,
      orphansMoved: 0,
      sectionsRecreated: 2,
      backupPath: null,
      foreignKeyCheckPass: true,
      doctorPass: true,
    });

    const missing = await app.request('/api/entries/9999/template/apply', { method: 'POST' });
    expect(missing.status).toBe(404);
  });
});

describe('Author alias group HTTP routes', () => {
  it('saves a group, merges duplicate spellings, and lists it back', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);

    const englishWork = createEntry(database, { title: 'English work', type: 'comic' });
    const displayWork = createEntry(database, { title: 'Display work', type: 'comic' });
    const english = createProducer(database, { name: 'pirate cat' });
    const display = createProducer(database, { name: '海盗猫' });
    linkEntryProducer(database, englishWork.id, english.id);
    linkEntryProducer(database, displayWork.id, display.id);

    const saveResponse = await app.request('/api/author-alias-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: '海盗猫', tagNames: ['pirate cat', '海盜貓'] }),
    });
    expect(saveResponse.status).toBe(201);
    const saved = await saveResponse.json() as {
      group: { canonicalName: string; aliases: unknown[]; producerId: number | null };
      merge: { totals: { deletedProducers: number; renamed: number } };
    };
    expect(saved.group.canonicalName).toBe('海盗猫');
    // The dictionary merge collapsed the alias-spelled producer into the
    // display-name row and relinked its work.
    expect(saved.merge.totals.deletedProducers).toBe(1);
    expect(saved.group.producerId).toBe(display.id);

    const listResponse = await app.request('/api/author-alias-groups');
    expect(listResponse.status).toBe(200);
    const listed = await listResponse.json() as {
      groups: Array<{ canonicalName: string; aliases: Array<{ name: string }>; producerId: number | null }>;
    };
    expect(listed.groups).toHaveLength(1);
    expect(listed.groups[0]!.aliases.map((alias) => alias.name).sort())
      .toEqual(['pirate cat', '海盜貓']);
    expect(listed.groups[0]!.producerId).toBe(display.id);

    const works = database.prepare(
      'SELECT entry_id FROM entry_producers WHERE producer_id = ? ORDER BY entry_id',
    ).pluck().all(display.id) as number[];
    expect(works.sort((left, right) => left - right)).toEqual([englishWork.id, displayWork.id]);
    expect(database.pragma('foreign_key_check')).toEqual([]);
  });

  it('lists gallery template summaries even with unnamed facets and unfiled tags', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const section = createSection(database, { entryType: 'comic', name: 'Info' });
    // A tag parked in the section's unnamed default Facet (name '') is normal
    // real-library data; the strict summary schema used to reject it with a
    // 400 Invalid request before the preview ever rendered.
    const work = createEntry(database, { title: 'Work', type: 'comic' });
    assignEntryTag(database, {
      entryId: work.id,
      facetId: section.defaultFacetId,
      name: 'Unfiled tag',
    });

    // The templates dir derives from the live database path.
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 't3-template-preview-'));
    temporaryDirectories.push(temporaryDirectory);
    const app = createApiApp(database, { databasePath: join(temporaryDirectory, 'library.db') });
    const response = await app.request('/api/templates');
    expect(response.status).toBe(200);
    const summaries = await response.json() as Array<{
      entryType: string;
      sections: Array<{ name: string; facets: string[] }>;
      mappings: Array<{ tag: string; section: string; facet: string }>;
    }>;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.entryType).toBe('comic');
    expect(summaries[0]!.sections[0]).toEqual({ name: 'Info', facets: [''] });
    expect(summaries[0]!.mappings[0]).toMatchObject({ tag: 'Unfiled tag', facet: '' });
  });

  it('rejects a group with duplicate tag names (400)', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);

    const response = await app.request('/api/author-alias-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: '海盗猫', tagNames: ['pirate cat', 'pirate cat'] }),
    });
    expect(response.status).toBe(400);
  });
});
