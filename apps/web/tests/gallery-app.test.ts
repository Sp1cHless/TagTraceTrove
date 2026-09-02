// @vitest-environment jsdom

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GalleryApp from '../src/GalleryApp.vue';
import type { GalleryApi } from '../src/api/gallery.js';
import { setLocale } from '../src/i18n.js';

function createMemoryApi(options: {
  withAuthors?: boolean;
  withDirectory?: boolean;
  withUnlinkedAuthor?: boolean;
  extraFacets?: Array<{
    entryId: number;
    id: number;
    name: string;
    sortOrder?: number;
    tags?: Array<{ id: number; name: string; normalizedName: string }>;
  }>;
} = {}): GalleryApi {
  const entries = [
    { id: 1, title: 'Endfield', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null },
    { id: 2, title: 'Hades II', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null },
    { id: 3, title: 'Witch Hat Atelier', type: 'manga', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null },
  ];
  const authors = options.withAuthors === false ? [] : [{
    id: 9,
    name: 'Hypergryph',
    occupation: 'Developer' as string | null,
    artworkRef: null as string | null,
    content: null as string | null,
  }, ...(options.withUnlinkedAuthor ? [{
    id: 10,
    name: 'Guest Artist',
    occupation: null as string | null,
    artworkRef: null as string | null,
    content: null as string | null,
  }] : [])];
  const linkedAuthorIds = new Map<number, number[]>(
    entries.map((entry) => [entry.id, authors.filter((author) => author.id === 9).map((author) => author.id)]),
  );
  let authorTags = [{ tagId: 30, name: 'Studio', normalizedName: 'studio' }];
  let authorDirectories: Array<{
    id: number;
    producerId: number;
    title: string;
    description: string;
    sortOrder: number;
    entries: Array<{ id: number; title: string; type: string; coverRef: string | null }>;
  }> = options.withDirectory ? [{
    id: 1,
    producerId: 9,
    title: 'Selected works',
    description: 'Directory note',
    sortOrder: 0,
    entries: [{ ...entries[0]!, coverRef: null }],
  }] : [];
  const entryTags = new Map<number, number[]>([
    [1, [1, 2]],
    [2, [1]],
    [3, [3]],
  ]);
  let assignedTagName: string | null = null;
  let assignedTagEntryId: number | null = null;
  let assignedTagFacetId: number | null = null;
  let mangaSectionName: string | null = null;
  let extraSectionName: string | null = null;
  let createdFacetName: string | null = null;
  let movedTagFacetId = 11;
  let renamedTagName = 'ARPG';
  let removedTag = false;
  let deletedContent = false;
  let baseContent = {
    id: 13,
    entryId: 1,
    contentType: 'note',
    content: 'A saved note',
    sortOrder: 0,
  };
  let createdContent: {
    id: number;
    entryId: number;
    contentType: string;
    content: string;
    sortOrder: number;
  } | null = null;
  return {
    assetUrl(path) {
      return path;
    },
    async deleteEntry(entryId) {
      const index = entries.findIndex((item) => item.id === entryId);
      if (index >= 0) entries.splice(index, 1);
    },
    async deleteAuthor(authorId) {
      const index = authors.findIndex((item) => item.id === authorId);
      if (index >= 0) authors.splice(index, 1);
    },
    async listGalleries() {
      const counts = new Map<string, number>();
      for (const entry of entries) {
        counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
      }
      return [...counts].map(([type, entryCount]) => ({ type, entryCount }));
    },
    async listEntries(type, filters?: { includeTagIds?: number[]; excludeTagIds?: number[] }) {
      return entries.filter((entry) => {
        if (entry.type !== type) return false;
        const tags = entryTags.get(entry.id) ?? [];
        return (filters?.includeTagIds ?? []).every((tagId) => tags.includes(tagId))
          && (filters?.excludeTagIds ?? []).every((tagId) => !tags.includes(tagId));
      });
    },
    async findEntriesByTag(tagId) {
      return tagId === 12 ? entries.filter((entry) => entry.id !== 3) : [];
    },
    async listFacetFilterOptions(type) {
      if (type !== 'game') return { entryType: type, facets: [], allTags: [], authors: [] };
      return {
        entryType: 'game',
        facets: [{
          facetId: 11,
          facetName: 'Genre',
          sectionName: 'Basic Information',
          tags: [
            { tagId: 1, name: 'ARPG' },
            { tagId: 2, name: 'Sci-fi' },
          ],
        }],
        allTags: [
          { tagId: 1, name: 'ARPG' },
          { tagId: 2, name: 'Sci-fi' },
          { tagId: 3, name: 'Fantasy' },
        ],
        authors: [{ authorId: 9, name: 'Hypergryph' }],
      };
    },
    async filterEntriesByFacets(type, conditions, authorIds) {
      return entries.filter((entry) => {
        if (entry.type !== type) return false;
        const tags = entryTags.get(entry.id) ?? [];
        const rowsMatch = conditions.every((condition) => (
          condition.tagIds.every((tagId) => tags.includes(tagId))
        ));
        if (!rowsMatch) return false;
        if (authorIds.length === 0) return true;
        const linked = linkedAuthorIds.get(entry.id) ?? [];
        return authorIds.some((authorId) => linked.includes(authorId));
      });
    },
    async applyEntryTagLayout() {
      return {
        entryType: 'game',
        entriesAffected: 0,
        tagsMoved: 0,
        entriesScanned: 0,
        backupPath: null,
        foreignKeyCheckPass: true,
        doctorPass: true,
        doctorIssues: [],
      };
    },
    async listGalleryTags(type) {
      if (type === 'game') {
        return [
          { id: 1, name: 'ARPG', normalizedName: 'arpg', entryCount: 2 },
          { id: 2, name: 'Sci-fi', normalizedName: 'sci-fi', entryCount: 1 },
        ];
      }
      return [{ id: 3, name: 'Fantasy', normalizedName: 'fantasy', entryCount: 1 }];
    },
    async createEntry(input) {
      const created = {
        id: entries.length + 1,
        title: input.title.trim(),
        type: input.type.trim(),
        coverRef: null,
        previewRef: null,
        previewRefs: [],
        uploadDate: null,
        pageCount: null,
      };
      entries.push(created);
      return created;
    },
    async uploadEntryMedia(entryId, kind, file) {
      void file;
      const entry = entries.find((item) => item.id === entryId);
      if (!entry) throw new Error('Entry not found');
      return {
        ...entry,
        coverRef: kind === 'cover' ? `/api/assets/entries/${entryId}/cover.png` : null,
        previewRef: kind === 'preview' ? `/api/assets/entries/${entryId}/preview.png` : null,
        previewRefs: kind === 'preview' ? [`/api/assets/entries/${entryId}/preview.png`] : [],
        uploadDate: null,
        pageCount: entry.pageCount ?? null,
      };
    },
    async previewSiteProbeFolder() {
      throw new Error('Not implemented in memory API');
    },
    async commitImport() {
      throw new Error('Not implemented in memory API');
    },
    async listTaxonomyAliases() {
      return [];
    },
    async upsertTaxonomyAlias() {
      throw new Error('Not implemented in memory API');
    },
    async importTaxonomyAliases() {
      return [];
    },
    async deleteTaxonomyAlias() {},
    async listLayout() {
      return [];
    },
    async getEntry(entryId) {
      const entry = entries.find((item) => item.id === entryId);
      if (!entry) {
        throw new Error('Entry not found');
      }
      const hasLayout = entryId !== 3 || mangaSectionName !== null;
      return {
        ...entry,
        coverRef: null,
        previewRef: null,
        previewRefs: [],
        uploadDate: null,
        pageCount: null,
        producers: authors.filter((author) => (linkedAuthorIds.get(entryId) ?? []).includes(author.id)),
        sections: hasLayout ? [{
          id: 10,
          name: entryId === 3 ? mangaSectionName as string : 'Basics',
          sortOrder: 0,
          facets: [{
            id: 11,
            name: '',
            sortOrder: 0,
            tags: [
              ...(!removedTag && (entryId === 1 || entryId === 2) && movedTagFacetId === 11
                ? [{ id: 12, name: renamedTagName, normalizedName: renamedTagName.toLowerCase() }]
                : []),
              ...(assignedTagName && assignedTagEntryId === entryId && assignedTagFacetId === 11
                ? [{ id: 14, name: assignedTagName, normalizedName: assignedTagName.toLowerCase() }]
                : []),
            ],
          }, ...(entryId === 2 ? [{
            id: 15,
            name: 'Genre',
            sortOrder: 1,
            tags: [
              ...(movedTagFacetId === 15
                ? [{ id: 12, name: renamedTagName, normalizedName: renamedTagName.toLowerCase() }]
                : []),
              ...(assignedTagName && assignedTagEntryId === entryId && assignedTagFacetId === 15
                ? [{ id: 14, name: assignedTagName, normalizedName: assignedTagName.toLowerCase() }]
                : []),
            ],
          }] : []), ...(createdFacetName && entryId === 1 ? [{
            id: 16,
            name: createdFacetName,
            sortOrder: 1,
            tags: [
              ...(movedTagFacetId === 16
                ? [{ id: 12, name: renamedTagName, normalizedName: renamedTagName.toLowerCase() }]
                : []),
              ...(assignedTagName && assignedTagEntryId === entryId && assignedTagFacetId === 16
                ? [{ id: 14, name: assignedTagName, normalizedName: assignedTagName.toLowerCase() }]
                : []),
            ],
          }] : []), ...(options.extraFacets ?? [])
            .filter((facet) => facet.entryId === entryId)
            .map((facet) => ({
              id: facet.id,
              name: facet.name,
              sortOrder: facet.sortOrder ?? 1,
              tags: facet.tags ?? [],
            }))],
        }, ...(extraSectionName && entry.type === 'game' ? [{
          id: 20,
          name: extraSectionName,
          sortOrder: 1,
          facets: [{ id: 21, name: '', sortOrder: 0, tags: [] }],
        }] : [])] : [],
        contents: [
          ...(!deletedContent ? [{
            id: baseContent.id,
            contentType: baseContent.contentType,
            content: baseContent.content,
            sortOrder: baseContent.sortOrder,
          }] : []),
          ...(createdContent?.entryId === entryId ? [{
            id: createdContent.id,
            contentType: createdContent.contentType,
            content: createdContent.content,
            sortOrder: createdContent.sortOrder,
          }] : []),
        ].sort((left, right) => left.sortOrder - right.sortOrder),
      };
    },
    async createEntryContent(entryId, input) {
      createdContent = {
        id: 14,
        entryId,
        contentType: input.contentType.trim(),
        content: input.content,
        sortOrder: input.sortOrder ?? 0,
      };
      return createdContent;
    },
    async updateEntryContent(contentId, input) {
      if (contentId === baseContent.id) {
        baseContent = {
          ...baseContent,
          contentType: input.contentType ?? baseContent.contentType,
          content: input.content ?? baseContent.content,
          sortOrder: input.sortOrder ?? baseContent.sortOrder,
        };
        return baseContent;
      }
      if (createdContent?.id === contentId) {
        const updated = {
          ...createdContent,
          contentType: input.contentType ?? createdContent.contentType,
          content: input.content ?? createdContent.content,
          sortOrder: input.sortOrder ?? createdContent.sortOrder,
        };
        createdContent = updated;
        return updated;
      }
      throw new Error('Entry content not found');
    },
    async deleteEntryContent(contentId) {
      if (contentId !== baseContent.id) throw new Error('Entry content not found');
      deletedContent = true;
    },
    async reorderEntryContents(_entryId, orderedContentIds) {
      orderedContentIds.forEach((contentId, sortOrder) => {
        if (contentId === baseContent.id) baseContent.sortOrder = sortOrder;
        if (createdContent?.id === contentId) createdContent.sortOrder = sortOrder;
      });
    },
    async reorderSectionFacets() {},
    async createSection(input) {
      if (input.entryType === 'manga') mangaSectionName = input.name.trim();
      else extraSectionName = input.name.trim();
    },
    async createFacet(input) {
      createdFacetName = input.name.trim();
    },
    async assignEntryTag(entryId, input) {
      assignedTagName = input.name.trim();
      assignedTagEntryId = entryId;
      assignedTagFacetId = input.facetId;
    },
    async moveEntryTag(_entryId, _tagId, targetFacetId) {
      movedTagFacetId = targetFacetId;
    },
    async renameEntryTag(_entryId, _tagId, name) {
      renamedTagName = name.trim();
    },
    async removeEntryTag() {
      removedTag = true;
    },
    async listAuthors() {
      return authors.map(({ id, name }) => ({ id, name, covers: [], galleryType: 'game' }));
    },
    async findAuthorsByTag(tagId) {
      return tagId === 30
        ? authors.filter((author) => author.id === 9).map(({ id, name }) => ({ id, name, covers: [] }))
        : [];
    },
    async getAuthor(authorId) {
      const author = authors.find((item) => item.id === authorId);
      if (!author) throw new Error('Author not found');
      const groupedIds = new Set(authorDirectories.flatMap((directory) => (
        directory.entries.map((entry) => entry.id)
      )));
      return {
        ...author,
        galleryType: 'game',
        tags: authorTags,
        looseEntries: entries
          .filter((entry) => (linkedAuthorIds.get(entry.id) ?? []).includes(authorId)
            && !groupedIds.has(entry.id))
          .map((entry) => ({ ...entry, coverRef: null })),
        directories: authorDirectories,
      };
    },
    async createAuthor(input) {
      const author = {
        id: Math.max(0, ...authors.map((item) => item.id)) + 1,
        name: input.name.trim(),
        occupation: input.occupation ?? null,
        artworkRef: input.artworkRef ?? null,
        content: input.content ?? null,
      };
      authors.push(author);
      return author;
    },
    async updateAuthor(authorId, input) {
      const author = authors.find((item) => item.id === authorId);
      if (!author) throw new Error('Author not found');
      Object.assign(author, input);
      return author;
    },
    async linkEntryAuthor(entryId, authorId) {
      linkedAuthorIds.set(entryId, [...new Set([...(linkedAuthorIds.get(entryId) ?? []), authorId])]);
    },
    async unlinkEntryAuthor(entryId, authorId) {
      linkedAuthorIds.set(entryId, (linkedAuthorIds.get(entryId) ?? []).filter((id) => id !== authorId));
    },
    async assignAuthorTag(_authorId, name) {
      authorTags.push({ tagId: 31, name: name.trim(), normalizedName: name.trim().toLowerCase() });
    },
    async renameAuthorTag(_authorId, tagId, name) {
      authorTags = authorTags.map((tag) => tag.tagId === tagId
        ? { ...tag, name: name.trim(), normalizedName: name.trim().toLowerCase() }
        : tag);
    },
    async removeAuthorTag(_authorId, tagId) {
      authorTags = authorTags.filter((tag) => tag.tagId !== tagId);
    },
    async createAuthorDirectory(authorId, input) {
      const directory = {
        id: authorDirectories.length + 1,
        producerId: authorId,
        title: input.title,
        description: input.description ?? '',
        sortOrder: authorDirectories.length,
        entries: entries.filter((entry) => (input.entryIds ?? []).includes(entry.id))
          .map((entry) => ({ ...entry, coverRef: null })),
      };
      authorDirectories.push(directory);
      return directory;
    },
    async updateAuthorDirectory(directoryId, input) {
      const directory = authorDirectories.find((item) => item.id === directoryId);
      if (!directory) throw new Error('Directory not found');
      Object.assign(directory, input);
      return directory;
    },
    async moveEntryToAuthorDirectory(_authorId, directoryId, entryId) {
      const directory = authorDirectories.find((item) => item.id === directoryId);
      const entry = entries.find((item) => item.id === entryId);
      if (!directory || !entry) throw new Error('Directory or Entry not found');
      authorDirectories = authorDirectories.map((item) => ({
        ...item,
        entries: item.id === directoryId
          ? [...item.entries.filter((work) => work.id !== entryId), { ...entry, coverRef: null }]
          : item.entries.filter((work) => work.id !== entryId),
      }));
      return authorDirectories.find((item) => item.id === directoryId) as typeof directory;
    },
    async removeEntryFromAuthorDirectory(_authorId, directoryId, entryId) {
      authorDirectories = authorDirectories.map((item) => ({
        ...item,
        entries: item.id === directoryId
          ? item.entries.filter((work) => work.id !== entryId)
          : item.entries,
      }));
      return authorDirectories.find((item) => item.id === directoryId) as typeof authorDirectories[number];
    },
    async planProducerMerge() {
      return { plans: [] };
    },
    async executeProducerMerge() {
      return {
        backupPath: null,
        plans: [],
        totals: {
          deletedProducers: 0,
          worksRelinked: 0,
          tagsRelinked: 0,
          directoriesMoved: 0,
          directoriesMerged: 0,
          membershipsMoved: 0,
          membershipsRemoved: 0,
          renamed: 0,
        },
        foreignKeyCheckPass: true,
        doctorPass: true,
        doctorIssues: [],
      };
    },
    async applyEntryLayoutTemplate() {
      return {
        entryType: 'game',
        entriesAffected: 0,
        tagsRelinked: 0,
        orphansMoved: 0,
        sectionsRecreated: 0,
        backupPath: null,
        foreignKeyCheckPass: true,
        doctorPass: true,
        doctorIssues: [],
      };
    },
    async deleteFacet() {
      // no-op in the in-memory fixture
    },
  };
}

