// @vitest-environment jsdom

import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GalleryApp from '../src/GalleryApp.vue';

// App-level window listeners (focus, popstate, keydown) only detach on unmount.
enableAutoUnmount(afterEach);

vi.stubGlobal('scrollTo', vi.fn());

const suggestionDebounce = (ms = 220) => new Promise<void>((resolve) => setTimeout(resolve, ms));
import { multiAuthorProducerName } from '@t3/shared';
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
    { id: 1, title: 'Endfield', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null, viewCount: 2, likeCount: 0, lastViewedAt: '2026-09-05T01:00:00Z', nsfw: false },
    { id: 2, title: 'Hades II', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null, viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false },
    { id: 3, title: 'Witch Hat Atelier', type: 'manga', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null, viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false },
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
    entries: Array<{
      id: number;
      title: string;
      type: string;
      coverRef: string | null;
      viewCount: number;
      likeCount: number;
      lastViewedAt: string | null;
    }>;
  }> = options.withDirectory ? [{
    id: 1,
    producerId: 9,
    title: 'Selected works',
    description: 'Directory note',
    sortOrder: 0,
    entries: [{ ...entries[0]!, coverRef: null }],
  }] : [];
  const entryTags = new Map<number, number[]>([
    [1, [1, 2, 12]],
    [2, [1, 12]],
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
  let nextRatingSlotId = 100;
  let ratingSlotCount = 0;
  const ratingSlots: Array<{ id: number; name: string; sortOrder: number; entryId: number }> = [];
  const entryUsages: Array<{ entryId: number; viewCount: number; likeCount: number; lastViewedAt: string | null }> = [];
  const collectionStore: Array<{ id: number; kind: 'entry' | 'producer'; title: string; description: string; nsfw: boolean; sortOrder: number; children: never[]; entries: never[]; producers: never[] }> = [];
  let viewLaterStore: number[] = [];
  let viewLaterAuthorStore: number[] = [];
  const entryRatings: Array<{ entryId: number; slotId: number; name: string; stars: number | null }> = [
    { entryId: 1, slotId: 40, name: 'Quality', stars: 5 },
    { entryId: 2, slotId: 40, name: 'Quality', stars: 3 },
  ];
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

  function filteredEntrySummaries(input: Parameters<GalleryApi['queryEntryPage']>[0]) {
    const matchesRating = (entryId: number): boolean => input.ratingConditions.every((condition) => {
      const value = entryRatings.find((row) => row.entryId === entryId && row.slotId === condition.slotId)?.stars ?? null;
      if (condition.operator === 'unrated') return value === null;
      if (value === null) return false;
      const stars = condition.stars ?? 0;
      if (condition.operator === 'eq') return value === stars;
      if (condition.operator === 'gt') return value > stars;
      return value < stars;
    });
    const matched = entries.filter((entry) => {
      if (input.entryType && entry.type !== input.entryType) return false;
      const tags = entryTags.get(entry.id) ?? [];
      if (!input.conditions.every((condition) => condition.tagIds.every((tagId) => tags.includes(tagId)))) return false;
      if (input.authorIds.length > 0
        && !(linkedAuthorIds.get(entry.id) ?? []).some((id) => input.authorIds.includes(id))) return false;
      if (!matchesRating(entry.id)) return false;
      return input.usageConditions.every((condition) => {
        const value = entryUsages.find((row) => row.entryId === entry.id);
        if (condition.field === 'views') {
          const count = value?.viewCount ?? 0;
          const expected = condition.value as number;
          if (condition.operator === 'eq') return count === expected;
          if (condition.operator === 'gt') return count > expected;
          return count < expected;
        }
        const date = (value?.lastViewedAt ?? '').slice(0, 10);
        const expectedDate = condition.value as string;
        if (condition.operator === 'eq') return date === expectedDate;
        if (condition.operator === 'gt') return date > expectedDate;
        return date < expectedDate;
      });
    });
    if (input.usageSort) {
      const usageOf = (entryId: number): number => {
        const value = entryUsages.find((row) => row.entryId === entryId);
        return input.usageSort?.field === 'views'
          ? value?.viewCount ?? 0
          : value?.lastViewedAt ? Date.parse(value.lastViewedAt) : -1;
      };
      const direction = input.usageSort.direction === 'desc' ? -1 : 1;
      return matched.sort((left, right) => direction * (usageOf(left.id) - usageOf(right.id)) || left.id - right.id);
    }
    if (input.ratingSort) {
      const starsOf = (entryId: number): number => (
        entryRatings.find((row) => row.entryId === entryId && row.slotId === input.ratingSort?.slotId)?.stars ?? -1
      );
      return matched.sort((left, right) => starsOf(right.id) - starsOf(left.id) || left.id - right.id);
    }
    return matched;
  }

  return {
    assetUrl(path) {
      return path;
    },
    async suggestTags(input: Parameters<GalleryApi['suggestTags']>[0]) {
      const query = String(input.q).trim().toLocaleLowerCase();
      const excluded = new Set<number>(
        (Array.isArray(input.excludeIds) ? input.excludeIds : []).map((id) => Number(id)),
      );
      const limit = input.limit === undefined ? 20 : Number(input.limit);
      return [
        { id: 51, name: 'School Life', sameContextUsageCount: 3, totalUsageCount: 30 },
        { id: 52, name: 'School Uniform', sameContextUsageCount: 2, totalUsageCount: 12 },
        { id: 53, name: 'Roguelike', sameContextUsageCount: 5, totalUsageCount: 40 },
      ]
        .filter((tag) => !excluded.has(tag.id) && tag.name.toLocaleLowerCase().includes(query))
        .slice(0, limit);
    },
    async listSourceLibrary() {
      return [];
    },
    async getSyncCapabilities() {
      return {
        libraryId: 'memory', syncEpoch: 'memory', sqliteSchemaVersion: 15,
        snapshotFormatVersion: 1, syncProtocolVersion: 1, serverBuild: 'test',
        featureFlags: { readOnlySnapshot: true, offlineMutations: false },
      };
    },
    async fetchSyncSnapshot() {
      return {
        header: {
          libraryId: 'memory', syncEpoch: 'memory', snapshotSeq: 0,
          generatedAt: new Date().toISOString(), sqliteSchemaVersion: 15,
          snapshotFormatVersion: 1, counts: { entries: 0, producers: 0, entryContents: 0, entryTags: 0, collections: 0 },
          checksum: '0'.repeat(64),
        },
        payload: {
          entries: [], producers: [], entryProducers: [], tags: [], tagGroups: [], entryTags: [],
          producerTags: [], producerTagAssignments: [], entryContents: [], ratingSlots: [],
          entryRatingValues: [], producerRatingValues: [], collections: [], collectionMembers: [],
          authorDirectories: [], authorDirectoryEntries: [], entryUsage: [], viewLaterEntries: [],
          viewLaterProducers: [], gallerySettings: [], mediaRefs: [],
        },
      };
    },
    async probeSourceTarget(homepage: string) {
      return { ok: false as const, reason: 'unsupported', detail: homepage };
    },
    async patchSourceStatus(sourceKey, patch) {
      return { sourceKey, state: patch.state, note: patch.note ?? null, updatedAt: new Date().toISOString() };
    },
    async createSourceMaintenanceRun(input) {
      return {
        id: 1,
        originSourceKey: input.originSourceKey,
        adapterKey: input.adapterKey,
        targetOrigin: '',
        status: 'draft',
        markOriginInvalid: input.markOriginInvalid,
        counts: { total: 0, processed: 0, matched: 0, ambiguous: 0, noMatch: 0, errors: 0 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },
    async getSourceMaintenanceRun(runId) {
      return {
        id: runId,
        originSourceKey: 'known:hitomi',
        adapterKey: 'fake',
        targetOrigin: '',
        status: 'draft',
        markOriginInvalid: false,
        counts: { total: 0, processed: 0, matched: 0, ambiguous: 0, noMatch: 0, errors: 0 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },
    async startSourceMaintenanceRun(runId) { return this.getSourceMaintenanceRun(runId); },
    async pauseSourceMaintenanceRun(runId) { return this.getSourceMaintenanceRun(runId); },
    async resumeSourceMaintenanceRun(runId) { return this.getSourceMaintenanceRun(runId); },
    async cancelSourceMaintenanceRun(runId) { return this.getSourceMaintenanceRun(runId); },
    async listSourceMaintenanceItems(runId) {
      return {
        run: await this.getSourceMaintenanceRun(runId),
        items: [],
        total: 0,
      };
    },
    async patchSourceMaintenanceItem(runId, entryId, patch) {
      return {
        entryId,
        entryTitleSnapshot: '',
        originUrls: [],
        queryTitles: [],
        candidates: [],
        decision: patch.decision ?? 'pending',
        selectedUrl: patch.selectedUrl ?? null,
        errorText: null,
        updatedAt: new Date().toISOString(),
      };
    },
    async commitSourceMaintenanceRun(runId) {
      return {
        runId,
        status: 'committed',
        createdCount: 0,
        skippedCount: 0,
        unresolvedCount: 0,
        originMarkedInvalid: false,
        backupDir: '',
      };
    },
    async suggestProducers(input: Parameters<GalleryApi['suggestProducers']>[0]) {
      const query = String(input.q).trim().toLocaleLowerCase();
      const excluded = new Set<number>(
        (Array.isArray(input.excludeIds) ? input.excludeIds : []).map((id) => Number(id)),
      );
      const limit = input.limit === undefined ? 20 : Number(input.limit);
      return authors
        .filter((author) => !excluded.has(author.id))
        .filter((author) => query !== '' && author.name.toLocaleLowerCase().includes(query))
        .slice(0, limit)
        .map((author) => ({ id: author.id, name: author.name, sameContextUsageCount: 0, totalUsageCount: 0 }));
    },
    async getViewLaterState() {
      return { entryIds: [...viewLaterStore], producerIds: [...viewLaterAuthorStore] };
    },
    async addViewLaterEntry(entryId: number) {
      if (!viewLaterStore.includes(entryId)) viewLaterStore.push(entryId);
      return { entryIds: [...viewLaterStore], producerIds: [...viewLaterAuthorStore] };
    },
    async removeViewLaterEntry(entryId: number) {
      viewLaterStore = viewLaterStore.filter((id) => id !== entryId);
      return { entryIds: [...viewLaterStore], producerIds: [...viewLaterAuthorStore] };
    },
    async mergeViewLaterEntries(entryIds: number[]) {
      viewLaterStore = [...new Set([...viewLaterStore, ...entryIds])];
      return { entryIds: [...viewLaterStore], producerIds: [...viewLaterAuthorStore] };
    },
    async addViewLaterAuthor(authorId: number) {
      if (!viewLaterAuthorStore.includes(authorId)) viewLaterAuthorStore.push(authorId);
      return { entryIds: [...viewLaterStore], producerIds: [...viewLaterAuthorStore] };
    },
    async removeViewLaterAuthor(authorId: number) {
      viewLaterAuthorStore = viewLaterAuthorStore.filter((id) => id !== authorId);
      return { entryIds: [...viewLaterStore], producerIds: [...viewLaterAuthorStore] };
    },
    async deleteEntry(entryId) {
      const index = entries.findIndex((item) => item.id === entryId);
      if (index >= 0) entries.splice(index, 1);
    },
    async listEntrySources() {
      return [];
    },

    async mergeAuthorEntries(input) {
      const index = entries.findIndex((item) => item.id === input.absorbEntryId);
      if (index >= 0) entries.splice(index, 1);
      return {
        keptEntryId: input.keepEntryId,
        absorbedEntryId: input.absorbEntryId,
        copiedTagCount: 0,
        copiedSourceCount: 0,
        sources: [],
        mediaCleanupFailed: false,
      };
    },
    async mergeTag(input: { vocabulary: 'entry' | 'producer'; keptTagId: number; mergedTagIds: number[] }) {
      return { keptTagId: input.keptTagId, movedAssignments: 0, skippedDuplicates: 0, deletedTags: input.mergedTagIds.length };
    },
    async listTemplates() {
      return [];
    },
    async listAuthorAliasGroups() {
      return [];
    },
    async saveAuthorAliasGroup(input: { displayName: string; tagNames: string[] }) {
      return {
        group: {
          canonicalName: input.displayName,
          aliases: input.tagNames.map((name, index) => ({ id: index + 1, name })),
          producerId: null,
          producerName: null,
        },
        merge: {
          backupPath: null,
          plans: [],
          totals: {
            deletedProducers: 0,
            worksRelinked: 0,
            tagsRelinked: 0,
            ratingsRelinked: 0,
            directoriesMoved: 0,
            directoriesMerged: 0,
            membershipsMoved: 0,
            membershipsRemoved: 0,
            renamed: 0,
          },
          foreignKeyCheckPass: true,
          doctorPass: true,
          doctorIssues: [],
        },
      };
    },
    async listCollections(kind: 'entry' | 'producer') {
      return collectionStore.filter((record) => record.kind === kind);
    },

    async createCollection(input: { kind: 'entry' | 'producer'; title: string }) {
      const record = {
        id: 900 + collectionStore.length, kind: input.kind, title: input.title,
        description: '', nsfw: false, sortOrder: collectionStore.length,
        children: [], entries: [], producers: [],
      };
      collectionStore.push(record);
      return record;
    },
    async createTemporaryCollection(entryIds: number[]) {
      // Mirrors the server: take the next free 临时N name, then file the batch.
      let title = '临时';
      let suffix = 2;
      while (collectionStore.some((collection) => collection.title === title)) {
        title = `临时${suffix}`;
        suffix += 1;
      }
      const id = 900 + collectionStore.length;
      collectionStore.push({
        id, kind: 'entry', title,
        description: '', nsfw: false, sortOrder: collectionStore.length,
        children: [], entries: [], producers: [],
      });
      return { collectionId: id, title, entryCount: new Set(entryIds).size };
    },
    async updateCollection() {
      throw new Error('Not implemented in memory API');
    },
    async deleteCollection(collectionId: number) {
      const index = collectionStore.findIndex((record) => record.id === collectionId);
      if (index >= 0) collectionStore.splice(index, 1);
    },
    async setCollectionNsfw() {
      throw new Error('Not implemented in memory API');
    },
    async reorderCollections() {},
    async addCollectionEntry() {},
    async removeCollectionEntry() {},
    async addCollectionProducer() {},
    async removeCollectionProducer() {},
    async listCollectionsForEntry() {
      return [];
    },
    async listCollectionsForProducer() {
      return [];
    },
    async setGalleryPartition() {
      // The fixture never hides galleries; partition state is display-only here.
    },
    async recordEntryView(entryId) {
      const existing = entryUsages.find((row) => row.entryId === entryId);
      const now = new Date().toISOString();
      if (existing) {
        existing.viewCount += 1;
        existing.lastViewedAt = now;
        return { viewCount: existing.viewCount, likeCount: existing.likeCount, lastViewedAt: existing.lastViewedAt };
      }
      const created = { entryId, viewCount: 1, likeCount: 0, lastViewedAt: now };
      entryUsages.push(created);
      return { viewCount: 1, likeCount: 0, lastViewedAt: now };
    },
    async likeEntry(entryId) {
      const existing = entryUsages.find((row) => row.entryId === entryId);
      const likeCount = (existing?.likeCount ?? 0) + 1;
      if (existing) {
        existing.likeCount = likeCount;
      } else {
        entryUsages.push({ entryId, viewCount: 0, likeCount: 1, lastViewedAt: null });
      }
      const entry = entries.find((item) => item.id === entryId);
      if (entry) entry.likeCount = likeCount;
      return { viewCount: existing?.viewCount ?? 0, likeCount, lastViewedAt: existing?.lastViewedAt ?? null };
    },
    async deleteAuthor(authorId) {
      const index = authors.findIndex((item) => item.id === authorId);
      if (index >= 0) authors.splice(index, 1);
      viewLaterAuthorStore = viewLaterAuthorStore.filter((id) => id !== authorId);
    },
    async listGalleries() {
      const counts = new Map<string, number>();
      for (const entry of entries) {
        counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
      }
      return [...counts].map(([type, entryCount]) => ({ type, entryCount, nsfw: false }));
    },
    async queryEntryPage(input) {
      const matched = filteredEntrySummaries(input);
      const requestedOrder = new Map((input.entryIds ?? []).map((id, index) => [id, index]));
      let bounded = matched.filter((entry) => (
        ((input.entryIds?.length ?? 0) === 0 || requestedOrder.has(entry.id))
        && (input.includeTagIds ?? []).every((tagId) => (entryTags.get(entry.id) ?? []).includes(tagId))
        && !(input.excludeEntryTypes ?? []).includes(entry.type)
        && (!input.recentOnly || entry.lastViewedAt !== null)
        && (!input.searchQuery || entry.title.toLocaleLowerCase().includes(input.searchQuery.toLocaleLowerCase()))
      ));
      if (input.ratingSort === null && input.usageSort === null) {
        if (input.sort === 'source-order') {
          bounded.sort((left, right) => requestedOrder.get(left.id)! - requestedOrder.get(right.id)!);
        } else if (input.sort === 'random') {
          bounded = bounded.reverse();
        } else {
          const direction = input.sort.endsWith('-desc') ? -1 : 1;
          bounded.sort((left, right) => {
            if (input.sort.startsWith('title')) {
              return direction * left.title.localeCompare(right.title, undefined, { sensitivity: 'base' })
                || left.id - right.id;
            }
            const dateCompare = String(left.uploadDate ?? '').localeCompare(String(right.uploadDate ?? ''));
            return direction * (dateCompare || left.id - right.id);
          });
        }
      }
      const total = bounded.length;
      const start = (input.page - 1) * input.pageSize;
      return { items: bounded.slice(start, start + input.pageSize), total, page: input.page, pageSize: input.pageSize };
    },
    async queryProducerPage(input) {
      const requestedOrder = new Map((input.producerIds ?? []).map((id, index) => [id, index]));
      let matched = authors
        .map((author) => ({
          id: author.id,
          name: author.name,
          covers: [],
          galleryType: null,
          viewCount: 0,
          likeCount: 0,
          lastViewedAt: null,
          nsfw: false,
        }))
        .filter((author) => (
          ((input.producerIds?.length ?? 0) === 0 || requestedOrder.has(author.id))
          && (input.includeNsfw || !author.nsfw)
          && (!input.searchQuery || author.name.toLocaleLowerCase().includes(input.searchQuery.toLocaleLowerCase()))
          && (input.ownTagIds.length === 0 || (author.id === 9 && input.ownTagIds.every((id) => id === 30)))
        ));
      if (input.sort === 'source-order') {
        matched.sort((left, right) => requestedOrder.get(left.id)! - requestedOrder.get(right.id)!);
      } else if (input.sort === 'random') {
        matched = matched.reverse();
      } else {
        matched.sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id);
      }
      const total = matched.length;
      const start = (input.page - 1) * input.pageSize;
      return { items: matched.slice(start, start + input.pageSize), total, page: input.page, pageSize: input.pageSize };
    },
    async searchTags(query) {
      const candidates = [{ tagId: 12, name: 'Shared', normalizedName: 'shared', entryCount: 2 }];
      const needle = query.toLocaleLowerCase();
      return candidates.filter((tag) => tag.name.toLocaleLowerCase().includes(needle));
    },

    async listFacetFilterOptions(type) {
      if (type !== 'game') return { entryType: type, facets: [], allTags: [], authors: [], ratingSlots: [] };
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
        ratingSlots: [{ id: 40, name: 'Quality', sortOrder: 0 }],
      };
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
        templateFiles: null,
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
        viewCount: 0,
        likeCount: 0,
        lastViewedAt: null,
        nsfw: false,
      };
      entries.push(created);
      return created;
    },
    async updateEntry(entryId, input) {
      const entry = entries.find((item) => item.id === entryId);
      if (!entry) throw new Error('Entry not found');
      if (input.title !== undefined) entry.title = input.title.trim();
      return entry;
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
    async listRatingSlots() {
      return [];
    },
    async createEntryRatingSlot(entryId, name) {
      const slot = { id: nextRatingSlotId++, name: name.trim(), sortOrder: ratingSlotCount++ };
      ratingSlots.push({ ...slot, entryId });
      return slot;
    },
    async setEntryRating(entryId, slotId, stars) {
      const name = ratingSlots.find((slot) => slot.id === slotId)?.name ?? '';
      const existing = entryRatings.find((row) => row.entryId === entryId && row.slotId === slotId);
      if (existing) {
        existing.stars = stars;
      } else {
        entryRatings.push({ entryId, slotId, name, stars });
      }
      return { slotId, name, stars };
    },
    async reorderEntryRatingSlots(_entryId, orderedSlotIds) {
      orderedSlotIds.forEach((slotId, index) => {
        const slot = ratingSlots.find((item) => item.id === slotId);
        if (slot) slot.sortOrder = index;
      });
    },
    async createAuthorRatingSlot() {
      throw new Error('Not implemented in memory API');
    },
    async setAuthorRating() {
      throw new Error('Not implemented in memory API');
    },
    async reorderAuthorRatingSlots() {
      throw new Error('Not implemented in memory API');
    },
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
        producers: authors
          .filter((author) => (linkedAuthorIds.get(entryId) ?? []).includes(author.id))
          .map((author) => ({
            ...author,
            entryCount: entries
              .filter((entry) => (linkedAuthorIds.get(entry.id) ?? []).includes(author.id)).length,
          })),
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
        ratings: ratingSlots.slice().sort((left, right) => left.sortOrder - right.sortOrder)
          .map((slot) => {
            const value = entryRatings.find((row) => row.entryId === entryId && row.slotId === slot.id);
            return { slotId: slot.id, name: slot.name, stars: value ? value.stars : null };
          }),
        usage: {
          viewCount: entryUsages.find((row) => row.entryId === entryId)?.viewCount ?? 0,
          likeCount: entryUsages.find((row) => row.entryId === entryId)?.likeCount ?? 0,
          lastViewedAt: entryUsages.find((row) => row.entryId === entryId)?.lastViewedAt ?? null,
        },
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
    async listAuthorFilterOptions() {
      return {
        authorTags: authorTags.map((tag) => ({ tagId: tag.tagId, name: tag.name })),
        workTags: [
          { tagId: 1, name: 'Action' },
          { tagId: 2, name: 'RPG' },
          { tagId: 3, name: 'Manga' },
        ],
      };
    },
    async listAuthors() {
      return authors.map(({ id, name }) => ({
        id, name, covers: [], galleryType: 'game', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false,
      }));
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
        ratings: [],
        usage: { viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false },
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
    async linkEntryAuthorByName(entryId: number, name: string) {
      // 与服务端同语义:同名(或别名)已存在则关联既有作者,不新建。
      const normalized = name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
      const existing = authors.find((author) => (
        author.name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase() === normalized
      ));
      if (existing) {
        const list = linkedAuthorIds.get(entryId) ?? [];
        if (!list.includes(existing.id)) list.push(existing.id);
        linkedAuthorIds.set(entryId, list);
        return { entryId, producerId: existing.id, producerName: existing.name, created: false };
      }
      const createdProducer = { id: 900 + authors.length, name, occupation: null, artworkRef: null, content: null };
      authors.push(createdProducer);
      linkedAuthorIds.set(entryId, [...(linkedAuthorIds.get(entryId) ?? []), createdProducer.id]);
      return { entryId, producerId: createdProducer.id, producerName: name, created: true };
    },
    async linkEntryAuthor(entryId, authorId) {
      linkedAuthorIds.set(entryId, [...new Set([...(linkedAuthorIds.get(entryId) ?? []), authorId])]);
    },
    async unlinkEntryAuthor(entryId, authorId) {
      linkedAuthorIds.set(entryId, (linkedAuthorIds.get(entryId) ?? []).filter((id) => id !== authorId));
    },
    async planTitleShortening() {
      const candidates = entries.flatMap((entry) => {
        const parts = entry.title.split('|').map((part) => part.trim());
        if (!entry.title.includes('|') || parts.length !== 2) return [];
        const [front = '', back = ''] = parts;
        if (front === '' || back === '') return [];
        const suggested = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(back)
          ? 'back' as const
          : /\p{Script=Hangul}/u.test(back) ? 'front' as const : null;
        return [{
          entryId: entry.id,
          title: entry.title,
          keepFront: front,
          keepBack: back,
          suggested,
        }];
      });
      return { candidates };
    },
    async applyTitleShortening(changes) {
      let shortenedCount = 0;
      let skippedCount = 0;
      for (const change of changes) {
        const entry = entries.find((item) => item.id === change.entryId);
        if (!entry || entry.title !== change.title) {
          skippedCount += 1;
          continue;
        }
        entry.title = change.shortenedTitle;
        shortenedCount += 1;
      }
      return { shortenedCount, skippedCount, backupPath: null };
    },
    async convertEntryAuthors(entryId) {
      const linked = linkedAuthorIds.get(entryId) ?? [];
      const multiAuthor = authors.find((author) => author.name === multiAuthorProducerName);
      // Every credited Author is absorbed, whatever else they have.
      const convertible = linked
        .filter((id) => id !== multiAuthor?.id)
        .map((id) => authors.find((author) => author.id === id)!)
        .filter(Boolean);
      const target = multiAuthor ?? {
        id: Math.max(0, ...authors.map((author) => author.id)) + 1,
        name: multiAuthorProducerName,
        occupation: null,
        artworkRef: null,
        content: null,
      };
      if (!multiAuthor) authors.push(target);
      linkedAuthorIds.set(entryId, [target.id]);
      const toAuthor = (author: { id: number; name: string }) => ({ id: author.id, name: author.name });
      return {
        entryId,
        multiAuthorId: target.id,
        multiAuthorName: target.name,
        convertedAuthors: convertible.map(toAuthor),
      };
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
          ratingsRelinked: 0,
          directoriesMoved: 0,
          directoriesMerged: 0,
          membershipsMoved: 0,
          membershipsRemoved: 0,
          renamed: 0,
        },
        foreignKeyCheckPass: true,
        doctorPass: true,
        doctorIssues: [],
        templateFiles: null,
      };
    },
    async applyEntryLayoutTemplate() {
      return {
        entryType: 'game',
        entriesAffected: 0,
        tagsRelinked: 0,
        ratingsRelinked: 0,
        orphansMoved: 0,
        sectionsRecreated: 0,
        backupPath: null,
        foreignKeyCheckPass: true,
        doctorPass: true,
        doctorIssues: [],
        templateFiles: null,
      };
    },
    async deleteFacet() {
      // no-op in the in-memory fixture
    },
  };
}

// Home is the default view: tests that need a Gallery grid must open one.
async function openGalleryType(wrapper: VueWrapper, type = 'game'): Promise<void> {
  await wrapper.get(`[data-gallery-type="${type}"]`).trigger('click');
  await flushPromises();
}

async function openEntryForEditing(wrapper: VueWrapper, entryId: number): Promise<void> {
  // Home shows only recently viewed entries; open the backing Gallery when
  // the target card is not on screen.
  if (!wrapper.find(`[data-entry-id="${entryId}"]`).exists()) {
    await openGalleryType(wrapper);
  }
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

  it('shows when reads are served from the offline snapshot', () => {
    const wrapper = mount(GalleryApp, {
      props: {
        api: createMemoryApi(),
        offlineState: { mode: 'offline', lastFallbackAt: '2026-09-13T00:00:00Z' },
      },
    });

    expect(wrapper.get('[data-testid="offline-mode-banner"]').text()).toContain('offline copy');
  });

  it('opens Settings and switches all UI copy between English and Chinese', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();

    expect(wrapper.get('h1').text()).toBe('Galleries');
    await wrapper.get('[data-testid="settings-button"]').trigger('click');
    expect(wrapper.get('[data-testid="settings-panel"]').text()).toContain('Language');
    expect(wrapper.get('[data-testid="offline-settings"]').text()).toContain('Offline library');

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

  it('switches the accent color from Settings and applies it app-wide', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();

    await wrapper.get('[data-testid="settings-button"]').trigger('click');
    const root = wrapper.get('.gallery-app');
    expect(root.attributes('data-accent')).toBe('blue');

    await wrapper.get('[data-testid="accent-teal"]').trigger('click');
    expect(root.attributes('data-accent')).toBe('teal');
    expect(window.localStorage.getItem('t3.accent')).toBe('teal');

    await wrapper.get('[data-testid="accent-blue"]').trigger('click');
    expect(root.attributes('data-accent')).toBe('blue');
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

  it('saves an author alias group from Advanced editing and lists existing groups', async () => {
    const api = createMemoryApi();
    const groups: Array<{
      canonicalName: string;
      aliases: Array<{ id: number; name: string }>;
      producerId: number | null;
      producerName: string | null;
    }> = [];
    api.listAuthorAliasGroups = vi.fn(async () => groups);
    api.saveAuthorAliasGroup = vi.fn(async (input: { displayName: string; tagNames: string[] }) => {
      const group = {
        canonicalName: input.displayName,
        aliases: input.tagNames.map((name, index) => ({ id: index + 1, name })),
        producerId: null,
        producerName: null,
      };
      groups.push(group);
      return {
        group,
        merge: {
          backupPath: null,
          plans: [],
          totals: {
            deletedProducers: 0,
            worksRelinked: 0,
            tagsRelinked: 0,
            ratingsRelinked: 0,
            directoriesMoved: 0,
            directoriesMerged: 0,
            membershipsMoved: 0,
            membershipsRemoved: 0,
            renamed: 0,
          },
          foreignKeyCheckPass: true,
          doctorPass: true,
          doctorIssues: [],
        },
      };
    });
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="settings-button"]').trigger('click');
    await wrapper.get('[data-testid="advanced-entry"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="advanced-tab-authors"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="author-alias-empty"]').exists()).toBe(true);
    const form = wrapper.get('[data-testid="author-alias-form"]');
    // Fill-in inputs commit through Enter, picking a suggestion, OR blur —
    // typing and clicking Save directly must also work (blur commits first).
    // Real flow: tap the field (focus), type, tap elsewhere (blur commits).
    const displayNameInput = form.get('[name="authorAliasDisplayName"]');
    await displayNameInput.trigger('focus');
    await displayNameInput.setValue('海盗猫');
    await displayNameInput.trigger('blur');
    // The committed text stays visible: clearing it on blur looked like "my input never saved".
    expect((displayNameInput.element as HTMLInputElement).value).toBe('海盗猫');
    await wrapper.get('[data-testid="author-alias-add-tag"]').trigger('click');
    expect((displayNameInput.element as HTMLInputElement).value).toBe('海盗猫');
    const tag0 = wrapper.get('[data-testid="author-alias-tag-0"] input');
    await tag0.trigger('focus');
    await tag0.setValue('pirate cat');
    await tag0.trigger('blur');
    expect((tag0.element as HTMLInputElement).value).toBe('pirate cat');
    await wrapper.get('[data-testid="author-alias-add-tag"]').trigger('click');
    const tag1 = wrapper.get('[data-testid="author-alias-tag-1"] input');
    await tag1.trigger('focus');
    await tag1.setValue('海盜貓');
    await tag1.trigger('blur');
    expect((tag0.element as HTMLInputElement).value).toBe('pirate cat');
    await form.trigger('submit');
    await flushPromises();

    expect(api.saveAuthorAliasGroup).toHaveBeenCalledWith({
      displayName: '海盗猫',
      tagNames: ['pirate cat', '海盜貓'],
    });
    expect(wrapper.get('[data-testid="author-alias-notice"]').text()).toContain('海盗猫');
    expect(wrapper.get('[data-testid="author-alias-group-list"]').text()).toContain('pirate cat');
  });

  it('renders the gallery template tab with per-gallery structure and file paths', async () => {
    const api = createMemoryApi();
    api.listTemplates = vi.fn(async () => [{
      entryType: 'comic',
      sections: [
        { name: '信息', facets: ['Series', 'Characters'] },
        { name: '', facets: ['Tags'] },
      ],
      mappings: [{ tag: '奇幻', section: '信息', facet: 'Series' }],
      templatePath: 'C:/t3/templates/comic.template.json',
      tagLayoutPath: 'C:/t3/templates/comic.tag-layout.json',
      templateExists: true,
      tagLayoutExists: false,
    }]);
    api.listRatingSlots = vi.fn(async (type: string) => type === 'comic'
      ? [{ id: 9, name: '画力', sortOrder: 0 }]
      : []);
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="settings-button"]').trigger('click');
    await wrapper.get('[data-testid="advanced-entry"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="advanced-tab-templates"]').trigger('click');
    await flushPromises();

    // The tab renders its own panel (not the unassigned-tag content) and the
    // gallery stays collapsed until its header is clicked.
    expect(wrapper.find('[data-testid="advanced-unassigned"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="gallery-template-comic"]').exists()).toBe(true);
    await wrapper.get('[data-testid="gallery-template-comic"]').trigger('click');
    // The preview sketches the saved Section → Facet card layout; tag
    // placements are deliberately NOT listed here.
    const preview = wrapper.get('[data-testid="gallery-template-preview-comic"]').text();
    expect(preview).toContain('信息');
    expect(preview).toContain('Series');
    expect(wrapper.find('[data-testid="gallery-template-mappings-comic"]').exists()).toBe(false);
    // Full card sketch: Ratings with the gallery's shared slots, then Content.
    expect(preview).toContain('Ratings');
    expect(preview).toContain('画力');
    expect(preview).toContain('Content');
    expect(preview).toContain('source url');
    const files = wrapper.get('[data-testid="gallery-template-files-comic"]').text();
    expect(files).toContain('comic.template.json');
    expect(files).toContain('File not written yet');
  });

  it('deals one page of random works, authors, and tags from the random page', async () => {
    const api = createMemoryApi();
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="random-navigation"]').trigger('click');
    await flushPromises();

    // Works mode with one gallery: the deal returns at most one page of cards.
    await wrapper.get('[data-testid="random-deal-button"]').trigger('click');
    await flushPromises();
    const dealt = wrapper.findAll('[data-testid="random-entry-card"]');
    expect(dealt.length).toBeGreaterThan(0);
    expect(dealt.length).toBeLessThanOrEqual(24);

    // Authors mode.
    await wrapper.get('[data-testid="random-mode-authors"]').trigger('click');
    await wrapper.get('[data-testid="random-deal-button"]').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-testid="random-authors"] [data-author-id]').length).toBeGreaterThan(0);

    // Tags mode: vocabulary is assembled from currently visible Galleries.
    await wrapper.get('[data-testid="random-mode-tags"]').trigger('click');
    await wrapper.get('[data-testid="random-deal-button"]').trigger('click');
    await flushPromises();
    // Exactly ONE tag per deal, presented as the page's large reveal card.
    expect(wrapper.findAll('[data-random-tag-id]')).toHaveLength(1);
    const randomTag = wrapper.get('[data-testid="random-tag-card"]');
    const chosenTagName = randomTag.get('[data-testid="random-tag-name"]').text();
    expect(chosenTagName.length).toBeGreaterThan(0);
    expect(randomTag.get('[data-testid="random-tag-count"]').text()).toMatch(/^\d+$/u);
    await randomTag.trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="tag-results"]').text()).toContain(chosenTagName);
  });

  it('returns from an Author work to the same Author pagination state', async () => {
    const api = createMemoryApi();
    const getAuthor = api.getAuthor.bind(api);
    const getEntry = api.getEntry.bind(api);
    const works = Array.from({ length: 40 }, (_, index) => ({
      id: 500 + index,
      title: `Author work ${index + 1}`,
      type: 'game',
      coverRef: null,
      previewRef: null,
      previewRefs: [],
      uploadDate: null,
      pageCount: null,
      viewCount: 0,
      likeCount: 0,
      lastViewedAt: null,
    }));
    api.getAuthor = vi.fn(async (authorId: number) => ({
      ...(await getAuthor(authorId)),
      looseEntries: works,
    }));
    const queryEntryPage = api.queryEntryPage.bind(api);
    api.queryEntryPage = vi.fn(async (input) => {
      if (input.authorIds.includes(9) || input.looseForProducerId === 9) {
        const start = (input.page - 1) * input.pageSize;
        return { items: works.slice(start, start + input.pageSize), total: works.length, page: input.page, pageSize: input.pageSize };
      }
      return queryEntryPage(input);
    });
    api.getEntry = vi.fn(async (entryId: number) => {
      const work = works.find((candidate) => candidate.id === entryId);
      return work ? { ...(await getEntry(1)), ...work, producers: [] } : getEntry(entryId);
    });
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="author-navigation"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-author-id="9"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="author-next-page"]').trigger('click');
    const secondPageWork = wrapper.get('[data-author-work-id] .author-card-main');
    await secondPageWork.trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="entry-back"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="author-information-board"]').text()).toContain('Hypergryph');
    expect(wrapper.get('.pagination').text()).toContain('Page 2 of 2');
  });

  it('returns from a random Entry to the same dealt result set', async () => {
    const api = createMemoryApi();
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="random-navigation"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="random-deal-button"]').trigger('click');
    await flushPromises();
    const dealtCards = wrapper.findAll('[data-testid="random-entry-card"]')
      .map((card) => card.text());
    await wrapper.get('[data-testid="random-entry-card"] .entry-card-main').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="entry-back"]').trigger('click');
    await flushPromises();

    expect(wrapper.findAll('[data-testid="random-entry-card"]')
      .map((card) => card.text())).toEqual(dealtCards);
  });

  it('opens global Entry search from the sidebar and navigates from a result card', async () => {
    const api = createMemoryApi();
    api.queryEntryPage = vi.fn(async (input) => ({
      items: input.searchQuery === 'end'
        ? [{ id: 1, title: 'Endfield', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null, viewCount: 0, likeCount: 0, lastViewedAt: null }]
        : [],
      total: input.searchQuery === 'end' ? 1 : 0,
      page: input.page,
      pageSize: input.pageSize,
    }));
    api.searchTags = vi.fn(async () => []);
    api.queryProducerPage = vi.fn(async (input) => ({ items: [], total: 0, page: input.page, pageSize: input.pageSize }));
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="sidebar-search-input"]').setValue('end');
    await wrapper.get('[data-testid="sidebar-search-form"]').trigger('submit');
    await flushPromises();

    expect(wrapper.get('[data-testid="search-page"]').text()).toContain('Endfield');
    expect(api.queryEntryPage).toHaveBeenCalledWith(expect.objectContaining({ searchQuery: 'end' }));
    await wrapper.get('[data-testid="search-result-entry-1"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="entry-detail"]').text()).toContain('Endfield');
    expect(wrapper.get('[data-testid="entry-back"]').text()).toContain('Search');
  });

  it('returns to the same Search after deleting an opened result', async () => {
    const api = createMemoryApi();
    let deleted = false;
    const deleteEntry = api.deleteEntry.bind(api);
    api.deleteEntry = vi.fn(async (entryId: number) => {
      await deleteEntry(entryId);
      deleted = true;
    });
    api.queryEntryPage = vi.fn(async (input) => ({
      items: input.searchQuery === 'end' && !deleted
        ? [{ id: 1, title: 'Endfield', type: 'game', coverRef: null, previewRef: null, previewRefs: [], uploadDate: null, pageCount: null, viewCount: 0, likeCount: 0, lastViewedAt: null }]
        : [],
      total: input.searchQuery === 'end' && !deleted ? 1 : 0,
      page: input.page,
      pageSize: input.pageSize,
    }));
    api.searchTags = vi.fn(async () => []);
    api.queryProducerPage = vi.fn(async (input) => ({ items: [], total: 0, page: input.page, pageSize: input.pageSize }));
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="sidebar-search-input"]').setValue('end');
    await wrapper.get('[data-testid="sidebar-search-form"]').trigger('submit');
    await flushPromises();
    await wrapper.get('[data-testid="search-result-entry-1"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');
    const deleteButton = wrapper.get('[data-testid="delete-entry"]');
    await deleteButton.trigger('click');
    await deleteButton.trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="search-page"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="search-main-input"]').element).toHaveProperty('value', 'end');
    expect(wrapper.find('[data-testid="search-result-entry-1"]').exists()).toBe(false);
  });

  it('switches global search scopes and opens Tag and Author result views', async () => {
    const api = createMemoryApi();
    api.queryEntryPage = vi.fn(async (input) => ({ items: [], total: 0, page: input.page, pageSize: input.pageSize }));
    api.searchTags = vi.fn(async () => [{ tagId: 12, name: 'Shared', normalizedName: 'shared', entryCount: 2 }]);
    api.queryProducerPage = vi.fn(async (input) => ({
      items: input.searchQuery === 'sha' ? [{
        id: 9,
        name: 'Hypergryph',
        galleryType: 'game',
        covers: [],
        viewCount: 0,
        likeCount: 0,
        lastViewedAt: null,
        nsfw: false,
      }] : [],
      total: input.searchQuery === 'sha' ? 1 : 0,
      page: input.page,
      pageSize: input.pageSize,
    }));
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="sidebar-search-input"]').setValue('sha');
    await wrapper.get('[data-testid="sidebar-search-form"]').trigger('submit');
    await flushPromises();
    await wrapper.get('[data-testid="search-scope-tags"]').trigger('click');
    await flushPromises();
    expect(api.searchTags).toHaveBeenCalledWith('sha', false);

    await wrapper.get('[data-testid="search-result-tag-12"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="tag-results"]').text()).toContain('Shared');
    await wrapper.get('[data-testid="tag-results"] .back-button').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="search-main-input"]').element).toHaveProperty('value', 'sha');
    expect(wrapper.get('[data-testid="search-scope-tags"]').classes()).toContain('active');

    await wrapper.get('[data-testid="search-scope-producers"]').trigger('click');
    await flushPromises();
    expect(api.queryProducerPage).toHaveBeenCalledWith(expect.objectContaining({ searchQuery: 'sha' }));
    await wrapper.get('[data-testid="search-result-author-9"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="author-information-board"]').text()).toContain('Hypergryph');
    expect(wrapper.get('[data-testid="author-information-board"] .text-button').text()).toContain('Search');
  });

  it('shows the alias spelling an author was found through on the search card', async () => {
    const api = createMemoryApi();
    api.listTaxonomyAliases = vi.fn(async () => [
      {
        id: 1,
        vocabulary: 'producer' as const,
        partition: 'authors',
        alias: 'ishikei',
        normalizedAlias: 'ishikei',
        canonicalName: '石恵',
        normalizedCanonical: '石恵',
      },
      // A placeholder row belongs to no author and must not show anywhere.
      {
        id: 2,
        vocabulary: 'producer' as const,
        partition: 'authors',
        alias: 'notyet',
        normalizedAlias: 'notyet',
        canonicalName: '',
        normalizedCanonical: '',
      },
    ]);
    api.queryProducerPage = vi.fn(async (input) => ({
      items: input.searchQuery === 'ishikei' ? [{
        id: 42,
        name: '石恵',
        galleryType: 'Comic',
        covers: [],
        viewCount: 0,
        likeCount: 0,
        lastViewedAt: null,
        nsfw: false,
      }] : [],
      total: input.searchQuery === 'ishikei' ? 1 : 0,
      page: input.page,
      pageSize: input.pageSize,
    }));
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="sidebar-search-input"]').setValue('ishikei');
    await wrapper.get('[data-testid="sidebar-search-form"]').trigger('submit');
    await flushPromises();
    await wrapper.get('[data-testid="search-scope-producers"]').trigger('click');
    await flushPromises();

    // The author is found, listed under their own name, with the spelling that
    // matched shown underneath.
    const card = wrapper.get('[data-testid="search-result-author-42"]');
    expect(card.text()).toContain('石恵');
    expect(wrapper.get('[data-testid="search-result-author-alternates-42"]').text()).toBe('ishikei');
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
    expect(wrapper.get('[data-testid="desktop-entry-import"]').classes()).toContain('desktop-entry-import');

    await wrapper.get('[data-testid="add-entry-back"]').trigger('click');
    await wrapper.get('[data-testid="add-author-navigation"]').trigger('click');
    expect(wrapper.get('[data-testid="add-author-page"]').text()).toContain('New Author');
  });

  it('returns from Add Author to the Authors page', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await wrapper.get('[data-testid="author-navigation"]').trigger('click');
    expect(wrapper.find('[data-testid="author-page"]').exists()).toBe(true);

    await wrapper.get('[data-testid="add-author-navigation"]').trigger('click');
    expect(wrapper.find('[data-testid="add-author-page"]').exists()).toBe(true);
    await wrapper.get('[data-testid="add-author-page"] .back-button').trigger('click');

    expect(wrapper.find('[data-testid="author-page"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="add-author-page"]').exists()).toBe(false);
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
      skippedExistingEntryCount: 0,
      createdProducerCount: 1,
      producerLinkCount: 1,
      tagAssignmentCount: 1,
      contentCount: 2,
      authorRatingCount: 0,
      warnings: [],
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

  it('reports the source quirks a commit resolved without failing the import', async () => {
    setLocale('en');
    const api = createMemoryApi();
    api.previewSiteProbeFolder = vi.fn(async () => ({
      source: 'hitomi.la',
      entryCount: 1,
      tagAssignmentCount: 0,
      uniqueTagCount: 0,
      entriesMissingCover: 0,
      warnings: [],
      batch: {
        source: 'hitomi.la',
        warnings: [],
        entries: [{ externalKey: 'hitomi.la:1', title: 'Artist collection', tags: [] }],
      },
    }));
    api.listLayout = vi.fn(async () => [
      { id: 10, name: 'Tags', sortOrder: 0, facets: [{ id: 11, name: '', sortOrder: 0 }] },
    ]);
    api.commitImport = vi.fn(async () => ({
      entries: [{ entryId: 7, title: 'Artist collection', externalKey: 'hitomi.la:1' }],
      entryCount: 1,
      skippedExistingEntryCount: 0,
      createdProducerCount: 0,
      producerLinkCount: 0,
      tagAssignmentCount: 2,
      contentCount: 1,
      authorRatingCount: 0,
      warnings: ['Tag "Goblin Slayer" arrived for both "Series" and "Characters" in one Entry; kept the first placement'],
    }));
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    await wrapper.get('.batch-import-toggle .secondary-button').trigger('click');
    const batchTypeInput = wrapper.get('.batch-import input[list="add-entry-gallery-types"]');
    await batchTypeInput.setValue('game');
    await batchTypeInput.trigger('change');
    await flushPromises();
    const batchInput = wrapper.get('.batch-import input[webkitdirectory]');
    const file = new File(['{}'], 'metadata.json', { type: 'application/json' });
    Object.defineProperty(file, 'webkitRelativePath', {
      value: 'hews/items/4103646/metadata.json',
    });
    Object.defineProperty(batchInput.element, 'files', { value: [file] });
    await batchInput.trigger('change');
    await flushPromises();

    await wrapper.get('.batch-import .primary-button').trigger('click');
    await flushPromises();

    // The batch ran, and the review view shows the placement it skipped: the
    // Add Entry page itself is gone by the time the run finishes.
    const review = wrapper.get('[data-testid="batch-review"]');
    const warnings = review.get('[data-testid="batch-review-warnings"]');
    expect(warnings.text()).toContain('kept the first placement');
    expect(warnings.text()).toContain('Series');
  });

  it('shows which export items an import skipped', async () => {
    setLocale('zh-CN');
    const skipped = 'Skipped work 888260: items/888260/metadata.json is missing';
    const api = createMemoryApi();
    api.previewSiteProbeFolder = vi.fn(async () => ({
      source: 'hitomi.la',
      entryCount: 1,
      tagAssignmentCount: 0,
      uniqueTagCount: 0,
      entriesMissingCover: 0,
      warnings: [skipped],
      batch: {
        source: 'hitomi.la',
        warnings: [skipped],
        entries: [{ externalKey: 'hitomi.la:111', title: 'Present work', tags: [] }],
      },
    }));
    api.listLayout = vi.fn(async () => []);
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const metadata = new File(['{}'], 'metadata.json', { type: 'application/json' });
    Object.defineProperty(metadata, 'webkitRelativePath', { value: 'export/metadata.json' });
    const input = wrapper.get('input[webkitdirectory]');
    Object.defineProperty(input.element, 'files', { value: [metadata] });
    await input.trigger('change');
    await flushPromises();

    const warnings = wrapper.get('[data-testid="import-warnings"]');
    expect(warnings.text()).toContain('已跳过 1 个条目');
    expect(warnings.text()).toContain('items/888260/metadata.json is missing');
  });

  it('uploads media by external key when a manifest skips already-imported Entries', async () => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const api = createMemoryApi();
    api.previewSiteProbeFolder = vi.fn(async () => ({
      source: 'hitomi.la',
      entryCount: 2,
      tagAssignmentCount: 0,
      uniqueTagCount: 0,
      entriesMissingCover: 0,
      warnings: [],
      batch: {
        source: 'hitomi.la',
        warnings: [],
        entries: [
          {
            externalKey: 'hitomi.la:42',
            title: 'Existing work',
            cover: 'items/42/cover/cover.webp',
          },
          {
            externalKey: 'hitomi.la:99',
            title: 'New work',
            cover: 'items/99/cover/cover.webp',
          },
        ],
      },
    }));
    api.listLayout = vi.fn(async () => [{
      id: 10,
      name: 'Tags',
      sortOrder: 0,
      facets: [{ id: 11, name: '', sortOrder: 0 }],
    }]);
    api.commitImport = vi.fn(async () => ({
      entries: [{ entryId: 99, title: 'New work', externalKey: 'hitomi.la:99' }],
      entryCount: 1,
      skippedExistingEntryCount: 1,
      createdProducerCount: 0,
      producerLinkCount: 0,
      tagAssignmentCount: 0,
      contentCount: 1,
      authorRatingCount: 0,
      warnings: [],
    }));
    const uploadEntryMedia = vi.fn<GalleryApi['uploadEntryMedia']>(async () => ({
      id: 99,
      title: 'New work',
      type: 'game',
      coverRef: '/api/assets/entries/99/cover.webp',
      previewRef: null,
      previewRefs: [],
      uploadDate: null,
      pageCount: null,
    }));
    api.uploadEntryMedia = uploadEntryMedia;

    const files = [
      new File(['{}'], 'metadata.json', { type: 'application/json' }),
      new File(['old'], 'cover.webp', { type: 'image/webp' }),
      new File(['new'], 'cover.webp', { type: 'image/webp' }),
    ];
    for (const [file, path] of files.map((file, index) => [file, [
      'amamitsuki/metadata.json',
      'amamitsuki/items/42/cover/cover.webp',
      'amamitsuki/items/99/cover/cover.webp',
    ][index]!] as const)) {
      Object.defineProperty(file, 'webkitRelativePath', { value: path });
    }

    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const input = wrapper.get('.folder-dropzone input[webkitdirectory]');
    Object.defineProperty(input.element, 'files', { value: files });
    await input.trigger('change');
    await flushPromises();
    await wrapper.get('[data-testid="import-review"] .primary-button').trigger('click');
    await flushPromises();

    expect(uploadEntryMedia).toHaveBeenCalledTimes(1);
    expect(uploadEntryMedia.mock.calls[0]?.slice(0, 2)).toEqual([99, 'cover']);
    expect(uploadEntryMedia.mock.calls[0]?.[2]).toBe(files[2]);
    expect(uploadEntryMedia.mock.calls[0]?.[2]).not.toBe(files[1]);
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
      skippedExistingEntryCount: 0,
      createdProducerCount: 1,
      producerLinkCount: 1,
      tagAssignmentCount: 5,
      contentCount: 1,
      authorRatingCount: 0,
      warnings: [],
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

  it('offers existing Galleries as selectable import targets', async () => {
    const api = createMemoryApi();
    api.listGalleries = vi.fn(async () => [
      { type: 'Comic', entryCount: 1, nsfw: false },
      { type: 'Hentai', entryCount: 1, nsfw: true },
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
      skippedExistingEntryCount: 0,
      createdProducerCount: 1,
      producerLinkCount: 1,
      tagAssignmentCount: 4,
      contentCount: 1,
      authorRatingCount: 0,
      warnings: [],
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

    const typeSelect = wrapper.get<HTMLSelectElement>('[data-testid="import-review"] select[name="importType"]');
    expect(Array.from(typeSelect.element.options).map((option) => option.value)).toEqual(['Comic', 'Hentai']);
    expect(typeSelect.element.value).toBe('Comic');
    await typeSelect.setValue('Hentai');
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

  it('injects a manually entered content type into the Type facet and previews the applied template card', async () => {
    const api = createMemoryApi();
    api.listGalleries = vi.fn(async () => [{ type: 'Comic', entryCount: 1, nsfw: false }]);
    api.listLayout = vi.fn(async () => [
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
    ]);
    api.listFacetFilterOptions = vi.fn(async () => ({
      entryType: 'Comic',
      facets: [{
        facetId: 26,
        facetName: 'Type',
        sectionName: 'Basic Information',
        tags: [{ tagId: 60, name: 'doujinshi' }, { tagId: 61, name: 'artist cg' }],
      }],
      allTags: [],
      authors: [],
      ratingSlots: [],
    }));
    // hitomi exports carry no contentTypes field — the value comes from the
    // manual input and must still land on the template's Type Facet.
    api.previewSiteProbeFolder = vi.fn(async () => ({
      source: 'hitomi.la',
      entryCount: 1,
      tagAssignmentCount: 2,
      uniqueTagCount: 2,
      entriesMissingCover: 0,
      warnings: [],
      batch: {
        source: 'hitomi.la',
        warnings: [],
        entries: [{
          externalKey: 'hitomi.la:1',
          title: 'Hitomi Work',
          tags: [{ name: 'Full Color' }],
          fields: { works: ['Series'], characters: ['Character'], authors: ['Author'] },
        }],
      },
    }));
    const commitImportMock = vi.fn<GalleryApi['commitImport']>(async (batch) => ({
      entries: batch.entries.map((entry, index) => ({
        entryId: 100 + index,
        title: entry.title,
        externalKey: entry.externalKey,
      })),
      entryCount: batch.entries.length,
      skippedExistingEntryCount: 0,
      createdProducerCount: 0,
      producerLinkCount: 0,
      tagAssignmentCount: 2,
      contentCount: 1,
      authorRatingCount: 0,
      warnings: [],
    }));
    api.commitImport = commitImportMock;

    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const metadata = new File(['{}'], 'metadata.json', { type: 'application/json' });
    Object.defineProperty(metadata, 'webkitRelativePath', { value: '1/metadata.json' });
    const folderInput = wrapper.get('input[webkitdirectory]');
    Object.defineProperty(folderInput.element, 'files', { value: [metadata] });
    await folderInput.trigger('change');
    await flushPromises();

    // The template has a Type Facet, so the manual content type input shows.
    const contentTypeInput = wrapper.get('[data-testid="import-content-type"] input');
    // The preview card mirrors the applied template before anything is mapped.
    const preview = wrapper.get('[data-testid="import-template-preview"]');
    expect(preview.text()).toContain('Comic');
    expect(preview.text()).toContain('Hitomi Work');
    expect(preview.text()).toContain('Basic Information');
    expect(preview.text()).toContain('Series');
    expect(preview.text()).toContain('Full Color');
    expect(preview.text()).not.toContain('artist cg');

    await contentTypeInput.setValue('artist cg');
    expect(wrapper.get('[data-testid="import-template-preview"]').text()).toContain('artist cg');

    await wrapper.get('[data-testid="import-review"] .primary-button').trigger('click');
    await flushPromises();

    const [committedBatch, committedMapping] = commitImportMock.mock.calls[0]!;
    expect(committedBatch.entries[0]!.fields).toEqual(expect.objectContaining({
      works: ['Series'],
      characters: ['Character'],
      authors: ['Author'],
      contentTypes: ['artist cg'],
    }));
    expect(committedMapping.fieldMappings.contentTypes).toEqual({ kind: 'tag', facetId: 26 });
  });

  it('applies one manually entered content type to every batch item', async () => {
    const api = createMemoryApi();
    api.listGalleries = vi.fn(async () => [{ type: 'Comic', entryCount: 1, nsfw: false }]);
    api.listLayout = vi.fn(async () => [
      {
        id: 24,
        name: 'Basic Information',
        sortOrder: 0,
        facets: [
          { id: 26, name: 'Type', sortOrder: 1 },
          { id: 27, name: 'Series', sortOrder: 2 },
        ],
      },
      { id: 30, name: 'Tags', sortOrder: 1, facets: [{ id: 31, name: '', sortOrder: 0 }] },
    ]);
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
          externalKey: 'hitomi.la:1',
          title: 'Hitomi Work',
          tags: [{ name: 'Full Color' }],
          fields: { authors: ['Author'] },
        }],
      },
    }));
    const commitImportMock = vi.fn<GalleryApi['commitImport']>(async (batch) => ({
      entries: batch.entries.map((entry, index) => ({
        entryId: 200 + index,
        title: entry.title,
        externalKey: entry.externalKey,
      })),
      entryCount: batch.entries.length,
      skippedExistingEntryCount: 0,
      createdProducerCount: 0,
      producerLinkCount: 1,
      tagAssignmentCount: 1,
      contentCount: 1,
      authorRatingCount: 0,
      warnings: [],
    }));
    api.commitImport = commitImportMock;

    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    await wrapper.get('.batch-import-toggle .secondary-button').trigger('click');

    const batchTypeInput = wrapper.get('.batch-import input[list="add-entry-gallery-types"]');
    await batchTypeInput.setValue('Comic');
    await batchTypeInput.trigger('change');
    await flushPromises();

    // The Comic template has a Type Facet, so the batch-wide input shows.
    await wrapper.get('[data-testid="batch-content-type"] input').setValue('doujinshi');

    const batchInput = wrapper.get('.batch-import input[webkitdirectory]');
    const files = ['100089', '102331'].map((itemId) => {
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

    expect(commitImportMock).toHaveBeenCalledTimes(2);
    for (const [committedBatch, committedMapping] of commitImportMock.mock.calls) {
      expect(committedBatch.entries[0]!.fields).toEqual(expect.objectContaining({
        contentTypes: ['doujinshi'],
      }));
      expect(committedMapping.fieldMappings.contentTypes).toEqual({ kind: 'tag', facetId: 26 });
    }
    // The temporary batch review group appears after the commits.
    expect(wrapper.find('[data-testid="batch-review"]').exists()).toBe(true);
  });

  it('batch import auto-links items by the same author to one producer across commits', async () => {
    const api = createMemoryApi();
    const authorList: Array<{ id: number; name: string; covers: string[]; galleryType: string | null; viewCount: number; likeCount: number; lastViewedAt: string | null; nsfw: boolean }> = [
      { id: 9, name: 'Hypergryph', covers: [], galleryType: 'game', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false },
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
      if (commitCount === 1) authorList.push({ id: 100, name: 'Peh-koi', covers: [], galleryType: null, viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false });
      return {
        entries: batch.entries.map((entry, index) => ({
          entryId: 100 + index,
          title: entry.title,
          externalKey: entry.externalKey,
        })),
        entryCount: batch.entries.length,
        skippedExistingEntryCount: 0,
        createdProducerCount: commitCount === 1 ? 1 : 0,
        producerLinkCount: 1,
        tagAssignmentCount: 1,
        contentCount: 1,
        authorRatingCount: 0,
        warnings: [],
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
    // The temporary batch review group appears after the commits.
    expect(wrapper.find('[data-testid="batch-review"]').exists()).toBe(true);
  });

  it('auto-links an imported author name through the producer taxonomy dictionary', async () => {
    const api = createMemoryApi();
    api.listAuthors = vi.fn(async () => [
      { id: 9, name: 'Hypergryph', covers: [], galleryType: 'game', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false },
      { id: 100, name: '鲍勃', covers: [], galleryType: null, viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false },
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
      skippedExistingEntryCount: 0,
      createdProducerCount: 0,
      producerLinkCount: 1,
      tagAssignmentCount: 1,
      contentCount: 1,
      authorRatingCount: 0,
      warnings: [],
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

  it('requires two explicit taps before deleting an Author from edit mode', async () => {
    const api = createMemoryApi();
    const deleteAuthor = vi.spyOn(api, 'deleteAuthor');
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="author-navigation"]').trigger('click');
    await wrapper.get('[data-author-id="9"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="start-author-editing"]').trigger('click');

    const button = wrapper.get('[data-testid="delete-author"]');
    await button.trigger('click');
    expect(deleteAuthor).not.toHaveBeenCalled();
    expect(button.classes()).toContain('armable-armed');
    expect(button.text()).toContain('Delete Hypergryph?');

    await button.trigger('click');
    await flushPromises();
    expect(deleteAuthor).toHaveBeenCalledOnce();
    expect(deleteAuthor).toHaveBeenCalledWith(9);
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
    const input = wrapper.get('[name="existingAuthorName"]');
    // The dropdown only opens for a focused field, like a real keyboard flow.
    await input.trigger('focus');
    await input.setValue('guest');
    await suggestionDebounce();
    const suggestions = wrapper.get('[data-testid="link-existing-author-form"] [role="listbox"]');
    expect(suggestions.text()).toContain('Guest Artist');
    expect(suggestions.text()).not.toContain('Hypergryph');
    // Enter without a highlighted candidate must not link anything.
    await input.trigger('keydown.enter');
    await flushPromises();
    expect(wrapper.find('[data-entry-author-id="10"]').exists()).toBe(false);
    await suggestions.get('[role="option"] button').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-entry-author-id="10"]').text()).toContain('Guest Artist');
  });

  it('adds an Entry Tag through a server suggestion by submitting the canonical name', async () => {
    const api = createMemoryApi();
    const assignSpy = vi.spyOn(api, 'assignEntryTag');
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-add-tag-facet-id="11"]').trigger('click');
    const input = wrapper.get('[data-create-tag-facet-id="11"] [name="tagName"]');
    await input.trigger('focus');
    await input.setValue('rogue');
    await suggestionDebounce();
    const options = wrapper.get('[data-create-tag-facet-id="11"] [role="listbox"]').findAll('[role="option"] button');
    expect(options.map((option) => option.text())).toEqual(['Roguelike']);
    await options[0]!.trigger('click');
    await flushPromises();

    expect(assignSpy).toHaveBeenCalledWith(1, { facetId: 11, name: 'Roguelike' });
    expect(wrapper.get('[data-facet-id="11"]').text()).toContain('Roguelike');
  });

  it('keeps the editor open for consecutive tags: type, tap away, type again', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-add-tag-facet-id="11"]').trigger('click');
    const input = wrapper.get('[data-create-tag-facet-id="11"] [name="tagName"]');
    // Short editor that grows with the text, never with the dropdown.
    expect(input.attributes('size')).toBe('5');
    await input.setValue('女仆');
    await input.trigger('blur');
    await flushPromises();
    expect(wrapper.get('[data-facet-id="11"]').text()).toContain('女仆');

    // The editor closed with the commit; open it again for the second tag —
    // this mirrors the old rhythm of adding several tags in a row.
    await wrapper.get('[data-add-tag-facet-id="11"]').trigger('click');
    const second = wrapper.get('[data-create-tag-facet-id="11"] [name="tagName"]');
    await second.setValue('女忍');
    await second.trigger('blur');
    await flushPromises();
    expect(wrapper.get('[data-facet-id="11"]').text()).toContain('女忍');
  });

  it('links the existing Author instead of creating a duplicate when the name matches', async () => {
    const api = createMemoryApi({ withUnlinkedAuthor: true });
    const createAuthor = vi.spyOn(api, 'createAuthor');
    const linkByName = vi.spyOn(api, 'linkEntryAuthorByName');
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-testid="add-entry-author"]').trigger('click');
    // 「Guest Artist」是库里已有作者(未关联到这个 Entry);大小写不同也应命中
    await wrapper.get('[name="authorName"]').setValue('guest artist');
    await wrapper.get('[name="authorName"]').trigger('keydown.enter');
    await flushPromises();

    expect(linkByName).toHaveBeenCalledWith(1, 'guest artist');
    // 走的是"解析或创建"这一条路径,不再先建后链
    expect(createAuthor).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="entry-detail"]').text()).toContain('Guest Artist');
  });

  it('warns when a new Author name matches an existing Author or alias', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-testid="add-entry-author"]').trigger('click');
    await wrapper.get('[name="authorName"]').setValue('Hyper');
    await suggestionDebounce(260);

    expect(wrapper.get('[data-testid="create-author-duplicate-warning"]').text())
      .toContain('Hypergryph');
  });

  it('unlinks one Author inline from Entry edit mode', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-unlink-author-id="9"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-unlink-author-id="9"]').exists()).toBe(false);
    await wrapper.get('[data-testid="link-entry-author"]').trigger('click');
    await wrapper.get('[name="existingAuthorName"]').trigger('focus');
    await wrapper.get('[name="existingAuthorName"]').setValue('hyper');
    await suggestionDebounce();
    expect(wrapper.get('[data-testid="link-existing-author-form"] [role="listbox"]').text()).toContain('Hypergryph');
  });

  it('returns an Entry opened from an Author to that Author detail', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const scrollY = vi.spyOn(window, 'scrollY', 'get').mockReturnValue(600);
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await wrapper.get('[data-testid="author-navigation"]').trigger('click');
    await wrapper.get('[data-author-id="9"]').trigger('click');
    await flushPromises();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, left: 0, behavior: 'auto' });

    scrollY.mockReturnValue(300);
    await wrapper.get('[data-author-work-id="1"] .author-card-main').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="entry-back"]').text()).toBe('← Back to Hypergryph');
    await wrapper.get('[data-testid="entry-back"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="author-information-board"]').text()).toContain('Hypergryph');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 300, left: 0, behavior: 'auto' });

    await wrapper.get('[data-testid="author-information-board"] .author-toolbar .text-button').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-author-id="9"]').text()).toContain('Hypergryph');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 600, left: 0, behavior: 'auto' });
    scrollY.mockRestore();
    scrollTo.mockRestore();
  });

  it('returns to the Author page when the opened work is deleted', async () => {
    const api = createMemoryApi();
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="author-navigation"]').trigger('click');
    await wrapper.get('[data-author-id="9"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-author-work-id="1"] .author-card-main').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');
    const deleteButton = wrapper.get('[data-testid="delete-entry"]');
    await deleteButton.trigger('click');
    await deleteButton.trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="author-information-board"]').text()).toContain('Hypergryph');
    expect(wrapper.find('[data-testid="gallery-main"]').exists()).toBe(false);
  });

  it('waits for an Author second page to render before restoring its Entry scroll position', async () => {
    const api = createMemoryApi();
    const originalGetAuthor = api.getAuthor.bind(api);
    const originalQueryEntryPage = api.queryEntryPage.bind(api);
    const baseAuthor = await originalGetAuthor(9);
    const seedWork = baseAuthor.looseEntries[0]!;
    const works = Array.from({ length: 40 }, (_, index) => ({
      ...seedWork,
      id: 100 + index,
      title: `Author work ${index + 1}`,
      previewRef: null,
      previewRefs: [],
      uploadDate: null,
      pageCount: null,
    }));
    api.getAuthor = vi.fn(async (authorId: number) => authorId === 9
      ? {
          ...baseAuthor,
          looseEntries: [],
          looseEntryCount: works.length,
          workTypes: ['game'],
        }
      : originalGetAuthor(authorId));
    const originalGetEntry = api.getEntry.bind(api);
    api.getEntry = vi.fn(async (entryId: number) => {
      const work = works.find((candidate) => candidate.id === entryId);
      return work
        ? { ...(await originalGetEntry(1)), id: work.id, title: work.title, type: work.type }
        : originalGetEntry(entryId);
    });
    let secondPageRequestCount = 0;
    let releaseRestoredPage: (() => void) | undefined;
    const restoredPageGate = new Promise<void>((resolve) => { releaseRestoredPage = resolve; });
    api.queryEntryPage = vi.fn(async (input) => {
      if (input.looseForProducerId !== 9) return originalQueryEntryPage(input);
      if (input.page === 2) {
        secondPageRequestCount += 1;
        if (secondPageRequestCount === 2) await restoredPageGate;
      }
      const start = (input.page - 1) * input.pageSize;
      return {
        items: works.slice(start, start + input.pageSize),
        total: works.length,
        page: input.page,
        pageSize: input.pageSize,
      };
    });
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const scrollY = vi.spyOn(window, 'scrollY', 'get').mockReturnValue(0);
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="author-navigation"]').trigger('click');
    await wrapper.get('[data-author-id="9"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="author-next-page"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('.author-works .pagination span').text()).toContain('2 of 2');

    scrollY.mockReturnValue(420);
    const sourceWork = wrapper.findAll('[data-author-work-id]').at(-1)!;
    const sourceId = sourceWork.attributes('data-author-work-id');
    await sourceWork.get('.author-card-main').trigger('click');
    await flushPromises();
    scrollTo.mockClear();

    void wrapper.get('[data-testid="top-bar-back"]').trigger('click');
    await flushPromises();
    expect(scrollTo).not.toHaveBeenCalledWith({ top: 420, left: 0, behavior: 'auto' });

    releaseRestoredPage?.();
    await flushPromises();
    expect(wrapper.get('.author-works .pagination span').text()).toContain('2 of 2');
    expect(wrapper.find(`[data-author-work-id="${sourceId}"]`).exists()).toBe(true);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 420, left: 0, behavior: 'auto' });
    scrollY.mockRestore();
    scrollTo.mockRestore();
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

  it('leaves a collection straight from the Entry detail menu when it is already joined', async () => {
    const api = createMemoryApi();
    const created = await api.createCollection({ kind: 'entry', title: 'Read list' });
    const addCollectionEntry = vi.fn(async () => undefined);
    const removeCollectionEntry = vi.fn(async () => undefined);
    api.addCollectionEntry = addCollectionEntry;
    api.removeCollectionEntry = removeCollectionEntry;
    api.listCollectionsForEntry = vi.fn(async () => [created.id]);

    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-testid="entry-add-to-collection"] button').trigger('click');
    await flushPromises();

    const option = wrapper.get('[data-testid="entry-add-to-collection"] .add-to-collection-option');
    expect(option.text()).toContain('✓ Read list');
    expect(option.attributes('aria-checked')).toBe('true');
    expect(option.attributes('disabled')).toBeUndefined();

    await option.trigger('click');
    await flushPromises();

    expect(removeCollectionEntry).toHaveBeenCalledWith(created.id, 1);
    expect(addCollectionEntry).not.toHaveBeenCalled();
    // 菜单保持打开，✓ 就地消失，可继续退出其它合集。
    expect(option.text()).not.toContain('✓');
    expect(option.attributes('aria-checked')).toBe('false');

    await option.trigger('click');
    await flushPromises();

    expect(addCollectionEntry).toHaveBeenCalledWith(created.id, 1);
    expect(removeCollectionEntry).toHaveBeenCalledTimes(1);
    // 加入与退出都保持菜单打开（✓ 就地更新），可连续勾选多个合集。
    expect(wrapper.get('[data-testid="entry-add-to-collection"] .add-to-collection-option').text()).toContain('✓');
  });

  it('keeps the Entry collection menu open across joins and closes it on outside taps', async () => {
    const api = createMemoryApi();
    await api.createCollection({ kind: 'entry', title: 'Read list' });
    await api.createCollection({ kind: 'entry', title: 'Watch list' });
    // attachTo: document.body — the outside-tap handler listens on the
    // document, which requires the component tree to be attached.
    const wrapper = mount(GalleryApp, { props: { api }, attachTo: document.body });
    await flushPromises();
    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-testid="entry-add-to-collection"] button').trigger('click');
    await flushPromises();
    const options = wrapper.findAll('[data-testid="entry-add-to-collection"] .add-to-collection-option');
    expect(options).toHaveLength(2);

    // Join the first collection; the menu stays open for the second pick.
    await options[0]!.trigger('click');
    await flushPromises();
    expect(options[0]!.text()).toContain('✓ Read list');
    expect(wrapper.findAll('[data-testid="entry-add-to-collection"] .add-to-collection-option')).toHaveLength(2);

    // Join the second one in the same session.
    const stillOpen = wrapper.findAll('[data-testid="entry-add-to-collection"] .add-to-collection-option');
    await stillOpen[1]!.trigger('click');
    await flushPromises();
    expect(stillOpen[1]!.text()).toContain('✓ Watch list');

    // A tap outside the menu closes it.
    await wrapper.get('[data-testid="entry-detail"]').trigger('pointerdown');
    await flushPromises();
    expect(wrapper.find('[data-testid="entry-add-to-collection"] .add-to-collection-option').exists()).toBe(false);
  });

  it('opens an Author detail by tapping its chip in Entry read mode', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-entry-author-id="9"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="author-information-board"]').text()).toContain('Hypergryph');
  });

  it('opens all matching Entries by tapping an Entry Tag in read mode', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-detail-tag-id="12"]').trigger('click');
    await flushPromises();

    const results = wrapper.get('[data-testid="tag-results"]');
    expect(results.text()).toContain('ARPG');
    expect(results.text()).toContain('Endfield');
    expect(results.text()).toContain('Hades II');
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' });

    await wrapper.get('[data-tag-entry-id="2"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="entry-back"]').text()).toBe('← Back to ARPG');
    await wrapper.get('[data-testid="entry-back"]').trigger('click');
    expect(wrapper.get('[data-testid="tag-results"]').text()).toContain('ARPG');
    scrollTo.mockRestore();
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

    // The app jumps straight into the freshly created entry.
    expect(wrapper.get('[data-testid="entry-detail"]').text()).toContain('Steins;Gate');
    // The new Gallery exists in the sidebar with the entry counted.
    expect(wrapper.get('[data-gallery-type="visual novel"]').text()).toContain('1');
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

  it('opens a Gallery card at the top and restores the Gallery scroll position on Back', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const scrollY = vi.spyOn(window, 'scrollY', 'get').mockReturnValue(640);
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await wrapper.get('[data-gallery-type="game"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, left: 0, behavior: 'auto' });

    scrollY.mockReturnValue(0);
    await wrapper.get('[data-testid="entry-back"]').trigger('click');
    await flushPromises();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 640, left: 0, behavior: 'auto' });
    scrollY.mockRestore();
    scrollTo.mockRestore();
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

  it('renames an Entry by double-clicking its title only while Entry edit mode is active', async () => {
    const api = createMemoryApi();
    const updateEntry = vi.fn(async (entryId: number, input: { title?: string }) => ({
      id: entryId,
      title: input.title ?? 'Endfield',
      type: 'game',
      coverRef: null,
      previewRef: null,
      previewRefs: [],
      uploadDate: null,
      pageCount: null,
    }));
    Object.assign(api, { updateEntry });
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();
    await wrapper.get('.detail-heading h2').trigger('dblclick');
    expect(wrapper.find('[data-testid="entry-title-input"]').exists()).toBe(false);

    await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');
    await wrapper.get('.detail-heading h2').trigger('dblclick');
    const input = wrapper.get('[data-testid="entry-title-input"]');
    expect((input.element as HTMLInputElement).value).toBe('Endfield');

    await input.setValue('  Endfield: New Title  ');
    await input.trigger('keydown.enter');
    await flushPromises();

    expect(updateEntry).toHaveBeenCalledOnce();
    expect(updateEntry).toHaveBeenCalledWith(1, { title: 'Endfield: New Title' });
    expect(wrapper.get('.detail-heading h2').text()).toBe('Endfield: New Title');
  });

  it('replaces every credited Author of a work with the multi-author Author', async () => {
    const api = createMemoryApi();
    const convertEntryAuthors = vi.spyOn(api, 'convertEntryAuthors');
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    // Hypergryph keeps three works and the two Guests exist nowhere else; the
    // conversion deliberately does not judge who deserves to stay.
    const guestA = await api.createAuthor({ name: 'Guest A' });
    const guestB = await api.createAuthor({ name: 'Guest B' });
    await api.linkEntryAuthor(1, guestA.id);
    await api.linkEntryAuthor(1, guestB.id);

    await openGalleryType(wrapper);
    await openEntryForEditing(wrapper, 1);

    const button = wrapper.get('[data-testid="convert-multi-author"]');
    expect(button.text()).toContain('3');
    expect(button.attributes('title')).toContain(multiAuthorProducerName);
    await button.trigger('click');
    await flushPromises();

    expect(convertEntryAuthors).toHaveBeenCalledWith(1);
    const chipText = wrapper.findAll('[data-entry-author-id]').map((chip) => chip.text()).join(' ');
    expect(chipText).toContain(multiAuthorProducerName);
    expect(chipText).not.toContain('Hypergryph');
    expect(chipText).not.toContain('Guest A');
    expect(chipText).not.toContain('Guest B');
    expect(wrapper.get('[data-testid="multi-author-notice"]').text())
      .toContain('Replaced 3 Author(s) with multiple author');
    // Only the multi-author Author is left, so the action disappears.
    expect(wrapper.find('[data-testid="convert-multi-author"]').exists()).toBe(false);
  });

  it('offers no multi-author action on a work with a single Author', async () => {
    const api = createMemoryApi();
    const convertEntryAuthors = vi.spyOn(api, 'convertEntryAuthors');
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await openGalleryType(wrapper);
    await openEntryForEditing(wrapper, 1);

    expect(wrapper.find('[data-testid="convert-multi-author"]').exists()).toBe(false);
    expect(convertEntryAuthors).not.toHaveBeenCalled();
  });

  it('plans and applies title shortening from Advanced editing', async () => {
    const api = createMemoryApi();
    const applyTitleShortening = vi.spyOn(api, 'applyTitleShortening');
    // The plan is reviewed before anything is written, so the fixtures carry
    // the three title shapes this feature cares about.
    await api.updateEntry(1, { title: 'Hyakudaku no Tou | 百濁之塔 -壹-' });
    await api.updateEntry(2, { title: 'Yuuka (Gym Uniform) | 유우카' });
    await api.updateEntry(3, { title: 'Nagareboshi | Shooting Star' });
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="settings-button"]').trigger('click');
    await wrapper.get('[data-testid="advanced-entry"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="advanced-tab-titles"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-testid="title-plan-button"]').trigger('click');
    await flushPromises();

    // Every candidate offers both sides; the plan's suggestion is preselected
    // — keep the translated side, but keep the original when the other side is
    // only Korean.
    expect(wrapper.get('[data-testid="title-plan-item-0"]').text())
      .toContain('百濁之塔 -壹-');
    expect(wrapper.get('[data-testid="title-keep-back-0"]').classes()).toContain('active');
    expect(wrapper.get('[data-testid="title-keep-front-1"]').classes()).toContain('active');
    // Both sides ASCII: nothing is preselected.
    expect(wrapper.get('[data-testid="title-keep-front-2"]').classes()).not.toContain('active');
    expect(wrapper.get('[data-testid="title-keep-back-2"]').classes()).not.toContain('active');
    expect(wrapper.get('[data-testid="title-undecided-2"]').text()).toContain('plain ASCII');
    // Two preselected decisions are ready to apply.
    expect(wrapper.get('[data-testid="title-apply-button"]').text()).toContain('Shorten 2 titles');

    // Overriding a suggestion is a single click.
    await wrapper.get('[data-testid="title-keep-back-1"]').trigger('click');
    expect(wrapper.get('[data-testid="title-apply-button"]').text()).toContain('Shorten 2 titles');

    // Destructive bulk edit: the first tap only arms the button.
    const applyButton = wrapper.get('[data-testid="title-apply-button"]');
    await applyButton.trigger('click');
    expect(applyTitleShortening).not.toHaveBeenCalled();
    expect(applyButton.text()).toContain('Confirm 2');
    await applyButton.trigger('click');
    await flushPromises();

    expect(applyTitleShortening).toHaveBeenCalledWith([
      { entryId: 1, title: 'Hyakudaku no Tou | 百濁之塔 -壹-', shortenedTitle: '百濁之塔 -壹-' },
      { entryId: 2, title: 'Yuuka (Gym Uniform) | 유우카', shortenedTitle: '유우카' },
    ]);
    expect(wrapper.get('[data-testid="title-totals"]').text())
      .toContain('Shortened 2, skipped 0');
    expect((await api.getEntry(1)).title).toBe('百濁之塔 -壹-');
    expect((await api.getEntry(2)).title).toBe('유우카');
    // The undecided one keeps its title.
    expect((await api.getEntry(3)).title).toBe('Nagareboshi | Shooting Star');
  });

  it('requires two explicit taps before deleting an Entry from edit mode', async () => {
    const api = createMemoryApi();
    const deleteEntry = vi.spyOn(api, 'deleteEntry');
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openGalleryType(wrapper);
    await openEntryForEditing(wrapper, 1);

    const button = wrapper.get('[data-testid="delete-entry"]');
    await button.trigger('click');
    expect(deleteEntry).not.toHaveBeenCalled();
    expect(button.classes()).toContain('armable-armed');
    expect(button.text()).toContain('Confirm');

    await button.trigger('click');
    await flushPromises();
    expect(deleteEntry).toHaveBeenCalledOnce();
    expect(deleteEntry).toHaveBeenCalledWith(1);
    expect(wrapper.get('[data-testid="active-gallery-title"]').text()).toBe('game');
    expect(wrapper.find('[data-entry-id="1"]').exists()).toBe(false);
    expect(wrapper.find('[data-entry-id="2"]').exists()).toBe(true);
  });

  it('keeps Tag mutation and dragging controls out of read mode', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openGalleryType(wrapper);

    await wrapper.get('[data-entry-id="2"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="add-section-button"]').exists()).toBe(false);
    expect(wrapper.find('[data-add-facet-section-id="10"]').exists()).toBe(false);
    expect(wrapper.find('[data-add-tag-facet-id="11"]').exists()).toBe(false);
    expect(wrapper.find('[data-remove-entry-tag-id="12"]').exists()).toBe(false);
    expect(wrapper.get('[data-detail-tag-id="12"]').attributes('draggable')).toBeUndefined();
  });

  it('renders direct Section Tags without showing empty Facet rows', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openGalleryType(wrapper);
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
    expect(form.find('button[type="submit"]').exists()).toBe(false);
    await input.setValue(tagName);
    // Tap-elsewhere-to-save: blur commits the typed tag (or closes when empty).
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
    await openGalleryType(wrapper);

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
    await input.trigger('keydown.enter');
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

  it('moves an Entry Tag by tapping it and then choosing a target Facet', async () => {
    const api = createMemoryApi();
    const moveEntryTag = vi.spyOn(api, 'moveEntryTag');
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-add-facet-section-id="10"]').trigger('click');
    const form = wrapper.get('[data-create-facet-section-id="10"]');
    await form.get('[name="facetName"]').setValue('Genre');
    await form.trigger('submit');
    await flushPromises();

    const source = wrapper.get('[data-detail-tag-id="12"]');
    expect(wrapper.get('[data-testid="tag-move-hint"]').text()).toContain('Tap a Tag');
    expect(source.attributes('aria-pressed')).toBe('false');
    expect(wrapper.find('[data-move-selected-tag-to-facet-id="16"]').exists()).toBe(false);

    await source.trigger('click');

    expect(wrapper.get('[data-detail-tag-id="12"]').attributes('aria-pressed')).toBe('true');
    const target = wrapper.get('[data-move-selected-tag-to-facet-id="16"]');
    await target.trigger('click');
    await flushPromises();

    expect(moveEntryTag).toHaveBeenCalledWith(1, 12, 16);
    expect(wrapper.get('[data-detail-tag-id="12"]').attributes('aria-pressed')).toBe('false');
    expect(wrapper.find('[data-move-selected-tag-to-facet-id="11"]').exists()).toBe(false);
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
      ratingsRelinked: 0,
      orphansMoved: 0,
      sectionsRecreated: 1,
      backupPath: null,
      foreignKeyCheckPass: true,
      doctorPass: true,
      doctorIssues: [],
      templateFiles: null,
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

    // Two-step confirmation: first click arms the button, second runs it.
    await wrapper.get('[data-testid="save-template-button"]').trigger('click');
    expect(apply).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="save-template-button"]').trigger('click');
    await flushPromises();
    expect(apply).toHaveBeenCalledWith(1);
    expect(wrapper.get('[data-testid="template-notice"]').text()).toContain('Template applied');

    // The empty-facet toggle flips its label and reveals empty named Facets.
    const toggle = wrapper.get('[data-testid="toggle-empty-facets"]');
    await toggle.trigger('click');
    expect(wrapper.get('[data-testid="toggle-empty-facets"]').text()).toContain('Hide empty facets');
  });

  it('clears a template success notice before another Entry or Gallery is opened', async () => {
    const api = createMemoryApi();
    api.applyEntryLayoutTemplate = vi.fn(async () => ({
      entryType: 'game',
      entriesAffected: 2,
      tagsRelinked: 3,
      ratingsRelinked: 0,
      orphansMoved: 0,
      sectionsRecreated: 1,
      backupPath: null,
      foreignKeyCheckPass: true,
      doctorPass: true,
      doctorIssues: [],
      templateFiles: null,
    }));
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);
    await wrapper.get('[data-testid="save-template-button"]').trigger('click');
    await wrapper.get('[data-testid="save-template-button"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="template-notice"]').exists()).toBe(true);

    await wrapper.get('[data-gallery-type="manga"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-entry-id="3"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="template-notice"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="entry-detail"]').text()).toContain('Witch Hat Atelier');
  });

  it('automatically dismisses a template success notice', async () => {
    let dismissNotice: (() => void) | null = null;
    const timeout = vi.spyOn(window, 'setTimeout').mockImplementation(((handler: TimerHandler) => {
      dismissNotice = handler as () => void;
      return 1;
    }) as typeof window.setTimeout);
    const api = createMemoryApi();
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);
    await wrapper.get('[data-testid="save-template-button"]').trigger('click');
    await wrapper.get('[data-testid="save-template-button"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="template-notice"]').exists()).toBe(true);
    expect(timeout).toHaveBeenCalled();
    expect(dismissNotice).not.toBeNull();
    dismissNotice!();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="template-notice"]').exists()).toBe(false);
    timeout.mockRestore();
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
    // Two-step confirmation on the small delete chip: × arms, 确认 runs.
    await wrapper.get('[data-delete-facet-id="15"]').trigger('click');
    expect(removeFacet).not.toHaveBeenCalled();
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

    const filterBar = wrapper.get('[data-testid="facet-filter-bar"]');
    expect(filterBar.text()).not.toContain('Everything combines with AND');
    expect(filterBar.find('.filter-add-actions').exists()).toBe(true);
    expect(filterBar.find('.filter-sort-actions').exists()).toBe(true);

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

    await wrapper.get('[data-testid="facet-picker-button"]').trigger('click');
    expect(wrapper.get('[data-testid="facet-dropdown"]').text()).not.toContain('Authors');
    await wrapper.get('[data-testid="add-author-filter"]').trigger('click');
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

  it('creates a shared rating row and stores half-step stars on the Entry detail', async () => {
    const api = createMemoryApi();
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    // Ratings sit after the Section board but before Content.
    const ratingArea = wrapper.get('[data-testid="entry-ratings"]');
    const contentArea = wrapper.get('.content-section');
    const detailChildren = Array.from(ratingArea.element.parentElement!.children);
    expect(detailChildren.indexOf(ratingArea.element)).toBeLessThan(detailChildren.indexOf(contentArea.element));
    expect(ratingArea.text()).not.toContain('Quality');
    await wrapper.get('[data-testid="add-rating-button"]').trigger('click');
    await wrapper.get('[data-testid="create-rating-form"] input').setValue('Quality');
    await wrapper.get('[data-testid="create-rating-form"]').trigger('submit');
    await flushPromises();

    const area = wrapper.get('[data-testid="entry-ratings"]');
    expect(area.text()).toContain('Quality');
    // A fresh slot exists on every same-Gallery card but is unrated (not zero):
    // the edit-mode picker shows empty stars.
    const freshRow = area.get('[data-rating-slot-id="100"]');
    expect(freshRow.find('[data-set-stars="3.5"]').exists()).toBe(true);
    expect(freshRow.get('.star-display-fill').attributes('style')).toContain('0%');

    // Half-step star pick: click the 3.5 zone of the shared slot.
    await area.get('[data-rating-slot-id="100"] [data-set-stars="3.5"]').trigger('click');
    await flushPromises();
    const ratedRow = wrapper.get('[data-testid="entry-ratings"] [data-rating-slot-id="100"]');
    expect(ratedRow.find('[data-clear-rating-slot-id="100"]').exists()).toBe(true);
    const fillStyle = ratedRow.get('.star-display-fill').attributes('style');
    expect(fillStyle).toContain('70%');

    // Leaving edit mode shows the read-only display instead of the picker.
    await wrapper.get('[data-testid="finish-entry-editing"]').trigger('click');
    await flushPromises();
    const readRow = wrapper.get('[data-testid="entry-ratings"] [data-rating-slot-id="100"]');
    expect(readRow.find('.star-display-fill').exists()).toBe(true);
    expect(readRow.find('.star-picker').exists()).toBe(false);

    // Clearing the stars returns the row to the unrated state.
    await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="entry-ratings"] [data-clear-rating-slot-id="100"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="entry-ratings"] [data-rating-slot-id="100"] .star-display-fill')
      .attributes('style')).toContain('0%');
  });

  it('reorders rating rows and shares the order across the Gallery template', async () => {
    const api = createMemoryApi();
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-testid="add-rating-button"]').trigger('click');
    await wrapper.get('[data-testid="create-rating-form"] input').setValue('Quality');
    await wrapper.get('[data-testid="create-rating-form"]').trigger('submit');
    await flushPromises();
    await wrapper.get('[data-testid="add-rating-button"]').trigger('click');
    await wrapper.get('[data-testid="create-rating-form"] input').setValue('Speed');
    await wrapper.get('[data-testid="create-rating-form"]').trigger('submit');
    await flushPromises();

    // Slots appear in creation order: Quality (100), Speed (101).
    expect(wrapper.get('[data-testid="entry-ratings"]').text()).toContain('Quality');
    let rowNames = wrapper.findAll('[data-testid="entry-ratings"] [data-rating-slot-id]')
      .map((row) => row.find('.rating-name').text());
    expect(rowNames).toEqual(['Quality', 'Speed']);

    // Moving Speed up persists through the shared template: reopening any
    // Entry of the same Gallery keeps the new order.
    await wrapper.get('[data-testid="entry-ratings"] [data-move-rating-up-id="101"]').trigger('click');
    await flushPromises();
    rowNames = wrapper.findAll('[data-testid="entry-ratings"] [data-rating-slot-id]')
      .map((row) => row.find('.rating-name').text());
    expect(rowNames).toEqual(['Speed', 'Quality']);

    await wrapper.get('[data-testid="finish-entry-editing"]').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-testid="entry-ratings"] [data-rating-slot-id]')
      .map((row) => row.find('.rating-name').text())).toEqual(['Speed', 'Quality']);
  });

  it('filters and sorts the gallery by rating rows in the filter bar', async () => {
    const api = createMemoryApi();
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openGameGallery(wrapper);

    // The shared rating slot of the Gallery enables the rating controls.
    await wrapper.get('[data-testid="add-rating-filter"]').trigger('click');
    await wrapper.get('[data-testid="rating-slot-select"]').setValue(40);
    await flushPromises();
    // Default row: Quality equals 3 stars → only Hades II matches.
    expect(wrapper.get('[data-testid="entry-list"]').text()).not.toContain('Endfield');
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('Hades II');

    await wrapper.get('[data-testid="rating-operator-select"]').setValue('gt');
    await flushPromises();
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('Endfield');
    expect(wrapper.get('[data-testid="entry-list"]').text()).not.toContain('Hades II');

    await wrapper.get('[data-testid="rating-operator-select"]').setValue('unrated');
    await flushPromises();
    expect(wrapper.get('[data-testid="entry-list"]').text()).not.toContain('Endfield');
    expect(wrapper.get('[data-testid="entry-list"]').text()).not.toContain('Hades II');

    // Back to gt 3, then activate the rating sort: Endfield (5) precedes nothing else.
    await wrapper.get('[data-testid="rating-operator-select"]').setValue('gt');
    await flushPromises();
    await wrapper.get('[data-testid="rating-stars-select"]').setValue(2);
    await flushPromises();
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('Endfield');
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('Hades II');

    await wrapper.get('[data-testid="rating-sort-select"]').setValue(40);
    await flushPromises();
    const titles = wrapper.findAll('[data-testid="entry-list"] article, [data-testid="entry-list"] .entry-card')
      .map((card) => card.text());
    expect(titles.join('|').indexOf('Endfield'))
      .toBeLessThan(titles.join('|').indexOf('Hades II'));

    // Clearing everything restores the full grid.
    await wrapper.get('[data-testid="clear-facet-filters"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('Endfield');
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('Hades II');
  });

  it('offers the Author-rating mode inside the rating sort control', async () => {
    const api = createMemoryApi();
    const queryEntryPage = vi.spyOn(api, 'queryEntryPage');
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openGameGallery(wrapper);

    const sortSelect = wrapper.get('[data-testid="rating-sort-select"]');
    expect(sortSelect.findAll('option').map((option) => option.text())).toContain('Quality ↓ 👤');
    expect(sortSelect.attributes('title')).toBe(
      'Works without their own rating sort by their Author rating',
    );

    await sortSelect.setValue('40:author');
    await flushPromises();
    expect(queryEntryPage.mock.calls.at(-1)?.[0]).toMatchObject({
      ratingSort: { slotId: 40, direction: 'desc', applyAuthorRating: true },
    });

    await sortSelect.setValue('40');
    await flushPromises();
    expect(queryEntryPage.mock.calls.at(-1)?.[0]).toMatchObject({
      ratingSort: { slotId: 40, direction: 'desc', applyAuthorRating: false },
    });
  });

  it('applies a rating chosen on the manual entry form after creating the entry', async () => {
    const api = createMemoryApi();
    const setRating = vi.fn(async (_entryId: number, slotId: number, stars: number | null) => ({
      slotId,
      name: 'Quality',
      stars,
    }));
    api.setEntryRating = setRating;
    api.listRatingSlots = vi.fn(async () => [{ id: 40, name: 'Quality', sortOrder: 0 }]);
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');

    const form = wrapper.get('[data-testid="manual-entry-form"]');
    const typeInput = form.get('input[name="type"]');
    await typeInput.setValue('game');
    await typeInput.trigger('change');
    await flushPromises();

    const ratingsArea = wrapper.get('[data-testid="manual-entry-ratings"]');
    await ratingsArea.get('select').setValue('5');

    await form.get('input[name="title"]').setValue('Rated New Work');
    await form.trigger('submit');
    await flushPromises();

    expect(setRating).toHaveBeenCalledTimes(1);
    const [entryId, slotId, stars] = setRating.mock.calls[0]!;
    expect(slotId).toBe(40);
    expect(stars).toBe(5);
    expect(entryId).toBeGreaterThan(0);
  });

  it('records the reviewed Author rating for the batch instead of rating every imported work', async () => {
    const api = createMemoryApi();
    const setEntryRating = vi.fn(async () => ({}));
    api.setEntryRating = setEntryRating as unknown as typeof api.setEntryRating;
    api.listRatingSlots = vi.fn(async () => [{ id: 40, name: 'Quality', sortOrder: 0 }]);
    api.listLayout = vi.fn(async () => [
      { id: 10, name: 'Tags', sortOrder: 0, facets: [{ id: 11, name: '', sortOrder: 0 }] },
    ]);
    const preview = {
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
          externalKey: 'hitomi.la:1',
          title: 'Hitomi Work',
          tags: [{ name: 'Full Color' }],
          fields: { authors: ['Author'] },
        }],
      },
    };
    api.previewSiteProbeFolder = vi.fn(async () => preview);
    const entryIdSeq = { value: 300 };
    const commitImport = vi.fn(async (batch: typeof preview.batch, mapping: unknown) => ({
      entries: batch.entries.map((entry: { title: string; externalKey?: string }) => {
        entryIdSeq.value += 1;
        return { entryId: entryIdSeq.value, title: entry.title, externalKey: entry.externalKey };
      }),
      entryCount: batch.entries.length,
      skippedExistingEntryCount: 0,
      createdProducerCount: 0,
      producerLinkCount: 0,
      tagAssignmentCount: 0,
      contentCount: 0,
      authorRatingCount: (mapping as { authorRatings?: unknown[] }).authorRatings?.length ?? 0,
    }));
    api.commitImport = commitImport as unknown as typeof api.commitImport;

    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    await wrapper.get('.batch-import-toggle .secondary-button').trigger('click');

    const batchTypeInput = wrapper.get('.batch-import input[list="add-entry-gallery-types"]');
    await batchTypeInput.setValue('game');
    await batchTypeInput.trigger('change');
    await flushPromises();

    // Imports no longer rate works: the batch dialog has no rating block, and
    // choosing the folder reviews the Authors the batch will touch.
    expect(wrapper.find('[data-testid="batch-ratings"]').exists()).toBe(false);
    const batchInput = wrapper.get('.batch-import input[webkitdirectory]');
    const files = ['100089', '102331'].map((itemId) => {
      const file = new File(['{}'], 'metadata.json', { type: 'application/json' });
      Object.defineProperty(file, 'webkitRelativePath', {
        value: `playlist_640641/items/${itemId}/metadata.json`,
      });
      return file;
    });
    Object.defineProperty(batchInput.element, 'files', { value: files });
    await batchInput.trigger('change');
    await flushPromises();

    // Rating inputs appear only for an Author the user ticked.
    expect(wrapper.find('[data-testid="author-ratings-Author"]').exists()).toBe(false);
    await wrapper.get('[data-testid="author-rating-toggle-Author"]').setValue(true);
    expect(wrapper.find('[data-testid="author-ratings-Author"]').exists()).toBe(true);
    await wrapper.get('[data-testid="author-rating-Author-Quality"]').setValue('4');
    // The batch button, not the single-work one, commits this run.
    expect(wrapper.find('[data-testid="batch-review-hint"]').exists()).toBe(true);

    await wrapper.get('.batch-import .primary-button').trigger('click');
    await flushPromises();

    // Both items commit with the same reviewed Author rating.
    expect(commitImport).toHaveBeenCalledTimes(2);
    for (const call of commitImport.mock.calls) {
      expect(call[1]).toMatchObject({
        authorRatings: [{ name: 'Author', slotName: 'Quality', stars: 4 }],
      });
    }
    expect(setEntryRating).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="batch-review"]').exists()).toBe(true);
  });
  it('shows usage stats and records a view only when the source URL opens', async () => {
    const api = createMemoryApi();
    const baseGetEntry = api.getEntry;
    api.getEntry = vi.fn(async (entryId: number) => {
      const detail = await baseGetEntry(entryId);
      if (entryId !== 1) return detail;
      return {
        ...detail,
        contents: [...detail.contents, {
          id: 99, contentType: 'Source URL', content: 'https://example.test/game', sortOrder: 5,
        }],
      };
    });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();

    // The detail banner starts at zero views with no date.
    const stats = wrapper.get('[data-testid="entry-usage-stats"]');
    expect(stats.text()).toContain('0 views');
    expect(stats.text()).not.toContain('Last viewed');

    // Opening the source URL is what counts as a view — record, then navigate.
    await wrapper.get('[data-source-url-content-id]').trigger('click');
    await flushPromises();

    expect(openSpy).toHaveBeenCalledWith('https://example.test/game', '_blank', 'noopener,noreferrer');
    const stats2 = wrapper.get('[data-testid="entry-usage-stats"]');
    expect(stats2.text()).toContain('1 views');
    expect(stats2.text()).toContain('Last viewed');
    openSpy.mockRestore();
  });

  it('keeps usage as sorting only and does not expose numeric usage conditions', async () => {
    const api = createMemoryApi();
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openGameGallery(wrapper);

    expect(wrapper.find('[data-testid="add-usage-filter"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="usage-field-select"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="usage-sort-select"]').exists()).toBe(true);

    // The retained usage sort still annotates the cards with the selected metric.
    await wrapper.get('[data-testid="usage-sort-select"]').setValue('lastViewed');
    await flushPromises();
    expect(wrapper.findAll('[data-testid="entry-usage-note"]')[0]!.text()).toContain('Viewed:');

    // Clearing removes the annotations again.
    await wrapper.get('[data-testid="clear-facet-filters"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="entry-usage-note"]').exists()).toBe(false);
  });

  it('opens the Recently viewed page with permanent gallery tabs and mode switching', async () => {
    const api = createMemoryApi();
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    // The sidebar entry is always visible.
    await wrapper.get('[data-testid="recent-view-navigation"]').trigger('click');
    await flushPromises();

    const tabs = wrapper.findAll('[data-recent-tab]');
    expect(tabs.length).toBe(2); // game + manga, both galleries even when empty
    expect(tabs.map((tab) => tab.text())).toEqual(['game 2', 'manga 1']);
    const tabStrip = wrapper.get('[data-testid="recent-tabs"]');
    const tabPanel = wrapper.get('[data-testid="recent-tab-panel"]');
    expect(tabStrip.element.nextElementSibling).toBe(tabPanel.element);

    // Recent cards use the same compact card geometry as Gallery cards.
    const recentGrid = wrapper.get('[data-testid="recent-entry-grid"]');
    expect(recentGrid.classes()).toContain('recent-grid-compact');
    expect(wrapper.get('[data-testid="recent-entry-card"] .entry-stack').classes()).toContain('entry-stack');

    // ★ Last viewed is the default mode; entries without view data never show.
    expect(wrapper.get('[data-testid="recent-mode-last-viewed"]').classes())
      .toContain('recent-mode-active');
    const grid = wrapper.get('[data-testid="recent-entry-grid"]');
    expect(grid.text()).toContain('Endfield');
    expect(grid.text()).not.toContain('Hades II');

    // Switching to ♥ Most viewed keeps the page on the same tab.
    await wrapper.get('[data-testid="recent-mode-most-viewed"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="recent-mode-most-viewed"]').classes())
      .toContain('recent-mode-active');
    expect(wrapper.findAll('[data-testid="shared-card-note"]')[0]!.text()).toContain('2 views');

    // The mode is sticky on this page: clicking another mode switches but the
    // page always keeps one active sort (recent view is the page's purpose).
    expect(wrapper.findAll('[data-testid="shared-card-note"]')[0]!.text()).toContain('2 views');

    // Leaving via any sidebar entry works (top-priority navigation).
    await wrapper.get('[data-gallery-type="game"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="recent-view-page"]').exists()).toBe(false);
  });

  it('returns from an Entry detail to the same active Recently viewed Gallery tab', async () => {
    const api = createMemoryApi();
    const queryEntryPage = api.queryEntryPage.bind(api);
    api.queryEntryPage = vi.fn(async (input) => {
      const result = await queryEntryPage(input.entryType === 'manga' ? { ...input, recentOnly: false } : input);
      return input.entryType === 'manga'
        ? { ...result, items: result.items.map((entry) => ({ ...entry, lastViewedAt: '2026-09-06T01:00:00Z' })) }
        : result;
    });
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="recent-view-navigation"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-recent-tab="manga"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="recent-entry-card"] .entry-card-main').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="entry-back"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-recent-tab="manga"]').attributes('aria-selected')).toBe('true');
    expect(wrapper.get('[data-testid="recent-entry-grid"]').text()).toContain('Witch Hat Atelier');
  });

  it('toggles View later from the Author toolbar and lists Authors on their own page', async () => {
    const api = createMemoryApi();
    await api.addViewLaterEntry(1);
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="author-navigation"]').trigger('click');
    await wrapper.get('[data-author-id="9"]').trigger('click');
    await flushPromises();

    const toggle = wrapper.get('[data-testid="author-view-later-button"]');
    expect(toggle.attributes('aria-pressed')).toBe('false');
    await toggle.trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="author-view-later-button"]').attributes('aria-pressed')).toBe('true');
    // Saving an Author is an independent membership: it must not bulk-add the
    // Author's other works to the Entry list.
    expect(await api.getViewLaterState()).toEqual({ entryIds: [1], producerIds: [9] });

    await wrapper.get('[data-testid="view-later-navigation"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="view-later-kind-entry"]').exists()).toBe(true);
    await wrapper.get('[data-testid="view-later-kind-author"]').trigger('click');
    expect(wrapper.get('[data-view-later-author-id="9"]').text()).toContain('Hypergryph');

    await wrapper.get('[data-remove-view-later-author-id="9"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-view-later-author-id="9"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="view-later-author-empty"]').exists()).toBe(true);
  });

  it('returns from a View later Author detail to the View later Authors tab', async () => {
    const api = createMemoryApi();
    await api.addViewLaterAuthor(9);
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="view-later-navigation"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="view-later-kind-author"]').trigger('click');
    await wrapper.get('[data-view-later-author-id="9"] .author-card-main').trigger('click');
    await flushPromises();

    await wrapper.get('[data-testid="author-information-board"] .author-toolbar .text-button').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="view-later-page"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="view-later-kind-author"]').attributes('aria-selected')).toBe('true');
    expect(wrapper.get('[data-view-later-author-id="9"]').text()).toContain('Hypergryph');
  });

  it('returns from an Entry detail to the same active View later Gallery tab', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const scrollY = vi.spyOn(window, 'scrollY', 'get').mockReturnValue(720);
    const api = createMemoryApi();
    await api.addViewLaterEntry(1);
    await api.addViewLaterEntry(3);
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="view-later-navigation"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-view-later-tab="manga"]').trigger('click');
    await wrapper.get('[data-testid="view-later-entry-card"] .entry-card-main').trigger('click');
    await flushPromises();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, left: 0, behavior: 'auto' });
    expect(wrapper.get('[data-testid="entry-back"]').text()).toContain('View later');
    scrollY.mockReturnValue(0);
    await wrapper.get('[data-testid="entry-back"]').trigger('click');
    await flushPromises();

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 720, left: 0, behavior: 'auto' });
    expect(wrapper.get('[data-view-later-tab="manga"]').attributes('aria-selected')).toBe('true');
    expect(wrapper.get('[data-testid="view-later-panel"]').text()).toContain('Witch Hat Atelier');
    scrollY.mockRestore();
    scrollTo.mockRestore();
  });

  it('offers random sorting in Gallery, Recently viewed, and View later controls', async () => {
    const api = createMemoryApi();
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await openGameGallery(wrapper);
    expect(wrapper.get('[data-testid="gallery-sort"] option[value="random"]').text()).toBe('Random');

    await wrapper.get('[data-testid="recent-view-navigation"]').trigger('click');
    await flushPromises();
    const recentRandom = wrapper.get('[data-testid="recent-mode-random"]');
    await recentRandom.trigger('click');
    expect(recentRandom.classes()).toContain('recent-mode-active');

    await wrapper.get('[data-testid="view-later-navigation"]').trigger('click');
    await flushPromises();
    const viewLaterRandom = wrapper.get('[data-testid="view-later-mode-random"]');
    await viewLaterRandom.trigger('click');
    expect(viewLaterRandom.classes()).toContain('recent-mode-active');
  });

  it('keeps the repeatable Like action visible below Edit in read mode and shows the card badge', async () => {
    const api = createMemoryApi();
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openGameGallery(wrapper);
    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();

    const toolbarActions = wrapper.get('.detail-toolbar-actions');
    const likeButton = wrapper.get('[data-testid="like-entry-button"]');
    const actionIds = toolbarActions.findAll('button').map((button) => button.attributes('data-testid'));
    expect(actionIds.indexOf('start-entry-editing')).toBeLessThan(actionIds.indexOf('like-entry-button'));
    expect(wrapper.find('[data-testid="entry-like-count"]').exists()).toBe(false);

    await likeButton.trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="like-entry-button"]').trigger('click');
    await flushPromises();
    // Likes are unlimited and re-clickable: two clicks add two.
    expect(wrapper.get('[data-testid="entry-like-count"]').text()).toContain('2');

    // The card in the gallery grid carries the small cover badge.
    await wrapper.get('[data-testid="entry-back"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('👍 2');
  });
  it('toggles view later from the entry page and lists saved works in its own gallery', async () => {
    const api = createMemoryApi();
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();

    // The clock button sits next to the like button in normal mode. The
    // icon-only button expresses state via aria-pressed + the check variant.
    const button = wrapper.get('[data-testid="view-later-button"]');
    expect(button.attributes('aria-pressed')).toBe('false');
    await button.trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="view-later-button"]').attributes('aria-pressed')).toBe('true');

    // The saved work shows up in the View later gallery under its tab.
    await wrapper.get('[data-testid="view-later-navigation"]').trigger('click');
    await flushPromises();
    const page = wrapper.get('[data-testid="view-later-page"]');
    expect(page.text()).toContain('Endfield');
    // Removing from the page clears the saved list entry.
    await page.get('[data-testid="view-later-remove-1"]').trigger('click');
    await flushPromises();
    expect(page.text()).toContain('Nothing saved for later');
  });

  it('converges to server View later state on focus and whenever the page is opened', async () => {
    const api = createMemoryApi();
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await api.addViewLaterEntry(2);
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(wrapper.get('[data-testid="view-later-navigation"]').text()).toContain('1');

    await api.removeViewLaterEntry(2);
    await wrapper.get('[data-testid="view-later-navigation"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="view-later-navigation"]').text()).not.toContain('1');
    expect(wrapper.text()).toContain('Nothing saved for later');
  }, 10_000);

  it('creates a collection in edit mode and opens its detail', async () => {
    const api = createMemoryApi();
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    // The sidebar entry sits below View later.
    await wrapper.get('[data-testid="collections-navigation"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="collections-page"]').text()).toContain('Collections');

    await wrapper.get('[data-testid="collections-edit-toggle"]').trigger('click');
    await wrapper.get('[data-testid="new-collection-title"]').setValue('Read list');
    await wrapper.get('[data-testid="create-collection"]').trigger('click');
    await flushPromises();
    // Creating jumps straight into the collection detail.
    const detail = wrapper.get('[data-testid="collection-detail"]');
    // Edit mode is on: the title input carries the created name.
    expect((detail.get('input[name="collectionTitle"]').element as HTMLInputElement).value)
      .toBe('Read list');
    expect(wrapper.get('[data-testid="collection-nsfw-toggle"]').text()).toBe('SFW');
  });
  it('returns from a Collection Entry to the exact collection and walks the top-bar Back hierarchy', async () => {
    const api = createMemoryApi();
    api.listCollections = vi.fn(async (kind: 'entry' | 'producer') => (kind === 'entry' ? [{
      id: 71,
      kind: 'entry' as const,
      title: 'Current shelf',
      description: '',
      nsfw: false,
      sortOrder: 0,
      children: [],
      entries: [{ id: 1, title: 'Endfield', type: 'game', coverRef: null, previewRefs: [] }],
      producers: [],
    }] : []));
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="collections-navigation"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-collection-id="71"]').trigger('click');
    await wrapper.get('[data-testid="collection-entry-card"] .entry-card-main').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="entry-back"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="collection-detail"]').text()).toContain('Current shelf');
    await wrapper.get('[data-testid="top-bar-back"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="collection-detail"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="collections-page"]').exists()).toBe(true);
    await wrapper.get('[data-testid="top-bar-back"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="home-page"]').exists()).toBe(true);
  });

  it('returns to the exact Collection when its opened Entry is deleted', async () => {
    const api = createMemoryApi();
    api.listCollections = vi.fn(async (kind: 'entry' | 'producer') => (kind === 'entry' ? [{
      id: 71,
      kind: 'entry' as const,
      title: 'Current shelf',
      description: '',
      nsfw: false,
      sortOrder: 0,
      children: [],
      entries: [{ id: 1, title: 'Endfield', type: 'game', coverRef: null, previewRefs: [] }],
      producers: [],
    }] : []));
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="collections-navigation"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-collection-id="71"]').trigger('click');
    await wrapper.get('[data-testid="collection-entry-card"] .entry-card-main').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');
    const deleteButton = wrapper.get('[data-testid="delete-entry"]');
    await deleteButton.trigger('click');
    await deleteButton.trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="collection-detail"]').text()).toContain('Current shelf');
  });

  it('opens the freshly imported Entry after a single folder import', async () => {
    const api = createMemoryApi();
    api.listLayout = vi.fn(async () => [
      { id: 10, name: 'Tags', sortOrder: 0, facets: [{ id: 11, name: '', sortOrder: 0 }] },
    ]);
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
          externalKey: 'hitomi.la:400',
          title: 'Freshly Imported Work',
          tags: [{ name: 'Full Color' }],
          fields: { authors: ['Author'] },
        }],
      },
    }));
    api.commitImport = vi.fn(async () => ({
      entries: [{ entryId: 400, title: 'Freshly Imported Work', externalKey: 'hitomi.la:400' }],
      entryCount: 1,
      skippedExistingEntryCount: 0,
      createdProducerCount: 0,
      producerLinkCount: 0,
      tagAssignmentCount: 1,
      contentCount: 0,
      authorRatingCount: 0,
      warnings: [],
    }));
    const baseGetEntry = api.getEntry;
    api.getEntry = vi.fn(async (entryId: number) => {
      if (entryId !== 400) return baseGetEntry(entryId);
      return {
        ...(await baseGetEntry(1)),
        id: 400,
        title: 'Freshly Imported Work',
        type: 'game',
      };
    });

    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="random-navigation"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');

    const metadata = new File(['{}'], 'metadata.json', { type: 'application/json' });
    Object.defineProperty(metadata, 'webkitRelativePath', {
      value: 'playlist_640641/items/400/metadata.json',
    });
    const folderInput = wrapper.get('.folder-dropzone input[webkitdirectory]');
    Object.defineProperty(folderInput.element, 'files', { value: [metadata] });
    await folderInput.trigger('change');
    await flushPromises();
    await wrapper.get('[data-testid="import-review"] .primary-button').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="add-entry-page"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="batch-review"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="entry-detail"]').text()).toContain('Freshly Imported Work');
  });

  it('shows a temporary batch review gallery after a batch import', async () => {
    const api = createMemoryApi();
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    await wrapper.get('.batch-import-toggle .secondary-button').trigger('click');

    const batchTypeInput = wrapper.get('.batch-import input[list="add-entry-gallery-types"]');
    await batchTypeInput.setValue('game');
    await batchTypeInput.trigger('change');
    await flushPromises();

    const batchInput = wrapper.get('.batch-import input[webkitdirectory]');
    const files = ['100089', '102331'].map((itemId) => {
      const file = new File(['{}'], 'metadata.json', { type: 'application/json' });
      Object.defineProperty(file, 'webkitRelativePath', {
        value: `playlist_640641/items/${itemId}/metadata.json`,
      });
      return file;
    });
    Object.defineProperty(batchInput.element, 'files', { value: files });
    await batchInput.trigger('change');
    await flushPromises();

    api.listLayout = vi.fn(async () => [
      { id: 10, name: 'Tags', sortOrder: 0, facets: [{ id: 11, name: '', sortOrder: 0 }] },
    ]);
    api.commitImport = vi.fn(async (batch) => ({
      entries: batch.entries.map((entry: { title: string; externalKey?: string }, index: number) => ({
        entryId: 400 + index,
        title: entry.title,
        externalKey: entry.externalKey,
      })),
      entryCount: batch.entries.length,
      skippedExistingEntryCount: 0,
      createdProducerCount: 0,
      producerLinkCount: 0,
      tagAssignmentCount: 0,
      contentCount: 0,
      authorRatingCount: 0,
      warnings: [],
    }));
    // The real backend returns the freshly committed entries from the bounded
    // Entry query; the mock mirrors that for the review grid.
    const queryEntryPage = api.queryEntryPage.bind(api);
    api.queryEntryPage = vi.fn(async (input: Parameters<GalleryApi['queryEntryPage']>[0]) => (input.entryIds?.some((id) => id === 400 || id === 401)
      ? { items: [400, 401].map((id: number) => ({
        id,
        title: 'Batch Work',
        type: 'game',
        coverRef: null,
        previewRef: null,
        previewRefs: [],
        uploadDate: null,
        pageCount: null,
        viewCount: 0,
        likeCount: 0,
        lastViewedAt: null,
      })), total: 2, page: input.page, pageSize: input.pageSize }
      : queryEntryPage(input)));
    const baseGetBatchEntry = api.getEntry;
    api.getEntry = vi.fn(async (entryId: number) => {
      if (entryId !== 400 && entryId !== 401) return baseGetBatchEntry(entryId);
      return {
        ...(await baseGetBatchEntry(1)),
        id: entryId,
        title: `Batch Work ${entryId}`,
        type: 'game',
      };
    });
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
          externalKey: 'hitomi.la:1',
          title: 'Batch Work',
          tags: [{ name: 'Full Color' }],
          fields: { authors: ['Author'] },
        }],
      },
    }));
    await wrapper.get('.batch-import .primary-button').trigger('click');
    await flushPromises();
    // The temporary review group lists exactly the just-committed cards.
    const firstReview = wrapper.get('[data-testid="batch-review"]');
    expect(firstReview.get('[data-testid="batch-review-title"]').text()).toBe('game');
    expect(firstReview.get('[data-testid="batch-review-notice"]').text()).toContain('Successfully imported');
    expect(firstReview.get('[data-testid="batch-review-notice"]').text()).toContain('one-time quick review');
    expect(firstReview.text()).toContain('Batch Work');

    await firstReview.get('[data-testid="complete-batch-review"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="batch-review"]').exists()).toBe(false);

    // Run another batch to exercise the Entry drill-down/back lifecycle.
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    await wrapper.get('.batch-import-toggle .secondary-button').trigger('click');
    const secondTypeInput = wrapper.get('.batch-import input[list="add-entry-gallery-types"]');
    await secondTypeInput.setValue('game');
    await secondTypeInput.trigger('change');
    await flushPromises();
    const secondBatchInput = wrapper.get('.batch-import input[webkitdirectory]');
    Object.defineProperty(secondBatchInput.element, 'files', { value: files });
    await secondBatchInput.trigger('change');
    await flushPromises();
    await wrapper.get('.batch-import .primary-button').trigger('click');
    await flushPromises();

    const secondReview = wrapper.get('[data-testid="batch-review"]');
    await secondReview.get('[data-entry-id="400"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="entry-detail"]').text()).toContain('Batch Work 400');

    await wrapper.get('[data-testid="entry-back"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="batch-review"]').exists()).toBe(true);

    // Any sidebar navigation explicitly discards the one-time group.
    await wrapper.get('[data-testid="recent-view-navigation"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="batch-review"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="recent-view-page"]').exists()).toBe(true);
  });

  it('saves a batch import as a temporary Collection from the review view', async () => {
    setLocale('en');
    const api = createMemoryApi();
    const createTemporaryCollection = vi.spyOn(api, 'createTemporaryCollection');
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    api.listLayout = vi.fn(async () => [
      { id: 10, name: 'Tags', sortOrder: 0, facets: [{ id: 11, name: '', sortOrder: 0 }] },
    ]);
    const summaries = (ids: number[]) => ids.map((id) => ({
      id,
      title: `Batch Work ${id}`,
      type: 'game',
      coverRef: null,
      previewRef: null,
      previewRefs: [],
      uploadDate: null,
      pageCount: null,
      viewCount: 0,
      likeCount: 0,
      lastViewedAt: null,
    }));
    let nextEntryId = 700;
    api.commitImport = vi.fn(async (batch) => {
      const entries = batch.entries.map((entry: { title: string }) => {
        nextEntryId += 1;
        return { entryId: nextEntryId, title: entry.title };
      });
      return {
        entries,
        entryCount: entries.length,
        skippedExistingEntryCount: 0,
        createdProducerCount: 0,
        producerLinkCount: 0,
        tagAssignmentCount: 0,
        contentCount: 0,
        authorRatingCount: 0,
        warnings: [],
      };
    });
    api.queryEntryPage = vi.fn(async (input) => ({
      items: summaries(input.entryIds ?? []),
      total: (input.entryIds ?? []).length,
      page: input.page,
      pageSize: input.pageSize,
    }));
    api.previewSiteProbeFolder = vi.fn(async () => ({
      source: 'hitomi.la',
      entryCount: 1,
      tagAssignmentCount: 0,
      uniqueTagCount: 0,
      entriesMissingCover: 0,
      warnings: [],
      batch: {
        source: 'hitomi.la',
        warnings: [],
        entries: [{
          externalKey: 'hitomi.la:1',
          title: 'Batch Work',
          tags: [],
          fields: { authors: ['Author'] },
        }],
      },
    }));

    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    await wrapper.get('.batch-import-toggle .secondary-button').trigger('click');
    const typeInput = wrapper.get('.batch-import input[list="add-entry-gallery-types"]');
    await typeInput.setValue('game');
    await typeInput.trigger('change');
    await flushPromises();
    const batchInput = wrapper.get('.batch-import input[webkitdirectory]');
    const file = new File(['{}'], 'metadata.json', { type: 'application/json' });
    Object.defineProperty(file, 'webkitRelativePath', {
      value: 'playlist_640641/items/100089/metadata.json',
    });
    Object.defineProperty(batchInput.element, 'files', { value: [file] });
    await batchInput.trigger('change');
    await flushPromises();
    await wrapper.get('.batch-import .primary-button').trigger('click');
    await flushPromises();

    // The review files the run into a Collection that outlives it.
    const button = wrapper.get('[data-testid="batch-review-save-collection"]');
    await button.trigger('click');
    await flushPromises();

    expect(createTemporaryCollection).toHaveBeenCalledWith([nextEntryId]);
    expect(wrapper.get('[data-testid="batch-review-collection-notice"]').text())
      .toContain('临时');
    expect(wrapper.get('[data-testid="batch-review-collection-notice"]').text()).toContain('1');
    // Saving once marks it done instead of creating another copy.
    expect(wrapper.get('[data-testid="batch-review-save-collection"]').attributes('disabled'))
      .toBeDefined();
    expect(wrapper.get('[data-testid="batch-review-save-collection"]').text())
      .toContain('临时');
    // The one-time review itself is still there.
    expect(wrapper.find('[data-testid="batch-review"]').exists()).toBe(true);
  });

  it('shows a later batch review even after paging through a longer earlier one', async () => {
    const api = createMemoryApi();
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    api.listLayout = vi.fn(async () => [
      { id: 10, name: 'Tags', sortOrder: 0, facets: [{ id: 11, name: '', sortOrder: 0 }] },
    ]);
    const summaries = (ids: number[]) => ids.map((id) => ({
      id,
      title: `Batch Work ${id}`,
      type: 'game',
      coverRef: null,
      previewRef: null,
      previewRefs: [],
      uploadDate: null,
      pageCount: null,
      viewCount: 0,
      likeCount: 0,
      lastViewedAt: null,
    }));
    let nextEntryId = 600;
    api.commitImport = vi.fn(async (batch) => {
      const entries = batch.entries.map((entry: { title: string }) => {
        nextEntryId += 1;
        return { entryId: nextEntryId, title: entry.title };
      });
      return {
        entries,
        entryCount: entries.length,
        skippedExistingEntryCount: 0,
        createdProducerCount: 0,
        producerLinkCount: 0,
        tagAssignmentCount: 0,
        contentCount: 0,
        authorRatingCount: 0,
        warnings: [],
      };
    });
    api.queryEntryPage = vi.fn(async (input) => ({
      items: summaries(input.entryIds ?? []),
      total: (input.entryIds ?? []).length,
      page: input.page,
      pageSize: input.pageSize,
    }));
    api.previewSiteProbeFolder = vi.fn(async () => ({
      source: 'hitomi.la',
      entryCount: 1,
      tagAssignmentCount: 0,
      uniqueTagCount: 0,
      entriesMissingCover: 0,
      warnings: [],
      batch: {
        source: 'hitomi.la',
        warnings: [],
        entries: Array.from({ length: 20 }, (_, index) => ({
          externalKey: `hitomi.la:${index}`,
          title: `Batch Work ${index}`,
          tags: [],
        })),
      },
    }));

    const runBatch = async (itemIds: string[]) => {
      await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
      await wrapper.get('.batch-import-toggle .secondary-button').trigger('click');
      const typeInput = wrapper.get('.batch-import input[list="add-entry-gallery-types"]');
      await typeInput.setValue('game');
      await typeInput.trigger('change');
      await flushPromises();
      const batchInput = wrapper.get('.batch-import input[webkitdirectory]');
      Object.defineProperty(batchInput.element, 'files', {
        value: itemIds.map((itemId) => {
          const file = new File(['{}'], 'metadata.json', { type: 'application/json' });
          Object.defineProperty(file, 'webkitRelativePath', {
            value: `playlist_640641/items/${itemId}/metadata.json`,
          });
          return file;
        }),
      });
      await batchInput.trigger('change');
      await flushPromises();
      await wrapper.get('.batch-import .primary-button').trigger('click');
      await flushPromises();
    };

    // A long batch: 2 items × 20 entries = 40 cards, so the review paginates.
    await runBatch(['100089', '102331']);
    const firstReview = wrapper.get('[data-testid="batch-review"]');
    expect(firstReview.findAll('.entry-card')).toHaveLength(30);
    await firstReview.get('[aria-label="Next page"]').trigger('click');
    await flushPromises();
    expect(firstReview.findAll('.entry-card')).toHaveLength(10);
    await wrapper.get('[data-testid="complete-batch-review"]').trigger('click');
    await flushPromises();

    // A short batch of the same Gallery must still show its own cards.
    await runBatch(['100089']);
    const secondReview = wrapper.get('[data-testid="batch-review"]');
    expect(secondReview.findAll('.entry-card')).toHaveLength(20);
    expect(secondReview.findAll('.entry-card')[0]!.text()).toContain('Batch Work');
  });

  it('lists the imported cards even when the typed Gallery spelling was not the stored one', async () => {
    const api = createMemoryApi();
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    await wrapper.get('.batch-import-toggle .secondary-button').trigger('click');

    // Typing `GAME` is legitimate: the import resolves it to the stored `game`
    // Gallery case-insensitively, so the review must look at the same type.
    const batchTypeInput = wrapper.get('.batch-import input[list="add-entry-gallery-types"]');
    await batchTypeInput.setValue('GAME');
    await batchTypeInput.trigger('change');
    await flushPromises();

    const batchInput = wrapper.get('.batch-import input[webkitdirectory]');
    const file = new File(['{}'], 'metadata.json', { type: 'application/json' });
    Object.defineProperty(file, 'webkitRelativePath', {
      value: 'playlist_640641/items/100089/metadata.json',
    });
    Object.defineProperty(batchInput.element, 'files', { value: [file] });
    await batchInput.trigger('change');
    await flushPromises();

    api.listLayout = vi.fn(async () => [
      { id: 10, name: 'Tags', sortOrder: 0, facets: [{ id: 11, name: '', sortOrder: 0 }] },
    ]);
    api.commitImport = vi.fn(async (batch) => ({
      entries: batch.entries.map((entry: { title: string }, index: number) => ({
        entryId: 500 + index,
        title: entry.title,
      })),
      entryCount: batch.entries.length,
      skippedExistingEntryCount: 0,
      createdProducerCount: 0,
      producerLinkCount: 0,
      tagAssignmentCount: 0,
      contentCount: 0,
      authorRatingCount: 0,
      warnings: [],
    }));
    // Mirrors the server: the Entry query matches the Gallery type exactly.
    const queryEntryPage = api.queryEntryPage.bind(api);
    api.queryEntryPage = vi.fn(async (input: Parameters<GalleryApi['queryEntryPage']>[0]) => (
      input.entryIds?.includes(500) && (input.entryType === undefined || input.entryType === 'game')
        ? {
          items: [{
            id: 500,
            title: 'Typed Type Work',
            type: 'game',
            coverRef: null,
            previewRef: null,
            previewRefs: [],
            uploadDate: null,
            pageCount: null,
            viewCount: 0,
            likeCount: 0,
            lastViewedAt: null,
          }],
          total: 1,
          page: input.page,
          pageSize: input.pageSize,
        }
        : queryEntryPage(input)));
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
          externalKey: 'hitomi.la:1',
          title: 'Typed Type Work',
          tags: [{ name: 'Full Color' }],
          fields: { authors: ['Author'] },
        }],
      },
    }));

    await wrapper.get('.batch-import .primary-button').trigger('click');
    await flushPromises();

    const review = wrapper.get('[data-testid="batch-review"]');
    // The heading names the Gallery the commits landed in, not the typed text.
    expect(review.get('[data-testid="batch-review-title"]').text()).toBe('game');
    expect(review.text()).toContain('Typed Type Work');
  });
});

