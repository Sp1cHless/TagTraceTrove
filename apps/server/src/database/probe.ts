import {
  createEntryContent,
  deleteEntryContent,
  reorderEntryContents,
  updateEntryContent,
} from '../repositories/entry-content-repository.js';
import {
  assignEntryTag,
  findEntriesByTags,
  listEntryTagsForType,
  moveEntryTag,
  queryEntryPage,
  renameEntryTag,
} from '../repositories/entry-tag-repository.js';
import {
  createEntry,
  getEntryDetail,
  listGalleries,
  updateEntry,
} from '../repositories/entry-repository.js';
import { mergeAuthorEntries } from '../repositories/entry-merge-repository.js';
import {
  convertEntryAuthorsToMultiAuthor,
  MULTI_AUTHOR_PRODUCER_NAME,
} from '../repositories/entry-multi-author-repository.js';
import { listEntrySources, listSourceLibrary } from '../repositories/source-library-repository.js';
import {
  createRun,
  getItem,
  getSourceStatus,
  getRun,
  patchItem,
  setSourceStatus,
  upsertItem,
} from '../source-maintenance/repository.js';
import { buildSyncCapabilities, buildSyncSnapshot, getSyncIdentity, rotateSyncEpoch } from '../sync/sync-service.js';
import { createFacet, createSection } from '../repositories/layout-repository.js';
import { assignProducerTag, findProducers } from '../repositories/producer-tag-repository.js';
import { suggestTags } from '../repositories/suggestion-repository.js';
import {
  createProducer,
  getAuthorDetail,
  linkEntryProducer,
  updateProducer,
} from '../repositories/producer-repository.js';
import {
  createAuthorDirectory,
  removeEntryFromAuthorDirectory,
} from '../repositories/author-directory-repository.js';
import { commitImportBatch } from '../import/commit.js';
import {
  createEntryRatingSlot,
  createProducerRatingSlot,
  createRatingSlot,
  findRatingSlotId,
  listEntryRatings,
  listProducerRatings,
  setEntryRating,
  setProducerRating,
} from '../repositories/rating-repository.js';
import {
  getEntryUsage,
  getProducerUsage,
  likeEntry,
  recordEntryView,
} from '../repositories/usage-repository.js';
import {
  authorHasNsfwWorks,
  listNsfwGalleryTypes,
  setGalleryPartition,
} from '../repositories/partition-repository.js';
import {
  addCollectionEntry,
  addCollectionProducer,
  createCollection,
  getCollection,
} from '../repositories/collection-repository.js';
import {
  addViewLaterEntry,
  addViewLaterProducer,
  listViewLaterEntryIds,
  listViewLaterProducerIds,
  removeViewLaterEntry,
  removeViewLaterProducer,
} from '../repositories/view-later-repository.js';
import { inspectDatabase } from './doctor.js';
import { createMigratedMemoryDatabase } from './testing.js';

export interface ProbeCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface DatabaseProbeResult {
  ok: boolean;
  checks: ProbeCheck[];
}