async function openEntryForEditing(wrapper: VueWrapper, entryId: number): Promise<void> {
  await wrapper.get(`[data-entry-id="${entryId}"]`).trigger('click');
  await flushPromises();
  await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');
  await flushPromises();
}

describe('GalleryApp', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setLocale('en');
  });

  it('opens Settings and switches all UI copy between English and Chinese', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();

    expect(wrapper.get('h1').text()).toBe('Galleries');
    await wrapper.get('[data-testid="settings-button"]').trigger('click');
    expect(wrapper.get('[data-testid="settings-panel"]').text()).toContain('Language');

    await wrapper.get('[data-testid="language-select"]').setValue('zh-CN');

    expect(wrapper.get('h1').text()).toBe('画廊');
    expect(wrapper.get('[data-testid="settings-panel"]').text()).toContain('语言');
    expect(wrapper.get('[data-testid="add-entry-navigation"]').text()).toContain('新建条目');
    await wrapper.get('[data-testid="settings-button"]').trigger('click');
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    expect(wrapper.get('[data-testid="add-entry-page"]').text()).toContain('导入导出文件夹');
    expect(wrapper.get('[data-testid="add-entry-page"]').text()).not.toContain('Canonical Tags');
    expect(window.localStorage.getItem('t3.locale')).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('manages generic taxonomy aliases from the Advanced editing page', async () => {
    const api = createMemoryApi();
    const aliases: Array<{
      id: number;
      vocabulary: 'entry' | 'producer';
      partition: string;
      alias: string;
      normalizedAlias: string;
      canonicalName: string;
      normalizedCanonical: string;
    }> = [{
      id: 1,
      vocabulary: 'entry',
      partition: '',
      alias: 'alice',
      normalizedAlias: 'alice',
      canonicalName: '',
      normalizedCanonical: '',
    }];
    api.listTaxonomyAliases = vi.fn(async () => [...aliases]);
    api.upsertTaxonomyAlias = vi.fn(async (input) => {
      const created = {
        id: aliases.length + 1,
        ...input,
        normalizedAlias: input.alias.toLocaleLowerCase(),
        normalizedCanonical: input.canonicalName.toLocaleLowerCase(),
      };
      aliases.push(created);
      return created;
    });
    api.deleteTaxonomyAlias = vi.fn(async (id) => {
      aliases.splice(aliases.findIndex((alias) => alias.id === id), 1);
    });
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="settings-button"]').trigger('click');
    await wrapper.get('[data-testid="advanced-entry"]').trigger('click');
    await flushPromises();
    const form = wrapper.get('[data-testid="taxonomy-alias-form"]');
    await form.get('[name="taxonomyAlias"]').setValue('Bob');
    await form.get('[name="taxonomyCanonicalName"]').setValue('鲍勃');
    await form.trigger('submit');
    await flushPromises();

    // Groups start collapsed: the list body is hidden until expanded.
    expect(wrapper.find('[data-testid="taxonomy-alias-list"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="taxonomy-group-unpartitioned"]').text()).toContain('2');
    await wrapper.get('[data-testid="taxonomy-group-unpartitioned"]').trigger('click');
    expect(wrapper.get('[data-testid="taxonomy-alias-list"]').text()).toContain('Bob → 鲍勃');
    expect(api.upsertTaxonomyAlias).toHaveBeenCalledWith({
      vocabulary: 'entry',
      partition: '',
      alias: 'Bob',
      canonicalName: '鲍勃',
    });

    // "Show only unmatched" narrows the list to placeholder rows and expands
    // groups automatically.
    await wrapper.get('[data-testid="taxonomy-unmatched-only"]').setValue(true);
    await flushPromises();
    const unmatchedText = wrapper.get('[data-testid="taxonomy-alias-list"]').text();
    expect(unmatchedText).toContain('alice →');
    expect(unmatchedText).not.toContain('鲍勃');
  });

  it('lists Galleries derived from Entry types and browses one type', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();

    expect(wrapper.get('[data-gallery-type="game"]').text()).toContain('2');
    expect(wrapper.get('[data-gallery-type="manga"]').text()).toContain('1');

    await wrapper.get('[data-gallery-type="game"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="active-gallery-title"]').text()).toBe('game');
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('Endfield');
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('Hades II');
    expect(wrapper.get('[data-testid="entry-list"]').text()).not.toContain('Witch Hat Atelier');
  });

  it('opens manual Entry and Author creation as secondary pages from sidebar actions', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();

    expect(wrapper.find('[data-testid="create-entry-form"]').exists()).toBe(false);
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    expect(wrapper.get('[data-testid="add-entry-page"]').text()).toContain('New Entry');
    expect(wrapper.find('[data-testid="entry-cover-dropzone"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="entry-preview-dropzone"]').exists()).toBe(false);
    expect(wrapper.find('input[webkitdirectory]').exists()).toBe(true);

    await wrapper.get('[data-testid="add-entry-back"]').trigger('click');
    await wrapper.get('[data-testid="add-author-navigation"]').trigger('click');
    expect(wrapper.get('[data-testid="add-author-page"]').text()).toContain('New Author');
  });

  it('previews and commits a reviewed site export folder from the Add Entry page', async () => {
    setLocale('zh-CN');
    const api = createMemoryApi();
    api.previewSiteProbeFolder = vi.fn(async () => ({
      source: '18comic.vip',
      entryCount: 1,
      tagAssignmentCount: 1,
      uniqueTagCount: 1,
      entriesMissingCover: 1,
      warnings: [],
      batch: {
        source: '18comic.vip',
        warnings: [],
        entries: [{
          externalKey: '18comic.vip:42',
          title: 'Imported work',
          tags: [{ name: 'Color' }],
          fields: { authors: ['Source Author'], works: ['Series'] },
        }],
      },
    }));
    api.listLayout = vi.fn(async () => [{
      id: 10,
      name: 'Imported',
      sortOrder: 0,
      facets: [{ id: 11, name: '', sortOrder: 0 }],
    }]);
    api.commitImport = vi.fn(async () => ({
      entries: [{ entryId: 4, title: 'Imported work', externalKey: '18comic.vip:42' }],
      entryCount: 1,
      createdProducerCount: 1,
      producerLinkCount: 1,
      tagAssignmentCount: 1,
      contentCount: 2,
    }));
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const metadata = new File(['{}'], 'metadata.json', { type: 'application/json' });
    Object.defineProperty(metadata, 'webkitRelativePath', { value: 'export/metadata.json' });
    const input = wrapper.get('input[webkitdirectory]');
    Object.defineProperty(input.element, 'files', { value: [metadata] });
    await input.trigger('change');
    await flushPromises();

    expect(wrapper.get('[data-testid="import-review"]').text()).toContain('1 个条目等待确认');
    expect(wrapper.get('[data-testid="import-review"]').text()).toContain('规范标签');
    expect(wrapper.get('[data-testid="import-review"]').text()).not.toContain('Canonical Tags');
    await wrapper.get('[data-testid="import-review"] .primary-button').trigger('click');
    await flushPromises();

    expect(api.commitImport).toHaveBeenCalledWith(expect.objectContaining({ source: '18comic.vip' }),
      expect.objectContaining({
        entryType: 'game',
        canonicalTagFacetId: 11,
        ignoredFields: ['works'],
      }));
  });

  it('auto-assigns supported fields to the matching template Facets on import', async () => {
    const api = createMemoryApi();
    api.previewSiteProbeFolder = vi.fn(async () => ({
      source: 'hitomi.la',
      entryCount: 1,
      tagAssignmentCount: 1,
      uniqueTagCount: 1,
      entriesMissingCover: 0,
      warnings: [],
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
        }],
      },
    }));
    api.listLayout = vi.fn(async () => [
      {
        id: 10,
        name: 'Basic Information',
        sortOrder: 0,
        facets: [
          { id: 11, name: 'Series', sortOrder: 1 },
          { id: 12, name: 'Characters', sortOrder: 2 },
          { id: 13, name: 'Type', sortOrder: 3 },
          { id: 14, name: 'Language', sortOrder: 4 },
        ],
      },
      { id: 20, name: 'Tags', sortOrder: 1, facets: [{ id: 21, name: '', sortOrder: 0 }] },
    ]);
    api.commitImport = vi.fn(async () => ({
      entries: [{ entryId: 4, title: 'Work', externalKey: 'hitomi.la:99' }],
      entryCount: 1,
      createdProducerCount: 1,
      producerLinkCount: 1,
      tagAssignmentCount: 5,
      contentCount: 1,
    }));
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const metadata = new File(['{}'], 'metadata.json', { type: 'application/json' });
    Object.defineProperty(metadata, 'webkitRelativePath', { value: '3220586/metadata.json' });
    const input = wrapper.get('input[webkitdirectory]');
    Object.defineProperty(input.element, 'files', { value: [metadata] });
    await input.trigger('change');
    await flushPromises();
    await wrapper.get('[data-testid="import-review"] .primary-button').trigger('click');
    await flushPromises();

    expect(api.commitImport).toHaveBeenCalledWith(expect.objectContaining({ source: 'hitomi.la' }),
      expect.objectContaining({
        entryType: 'game',
        canonicalTagFacetId: 21,
        sourceContentType: 'Source URL',
        fieldMappings: expect.objectContaining({
          works: { kind: 'tag', facetId: 11 },
          characters: { kind: 'tag', facetId: 12 },
          contentTypes: { kind: 'tag', facetId: 13 },
          language: { kind: 'tag', facetId: 14 },
          authors: expect.objectContaining({ kind: 'producer' }),
        }),
      }));
  });

  it('matches a lowercase hentai import type to the Hentai template layout', async () => {
    const api = createMemoryApi();
    api.listGalleries = vi.fn(async () => [
      { type: 'Comic', entryCount: 1 },
      { type: 'Hentai', entryCount: 1 },
    ]);
    api.previewSiteProbeFolder = vi.fn(async () => ({
      source: 'hanime1.me',
      entryCount: 1,
      tagAssignmentCount: 1,
      uniqueTagCount: 1,
      entriesMissingCover: 0,
      warnings: [],
      batch: {
        source: 'hanime1.me',
        warnings: [],
        entries: [{
          externalKey: 'hanime1.me:99',
          title: 'Work',
          tags: [{ name: 'Tag' }],
          fields: {
            works: ['Series'],
            characters: ['Character'],
            contentTypes: ['Video'],
            language: ['日本語'],
            authors: ['Author'],
          },
        }],
      },
    }));
    const hentaiLayout = [
      {
        id: 24,
        name: 'Basic Information',
        sortOrder: 0,
        facets: [
          { id: 26, name: 'Type', sortOrder: 1 },
          { id: 27, name: 'Series', sortOrder: 2 },
          { id: 28, name: 'Characters', sortOrder: 3 },
        ],
      },
      { id: 30, name: 'Tags', sortOrder: 1, facets: [{ id: 31, name: '', sortOrder: 0 }] },
    ];
    api.listLayout = vi.fn(async (entryType) => entryType === 'Hentai' ? hentaiLayout : []);
    api.commitImport = vi.fn(async () => ({
      entries: [{ entryId: 14, title: 'Work', externalKey: 'hanime1.me:99' }],
      entryCount: 1,
      createdProducerCount: 1,
      producerLinkCount: 1,
      tagAssignmentCount: 4,
      contentCount: 1,
    }));

    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const metadata = new File(['{}'], 'metadata.json', { type: 'application/json' });
    Object.defineProperty(metadata, 'webkitRelativePath', { value: '99737/metadata.json' });
    const folderInput = wrapper.get('input[webkitdirectory]');
    Object.defineProperty(folderInput.element, 'files', { value: [metadata] });
    await folderInput.trigger('change');
    await flushPromises();

    const typeInput = wrapper.get('[data-testid="import-review"] input[list="add-entry-gallery-types"]');
    await typeInput.setValue('hentai');
    await typeInput.trigger('change');
    await flushPromises();

    expect(api.listLayout).toHaveBeenLastCalledWith('Hentai');
    await wrapper.get('[data-testid="import-review"] .primary-button').trigger('click');
    await flushPromises();

    expect(api.commitImport).toHaveBeenCalledWith(expect.objectContaining({ source: 'hanime1.me' }),
      expect.objectContaining({
        entryType: 'Hentai',
        canonicalTagFacetId: 31,
        fieldMappings: expect.objectContaining({
          works: { kind: 'tag', facetId: 27 },
          characters: { kind: 'tag', facetId: 28 },
          contentTypes: { kind: 'tag', facetId: 26 },
          authors: expect.objectContaining({ kind: 'producer' }),
        }),
        ignoredFields: ['language'],
      }));
  });

  it('batch import auto-links items by the same author to one producer across commits', async () => {
    const api = createMemoryApi();
    const authorList: Array<{ id: number; name: string; covers: string[]; galleryType: string | null }> = [
      { id: 9, name: 'Hypergryph', covers: [], galleryType: 'game' },
    ];
    let commitCount = 0;
    api.listLayout = vi.fn(async () => [
      { id: 10, name: 'Tags', sortOrder: 0, facets: [{ id: 11, name: '', sortOrder: 0 }] },
    ]);
    api.previewSiteProbeFolder = vi.fn(async () => ({
      source: 'hanime1.me',
      entryCount: 1,
      tagAssignmentCount: 1,
      uniqueTagCount: 1,
      entriesMissingCover: 0,
      warnings: [],
      batch: {
        source: 'hanime1.me',
        warnings: [],
        entries: [{
          externalKey: `hanime1.me:${1000 + commitCount}`,
          title: `Work ${commitCount + 1}`,
          tags: [{ name: 'Tag' }],
          fields: { authors: ['Peh-koi'] },
        }],
      },
    }));
    api.listAuthors = vi.fn(async () => [...authorList]);
    const commitImportMock = vi.fn<GalleryApi['commitImport']>(async (batch) => {
      commitCount += 1;
      // First commit creates the "Peh-koi" producer; later commits reuse it.
      if (commitCount === 1) authorList.push({ id: 100, name: 'Peh-koi', covers: [], galleryType: null });
      return {
        entries: batch.entries.map((entry, index) => ({
          entryId: 100 + index,
          title: entry.title,
          externalKey: entry.externalKey,
        })),
        entryCount: batch.entries.length,
        createdProducerCount: commitCount === 1 ? 1 : 0,
        producerLinkCount: 1,
        tagAssignmentCount: 1,
        contentCount: 1,
      };
    });
    api.commitImport = commitImportMock;

    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    await wrapper.get('.batch-import-toggle .secondary-button').trigger('click');

    const batchInput = wrapper.get('.batch-import input[webkitdirectory]');
    const files = ['100089', '102331', '102440'].map((itemId) => {
      const file = new File(['{}'], 'metadata.json', { type: 'application/json' });
      Object.defineProperty(file, 'webkitRelativePath', {
        value: `playlist_640641/items/${itemId}/metadata.json`,
      });
      return file;
    });
    Object.defineProperty(batchInput.element, 'files', { value: files });
    await batchInput.trigger('change');
    await flushPromises();

    await wrapper.get('.batch-import .primary-button').trigger('click');
    await flushPromises();

    expect(commitImportMock).toHaveBeenCalledTimes(3);
    // First item: no existing "Peh-koi" yet — create it.
    expect(commitImportMock.mock.calls[0]![1].fieldMappings.authors).toEqual(
      expect.objectContaining({ existingProducerIds: {} }),
    );
    // Later items: the producer created by the first commit is auto-linked.
    expect(commitImportMock.mock.calls[1]![1].fieldMappings.authors).toEqual(
      expect.objectContaining({ existingProducerIds: { 'Peh-koi': 100 } }),
    );
    expect(commitImportMock.mock.calls[2]![1].fieldMappings.authors).toEqual(
      expect.objectContaining({ existingProducerIds: { 'Peh-koi': 100 } }),
    );
    // Parent list refreshed at mount, after the producer-creating commit, and at batch end.
    expect(api.listAuthors).toHaveBeenCalledTimes(3);
    expect(wrapper.get('[data-testid="batch-import"]').text())
      .toContain('Batch import complete: 3 succeeded, 0 failed.');
  });

  it('auto-links an imported author name through the producer taxonomy dictionary', async () => {
    const api = createMemoryApi();
    api.listAuthors = vi.fn(async () => [
      { id: 9, name: 'Hypergryph', covers: [], galleryType: 'game' },
      { id: 100, name: '鲍勃', covers: [], galleryType: null },
    ]);
    api.listTaxonomyAliases = vi.fn(async (vocabulary) => vocabulary === 'producer'
      ? [{
        id: 1,
        vocabulary: 'producer' as const,
        partition: '',
        alias: 'bob',
        normalizedAlias: 'bob',
        canonicalName: '鲍勃',
        normalizedCanonical: '鲍勃',
      }]
      : []);
    api.listLayout = vi.fn(async () => [
      { id: 10, name: 'Tags', sortOrder: 0, facets: [{ id: 11, name: '', sortOrder: 0 }] },
    ]);
    api.previewSiteProbeFolder = vi.fn(async () => ({
      source: 'hanime1.me',
      entryCount: 1,
      tagAssignmentCount: 1,
      uniqueTagCount: 1,
      entriesMissingCover: 0,
      warnings: [],
      batch: {
        source: 'hanime1.me',
        warnings: [],
        entries: [{
          externalKey: 'hanime1.me:77',
          title: 'Bob work',
          tags: [{ name: 'Tag' }],
          fields: { authors: ['bob'] },
        }],
      },
    }));
    const commitImportMock = vi.fn<GalleryApi['commitImport']>(async (batch) => ({
      entries: batch.entries.map((entry, index) => ({
        entryId: 1000 + index,
        title: entry.title,
        externalKey: entry.externalKey,
      })),
      entryCount: batch.entries.length,
      createdProducerCount: 0,
      producerLinkCount: 1,
      tagAssignmentCount: 1,
      contentCount: 1,
    }));
    api.commitImport = commitImportMock;

    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const metadata = new File(['{}'], 'metadata.json', { type: 'application/json' });
    Object.defineProperty(metadata, 'webkitRelativePath', { value: 'playlist/items/77/metadata.json' });
    const input = wrapper.get('input[webkitdirectory]');
    Object.defineProperty(input.element, 'files', { value: [metadata] });
    await input.trigger('change');
    await flushPromises();
    await wrapper.get('[data-testid="import-review"] .primary-button').trigger('click');
    await flushPromises();

    // The dictionary alias 'bob' -> '鲍勃' pre-selects the canonical author, and
    // the reviewed mapping is keyed by the canonical name — not the raw 'bob'.
    expect(commitImportMock.mock.calls[0]![1].fieldMappings.authors).toEqual(
      expect.objectContaining({ existingProducerIds: { '鲍勃': 100 } }),
    );
  });

  it('shows the Author page beside Galleries only when an Author exists', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();

    await wrapper.get('[data-testid="author-navigation"]').trigger('click');
    expect(wrapper.get('[data-testid="author-page"]').text()).toContain('Hypergryph');
  });

  it('reveals the Author page after creating and linking the first Author from an Entry', async () => {
    const wrapper = mount(GalleryApp, {
      props: { api: createMemoryApi({ withAuthors: false }) },
    });
    await flushPromises();
    expect(wrapper.find('[data-testid="author-navigation"]').exists()).toBe(false);
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-testid="add-entry-author"]').trigger('click');
    expect(wrapper.get('[data-testid="create-entry-author-form"]').find('button').exists()).toBe(false);
    expect(wrapper.get('[name="authorName"]').attributes('size')).toBe('5');
    await wrapper.get('[name="authorName"]').setValue('New Author');
    await wrapper.get('[name="authorName"]').trigger('keydown.enter');
    await flushPromises();

    expect(wrapper.get('[data-testid="author-navigation"]').text()).toContain('Authors');
    expect(wrapper.get('[data-testid="entry-detail"]').text()).toContain('New Author');
  });

  it('links an existing Author from Entry edit mode', async () => {
    const wrapper = mount(GalleryApp, {
      props: { api: createMemoryApi({ withUnlinkedAuthor: true }) },
    });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    expect(wrapper.find('select[name="existingAuthorId"]').exists()).toBe(false);
    await wrapper.get('[data-testid="link-entry-author"]').trigger('click');
    await wrapper.get('[name="existingAuthorName"]').setValue('guest');
    expect(wrapper.get('[data-testid="author-suggestions"]').text()).toContain('Guest Artist');
    expect(wrapper.get('[data-testid="author-suggestions"]').text()).not.toContain('Hypergryph');
    await wrapper.get('[name="existingAuthorName"]').trigger('blur');
    await flushPromises();

    expect(wrapper.get('[data-testid="entry-detail"]').text()).toContain('Guest Artist');
  });

  it('unlinks one Author inline from Entry edit mode', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-unlink-author-id="9"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-unlink-author-id="9"]').exists()).toBe(false);
    await wrapper.get('[data-testid="link-entry-author"]').trigger('click');
    expect(wrapper.get('[data-testid="author-suggestions"]').text()).toContain('Hypergryph');
  });

  it('returns an Entry opened from an Author to that Author detail', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await wrapper.get('[data-testid="author-navigation"]').trigger('click');
    await wrapper.get('[data-author-id="9"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-author-work-id="1"] .author-card-main').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="entry-back"]').text()).toBe('← Back to Hypergryph');
    await wrapper.get('[data-testid="entry-back"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="author-information-board"]').text()).toContain('Hypergryph');
  });

  it('returns an Entry opened from a Directory to that Directory detail', async () => {
    const wrapper = mount(GalleryApp, {
      props: { api: createMemoryApi({ withDirectory: true }) },
    });
    await flushPromises();
    await wrapper.get('[data-testid="author-navigation"]').trigger('click');
    await wrapper.get('[data-author-id="9"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-author-directory-id="1"] [data-directory-open]').trigger('click');
    await wrapper.get('[data-directory-work-id="1"] .author-card-main').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="entry-back"]').text()).toBe('← Back to Selected works');
    await wrapper.get('[data-testid="entry-back"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('.directory-heading').text()).toContain('Selected works');
  });

  it('opens an Author detail by double-clicking its chip in Entry read mode', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-entry-author-id="9"]').trigger('dblclick');
    await flushPromises();

    expect(wrapper.get('[data-testid="author-information-board"]').text()).toContain('Hypergryph');
  });

  it('opens all matching Entries by double-clicking an Entry Tag in read mode', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-detail-tag-id="12"]').trigger('dblclick');
    await flushPromises();

    const results = wrapper.get('[data-testid="tag-results"]');
    expect(results.text()).toContain('ARPG');
    expect(results.text()).toContain('Endfield');
    expect(results.text()).toContain('Hades II');

    await wrapper.get('[data-tag-entry-id="2"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="entry-back"]').text()).toBe('← Back to ARPG');
    await wrapper.get('[data-testid="entry-back"]').trigger('click');
    expect(wrapper.get('[data-testid="tag-results"]').text()).toContain('ARPG');
  });

  it('opens all matching Authors by clicking an Author Tag in read mode', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await wrapper.get('[data-testid="author-navigation"]').trigger('click');
    await wrapper.get('[data-author-id="9"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-author-tag-id="30"]').trigger('click');
    await flushPromises();

    const results = wrapper.get('[data-testid="tag-results"]');
    expect(results.text()).toContain('Studio');
    expect(results.text()).toContain('Hypergryph');
    await wrapper.get('[data-tag-author-id="9"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="author-information-board"]').text()).toContain('Hypergryph');
  });

  it('creates a new Gallery by creating an Entry with a new type', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();

    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    await wrapper.get('[name="title"]').setValue('Steins;Gate');
    await wrapper.get('[name="type"]').setValue('visual novel');
    await wrapper.get('[data-testid="manual-entry-form"]').trigger('submit');
    await flushPromises();

    expect(wrapper.get('[data-gallery-type="visual novel"]').text()).toContain('1');
    expect(wrapper.get('[data-testid="active-gallery-title"]').text()).toBe('visual novel');
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('Steins;Gate');
  });

  it('opens an Entry detail without introducing a Gallery record', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();

    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();

    const detail = wrapper.get('[data-testid="entry-detail"]');
    expect(detail.text()).toContain('Endfield');
    expect(detail.text()).toContain('Hypergryph');
    expect(detail.text()).toContain('ARPG');
    expect(detail.text()).toContain('A saved note');
  });

  it('enters edit mode from the Entry detail toolbar instead of the Gallery card', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();

    expect(wrapper.find('[data-edit-entry-id]').exists()).toBe(false);
    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();

    const detail = wrapper.get('[data-testid="entry-detail"]');
    await detail.get('[data-testid="start-entry-editing"]').trigger('click');
    expect(detail.attributes('data-edit-mode')).toBe('true');
    const done = detail.get('[data-testid="finish-entry-editing"]');
    expect(done.text()).toBe('Done');

    await done.trigger('click');
    expect(detail.attributes('data-edit-mode')).toBe('false');
    expect(detail.find('[data-testid="add-section-button"]').exists()).toBe(false);
  });

  it('keeps Tag mutation and dragging controls out of read mode', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();

    await wrapper.get('[data-entry-id="2"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="add-section-button"]').exists()).toBe(false);
    expect(wrapper.find('[data-add-facet-section-id="10"]').exists()).toBe(false);
    expect(wrapper.find('[data-add-tag-facet-id="11"]').exists()).toBe(false);
    expect(wrapper.find('[data-remove-entry-tag-id="12"]').exists()).toBe(false);
    expect(wrapper.get('[data-detail-tag-id="12"]').attributes('draggable')).toBe('false');
  });

  it('renders direct Section Tags without showing empty Facet rows', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await wrapper.get('[data-entry-id="2"]').trigger('click');
    await flushPromises();

    const section = wrapper.get('[data-section-id="10"]');
    const directRow = section.get('[data-facet-id="11"]');
    expect(directRow.attributes('data-unnamed-facet')).toBe('true');
    expect(directRow.get('[data-facet-label]').text()).toBe('');
    expect(directRow.find('[data-tag-column]').exists()).toBe(true);
    expect(section.find('[data-facet-id="15"]').exists()).toBe(false);
  });

  it('adds ordered Content from the Entry edit view', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-testid="add-content-button"]').trigger('click');
    const form = wrapper.get('[data-testid="create-content-form"]');
    await form.get('[name="contentType"]').setValue('short review');
    await form.get('[name="content"]').setValue('Worth replaying');
    await form.trigger('submit');
    await flushPromises();

    const created = wrapper.get('[data-content-id="14"]');
    expect(created.text()).toContain('short review');
    expect(created.text()).toContain('Worth replaying');
  });

  it('edits one Content row inline in the Entry edit view', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-edit-content-id="13"]').trigger('click');
    const form = wrapper.get('[data-testid="edit-content-form-13"]');
    await form.get('[name="contentType"]').setValue('short review');
    await form.get('[name="content"]').setValue('Updated note');
    await form.trigger('submit');
    await flushPromises();

    const updated = wrapper.get('[data-content-id="13"]');
    expect(updated.text()).toContain('short review');
    expect(updated.text()).toContain('Updated note');
    expect(updated.find('[data-testid="edit-content-form-13"]').exists()).toBe(false);
  });

  it('deletes one Content row inline without a dialog', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-delete-content-id="13"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-content-id="13"]').exists()).toBe(false);
  });

  it('moves ordered Content up from the Entry edit view', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-testid="add-content-button"]').trigger('click');
    const form = wrapper.get('[data-testid="create-content-form"]');
    await form.get('[name="contentType"]').setValue('source url');
    await form.get('[name="content"]').setValue('https://example.test');
    await form.trigger('submit');
    await flushPromises();

    await wrapper.get('[data-move-content-up-id="14"]').trigger('click');
    await flushPromises();

    expect(wrapper.findAll('[data-content-id]').map((item) => item.attributes('data-content-id')))
      .toEqual(['14', '13']);
  });

  it('adds another Section from the bottom of the information board', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-testid="add-section-button"]').trigger('click');
    const input = wrapper.get('[name="sectionName"]');
    expect(input.attributes('size')).toBe('5');
    expect(wrapper.find('[data-testid="create-section-form"] button[type="submit"]').exists())
      .toBe(false);
    await input.setValue('Story notes');
    expect(input.attributes('size')).toBe('11');
    await input.trigger('blur');
    await flushPromises();

    expect(wrapper.get('[data-testid="entry-information-board"]').text()).toContain('Story notes');
  });

  it('adds a Facet from the plus control inside its Section', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-add-facet-section-id="10"]').trigger('click');
    const form = wrapper.get('[data-create-facet-section-id="10"]');
    const input = form.get('[name="facetName"]');
    expect(input.attributes('size')).toBe('5');
    expect(form.find('button[type="submit"]').exists()).toBe(false);
    await input.setValue('Genre notes');
    expect(input.attributes('size')).toBe('11');
    await input.trigger('blur');
    await flushPromises();

    expect(wrapper.get('[data-facet-id="16"]').text()).toContain('Genre notes');
    expect(wrapper.find('[data-add-direct-tag-section-id="10"]').exists()).toBe(false);
  });

  it('reuses a previously hidden Facet instead of creating a duplicate', async () => {
    const api = createMemoryApi({
      extraFacets: [{ entryId: 1, id: 16, name: 'Series', tags: [] }],
    });
    api.createFacet = vi.fn(async () => {
      throw new Error('facet name already used');
    });
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);
    expect(wrapper.find('[data-facet-id="16"]').exists()).toBe(false);

    await wrapper.get('[data-add-facet-section-id="10"]').trigger('click');
    const input = wrapper.get('[name="facetName"]');
    await input.setValue('Series');
    await input.trigger('blur');
    await flushPromises();

    expect(api.createFacet).not.toHaveBeenCalled();
    expect(wrapper.get('[data-facet-id="16"]').text()).toContain('Series');
  });

  it('moves Facets up and down within their Section', async () => {
    const api = createMemoryApi({
      extraFacets: [
        { entryId: 1, id: 16, name: 'Series', tags: [{ id: 70, name: 'SR', normalizedName: 'sr' }] },
        { entryId: 1, id: 17, name: 'Type', tags: [{ id: 71, name: 'Doujin', normalizedName: 'doujin' }] },
        { entryId: 1, id: 18, name: 'Language', tags: [{ id: 72, name: 'JP', normalizedName: 'jp' }] },
      ],
    });
    api.reorderSectionFacets = vi.fn(async () => {});
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-move-facet-up-id="18"]').trigger('click');
    await flushPromises();
    expect(api.reorderSectionFacets).toHaveBeenCalledWith(10, [11, 16, 18, 17]);

    await wrapper.get('[data-move-facet-down-id="16"]').trigger('click');
    await flushPromises();
    expect(api.reorderSectionFacets).toHaveBeenCalledWith(10, [11, 17, 16, 18]);
  });

  it.each([
    { entryId: 1, facetId: 11, rowKind: 'unnamed direct-Section', tagName: 'Favorite' },
    { entryId: 1, facetId: 16, rowKind: 'new named', tagName: 'Roguelike' },
  ])('adds a Tag from a $rowKind Facet row', async ({ entryId, facetId, tagName }) => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openEntryForEditing(wrapper, entryId);

    if (facetId === 16) {
      await wrapper.get('[data-add-facet-section-id="10"]').trigger('click');
      const facetInput = wrapper.get('[name="facetName"]');
      await facetInput.setValue('Genre');
      await facetInput.trigger('blur');
      await flushPromises();
    } else {
      await wrapper.get(`[data-add-tag-facet-id="${facetId}"]`).trigger('click');
    }
    const form = wrapper.get(`[data-create-tag-facet-id="${facetId}"]`);
    const input = form.get('[name="tagName"]');
    expect(input.attributes('size')).toBe('5');
    expect(form.find('button[type="submit"]').exists()).toBe(false);
    await input.setValue(tagName);
    await input.trigger('blur');
    await flushPromises();

    expect(wrapper.get(`[data-facet-id="${facetId}"]`).text()).toContain(tagName);
    if (facetId === 16) {
      expect(wrapper.find('[data-add-direct-tag-section-id="10"]').exists()).toBe(false);
    }
  });

  it('does not expose the full Entry Tag vocabulary as Gallery filters', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();

    expect(wrapper.find('.tag-filter-bar').exists()).toBe(false);
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('Endfield');
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('Hades II');
  });

  it('creates the first Section for an Entry type before Tag placement', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await wrapper.get('[data-gallery-type="manga"]').trigger('click');
    await flushPromises();
    await openEntryForEditing(wrapper, 3);

    await wrapper.get('[data-testid="add-section-button"]').trigger('click');
    const form = wrapper.get('[data-testid="create-section-form"]');
    await form.get('[name="sectionName"]').setValue('Metadata');
    await form.trigger('submit');
    await flushPromises();

    expect(wrapper.get('[data-testid="entry-detail"]').text()).toContain('Metadata');
    expect(wrapper.find('[data-facet-id="11"]').exists()).toBe(false);
    const controls = wrapper.get('[data-empty-section-controls="10"]');
    expect(controls.find('[data-add-facet-section-id="10"]').exists()).toBe(true);
    expect(controls.find('[data-add-direct-tag-section-id="10"]').exists()).toBe(true);
  });

  it('creates an unnamed Facet only when adding a Tag directly under an empty Section', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await wrapper.get('[data-gallery-type="manga"]').trigger('click');
    await flushPromises();
    await openEntryForEditing(wrapper, 3);

    await wrapper.get('[data-testid="add-section-button"]').trigger('click');
    await wrapper.get('[name="sectionName"]').setValue('Metadata');
    await wrapper.get('[data-testid="create-section-form"]').trigger('submit');
    await flushPromises();

    await wrapper.get('[data-add-direct-tag-section-id="10"]').trigger('click');
    const input = wrapper.get('[data-create-tag-facet-id="11"] [name="tagName"]');
    await input.setValue('Favorite');
    await input.trigger('blur');
    await flushPromises();

    expect(wrapper.get('[data-facet-id="11"]').text()).toContain('Favorite');
    expect(wrapper.find('[data-empty-section-controls="10"]').exists()).toBe(false);
  });

  it('moves an Entry Tag by dragging it to another Facet', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-add-facet-section-id="10"]').trigger('click');
    const form = wrapper.get('[data-create-facet-section-id="10"]');
    await form.get('[name="facetName"]').setValue('Genre');
    await form.trigger('submit');
    await flushPromises();

    const source = wrapper.get('[data-detail-tag-id="12"]');
    const target = wrapper.get('[data-facet-id="16"]');
    await source.trigger('dragstart');
    await target.trigger('drop');
    await flushPromises();

    expect(wrapper.find('[data-facet-id="11"]').exists()).toBe(false);
    expect(wrapper.get('[data-facet-id="16"]').text()).toContain('ARPG');
    expect(wrapper.find('[data-add-direct-tag-section-id="10"]').exists()).toBe(false);
  });

  it('renames an Entry Tag by double-clicking it in edit mode', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-detail-tag-id="12"]').trigger('dblclick');
    const input = wrapper.get('[data-rename-entry-tag-id="12"]');
    expect(input.attributes('size')).toBe('5');
    await input.setValue('Action RPG');
    expect(input.attributes('size')).toBe('10');
    await input.trigger('blur');
    await flushPromises();

    expect(wrapper.get('[data-detail-tag-id="12"]').text()).toContain('Action RPG');
  });

  it('removes an Entry Tag inline without a dialog', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-remove-entry-tag-id="12"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="entry-detail"]').text()).not.toContain('ARPG');
    expect(wrapper.find('[data-facet-id="11"]').exists()).toBe(false);
    const controls = wrapper.get('[data-empty-section-controls="10"]');
    expect(controls.find('[data-add-facet-section-id="10"]').exists()).toBe(true);
    expect(controls.find('[data-add-direct-tag-section-id="10"]').exists()).toBe(true);
  });

  it('applies the Entry layout as the type template from the edit toolbar', async () => {
    const api = createMemoryApi();
    const apply = vi.fn(async () => ({
      entryType: 'game',
      entriesAffected: 2,
      tagsRelinked: 3,
      orphansMoved: 0,
      sectionsRecreated: 1,
      backupPath: null,
      foreignKeyCheckPass: true,
      doctorPass: true,
      doctorIssues: [],
    }));
    api.applyEntryLayoutTemplate = apply;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await openEntryForEditing(wrapper, 1);

    // Edit mode shows the four vertical actions: done, save template,
    // empty-facet toggle, delete.
    for (const testId of [
      'finish-entry-editing',
      'save-template-button',
      'toggle-empty-facets',
      'delete-entry',
    ]) {
      expect(wrapper.find(`[data-testid="${testId}"]`).exists()).toBe(true);
    }

    await wrapper.get('[data-testid="save-template-button"]').trigger('click');
    await flushPromises();
    expect(apply).toHaveBeenCalledWith(1);
    expect(wrapper.get('[data-testid="template-notice"]').text()).toContain('Template applied');

    // The empty-facet toggle flips its label and reveals empty named Facets.
    const toggle = wrapper.get('[data-testid="toggle-empty-facets"]');
    await toggle.trigger('click');
    expect(wrapper.get('[data-testid="toggle-empty-facets"]').text()).toContain('Hide empty facets');
  });

  it('deletes a Facet from the edit toolbar', async () => {
    const api = createMemoryApi();
    const removeFacet = vi.fn(async () => {});
    api.deleteFacet = removeFacet;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await openEntryForEditing(wrapper, 2);

    // Entry two carries the named "Genre" Facet (id 15), which is empty by
    // default — reveal it through the empty-facet toggle first.
    await wrapper.get('[data-testid="toggle-empty-facets"]').trigger('click');
    await wrapper.get('[data-delete-facet-id="15"]').trigger('click');
    await flushPromises();
    expect(removeFacet).toHaveBeenCalledWith(15);
  });
});

