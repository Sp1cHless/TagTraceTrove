import { normalizeTag, rankRelationSuggestions } from '@t3/shared';
import type {
  AuthorDetailResponse,
  AuthorFilterOptions,
  CollectionKind,
  CollectionRecordDto,
  EntryDetailResponse,
  EntryPageQueryRequest,
  EntryPageResponse,
  EntryTagUsage,
  FacetFilterOptions,
  GallerySummary,
  ProducerPageQueryRequest,
  ProducerPageResponse,
  SyncSnapshot,
  TagSuggestionQuery,
  ProducerSuggestionQuery,
  RelationSuggestionDto,
  TagSearchHit,
  TaxonomyAliasDto,
  TaxonomyVocabulary,
  ViewLaterState,
} from '@t3/shared';
import type { GalleryAuthorSummary } from '../api/gallery.js';

const EMPTY_USAGE = { viewCount: 0, likeCount: 0, lastViewedAt: null } as const;
type SnapshotContentRow = SyncSnapshot['payload']['entryContents'][number];

function compareContentRows(left: SnapshotContentRow, right: SnapshotContentRow): number {
  const bySortOrder = left.sortOrder - right.sortOrder;
  if (bySortOrder !== 0) return bySortOrder;
  const leftLocal = left.id < 0;
  const rightLocal = right.id < 0;
  if (leftLocal !== rightLocal) return leftLocal ? 1 : -1;
  return leftLocal ? Math.abs(left.id) - Math.abs(right.id) : left.id - right.id;
}

export interface OfflineLibrary {
  listGalleries(): GallerySummary[];
  listAuthors(): GalleryAuthorSummary[];
  suggestProducers(input: ProducerSuggestionQuery): RelationSuggestionDto[];
  suggestTags(input: TagSuggestionQuery): RelationSuggestionDto[];
  queryProducerPage(input: ProducerPageQueryRequest): ProducerPageResponse;
  getAuthor(authorId: number): AuthorDetailResponse;
  listAuthorFilterOptions(entryType?: string, includeNsfw?: boolean): AuthorFilterOptions;
  searchTags(query: string, includeNsfw?: boolean): TagSearchHit[];
  listGalleryTags(entryType?: string): EntryTagUsage[];
  listTaxonomyAliases(vocabulary?: TaxonomyVocabulary): TaxonomyAliasDto[];
  queryEntryPage(input: EntryPageQueryRequest): EntryPageResponse;
  listFacetFilterOptions(entryType: string, authorId?: number): FacetFilterOptions;
  getEntry(entryId: number): EntryDetailResponse;
  getViewLaterState(): ViewLaterState;
  listCollections(kind: CollectionKind, includeNsfw?: boolean): CollectionRecordDto[];
  listCollectionsForEntry(entryId: number): number[];
  listCollectionsForProducer(producerId: number): number[];
}

