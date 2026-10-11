// @vitest-environment jsdom

import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GalleryApp from '../src/GalleryApp.vue';

// App-level window listeners (focus, popstate, keydown) only detach on unmount.
enableAutoUnmount(afterEach);

vi.stubGlobal('scrollTo', vi.fn());

const suggestionDebounce = (ms = 220) => new Promise<void>((resolve) => setTimeout(resolve, ms));
import { multiAuthorProducerName, tagSuggestionQuerySchema } from '@t3/shared';
import type { GalleryApi } from '../src/api/gallery.js';
import { setLocale } from '../src/i18n.js';
import { createMemorySnapshotStore } from '../src/offline/snapshot-store.js';
import { showNsfw } from '../src/stores/preferences.js';

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
  let createdSectionCount = 0;
  let movedTagFacetId = 11;
  let renamedTagName = 'ARPG';
  let removedTag = false;
  let deletedContent = false;
  let nextRatingSlotId = 100;
  let ratingSlotCount = 0;
  const ratingSlots: Array<{ id: number; name: string; sortOrder: number; entryId: number }> = [];
  const entryUsages: Array<{ entryId: number; viewCount: number; likeCount: number; lastViewedAt: string | null }> = [];
  const collectionStore: Array<{ id: number; kind: 'entry' | 'producer'; title: string; description: string; nsfw: boolean; sortOrder: number; galleryType: string | null; children: never[]; entries: never[]; producers: never[] }> = [];
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
    async siteprobeReadme(site: string) {
      return { site, source: 'installed', text: `# ${site}` };
    },
    async uploadSiteprobeSelection(runId: string) {
      return { id: runId } as never;
    },
    async siteprobeLoginDone(runId: string) {
      return { id: runId } as never;
    },
    siteprobeExportFileUrl(path: string) {
      return `/api/siteprobe/export-file?path=${encodeURIComponent(path)}`;
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
        libraryId: 'memory', syncEpoch: 'memory', sqliteSchemaVersion: 32,
        snapshotFormatVersion: 1, syncProtocolVersion: 1, serverBuild: 'test',
        featureFlags: { readOnlySnapshot: true, offlineMutations: false, onlineEntryCreateClaim: true },
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
    async deleteTag(input: { vocabulary: 'entry' | 'producer'; tagId: number }) {
      return { tagId: input.tagId, tagName: 'stub', removedAssignments: 0, deletedTags: 1 };
    },
    async commonTemplate() {
      return { name: 'common', sections: [{ name: 'Basic', facets: [] }], ratingSlots: [] };
    },
    async applyCommonTemplate(entryType: string) {
      return { entryType, sectionCount: 1, facetCount: 0, ratingSlotCount: 0, templateFiles: null };
    },
    async applyCommonTemplateRatingSlots(entryType: string) {
      return { entryType, sectionCount: 0, facetCount: 0, ratingSlotCount: 1, templateFiles: null };
    },
    async listTemplates() {
      return [];
    },
    async listContentKinds() {
      return ['source url', 'description'];
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

    async createCollection(input: { kind: 'entry' | 'producer'; title: string; galleryType?: string }) {
      const record = {
        id: 900 + collectionStore.length, kind: input.kind, title: input.title,
        description: '', nsfw: false, sortOrder: collectionStore.length,
        galleryType: input.galleryType ?? null,
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
        galleryType: null,
        children: [], entries: [], producers: [],
      });
      return { collectionId: id, title, entryCount: new Set(entryIds).size };
    },
    async updateCollection() {
      throw new Error('Not implemented in memory API');
    },
    async addCollectionTag(collectionId: number, name: string) {
      const record = collectionStore.find((candidate) => candidate.id === collectionId);
      return {
        tagId: 1,
        entriesAffected: record?.entries.length ?? 0,
        alreadyPresent: 0,
        skipped: 0,
        name,
      };
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
    async setGalleryOrder(types) {
      return types;
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
    async previewSiteProbeExportPath() {
      throw new Error('Not implemented in memory API');
    },
    async commitImport() {
      throw new Error('Not implemented in memory API');
    },
    async commitImportPath() {
      throw new Error('Not implemented in memory API');
    },
    async siteprobeStatus() {
      throw new Error('Not implemented in memory API');
    },
    async fetchSiteProbeLinkMeta() {
      throw new Error('Not implemented in memory API');
    },
    async siteprobeSites() {
      throw new Error('Not implemented in memory API');
    },
    async siteprobeResolve() {
      throw new Error('Not implemented in memory API');
    },
    async startSiteprobeRun() {
      throw new Error('Not implemented in memory API');
    },
    async getSiteprobeRun() {
      throw new Error('Not implemented in memory API');
    },
    // A list, so "the server is holding nothing" is the truthful default rather than a throw: the
    // panels ask this on mount to take back a run they started before the person left the page.
    async listSiteprobeRuns() {
      return [];
    },
    async cancelSiteprobeRun() {
      throw new Error('Not implemented in memory API');
    },
    async listTaxonomyAliases() {
      return [];
    },
    async upsertTaxonomyAlias() {
      throw new Error('Not implemented in memory API');
    },
    async importTaxonomyAliases() {
      return { aliases: [], skipped: [] };
    },
    async importSiteDictionaries() {
      return {
        sites: 0, imported: 0, pending: 0, skipped: 0, rewritten: 0, merged: 0, conflicts: [],
      };
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
      createdSectionCount += 1;
      return {
        id: 800 + createdSectionCount,
        entryType: input.entryType,
        name: input.name.trim(),
        sortOrder: input.sortOrder ?? 0,
        defaultFacetId: 900 + createdSectionCount,
      };
    },
    async createFacet(input) {
      createdFacetName = input.name.trim();
    },
    async assignEntryTag(entryId, input) {
      assignedTagName = input.name.trim();
      assignedTagEntryId = entryId;
      assignedTagFacetId = input.facetId;
      // The server answers with the tag it just linked; the fixture serves the
      // same tag (id 14) from the Entry it returns on the next read.
      return { tagId: 14, name: assignedTagName, normalizedName: assignedTagName.toLowerCase(), facetId: input.facetId };
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
    async renameSection() {
      throw new Error('Not implemented in memory API');
    },
    async deleteSection() {
      throw new Error('Not implemented in memory API');
    },
  };
}

// Home is the default view: tests that need a Gallery grid must open one.
async function openGalleryType(wrapper: VueWrapper, type = 'game'): Promise<void> {
  await wrapper.get(`[data-gallery-type="${type}"]`).trigger('click');
  await flushPromises();
}

/**
 * The folder and batch doors now live on the Add Entry page's "Import files" tab.
 *
 * The page grew four tabs (quick / advanced / rules / files) so that the quick form — the one the
 * phone uses — is not buried under the desktop import machinery. A test that drives an import
 * therefore opens that tab first; everything it does afterwards is unchanged.
 */
async function openAddEntryFilesTab(wrapper: VueWrapper): Promise<void> {
  // The page finishes opening asynchronously (it loads the Galleries and Authors it needs), and its
  // tab state lives in the page component: settling that work first is what keeps the click from
  // landing on a page that is about to be replaced.
  await flushPromises();
  await wrapper.get('[data-testid="add-entry-tab-files"]').trigger('click');
  await flushPromises();
  if (!wrapper.find('[data-testid="add-entry-files"]').exists()) {
    throw new Error('DEBUG section missing');
  }
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

  it('shows switching progress and an explicit unavailable state instead of an empty library', async () => {
    const wrapper = mount(GalleryApp, { props: {
      api: createMemoryApi(),
      offlineState: { mode: 'online', lastFallbackAt: null, connectionPhase: 'switching' },
    } });
    expect(wrapper.get('[data-testid="offline-connection-status"]').text()).toContain('switching to offline');
    await flushPromises();
    await wrapper.setProps({
      offlineState: { mode: 'online', lastFallbackAt: null, connectionPhase: 'no-copy' },
    });
    expect(wrapper.get('[data-testid="offline-unavailable"]').text()).toContain('not an empty library');
  });

  it('waits for the local snapshot pointer before beginning home reads', async () => {
    let release!: () => void;
    const startupReady = new Promise<void>((resolve) => { release = resolve; });
    const api = createMemoryApi();
    const listGalleries = vi.spyOn(api, 'listGalleries');
    const wrapper = mount(GalleryApp, { props: {
      api, startupReady,
      offlineState: { mode: 'online', lastFallbackAt: null, connectionPhase: 'checking' },
    } });
    await flushPromises();
    expect(wrapper.get('[data-testid="offline-connection-status"]').text()).toContain('Checking');
    expect(listGalleries).not.toHaveBeenCalled();
    release();
    await flushPromises();
    expect(listGalleries).toHaveBeenCalled();
  });

  it('opens the saved offline Gallery without requesting online-only sidebar counts', async () => {
    const api = createMemoryApi();
    api.getNavigationCounts = vi.fn(() => new Promise<never>(() => undefined));
    const wrapper = mount(GalleryApp, { props: {
      api,
      offlineState: { mode: 'offline', lastFallbackAt: null },
    } });

    await flushPromises();
    expect(wrapper.find('[data-testid="sidebar-home"]').exists()).toBe(true);
    expect(wrapper.get('[data-gallery-type="game"]').text()).toContain('game');
    expect(api.getNavigationCounts).not.toHaveBeenCalled();
  });

  it('renders Galleries while a noncritical sidebar count request is still pending', async () => {
    const api = createMemoryApi();
    api.getNavigationCounts = vi.fn(() => new Promise<never>(() => undefined));
    const wrapper = mount(GalleryApp, { props: { api } });

    await flushPromises();
    expect(wrapper.find('[data-testid="sidebar-home"]').exists()).toBe(true);
    expect(wrapper.get('[data-gallery-type="game"]').text()).toContain('game');
  });

  it('opens a saved Gallery before slower Author and View-later lists settle', async () => {
    const api = createMemoryApi();
    const readAuthors = api.listAuthors.bind(api);
    const readViewLater = api.getViewLaterState.bind(api);
    let releaseSupplementary!: () => void;
    const supplementaryGate = new Promise<void>((resolve) => { releaseSupplementary = resolve; });
    api.listAuthors = vi.fn(async () => { await supplementaryGate; return readAuthors(); });
    api.getViewLaterState = vi.fn(async () => { await supplementaryGate; return readViewLater(); });
    const wrapper = mount(GalleryApp, { props: {
      api,
      offlineState: { mode: 'offline', lastFallbackAt: null },
    } });

    await flushPromises();
    expect(wrapper.find('[data-testid="sidebar-home"]').exists()).toBe(true);
    expect(wrapper.get('[data-gallery-type="game"]').text()).toContain('game');
    expect(wrapper.find('[data-testid="author-navigation"]').exists()).toBe(false);

    releaseSupplementary();
    await flushPromises();
    expect(wrapper.find('[data-testid="author-navigation"]').exists()).toBe(true);
  });

  it('shows a copyable runtime report for offline mutation diagnosis', async () => {
    const offlineStore = createMemorySnapshotStore();
    await offlineStore.writeMeta('activeGeneration', '7');
    await offlineStore.writeMeta('capability.offlineEntryCreate', '1');
    await offlineStore.writeMeta('capability.offlineUsageEvents', '0');
    await offlineStore.writeMeta('capability.offlineEntryViewLater', '1');
    await offlineStore.writeMeta('capability.offlineEntryRating', '1');
    await offlineStore.writeMeta('capability.offlineEntryAuthors', '1');
    await offlineStore.writeMeta('capability.offlineAuthorCreate', '1');
    await offlineStore.writeMeta('capability.offlineEntryTags', '1');
    await offlineStore.writeMeta('capability.offlinePendingEntryTags', '1');
    for (const flag of ['offlineEntryFacetCreate', 'offlineEntryTagVocabulary', 'offlinePendingEntryTagCreation']) await offlineStore.writeMeta(`capability.${flag}`, '1');
    await offlineStore.writeMeta('capability.offlinePendingEntryAuthors', '1');
    await offlineStore.writeMeta('capability.offlinePendingEntryMetadata', '1');
    await offlineStore.writeMeta('capability.offlinePendingEntryContents', '1');
    await offlineStore.writeMeta('capability.offlinePendingEntryAuthorCreate', '1');
    await offlineStore.writeMeta('capability.offlineCrossEntryPendingAuthors', '1');
    await offlineStore.writeMeta('capability.offlineProducerViewLater', '0');
    await offlineStore.writeMeta('capability.offlineProducerRating', '1');
    await offlineStore.writeMeta('capability.offlineProducerProfile', '1');
    await offlineStore.writeMeta('capability.offlineProducerTags', '1');
    await offlineStore.writeMeta('capability.offlineCollectionManagement', '0');
    await Promise.all([
      offlineStore.writeMeta('capability.offlineMutations', '1'),
      offlineStore.writeMeta('capability.offlineEntryUpdate', '1'),
      offlineStore.writeMeta('capability.completeSnapshotDelta', '1'),
      offlineStore.writeMeta('capability.offlineMediaUpload', '1'),
      offlineStore.writeMeta('capability.offlineMediaMultiplePreviews', '1'),
      offlineStore.writeMeta('capability.existingEntryMedia', '1'),
    ]);
    const wrapper = mount(GalleryApp, {
      props: {
        api: createMemoryApi(),
        offlineStore,
        offlineState: {
          mode: 'offline',
          lastFallbackAt: '2026-09-21T00:00:00Z',
          pendingCount: 0,
          lastCapabilityProbe: {
            at: '2026-09-21T00:00:00Z', status: 'success', serverBuild: 'test',
            offlineUsageEvents: false, offlineEntryViewLater: true, offlineEntryRating: true,
            offlineEntryAuthors: true, offlineAuthorCreate: true, offlineEntryTags: true, offlineEntryContents: true, offlineProducerViewLater: false, offlineProducerRating: true,
            offlineProducerProfile: true, offlineProducerTags: true,
            offlineRatingSlotLayout: false, offlineCollectionProducerMembership: false,
            offlineCollectionManagement: false, offlineAuthorDirectories: false, error: null,
          },
          lastMutationDiagnostic: {
            at: '2026-09-21T00:01:00Z', action: 'like', modeBefore: 'offline', modeAfter: 'offline',
            capability: '0', result: 'error', transportClassified: false,
            errorName: 'Error', errorMessage: 'offline usage is disabled',
          },
        },
      },
    });

    await flushPromises();
    await wrapper.get('[data-testid="offline-diagnostics-toggle"]').trigger('click');
    await flushPromises();
    const report = wrapper.get('[data-testid="offline-diagnostics"]').text();
    expect(report).toContain('0.0.40-c3-offline-read-latency');
    expect(report).toMatch(/"snapshotReadyAtMs":\s*\d+/u);
    expect(report).toMatch(/"galleriesReadyAtMs":\s*\d+/u);
    expect(report).toContain('"offlineAuthorCreate": "1"');
    expect(report).toContain('"offlineEntryTags": "1"');
    expect(report).toContain('"offlinePendingEntryTags": "1"');
    for (const flag of ['offlineEntryFacetCreate', 'offlineEntryTagVocabulary', 'offlinePendingEntryTagCreation']) expect(report).toContain(`"${flag}": "1"`);
    expect(report).toContain('"offlinePendingEntryAuthors": "1"');
    expect(report).toContain('"offlinePendingEntryMetadata": "1"');
    expect(report).toContain('"offlinePendingEntryContents": "1"');
    expect(report).toContain('"offlinePendingEntryAuthorCreate": "1"');
    expect(report).toContain('"offlineCrossEntryPendingAuthors": "1"');
    expect(report).toContain('"offlineUsageEvents": "0"');
    expect(report).toContain('"offlineEntryRating": "1"');
    expect(report).toContain('"offlineEntryAuthors": "1"');
    expect(report).toContain('"offlineProducerViewLater": "0"');
    expect(report).toContain('"offlineProducerRating": "1"');
    expect(report).toContain('"offlineProducerProfile": "1"');
    expect(report).toContain('"offlineProducerTags": "1"');
    expect(report).toContain('"offlineCollectionManagement": "0"');
    expect(report).toContain('"offlineMutations": "1"');
    expect(report).toContain('"offlineEntryUpdate": "1"');
    expect(report).toContain('"completeSnapshotDelta": "1"');
    expect(report).toContain('"offlineMediaUpload": "1"');
    expect(report).toContain('"offlineMediaMultiplePreviews": "1"');
    expect(report).toContain('"existingEntryMedia": "1"');
    expect(report).toContain('"action": "like"');
    expect(report).toContain('"activeGeneration": "7"');
  });

  it('shows durable pending and conflict counts in the offline banner', async () => {
    const api = createMemoryApi();
    api.discardBlockedOfflineOperations = vi.fn().mockResolvedValue(undefined);
    const wrapper = mount(GalleryApp, {
      props: {
        api,
        offlineState: {
          mode: 'online', lastFallbackAt: null, pendingCount: 1,
          conflictCount: 0, lastReplayError: null,
        },
      },
    });

    expect(wrapper.get('[data-testid="offline-pending-count"]').text()).toContain('1 offline edit');
    await wrapper.setProps({
      offlineState: {
        mode: 'online', lastFallbackAt: null, pendingCount: 0,
        conflictCount: 1, lastReplayError: 'conflict',
      },
    });
    expect(wrapper.find('[data-testid="offline-mode-banner"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="offline-conflict-count"]').text()).toContain('1 offline edit');
    await wrapper.get('[data-testid="offline-discard-blocked"]').trigger('click');
    expect(api.discardBlockedOfflineOperations).toHaveBeenCalledTimes(1);
    await wrapper.setProps({
      offlineState: {
        mode: 'online', lastFallbackAt: null, pendingCount: 2,
        conflictCount: 1, failedCount: 1, lastReplayError: 'validation',
      },
    });
    expect(wrapper.get('[data-testid="offline-pending-count"]').text()).toContain('2 offline edit');
    expect(wrapper.get('[data-testid="offline-conflict-count"]').text()).toContain('1 offline edit');
    expect(wrapper.get('[data-testid="offline-failed-count"]').text()).toContain('failed validation');
  });

  it('keeps the offline copy on the Advanced function page and out of the Settings sheet', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await wrapper.get('[data-testid="settings-button"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="offline-settings"]').exists()).toBe(false);
    // The entry to the Advanced function page sits in the sheet; it closes as
    // that page opens.
    await wrapper.get('[data-testid="advanced-entry"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="advanced-page"]').text()).toContain('Advanced function');
    expect(wrapper.find('[data-testid="advanced-offline"]').exists()).toBe(false);
    await wrapper.get('[data-testid="advanced-tab-offline"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="advanced-offline"]').text()).toContain('Offline library');
  });

  it('gives the mobile connection block one title and one row of two buttons', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await wrapper.get('[data-testid="settings-button"]').trigger('click');
    await flushPromises();
    const block = wrapper.get('[data-testid="secure-pairing-settings"]');
    expect(block.text()).toContain('Connect to APP');
    expect(block.text()).not.toContain('Encrypted mobile connection');
    const actions = block.get('.pairing-actions');
    const labels = actions.findAll('button').map((node) => node.text());
    expect(labels).toEqual([
      'Create pairing QR (expires in 2 minutes)',
      'Authorized devices',
    ]);
    expect(actions.findAll('button').every((node) => node.classes().includes('secondary-button'))).toBe(true);
  });

  it('opens Settings and switches all UI copy between English and Chinese', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();

    expect(wrapper.get('h1').text()).toBe('Galleries');
    await wrapper.get('[data-testid="settings-button"]').trigger('click');
    expect(wrapper.get('[data-testid="settings-panel"]').text()).toContain('Language');
    // The offline copy is a function, not a quick setting: it lives on the
    // Advanced function page now, so the sheet must not carry it.
    expect(wrapper.find('[data-testid="offline-settings"]').exists()).toBe(false);

    await wrapper.get('[data-testid="language-select"]').setValue('zh-CN');

    expect(wrapper.get('h1').text()).toBe('画廊');
    expect(wrapper.get('[data-testid="settings-panel"]').text()).toContain('语言');
    expect(wrapper.get('[data-testid="add-entry-navigation"]').text()).toContain('新建条目');
    await wrapper.get('[data-testid="settings-button"]').trigger('click');
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    await openAddEntryFilesTab(wrapper);
    expect(wrapper.get('[data-testid="add-entry-page"]').text()).toContain('快速导入');
    expect(wrapper.get('[data-testid="add-entry-page"]').text()).toContain('链接导入');
    await openAddEntryFilesTab(wrapper);
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

  it('manages generic taxonomy aliases from the Advanced function page', async () => {
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
    // The dictionary has two lists now — decided and not yet — rather than the tool's sections, which
    // no generic adapter can fill and which the database never distinguished anyway. The saved mapping
    // is in the first; `alice`, which nobody has mapped, is in the second.
    expect(wrapper.get('[data-testid="taxonomy-group-pending"]').text()).toContain('1');
    expect(wrapper.get('[data-testid="taxonomy-group-mapped"]').text()).toContain('1');
    await wrapper.get('[data-testid="taxonomy-group-mapped"]').trigger('click');
    expect(wrapper.get('[data-testid="taxonomy-alias-list"]').text()).toContain('Bob → 鲍勃');
    expect(api.upsertTaxonomyAlias).toHaveBeenCalledWith({
      vocabulary: 'entry',
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

    // 无需映射: a name that needs no translation (`2B`) leaves the queue instead of sitting in it for
    // ever. A row mapping a name to itself would say nothing — the built-in conversion already covers
    // the one case where a name really does change — so the answer is to have no row at all.
    await wrapper.get('[data-testid="taxonomy-unmatched-only"]').setValue(false);
    await flushPromises();
    // The filter expanded every group, so the pending list is already open.
    const keptId = aliases.find((alias) => alias.alias === 'alice')!.id;
    await wrapper.get(`[data-testid="taxonomy-keep-${keptId}"]`).trigger('click');
    await flushPromises();
    expect(api.deleteTaxonomyAlias).toHaveBeenCalledWith(keptId);
    expect(wrapper.find('[data-testid="taxonomy-group-pending"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="taxonomy-import-summary"]').text()).toContain('alice');

    // The one-time move off the tool's export tree: every crawl has been writing a dictionary per
    // site all along, and until this button the only way to use one was to find the file and hand it
    // over — which stopped happening once a work went from a crawl to the library by itself.
    api.importSiteDictionaries = vi.fn(async () => ({
      sites: 7, imported: 2015, pending: 11, skipped: 1914, rewritten: 0, merged: 0,
      conflicts: [],
    }));
    await wrapper.get('[data-testid="taxonomy-import-site-dictionaries"]').trigger('click');
    await flushPromises();
    expect(api.importSiteDictionaries).toHaveBeenCalled();
    expect(wrapper.get('[data-testid="taxonomy-import-summary"]').text())
      .toContain('2015');
  });

  it('saves an author alias group from Advanced function and lists existing groups', async () => {
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
    // The saved groups stay closed until asked for: they are what you come back to check, not what
    // you came to read, and an always-open list pushed the form that saves one off a phone screen.
    expect(wrapper.find('[data-testid="author-alias-group-list"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="author-alias-groups-toggle"]').text()).toContain('1');
    await wrapper.get('[data-testid="author-alias-groups-toggle"]').trigger('click');
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
      // The Content scope comes from the works themselves: the two built-ins every Gallery has, plus
      // a kind somebody added on one work.
      contentKinds: ['source url', 'description', '短评'],
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
    // Full card sketch: Ratings with the gallery's shared slots, then Content — and the Content rows
    // are this Gallery's own kinds, not a fixed one: a kind added on a single work is part of it.
    expect(preview).toContain('Ratings');
    expect(preview).toContain('画力');
    expect(preview).toContain('Content');
    expect(preview).toContain('source url');
    expect(preview).toContain('description');
    expect(preview).toContain('短评');
    expect(wrapper.get('[data-testid="gallery-template-content-kinds-comic"]').text())
      .toContain('3');
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

  it('uses a fresh seed for every random Work deal', async () => {
    const api = createMemoryApi();
    const queryEntryPage = vi.spyOn(api, 'queryEntryPage');
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="random-navigation"]').trigger('click');
    await flushPromises();

    const random = vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.125)
      .mockReturnValueOnce(0.875);
    await wrapper.get('[data-testid="random-deal-button"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="random-deal-button"]').trigger('click');
    await flushPromises();
    random.mockRestore();

    const seeds = queryEntryPage.mock.calls
      .map(([input]) => input)
      .filter((input) => input.sort === 'random')
      .map((input) => input.randomSeed);
    expect(seeds).toEqual([
      Math.floor(0.125 * 2_147_483_648),
      Math.floor(0.875 * 2_147_483_648),
    ]);
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

    // The sidebar's search is an icon now, and the field it opens belongs to the Search page itself.
    await wrapper.get('[data-testid="sidebar-search"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="search-main-input"]').setValue('end');
    await wrapper.get('[data-testid="search-main-form"]').trigger('submit');
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

    // The sidebar's search is an icon now, and the field it opens belongs to the Search page itself.
    await wrapper.get('[data-testid="sidebar-search"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="search-main-input"]').setValue('end');
    await wrapper.get('[data-testid="search-main-form"]').trigger('submit');
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

    await wrapper.get('[data-testid="sidebar-search"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="search-main-input"]').setValue('sha');
    await wrapper.get('[data-testid="search-main-form"]').trigger('submit');
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

    await wrapper.get('[data-testid="sidebar-search"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="search-main-input"]').setValue('ishikei');
    await wrapper.get('[data-testid="search-main-form"]').trigger('submit');
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
    await flushPromises();
    expect(wrapper.get('[data-testid="add-entry-page"]').text()).toContain('New Entry');
    // What opens is the quick page: a cover dropzone, and no preview box until a cover exists.
    expect(wrapper.find('[data-testid="entry-cover-dropzone"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="entry-preview-dropzone"]').exists()).toBe(false);
    // The folder door lives on its own page now.
    await openAddEntryFilesTab(wrapper);
    expect(wrapper.find('input[webkitdirectory]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="desktop-entry-import"]').classes()).toContain('desktop-entry-import');

    await wrapper.get('[data-testid="add-entry-back"]').trigger('click');
    // The "+ Author" door is gone from the sidebar and from Home: it took a row of its own in a
    // drawer whose space belongs to the common actions. An Author is still created from the Entry
    // editor, where it is part of linking one.
    expect(wrapper.find('[data-testid="add-author-navigation"]').exists()).toBe(false);
  });

  it('files an export whose works were all already imported, through the plain folder import', async () => {
    setLocale('en');
    const api = createMemoryApi();
    api.listLayout = vi.fn(async () => [{
      id: 10, name: 'Imported', sortOrder: 0, facets: [{ id: 11, name: '', sortOrder: 0 }],
    }]);
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
          externalKey: 'hitomi.la:42',
          title: 'Known work',
          tags: [],
          sources: [{ label: 'hitomi', url: 'https://hitomi.la/g/42.html' }],
        }],
      },
    })) as unknown as typeof api.previewSiteProbeFolder;
    // Nothing new: the export's single work is already in the library.
    api.commitImport = vi.fn(async () => ({
      entries: [],
      entryCount: 0,
      skippedExistingEntryCount: 1,
      existingEntryIds: [2],
      createdProducerCount: 0,
      producerLinkCount: 0,
      tagAssignmentCount: 0,
      contentCount: 0,
      authorRatingCount: 0,
      warnings: [],
    })) as unknown as typeof api.commitImport;
    const createTemporaryCollection = vi.fn(async (entryIds: number[]) => ({
      collectionId: 88, title: 'Temporary', entryCount: entryIds.length,
    }));
    api.createTemporaryCollection = createTemporaryCollection as unknown as typeof api.createTemporaryCollection;

    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    await openAddEntryFilesTab(wrapper);
    await openAddEntryFilesTab(wrapper);
    const file = new File(['{}'], 'metadata.json', { type: 'application/json' });
    Object.defineProperty(file, 'webkitRelativePath', { value: 'folder_42/items/42/metadata.json' });
    const input = wrapper.get('[data-testid="desktop-entry-import"] input[webkitdirectory]');
    Object.defineProperty(input.element, 'files', { value: [file] });
    await input.trigger('change');
    await flushPromises();
    await wrapper.get('[data-testid="import-review"] .primary-button').trigger('click');
    await flushPromises();

    // Not the gallery: the run is offered for filing, with the known work shown.
    const review = wrapper.get('[data-testid="batch-review"]');
    const card = review.get('[data-entry-id="2"]');
    expect(card.get('[data-testid="batch-review-existing"]').text()).toBe('Already in the library');
    await wrapper.get('[data-testid="batch-review-save-collection"]').trigger('click');
    await flushPromises();
    expect(createTemporaryCollection).toHaveBeenCalledWith([2]);
  });

  it('files the works a batch import already knew into the same temporary collection', async () => {
    setLocale('en');
    const api = createMemoryApi();
    api.listLayout = vi.fn(async () => [{
      id: 10, name: 'Imported', sortOrder: 0, facets: [{ id: 11, name: '', sortOrder: 0 }],
    }]);
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
          externalKey: 'hitomi.la:99',
          title: 'Fresh work',
          tags: [],
          sources: [{ label: 'hitomi', url: 'https://hitomi.la/g/99.html' }],
        }],
      },
    })) as unknown as typeof api.previewSiteProbeFolder;
    // One item the run created, one the library already had.
    api.commitImport = vi.fn(async () => ({
      entries: [{ entryId: 4, title: 'Fresh work', externalKey: 'hitomi.la:99' }],
      entryCount: 1,
      skippedExistingEntryCount: 1,
      existingEntryIds: [2],
      createdProducerCount: 0,
      producerLinkCount: 0,
      tagAssignmentCount: 0,
      contentCount: 1,
      authorRatingCount: 0,
      warnings: [],
    })) as unknown as typeof api.commitImport;
    const createTemporaryCollection = vi.fn(async (entryIds: number[]) => ({
      collectionId: 77, title: 'Temporary', entryCount: entryIds.length,
    }));
    api.createTemporaryCollection = createTemporaryCollection as unknown as typeof api.createTemporaryCollection;

    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    await openAddEntryFilesTab(wrapper);
    await openAddEntryFilesTab(wrapper);
    await wrapper.get('.batch-import-toggle .secondary-button').trigger('click');
    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
    const batchTypeInput = wrapper.get('.batch-import input[list="add-entry-gallery-types"]');
    await batchTypeInput.setValue('Comic');
    await batchTypeInput.trigger('change');
    await flushPromises();

    const file = new File(['{}'], 'metadata.json', { type: 'application/json' });
    Object.defineProperty(file, 'webkitRelativePath', { value: 'folder_42/items/99/metadata.json' });
    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
    const batchInput = wrapper.get('.batch-import input[webkitdirectory]');
    Object.defineProperty(batchInput.element, 'files', { value: [file] });
    await batchInput.trigger('change');
    await flushPromises();
    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
    await wrapper.get('.batch-import .primary-button').trigger('click');
    await flushPromises();

    const review = wrapper.get('[data-testid="batch-review"]');
    // The works the library already had are stated, not silently dropped: the
    // folder a work came from is itself information.
    expect(review.get('[data-testid="batch-review-warnings"]').text())
      .toContain('1 works were already in the library and are filed with this run.');

    // Both appear, and the one the library already had says so.
    const cards = wrapper.findAll('[data-testid="batch-review"] [data-entry-id]');
    expect(cards.map((card) => card.attributes('data-entry-id'))).toContain('2');
    const existingCard = cards.find((card) => card.attributes('data-entry-id') === '2')!;
    expect(existingCard.get('[data-testid="batch-review-existing"]').text()).toBe('Already in the library');

    await wrapper.get('[data-testid="batch-review-save-collection"]').trigger('click');
    await flushPromises();
    expect(createTemporaryCollection).toHaveBeenCalledWith([4, 2]);
  });

  it('offers the template path from the composer without complicating it', async () => {
    setLocale('en');
    const api = createMemoryApi();
    const created: Array<{ title: string; type: string }> = [];
    const memoryCreateEntry = api.createEntry;
    api.createEntry = (async (input: { title: string; type: string }) => {
      created.push(input);
      return memoryCreateEntry(input as Parameters<typeof memoryCreateEntry>[0]);
    }) as typeof api.createEntry;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    await flushPromises();

    // The simple composer is still there: cover + fields, nothing else.
    expect(wrapper.find('[data-testid="manual-template-section"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="entry-cover-dropzone"]').exists()).toBe(true);

    // Default type is an existing Gallery -> the template is already there.
    expect(wrapper.get('[data-testid="create-with-template"]').text())
      .toContain('Template ready — open detailed editing');
    await wrapper.get('[data-testid="add-entry-page"] input[name="title"]').setValue('Quick one');
    await wrapper.get('[data-testid="create-with-template"]').trigger('click');
    await flushPromises();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ title: 'Quick one', type: 'game' });
    // Straight into the new work's editor, which is where the template lives.
    expect(wrapper.find('[data-testid="entry-detail"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="entry-detail"]').text()).toContain('Quick one');
    expect(wrapper.find('[data-testid="finish-entry-editing"]').exists()).toBe(true);
  });

  it('labels the template path as a new Gallery when the type is unknown', async () => {
    setLocale('en');
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-testid="add-entry-page"] input[name="type"]').setValue('doujin');
    await flushPromises();
    expect(wrapper.get('[data-testid="create-with-template"]').text())
      .toContain('New Gallery — create its template');
  });

  it('offers to apply the template when the first work of a Gallery finishes editing', async () => {
    setLocale('en');
    const api = createMemoryApi();
    const apply = vi.fn(async () => ({
      entryId: 3, entriesAffected: 1, tagsRelinked: 0, templatePath: null, tagLayoutPath: null,
      backupPath: null, foreignKeyCheckPass: true, doctorPass: true, doctorIssues: [],
    }));
    api.applyEntryLayoutTemplate = apply as unknown as typeof api.applyEntryLayoutTemplate;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    // Entry 3 is the only manga work and carries no Sections yet.
    await openGalleryType(wrapper, 'manga');
    await wrapper.get('[data-entry-id="3"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-testid="finish-entry-editing"]').trigger('click');
    await flushPromises();

    const prompt = wrapper.get('[data-testid="template-prompt"]');
    expect(prompt.text()).toContain('This Gallery has no template yet');
    expect(prompt.text()).toContain('Apply this work’s Sections and Facets to every manga work');
    // Still editing behind the prompt: nothing was saved away yet.
    expect(wrapper.find('[data-testid="finish-entry-editing"]').exists()).toBe(true);

    await wrapper.get('[data-testid="template-prompt-apply"]').trigger('click');
    await flushPromises();
    expect(apply).toHaveBeenCalledWith(3);
    expect(wrapper.find('[data-testid="template-prompt"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="finish-entry-editing"]').exists()).toBe(false);
  });

  it('leaves a Gallery whose work already has a structure alone when Done is clicked', async () => {
    setLocale('en');
    const api = createMemoryApi();
    const apply = vi.fn(async () => ({
      entryId: 1, entriesAffected: 1, tagsRelinked: 0, templatePath: null, tagLayoutPath: null,
      backupPath: null, foreignKeyCheckPass: true, doctorPass: true, doctorIssues: [],
    }));
    api.applyEntryLayoutTemplate = apply as unknown as typeof api.applyEntryLayoutTemplate;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    // Entry 1 carries Sections and shares its Gallery with entry 2.
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-testid="finish-entry-editing"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="template-prompt"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="finish-entry-editing"]').exists()).toBe(false);
    expect(apply).not.toHaveBeenCalled();
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
      existingEntryIds: [],
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
    await openAddEntryFilesTab(wrapper);
    await openAddEntryFilesTab(wrapper);
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
      existingEntryIds: [],
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
    await openAddEntryFilesTab(wrapper);
    await openAddEntryFilesTab(wrapper);
    await wrapper.get('.batch-import-toggle .secondary-button').trigger('click');
    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
    const batchTypeInput = wrapper.get('.batch-import input[list="add-entry-gallery-types"]');
    await batchTypeInput.setValue('game');
    await batchTypeInput.trigger('change');
    await flushPromises();
    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
    const batchInput = wrapper.get('.batch-import input[webkitdirectory]');
    const file = new File(['{}'], 'metadata.json', { type: 'application/json' });
    Object.defineProperty(file, 'webkitRelativePath', {
      value: 'hews/items/4103646/metadata.json',
    });
    Object.defineProperty(batchInput.element, 'files', { value: [file] });
    await batchInput.trigger('change');
    await flushPromises();

    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
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
    await openAddEntryFilesTab(wrapper);
    await openAddEntryFilesTab(wrapper);
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
      existingEntryIds: [],
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
    await openAddEntryFilesTab(wrapper);
    await openAddEntryFilesTab(wrapper);
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

  it('leaves the person on the page they moved to while an import was being prepared', async () => {
    const api = createMemoryApi();
    api.listLayout = vi.fn(async () => [{
      id: 10, name: 'Tags', sortOrder: 0, facets: [{ id: 11, name: '', sortOrder: 0 }],
    }]);
    // Preparing a folder takes a moment, and this holds it open so the person can move away in
    // between — which is the whole point: the review used to take over the import page
    // unconditionally, pulling them out of whatever page they had gone to.
    let release: (() => void) | null = null;
    api.previewSiteProbeFolder = vi.fn(() => new Promise((resolve) => {
      release = () => resolve({
        source: 'hitomi.la',
        entryCount: 0,
        tagAssignmentCount: 0,
        uniqueTagCount: 0,
        entriesMissingCover: 0,
        warnings: [],
        batch: { source: 'hitomi.la', warnings: [], entries: [] },
      });
    })) as unknown as typeof api.previewSiteProbeFolder;

    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    await openAddEntryFilesTab(wrapper);
    await openAddEntryFilesTab(wrapper);
    const file = new File(['{}'], 'metadata.json', { type: 'application/json' });
    Object.defineProperty(file, 'webkitRelativePath', { value: 'folder_42/items/42/metadata.json' });
    const input = wrapper.get('[data-testid="desktop-entry-import"] input[webkitdirectory]');
    Object.defineProperty(input.element, 'files', { value: [file] });
    await input.trigger('change');

    // Away to another page while the preview is still being read.
    await wrapper.get('[data-testid="add-entry-tab-quick"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="manual-entry-form"]').exists()).toBe(true);

    release!();
    await flushPromises();

    // Still there. The review is waiting on the import page, and going back to it finds it.
    expect(wrapper.find('[data-testid="manual-entry-form"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="add-entry-import"]').exists()).toBe(false);
    await wrapper.get('[data-testid="add-entry-tab-import"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="import-review"]').exists()).toBe(true);
  });

  it('finishes the pictures of a work an interrupted import left behind', async () => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
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
        entries: [{
          externalKey: 'hitomi.la:42',
          title: 'Known work',
          cover: 'items/42/cover/cover.webp',
        }],
      },
    }));
    api.listLayout = vi.fn(async () => [{
      id: 10, name: 'Tags', sortOrder: 0, facets: [{ id: 11, name: '', sortOrder: 0 }],
    }]);
    // The rows were committed and the tab was closed before the pictures went up: the work is in the
    // library with no cover, and the import that follows it *skips* the work rather than passing over
    // it, so this is the only chance its pictures have.
    api.commitImport = vi.fn(async () => ({
      entries: [],
      entryCount: 0,
      skippedExistingEntryCount: 1,
      existingEntryIds: [42],
      skippedExisting: [{ entryId: 42, externalKey: 'hitomi.la:42', title: 'Known work' }],
      createdProducerCount: 0,
      producerLinkCount: 0,
      tagAssignmentCount: 0,
      contentCount: 0,
      authorRatingCount: 0,
      warnings: [],
    }));
    api.getEntry = vi.fn(async () => ({
      id: 42, title: 'Known work', type: 'game',
      coverRef: null, previewRef: null, previewRefs: [],
      uploadDate: null, pageCount: null,
    })) as unknown as typeof api.getEntry;
    const uploadEntryMedia = vi.fn<GalleryApi['uploadEntryMedia']>(async () => ({
      id: 42, title: 'Known work', type: 'game',
      coverRef: '/api/assets/entries/42/cover.webp', previewRef: null, previewRefs: [],
      uploadDate: null, pageCount: null,
    }));
    api.uploadEntryMedia = uploadEntryMedia;

    const files = [
      new File(['{}'], 'metadata.json', { type: 'application/json' }),
      new File(['cover'], 'cover.webp', { type: 'image/webp' }),
    ];
    for (const [file, path] of files.map((file, index) => [file, [
      'export/metadata.json',
      'export/items/42/cover/cover.webp',
    ][index]!] as const)) {
      Object.defineProperty(file, 'webkitRelativePath', { value: path });
    }

    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    await openAddEntryFilesTab(wrapper);
    await openAddEntryFilesTab(wrapper);
    const input = wrapper.get('.folder-dropzone input[webkitdirectory]');
    Object.defineProperty(input.element, 'files', { value: files });
    await input.trigger('change');
    await flushPromises();
    await wrapper.get('[data-testid="import-review"] .primary-button').trigger('click');
    await flushPromises();

    expect(uploadEntryMedia).toHaveBeenCalledTimes(1);
    expect(uploadEntryMedia.mock.calls[0]?.slice(0, 2)).toEqual([42, 'cover']);
    expect(uploadEntryMedia.mock.calls[0]?.[2]).toBe(files[1]);
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
      existingEntryIds: [],
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
    await openAddEntryFilesTab(wrapper);
    await openAddEntryFilesTab(wrapper);
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
      existingEntryIds: [],
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
    await openAddEntryFilesTab(wrapper);
    await openAddEntryFilesTab(wrapper);
    const metadata = new File(['{}'], 'metadata.json', { type: 'application/json' });
    Object.defineProperty(metadata, 'webkitRelativePath', { value: '99737/metadata.json' });
    const folderInput = wrapper.get('input[webkitdirectory]');
    Object.defineProperty(folderInput.element, 'files', { value: [metadata] });
    await folderInput.trigger('change');
    await flushPromises();

    const typeField = wrapper.get<HTMLInputElement>('[data-testid="import-type-input"]');
    // The field takes a type that does not exist yet, so it is an input; the list is behind the
    // arrow (the same control the quick page uses) rather than a `<select>` with a closed set.
    expect(typeField.element.value).toBe('Comic');
    await wrapper.get('[data-testid="import-type-toggle"]').trigger('click');
    // The list follows the app's SFW preference, like the sidebar and the quick page's own field —
    // and a Gallery that is not listed is still reachable by typing its name, which is the whole
    // reason this is an input.
    expect(wrapper.findAll('[data-testid="import-type-list"] [data-gallery-option]')
      .map((option) => option.attributes('data-gallery-option'))).toEqual(['Comic']);
    await typeField.setValue('Hentai');
    await typeField.trigger('change');
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
      existingEntryIds: [],
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
    await openAddEntryFilesTab(wrapper);
    await openAddEntryFilesTab(wrapper);
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
      existingEntryIds: [],
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
    await openAddEntryFilesTab(wrapper);
    await openAddEntryFilesTab(wrapper);
    await wrapper.get('.batch-import-toggle .secondary-button').trigger('click');

    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
    const batchTypeInput = wrapper.get('.batch-import input[list="add-entry-gallery-types"]');
    await batchTypeInput.setValue('Comic');
    await batchTypeInput.trigger('change');
    await flushPromises();

    // The Comic template has a Type Facet, so the batch-wide input shows.
    await wrapper.get('[data-testid="batch-content-type"] input').setValue('doujinshi');

    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
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

    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
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
      existingEntryIds: [],
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
    await openAddEntryFilesTab(wrapper);
    await openAddEntryFilesTab(wrapper);
    await wrapper.get('.batch-import-toggle .secondary-button').trigger('click');

    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
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

    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
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
      existingEntryIds: [],
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
    await openAddEntryFilesTab(wrapper);
    await openAddEntryFilesTab(wrapper);
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

  it('takes the sidebar numbers from the visibility-aware counts interface', async () => {
    showNsfw.value = false;
    const api = createMemoryApi();
    const requested: boolean[] = [];
    api.getNavigationCounts = vi.fn(async (includeNsfw: boolean) => {
      requested.push(includeNsfw);
      return includeNsfw
        ? { authors: 4, viewLaterEntries: 3, viewLaterAuthors: 2 }
        : { authors: 1, viewLaterEntries: 0, viewLaterAuthors: 0 };
    });
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    expect(wrapper.get('[data-testid="author-navigation-count"]').text()).toBe('1');
    expect(wrapper.find('[data-testid="view-later-navigation-count"]').exists()).toBe(false);

    showNsfw.value = true;
    await flushPromises();
    expect(wrapper.get('[data-testid="author-navigation-count"]').text()).toBe('4');
    expect(wrapper.get('[data-testid="view-later-navigation-count"]').text()).toBe('5');
    // Startup and the saved-list watcher may both refresh; the preference always
    // travels with the request, and the last one follows the current switch.
    expect(requested[0]).toBe(false);
    expect(requested).toContain(true);
    expect(requested.at(-1)).toBe(true);
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

  it('mounted Entry Author selector uses stable staged UUID after genuine online recovery',async()=>{
    const {createOfflineAwareGalleryApi}=await import('../src/offline/offline-api.js');
    const {createMemoryOutboxStore}=await import('../src/offline/outbox-store.js');
    const {createMemoryMediaOutboxStore}=await import('../src/offline/media-outbox-store.js');
    const {offlineSnapshot}=await import('./fixtures/pending-entry-tags.js');
    const outbox=createMemoryOutboxStore(),store={...createMemorySnapshotStore(),...outbox,...createMemoryMediaOutboxStore(op=>outbox.enqueue(op))};
    await store.writeGeneration(1,JSON.stringify(offlineSnapshot()));await store.writeMeta((await import('../src/offline/snapshot-store.js')).ACTIVE_GENERATION_KEY,'1');
    for(const flag of ['offlineEntryCreate','offlineEntryAuthors','offlinePendingEntryAuthors','offlineAuthorCreate','offlinePendingEntryAuthorCreate','offlineCrossEntryPendingAuthors']) await store.writeMeta(`capability.${flag}`,'1');
    const online=createMemoryApi({withAuthors:false}),get=vi.spyOn(online,'getEntry'),link=vi.spyOn(online,'linkEntryAuthor');
    const api=createOfflineAwareGalleryApi(online,store,{clientId:'mounted-cross'});
    const a=await api.enqueueOfflineEntryCreate!({title:'Source',type:'game',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null});
    const author=await api.enqueueOfflinePendingEntryAuthorCreate!(a.localKey,'Staged Cross Author');
    const source=(await store.list())[1]!;
    online.fetchSyncSnapshot=vi.fn().mockResolvedValue(offlineSnapshot());await api.fetchSyncSnapshot();
    const wrapper=mount(GalleryApp,{props:{api}});await flushPromises();await openEntryForEditing(wrapper,1);
    expect(get).toHaveBeenCalledWith(1);
    await wrapper.get('[data-testid="link-entry-author"]').trigger('click');
    await wrapper.get('[name="existingAuthorName"]').trigger('focus');
    await wrapper.get('[name="existingAuthorName"]').setValue('Staged');await suggestionDebounce();
    await wrapper.get('[data-testid="link-existing-author-form"] [role="option"] button').trigger('click');await flushPromises();
    expect(link).not.toHaveBeenCalled();
    expect((await store.list()).at(-1)).toMatchObject({operationKind:'entry.authors.set',payload:{producerUids:expect.arrayContaining([author.producerUid]),producerCreates:[{producerUid:author.producerUid,createOpId:source.opId}]}});
  });

  it('mounted Entry editor unlinks staged Author after genuine online recovery',async()=>{
    const {createOfflineAwareGalleryApi}=await import('../src/offline/offline-api.js');
    const {createMemoryOutboxStore}=await import('../src/offline/outbox-store.js');
    const {createMemoryMediaOutboxStore}=await import('../src/offline/media-outbox-store.js');
    const {offlineSnapshot}=await import('./fixtures/pending-entry-tags.js');
    const outbox=createMemoryOutboxStore(),store={...createMemorySnapshotStore(),...outbox,...createMemoryMediaOutboxStore(op=>outbox.enqueue(op))};
    await store.writeGeneration(1,JSON.stringify(offlineSnapshot()));await store.writeMeta((await import('../src/offline/snapshot-store.js')).ACTIVE_GENERATION_KEY,'1');
    for(const flag of ['offlineEntryCreate','offlineEntryAuthors','offlinePendingEntryAuthors','offlineAuthorCreate','offlinePendingEntryAuthorCreate','offlineCrossEntryPendingAuthors']) await store.writeMeta(`capability.${flag}`,'1');
    const online=createMemoryApi({withAuthors:false}),get=vi.spyOn(online,'getEntry'),link=vi.spyOn(online,'linkEntryAuthor'),unlink=vi.spyOn(online,'unlinkEntryAuthor').mockRejectedValue(new Error('negative numeric Author forbidden'));
    const api=createOfflineAwareGalleryApi(online,store,{clientId:'mounted-cross'});
    const a=await api.enqueueOfflineEntryCreate!({title:'Source',type:'game',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null});
    const author=await api.enqueueOfflinePendingEntryAuthorCreate!(a.localKey,'Staged Cross Author');
    const source=(await store.list())[1]!;
    online.fetchSyncSnapshot=vi.fn().mockResolvedValue(offlineSnapshot());await api.fetchSyncSnapshot();
    const wrapper=mount(GalleryApp,{props:{api}});await flushPromises();await openEntryForEditing(wrapper,1);
    expect(get).toHaveBeenCalledWith(1);
    await wrapper.get('[data-testid="link-entry-author"]').trigger('click');
    await wrapper.get('[name="existingAuthorName"]').trigger('focus');
    await wrapper.get('[name="existingAuthorName"]').setValue('Staged');await suggestionDebounce();
    await wrapper.get('[data-testid="link-existing-author-form"] [role="option"] button').trigger('click');await flushPromises();
    expect(link).not.toHaveBeenCalled();
    expect((await store.list()).at(-1)).toMatchObject({operationKind:'entry.authors.set',payload:{producerUids:expect.arrayContaining([author.producerUid]),producerCreates:[{producerUid:author.producerUid,createOpId:source.opId}]}});
    const before=await store.list();
    const authorId=Number(wrapper.get('[data-unlink-author-id^="-"]').attributes('data-unlink-author-id'));
    expect(authorId).toBeLessThan(0);
    const remainingUids=(before.at(-1)!.payload.producerUids as string[]).filter(uid=>uid!==author.producerUid);
    await api.fetchSyncSnapshot();get.mockClear();await api.getEntry(1);expect(get).toHaveBeenCalledWith(1);
    await wrapper.get(`[data-unlink-author-id="${authorId}"]`).trigger('click');await flushPromises();
    expect(unlink).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(before.length+1);
    expect((await store.list()).at(-1)).toMatchObject({entityUid:before.at(-1)!.entityUid,operationKind:'entry.authors.set',baseValues:{producerUids:before.at(-1)!.payload.producerUids},payload:{producerUids:remainingUids,producerCreates:[{producerUid:author.producerUid,createOpId:source.opId}]}});
    expect((await store.list()).slice(0,before.length)).toEqual(before);
    expect(wrapper.find(`[data-unlink-author-id="${authorId}"]`).exists()).toBe(false);
    expect((await api.listPendingOfflineEntryCreates!()).find(row=>row.localKey===a.localKey)?.authors).toContainEqual(author);
  });

  it('selects a staged Author via the actual synced Entry RelationSuggestion callback', async () => {
    const api=createMemoryApi();
    vi.spyOn(api,'suggestProducers').mockResolvedValue([{id:-42,name:'Staged Cross Author',sameContextUsageCount:0,totalUsageCount:0}]);
    const link=vi.spyOn(api,'linkEntryAuthor').mockResolvedValue(undefined);
    const wrapper=mount(GalleryApp,{props:{api}});await flushPromises();await openEntryForEditing(wrapper,1);
    await wrapper.get('[data-testid="link-entry-author"]').trigger('click');
    await wrapper.get('[name="existingAuthorName"]').trigger('focus');
    await wrapper.get('[name="existingAuthorName"]').setValue('Staged');await suggestionDebounce();
    await wrapper.get('[data-testid="link-existing-author-form"] [role="option"] button').trigger('click');await flushPromises();
    expect(link).toHaveBeenCalledWith(1,-42);
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

  it('plans and applies title shortening from Advanced function', async () => {
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

  it('offers the Gallery’s Content kinds as one-click labels, and refuses an empty row', async () => {
    const api = createMemoryApi();
    // The kinds this Gallery already uses: the two built-ins plus one somebody added on a work.
    api.listContentKinds = vi.fn(async () => ['source url', 'description', '短评']);
    const createContent = vi.spyOn(api, 'createEntryContent');
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-testid="add-content-button"]').trigger('click');
    await flushPromises();
    // A work's `description` is a click rather than a spelling exercise, and the chips are this
    // Gallery's kinds — asked for on the Entry's own type.
    expect(api.listContentKinds).toHaveBeenCalledWith('game');
    const chips = wrapper.get('[data-testid="content-kind-chips"]');
    expect(chips.text()).toContain('description');
    expect(chips.text()).toContain('短评');

    await chips.get('[data-content-kind="短评"]').trigger('click');
    const form = wrapper.get('[data-testid="create-content-form"]');
    expect((form.get('[name="contentType"]').element as HTMLInputElement).value).toBe('短评');

    // An empty Content row is a slot, not content: it would render as a blank line on the work, so
    // the form asks for text instead of writing one.
    await form.trigger('submit');
    await flushPromises();
    expect(createContent).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain('empty row');

    await form.get('[name="content"]').setValue('好看');
    await form.trigger('submit');
    await flushPromises();
    expect(createContent).toHaveBeenCalledWith(1, expect.objectContaining({
      contentType: '短评',
      content: '好看',
    }));
  });

  it('does not show a Content row with no text until the Entry is being edited', async () => {
    const api = createMemoryApi();
    const baseGetEntry = api.getEntry;
    api.getEntry = vi.fn(async (entryId: number) => {
      const detail = await baseGetEntry(entryId);
      // Entry 1: a filled row plus a built-in kind a crawl left empty; entry 2: only the empty kind.
      if (entryId === 1) {
        return {
          ...detail,
          contents: [...detail.contents, {
            id: 98, contentType: 'description', content: '   ', sortOrder: 6,
          }],
        };
      }
      if (entryId === 2) {
        return {
          ...detail,
          contents: [{ id: 97, contentType: 'description', content: '', sortOrder: 0 }],
        };
      }
      return detail;
    });
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    // Home lists only recently viewed works, and entry 2 was never opened: use the Gallery grid.
    await openGalleryType(wrapper);

    // A work whose only Content is empty shows no Content section at all, rather than an empty box.
    await wrapper.get('[data-entry-id="2"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('.content-section').exists()).toBe(false);
    await wrapper.get('[data-testid="floating-back"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();
    // Reading: a kind with nothing in it is not shown at all — that is the rule for the built-in
    // kinds, and it is why nothing writes an empty row for a work that has nothing to say.
    expect(wrapper.find('[data-content-id="13"]').exists()).toBe(true);
    expect(wrapper.find('[data-content-id="98"]').exists()).toBe(false);

    await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');
    await flushPromises();
    // Editing: the row is there, so it can be filled or removed.
    expect(wrapper.get('[data-content-id="98"]').text()).toContain('description');
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
    // Editing shows every named Facet, so the empty one is on screen already;
    // the point is that typing its name again does not create a duplicate.
    expect(wrapper.get('[data-facet-id="16"]').text()).toContain('Series');

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
    // A device with a pointer drags; the tap wording belongs to a touch screen (next test).
    expect(wrapper.get('[data-testid="tag-move-hint"]').text()).toContain('Drag a Tag');
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

    // Edit mode shows the three vertical actions: done, save template, delete.
    for (const testId of [
      'finish-entry-editing',
      'save-template-button',
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
    // default — editing shows it without any toggle.
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

  it('keeps the filter bar and its chips after opening an Entry and coming back', async () => {
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    await openGameGallery(wrapper);
    await pickFacet(wrapper, 'Genre');
    await pickTag(wrapper, 'Sci-fi');
    expect(wrapper.get('[data-testid="entry-list"]').text()).not.toContain('Hades II');

    expect(wrapper.get('[data-testid="filter-tag-chip"]').text()).toContain('Sci-fi');
    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="entry-detail"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="facet-filter-bar"]').exists()).toBe(false);

    await wrapper.get('[data-testid="top-bar-back"]').trigger('click');
    await flushPromises();

    // Back on the filtered Gallery: the bar, the chip and the filtered result
    // all have to survive so the filter can still be adjusted.
    expect(wrapper.find('[data-testid="facet-filter-bar"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="filter-tag-chip"]').text()).toContain('Sci-fi');
    expect(wrapper.get('[data-testid="entry-list"]').text()).toContain('Endfield');
    expect(wrapper.get('[data-testid="entry-list"]').text()).not.toContain('Hades II');
  });

  it('builds the filter row when an Entry gains its first tag and is closed', async () => {
    const api = createMemoryApi();
    const readOptions = api.listFacetFilterOptions.bind(api);
    let reads = 0;
    api.listFacetFilterOptions = vi.fn<GalleryApi['listFacetFilterOptions']>(async (type) => {
      reads += 1;
      const options = await readOptions(type);
      // The sequence that showed the defect: the Gallery had nothing to filter by,
      // the Entry was opened and tagged, and coming back has to show the row that
      // now exists. Only the first read is empty, so a stale row stays invisible.
      return reads === 1 ? { ...options, facets: [], allTags: [] } : options;
    });

    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openGameGallery(wrapper);
    expect(wrapper.find('[data-testid="facet-filter-bar"]').exists()).toBe(false);

    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="entry-detail"]').exists()).toBe(true);
    await wrapper.get('[data-testid="top-bar-back"]').trigger('click');
    await flushPromises();

    expect(reads).toBe(2);
    expect(wrapper.find('[data-testid="facet-filter-bar"]').exists()).toBe(true);
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

  it('creates a manual entry without a rating, because the quick page no longer asks for one', async () => {
    // Ratings are a judgement made about a work once it exists — they are edited on the Entry, and
    // the quick page is kept to what a person can answer from the page in front of them. This pins
    // that shape: the form has no rating control, and creating an Entry sends none.
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
    expect(wrapper.find('[data-testid="manual-entry-ratings"]').exists()).toBe(false);
    // The date is back (a work's own date is part of it) and takes partial values, so its hint and
    // placeholder say which shapes it accepts.
    const dateField = wrapper.get('[data-testid="manual-entry-upload-date"]');
    expect(dateField.attributes('placeholder')).toBe('yyyy-mm-dd');
    expect(form.text()).toContain('yyyy-mm');

    await form.get('input[name="title"]').setValue('Rated New Work');
    await form.trigger('submit');
    await flushPromises();

    expect(setRating).not.toHaveBeenCalled();
  });

  it('retries failed manual media on the original Entry without creating another', async () => {
    const api = createMemoryApi();
    const create = vi.spyOn(api, 'createEntry');
    const upload = vi.spyOn(api, 'uploadEntryMedia');
    upload.mockRejectedValueOnce(new Error('media unavailable'));
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const form = wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue('Retry media');
    await form.get('input[name="type"]').setValue('game');
    const file = new File(['image'], 'cover.png', { type: 'image/png' });
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:cover');
      static revokeObjectURL = vi.fn();
    });
    const input = form.get('[data-testid="entry-cover-dropzone"] input');
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] });
    await input.trigger('change');
    await form.trigger('submit');
    await flushPromises();
    expect(create).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    const entryId = upload.mock.calls[0]![0];
    expect(wrapper.get('[data-testid="retry-entry-media"]').text()).toContain(String(entryId));
    await wrapper.get('[data-testid="retry-entry-media"]').trigger('click');
    await flushPromises();
    expect(create).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1]).toEqual([entryId, 'cover', file]);
    expect(wrapper.find('[data-testid="retry-entry-media"]').exists()).toBe(false);
  });

  it('uses the old online create shape when the server does not advertise a claim', async () => {
    const api = createMemoryApi();
    const capabilities = await api.getSyncCapabilities();
    vi.spyOn(api, 'getSyncCapabilities').mockResolvedValue({ ...capabilities, sqliteSchemaVersion: 31,
      featureFlags: { readOnlySnapshot: true, offlineMutations: false } });
    const create = vi.spyOn(api, 'createEntry');
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const form = wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue('Legacy work');
    await form.get('input[name="type"]').setValue('game');
    await form.trigger('submit');
    await flushPromises();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('syncUid');
  });

  it('keeps a legacy uncertain-response create visible without creating an offline twin', async () => {
    const api = createMemoryApi();
    const capabilities = await api.getSyncCapabilities();
    vi.spyOn(api, 'getSyncCapabilities').mockResolvedValue({ ...capabilities, sqliteSchemaVersion: 31,
      featureFlags: { readOnlySnapshot: true, offlineMutations: false } });
    const create = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    api.createEntry = create;
    const enqueue = vi.fn();
    api.enqueueOfflineEntryCreate = enqueue;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const form = wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue('Ambiguous legacy work');
    await form.get('input[name="type"]').setValue('game');
    await form.trigger('submit');
    await flushPromises();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('syncUid');
    expect(enqueue).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="manual-entry-form"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Check the desktop library before creating again');
  });

  it('queues safely when the capability probe fails before any create request is sent', async () => {
    const api = createMemoryApi();
    vi.spyOn(api, 'getSyncCapabilities').mockRejectedValue(new TypeError('Failed to fetch'));
    const create = vi.spyOn(api, 'createEntry');
    const enqueue = vi.fn().mockResolvedValue({ localKey: 'local:22222222-2222-4222-8222-222222222222' });
    api.enqueueOfflineEntryCreate = enqueue;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const form = wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue('Probe-down work');
    await form.get('input[name="type"]').setValue('game');
    await form.trigger('submit');
    await flushPromises();
    expect(create).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[1]).toBeInstanceOf(TypeError);
  });

  it('queues the manual Entry when the initial create transport fails without running online follow-ups', async () => {
    const api = createMemoryApi();
    const onlineCreate = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    api.createEntry = onlineCreate;
    const enqueue = vi.fn().mockResolvedValue({
      localKey: 'local:22222222-2222-4222-8222-222222222222',
    });
    api.enqueueOfflineEntryCreate = enqueue;
    const upload = vi.spyOn(api, 'uploadEntryMedia');
    const rating = vi.spyOn(api, 'setEntryRating');
    const viewLater = vi.spyOn(api, 'addViewLaterEntry');
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const form = wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue('Queued manual work');
    await form.get('input[name="type"]').setValue('game');
    await form.get('input[name="pageCount"]').setValue('24');
    await wrapper.get('[data-testid="manual-entry-view-later"] input').setValue(true);

    await form.trigger('submit');
    await flushPromises();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      title: 'Queued manual work',
      type: 'game',
      pageCount: 24,
      viewLater: true,
      coverFile: null,
      previewFile: null,
    });
    expect(enqueue.mock.calls[0]?.[1]).toBeInstanceOf(TypeError);
    expect(onlineCreate).toHaveBeenCalledTimes(1);
    expect(onlineCreate.mock.calls[0]?.[0]?.syncUid).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i);
    expect(enqueue.mock.calls[0]?.[0]?.syncUid).toBe(onlineCreate.mock.calls[0]?.[0]?.syncUid);
    expect(upload).not.toHaveBeenCalled();
    expect(rating).not.toHaveBeenCalled();
    expect(viewLater).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="manual-entry-form"]').exists()).toBe(false);
  });

  it('hands every chosen Preview to the offline queue without a partial-media warning', async () => {
    const api = createMemoryApi();
    const enqueue = vi.fn().mockResolvedValue({
      localKey: 'local:22222222-2222-4222-8222-222222222222',
    });
    api.enqueueOfflineEntryCreate = enqueue;
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:preview');
      static revokeObjectURL = vi.fn();
    });
    const wrapper = mount(GalleryApp, { props: { api, offlineState: {
      mode: 'offline', lastFallbackAt: null, pendingCount: 0,
      conflictCount: 0, failedCount: 0, lastReplayError: null,
    } } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const form = wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue('Multi preview draft');
    await form.get('input[name="type"]').setValue('game');
    const cover = new File(['cover'], 'cover.png', { type: 'image/png' });
    const first = new File(['first'], 'first.png', { type: 'image/png' });
    const second = new File(['second'], 'second.png', { type: 'image/png' });
    await form.get('[data-testid="entry-cover-dropzone"]').trigger('drop', {
      dataTransfer: { files: [cover, first, second] },
    });
    await flushPromises();
    await form.trigger('submit');
    await flushPromises();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0]).toMatchObject({ coverFile: cover,
      previewFiles: [first, second] });
    expect(wrapper.text()).not.toContain('Only the first Preview');
  });

  it('reuses the original online UID when a failed fallback enqueue is retried in offline mode', async () => {
    const api = createMemoryApi();
    const onlineCreate = vi.fn().mockRejectedValue(new TypeError('response lost'));
    api.createEntry = onlineCreate;
    const enqueue = vi.fn()
      .mockRejectedValueOnce(new Error('storage full'))
      .mockResolvedValueOnce({ localKey: 'local:22222222-2222-4222-8222-222222222222' });
    api.enqueueOfflineEntryCreate = enqueue;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const form = wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue('Interrupted local save');
    await form.get('input[name="type"]').setValue('game');
    await form.trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('storage full');
    expect(wrapper.find('[data-testid="manual-entry-form"]').exists()).toBe(true);
    const firstUid = onlineCreate.mock.calls[0]?.[0]?.syncUid;
    expect(firstUid).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i);
    expect(enqueue.mock.calls[0]?.[0]?.syncUid).toBe(firstUid);

    await wrapper.setProps({ offlineState: {
      mode: 'offline', lastFallbackAt: null, pendingCount: 0,
      conflictCount: 0, failedCount: 0, lastReplayError: null,
    } });
    await form.trigger('submit');
    await flushPromises();
    expect(onlineCreate).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[1]?.[0]?.syncUid).toBe(firstUid);
    expect(wrapper.find('[data-testid="manual-entry-form"]').exists()).toBe(false);
  });

  it('reuses the online UID on retry and refuses a legacy POST after an uncertain claimed create', async () => {
    const api = createMemoryApi();
    const capabilities = await api.getSyncCapabilities();
    const probe = vi.spyOn(api, 'getSyncCapabilities')
      .mockResolvedValueOnce(capabilities)
      .mockResolvedValueOnce({ ...capabilities,
        featureFlags: { readOnlySnapshot: true, offlineMutations: false },
      });
    const onlineCreate = vi.fn().mockRejectedValue(new TypeError('response lost'));
    api.createEntry = onlineCreate;
    const enqueue = vi.fn().mockRejectedValue(new Error('storage full'));
    api.enqueueOfflineEntryCreate = enqueue;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const form = wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue('Server changed');
    await form.get('input[name="type"]').setValue('game');
    await form.trigger('submit');
    await flushPromises();
    const firstUid = onlineCreate.mock.calls[0]?.[0]?.syncUid;
    expect(firstUid).toBeTruthy();
    await form.trigger('submit');
    await flushPromises();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(onlineCreate).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('Check the desktop library before creating again');
    expect(wrapper.find('[data-testid="manual-entry-form"]').exists()).toBe(true);
  });

  it('reuses the same UID on a second online POST if both the response and first fallback save failed', async () => {
    const api = createMemoryApi();
    const onlineCreate = vi.fn().mockRejectedValue(new TypeError('response lost'));
    api.createEntry = onlineCreate;
    const enqueue = vi.fn()
      .mockRejectedValueOnce(new Error('storage full'))
      .mockResolvedValueOnce({ localKey: 'local:22222222-2222-4222-8222-222222222222' });
    api.enqueueOfflineEntryCreate = enqueue;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const form = wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue('Retry unchanged');
    await form.get('input[name="type"]').setValue('game');
    await form.trigger('submit');
    await flushPromises();
    await form.trigger('submit');
    await flushPromises();
    expect(onlineCreate).toHaveBeenCalledTimes(2);
    const firstUid = onlineCreate.mock.calls[0]?.[0]?.syncUid;
    expect(firstUid).toBeTruthy();
    expect(onlineCreate.mock.calls[1]?.[0]?.syncUid).toBe(firstUid);
    expect(enqueue.mock.calls[1]?.[0]?.syncUid).toBe(firstUid);
  });

  it('queues a manual Entry immediately when snapshot mode is already active', async () => {
    const api = createMemoryApi();
    const createEntry = vi.spyOn(api, 'createEntry');
    const enqueue = vi.fn().mockResolvedValue({
      localKey: 'local:22222222-2222-4222-8222-222222222222',
    });
    api.enqueueOfflineEntryCreate = enqueue;
    const offlineState = {
      mode: 'offline' as const,
      lastFallbackAt: new Date().toISOString(),
      pendingCount: 0,
      conflictCount: 0,
      failedCount: 0,
      lastReplayError: null,
    };
    const wrapper = mount(GalleryApp, { props: { api, offlineState } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const form = wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue('Immediate offline work');
    await form.get('input[name="type"]').setValue('game');
    await form.get('[data-testid="manual-initial-content-type"]').setValue('Source URL');
    await form.get('[data-testid="manual-initial-content-text"]').setValue('https://example.test/new');

    await form.trigger('submit');
    await flushPromises();

    expect(createEntry).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      title: 'Immediate offline work',
      type: 'game',
      contents: [{ contentType: 'Source URL', content: 'https://example.test/new' }],
    });
    expect(enqueue.mock.calls[0]).toHaveLength(1);
    expect(wrapper.find('[data-testid="manual-entry-form"]').exists()).toBe(false);
  });

  it('queues the manual Source URL before initial Content without an unsaved-address warning', async () => {
    const api = createMemoryApi();
    const createEntry = vi.spyOn(api, 'createEntry');
    const createContent = vi.spyOn(api, 'createEntryContent');
    const enqueue = vi.fn().mockResolvedValue({ localKey: 'local:22222222-2222-4222-8222-222222222222' });
    api.enqueueOfflineEntryCreate = enqueue;
    const wrapper = mount(GalleryApp, { props: { api, offlineState: {
      mode: 'offline', lastFallbackAt: null, pendingCount: 0, conflictCount: 0,
      failedCount: 0, lastReplayError: null,
    } } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const form = wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue('Offline Source work');
    await form.get('input[name="type"]').setValue('game');
    await form.get('[data-testid="entry-source-url"]').setValue('https://example.test/read#page-2');
    await form.get('[data-testid="manual-initial-content-type"]').setValue('Notes');
    await form.get('[data-testid="manual-initial-content-text"]').setValue('Keep this note');
    await form.trigger('submit');
    await flushPromises();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0].contents).toEqual([
      { contentType: 'Source URL', content: 'https://example.test/read#page-2' },
      { contentType: 'Notes', content: 'Keep this note' },
    ]);
    expect(createEntry).not.toHaveBeenCalled();
    expect(createContent).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="manual-entry-form"]').exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('retains the Source URL draft when an offline Content-capability refusal rejects saving', async () => {
    const api = createMemoryApi();
    const createEntry = vi.spyOn(api, 'createEntry');
    const enqueue = vi.fn().mockRejectedValue(new Error('Offline initial Content requires a supporting server'));
    api.enqueueOfflineEntryCreate = enqueue;
    const wrapper = mount(GalleryApp, { props: { api, offlineState: {
      mode: 'offline', lastFallbackAt: null, pendingCount: 0, conflictCount: 0,
      failedCount: 0, lastReplayError: null,
    } } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const form = wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue('Keep Source draft');
    await form.get('input[name="type"]').setValue('game');
    await form.get('[data-testid="entry-source-url"]').setValue('https://example.test/keep');
    await form.trigger('submit');
    await flushPromises();
    expect(enqueue.mock.calls[0]?.[0].contents).toEqual([
      { contentType: 'Source URL', content: 'https://example.test/keep' },
    ]);
    expect(createEntry).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="entry-source-url"]').element).toHaveProperty('value', 'https://example.test/keep');
    expect(wrapper.get('[role="alert"]').text()).toContain('initial Content');
    wrapper.unmount();
  });

  it('preserves the Source URL when a claimed online create falls back after response loss', async () => {
    const api = createMemoryApi();
    const capabilities = await api.getSyncCapabilities();
    vi.spyOn(api, 'getSyncCapabilities').mockResolvedValue({ ...capabilities,
      featureFlags: { ...capabilities.featureFlags, onlineEntryCreateClaim: true } });
    const createEntry = vi.spyOn(api, 'createEntry').mockRejectedValue(new TypeError('response lost'));
    const createContent = vi.spyOn(api, 'createEntryContent');
    const enqueue = vi.fn().mockResolvedValue({ localKey: 'local:22222222-2222-4222-8222-222222222222' });
    api.enqueueOfflineEntryCreate = enqueue;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const form = wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue('Lost response Source');
    await form.get('input[name="type"]').setValue('game');
    await form.get('[data-testid="entry-source-url"]').setValue('https://example.test/lost');
    await form.trigger('submit');
    await flushPromises();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      syncUid: createEntry.mock.calls[0]?.[0].syncUid,
      contents: [{ contentType: 'Source URL', content: 'https://example.test/lost' }],
    });
    expect(createContent).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="manual-entry-form"]').exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('creates an Entry online through one atomic create command when the server advertises it', async () => {
    const api = createMemoryApi();
    const capabilities = await api.getSyncCapabilities();
    vi.spyOn(api, 'getSyncCapabilities').mockResolvedValue({ ...capabilities,
      featureFlags: { ...capabilities.featureFlags, onlineEntryCreateCommand: true } });
    const createEntry = vi.spyOn(api, 'createEntry');
    const createContent = vi.spyOn(api, 'createEntryContent');
    const setRating = vi.spyOn(api, 'setEntryRating');
    const replay = vi.fn().mockResolvedValue({
      opId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'applied', entityId: 1,
      resourceVersion: 2, serverSeq: 9,
    });
    api.replaySyncOperation = replay;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const form = wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue('Commanded work');
    await form.get('input[name="type"]').setValue('game');
    await form.get('[data-testid="entry-source-url"]').setValue('https://example.test/command');
    await form.trigger('submit');
    await flushPromises();
    expect(replay).toHaveBeenCalledTimes(1);
    const operation = replay.mock.calls[0]?.[0];
    expect(operation).toMatchObject({
      operationKind: 'entry.create', entityKind: 'entry', baseVersion: 0, baseValues: {},
      payload: {
        title: 'Commanded work', type: 'game', uploadDate: null, pageCount: null,
        ratings: [], viewLater: false,
        contents: [{ contentType: 'Source URL', content: 'https://example.test/command' }],
      },
    });
    expect(operation?.payload.contents?.[0]?.syncUid).toEqual(expect.any(String));
    expect(operation?.entityUid).toMatch(/^[0-9a-f-]{36}$/);
    expect(createEntry).not.toHaveBeenCalled();
    expect(createContent).not.toHaveBeenCalled();
    expect(setRating).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('falls back to the legacy create for a newly typed Gallery when the command receipt refuses it', async () => {
    const api = createMemoryApi();
    const capabilities = await api.getSyncCapabilities();
    vi.spyOn(api, 'getSyncCapabilities').mockResolvedValue({ ...capabilities,
      featureFlags: { ...capabilities.featureFlags, onlineEntryCreateCommand: true } });
    const createEntry = vi.spyOn(api, 'createEntry');
    const createContent = vi.spyOn(api, 'createEntryContent');
    const replay = vi.fn().mockResolvedValue({
      opId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'failed',
      errorCode: 'invalid-create', detail: 'Offline creation requires an existing Gallery',
    });
    api.replaySyncOperation = replay;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const form = wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue('Brand new gallery work');
    await form.get('input[name="type"]').setValue('G1');
    await form.get('[data-testid="entry-source-url"]').setValue('https://example.test/new-gallery');
    await form.trigger('submit');
    await flushPromises();
    // One failed receipt, then the legacy request shape; no second command.
    expect(replay).toHaveBeenCalledTimes(1);
    expect(createEntry).toHaveBeenCalledTimes(1);
    // The fallback reuses the attempt's identity, so the online claim and any
    // later offline fallback still converge on the same Entry.
    expect(createEntry.mock.calls[0]?.[0].syncUid).toBe(replay.mock.calls[0]?.[0].entityUid);
    expect(createEntry.mock.calls[0]?.[0].type).toBe('G1');
    expect(createContent).toHaveBeenCalledWith(expect.any(Number), {
      contentType: 'Source URL', content: 'https://example.test/new-gallery',
    });
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows a create failure beside the submit button, not only at the top of the page', async () => {
    const api = createMemoryApi();
    api.createEntry = vi.fn().mockRejectedValue(new Error('Gallery write refused'));
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const form = wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue('Doomed draft');
    await form.get('input[name="type"]').setValue('game');
    await form.trigger('submit');
    await flushPromises();
    expect(wrapper.get('[data-testid="entry-create-error"]').text()).toContain('Gallery write refused');
    expect(wrapper.find('[data-testid="manual-entry-form"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('shows an explicit pairing screen when the native shell is unpaired', async () => {
    const meta = Object.assign(document.createElement('meta'), { name: 't3-native-shell', content: 'android' });
    document.head.appendChild(meta);
    const calls: Array<[string, string]> = [];
    (window as unknown as { Capacitor: unknown }).Capacitor = {
      nativePromise: async (plugin: string, method: string) => {
        calls.push([plugin, method]);
        return method === 'status' ? { paired: false } : {};
      },
    };
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    expect(wrapper.get('[data-testid="pairing-gate"]').text()).toContain('Pair to your desktop library');
    await wrapper.get('[data-testid="pairing-gate-scan"]').trigger('click');
    expect(calls).toContainEqual(['T3PairedTransport', 'pair']);
    wrapper.unmount();
    meta.remove();
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  it('does not show the pairing screen once the shell is paired', async () => {
    const meta = Object.assign(document.createElement('meta'), { name: 't3-native-shell', content: 'android' });
    document.head.appendChild(meta);
    (window as unknown as { Capacitor: unknown }).Capacitor = {
      nativePromise: async () => ({ paired: true, libraryId: 'test' }),
    };
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();
    expect(wrapper.find('[data-testid="pairing-gate"]').exists()).toBe(false);
    wrapper.unmount();
    meta.remove();
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  it('queues the identical create command offline when the online command response is lost', async () => {
    const api = createMemoryApi();
    const capabilities = await api.getSyncCapabilities();
    vi.spyOn(api, 'getSyncCapabilities').mockResolvedValue({ ...capabilities,
      featureFlags: { ...capabilities.featureFlags, onlineEntryCreateCommand: true } });
    const createEntry = vi.spyOn(api, 'createEntry');
    api.replaySyncOperation = vi.fn().mockRejectedValue(new TypeError('response lost'));
    const enqueue = vi.fn().mockResolvedValue({ localKey: 'local:22222222-2222-4222-8222-222222222222' });
    api.enqueueOfflineEntryCreate = enqueue;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const form = wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue('Lost command');
    await form.get('input[name="type"]').setValue('game');
    await form.get('[data-testid="entry-source-url"]').setValue('https://example.test/lost-command');
    await form.trigger('submit');
    await flushPromises();
    expect(enqueue).toHaveBeenCalledTimes(1);
    const input = enqueue.mock.calls[0]?.[0];
    expect(input.presetCreateOperation).toMatchObject({
      operationKind: 'entry.create', baseVersion: 0,
      payload: {
        title: 'Lost command', type: 'game',
        contents: [{ contentType: 'Source URL', content: 'https://example.test/lost-command' }],
      },
    });
    // The queued create must replay under the attempt's own identity, or the
    // server receipt could not answer whether the command already committed.
    expect(input.syncUid).toBe(input.presetCreateOperation.entityUid);
    expect(createEntry).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="manual-entry-form"]').exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('retries an uncertain create command under the same identity on the next submit', async () => {
    const api = createMemoryApi();
    const capabilities = await api.getSyncCapabilities();
    vi.spyOn(api, 'getSyncCapabilities').mockResolvedValue({ ...capabilities,
      featureFlags: { ...capabilities.featureFlags, onlineEntryCreateCommand: true } });
    const replay = vi.fn()
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockResolvedValue({ opId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'applied', entityId: 1, resourceVersion: 2, serverSeq: 9 });
    api.replaySyncOperation = replay;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const form = wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue('Retried command');
    await form.get('input[name="type"]').setValue('game');
    await form.trigger('submit');
    await flushPromises();
    expect(replay).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    await wrapper.get('[data-testid="manual-entry-form"]').trigger('submit');
    await flushPromises();
    expect(replay).toHaveBeenCalledTimes(2);
    expect(replay.mock.calls[0]?.[0].opId).toBe(replay.mock.calls[1]?.[0].opId);
    expect(replay.mock.calls[0]?.[0].entityUid).toBe(replay.mock.calls[1]?.[0].entityUid);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('saves a manually entered initial Content row on the online creation path', async () => {
    const api = createMemoryApi();
    const createContent = vi.spyOn(api, 'createEntryContent');
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const form = wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue('Online initial notes');
    await form.get('input[name="type"]').setValue('game');
    await form.get('[data-testid="manual-initial-content-type"]').setValue('Source URL');
    await form.get('[data-testid="manual-initial-content-text"]').setValue('https://example.test/online');
    await form.trigger('submit');
    await flushPromises();
    expect(createContent).toHaveBeenCalledWith(expect.any(Number), {
      contentType: 'Source URL', content: 'https://example.test/online',
    });
  });

  it('does not leave a retryable create form after the server created an Entry but initial Content failed', async () => {
    const api = createMemoryApi();
    const createEntry = vi.spyOn(api, 'createEntry');
    api.createEntryContent = vi.fn().mockRejectedValue(new Error('Content upload failed'));
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    const form = wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue('Online partial work');
    await form.get('input[name="type"]').setValue('game');
    await form.get('[data-testid="manual-initial-content-type"]').setValue('Notes');
    await form.get('[data-testid="manual-initial-content-text"]').setValue('save me');
    await form.trigger('submit');
    await flushPromises();

    expect(createEntry).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="manual-entry-form"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Entry was created');
    expect(wrapper.text()).toContain('Content upload failed');
  });

  it.each([
    ['failed', 'Sync failed'], ['conflict', 'Sync conflict'],
  ] as const)('shows a blocked offline create as %s with its reason rather than pending sync', async (status, label) => {
    const api = createMemoryApi();
    api.listPendingOfflineEntryCreates = vi.fn().mockResolvedValue([{
      localKey: 'local:22222222-2222-4222-8222-222222222222', title: 'Blocked draft', type: 'game',
      uploadDate: null, pageCount: null, status, lastError: 'The saved creation needs review',
      canAppendContent: true,
    }]);
    api.enqueueOfflinePendingEntryContent = vi.fn();
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="sidebar-search"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="search-main-input"]').setValue('Blocked draft');
    await wrapper.get('[data-testid="search-main-form"]').trigger('submit');
    await flushPromises();
    const card = wrapper.get('[data-testid="search-pending-entry-local:22222222-2222-4222-8222-222222222222"]');
    expect(card.text()).toContain(label);
    expect(card.text()).toContain('The saved creation needs review');
    expect(card.text()).not.toContain('Pending sync');
    expect(card.find('[data-testid="pending-add-content"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows an offline-created Entry in global search without inventing a numeric id', async () => {
    const api = createMemoryApi();
    api.listPendingOfflineEntryCreates = vi.fn().mockResolvedValue([{
      localKey: 'local:22222222-2222-4222-8222-222222222222',
      title: 'test1',
      type: 'game',
      uploadDate: null,
      pageCount: null,
      status: 'pending',
      canAppendContent: false,
      contents: [{ contentType: 'Notes', content: 'saved offline note' }],
    }]);
    api.enqueueOfflinePendingEntryContent = vi.fn(async () => undefined);
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="sidebar-search"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="search-main-input"]').setValue('test1');
    await wrapper.get('[data-testid="search-main-form"]').trigger('submit');
    await flushPromises();

    const pending = wrapper.get('[data-testid="search-pending-entry-local:22222222-2222-4222-8222-222222222222"]');
    expect(pending.text()).toContain('test1');
    expect(pending.text()).toContain('Pending sync');
    expect(pending.text()).toContain('Notes: saved offline note');
    expect(pending.find('button').exists()).toBe(false);
  });

  it.each([
    ['pending', 'Pending sync'], ['failed', 'Sync failed'], ['conflict', 'Sync conflict'],
  ] as const)('shows the individual %s state of later Content on a pending Entry', async (status, label) => {
    const api = createMemoryApi();
    api.listPendingOfflineEntryCreates = vi.fn().mockResolvedValue([{
      localKey: 'local:22222222-2222-4222-8222-222222222222', title: 'Child state draft', type: 'game',
      uploadDate: null, pageCount: null, status: 'pending', canAppendContent: false,
      contents: [
        { contentType: 'Notes', content: 'initial' },
        { contentType: 'Notes', content: 'later', status, lastError: 'Later Content needs review' },
      ],
    }]);
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="sidebar-search"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="search-main-input"]').setValue('Child state draft');
    await wrapper.get('[data-testid="search-main-form"]').trigger('submit');
    await flushPromises();
    const card = wrapper.get('[data-testid="search-pending-entry-local:22222222-2222-4222-8222-222222222222"]');
    expect(card.get('[data-testid="pending-content-status"]').text()).toContain(label);
    expect(card.text()).toContain('Notes: initial');
    expect(card.text()).toContain('Notes: later');
    expect(card.find('[data-testid="pending-content-error"]').exists()).toBe(status !== 'pending');
    if (status !== 'pending') expect(card.get('[data-testid="pending-content-error"]').text()).toContain('Later Content needs review');
    wrapper.unmount();
  });

  it('adds, moves and removes cached Tags on a pending Entry through separate local-key writes', async () => {
    const api = createMemoryApi();
    const localKey = 'local:22222222-2222-4222-8222-222222222222' as const;
    let assigned: Array<{ name: string; facetId: number }> = [];
    api.listPendingOfflineEntryCreates = vi.fn(async () => [{
      localKey, title: 'Pending tag work', type: 'game', uploadDate: null, pageCount: null,
      status: 'pending' as const, canEditTags: true, tags: assigned.map((tag) => ({ ...tag })),
    }]);
    api.getPendingOfflineEntryTagOptions = vi.fn(async () => ({
      facets: [{ id: 1, name: 'Genre' }, { id: 2, name: 'Theme' }],
      tags: assigned.map((tag) => ({ ...tag })), availableTags: [{ id: 10, name: 'RPG' }],
    }));
    const enqueue = vi.fn(async (_key: string, desired: Array<{ name: string; facetId: number }>) => {
      assigned = desired.map((tag) => ({ ...tag }));
    });
    api.enqueueOfflinePendingEntryTags = enqueue;
    vi.spyOn(api, 'suggestTags').mockResolvedValue([
      { id: 10, name: 'RPG', sameContextUsageCount: 1, totalUsageCount: 1 },
      { id: 99, name: 'RPG new remote Tag', sameContextUsageCount: 1, totalUsageCount: 1 },
    ]);
    const createEntry = vi.spyOn(api, 'createEntry');
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="sidebar-search"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="search-main-input"]').setValue('Pending tag work');
    await wrapper.get('[data-testid="search-main-form"]').trigger('submit');
    await flushPromises();
    const card = () => wrapper.get(`[data-testid="search-pending-entry-${localKey}"]`);
    const edit = async () => {
      await card().get('[data-testid="pending-edit-tags"]').trigger('click');
      await flushPromises();
      return card().get('[data-testid="pending-tag-form"]');
    };
    let form = await edit();
    await form.get('input[name="pending-entry-tag"]').setValue('RP');
    await form.get('input[name="pending-entry-tag"]').trigger('focus');
    await vi.waitFor(() => expect(form.find('[role="option"]').exists()).toBe(true));
    expect(form.findAll('[role="option"]')).toHaveLength(1);
    expect(tagSuggestionQuerySchema.safeParse(vi.mocked(api.suggestTags).mock.calls[0]?.[0]).success).toBe(true);
    await form.get('[role="option"] button').trigger('click');
    await form.trigger('submit');
    await flushPromises();
    expect(enqueue).toHaveBeenNthCalledWith(1, localKey, [{ name: 'RPG', facetId: 1 }]);
    expect(card().text()).toContain('RPG');
    form = await edit();
    await form.get('[data-testid="pending-tag-row-facet"]').setValue('2');
    await form.trigger('submit');
    await flushPromises();
    expect(enqueue).toHaveBeenNthCalledWith(2, localKey, [{ name: 'RPG', facetId: 2 }]);
    form = await edit();
    await form.get('[data-testid="pending-tag-remove"]').trigger('click');
    await form.trigger('submit');
    await flushPromises();
    expect(enqueue).toHaveBeenNthCalledWith(3, localKey, []);
    expect(createEntry).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('releases the pending Tag write lock after its editor unmounts during a Search change', async () => {
    const api = createMemoryApi();
    const firstKey = 'local:22222222-2222-4222-8222-222222222222' as const;
    const secondKey = 'local:33333333-3333-4333-8333-333333333333' as const;
    api.listPendingOfflineEntryCreates = vi.fn().mockResolvedValue([
      { localKey: firstKey, title: 'First tag work', type: 'game', uploadDate: null, pageCount: null, status: 'pending', canEditTags: true },
      { localKey: secondKey, title: 'Second tag work', type: 'game', uploadDate: null, pageCount: null, status: 'pending', canEditTags: true },
    ]);
    api.getPendingOfflineEntryTagOptions = vi.fn(async (key) => ({
      facets: [{ id: 1, name: 'Genre' }, { id: 2, name: 'Theme' }],
      tags: key === firstKey ? [{ name: 'RPG', facetId: 1 }] : [], availableTags: [{ id: 10, name: 'RPG' }],
    }));
    let finish!: () => void;
    const writing = new Promise<void>((resolve) => { finish = resolve; });
    api.enqueueOfflinePendingEntryTags = vi.fn(() => writing);
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    const search = async (text: string) => {
      if (!wrapper.find('[data-testid="search-main-input"]').exists()) {
        await wrapper.get('[data-testid="sidebar-search"]').trigger('click');
        await flushPromises();
      }
      await wrapper.get('[data-testid="search-main-input"]').setValue(text);
      await wrapper.get('[data-testid="search-main-form"]').trigger('submit');
      await flushPromises();
    };
    await search('First tag work');
    await wrapper.get('[data-testid="pending-edit-tags"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="pending-tag-row-facet"]').setValue('2');
    await wrapper.get('[data-testid="pending-tag-form"]').trigger('submit');
    await flushPromises();
    await search('Second tag work');
    expect(wrapper.get('[data-testid="pending-edit-tags"]').attributes('disabled')).toBeDefined();
    finish();
    await flushPromises();
    expect(wrapper.get('[data-testid="pending-edit-tags"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-testid="pending-edit-tags"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="pending-tag-row-facet"]').exists()).toBe(false);
    expect(api.enqueueOfflinePendingEntryTags).toHaveBeenCalledTimes(1);
    expect(api.enqueueOfflinePendingEntryTags).toHaveBeenCalledWith(firstKey, [{ name: 'RPG', facetId: 2 }]);
    wrapper.unmount();
  });

  it('keeps a confirmed pending Tag save closed when the local card refresh fails', async () => {
    const api = createMemoryApi();
    const localKey = 'local:22222222-2222-4222-8222-222222222222' as const;
    const pending = { localKey, title: 'Saved tag work', type: 'game', uploadDate: null,
      pageCount: null, status: 'pending' as const, canEditTags: true, tags: [{ name: 'RPG', facetId: 1 }] };
    let assigned = pending.tags;
    api.listPendingOfflineEntryCreates = vi.fn().mockResolvedValueOnce([pending]).mockRejectedValue(new Error('projection read failed'));
    api.getPendingOfflineEntryTagOptions = vi.fn(async () => ({
      facets: [{ id: 1, name: 'Genre' }, { id: 2, name: 'Theme' }],
      tags: assigned.map((tag) => ({ ...tag })), availableTags: [{ id: 10, name: 'RPG' }],
    }));
    api.enqueueOfflinePendingEntryTags = vi.fn(async (_key: string, tags: Array<{ name: string; facetId: number }>) => { assigned = tags.map((tag) => ({ ...tag })); });
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="sidebar-search"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="search-main-input"]').setValue('Saved tag work');
    await wrapper.get('[data-testid="search-main-form"]').trigger('submit');
    await flushPromises();
    await wrapper.get('[data-testid="pending-edit-tags"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="pending-tag-row-facet"]').setValue('2');
    await wrapper.get('[data-testid="pending-tag-form"]').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-testid="pending-tag-form"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Tags saved offline');
    expect(api.enqueueOfflinePendingEntryTags).toHaveBeenCalledTimes(1);
    await wrapper.get('[data-testid="pending-edit-tags"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="pending-tag-row-facet"]').element).toHaveProperty('value', '2');
    await wrapper.get('[data-testid="pending-tag-form"]').trigger('submit');
    await flushPromises();
    expect(api.enqueueOfflinePendingEntryTags).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('lets a pending Entry append Content without re-submitting the original create', async () => {
    setLocale('en');
    const api = createMemoryApi();
    const localKey = 'local:22222222-2222-4222-8222-222222222222' as const;
    const contents = [{ contentType: 'Notes', content: 'initial' }];
    api.listPendingOfflineEntryCreates = vi.fn(async () => [{
      localKey, title: 'test1', type: 'game', uploadDate: null, pageCount: null,
      status: 'pending' as const, canAppendContent: true, contents: [...contents],
    }]);
    const append = vi.fn(async (_key: string, row: { contentType: string; content: string }) => {
      contents.push(row);
    });
    (api as GalleryApi & { enqueueOfflinePendingEntryContent: typeof append }).enqueueOfflinePendingEntryContent = append;
    const create = vi.spyOn(api, 'createEntry');
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="sidebar-search"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="search-main-input"]').setValue('test1');
    await wrapper.get('[data-testid="search-main-form"]').trigger('submit');
    await flushPromises();
    const pending = wrapper.get(`[data-testid="search-pending-entry-${localKey}"]`);
    await pending.get('[data-testid="pending-add-content"]').trigger('click');
    await pending.get('[data-testid="pending-content-type"]').setValue('Notes');
    await pending.get('[data-testid="pending-content-text"]').setValue('later appended');
    await pending.get('[data-testid="pending-content-submit"]').trigger('submit');
    await flushPromises();
    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith(localKey, { contentType: 'Notes', content: 'later appended' });
    expect(create).not.toHaveBeenCalled();
    expect(pending.text()).toContain('Notes: later appended');
  });

  it('does not carry a pending Content draft onto another local Entry', async () => {
    const api = createMemoryApi();
    api.listPendingOfflineEntryCreates = vi.fn(async () => [
      { localKey: 'local:22222222-2222-4222-8222-222222222222' as const, title: 'test1', type: 'game', uploadDate: null, pageCount: null, status: 'pending' as const, canAppendContent: true },
      { localKey: 'local:33333333-3333-4333-8333-333333333333' as const, title: 'test2', type: 'game', uploadDate: null, pageCount: null, status: 'pending' as const, canAppendContent: true },
    ]);
    const append = vi.fn(async () => undefined);
    (api as GalleryApi & { enqueueOfflinePendingEntryContent: typeof append }).enqueueOfflinePendingEntryContent = append;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="sidebar-search"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="search-main-input"]').setValue('test');
    await wrapper.get('[data-testid="search-main-form"]').trigger('submit');
    await flushPromises();
    const first = wrapper.get('[data-testid="search-pending-entry-local:22222222-2222-4222-8222-222222222222"]');
    const second = wrapper.get('[data-testid="search-pending-entry-local:33333333-3333-4333-8333-333333333333"]');
    await first.get('[data-testid="pending-add-content"]').trigger('click');
    await first.get('[data-testid="pending-content-type"]').setValue('Private note');
    await first.get('[data-testid="pending-content-text"]').setValue('belongs to first');
    await second.get('[data-testid="pending-add-content"]').trigger('click');
    expect(second.get('[data-testid="pending-content-type"]').element).toHaveProperty('value', '');
    expect(second.get('[data-testid="pending-content-text"]').element).toHaveProperty('value', '');
  });

  it('does not offer a second submit if a committed pending append cannot refresh its card', async () => {
    setLocale('en');
    const api = createMemoryApi();
    const localKey = 'local:22222222-2222-4222-8222-222222222222' as const;
    api.listPendingOfflineEntryCreates = vi.fn()
      .mockResolvedValueOnce([{ localKey, title: 'test1', type: 'game', uploadDate: null, pageCount: null, status: 'pending', canAppendContent: true }])
      .mockRejectedValueOnce(new Error('local read failed'));
    const append = vi.fn(async () => undefined);
    api.enqueueOfflinePendingEntryContent = append;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="sidebar-search"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="search-main-input"]').setValue('test1');
    await wrapper.get('[data-testid="search-main-form"]').trigger('submit');
    await flushPromises();
    const pending = wrapper.get(`[data-testid="search-pending-entry-${localKey}"]`);
    await pending.get('[data-testid="pending-add-content"]').trigger('click');
    await pending.get('[data-testid="pending-content-type"]').setValue('Notes');
    await pending.get('[data-testid="pending-content-text"]').setValue('saved');
    await pending.get('[data-testid="pending-content-submit"]').trigger('submit');
    await flushPromises();
    expect(append).toHaveBeenCalledOnce();
    expect(pending.find('[data-testid="pending-content-submit"]').exists()).toBe(false);
    expect(pending.get('[role="alert"]').text()).toContain('Content was saved');
  });

  it('keeps the composer open when Template ready is used without a server', async () => {
    setLocale('en');
    const api = createMemoryApi();
    api.createEntry = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const enqueue = vi.fn().mockResolvedValue({
      localKey: 'local:22222222-2222-4222-8222-222222222222',
    });
    api.enqueueOfflineEntryCreate = enqueue;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    await wrapper.get('[data-testid="manual-entry-form"] input[name="title"]').setValue('Template offline');

    await wrapper.get('[data-testid="create-with-template"]').trigger('click');
    await flushPromises();

    expect(enqueue).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="manual-entry-form"]').exists()).toBe(true);
    expect(wrapper.get('[role="alert"]').text()).toContain('Advanced functions require a connection');
    expect(wrapper.find('[data-testid="home-page"]').exists()).toBe(false);
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
      existingEntryIds: [],
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
    await openAddEntryFilesTab(wrapper);
    await openAddEntryFilesTab(wrapper);
    await wrapper.get('.batch-import-toggle .secondary-button').trigger('click');

    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
    const batchTypeInput = wrapper.get('.batch-import input[list="add-entry-gallery-types"]');
    await batchTypeInput.setValue('game');
    await batchTypeInput.trigger('change');
    await flushPromises();

    // Imports no longer rate works: the batch dialog has no rating block, and
    // choosing the folder reviews the Authors the batch will touch.
    expect(wrapper.find('[data-testid="batch-ratings"]').exists()).toBe(false);
    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
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

    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
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

  it('opens a Source URL immediately without waiting for usage tracking', async () => {
    const api = createMemoryApi();
    const baseGetEntry = api.getEntry;
    api.getEntry = vi.fn(async (entryId: number) => {
      const detail = await baseGetEntry(entryId);
      return entryId === 1 ? {
        ...detail,
        contents: [...detail.contents, {
          id: 99, contentType: 'Source URL', content: 'https://example.test/game', sortOrder: 5,
        }],
      } : detail;
    });
    let finishTracking: (() => void) | undefined;
    api.recordEntryView = vi.fn(() => new Promise<{
      viewCount: number;
      likeCount: number;
      lastViewedAt: string | null;
    }>((resolve) => {
      finishTracking = () => resolve({ viewCount: 1, likeCount: 0, lastViewedAt: new Date().toISOString() });
    }));
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();

    const click = wrapper.get('[data-source-url-content-id]').trigger('click');
    expect(openSpy).toHaveBeenCalledWith('https://example.test/game', '_blank', 'noopener,noreferrer');
    expect(api.recordEntryView).toHaveBeenCalledWith(1);

    finishTracking?.();
    await click;
    await flushPromises();
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
      galleryType: 'game',
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
      galleryType: 'game',
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
      existingEntryIds: [],
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
    await openAddEntryFilesTab(wrapper);
    await openAddEntryFilesTab(wrapper);

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
    await openAddEntryFilesTab(wrapper);
    await openAddEntryFilesTab(wrapper);
    await wrapper.get('.batch-import-toggle .secondary-button').trigger('click');

    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
    const batchTypeInput = wrapper.get('.batch-import input[list="add-entry-gallery-types"]');
    await batchTypeInput.setValue('game');
    await batchTypeInput.trigger('change');
    await flushPromises();

    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
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
      existingEntryIds: [],
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
    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
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
    await openAddEntryFilesTab(wrapper);
    await wrapper.get('.batch-import-toggle .secondary-button').trigger('click');
    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
    const secondTypeInput = wrapper.get('.batch-import input[list="add-entry-gallery-types"]');
    await secondTypeInput.setValue('game');
    await secondTypeInput.trigger('change');
    await flushPromises();
    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
    const secondBatchInput = wrapper.get('.batch-import input[webkitdirectory]');
    Object.defineProperty(secondBatchInput.element, 'files', { value: files });
    await secondBatchInput.trigger('change');
    await flushPromises();
    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
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
      existingEntryIds: [],
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
    await openAddEntryFilesTab(wrapper);
    await openAddEntryFilesTab(wrapper);
    await wrapper.get('.batch-import-toggle .secondary-button').trigger('click');
    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
    const typeInput = wrapper.get('.batch-import input[list="add-entry-gallery-types"]');
    await typeInput.setValue('game');
    await typeInput.trigger('change');
    await flushPromises();
    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
    const batchInput = wrapper.get('.batch-import input[webkitdirectory]');
    const file = new File(['{}'], 'metadata.json', { type: 'application/json' });
    Object.defineProperty(file, 'webkitRelativePath', {
      value: 'playlist_640641/items/100089/metadata.json',
    });
    Object.defineProperty(batchInput.element, 'files', { value: [file] });
    await batchInput.trigger('change');
    await flushPromises();
    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
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
      existingEntryIds: [],
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
    await openAddEntryFilesTab(wrapper);
    await openAddEntryFilesTab(wrapper);
      await wrapper.get('.batch-import-toggle .secondary-button').trigger('click');
      // The batch controls live on the files page; the review lives on its own.
      await openAddEntryFilesTab(wrapper);
      const typeInput = wrapper.get('.batch-import input[list="add-entry-gallery-types"]');
      await typeInput.setValue('game');
      await typeInput.trigger('change');
      await flushPromises();
      // The batch controls live on the files page; the review lives on its own.
      await openAddEntryFilesTab(wrapper);
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
      // The batch controls live on the files page; the review lives on its own.
      await openAddEntryFilesTab(wrapper);
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
    await openAddEntryFilesTab(wrapper);
    await openAddEntryFilesTab(wrapper);
    await wrapper.get('.batch-import-toggle .secondary-button').trigger('click');

    // Typing `GAME` is legitimate: the import resolves it to the stored `game`
    // Gallery case-insensitively, so the review must look at the same type.
    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
    const batchTypeInput = wrapper.get('.batch-import input[list="add-entry-gallery-types"]');
    await batchTypeInput.setValue('GAME');
    await batchTypeInput.trigger('change');
    await flushPromises();

    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
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
      existingEntryIds: [],
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

    // The batch controls live on the files page; the review lives on its own.
    await openAddEntryFilesTab(wrapper);
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
    await wrapper.get('[data-testid="sidebar-home"]').trigger('click');
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

  it('keeps Back and scroll-to-top floating on every view', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const wrapper = mount(GalleryApp, { props: { api: createMemoryApi() } });
    await flushPromises();

    // Home: present, with Back disabled exactly like the top-bar arrow.
    const fabs = wrapper.get('[data-testid="floating-back"]').element.parentElement!;
    expect([...fabs.children].map((child) => child.getAttribute('data-testid')))
      .toEqual(['floating-back', 'floating-scroll-top']);
    expect(wrapper.get('[data-testid="floating-back"]').attributes('disabled')).toBeDefined();

    await wrapper.get('[data-testid="floating-scroll-top"]').trigger('click');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, left: 0, behavior: 'smooth' });
    expect(wrapper.find('[data-testid="floating-back"]').exists()).toBe(true);

    // A Gallery page: Back is live and leads home, and the pair stays put.
    await wrapper.get('[data-gallery-type="game"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="floating-back"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-testid="floating-back"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="home-page"]').exists()).toBe(true);

    // Entry detail: same control, same action as the top-bar arrow.
    await wrapper.get('[data-gallery-type="game"]').trigger('click');
    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="floating-back"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="entry-detail"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="active-gallery-title"]').text()).toBe('game');
    expect(wrapper.find('[data-testid="floating-back"]').exists()).toBe(true);
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

  it('orders Galleries with the exchange control, and stores the whole list', async () => {
    // A Gallery is a projection of `entries.type`, so it had no order of its own: the sidebar listed
    // them by name and there was no way to move one — measured on a real library with seven galleries,
    // the two used every day sat wherever their spelling put them. The control is a *mode* (its button
    // keeps the applied look), and the arrows only exist while it is on.
    const api = createMemoryApi();
    const written: string[][] = [];
    api.setGalleryOrder = vi.fn(async (types: string[]) => { written.push(types); return types; });
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    expect(wrapper.find('[data-testid="gallery-move-up-game"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="sidebar-exchange"]').attributes('aria-pressed')).toBe('false');
    await wrapper.get('[data-testid="sidebar-exchange"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="sidebar-exchange"]').attributes('aria-pressed')).toBe('true');

    const types = wrapper.findAll('[data-gallery-type]').map((row) => row.attributes('data-gallery-type')!);
    expect(types.length).toBeGreaterThan(1);
    await wrapper.get(`[data-testid="gallery-move-up-${types[1]}"]`).trigger('click');
    await flushPromises();

    const expected = [types[1], types[0], ...types.slice(2)];
    // The list moved, and the *whole* order was written — a swap of two rows would leave every other
    // Gallery in the alphabet, which is an order nobody could predict from looking at it.
    expect(wrapper.findAll('[data-gallery-type]').map((row) => row.attributes('data-gallery-type')))
      .toEqual(expected);
    expect(written.at(-1)).toEqual(expected);

    // Turning the mode off takes the arrows away again and leaves the order alone.
    await wrapper.get('[data-testid="sidebar-exchange"]').trigger('click');
    await flushPromises();
    expect(wrapper.find(`[data-testid="gallery-move-up-${types[1]}"]`).exists()).toBe(false);
    expect(written).toHaveLength(1);
  });

  it('offline Exchange moves visible neighbours while preserving the hidden Gallery slot', async () => {
    const { createOfflineAwareGalleryApi } = await import('../src/offline/offline-api.js');
    const { createMemoryOutboxStore } = await import('../src/offline/outbox-store.js');
    const { offlineSnapshot } = await import('./fixtures/pending-entry-tags.js');
    const snapshot = offlineSnapshot();
    const original = snapshot.payload.entries[0]!;
    snapshot.payload.entries = [original, { ...original, id: 2, type: 'hidden', syncUid: '22222222-2222-4222-8222-222222222222' }, { ...original, id: 3, type: 'manga', syncUid: '33333333-3333-4333-8333-333333333333' }];
    snapshot.payload.gallerySettings = [{ entryType: 'hidden', nsfw: true }];
    snapshot.payload.galleryOrder = { syncUid: '00000000-0000-4000-8000-000000000037', syncVersion: 1, orderedTypes: ['game', 'hidden', 'manga'] };
    const store = { ...createMemorySnapshotStore(), ...createMemoryOutboxStore() };
    await store.writeGeneration(1, JSON.stringify(snapshot));
    await store.writeMeta('activeGeneration', '1');
    for (const flag of ['offlineMutations', 'offlineGalleryOrder']) await store.writeMeta(`capability.${flag}`, '1');
    const online = createMemoryApi();
    const write = vi.spyOn(online, 'setGalleryOrder');
    const api = createOfflineAwareGalleryApi(online, store, { clientId: 'gallery-ui' });
    await api.preferOfflineSnapshot!();
    showNsfw.value = false;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="sidebar-exchange"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="gallery-move-up-manga"]').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-gallery-type]').map(row => row.attributes('data-gallery-type'))).toEqual(['manga', 'game']);
    expect(write).not.toHaveBeenCalled();
    expect((await store.list())[0]!.payload).toEqual({ orderedTypes: ['manga', 'hidden', 'game'] });
    wrapper.unmount();
    const cold = createOfflineAwareGalleryApi(online, store, { clientId: 'gallery-ui' });
    await cold.preferOfflineSnapshot!();
    expect((await cold.listGalleries()).map(row => row.type)).toEqual(['manga', 'hidden', 'game']);
  });

  it('re-reads Home when the app comes back online, instead of keeping the snapshot it opened with', async () => {
    // A cold start deliberately opens the offline copy first, and Home's read can be answered from it —
    // including the *recent* list, which the copy holds as of its last sync. Measured on this symptom:
    // Home showed the same few works from days ago on every fresh open, and was right the moment the
    // page was left and entered again. The shell already re-reads its visible surfaces on a mode
    // change; Home was the one it did not know about.
    const api = createMemoryApi();
    // The real answer both times; only the title differs, so the assertion is about *when* the read
    // happened rather than about the shape of a hand-made fixture.
    const real = api.queryEntryPage.bind(api);
    let reads = 0;
    const query = vi.fn(async (input: Parameters<typeof real>[0]) => {
      const page = await real(input);
      reads += 1;
      return reads === 1
        ? page
        : { ...page, items: page.items.map((item) => ({ ...item, title: 'From the server' })) };
    });
    api.queryEntryPage = query as unknown as typeof api.queryEntryPage;

    const offlineState = (mode: 'offline' | 'online') => ({
      mode, lastFallbackAt: null, pendingCount: 0, conflictCount: 0, failedCount: 0,
      lastReplayError: null,
    });
    const wrapper = mount(GalleryApp, { props: { api, offlineState: offlineState('offline') } });
    await flushPromises();
    // Endfield is the fixture's only recently-viewed work — the answer the snapshot would give.
    expect(wrapper.get('[data-testid="home-recent"]').text()).toContain('Endfield');
    const readsBefore = query.mock.calls.length;

    // The capability probe succeeds without any Wi-Fi event.
    await wrapper.setProps({ offlineState: offlineState('online') });
    await flushPromises();

    expect(query.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(wrapper.get('[data-testid="home-recent"]').text()).toContain('From the server');
  });

  it('reports a failed import beside the button, not at the top of a 2600px page', async () => {
    // Measured on a phone: the review is about 2600px tall and the Import button is the last thing on
    // it. The failure used to render in the header, hundreds of pixels above the finger, so a commit
    // that refused looked exactly like a tap that did nothing — the person's report was "clicking
    // import does nothing". `role="alert"` alone does not help when the message is off-screen.
    const api = createMemoryApi();
    api.listLayout = vi.fn(async () => [{
      id: 10, name: 'Tags', sortOrder: 0, facets: [{ id: 11, name: '', sortOrder: 0 }],
    }]);
    api.previewSiteProbeFolder = vi.fn(async () => ({
      source: 'hitomi.la', entryCount: 1, tagAssignmentCount: 0, uniqueTagCount: 0,
      entriesMissingCover: 0, warnings: [],
      batch: {
        source: 'hitomi.la', warnings: [],
        entries: [{ externalKey: 'hitomi.la:42', title: 'A work', tags: [],
                    sources: [{ label: 'hitomi', url: 'https://hitomi.la/g/42.html' }] }],
      },
    })) as unknown as typeof api.previewSiteProbeFolder;
    api.commitImport = vi.fn(async () => { throw new Error('the commit was refused'); });

    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
    await openAddEntryFilesTab(wrapper);
    await openAddEntryFilesTab(wrapper);
    const file = new File(['{}'], 'metadata.json', { type: 'application/json' });
    Object.defineProperty(file, 'webkitRelativePath', { value: 'folder_42/items/42/metadata.json' });
    const input = wrapper.get('[data-testid="desktop-entry-import"] input[webkitdirectory]');
    Object.defineProperty(input.element, 'files', { value: [file] });
    await input.trigger('change');
    await flushPromises();
    await wrapper.get('[data-testid="import-review"] .primary-button').trigger('click');
    await flushPromises();

    const reported = wrapper.get('[data-testid="import-commit-error"]');
    expect(reported.text()).toContain('the commit was refused');
    // And it is the element right before the button, so it is on screen when the button is.
    expect(reported.element.nextElementSibling?.tagName).toBe('BUTTON');
    expect(reported.element.nextElementSibling?.textContent).toContain('Import');
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

  it('distinguishes an NSFW-filtered library from a genuinely empty library', async () => {
    showNsfw.value = false;
    const api = createMemoryApi();
    const listGalleries = api.listGalleries.bind(api);
    api.listGalleries = async () => (await listGalleries()).map((gallery) => ({ ...gallery, nsfw: true }));
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();

    expect(wrapper.find('[data-testid="home-empty"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="home-nsfw-hidden"]').text()).toContain('hidden by your NSFW setting');

    await wrapper.get('[data-testid="home-show-nsfw"]').trigger('click');
    await flushPromises();
    expect(showNsfw.value).toBe(true);
    expect(wrapper.find('[data-testid="home-nsfw-hidden"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-gallery-type]').length).toBeGreaterThan(0);
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

  it('does not show the previous Gallery entries when switching to a Gallery fails to load', async () => {
    const api = createMemoryApi();
    const query = api.queryEntryPage.bind(api);
    api.queryEntryPage = vi.fn(async (input) => {
      if (input.entryType === 'manga') throw new Error('Gallery unavailable');
      return query(input);
    });
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-gallery-type="game"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-entry-id="1"]').exists()).toBe(true);

    await wrapper.get('[data-gallery-type="manga"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Gallery unavailable');
    expect(wrapper.find('[data-testid="entry-list"] [data-entry-id]').exists()).toBe(false);
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

describe('Section controls', () => {
  // A Section is the heading above its Facets. Until now it could be created and never renamed or
  // removed — the one part of the information board with no controls — so these pin the two actions
  // and, just as important, that they stay out of the way when the Entry is not being edited.
  it('renames a Section in place from its heading', async () => {
    const api = createMemoryApi();
    const renameSection = vi.fn(async () => undefined);
    api.renameSection = renameSection;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-rename-section-button="10"]').trigger('click');
    const input = wrapper.get('[data-rename-section-id="10"]');
    await input.setValue('  Details  ');
    await input.trigger('keydown.enter');
    await flushPromises();

    // Trimmed on the way out, and the heading is back to being a heading afterwards.
    expect(renameSection).toHaveBeenCalledWith(10, 'Details');
    expect(wrapper.find('[data-rename-section-id="10"]').exists()).toBe(false);
  });

  it('deletes a Section only on the second click, the way a Facet does', async () => {
    const api = createMemoryApi();
    const deleteSection = vi.fn(async () => undefined);
    api.deleteSection = deleteSection;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-delete-section-button="10"]').trigger('click');
    expect(deleteSection).not.toHaveBeenCalled();
    expect(wrapper.get('[data-delete-section-button="10"]').text()).toBe('Confirm');

    await wrapper.get('[data-delete-section-button="10"]').trigger('click');
    await flushPromises();
    expect(deleteSection).toHaveBeenCalledWith(10);
  });

  it('names the Section that still has tags instead of repeating the server sentence', async () => {
    const api = createMemoryApi();
    api.deleteSection = vi.fn(async () => {
      throw new Error('cannot delete a section that contains assigned tags');
    });
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-delete-section-button="10"]').trigger('click');
    await wrapper.get('[data-delete-section-button="10"]').trigger('click');
    await flushPromises();

    const alert = wrapper.get('[role="alert"]');
    expect(alert.text()).toContain('Basics');
    expect(alert.text()).toContain('tags');
  });

  it('offers neither action while the Entry is only being read', async () => {
    const api = createMemoryApi();
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openGalleryType(wrapper, 'game');
    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="entry-information-board"]').exists()).toBe(true);
    expect(wrapper.find('[data-rename-section-button]').exists()).toBe(false);
    expect(wrapper.find('[data-delete-section-button]').exists()).toBe(false);
  });
});


describe('the work\u2019s date and page count', () => {
  /** The entry detail the board reads, with both values present and a basic Section to hold them. */
  async function apiWithStats(pageCount: number | null, uploadDate: string | null) {
    const api = createMemoryApi();
    const base = await api.getEntry(1);
    api.getEntry = vi.fn(async (entryId: number) => (entryId === 1
      ? {
        ...base,
        pageCount,
        uploadDate,
        sections: [{ id: 10, name: 'Basic Information', sortOrder: 0, facets: [] }],
      }
      : base));
    return api;
  }

  it('saves a page count typed over the value in place', async () => {
    const api = await apiWithStats(175, '2026-09-10');
    const update = vi.fn(async () => (await api.getEntry(1)));
    api.updateEntry = update;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    await wrapper.get('[data-testid="page-count-value"]').trigger('dblclick');
    const input = wrapper.get('[data-testid="page-count-input"]');
    await input.setValue('200');
    await input.trigger('keydown.enter');
    await flushPromises();
    expect(update).toHaveBeenCalledWith(1, { pageCount: 200 });
  });

  it('saves a date that is only a year, and refuses a shape it cannot store', async () => {
    const api = await apiWithStats(175, '2026-09-10');
    const update = vi.fn(async () => (await api.getEntry(1)));
    api.updateEntry = update;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    // A film's year is often all there is, so a prefix is a complete answer.
    await wrapper.get('[data-testid="upload-date-value"]').trigger('dblclick');
    const input = wrapper.get('[data-testid="upload-date-input"]');
    await input.setValue('2019');
    await input.trigger('keydown.enter');
    await flushPromises();
    expect(update).toHaveBeenCalledWith(1, { uploadDate: '2019' });

    // Anything else keeps the editor open and says what is accepted, rather than storing it.
    update.mockClear();
    await wrapper.get('[data-testid="upload-date-value"]').trigger('dblclick');
    const again = wrapper.get('[data-testid="upload-date-input"]');
    await again.setValue('19-2');
    await again.trigger('keydown.enter');
    await flushPromises();
    expect(update).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain('yyyy-mm-dd');
  });

  it('offers an empty page count and date to editing, says nothing to reading', async () => {
    const api = await apiWithStats(null, null);
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openGalleryType(wrapper, 'game');
    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();

    // Reading: nothing to say about a work with no values, so the row says nothing.
    expect(wrapper.find('[data-testid="add-page-count"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="add-upload-date"]').exists()).toBe(false);

    // Editing offers both, without any toggle: two chips, styled like "+ Tag".
    await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');
    await flushPromises();
    const pagesChip = wrapper.get('[data-testid="add-page-count"]');
    expect(pagesChip.text()).toContain('+');
    expect(pagesChip.classes()).toContain('add-button');
    expect(wrapper.get('[data-testid="add-upload-date"]').text()).toContain('+');

    // Typing into the chip it opens saves straight away.
    const update = vi.fn(async () => (await api.getEntry(1)));
    api.updateEntry = update;
    await pagesChip.trigger('click');
    const input = wrapper.get('[data-testid="page-count-input"]');
    await input.setValue('42');
    await input.trigger('keydown.enter');
    await flushPromises();
    expect(update).toHaveBeenCalledWith(1, { pageCount: 42 });
  });

  it('leaves the values alone on a double-click when the Entry is not being edited', async () => {
    const api = await apiWithStats(175, '2026-09-10');
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openGalleryType(wrapper, 'game');
    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="page-count-value"]').text()).toContain('175');
    await wrapper.get('[data-testid="page-count-value"]').trigger('dblclick');
    expect(wrapper.find('[data-testid="page-count-input"]').exists()).toBe(false);
  });
});


describe('hints and rows for the device in hand', () => {
  /** Pretend the browser has no hover, which is what a phone reports. */
  function withTouchScreen(): void {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(hover: none)',
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    touchScreenRestore = () => { window.matchMedia = original; };
  }
  let touchScreenRestore: (() => void) | null = null;

  afterEach(() => {
    if (touchScreenRestore) touchScreenRestore();
    touchScreenRestore = null;
  });

  it('tells a touch screen to tap, and a pointer to drag', async () => {
    withTouchScreen();
    const api = createMemoryApi();
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);
    expect(wrapper.get('[data-testid="tag-move-hint"]').text()).toContain('Tap a Tag');
  });

  it('puts the row at the right of the first Section, whatever that Section is called', async () => {
    // The reported inconsistency: a Section named "Basic Information" got the row while one named
    // "tag" did not, because the rule matched a name. The rule is a position now.
    const api = createMemoryApi();
    const base = await api.getEntry(1);
    api.getEntry = vi.fn(async (entryId: number) => (entryId === 1
      ? {
        ...base,
        pageCount: null,
        uploadDate: null,
        sections: [
          { id: 141, name: 'tag', sortOrder: 0, facets: [] },
          { id: 142, name: 'later', sortOrder: 1, facets: [] },
        ],
      }
      : base));
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openGalleryType(wrapper, 'game');
    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();

    // Reading: nothing to say about a work with no values…
    expect(wrapper.find('[data-testid="entry-stats-row"]').exists()).toBe(false);
    // …editing offers the row, without any toggle.
    await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');
    await flushPromises();
    const first = wrapper.get('[data-section-id="141"]');
    expect(first.find('[data-testid="add-page-count"]').exists()).toBe(true);
    expect(first.find('[data-testid="add-upload-date"]').exists()).toBe(true);
    // The second Section has none: one place, the first one.
    expect(wrapper.get('[data-section-id="142"]').find('[data-testid="entry-stats-row"]').exists())
      .toBe(false);
    expect(wrapper.findAll('[data-testid="entry-stats-row"]')).toHaveLength(1);
  });

  it('keeps that place even when the work has no Section at all', async () => {
    const api = createMemoryApi();
    const base = await api.getEntry(1);
    api.getEntry = vi.fn(async (entryId: number) => (entryId === 1
      ? { ...base, pageCount: 12, uploadDate: '2020', sections: [] }
      : base));
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    // No Sections to hang them on, so they are shown above the (empty) Section list — the same
    // position a first Section's header would have had.
    const row = wrapper.get('[data-testid="entry-stats-row"]');
    expect(row.find('[data-testid="page-count-value"]').text()).toContain('12');
    expect(row.find('[data-testid="upload-date-value"]').text()).toContain('2020');
  });

  it('keeps the values in the first Section header where they have always been', async () => {
    const api = createMemoryApi();
    const base = await api.getEntry(1);
    api.getEntry = vi.fn(async (entryId: number) => (entryId === 1
      ? {
        ...base,
        pageCount: 175,
        uploadDate: '2026-09-10',
        sections: [{ id: 10, name: 'Basic Information', sortOrder: 0, facets: [] }],
      }
      : base));
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openEntryForEditing(wrapper, 1);

    const section = wrapper.get('[data-section-id="10"]');
    expect(section.find('[data-testid="page-count-value"]').text()).toContain('175');
    expect(section.find('[data-testid="upload-date-value"]').text()).toContain('2026-09-10');
    // Not twice: the work-level row stays out of the way when a Section carries them.
    expect(wrapper.findAll('[data-testid="entry-stats-row"]')).toHaveLength(1);
  });
});


// Measured on the device: the tag was recorded in 230 ms, but the row only
// showed it after the whole Entry had been re-read over the network (1.2 s with
// a live server, up to the read timeout when the connection was bad) — the
// user's "sometimes it does not refresh and you have to wait".
it('shows a new tag from the write itself without waiting for the Entry re-read', async () => {
  const api = createMemoryApi();
  const wrapper = mount(GalleryApp, { props: { api } });
  await flushPromises();
  await openEntryForEditing(wrapper, 1);
  // The refresh that used to gate the row never settles.
  vi.spyOn(api, 'getEntry').mockImplementation(() => new Promise(() => {}));
  await wrapper.get('[data-add-tag-facet-id="11"]').trigger('click');
  wrapper.getComponent({ name: 'SuggestionInput' }).vm.$emit('submit-text', 'Instant Tag');
  await flushPromises();
  expect(wrapper.find('[data-create-tag-facet-id="11"]').exists()).toBe(false);
  const chip = wrapper.findAll('[data-remove-entry-tag-id]').map((node) => node.attributes('aria-label'));
  expect(chip.join(' ')).toContain('Instant Tag');
});

it('falls back to the Entry re-read when the write cannot name the tag', async () => {
  const api = createMemoryApi();
  const wrapper = mount(GalleryApp, { props: { api } });
  await flushPromises();
  await openEntryForEditing(wrapper, 1);
  // The write still records the tag; it just cannot name it back.
  const assign = api.assignEntryTag.bind(api);
  vi.spyOn(api, 'assignEntryTag').mockImplementation(async (entryId, input) => {
    await assign(entryId, input);
    return null;
  });
  await wrapper.get('[data-add-tag-facet-id="11"]').trigger('click');
  wrapper.getComponent({ name: 'SuggestionInput' }).vm.$emit('submit-text', 'Refetched Tag');
  await flushPromises();
  // The fixture serves the tag from the next read, so it lands there anyway.
  const chip = wrapper.findAll('[data-remove-entry-tag-id]').map((node) => node.attributes('aria-label'));
  expect(chip.join(' ')).toContain('Refetched Tag');
});

it('owns an awaited Tag creation lock above the Gallery editor and never re-enqueues on committed refresh failure', async () => {
  const api = createMemoryApi(); let finish!: () => void;
  const assign = vi.spyOn(api, 'assignEntryTag').mockImplementation(() => new Promise<null>(resolve => { finish = () => resolve(null); }));
  const wrapper = mount(GalleryApp, { props: { api } }); await flushPromises(); await openEntryForEditing(wrapper, 1);
  await wrapper.get('[data-add-tag-facet-id="11"]').trigger('click');
  const picker = wrapper.getComponent({ name: 'SuggestionInput' });
  picker.vm.$emit('submit-text', 'New Tag'); picker.vm.$emit('submit-text', 'New Tag'); await flushPromises();
  expect(assign).toHaveBeenCalledTimes(1);
  vi.spyOn(api, 'getEntry').mockRejectedValueOnce(new Error('projection refresh failed'));
  finish(); await flushPromises();
  expect(wrapper.find('[data-create-tag-facet-id="11"]').exists()).toBe(false);
  expect(wrapper.text()).toContain('Tags saved');
  expect(assign).toHaveBeenCalledTimes(1);
});

// Found on the phone: a work created from the composer did not appear in the
// Gallery it belonged to until the page was left and entered again — the card
// list stays mounted behind the detail and was never reloaded.
// The Settings panel downloads, clears or restores the offline copy while the
// rest of the app keeps its old lists on screen; it must ask for a re-read
// (found on the phone: the sidebar's per-Gallery count lagged behind the copy).
// The offline create returns early (nothing was sent to the server), and that
// early return skipped the refresh: the work only appeared after switching
// galleries. Found on the phone after the committed path was already fixed.
it('reloads the mounted Gallery list after an offline create too', async () => {
  const api = createMemoryApi();
  api.enqueueOfflineEntryCreate = vi.fn(async () => ({ localKey: 'local-1' }));
  const reads: string[] = [];
  const original = api.queryEntryPage.bind(api);
  api.queryEntryPage = vi.fn(async (input: Parameters<GalleryApi['queryEntryPage']>[0]) => {
    reads.push(input.entryType ?? '?');
    return original(input);
  }) as GalleryApi['queryEntryPage'];
  const wrapper = mount(GalleryApp, {
    props: { api, offlineState: { mode: 'offline', connectionPhase: null, lastFallbackAt: null } as never },
  });
  await flushPromises();
  await wrapper.get('[data-gallery-type="game"]').trigger('click');
  await flushPromises();
  const before = reads.length;
  await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
  const form = wrapper.get('[data-testid="manual-entry-form"]');
  await form.get('input[name="title"]').setValue('Queued offline work');
  await form.get('input[name="type"]').setValue('game');
  await form.trigger('submit');
  await flushPromises();
  expect(api.enqueueOfflineEntryCreate).toHaveBeenCalled();
  expect(reads.length).toBeGreaterThan(before);
});

it('re-reads the visible surfaces when the offline copy changes', async () => {
  const api = createMemoryApi();
  const wrapper = mount(GalleryApp, { props: { api } });
  await flushPromises();
  await wrapper.get('[data-testid="settings-button"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-testid="advanced-entry"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-testid="advanced-tab-offline"]').trigger('click');
  await flushPromises();
  const galleries = vi.spyOn(api, 'listGalleries');
  const offline = wrapper.findComponent({ name: 'OfflineLibrarySettings' });
  expect(offline.exists()).toBe(true);
  offline.vm.$emit('updated');
  await flushPromises();
  expect(galleries).toHaveBeenCalled();
});

it('reloads the mounted Gallery list after creating a work', async () => {
  const api = createMemoryApi();
  const reads: string[] = [];
  const original = api.queryEntryPage.bind(api);
  api.queryEntryPage = vi.fn(async (input: Parameters<GalleryApi['queryEntryPage']>[0]) => {
    reads.push(input.entryType ?? '?');
    return original(input);
  }) as GalleryApi['queryEntryPage'];
  const wrapper = mount(GalleryApp, { props: { api } });
  await flushPromises();
  await wrapper.get('[data-gallery-type="game"]').trigger('click');
  await flushPromises();
  const before = reads.length;
  await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');
  const form = wrapper.get('[data-testid="manual-entry-form"]');
  await form.get('input[name="title"]').setValue('Fresh Work');
  await form.get('input[name="type"]').setValue('game');
  await form.trigger('submit');
  await flushPromises();
  expect(reads.length).toBeGreaterThan(before);
});

// Seen on the phone: the action row sits in the top-right corner, and the
// stylesheet's phone rule anchored the menu's left edge to the trigger — half
// of it ended up past the right edge of the screen.
describe('the Add-to-collection menu is placed from its trigger', () => {
  async function openMenuWithTriggerAt(right: number) {
    const api = createMemoryApi();
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-entry-id="1"]').trigger('click');
    await flushPromises();
    const root = wrapper.get('[data-testid="entry-add-to-collection"]').element as HTMLElement;
    root.getBoundingClientRect = () => ({
      top: 100, bottom: 144, left: right - 44, right, width: 44, height: 44, x: right - 44, y: 100,
      toJSON: () => ({}),
    }) as DOMRect;
    Object.defineProperty(window, 'innerWidth', { value: 360, configurable: true, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 764, configurable: true, writable: true });
    await wrapper.get('[data-testid="entry-add-to-collection"] button').trigger('click');
    await flushPromises();
    return wrapper.get('.add-to-collection-menu');
  }

  it("anchors to the trigger's right edge when the trigger is near the right edge", async () => {
    const menu = await openMenuWithTriggerAt(340);
    expect(menu.attributes('style')).toContain('right: 0');
    // 340px of room to the left of the trigger, capped at the menu's own width.
    expect(menu.attributes('style')).toContain('max-width: 192px');
  });

  it("anchors to the trigger's left edge when the trigger is near the left edge", async () => {
    const menu = await openMenuWithTriggerAt(60);
    expect(menu.attributes('style')).toContain('left: 0');
    expect(menu.attributes('style')).toContain('max-width: 192px');
  });
});