describe('Home page', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setLocale('en');
  });

  it('lands on Home by default and opens a Gallery and back from the sidebar', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();

    // Fresh load: Home is the first view, no Gallery is auto-opened.
    expect(wrapper.find('[data-testid="home-page"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="active-gallery-title"]').exists()).toBe(false);

    await wrapper.get('[data-home-gallery="manga"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="active-gallery-title"]').text()).toBe('manga');
    expect(wrapper.find('[data-testid="home-page"]').exists()).toBe(false);

    // The sidebar Home entry returns to the welcome page.
    await wrapper.get('[data-testid="home-navigation"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="home-page"]').exists()).toBe(true);
  });

  it('uses the global top-bar Back control for the current parent level and does nothing on Home', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();

    const back = wrapper.get('[data-testid="top-bar-back"]');
    expect(back.attributes('disabled')).toBeDefined();

    await wrapper.get('[data-gallery-type="game"]').trigger('click');
    expect(wrapper.get('[data-testid="top-bar-back"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-testid="top-bar-back"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="home-page"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="top-bar-back"]').attributes('disabled')).toBeDefined();
  });

  it('shows a fixed scroll-to-top control on Entry detail pages', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await wrapper.get('[data-gallery-type="game"]').trigger('click');
    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-testid="entry-scroll-top"]').trigger('click');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, left: 0, behavior: 'smooth' });
    scrollTo.mockRestore();
  });

  it('shows the recently viewed entry and opens it from Home', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();

    // Endfield is the only fixture entry with a last-viewed timestamp.
    const cards = wrapper.findAll('[data-testid="home-recent-card"]');
    expect(cards.length).toBe(1);
    expect(cards[0]!.text()).toContain('Endfield');

    await cards[0]!.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="entry-detail"]').text()).toContain('Endfield');

    // Closing the detail falls back to Home (no legacy empty Gallery).
    await wrapper.get('[data-testid="entry-back"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="home-page"]').exists()).toBe(true);
  });

  it('rotates the ambient summary through its dots', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();

    const message = () => wrapper.get('[data-testid="home-ambient-message"]').text();
    expect(message()).toContain('3 entries');

    const dots = wrapper.findAll('.home-ambient-dot');
    expect(dots.length).toBe(3);
    await dots[1]!.trigger('click');
    expect(message()).toContain('2 galleries');
  });

  it('shows the onboarding empty state when the library has no entries', async () => {
    const api = createMemoryApi();
    api.listGalleries = async () => [];
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    expect(wrapper.get('[data-testid="home-empty"]').text()).toContain('Add your first entry');

    await wrapper.get('[data-testid="home-add-first-entry"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="add-entry-page"]').exists()).toBe(true);
  });

  it('opens the new-entry creation flow from the Home hero', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();

    await wrapper.get('[data-testid="home-add-entry"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="add-entry-page"]').exists()).toBe(true);
  });
});