export function createOfflineLibrary(snapshot: SyncSnapshot): OfflineLibrary {
  const { payload } = snapshot;
  const entriesById = new Map(payload.entries.map((entry) => [entry.id, entry]));
  const producersById = new Map(payload.producers.map((producer) => [producer.id, producer]));
  const tagsById = new Map(payload.tags.map((tag) => [tag.id, tag]));
  const usageByEntryId = new Map(payload.entryUsage.map((usage) => [usage.entryId, usage]));
  const galleryNsfw = new Map(payload.gallerySettings.map((setting) => [setting.entryType, setting.nsfw]));
  const producerEntryIds = new Map<number, number[]>();
  for (const link of payload.entryProducers) {
    const ids = producerEntryIds.get(link.producerId) ?? [];
    ids.push(link.entryId);
    producerEntryIds.set(link.producerId, ids);
  }
  const entryProducerIds = new Map<number, number[]>();
  for (const link of payload.entryProducers) {
    const ids = entryProducerIds.get(link.entryId) ?? [];
    ids.push(link.producerId);
    entryProducerIds.set(link.entryId, ids);
  }
  const entryTagRows = new Map<number, typeof payload.entryTags>();
  for (const assignment of payload.entryTags) {
    const rows = entryTagRows.get(assignment.entryId) ?? [];
    rows.push(assignment);
    entryTagRows.set(assignment.entryId, rows);
  }

  function usageOf(entryId: number) {
    return usageByEntryId.get(entryId) ?? EMPTY_USAGE;
  }

  function summaryOf(entry: (typeof payload.entries)[number]) {
    return {
      id: entry.id,
      title: entry.title,
      type: entry.type,
      coverRef: entry.coverRef,
      previewRef: entry.previewRef,
      previewRefs: entry.previewRefs,
      uploadDate: entry.uploadDate,
      pageCount: entry.pageCount,
      ...(entry.durationSeconds !== undefined ? { durationSeconds: entry.durationSeconds } : {}),
      ...usageOf(entry.id),
    };
  }

  function listGalleries(): GallerySummary[] {
    const counts = new Map<string, number>();
    for (const entry of payload.entries) counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
    return [...counts.entries()]
      .sort(([left], [right]) => {
        const order = payload.galleryOrder?.orderedTypes ?? [];
        const rank = (type: string) => { const index = order.indexOf(type); return index < 0 ? order.length : index; };
        return rank(left) - rank(right) || left.localeCompare(right);
      })
      .map(([type, entryCount]) => ({ type, entryCount, nsfw: galleryNsfw.get(type) ?? false }));
  }

  function summaryForProducer(
    producer: (typeof payload.producers)[number],
    includeNsfw = true,
  ): GalleryAuthorSummary | null {
    const entries = (producerEntryIds.get(producer.id) ?? [])
      .map((entryId) => entriesById.get(entryId))
      .filter((entry): entry is NonNullable<typeof entry> => (
        entry !== undefined && (includeNsfw || !(galleryNsfw.get(entry.type) ?? false))
      ));
    if (entries.length === 0) return null;
    const typeCounts = new Map<string, number>();
    let viewCount = 0;
    let likeCount = 0;
    let lastViewedAt: string | null = null;
    for (const entry of entries) {
      typeCounts.set(entry.type, (typeCounts.get(entry.type) ?? 0) + 1);
      const usage = usageOf(entry.id);
      viewCount += usage.viewCount;
      likeCount += usage.likeCount;
      if (usage.lastViewedAt !== null && (lastViewedAt === null || usage.lastViewedAt > lastViewedAt)) {
        lastViewedAt = usage.lastViewedAt;
      }
    }
    const galleryType = producer.galleryAnchor ?? [...typeCounts.entries()]
      .sort(([leftType, leftCount], [rightType, rightCount]) => (
        rightCount - leftCount || leftType.localeCompare(rightType)
      ))[0]?.[0] ?? null;
    return {
      id: producer.id,
      name: producer.name,
      covers: entries.map((entry) => entry.coverRef).filter((ref): ref is string => ref !== null).slice(0, 4),
      galleryType,
      viewCount,
      likeCount,
      lastViewedAt,
      nsfw: includeNsfw && entries.some((entry) => galleryNsfw.get(entry.type) ?? false),
    };
  }

  function listAuthors(): GalleryAuthorSummary[] {
    return payload.producers.flatMap((producer) => {
      const summary = summaryForProducer(producer);
      return summary === null ? [] : [summary];
    }).sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id);
  }

  function queryProducerPage(input: ProducerPageQueryRequest): ProducerPageResponse {
    const requireAuthorRatingSlot = (slotId: number) => {
      const slot = payload.ratingSlots.find(row => row.id === slotId && row.subjectKind === 'author_self');
      if (!slot) throw new Error(`cannot filter: rating slot ${slotId} is not an Author's own rating dimension`);
      return slot;
    };
    for (const condition of input.ratingConditions ?? []) requireAuthorRatingSlot(condition.slotId);
    if (input.ratingSort) requireAuthorRatingSlot(input.ratingSort.slotId);
    const authorStars = (producerId: number, galleryType: string | null, slotId: number) => {
      const slot = requireAuthorRatingSlot(slotId);
      if (slot.entryType !== galleryType) return null;
      return payload.producerRatingValues.find(row => row.producerId === producerId && row.slotId === slotId)?.stars ?? null;
    };
    const requestedIds = input.producerIds === undefined ? null : new Set(input.producerIds);
    const ownTagIds = new Set(input.ownTagIds);
    const workTagIds = new Set(input.relatedEntryTagIds);
    const query = input.searchQuery?.trim().toLocaleLowerCase();
    const collectionProducerIds = input.collectionId === undefined ? null : new Set(
      payload.collectionMembers.filter((row) => (
        row.collectionId === input.collectionId && 'producerId' in row
      )).map((row) => 'producerId' in row ? row.producerId : -1),
    );
    let authors = payload.producers.flatMap((producer) => {
      const summary = summaryForProducer(producer);
      if (summary === null || (!input.includeNsfw && summary.nsfw)) return [];
      if (requestedIds !== null && !requestedIds.has(producer.id)) return [];
      if (collectionProducerIds !== null && !collectionProducerIds.has(producer.id)) return [];
      const linkedEntries = (producerEntryIds.get(producer.id) ?? [])
        .map((entryId) => entriesById.get(entryId))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
      if (input.entryType !== undefined && summary.galleryType !== input.entryType) return [];
      const assignedTagIds = new Set(payload.producerTagAssignments
        .filter((row) => row.producerId === producer.id).map((row) => row.tagId));
      if ([...ownTagIds].some((tagId) => !assignedTagIds.has(tagId))) return [];
      if (workTagIds.size > 0 && !linkedEntries.some((entry) => {
        const tags = new Set((entryTagRows.get(entry.id) ?? []).map((row) => row.tagId));
        return [...workTagIds].every((tagId) => tags.has(tagId));
      })) return [];
      if (query !== undefined) {
        const aliases = (payload.taxonomyAliases ?? []).filter((row) => (
          row.vocabulary === 'producer'
          && row.normalizedCanonical === producer.name.trim().toLocaleLowerCase()
        ));
        if (!producer.name.toLocaleLowerCase().includes(query)
          && !aliases.some((row) => row.aliasName.toLocaleLowerCase().includes(query))) return [];
      }
      if (!(input.ratingConditions ?? []).every(condition => {
        const stars = authorStars(producer.id, summary.galleryType, condition.slotId);
        if (condition.operator === 'unrated') return stars === null;
        if (stars === null || condition.stars === null) return false;
        return condition.operator === 'eq' ? stars === condition.stars : condition.operator === 'gt' ? stars > condition.stars : stars < condition.stars;
      })) return [];
      return [summary];
    });
    const sourceOrder = new Map((input.producerIds ?? []).map((id, index) => [id, index]));
    authors = authors.sort((left, right) => {
      if (input.ratingSort) {
        const a = authorStars(left.id, left.galleryType, input.ratingSort.slotId);
        const b = authorStars(right.id, right.galleryType, input.ratingSort.slotId);
        if (a === null && b !== null) return 1;
        if (b === null && a !== null) return -1;
        if (a !== null && b !== null && a !== b) return b - a;
      }
      if (input.sort === 'source-order') return (sourceOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
        - (sourceOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER) || left.id - right.id;
      if (input.sort === 'last-viewed-desc') {
        if (left.lastViewedAt === null) return right.lastViewedAt === null ? left.id - right.id : 1;
        if (right.lastViewedAt === null) return -1;
        return right.lastViewedAt.localeCompare(left.lastViewedAt) || left.id - right.id;
      }
      if (input.sort === 'views-desc') return right.viewCount - left.viewCount || left.id - right.id;
      if (input.sort === 'likes-desc') return right.likeCount - left.likeCount || left.id - right.id;
      if (input.sort === 'random') {
        const seed = BigInt(input.randomSeed ?? 0);
        const rank = (id: number) => (BigInt(id) * 1103515245n + seed * 12345n) & 2147483647n;
        const leftRank = rank(left.id);
        const rightRank = rank(right.id);
        return leftRank < rightRank ? -1 : leftRank > rightRank ? 1 : left.id - right.id;
      }
      if (input.sort === 'relevance' && query !== undefined) {
        const rank = (name: string) => name.toLocaleLowerCase() === query ? 0
          : name.toLocaleLowerCase().startsWith(query) ? 1 : 2;
        return rank(left.name) - rank(right.name) || left.name.localeCompare(right.name) || left.id - right.id;
      }
      return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) || left.id - right.id;
    });
    const total = authors.length;
    const start = (input.page - 1) * input.pageSize;
    return { items: authors.slice(start, start + input.pageSize), total, page: input.page, pageSize: input.pageSize };
  }

  function getAuthor(authorId: number): AuthorDetailResponse {
    const producer = producersById.get(authorId);
    if (producer === undefined) throw new Error(`Offline Author ${authorId} was not found`);
    const summary = summaryForProducer(producer);
    const entryIds = producerEntryIds.get(authorId) ?? [];
    const workSummary = (entryId: number) => {
      const entry = entriesById.get(entryId);
      return entry === undefined ? null : {
        id: entry.id,
        title: entry.title,
        type: entry.type,
        coverRef: entry.coverRef,
        ...usageOf(entry.id),
      };
    };
    const directoryRows = payload.authorDirectories.filter((row) => row.producerId === authorId)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id);
    const directoryEntryIds = new Set(payload.authorDirectoryEntries
      .filter((row) => row.producerId === authorId).map((row) => row.entryId));
    const looseEntries = entryIds.filter((entryId) => !directoryEntryIds.has(entryId))
      .map(workSummary).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const galleryType = producer.galleryAnchor ?? summary?.galleryType ?? null;
    return {
      ...producer,
      galleryType,
      tags: payload.producerTagAssignments.filter((row) => row.producerId === authorId)
        .map((row) => payload.producerTags.find((tag) => tag.id === row.tagId))
        .filter((tag): tag is NonNullable<typeof tag> => tag !== undefined)
        .map((tag) => ({ tagId: tag.id, name: tag.name, normalizedName: tag.normalizedName })),
      looseEntries,
      looseEntryCount: looseEntries.length,
      directories: directoryRows.map((directory) => {
        const entries = payload.authorDirectoryEntries
          .filter((row) => row.directoryId === directory.id)
          .sort((left, right) => left.sortOrder - right.sortOrder || left.entryId - right.entryId)
          .map((row) => workSummary(row.entryId))
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
        return { ...directory, entries, entryCount: entries.length };
      }),
      workTypes: [...new Set(entryIds.map((entryId) => entriesById.get(entryId)?.type).filter((type): type is string => type !== undefined))],
      workCoverRefs: entryIds.map((entryId) => entriesById.get(entryId)?.coverRef)
        .filter((ref): ref is string => ref !== null && ref !== undefined).slice(0, 4),
      authorSelfRatings: galleryType === null ? [] : payload.ratingSlots
        .filter((slot) => slot.subjectKind === 'author_self' && slot.entryType === galleryType)
        .sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id)
        .map((slot) => ({ slotId: slot.id, name: slot.name,
          stars: payload.producerRatingValues.find((row) => row.slotId === slot.id && row.producerId === authorId)?.stars ?? null })),
      ratings: galleryType === null ? [] : payload.ratingSlots
        .filter((slot) => slot.subjectKind === 'producer' && slot.entryType === galleryType)
        .sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id)
        .map((slot) => ({
          slotId: slot.id,
          name: slot.name,
          stars: payload.producerRatingValues.find((row) => row.slotId === slot.id && row.producerId === authorId)?.stars ?? null,
        })),
      usage: summary === null ? { ...EMPTY_USAGE } : {
        viewCount: summary.viewCount,
        likeCount: summary.likeCount,
        lastViewedAt: summary.lastViewedAt,
      },
    };
  }

  function listAuthorFilterOptions(entryType?: string, includeNsfw = true): AuthorFilterOptions {
    const eligibleAuthors = listAuthors().filter((author) => (
      (includeNsfw || !author.nsfw)
      && (entryType === undefined || author.galleryType === entryType)
    ));
    const visibleProducerIds = new Set(eligibleAuthors.map((author) => author.id));
    const galleryTypes = new Set(eligibleAuthors.map((author) => author.galleryType));
    const visibleEntryIds = new Set(payload.entryProducers
      .filter((row) => visibleProducerIds.has(row.producerId)).map((row) => row.entryId));
    const ownTagIds = new Set(payload.producerTagAssignments
      .filter((row) => visibleProducerIds.has(row.producerId)).map((row) => row.tagId));
    const workTagIds = new Set(payload.entryTags
      .filter((row) => visibleEntryIds.has(row.entryId)).map((row) => row.tagId));
    return {
      authorTags: payload.producerTags.filter((tag) => ownTagIds.has(tag.id))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((tag) => ({ tagId: tag.id, name: tag.name })),
      workTags: payload.tags.filter((tag) => workTagIds.has(tag.id))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((tag) => ({ tagId: tag.id, name: tag.name })),
      // New unscored dimensions are useful too: `unrated` finds their Authors.
      ratingSlots: payload.ratingSlots.filter(slot => slot.subjectKind === 'author_self'
        && galleryTypes.has(slot.entryType))
        .sort((a,b) => a.entryType.localeCompare(b.entryType) || a.sortOrder-b.sortOrder || a.id-b.id)
        .map(slot => ({id:slot.id,name:slot.name,sortOrder:slot.sortOrder,entryType:slot.entryType})),
    };
  }

  function searchTags(query: string, includeNsfw = true): TagSearchHit[] {
    const normalized = query.trim().toLocaleLowerCase();
    return payload.tags.flatMap((tag) => {
      if (!tag.name.toLocaleLowerCase().includes(normalized)) return [];
      const entryCount = new Set(payload.entryTags.filter((row) => {
        const entry = entriesById.get(row.entryId);
        return row.tagId === tag.id && entry !== undefined
          && (includeNsfw || !(galleryNsfw.get(entry.type) ?? false));
      }).map((row) => row.entryId)).size;
      return entryCount === 0 ? [] : [{ tagId: tag.id, name: tag.name, normalizedName: tag.normalizedName, entryCount }];
    }).sort((left, right) => left.name.localeCompare(right.name) || left.tagId - right.tagId);
  }

  function listGalleryTags(entryType?: string): EntryTagUsage[] {
    return payload.tags.flatMap((tag) => {
      const entryCount = new Set(payload.entryTags.filter((row) => (
        row.tagId === tag.id && (entryType === undefined || entriesById.get(row.entryId)?.type === entryType)
      )).map((row) => row.entryId)).size;
      return entryCount === 0 ? [] : [{ id: tag.id, name: tag.name, normalizedName: tag.normalizedName, entryCount }];
    }).sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id);
  }

  function listTaxonomyAliases(vocabulary?: TaxonomyVocabulary): TaxonomyAliasDto[] {
    return (payload.taxonomyAliases ?? []).filter((row) => (
      vocabulary === undefined || row.vocabulary === vocabulary
    )).map(({ aliasName, ...row }) => ({ ...row, alias: aliasName }));
  }

  function effectiveRating(entryId: number, slotId: number): number | null {
    const slot = payload.ratingSlots.find(row => row.id === slotId);
    const entry = entriesById.get(entryId);
    if (!slot || !entry || slot.entryType !== entry.type) return null;
    if (slot.subjectKind !== 'author_self') {
      const ownSlot = slot.subjectKind === 'entry' ? slot : payload.ratingSlots.find(row => row.subjectKind === 'entry' && row.entryType === slot.entryType && row.name === slot.name);
      const direct = payload.entryRatingValues.find(row => row.entryId === entryId && row.slotId === ownSlot?.id)?.stars ?? null;
      if (direct !== null) return direct;
    }
    const authorIds = entryProducerIds.get(entryId) ?? [];
    if (authorIds.length >= 4) return null;
    const kind = slot.subjectKind === 'author_self' ? 'author_self' : 'producer';
    const authorSlot = payload.ratingSlots.find(row => row.subjectKind === kind && row.entryType === slot.entryType && row.name === slot.name);
    const values = payload.producerRatingValues.filter(row => row.slotId === authorSlot?.id && authorIds.includes(row.producerId)).flatMap(row => row.stars === null ? [] : [row.stars]);
    return values.length === 0 ? null : Math.max(...values);
  }

  function queryEntryPage(input: EntryPageQueryRequest): EntryPageResponse {
    const requestedIds = input.entryIds === undefined ? null : new Set(input.entryIds);
    const includedTags = new Set(input.includeTagIds ?? []);
    const excludedTypes = new Set(input.excludeEntryTypes ?? []);
    const authorIds = new Set(input.authorIds);
    const query = input.searchQuery?.trim().toLocaleLowerCase();
    let entries = payload.entries.filter((entry) => {
      if (input.entryType !== undefined && entry.type !== input.entryType) return false;
      if (requestedIds !== null && !requestedIds.has(entry.id)) return false;
      if (excludedTypes.has(entry.type)) return false;
      if (query !== undefined && !entry.title.toLocaleLowerCase().includes(query)) return false;
      if (input.includeNsfw === false && (galleryNsfw.get(entry.type) ?? false)) return false;
      if (input.recentOnly === true && usageOf(entry.id).lastViewedAt === null) return false;
      const tagRows = entryTagRows.get(entry.id) ?? [];
      const tagIds = new Set(tagRows.map((row) => row.tagId));
      if ([...includedTags].some((tagId) => !tagIds.has(tagId))) return false;
      if (!input.conditions.every((condition) => condition.tagIds.every((tagId) => (
        tagRows.some((row) => row.tagId === tagId && (condition.facetId === null || row.facetId === condition.facetId))
      )))) return false;
      if (authorIds.size > 0 && !(entryProducerIds.get(entry.id) ?? []).some((id) => authorIds.has(id))) return false;
      if (input.collectionId !== undefined && !payload.collectionMembers.some((row) => (
        row.collectionId === input.collectionId && 'entryId' in row && row.entryId === entry.id
      ))) return false;
      if (input.producerDirectoryId !== undefined && !payload.authorDirectoryEntries.some((row) => (
        row.directoryId === input.producerDirectoryId && row.entryId === entry.id
      ))) return false;
      if (input.looseForProducerId !== undefined) {
        if (!(entryProducerIds.get(entry.id) ?? []).includes(input.looseForProducerId)) return false;
        if (payload.authorDirectoryEntries.some((row) => (
          row.producerId === input.looseForProducerId && row.entryId === entry.id
        ))) return false;
      }
      if (!input.ratingConditions.every((condition) => {
        const stars = effectiveRating(entry.id, condition.slotId);
        if (condition.operator === 'unrated') return stars === null;
        if (stars === null || condition.stars === null) return false;
        if (condition.operator === 'eq') return stars === condition.stars;
        if (condition.operator === 'gt') return stars > condition.stars;
        return stars < condition.stars;
      })) return false;
      return input.usageConditions.every((condition) => {
        const usage = usageOf(entry.id);
        if (condition.field === 'lastViewed') {
          const value = usage.lastViewedAt?.slice(0, 10) ?? '';
          if (condition.operator === 'eq') return value === condition.value;
          if (condition.operator === 'gt') return value > condition.value;
          return value < condition.value;
        }
        const value = condition.field === 'views' ? usage.viewCount : usage.likeCount;
        if (condition.operator === 'eq') return value === condition.value;
        if (condition.operator === 'gt') return value > condition.value;
        return value < condition.value;
      });
    });

    const sourceOrder = new Map((input.entryIds ?? []).map((id, index) => [id, index]));
    entries = [...entries].sort((left, right) => {
      if (input.usageSort !== null) {
        const value = (entryId: number) => {
          const usage = usageOf(entryId);
          if (input.usageSort?.field === 'views') return usage.viewCount;
          if (input.usageSort?.field === 'likes') return usage.likeCount;
          return usage.lastViewedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(usage.lastViewedAt);
        };
        const direction = input.usageSort.direction === 'desc' ? -1 : 1;
        return direction * (value(left.id) - value(right.id)) || left.id - right.id;
      }
      if (input.ratingSort !== null) {
        const leftStars = effectiveRating(left.id, input.ratingSort.slotId);
        const rightStars = effectiveRating(right.id, input.ratingSort.slotId);
        if (leftStars === null) return rightStars === null ? left.title.localeCompare(right.title) || left.id - right.id : 1;
        if (rightStars === null) return -1;
        return rightStars - leftStars || left.title.localeCompare(right.title) || left.id - right.id;
      }
      if (input.sort === 'title-asc') return left.title.toLocaleLowerCase().localeCompare(right.title.toLocaleLowerCase()) || left.id - right.id;
      if (input.sort === 'title-desc') return right.title.toLocaleLowerCase().localeCompare(left.title.toLocaleLowerCase()) || left.id - right.id;
      if (input.sort === 'type') return left.type.toLocaleLowerCase().localeCompare(right.type.toLocaleLowerCase()) || left.title.toLocaleLowerCase().localeCompare(right.title.toLocaleLowerCase()) || left.id - right.id;
      if (input.sort === 'source-order') return sourceOrder.size === 0
        ? left.id - right.id
        : (sourceOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (sourceOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER) || left.id - right.id;
      if (input.sort === 'random') {
        const seed = BigInt(input.randomSeed ?? 0);
        const rank = (id: number) => (BigInt(id) * 1103515245n + seed * 12345n) & 2147483647n;
        const leftRank = rank(left.id);
        const rightRank = rank(right.id);
        return leftRank < rightRank ? -1 : leftRank > rightRank ? 1 : left.id - right.id;
      }
      const leftDate = left.uploadDate;
      const rightDate = right.uploadDate;
      if (leftDate === null) return rightDate === null ? left.id - right.id : input.sort === 'date-asc' ? -1 : 1;
      if (rightDate === null) return input.sort === 'date-asc' ? 1 : -1;
      return input.sort === 'date-asc'
        ? leftDate.localeCompare(rightDate) || left.id - right.id
        : rightDate.localeCompare(leftDate) || right.id - left.id;
    });
    const total = entries.length;
    const start = (input.page - 1) * input.pageSize;
    return { items: entries.slice(start, start + input.pageSize).map(summaryOf), total, page: input.page, pageSize: input.pageSize };
  }

  function listFacetFilterOptions(entryType: string, authorId?: number): FacetFilterOptions {
    const typeEntryIds = new Set(payload.entries.filter((entry) => (
      entry.type === entryType
      && (authorId === undefined || (entryProducerIds.get(entry.id) ?? []).includes(authorId))
    )).map((entry) => entry.id));
    const usedRows = payload.entryTags.filter((row) => typeEntryIds.has(row.entryId));
    const usedTagIds = new Set(usedRows.map((row) => row.tagId));
    const sections = payload.tagGroups.filter((group) => group.entryType === entryType && group.groupKind === 'section');
    const facets = payload.tagGroups
      .filter((group) => group.entryType === entryType && group.groupKind === 'facet')
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id)
      .map((facet) => ({
        facetId: facet.id,
        facetName: facet.name,
        sectionName: sections.find((section) => section.id === facet.parentId)?.name ?? facet.name,
        tags: [...new Set(usedRows.filter((row) => row.facetId === facet.id).map((row) => row.tagId))]
          .map((tagId) => tagsById.get(tagId))
          .filter((tag): tag is NonNullable<typeof tag> => tag !== undefined)
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((tag) => ({ tagId: tag.id, name: tag.name })),
      }));
    return {
      entryType,
      facets,
      allTags: payload.tags.filter((tag) => usedTagIds.has(tag.id))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((tag) => ({ tagId: tag.id, name: tag.name })),
      authors: payload.producers.filter((producer) => (
        (producerEntryIds.get(producer.id) ?? []).some((entryId) => typeEntryIds.has(entryId))
      )).sort((left, right) => left.name.localeCompare(right.name))
        .map((producer) => ({ authorId: producer.id, name: producer.name })),
      ratingSlots: payload.ratingSlots
        .filter((slot) => (slot.subjectKind === 'entry' || slot.subjectKind === 'author_self') && slot.entryType === entryType)
        .sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id)
        .map((slot) => ({ id: slot.id, name: slot.name, sortOrder: slot.sortOrder, subjectKind: slot.subjectKind })),
    };
  }

  function getEntry(entryId: number): EntryDetailResponse {
    const entry = entriesById.get(entryId);
    if (entry === undefined) throw new Error(`Offline Entry ${entryId} was not found`);
    const sections = payload.tagGroups
      .filter((group) => group.entryType === entry.type && group.groupKind === 'section')
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id)
      .map((section) => ({
        id: section.id,
        name: section.name,
        sortOrder: section.sortOrder,
        facets: payload.tagGroups
          .filter((group) => group.groupKind === 'facet' && group.parentId === section.id)
          .sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id)
          .map((facet) => ({
            id: facet.id,
            name: facet.name,
            sortOrder: facet.sortOrder,
            tags: (entryTagRows.get(entryId) ?? []).filter((row) => row.facetId === facet.id)
              .map((row) => tagsById.get(row.tagId))
              .filter((tag): tag is NonNullable<typeof tag> => tag !== undefined)
              .map((tag) => ({ id: tag.id, name: tag.name, normalizedName: tag.normalizedName })),
          })),
      }));
    return {
      id: entry.id,
      title: entry.title,
      type: entry.type,
      coverRef: entry.coverRef,
      previewRef: entry.previewRef,
      previewRefs: entry.previewRefs,
      uploadDate: entry.uploadDate,
      pageCount: entry.pageCount,
      ...(entry.durationSeconds !== undefined ? { durationSeconds: entry.durationSeconds } : {}),
      producers: (entryProducerIds.get(entryId) ?? []).map((producerId) => producersById.get(producerId))
        .filter((producer): producer is NonNullable<typeof producer> => producer !== undefined)
        .map((producer) => ({ ...producer, entryCount: producerEntryIds.get(producer.id)?.length ?? 0 })),
      sections,
      contents: payload.entryContents.filter((row) => row.entryId === entryId)
        .sort(compareContentRows)
        .map((content) => ({
          id: content.id,
          contentType: content.contentType,
          content: content.content,
          sortOrder: content.sortOrder,
        })),
      ratings: payload.ratingSlots.filter((slot) => slot.subjectKind === 'entry' && slot.entryType === entry.type)
        .sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id)
        .map((slot) => ({
          slotId: slot.id,
          name: slot.name,
          stars: payload.entryRatingValues.find((row) => row.slotId === slot.id && row.entryId === entryId)?.stars ?? null,
        })),
      usage: { ...usageOf(entryId) },
    };
  }

  function getViewLaterState(): ViewLaterState {
    return {
      entryIds: [...payload.viewLaterEntries].sort((left, right) => left.position - right.position).map((row) => row.subjectId),
      producerIds: [...payload.viewLaterProducers].sort((left, right) => left.position - right.position).map((row) => row.subjectId),
    };
  }

  function listCollections(kind: CollectionKind, includeNsfw = true): CollectionRecordDto[] {
    const authorSummaries = new Map(listAuthors().flatMap((author) => {
      if (includeNsfw) return [[author.id, author] as const];
      const visibleEntries = (producerEntryIds.get(author.id) ?? [])
        .map((entryId) => entriesById.get(entryId))
        .filter((entry): entry is NonNullable<typeof entry> => (
          entry !== undefined && !(galleryNsfw.get(entry.type) ?? false)
        ));
      if (visibleEntries.length === 0) return [];
      return [[author.id, {
        ...author,
        covers: visibleEntries.map((entry) => entry.coverRef)
          .filter((ref): ref is string => ref !== null)
          .slice(0, 4),
        nsfw: false,
      }] as const];
    }));
    const rows = payload.collections.filter((collection) => (
      collection.kind === kind && (includeNsfw || !collection.nsfw)
    ));
    const build = (collection: (typeof rows)[number]): CollectionRecordDto => {
      const members = payload.collectionMembers.filter((row) => row.collectionId === collection.id);
      const entries = members.flatMap((member) => {
        if (!('entryId' in member)) return [];
        const entry = entriesById.get(member.entryId);
        return entry === undefined || (!includeNsfw && (galleryNsfw.get(entry.type) ?? false)) ? [] : [{
          id: entry.id,
          title: entry.title,
          type: entry.type,
          coverRef: entry.coverRef,
          previewRefs: entry.previewRefs,
        }];
      });
      const producers = members.flatMap((member) => {
        if (!('producerId' in member)) return [];
        const author = authorSummaries.get(member.producerId);
        return author === undefined ? [] : [{ id: author.id, name: author.name, covers: author.covers }];
      });
      return {
        id: collection.id,
        kind: collection.kind,
        title: collection.title,
        description: collection.description,
        nsfw: collection.nsfw,
        sortOrder: collection.sortOrder,
        galleryType: collection.galleryType ?? null,
        children: rows.filter((candidate) => candidate.parentId === collection.id)
          .sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id)
          .map(build),
        entries,
        producers,
        entryCount: entries.length,
        producerCount: producers.length,
      };
    };
    return rows.filter((collection) => collection.parentId === null)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id)
      .map(build);
  }

  function relationAliases(vocabulary: 'entry' | 'producer', authorIdentity: boolean) {
    const byCanonical = new Map<string, string[]>();
    for (const row of payload.taxonomyAliases ?? []) {
      if (row.vocabulary !== vocabulary || row.normalizedCanonical === ''
        || (vocabulary === 'producer' && (row.partition === 'authors') !== authorIdentity)) continue;
      const aliases = byCanonical.get(row.normalizedCanonical) ?? [];
      aliases.push(row.aliasName);
      byCanonical.set(row.normalizedCanonical, aliases);
    }
    return byCanonical;
  }

  function suggestProducers(input: ProducerSuggestionQuery): RelationSuggestionDto[] {
    const aliases = relationAliases('producer', true);
    const excluded = new Set(input.excludeIds);
    return rankRelationSuggestions(payload.producers
      .filter((producer) => !excluded.has(producer.id))
      .map((producer) => ({
        id: producer.id,
        name: producer.name,
        aliases: aliases.get(normalizeTag(producer.name)) ?? [],
        sameContextUsageCount: 0,
        totalUsageCount: new Set(producerEntryIds.get(producer.id) ?? []).size,
      })), input.q, input.limit);
  }

  function suggestTags(input: TagSuggestionQuery): RelationSuggestionDto[] {
    const entryVocabulary = input.vocabulary === 'entry';
    const aliases = relationAliases(input.vocabulary, false);
    const excluded = new Set(input.excludeIds);
    const tagRows = entryVocabulary ? payload.tags : payload.producerTags;
    return rankRelationSuggestions(tagRows.flatMap((tag) => {
      if (excluded.has(tag.id)) return [];
      const assignments = entryVocabulary
        ? payload.entryTags.filter((row) => row.tagId === tag.id)
        : payload.producerTagAssignments.filter((row) => row.tagId === tag.id);
      if (assignments.length === 0) return [];
      const visible = assignments.filter((row) => {
        if (input.includeNsfw !== 'false') return true;
        if (entryVocabulary && 'entryId' in row) {
          return !(galleryNsfw.get(entriesById.get(row.entryId)?.type ?? '') ?? false);
        }
        if (!entryVocabulary && 'producerId' in row) {
          return !(producerEntryIds.get(row.producerId) ?? []).some((entryId) => (
            galleryNsfw.get(entriesById.get(entryId)?.type ?? '') ?? false
          ));
        }
        return false;
      });
      if (visible.length === 0 && input.includeNsfw === 'false') return [];
      const sameContextUsageCount = entryVocabulary
        ? new Set(payload.entryTags.filter((row) => row.tagId === tag.id
          && (input.facetId === undefined || row.facetId === input.facetId)
          && (input.entryType === undefined || entriesById.get(row.entryId)?.type === input.entryType))
          .map((row) => row.entryId)).size
        : input.entryType === undefined ? 0 : new Set(payload.producerTagAssignments
          .filter((row) => row.tagId === tag.id
            && (producerEntryIds.get(row.producerId) ?? []).some((entryId) => (
              entriesById.get(entryId)?.type === input.entryType
            )))
          .map((row) => row.producerId)).size;
      return [{
        id: tag.id,
        name: tag.name,
        aliases: aliases.get(tag.normalizedName) ?? [],
        sameContextUsageCount: entryVocabulary && input.facetId === undefined && input.entryType === undefined
          ? 0 : sameContextUsageCount,
        totalUsageCount: new Set(assignments.map((row) => (
          'entryId' in row ? row.entryId : row.producerId
        ))).size,
      }];
    }), input.q, input.limit);
  }

  function listCollectionsForEntry(entryId: number): number[] {
    return payload.collectionMembers
      .filter((row) => 'entryId' in row && row.entryId === entryId)
      .map((row) => row.collectionId);
  }

  function listCollectionsForProducer(producerId: number): number[] {
    return payload.collectionMembers
      .filter((row) => 'producerId' in row && row.producerId === producerId)
      .map((row) => row.collectionId);
  }

  return {
    listGalleries,
    listAuthors,
    queryProducerPage,
    getAuthor,
    listAuthorFilterOptions,
    suggestProducers,
    suggestTags,
    searchTags,
    listGalleryTags,
    listTaxonomyAliases,
    queryEntryPage,
    listFacetFilterOptions,
    getEntry,
    getViewLaterState,
    listCollections,
    listCollectionsForEntry,
    listCollectionsForProducer,
  };
}