// The user's report: on the phone the Settings sheet was a few pixels narrower
// than the page card behind it and shifted left, so a sliver of that card showed
// along the right edge. It repeats the card's box now, measured, so the width
// always matches whatever the layout does.
it("gives the phone Settings sheet the page card's own box", async () => {
  const api = createMemoryApi();
  const wrapper = mount(GalleryApp, { props: { api } });
  await flushPromises();
  const card = wrapper.get('.content-panel').element as HTMLElement;
  card.getBoundingClientRect = () => ({
    top: 96, bottom: 900, left: 12, right: 348, width: 336, height: 804, x: 12, y: 96,
    toJSON: () => ({}),
  }) as DOMRect;
  Object.defineProperty(window, 'innerWidth', { value: 360, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: 764, configurable: true, writable: true });
  await wrapper.get('[data-testid="settings-button"]').trigger('click');
  await flushPromises();
  const style = wrapper.get('[data-testid="settings-panel"]').attributes('style') ?? '';
  expect(style).toContain('left: 12px');
  expect(style).toContain('width: 336px');
  expect(style).toContain('top: 96px');
  expect(style).toContain('right: auto');
});

describe('Entry media strip, expand mode, and adding images', () => {
  /** The detail view the memory API returns; media state is what each test varies. */
  function withEntryMedia(api: GalleryApi, media: { coverRef: string | null; previewRefs: string[] }): void {
    const original = api.getEntry.bind(api);
    api.getEntry = (async (entryId: number) => ({
      ...await original(entryId),
      coverRef: media.coverRef,
      previewRef: media.previewRefs[0] ?? null,
      previewRefs: media.previewRefs,
    })) as GalleryApi['getEntry'];
  }
  async function openDetail(wrapper: VueWrapper, entryId: number): Promise<void> {
    if (!wrapper.find(`[data-entry-id="${entryId}"]`).exists()) {
      await wrapper.get('[data-testid="gallery-home"]').trigger('click');
      await flushPromises();
    }
    await wrapper.get(`[data-entry-id="${entryId}"]`).trigger('click');
    await flushPromises();
  }

  it('offers no expand control for a single image and keeps the pager out of the way', async () => {
    const api = createMemoryApi();
    withEntryMedia(api, { coverRef: '/api/assets/entries/1/cover.webp', previewRefs: [] });
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openDetail(wrapper, 1);
    expect(wrapper.find('[data-testid="media-expand"]').exists()).toBe(false);
    expect(wrapper.find('.media-count').exists()).toBe(false);
    wrapper.unmount();
  });

  it('expands every image into one strip with the collapse control inside the last one', async () => {
    const api = createMemoryApi();
    withEntryMedia(api, {
      coverRef: '/api/assets/entries/1/cover.webp',
      previewRefs: ['/api/assets/entries/1/preview.webp', '/api/assets/entries/1/preview-2.webp'],
    });
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openDetail(wrapper, 1);
    expect(wrapper.find('.media-count').text()).toContain('1 / 3');
    const expand = wrapper.get('[data-testid="media-expand"]');
    await expand.trigger('click');
    await flushPromises();
    const slides = wrapper.findAll('.entry-media-slide');
    expect(slides).toHaveLength(3);
    // The collapse control lives inside the last slide, not beside the strip.
    expect(slides[2]!.find('[data-testid="media-collapse"]').exists()).toBe(true);
    expect(slides[0]!.find('[data-testid="media-collapse"]').exists()).toBe(false);
    await wrapper.get('[data-testid="media-collapse"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('.entry-media-slide').exists()).toBe(false);
    expect(wrapper.find('.media-count').exists()).toBe(true);
    wrapper.unmount();
  });

  it('shows the add slot only while editing and only below four images', async () => {
    const api = createMemoryApi();
    withEntryMedia(api, {
      coverRef: '/api/assets/entries/1/cover.webp',
      previewRefs: ['/api/assets/entries/1/preview.webp'],
    });
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openDetail(wrapper, 1);
    expect(wrapper.find('[data-testid="media-add-slot"]').exists()).toBe(false);
    await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="media-add-slot"]').exists()).toBe(true);
    wrapper.unmount();

    const four = createMemoryApi();
    withEntryMedia(four, {
      coverRef: '/api/assets/entries/1/cover.webp',
      previewRefs: ['/a.webp', '/b.webp', '/c.webp'],
    });
    const capped = mount(GalleryApp, { props: { api: four } });
    await flushPromises();
    await openDetail(capped, 1);
    await capped.get('[data-testid="start-entry-editing"]').trigger('click');
    await flushPromises();
    expect(capped.find('[data-testid="media-add-slot"]').exists()).toBe(false);
    expect(capped.find('[data-testid="media-expand"]').exists()).toBe(true);
    capped.unmount();
  });

  it('wears an empty-cover placeholder and uploads the first image as the cover', async () => {
    const api = createMemoryApi();
    const uploadEntryMedia = vi.fn(async () => (await api.getEntry(1)));
    api.uploadEntryMedia = uploadEntryMedia as unknown as GalleryApi['uploadEntryMedia'];
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openDetail(wrapper, 1);
    await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');
    await flushPromises();
    const placeholder = wrapper.get('[data-testid="media-add-empty"]');
    await placeholder.trigger('click');
    const input = wrapper.get('[data-testid="media-add-file"]');
    const file = new File(['x'], 'cover.webp', { type: 'image/webp' });
    Object.defineProperty(input.element, 'files', { value: [file] });
    await input.trigger('change');
    await flushPromises();
    expect(uploadEntryMedia).toHaveBeenCalledTimes(1);
    expect(uploadEntryMedia.mock.calls[0]?.slice(0, 2)).toEqual([1, 'cover']);
    wrapper.unmount();
  });

  it('deletes and reorders by handing the whole list to one command', async () => {
    const api = createMemoryApi();
    withEntryMedia(api, {
      coverRef: '/api/assets/entries/1/cover.webp',
      previewRefs: ['/api/assets/entries/1/preview.webp', '/api/assets/entries/1/preview-2.webp'],
    });
    const setOrder = vi.fn(async () => (await api.getEntry(1)));
    api.setEntryMediaOrder = setOrder;
    const wrapper = mount(GalleryApp, { props: { api } });
    await flushPromises();
    await openDetail(wrapper, 1);
    await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');
    await flushPromises();
    // The controls appear only once the media editor is asked for.
    expect(wrapper.find('[data-testid="media-delete"]').exists()).toBe(false);
    await wrapper.get('[data-testid="media-edit-toggle"]').trigger('click');
    await flushPromises();
    const remove = wrapper.findAll('[data-testid="media-delete"]');
    expect(remove).toHaveLength(1);
    await remove[0]!.trigger('click');
    await flushPromises();
    expect(setOrder).toHaveBeenLastCalledWith(1, [
      '/api/assets/entries/1/preview.webp', '/api/assets/entries/1/preview-2.webp',
    ]);
    // Moving is the same command with two refs swapped, and only exists in the
    // strip, where the order is visible.
    setOrder.mockClear();
    await wrapper.get('[data-testid="media-expand"]').trigger('click');
    await flushPromises();
    await wrapper.findAll('[data-testid="media-move-next"]')[0]!.trigger('click');
    await flushPromises();
    expect(setOrder).toHaveBeenLastCalledWith(1, [
      '/api/assets/entries/1/preview.webp', '/api/assets/entries/1/cover.webp', '/api/assets/entries/1/preview-2.webp',
    ]);
    wrapper.unmount();
  });

  it('gives a phone the floating add control and no strip mode', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(hover: none)', media: query, onchange: null,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      addListener: () => undefined, removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      const api = createMemoryApi();
      withEntryMedia(api, {
        coverRef: '/api/assets/entries/1/cover.webp',
        previewRefs: ['/api/assets/entries/1/preview.webp'],
      });
      const wrapper = mount(GalleryApp, { props: { api } });
      await flushPromises();
      await openDetail(wrapper, 1);
      await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');
      await flushPromises();
      expect(wrapper.find('[data-testid="media-expand"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="media-add-slot"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="media-add-floating"]').exists()).toBe(true);
      // Delete rides with the floating add on a phone: no strip, so no move
      // arrows either.
      await wrapper.get('[data-testid="media-edit-toggle"]').trigger('click');
      await flushPromises();
      expect(wrapper.find('[data-testid="media-delete"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="media-move-next"]').exists()).toBe(false);
      wrapper.unmount();
    } finally {
      window.matchMedia = original;
    }
  });
});