describe('Mobile navigation shell', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
    setLocale('en');
  });

  it('applies the active theme to the browser canvas for mobile edge overscroll', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.backgroundColor).toBe('var(--page-background)');
    expect(document.body.style.backgroundColor).toBe('var(--page-background)');

    await wrapper.get('[data-testid="theme-toggle"]').trigger('click');
    expect(document.documentElement.dataset.theme).toBe('dark');

    wrapper.unmount();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(document.documentElement.style.backgroundColor).toBe('');
    expect(document.body.style.backgroundColor).toBe('');
  });

  it('opens an accessible navigation drawer and closes it after choosing a destination', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();

    const trigger = wrapper.get('[data-testid="mobile-navigation-toggle"]');
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(wrapper.get('[data-testid="app-sidebar"]').classes()).not.toContain('sidebar-open');

    await trigger.trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('[data-testid="app-sidebar"]').classes()).toContain('sidebar-open');
    expect(wrapper.find('[data-testid="mobile-navigation-backdrop"]').exists()).toBe(true);

    await wrapper.get('[data-gallery-type="game"]').trigger('click');
    await flushPromises();
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(wrapper.get('[data-testid="app-sidebar"]').classes()).not.toContain('sidebar-open');
    expect(wrapper.get('[data-testid="active-gallery-title"]').text()).toBe('game');
  });

  it('offers a collapsible filter surface without changing its filter model', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await wrapper.get('[data-gallery-type="game"]').trigger('click');
    await flushPromises();

    const toggle = wrapper.get('[data-testid="mobile-filter-toggle"]');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(wrapper.get('[data-testid="mobile-filter-surface"]').classes()).not.toContain('facet-filter-bar__body--open');

    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('[data-testid="mobile-filter-surface"]').classes()).toContain('facet-filter-bar__body--open');
  });

  it('closes the drawer through backdrop, Escape, and Browser Back', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    const trigger = wrapper.get('[data-testid="mobile-navigation-toggle"]');

    await trigger.trigger('click');
    await wrapper.get('[data-testid="mobile-navigation-backdrop"]').trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('false');

    await trigger.trigger('click');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await wrapper.vm.$nextTick();
    expect(trigger.attributes('aria-expanded')).toBe('false');

    await trigger.trigger('click');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await wrapper.vm.$nextTick();
    expect(trigger.attributes('aria-expanded')).toBe('false');
  });
});

