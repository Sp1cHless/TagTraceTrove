import { describe, expect, it, vi } from 'vitest';
import { createGalleryApi, resolveDefaultApiBaseUrl } from '../src/api/gallery.js';
import type { ApiClient } from '../src/api/client.js';

describe('default GalleryApi origin', () => {
  it('uses the serving origin in production while retaining the 8765 development default', () => {
    expect(resolveDefaultApiBaseUrl(undefined, true, 'http://127.0.0.1:8799')).toBe('http://127.0.0.1:8799/api/');
    expect(resolveDefaultApiBaseUrl(undefined, false, 'http://127.0.0.1:5173')).toBe('http://127.0.0.1:8765/api/');
    expect(resolveDefaultApiBaseUrl('http://localhost:9000/custom/', true, 'http://127.0.0.1:8799'))
      .toBe('http://localhost:9000/custom/');
  });
});

describe('GalleryApi Entry Content', () => {
  it('requests a bounded server-side Entry page with filters and sort', async () => {
    const page = {
      items: [{ id: 5, title: 'Middle', type: 'comic', coverRef: null, previewRef: null, previewRefs: [], uploadDate: '2024-03-01', pageCount: null, viewCount: 0, likeCount: 0, lastViewedAt: null }],
      total: 5,
      page: 2,
      pageSize: 1,
    };
    const request = vi.fn(async () => page);
    const api = createGalleryApi({ request } as unknown as ApiClient);
    const input = {
      entryType: 'comic',
      conditions: [],
      authorIds: [],
      ratingConditions: [],
      ratingSort: null,
      usageConditions: [],
      usageSort: null,
      sort: 'date-desc' as const,
      page: 2,
      pageSize: 1,
    };

    await expect(api.queryEntryPage(input)).resolves.toEqual(page);
    expect(request).toHaveBeenCalledWith('entries/query', {
      method: 'POST',
      body: input,
    });
  });

  it('reads and mutates the shared Entry and Author View later lists', async () => {
    const state = { entryIds: [2, 1], producerIds: [8] };
    const request = vi.fn(async () => state);
    const api = createGalleryApi({ request } as unknown as ApiClient);

    await expect(api.getViewLaterState()).resolves.toEqual(state);
    await expect(api.addViewLaterEntry(3)).resolves.toEqual(state);
    await expect(api.removeViewLaterEntry(2)).resolves.toEqual(state);
    await expect(api.mergeViewLaterEntries([1, 3])).resolves.toEqual(state);
    await expect(api.addViewLaterAuthor(9)).resolves.toEqual(state);
    await expect(api.removeViewLaterAuthor(8)).resolves.toEqual(state);

    expect(request).toHaveBeenNthCalledWith(1, 'view-later');
    expect(request).toHaveBeenNthCalledWith(2, 'view-later/3', { method: 'PUT' });
    expect(request).toHaveBeenNthCalledWith(3, 'view-later/2', { method: 'DELETE' });
    expect(request).toHaveBeenNthCalledWith(4, 'view-later/merge', {
      method: 'POST',
      body: { entryIds: [1, 3] },
    });
    expect(request).toHaveBeenNthCalledWith(5, 'view-later/producers/9', { method: 'PUT' });
    expect(request).toHaveBeenNthCalledWith(6, 'view-later/producers/8', { method: 'DELETE' });
  });

  it('previews a selected export folder and commits its reviewed mapping', async () => {
    const batch = {
      source: 'hitomi.la',
      entries: [{ externalKey: '42', title: 'Work' }],
      warnings: [],
    };
    const request = vi.fn(async (path: string, options?: unknown) => {
      void options;
      return path === 'imports/site-probe/preview'
        ? {
            batch,
            source: 'hitomi.la',
            entryCount: 1,
            tagAssignmentCount: 0,
            uniqueTagCount: 0,
            entriesMissingCover: 1,
            warnings: [],
          }
        : {
            entries: [{ entryId: 7, title: 'Work', externalKey: '42' }],
            entryCount: 1,
            createdProducerCount: 0,
            producerLinkCount: 0,
            tagAssignmentCount: 0,
            contentCount: 1,
          };
    });
    const api = createGalleryApi({ request } as unknown as ApiClient);
    const metadata = new File(['{}'], 'metadata.json', { type: 'application/json' });
    Object.defineProperty(metadata, 'webkitRelativePath', { value: 'export/metadata.json' });

    await expect(api.previewSiteProbeFolder([metadata])).resolves.toMatchObject({ entryCount: 1 });
    const mapping = {
      entryType: 'manga',
      canonicalTagFacetId: 3,
      sourceContentType: 'Source',
      externalKeyContentType: 'External ID',
      fieldMappings: {},
      ignoredFields: [],
    };
    await expect(api.commitImport(batch, mapping)).resolves.toMatchObject({ entryCount: 1 });

    const previewOptions = request.mock.calls[0]?.[1] as { formData: FormData };
    expect(previewOptions.formData.getAll('files')).toEqual([metadata]);
    expect(previewOptions.formData.getAll('paths')).toEqual(['export/metadata.json']);
    expect(request).toHaveBeenCalledWith('imports/commit', {
      method: 'POST',
      body: { batch, mapping },
    });
  });

  it('uploads managed cover media as multipart form data', async () => {
    const request = vi.fn(async () => ({
      id: 7,
      title: 'Entry',
      type: 'comic',
      coverRef: '/api/assets/entries/7/cover.png',
      previewRef: null,
      previewRefs: [],
      uploadDate: null,
      pageCount: null,
    }));
    const api = createGalleryApi({ request } as unknown as ApiClient);
    const file = new File(['cover'], 'cover.png', { type: 'image/png' });

    await expect(api.uploadEntryMedia(7, 'cover', file)).resolves.toMatchObject({ id: 7 });
    const [, options] = request.mock.calls[0] as unknown as [string, { formData: FormData }];
    const formData = options.formData;
    expect(request).toHaveBeenCalledWith('entries/7/media/cover', expect.objectContaining({ method: 'PUT' }));
    expect(formData.get('file')).toBe(file);
  });

  it('queries bounded Entry/Author search pages and the Tag search endpoint', async () => {
    const request = vi.fn(async (path: string) => {
      if (path === 'entries/query') return { items: [
          { id: 1, title: 'Endfield', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null, viewCount: 0, likeCount: 0, lastViewedAt: null },
        ], total: 1, page: 1, pageSize: 30 };
      if (path === 'search/tags') return [
        { tagId: 8, name: 'Endfield', normalizedName: 'endfield', entryCount: 1 },
      ];
      return { items: [
          { id: 9, name: 'Hypergryph', covers: [], galleryType: 'game', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false },
        ], total: 1, page: 1, pageSize: 30 };
    });
    const api = createGalleryApi({ request } as unknown as ApiClient);
    const entryInput = {
      conditions: [], authorIds: [], ratingConditions: [], ratingSort: null,
      usageConditions: [], usageSort: null, searchQuery: 'end', sort: 'date-desc' as const,
      page: 1, pageSize: 30,
    };
    const producerInput = {
      searchQuery: 'hyper', ownTagIds: [], relatedEntryTagIds: [], includeNsfw: true,
      sort: 'relevance' as const, page: 1, pageSize: 30,
    };

    await expect(api.queryEntryPage(entryInput)).resolves.toMatchObject({ total: 1 });
    await expect(api.searchTags('end', false)).resolves.toHaveLength(1);
    await expect(api.queryProducerPage(producerInput)).resolves.toMatchObject({ total: 1 });
    expect(request).toHaveBeenNthCalledWith(1, 'entries/query', { method: 'POST', body: entryInput });
    expect(request).toHaveBeenNthCalledWith(2, 'search/tags', { query: { q: 'end', includeNsfw: 'false' } });
    expect(request).toHaveBeenNthCalledWith(3, 'producers/query', { method: 'POST', body: producerInput });
  });

  it('finds Entries across Gallery types through a bounded Entry Tag query', async () => {
    const response = { items: [
        { id: 1, title: 'Endfield', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null, viewCount: 0, likeCount: 0, lastViewedAt: null },
        { id: 2, title: 'Witch Hat Atelier', type: 'manga', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null, viewCount: 0, likeCount: 0, lastViewedAt: null },
      ], total: 2, page: 1, pageSize: 30 };
    const request = vi.fn(async () => response);
    const api = createGalleryApi({ request } as unknown as ApiClient);
    const input = {
      conditions: [], authorIds: [], ratingConditions: [], ratingSort: null,
      usageConditions: [], usageSort: null, includeTagIds: [8], sort: 'date-desc' as const,
      page: 1, pageSize: 30,
    };

    await expect(api.queryEntryPage(input)).resolves.toEqual(response);
    expect(request).toHaveBeenCalledWith('entries/query', { method: 'POST', body: input });
  });

  it('creates Content under the active Entry through the HTTP boundary', async () => {
    const request = vi.fn(async () => ({
      id: 21,
      entryId: 7,
      contentType: 'short review',
      content: 'Worth replaying',
      sortOrder: 1,
    }));
    const api = createGalleryApi({ request } as unknown as ApiClient);

    await expect(api.createEntryContent(7, {
      contentType: 'short review',
      content: 'Worth replaying',
      sortOrder: 1,
    })).resolves.toMatchObject({ id: 21, entryId: 7 });
    expect(request).toHaveBeenCalledWith('entries/7/contents', {
      method: 'POST',
      body: {
        contentType: 'short review',
        content: 'Worth replaying',
        sortOrder: 1,
      },
    });
  });

  it('updates one Content row through its dedicated route', async () => {
    const request = vi.fn(async () => ({
      id: 21,
      entryId: 7,
      contentType: 'review',
      content: 'Updated body',
      sortOrder: 1,
    }));
    const api = createGalleryApi({ request } as unknown as ApiClient);

    await expect(api.updateEntryContent(21, {
      contentType: 'review',
      content: 'Updated body',
    })).resolves.toMatchObject({ id: 21, content: 'Updated body' });
    expect(request).toHaveBeenCalledWith('contents/21', {
      method: 'PATCH',
      body: { contentType: 'review', content: 'Updated body' },
    });
  });

  it('deletes one Content row through its dedicated route', async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const api = createGalleryApi({ request } as unknown as ApiClient);

    await api.deleteEntryContent(21);

    expect(request).toHaveBeenCalledWith('contents/21', { method: 'DELETE' });
  });

  it('persists the complete ordered Content ID list for an Entry', async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const api = createGalleryApi({ request } as unknown as ApiClient);

    await api.reorderEntryContents(7, [22, 21]);

    expect(request).toHaveBeenCalledWith('entries/7/contents/order', {
      method: 'PUT',
      body: { orderedContentIds: [22, 21] },
    });
  });

  it('renames one Entry Tag assignment through its dedicated route', async () => {
    const request = vi.fn(async () => ({
      tagId: 23,
      name: 'Action RPG',
      normalizedName: 'action rpg',
      facetId: 4,
    }));
    const api = createGalleryApi({ request } as unknown as ApiClient);

    await api.renameEntryTag(7, 21, 'Action RPG');

    expect(request).toHaveBeenCalledWith('entries/7/tags/21/name', {
      method: 'PATCH',
      body: { name: 'Action RPG' },
    });
  });
});