export function runDatabaseProbe(): DatabaseProbeResult {
  const database = createMigratedMemoryDatabase();
  const checks: ProbeCheck[] = [];
  let assignedTagId = 0;
  let targetFacetId = 0;

  const check = (name: string, operation: () => boolean): void => {
    try {
      const passed = operation();
      checks.push({ name, passed, ...(passed ? {} : { detail: 'assertion returned false' }) });
    } catch (error) {
      checks.push({
        name,
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  try {
    check('seed core scenario', () => {
      database.exec(`
        INSERT INTO entries (id, title, type) VALUES (1, 'Example Game', 'game');
        INSERT INTO producers (id, name, content) VALUES (1, 'Example Creator', 'Important creator note');
        INSERT INTO entry_producers (entry_id, producer_id) VALUES (1, 1);
        INSERT INTO producer_tags (id, name, normalized_name) VALUES (1, 'Favorite', 'favorite');
        INSERT INTO producer_tag_assignments (producer_id, tag_id) VALUES (1, 1);
        INSERT INTO entry_contents (entry_id, content_type, content) VALUES
          (1, 'short review', 'Good'),
          (1, 'source url', 'https://example.test/game');
      `);

      const basic = createSection(database, { entryType: 'game', name: 'Basic' });
      const review = createSection(database, {
        entryType: 'game',
        name: 'Review',
        sortOrder: 1,
      });
      const opinion = createFacet(database, { sectionId: review.id, name: 'Opinion' });
      const assignment = assignEntryTag(database, {
        entryId: 1,
        facetId: basic.defaultFacetId,
        name: 'Character',
      });
      assignedTagId = assignment.tagId;
      targetFacetId = opinion.id;
      return true;
    });

    check('move tag between facets', () => {
      moveEntryTag(database, {
        entryId: 1,
        tagId: assignedTagId,
        targetFacetId,
      });
      return database.prepare(
        'SELECT facet_id FROM entry_tags WHERE entry_id = 1 AND tag_id = 1',
      ).pluck().get() === targetFacetId;
    });

    check('compose complete entry detail', () => {
      const detail = getEntryDetail(database, 1);
      return detail?.sections.length === 2
        && detail.sections[0]?.facets[0]?.name === ''
        && detail.producers[0]?.name === 'Example Creator'
        && detail.contents.length === 2;
    });

    check('find producer through an entry tag', () => {
      const producer = database.prepare(`
        SELECT producer.name
        FROM producers AS producer
        JOIN entry_producers AS relation ON relation.producer_id = producer.id
        JOIN entry_tags AS assignment ON assignment.entry_id = relation.entry_id
        JOIN tags AS tag ON tag.id = assignment.tag_id
        WHERE tag.normalized_name = ?
      `).pluck().get('character');
      return producer === 'Example Creator';
    });

    check('keep tag vocabularies independent', () => {
      return database.prepare('SELECT COUNT(*) FROM tags').pluck().get() === 1
        && database.prepare('SELECT COUNT(*) FROM producer_tags').pluck().get() === 1;
    });

    check('bound strict relation suggestions by vocabulary', () => {
      const entrySuggestions = suggestTags(database, {
        vocabulary: 'entry', q: 'character', limit: 20, excludeIds: [], entryType: 'game',
      });
      const producerSuggestions = suggestTags(database, {
        vocabulary: 'producer', q: 'favorite', limit: 20, excludeIds: [],
      });
      return entrySuggestions.length === 1
        && entrySuggestions[0]?.id === assignedTagId
        && entrySuggestions[0]?.sameContextUsageCount === 1
        && producerSuggestions.length === 1
        && producerSuggestions[0]?.name === 'Favorite';
    });

    check('store arbitrary content labels', () => {
      return database.prepare(
        "SELECT COUNT(*) FROM entry_contents WHERE content_type IN ('short review', 'source url')",
      ).pluck().get() === 2;
    });

    check('write and search through repositories', () => {
      const entry = createEntry(database, { title: 'Second Work', type: 'game' });
      updateEntry(database, entry.id, { title: 'Updated Second Work' });
      const producer = createProducer(database, { name: 'Second Creator' });
      updateProducer(database, producer.id, { content: 'Creator note' });
      linkEntryProducer(database, entry.id, producer.id);
      const ownTag = assignProducerTag(database, {
        producerId: producer.id,
        name: 'Featured',
      });
      const relatedTag = assignEntryTag(database, {
        entryId: entry.id,
        facetId: targetFacetId,
        name: 'Related work tag',
      });
      assignEntryTag(database, {
        entryId: entry.id,
        facetId: targetFacetId,
        name: 'Character',
      });
      const firstContent = createEntryContent(database, {
        entryId: entry.id,
        contentType: 'short review',
        content: 'Initial',
      });
      const secondContent = createEntryContent(database, {
        entryId: entry.id,
        contentType: 'source url',
        content: 'https://example.test/second',
      });
      updateEntryContent(database, firstContent.id, { content: 'Updated' });
      reorderEntryContents(database, entry.id, [secondContent.id, firstContent.id]);
      deleteEntryContent(database, secondContent.id);

      const matches = findProducers(database, {
        ownTagIds: [ownTag.tagId],
        relatedEntryTagIds: [relatedTag.tagId],
      });
      const detail = getEntryDetail(database, entry.id);
      return matches.length === 1
        && matches[0]?.id === producer.id
        && detail?.title === 'Updated Second Work'
        && detail.producers[0]?.content === 'Creator note'
        && detail.contents.length === 1
        && detail.contents[0]?.content === 'Updated';
    });

    check('commit reviewed Import batch transactionally', () => {
      const result = commitImportBatch(database, {
        source: 'probe.example',
        warnings: [],
        entries: [{
          externalKey: 'probe.example:1',
          title: 'Imported Work',
          tags: [{ name: 'Imported' }],
          sources: [{ url: 'https://probe.example/1' }],
        }],
      }, {
        entryType: 'game',
        canonicalTagFacetId: targetFacetId,
        sourceContentType: 'source url',
        externalKeyContentType: 'external key',
        fieldMappings: {},
        ignoredFields: [],
        authorRatings: [],
      });
      const detail = getEntryDetail(database, result.entries[0]?.entryId ?? 0);
      return result.entryCount === 1
        && result.tagAssignmentCount === 1
        && result.contentCount === 1
        && detail?.title === 'Imported Work';
    });

    check('derive Galleries from Entry types', () => {
      const gallery = listGalleries(database).find((item) => item.type === 'game');
      return gallery?.entryCount === 3;
    });

    check('aggregate Entry tags for Gallery filtering', () => {
      const character = listEntryTagsForType(database, 'game')
        .find((item) => item.normalizedName === 'character');
      return character?.entryCount === 2;
    });

    check('find Entry Tag results across Gallery types', () => {
      const mangaSection = createSection(database, { entryType: 'manga', name: 'Basic' });
      const mangaEntry = createEntry(database, { title: 'Tagged Manga', type: 'manga' });
      assignEntryTag(database, {
        entryId: mangaEntry.id,
        facetId: mangaSection.defaultFacetId,
        name: 'Character',
      });
      const matches = findEntriesByTags(database, { includeTagIds: [assignedTagId] });
      return matches.some((entry) => entry.id === 1)
        && matches.some((entry) => entry.id === mangaEntry.id);
    });

    check('compose Author UI organization without grouping Entries', () => {
      const author = createProducer(database, { name: 'Directory Author' });
      const firstWork = createEntry(database, { title: 'Directory Work', type: 'game' });
      linkEntryProducer(database, firstWork.id, author.id);
      const directory = createAuthorDirectory(database, {
        producerId: author.id,
        title: 'New Directory',
        entryIds: [firstWork.id],
      });
      const groupedDetail = getAuthorDetail(database, author.id);
      removeEntryFromAuthorDirectory(database, {
        producerId: author.id,
        directoryId: directory.id,
        entryId: firstWork.id,
      });
      const ungroupedDetail = getAuthorDetail(database, author.id);
      return groupedDetail?.directories[0]?.id === directory.id
        && groupedDetail.directories[0]?.entries[0]?.id === firstWork.id
        && ungroupedDetail?.directories[0]?.entries.length === 0
        && ungroupedDetail.looseEntries[0]?.id === firstWork.id
        && database.prepare('SELECT type FROM entries WHERE id = ?').pluck().get(firstWork.id) === 'game';
    });

    check('rename one Entry Tag assignment without changing shared uses', () => {
      const renamed = renameEntryTag(database, {
        entryId: 1,
        tagId: assignedTagId,
        name: 'Playable Character',
      });
      const secondEntryStillUsesOriginal = database.prepare(`
        SELECT COUNT(*)
        FROM entry_tags AS assignment
        JOIN tags AS tag ON tag.id = assignment.tag_id
        WHERE assignment.entry_id = 2 AND tag.normalized_name = 'character'
      `).pluck().get() === 1;
      return renamed.normalizedName === 'playable character' && secondEntryStillUsesOriginal;
    });

    check('share rating slots per Gallery and keep unrated null', () => {
      // Entry side: one slot creation is immediately visible on every Entry
      // of the same type; a missing value is null, not zero.
      const entrySlot = createEntryRatingSlot(database, { entryId: 1, name: 'Quality' });
      const otherEntryRatings = listEntryRatings(database, 2);
      const beforeStars = otherEntryRatings.find((row) => row.slotId === entrySlot.id);
      setEntryRating(database, { entryId: 1, slotId: entrySlot.id, stars: 3.5 });
      setEntryRating(database, { entryId: 2, slotId: entrySlot.id, stars: null });
      const detail = getEntryDetail(database, 1);
      const detailRow = detail?.ratings.find((row) => row.slotId === entrySlot.id);
      const secondEntryDetail = getEntryDetail(database, 2);
      const secondRow = secondEntryDetail?.ratings.find((row) => row.slotId === entrySlot.id);
      return entrySlot.name === 'Quality'
        && beforeStars?.stars === null
        && detailRow?.stars === 3.5
        && secondRow?.stars === null
        && secondRow?.name === 'Quality';
    });

    check('apply author rating slots across same-dominant-Gallery authors', () => {
      // Author 1 (Example Creator) has one game work; the slot joins the
      // 'game' producer partition and appears for Author 2 (Second Creator,
      // also game) without any explicit apply step.
      const authorSlot = createProducerRatingSlot(database, { producerId: 1, name: 'Taste' });
      const firstRatings = listProducerRatings(database, 1);
      const secondRatings = listProducerRatings(database, 2);
      setProducerRating(database, { producerId: 1, slotId: authorSlot.id, stars: 4.5 });
      setProducerRating(database, { producerId: 2, slotId: authorSlot.id, stars: null });
      const firstDetail = getAuthorDetail(database, 1);
      const secondDetail = getAuthorDetail(database, 2);
      return firstRatings.some((row) => row.slotId === authorSlot.id)
        && secondRatings.some((row) => row.slotId === authorSlot.id)
        && firstDetail?.ratings.find((row) => row.slotId === authorSlot.id)?.stars === 4.5
        && secondDetail?.ratings.find((row) => row.slotId === authorSlot.id)?.stars === null;
    });

    check('sort by the Author rating when a work has fewer than four Authors', () => {
      const type = 'probe-author-rating';
      const entrySlot = createRatingSlot(database, { kind: 'entry', entryType: type, name: 'Quality' });
      const author = createProducer(database, { name: 'Probe Rated Author' });
      const ownRating = createEntry(database, { title: 'Probe own rating', type });
      const inherited = createEntry(database, { title: 'Probe inherited rating', type });
      const anthology = createEntry(database, { title: 'Probe anthology', type });
      linkEntryProducer(database, ownRating.id, author.id);
      linkEntryProducer(database, inherited.id, author.id);
      // The anthology shares the rated Author and three more: four Authors in
      // total, so it must never inherit an Author rating.
      linkEntryProducer(database, anthology.id, author.id);
      for (const name of ['Probe A', 'Probe B', 'Probe C']) {
        linkEntryProducer(database, anthology.id, createProducer(database, { name }).id);
      }
      const authorSlotId = createProducerRatingSlot(database, { producerId: author.id, name: entrySlot.name }).id;
      setProducerRating(database, { producerId: author.id, slotId: authorSlotId, stars: 4 });
      setEntryRating(database, { entryId: ownRating.id, slotId: entrySlot.id, stars: 2 });

      const sortedTitles = (applyAuthorRating: boolean): string[] => queryEntryPage(database, {
        entryType: type,
        conditions: [],
        authorIds: [],
        ratingConditions: [],
        ratingSort: { slotId: entrySlot.id, direction: 'desc', applyAuthorRating },
        usageConditions: [],
        usageSort: null,
        sort: 'title-asc',
        page: 1,
        pageSize: 10,
      }).items.map((entry) => entry.title);

      return sortedTitles(false).join('|') === 'Probe own rating|Probe anthology|Probe inherited rating'
        && sortedTitles(true).join('|') === 'Probe inherited rating|Probe own rating|Probe anthology'
        && findRatingSlotId(database, 'producer', type, entrySlot.name) === authorSlotId;
    });

    check('track entry views and derive author usage', () => {
      // Entry 1 starts unviewed; each recorded view bumps the count and the
      // timestamp. Author usage is derived from their works' rows.
      const before = getEntryUsage(database, 1);
      recordEntryView(database, 1);
      recordEntryView(database, 1);
      const after = getEntryUsage(database, 1);
      const authorUsage = getProducerUsage(database, 1);
      const idleUsage = getProducerUsage(database, 2);
      return before.viewCount === 0 && before.lastViewedAt === null
        && after.viewCount === 2
        && typeof after.lastViewedAt === 'string' && after.lastViewedAt.length > 0
        && authorUsage.viewCount === 2 && authorUsage.lastViewedAt === after.lastViewedAt
        && idleUsage.viewCount === 0 && idleUsage.lastViewedAt === null;
    });

    check('like entries without a cap and derive author likes', () => {
      // Likes are unlimited and re-clickable: every call adds one. The
      // author-side number is the sum of their works' counters.
      likeEntry(database, 1);
      likeEntry(database, 1);
      const usage = getEntryUsage(database, 1);
      const authorUsage = getProducerUsage(database, 1);
      return usage.likeCount === 2 && authorUsage.likeCount === 2;
    });

    check('partition whole galleries and derive the author partition', () => {
      // Only whole Galleries are partitioned; an Author with any work in an
      // NSFW Gallery is an NSFW Author, and flipping the Gallery flips them.
      setGalleryPartition(database, 'game', true);
      const nsfwTypes = listNsfwGalleryTypes(database);
      const authorNsfw = authorHasNsfwWorks(database, 1, nsfwTypes);
      setGalleryPartition(database, 'game', false);
      return nsfwTypes.has('game')
        && authorNsfw
        && !listNsfwGalleryTypes(database).has('game')
        && !authorHasNsfwWorks(database, 1, listNsfwGalleryTypes(database));
    });

    check('curate collections with members and one-level nesting', () => {
      const parent = createCollection(database, { kind: 'entry', title: 'Read list' });
      addCollectionEntry(database, parent.id, 1);
      const child = createCollection(database, {
        kind: 'entry',
        title: 'Series X',
        parentId: parent.id,
      });
      addCollectionEntry(database, child.id, 2);
      // Exactly one level: a child folder can never host another child.
      let rejected = false;
      try {
        createCollection(database, { kind: 'entry', title: 'Too deep', parentId: child.id });
      } catch {
        rejected = true;
      }
      const authorCollection = createCollection(database, { kind: 'producer', title: 'Favourite authors' });
      addCollectionProducer(database, authorCollection.id, 1);
      const reloaded = getCollection(database, parent.id);
      return rejected
        && reloaded?.entries.some((entry) => entry.id === 1) === true
        && reloaded?.children.some((nested) => nested.id === child.id
          && nested.entries.some((entry) => entry.id === 2)) === true
        && getCollection(database, authorCollection.id)?.producers[0]?.id === 1;
    });

    check('persist shared View later', () => {
      addViewLaterEntry(database, 1);
      addViewLaterEntry(database, 2);
      addViewLaterEntry(database, 1);
      addViewLaterProducer(database, 1);
      addViewLaterProducer(database, 1);
      removeViewLaterEntry(database, 1);
      removeViewLaterProducer(database, 1);
      return listViewLaterEntryIds(database).join(',') === '2'
        && listViewLaterProducerIds(database).length === 0;
    });

    check('query a bounded deterministic Entry page', () => {
      const page = queryEntryPage(database, {
        entryType: 'game',
        conditions: [],
        authorIds: [],
        ratingConditions: [],
        ratingSort: null,
        usageConditions: [],
        usageSort: null,
        sort: 'title-asc',
        page: 1,
        pageSize: 1,
      });
      return page.total >= 1
        && page.items.length === 1
        && page.page === 1
        && page.pageSize === 1
        && page.items[0]?.type === 'game';
    });

    check('derive Sources from manual Content and merge Author works atomically', () => {
      const section = createSection(database, { entryType: 'merge-probe', name: 'Tags' });
      const author = createProducer(database, { name: 'Merge Probe Author' });
      const keep = createEntry(database, { title: 'Kept Probe Work', type: 'merge-probe' });
      const absorb = createEntry(database, { title: 'Absorbed Probe Work', type: 'merge-probe' });
      linkEntryProducer(database, keep.id, author.id);
      linkEntryProducer(database, absorb.id, author.id);
      assignEntryTag(database, {
        entryId: absorb.id,
        facetId: section.defaultFacetId,
        name: 'Merged Probe Tag',
      });
      const manualContent = createEntryContent(database, {
        entryId: absorb.id,
        contentType: 'manual custom source field',
        content: 'Mirror: https://hitomi.la/reader/probe.html',
      });
      const selectedSource = listEntrySources(database, absorb.id)[0];
      if (!selectedSource || selectedSource.contentId !== manualContent.id) return false;
      mergeAuthorEntries(database, {
        authorId: author.id,
        keepEntryId: keep.id,
        absorbEntryId: absorb.id,
        copyTags: true,
        sourceUrls: [selectedSource.url],
      });
      const detail = getEntryDetail(database, keep.id);
      return getEntryDetail(database, absorb.id) === null
        && detail?.title === 'Kept Probe Work'
        && detail.sections.some((item) => item.facets.some((facet) => (
          facet.tags.some((tag) => tag.normalizedName === 'merged probe tag')
        ))) === true
        && listEntrySources(database, keep.id)[0]?.sourceKey === 'known:hitomi'
        && listSourceLibrary(database).some((source) => (
          source.sourceKey === 'known:hitomi' && source.entryCount >= 1
        ));
    });

    check('maintain Source invalidation workflow', () => {
    const status = setSourceStatus(database, 'known:hitomi', 'invalid', 'probe check');
    const annotated = listSourceLibrary(database).find((source) => source.sourceKey === 'known:hitomi');
    const probeEntryId = Number(database.prepare('SELECT id FROM entries ORDER BY id LIMIT 1').pluck().get());
    const run = createRun(database, {
      originSourceKey: 'known:hitomi',
      adapterKey: 'fake',
      targetOrigin: 'https://probe.example',
      markOriginInvalid: true,
      settings: {},
    });
    upsertItem(database, run.id, {
      entryId: probeEntryId,
      entryTitleSnapshot: String(database.prepare('SELECT title FROM entries WHERE id = ?').pluck().get(probeEntryId)),
      originUrls: [],
      candidates: [{
        url: 'https://probe.example/2',
        title: 'Probe target',
        band: 'strong-review',
        reasons: ['probe fixture'],
        adapterEvidence: {},
      }],
    });
    patchItem(database, run.id, probeEntryId, { decision: 'accept', selectedUrl: 'https://probe.example/2' });
    const accepted = getItem(database, run.id, probeEntryId);
    const counts = getRun(database, run.id)!.counts;
    const cleared = setSourceStatus(database, 'known:hitomi', 'active', '');
    return (
      status.state === 'invalid'
      && annotated !== undefined
      && annotated.state === 'invalid'
      && accepted !== null
      && accepted.decision === 'accept'
      && counts.total === 1
      && counts.processed === 1
      && cleared.state === 'active'
      && getSourceStatus(database, 'unknown:none') === null
    );
  });

  check('credit a multi-Author Entry to the multi-author Author alone', () => {
      const anthology = createEntry(database, { title: 'Probe anthology', type: 'multi-author-probe' });
      const contributor = createProducer(database, { name: 'Probe Contributor' });
      const established = createProducer(database, { name: 'Probe Established Author' });
      const establishedWork = createEntry(database, { title: 'Probe established work', type: 'multi-author-probe' });
      linkEntryProducer(database, anthology.id, contributor.id);
      linkEntryProducer(database, anthology.id, established.id);
      linkEntryProducer(database, establishedWork.id, established.id);

      const result = convertEntryAuthorsToMultiAuthor(database, anthology.id);
      const detail = getEntryDetail(database, anthology.id);
      const visible = findProducers(database).map((producer) => producer.name);
      return result.convertedAuthors.length === 2
        && detail?.producers.length === 1
        && detail.producers[0]?.name === MULTI_AUTHOR_PRODUCER_NAME
        && detail.producers[0]?.entryCount === 1
        // The emptied Author disappears; the one with their own work stays.
        && !visible.includes('Probe Contributor')
        && visible.includes('Probe Established Author');
    });

    check('offline sync identity and atomic snapshot', () => {
    const capabilities = buildSyncCapabilities(database, 'probe');
    const identity = getSyncIdentity(database);
    const first = buildSyncSnapshot(database);
    const second = buildSyncSnapshot(database);
    const rotated = rotateSyncEpoch(database);
    return (
      capabilities.libraryId === identity.libraryId
      && capabilities.syncEpoch !== ''
      && capabilities.snapshotFormatVersion === 1
      && second.header.snapshotSeq === first.header.snapshotSeq + 1
      && first.header.checksum.length === 64
      && rotated !== capabilities.syncEpoch
      && first.payload.entries.length >= 1
    );
  });

  check('database doctor clean', () => inspectDatabase(database).ok);
  } finally {
    database.close();
  }

  return { ok: checks.every((item) => item.passed), checks };
}
