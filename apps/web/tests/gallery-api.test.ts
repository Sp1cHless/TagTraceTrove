import { describe, expect, it, vi } from 'vitest';
import { createGalleryApi } from '../src/api/gallery.js';
import type { ApiClient } from '../src/api/client.js';

describe('GalleryApi Entry Content', () => {
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

  it('finds Entries across Gallery types through one Entry Tag', async () => {
    const request = vi.fn(async () => [
      { id: 1, title: 'Endfield', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null },
      { id: 2, title: 'Witch Hat Atelier', type: 'manga', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null },
    ]);
    const api = createGalleryApi({ request } as unknown as ApiClient);

    await expect(api.findEntriesByTag(8)).resolves.toHaveLength(2);
    expect(request).toHaveBeenCalledWith('entries', {
      query: { includeTagIds: '8' },
    });
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
  it('finds Authors through the independent Producer Tag vocabulary', async () => {
    const request = vi.fn(async () => [{ id: 3, name: 'Author', covers: [], galleryType: null }]);
    const api = createGalleryApi({ request } as unknown as ApiClient);

    await expect(api.findAuthorsByTag(8)).resolves.toEqual(
      [{ id: 3, name: 'Author', covers: [], galleryType: null }],
    );
    expect(request).toHaveBeenCalledWith('producers', {
      query: { ownTagIds: '8' },
    });
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
      if (path === 'producers') return [{ id: 3, name: 'Author', galleryType: null }];
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
      };
      if (path === 'producers/3/directories') return directory;
      if (path === 'author-directories/5') return { ...directory, title: 'Selected works' };
      if (path.includes('/directories/5/entries/7')) return {
        ...directory,
        entries: [{ id: 7, title: 'Work', type: 'manga', coverRef: null }],
      };
      if (path.includes('/tags')) return { tagId: 8, name: 'Artist', normalizedName: 'artist' };
      if (path === 'entries/7/producers/3') return { ok: true };
      return { id: 3, name: 'Author', occupation: null, artworkRef: null, content: null };
    });
    const api = createGalleryApi({ request } as unknown as ApiClient);

    await expect(api.listAuthors()).resolves.toEqual(
      [{ id: 3, name: 'Author', covers: [], galleryType: null }],
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