describe('Facet filter bar', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setLocale('en');
  });

  async function openGameGallery(wrapper: VueWrapper): Promise<void> {
    await wrapper.get('[data-gallery-type="game"]').trigger('click');
    await flushPromises();
  }

  async function pickFacet(wrapper: VueWrapper, label: string): Promise<void> {
    await wrapper.get('[data-testid="facet-picker-button"]').trigger('click');
    await flushPromises();
    const option = wrapper.findAll('[data-testid="facet-dropdown"] .filter-option')
      .find((candidate) => candidate.text().includes(label))!;
    await option.trigger('click');
    await flushPromises();
  }

  async function pickTag(wrapper: VueWrapper, label: string): Promise<void> {
    const option = wrapper.findAll('[data-testid="tag-dropdown"] .filter-option')
      .find((candidate) => candidate.text() === label)!;
    await option.trigger('click');
    await flushPromises();
  }

  it('filters the gallery by Facet tags and restores results when the chip is removed', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openGameGallery(wrapper);

    expect(wrapper.find('[data-testid="facet-filter-bar"]').exists()).toBe(true);

    // Genre / Sci-fi: only Endfield carries Sci-fi.
    await pickFacet(wrapper, 'Genre');
    await pickTag(wrapper, 'Sci-fi');

    const grid = wrapper.get('[data-testid="entry-list"]');
    expect(grid.text()).toContain('Endfield');
    expect(grid.text()).not.toContain('Hades II');

    // Removing the chip drops the filter and the full gallery comes back.
    await wrapper.get('[data-testid="filter-tag-chip"] .filter-tag-chip__remove').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('Hades II');
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('Endfield');
  });

  it('combines rows with AND and clears everything back to the full gallery', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openGameGallery(wrapper);

    // Row one: Genre Facet must contain Sci-fi (Endfield only).
    await pickFacet(wrapper, 'Genre');
    await pickTag(wrapper, 'Sci-fi');

    // Row two: the "all tags" row (facet-independent) must contain ARPG —
    // Hades II has ARPG but not Sci-fi, so only Endfield satisfies both rows.
    await wrapper.get('[data-testid="add-facet-filter"]').trigger('click');
    await flushPromises();
    await pickFacet(wrapper, 'All tags');
    await pickTag(wrapper, 'ARPG');

    const grid = wrapper.get('[data-testid="entry-list"]');
    expect(grid.text()).toContain('Endfield');
    expect(grid.text()).not.toContain('Hades II');

    // Clear all -> empty bar row again and both entries back.
    await wrapper.get('[data-testid="clear-facet-filters"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('Endfield');
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('Hades II');
    expect(wrapper.find('[data-testid="facet-picker-button"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="filter-tag-chip"]').exists()).toBe(false);
  });

  it('ANDs tags inside one row: picking more tags narrows the result', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openGameGallery(wrapper);

    // Genre row: ARPG AND Sci-fi. Only Endfield carries both in the fixture.
    await pickFacet(wrapper, 'Genre');
    await pickTag(wrapper, 'ARPG');
    await pickTag(wrapper, 'Sci-fi');

    const grid = wrapper.get('[data-testid="entry-list"]');
    expect(grid.text()).toContain('Endfield');
    expect(grid.text()).not.toContain('Hades II');

    // Removing ONE chip relaxes the row to the remaining tag (Sci-fi), so
    // Hades II (which has no Sci-fi) must still be excluded…
    await wrapper.get('[data-testid="filter-tag-chip"] .filter-tag-chip__remove').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('Endfield');
    expect(wrapper.get('[data-testid="entry-list"]').text()).not.toContain('Hades II');

    // …and only the empty row restores the full gallery.
    await wrapper.get('[data-testid="filter-tag-chip"] .filter-tag-chip__remove').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('Hades II');
  });

  it('rejects picking the same tag in a second filter row', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openGameGallery(wrapper);

    // Row one: Genre / ARPG.
    await pickFacet(wrapper, 'Genre');
    await pickTag(wrapper, 'ARPG');

    // Row two: the all-tags row; ARPG is already used in row one.
    await wrapper.get('[data-testid="add-facet-filter"]').trigger('click');
    await flushPromises();
    await pickFacet(wrapper, 'All tags');
    await pickTag(wrapper, 'ARPG');

    const errorBox = wrapper.get('[data-testid="filter-error"]');
    expect(errorBox.text()).toContain('already used in another filter row');
    // The duplicate tag was NOT added: row two still has no chips.
    expect(wrapper.findAll('[data-testid="filter-tag-chip"]')).toHaveLength(1);
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('Hades II');
  });

  it('filters by Authors through the Authors row', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openGameGallery(wrapper);

    await pickFacet(wrapper, 'Authors');
    await pickTag(wrapper, 'Hypergryph');

    // Both fixture entries link Hypergryph, so the author filter keeps them
    // but the bar must reflect the active author chip.
    const chips = wrapper.findAll('[data-testid="filter-tag-chip"]');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.text()).toContain('Hypergryph');
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('Endfield');
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('Hades II');

    // Removing the author chip clears the filter again.
    await wrapper.get('[data-testid="filter-tag-chip"] .filter-tag-chip__remove').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="filter-tag-chip"]').exists()).toBe(false);
  });
});