describe('GalleryApi Authors', () => {
  it('loads Author filter options and combines both independent Tag groups', async () => {
    const summary = { id: 3, name: 'Author', covers: [], galleryType: 'Comic', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false };
    const page = { items: [summary], total: 1, page: 1, pageSize: 30 };
    const request = vi.fn(async (path: string) => (path === 'producers/filter-options'
      ? {
          authorTags: [{ tagId: 2, name: 'Circle' }],
          workTags: [{ tagId: 5, name: 'Action' }],
        }
      : page));
    const api = createGalleryApi({ request } as unknown as ApiClient);

    await expect(api.listAuthorFilterOptions('Comic', false)).resolves.toEqual({
      authorTags: [{ tagId: 2, name: 'Circle' }],
      workTags: [{ tagId: 5, name: 'Action' }],
    });
    const input = {
      ownTagIds: [2, 3], relatedEntryTagIds: [5, 8], includeNsfw: true,
      sort: 'name-asc' as const, page: 1, pageSize: 30,
    };
    await expect(api.queryProducerPage(input)).resolves.toEqual(page);
    expect(request).toHaveBeenCalledWith('producers/filter-options', {
      query: { entryType: 'Comic', includeNsfw: 'false' },
    });
    expect(request).toHaveBeenCalledWith('producers/query', { method: 'POST', body: input });
  });

  it('finds Authors through a bounded independent Producer Tag query', async () => {
    const page = { items: [{ id: 3, name: 'Author', covers: [], galleryType: null, viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false }], total: 1, page: 1, pageSize: 30 };
    const request = vi.fn(async () => page);
    const api = createGalleryApi({ request } as unknown as ApiClient);
    const input = {
      ownTagIds: [8], relatedEntryTagIds: [], includeNsfw: true,
      sort: 'name-asc' as const, page: 1, pageSize: 30,
    };

    await expect(api.queryProducerPage(input)).resolves.toEqual(page);
    expect(request).toHaveBeenCalledWith('producers/query', { method: 'POST', body: input });
  });

  it('uses Producer HTTP routes behind Author-facing client methods', async () => {
    const directory = {
      id: 5,
      producerId: 3,
      title: 'New Directory',
      description: '',
      sortOrder: 0,
      entries: [],
    };
    const request = vi.fn(async (path: string, options?: { method?: string }) => {
      if (path === 'producers' && options?.method === 'POST') {
        return { id: 3, name: 'Author', occupation: null, artworkRef: null, content: null };
      }
      if (path === 'producers') return [{ id: 3, name: 'Author', galleryType: null, viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false }];
      if (path === 'producers/3' && options?.method === 'PATCH') {
        return { id: 3, name: 'Author', occupation: null, artworkRef: null, content: 'Note' };
      }
      if (path === 'producers/3') return {
        id: 3,
        name: 'Author',
        occupation: null,
        artworkRef: null,
        content: null,
        galleryType: null,
        tags: [],
        looseEntries: [],
        directories: [],
        ratings: [],
        usage: { viewCount: 0, likeCount: 0, lastViewedAt: null },
      };
      if (path === 'producers/3/directories') return directory;
      if (path === 'author-directories/5') return { ...directory, title: 'Selected works' };
      if (path.includes('/directories/5/entries/7')) return {
        ...directory,
        entries: [{
          id: 7,
          title: 'Work',
          type: 'manga',
          coverRef: null,
          viewCount: 0,
          likeCount: 0,
          lastViewedAt: null,
        }],
      };
      if (path.includes('/tags')) return { tagId: 8, name: 'Artist', normalizedName: 'artist' };
      if (path === 'entries/7/producers/3') return { ok: true };
      return { id: 3, name: 'Author', occupation: null, artworkRef: null, content: null };
    });
    const api = createGalleryApi({ request } as unknown as ApiClient);

    await expect(api.listAuthors()).resolves.toEqual(
      [{ id: 3, name: 'Author', covers: [], galleryType: null, viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false }],
    );
    await expect(api.getAuthor(3)).resolves.toMatchObject({ id: 3, directories: [] });
    await api.createAuthor({ name: 'Author' });
    await api.updateAuthor(3, { content: 'Note' });
    await api.linkEntryAuthor(7, 3);
    await api.unlinkEntryAuthor(7, 3);
    await api.assignAuthorTag(3, 'Artist');
    await api.renameAuthorTag(3, 8, 'Illustrator');
    await api.removeAuthorTag(3, 8);
    await api.createAuthorDirectory(3, { title: 'New Directory', entryIds: [7, 9] });
    await api.updateAuthorDirectory(5, { title: 'Selected works' });
    await api.moveEntryToAuthorDirectory(3, 5, 7);
    await api.removeEntryFromAuthorDirectory(3, 5, 7);

    expect(request).toHaveBeenCalledWith('producers', { method: 'POST', body: { name: 'Author' } });
    expect(request).toHaveBeenCalledWith('producers/3', {
      method: 'PATCH',
      body: { content: 'Note' },
    });
    expect(request).toHaveBeenCalledWith('entries/7/producers/3', { method: 'PUT' });
    expect(request).toHaveBeenCalledWith('entries/7/producers/3', { method: 'DELETE' });
    expect(request).toHaveBeenCalledWith('producers/3/tags', {
      method: 'POST', body: { name: 'Artist' },
    });
    expect(request).toHaveBeenCalledWith('producers/3/tags/8/name', {
      method: 'PATCH', body: { name: 'Illustrator' },
    });
    expect(request).toHaveBeenCalledWith('producers/3/tags/8', { method: 'DELETE' });
    expect(request).toHaveBeenCalledWith('producers/3/directories', {
      method: 'POST', body: { title: 'New Directory', entryIds: [7, 9] },
    });
    expect(request).toHaveBeenCalledWith('author-directories/5', {
      method: 'PATCH', body: { title: 'Selected works' },
    });
    expect(request).toHaveBeenCalledWith('producers/3/directories/5/entries/7', { method: 'PUT' });
    expect(request).toHaveBeenCalledWith('producers/3/directories/5/entries/7', { method: 'DELETE' });
  });
});