describe('Card grid pagination', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setLocale('en');
  });

  function createLargeApi(entryCount = 40): GalleryApi {
    const api = createMemoryApi();
    const generated = Array.from({ length: entryCount }, (_, index) => ({
      id: 100 + index,
      title: `Generated ${index + 1}`,
      type: 'game',
      coverRef: `/api/assets/entries/${100 + index}/cover.webp`,
      previewRef: `/api/assets/entries/${100 + index}/preview.webp`,
      previewRefs: [`/api/assets/entries/${100 + index}/preview.webp`],
      uploadDate: null,
      pageCount: null,
      viewCount: 0,
      likeCount: 0,
      lastViewedAt: null,
    }));
    const queryEntryPage = api.queryEntryPage.bind(api);
    api.queryEntryPage = async (input) => {
      if (input.entryType !== 'game') return queryEntryPage(input);
      const sorted = [...generated];
      const direction = input.sort.endsWith('-desc') ? -1 : 1;
      sorted.sort((left, right) => {
        if (input.sort.startsWith('title')) {
          return direction * left.title.localeCompare(right.title, undefined, { sensitivity: 'base' })
            || left.id - right.id;
        }
        const dateCompare = String(left.uploadDate ?? '').localeCompare(String(right.uploadDate ?? ''));
        return direction * (dateCompare || left.id - right.id);
      });
      const start = (input.page - 1) * input.pageSize;
      return {
        items: sorted.slice(start, start + input.pageSize),
        total: sorted.length,
        page: input.page,
        pageSize: input.pageSize,
      };
    };
    const getEntry = api.getEntry.bind(api);
    api.getEntry = async (entryId: number) => {
      if (entryId < 100 || entryId >= 100 + entryCount) return getEntry(entryId);
      return {
        ...(await getEntry(1)),
        id: entryId,
        title: `Generated ${entryId - 99}`,
        type: 'game',
      };
    };
    return api;
  }

  it('requests viewport-approved card images eagerly and decodes them asynchronously', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createLargeApi(4) } });
    await flushPromises();

    await wrapper.get('[data-gallery-type="game"]').trigger('click');
    await flushPromises();

    const galleryImages = wrapper.findAll('[data-testid="entry-list"] img');
    expect(galleryImages.length).toBeGreaterThan(0);
    expect(galleryImages.every((image) => image.attributes('loading') === 'eager')).toBe(true);
    expect(galleryImages.every((image) => image.attributes('decoding') === 'async')).toBe(true);
  });

  it('uses twice the configured row count on a phone-width card grid', async () => {
    const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 260 });
    let wrapper: ReturnType<typeof mount> | undefined;
    try {
      wrapper = mount(GalleryApp, { props: { api: createLargeApi(50) } });
      await flushPromises();
      await wrapper.get('[data-gallery-type="game"]').trigger('click');
      await flushPromises();

      // 5 configured rows × 2 mobile multiplier × 2 actual columns.
      expect(wrapper.findAll('[data-testid="entry-list"] [data-entry-id]').length).toBe(20);
    } finally {
      wrapper?.unmount();
      if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth);
      if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
    }
  });

  it('returns from a phone Gallery Entry to page five instead of clamping to the desktop page count', async () => {
    const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 260 });
    let wrapper: ReturnType<typeof mount> | undefined;
    try {
      wrapper = mount(GalleryApp, { props: { api: createLargeApi(86) } });
      await flushPromises();
      await wrapper.get('[data-gallery-type="game"]').trigger('click');
      await flushPromises();

      for (let page = 2; page <= 5; page += 1) {
        await wrapper.get('[aria-label="Next page"]').trigger('click');
        await flushPromises();
      }
      expect(wrapper.get('[aria-current="page"]').text()).toBe('5');
      const sourceId = wrapper.get('[data-testid="entry-list"] [data-entry-id]').attributes('data-entry-id');
      await wrapper.get(`[data-testid="entry-list"] [data-entry-id="${sourceId}"]`).trigger('click');
      await flushPromises();
      await wrapper.get('[data-testid="top-bar-back"]').trigger('click');
      await flushPromises();

      expect(wrapper.get('[aria-current="page"]').text()).toBe('5');
      expect(wrapper.find(`[data-testid="entry-list"] [data-entry-id="${sourceId}"]`).exists()).toBe(true);
    } finally {
      wrapper?.unmount();
      if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth);
      if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
    }
  });

  it('requests the current Gallery page from the server', async () => {
    const api = createLargeApi(40);
    const query = vi.spyOn(api, 'queryEntryPage');
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-gallery-type="game"]').trigger('click');
    await flushPromises();

    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({
      entryType: 'game', page: 1, pageSize: 30, sort: 'date-desc',
    }));
    await wrapper.findAll('.card-pagination-page').find((button) => button.text() === '2')!.trigger('click');
    await flushPromises();
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({
      entryType: 'game', page: 2, pageSize: 30, sort: 'date-desc',
    }));
  });

  it('pages the gallery grid by rows x columns and shows the bar above and below', async () => {
    // jsdom has no layout: the grid falls back to the 6-column default,
    // so the default preference (5 rows) yields a 30-card page.
    const wrapper = mount(GalleryApp, { props: { api: createLargeApi(40) } });
    await flushPromises();
    await wrapper.get('[data-gallery-type="game"]').trigger('click');
    await flushPromises();

    expect(wrapper.findAll('[data-testid="card-pagination"]').length).toBe(2);
    expect(wrapper.findAll('[data-testid="entry-list"] [data-entry-id]').length).toBe(30);

    await wrapper.findAll('.card-pagination-page').find((button) => button.text() === '2')!.trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-testid="entry-list"] [data-entry-id]').length).toBe(10);
    expect(wrapper.get('[aria-current="page"]').text()).toBe('2');
  });

  it('returns from an Entry detail to the same Gallery page', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createLargeApi(40) } });
    await flushPromises();
    await wrapper.get('[data-gallery-type="game"]').trigger('click');
    await flushPromises();

    await wrapper.findAll('.card-pagination-page').find((button) => button.text() === '2')!.trigger('click');
    await flushPromises();
    const sourceCard = wrapper.findAll('[data-testid="entry-list"] [data-entry-id]')[0]!;
    const sourceId = sourceCard.attributes('data-entry-id');
    await sourceCard.trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="entry-back"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[aria-current="page"]').text()).toBe('2');
    expect(wrapper.find(`[data-testid="entry-list"] [data-entry-id="${sourceId}"]`).exists()).toBe(true);
  });

  it('jumps to a typed page number from the pagination input', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createLargeApi(40) } });
    await flushPromises();
    await wrapper.get('[data-gallery-type="game"]').trigger('click');
    await flushPromises();

    const jump = wrapper.get('[data-testid="card-pagination-jump"]');
    await jump.setValue('2');
    await jump.trigger('keydown.enter');
    await flushPromises();
    expect(wrapper.findAll('[data-testid="entry-list"] [data-entry-id]').length).toBe(10);
  });

  it('derives the page size from the rows-per-page preference', async () => {
    const { rowsPerPage } = await import('../src/stores/preferences.js');
    const wrapper = mount(GalleryApp, { props: { api: createLargeApi(40) } });
    await flushPromises();
    await wrapper.get('[data-gallery-type="game"]').trigger('click');
    await flushPromises();

    // 3 rows x 6 columns = 18 cards per page -> three pages.
    await wrapper.get('[data-testid="settings-button"]').trigger('click');
    await wrapper.get('[data-testid="rows-per-page-select"]').setValue('3');
    await flushPromises();
    expect(wrapper.findAll('[data-testid="entry-list"] [data-entry-id]').length).toBe(18);
    expect(wrapper.findAll('.card-pagination-page').some((button) => button.text() === '3')).toBe(true);

    await wrapper.findAll('.card-pagination-page').find((button) => button.text() === '3')!.trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-testid="entry-list"] [data-entry-id]').length).toBe(4);

    rowsPerPage.value = 5;
    window.localStorage.clear();
  });
});
