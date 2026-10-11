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
  deleteEntry,
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
import { ackSyncChanges, buildSyncCapabilities, buildSyncSnapshot, getSyncIdentity, readSyncChanges, rotateSyncEpoch } from '../sync/sync-service.js';
import { createOnlineEntry } from '../sync/online-entry-create.js';
import { createFacet, createSection } from '../repositories/layout-repository.js';
import { assignProducerTag, findProducers } from '../repositories/producer-tag-repository.js';
import { suggestTags } from '../repositories/suggestion-repository.js';
import {
  createProducer,
  getAuthorDetail,
  linkEntryProducer,
  unlinkEntryProducer,
  updateProducer,
} from '../repositories/producer-repository.js';
import {
  createAuthorDirectory,
  removeEntryFromAuthorDirectory,
} from '../repositories/author-directory-repository.js';
import { deleteTag } from '../repositories/tag-merge-repository.js';
import { commitImportBatch } from '../import/commit.js';
import { executeProducerMerges, planProducerMerges } from '../import/merge-producers.js';
import {
  createEntryRatingSlot,
  createProducerRatingSlot,
  createRatingSlot,
  findRatingSlotId,
  listAuthorSelfRatings,
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
import {
  findSiteWork,
  getSiteCrawlSource,
  partitionKnownSiteWorks,
  recordCrawlObservation,
  siteWorkOrderKey,
} from '../repositories/site-crawl-repository.js';
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
    check('schema-34 Entry Tag and Facet origin registries', () => {
      const version = database.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() as number;
      if (version < 34) return false;
      return ['sync_offline_created_entry_facets', 'sync_offline_created_entry_tags', 'entry_tag_layouts', 'sync_entry_taxonomy_changes'].every(table =>
        database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined);
    });
    check('schema-37 Gallery order sync scope', () => {
      const version = database.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() as number;
      return version >= 37 && database.prepare("SELECT 1 FROM gallery_order_scope WHERE id=1 AND sync_version>=1").get() !== undefined;
    });
    check('schema-38 Entry duration', () => {
      const version = database.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() as number;
      if (version < 38) return false;
      return database.prepare("SELECT 1 FROM pragma_table_info('entries') WHERE name = 'duration_seconds'")
        .get() !== undefined;
    });
    check('schema-36 stored Gallery order', () => {
      const version = database.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() as number;
      if (version < 36) return false;
      return database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='gallery_order'",
      ).get() !== undefined;
    });
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

    check('store a work duration as the peer of its page count', () => {
      // The whole point of the column is that a work with no pages still carries a fact, and that
      // clearing it is an ordinary edit — most works have no runtime, so null must survive the trip
      // back out of the detail the Entry page reads.
      const stored = updateEntry(database, 1, { durationSeconds: 805 });
      const readBack = getEntryDetail(database, 1)?.durationSeconds;
      const cleared = updateEntry(database, 1, { durationSeconds: null });
      return stored.durationSeconds === 805
        && readBack === 805
        && cleared.durationSeconds === null
        && getEntryDetail(database, 1)?.durationSeconds === null;
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

    check('delete a tag and every assignment of it', () => {
      // Two Entries share one tag plus keep a second tag of their own, so the
      // delete has to remove one assignment per work and leave the other alone.
      const shared = assignEntryTag(database, {
        entryId: 1, facetId: targetFacetId, name: 'Doomed tag',
      });
      const kept = assignEntryTag(database, {
        entryId: 1, facetId: targetFacetId, name: 'Surviving tag',
      });
      assignEntryTag(database, { entryId: 2, facetId: targetFacetId, name: 'Doomed tag' });
      assignEntryTag(database, { entryId: 2, facetId: targetFacetId, name: 'Surviving tag' });

      const result = deleteTag(database, { vocabulary: 'entry', tagId: shared.tagId });
      const survivors = database.prepare(
        'SELECT COUNT(*) FROM entry_tags WHERE tag_id = ?',
      ).pluck().get(shared.tagId);
      const keptSurvives = database.prepare(
        'SELECT COUNT(*) FROM entry_tags WHERE tag_id = ?',
      ).pluck().get(kept.tagId);
      return result.removedAssignments === 2
        && result.deletedTags === 1
        && result.tagName === 'Doomed tag'
        && survivors === 0
        && keptSurvives === 2
        && database.prepare('SELECT COUNT(*) FROM tags WHERE id = ?').pluck().get(shared.tagId) === 0;
    });

    check('derive Galleries from Entry types', () => {
      const gallery = listGalleries(database).find((item) => item.type === 'game');
      return gallery?.entryCount === 3;
    });

    check('retain a site work id per imported work and advance its cursor', () => {
      // One run of a folder listing: the export carries the site identity, so
      // the commit both files each work under its id and moves the cursor.
      const folderBatch = {
        source: 'hitomi.la',
        origin: { kind: 'folder' as const, ref: 'probe-folder', displayName: 'Probe folder' },
        warnings: [],
        entries: [
          {
            externalKey: 'hitomi.la:100',
            title: 'Crawled work 100',
            uploadDate: '2026-01-10',
            sources: [{ url: 'https://hitomi.la/galleries/100.html' }],
          },
          {
            externalKey: 'hitomi.la:120',
            title: 'Crawled work 120',
            uploadDate: '2026-03-05',
            sources: [{ url: 'https://hitomi.la/galleries/120.html' }],
          },
        ],
      };
      const folderMapping = {
        entryType: 'game',
        canonicalTagFacetId: targetFacetId,
        sourceContentType: 'source url',
        externalKeyContentType: 'external key',
        fieldMappings: {},
        ignoredFields: [],
        authorRatings: [],
      };
      const firstRun = commitImportBatch(database, folderBatch, folderMapping);

      // A second run of the same folder, a month later: the two known works are
      // gone from disk, the third is past the cursor, and only it gets fetched.
      const secondRun = commitImportBatch(database, {
        source: 'hitomi.la',
        origin: { kind: 'folder', ref: 'probe-folder' },
        warnings: [],
        entries: [{
          externalKey: 'hitomi.la:140',
          title: 'Crawled work 140',
          uploadDate: '2026-04-01',
          sources: [{ url: 'https://hitomi.la/galleries/140.html' }],
        }],
      }, folderMapping);

      const listing = partitionKnownSiteWorks(database, 'hitomi.la', ['100', '120', '140', '160']);
      const work = findSiteWork(database, 'hitomi.la', '100');
      const digest = getSiteCrawlSource(database, {
        sourceSite: 'hitomi.la',
        sourceKind: 'folder',
        sourceRef: 'probe-folder',
      });

      return firstRun.entryCount === 2
        && secondRun.entryCount === 1
        && work?.entryId === firstRun.entries[0]?.entryId
        && work?.workDate === '2026-01-10'
        && listing.known.length === 3
        && listing.unknown.length === 1
        && listing.unknown[0] === '160'
        && digest?.lastSeenSourceId === '140'
        && digest?.lastSeenWorkDate === '2026-04-01'
        && digest?.crawlCount === 2
        && digest?.libraryWorkCount === 3;
    });

    check('never pull a crawl cursor backwards', () => {
      const cursor = { sourceSite: 'hitomi.la', sourceKind: 'folder' as const, sourceRef: 'revisited' };
      const earlier = recordCrawlObservation(database, {
        ...cursor,
        works: [{ sourceId: '500', workDate: '2026-05-01' }],
      });
      const later = recordCrawlObservation(database, {
        ...cursor,
        works: [{ sourceId: '400', workDate: '2026-01-01' }],
      });
      return earlier.lastSeenSourceId === '500'
        && later.lastSeenSourceId === '500'
        && later.lastSeenWorkDate === '2026-05-01'
        && later.crawlCount === 2;
    });

    check('order site work ids numerically rather than as raw text', () => {
      const byId = ['100', '9', '10', '1024']
        .sort((left, right) => (siteWorkOrderKey(left, null) < siteWorkOrderKey(right, null) ? -1 : 1));
      return byId.join(',') === '9,10,100,1024'
        // A site with no dates on its works still gets a pure id ordering, and a
        // dated work always outranks the same work without its date.
        && siteWorkOrderKey('1', '2026-01-01') < siteWorkOrderKey('1', '2026-02-01')
        && siteWorkOrderKey('1', null) < siteWorkOrderKey('1', '2026-01-01');
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

      // One reading, not two: a work dimension is its own value and, where it has none, its Authors'
      // summary of the same name. The older flag asks for exactly that, so both calls answer the
      // same — and the four-Author anthology, which can inherit nothing, sinks.
      return sortedTitles(false).join('|') === 'Probe inherited rating|Probe own rating|Probe anthology'
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
      const parent = createCollection(database, {
        kind: 'entry',
        title: 'Read list',
        galleryType: 'game',
      });
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
      // An Author folder has no Gallery page of its own.
      let galleryRejected = false;
      try {
        createCollection(database, { kind: 'producer', title: 'Filed authors', galleryType: 'game' });
      } catch {
        galleryRejected = true;
      }
      const authorCollection = createCollection(database, { kind: 'producer', title: 'Favourite authors' });
      addCollectionProducer(database, authorCollection.id, 1);
      const reloaded = getCollection(database, parent.id);
      return rejected
        && galleryRejected
        && parent.galleryType === 'game'
        && child.galleryType === 'game'
        && authorCollection.galleryType === null
        && reloaded?.galleryType === 'game'
        && reloaded?.entries.some((entry) => entry.id === 1) === true
        && reloaded?.children.some((nested) => nested.id === child.id
          && nested.galleryType === 'game'
          && nested.entries.some((entry) => entry.id === 2)) === true
        && getCollection(database, authorCollection.id)?.producers[0]?.id === 1;
    });

    check('drop an Author once its last work is gone', () => {
      const author = createProducer(database, { name: 'One Work Author' });
      const entry = createEntry(database, { title: 'Only Work', type: 'game' });
      linkEntryProducer(database, entry.id, author.id);
      // A hand-created Author that never held a work waits for one.
      const fresh = createProducer(database, { name: 'Fresh Author' });

      const producerExists = (id: number): boolean => database.prepare(
        'SELECT COUNT(*) FROM producers WHERE id = ?',
      ).pluck().get(id) !== 0;

      unlinkEntryProducer(database, entry.id, author.id);
      const goneAfterUnlink = producerExists(author.id) === false;

      const second = createProducer(database, { name: 'Two Work Author' });
      const firstWork = createEntry(database, { title: 'Work A', type: 'game' });
      const secondWork = createEntry(database, { title: 'Work B', type: 'game' });
      linkEntryProducer(database, firstWork.id, second.id);
      linkEntryProducer(database, secondWork.id, second.id);
      deleteEntry(database, firstWork.id);
      const keptWhileBusy = producerExists(second.id);
      deleteEntry(database, secondWork.id);
      const goneAfterLastWork = producerExists(second.id) === false;

      // A hand-created Author that never held a work is left alone.
      return goneAfterUnlink
        && keptWhileBusy
        && goneAfterLastWork
        && producerExists(fresh.id)
        && findProducers(database).some((row) => row.name === 'Two Work Author') === false;
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
      && capabilities.snapshotFormatVersion === 2
      && capabilities.featureFlags.offlineMutations === true
      && capabilities.featureFlags.offlineEntryUpdate === true
      && capabilities.featureFlags.offlineProducerViewLater === true
      && capabilities.featureFlags.offlineRatingSlotLayout === true
      && capabilities.featureFlags.offlineCollectionProducerMembership === true
      && capabilities.featureFlags.offlineCollectionManagement === true
      && capabilities.featureFlags.offlineAuthorDirectories === true
      && capabilities.featureFlags.offlineEntryAuthors === true
      && capabilities.featureFlags.offlineEntryTags === true
      && second.header.snapshotSeq === first.header.snapshotSeq + 1
      && second.header.changeSeq === first.header.changeSeq
      && first.header.checksum.length === 64
      && rotated !== capabilities.syncEpoch
      && first.payload.entries.length >= 1
      && first.payload.entries.every((entry) => (
        entry.syncUid !== undefined && entry.syncVersion !== undefined
      ))
    );
  });

  check('journal Entry Tag insert, update and delete', () => {
    const entry = createEntry(database, { title: 'Tag journal probe', type: 'Probe' });
    const section = createSection(database, { entryType: 'Probe', name: 'Tag journal' });
    const other = createSection(database, { entryType: 'Probe', name: 'Tag journal other' });
    const before = database.prepare('SELECT sync_uid AS syncUid, sync_version AS version FROM entries WHERE id = ?')
      .get(entry.id) as { syncUid: string; version: number };
    const beforeSeq = Number(database.prepare('SELECT COALESCE(MAX(seq), 0) FROM sync_changes').pluck().get());
    const assigned = assignEntryTag(database, { entryId: entry.id, facetId: section.defaultFacetId, name: 'Probe tag journal' });
    moveEntryTag(database, { entryId: entry.id, tagId: assigned.tagId, targetFacetId: other.defaultFacetId });
    database.prepare('DELETE FROM entry_tags WHERE entry_id = ? AND tag_id = ?').run(entry.id, assigned.tagId);
    const versions = database.prepare(`SELECT resource_version FROM sync_changes
      WHERE entity_kind = 'entry' AND entity_uid = ? AND seq > ? ORDER BY seq`)
      .pluck().all(before.syncUid, beforeSeq) as number[];
    return versions.join(',') === [before.version + 1, before.version + 2, before.version + 3].join(',');
  });

  check('journal Entry Author link changes', () => {
    const entry = createEntry(database, { title: 'Offline Author-link probe', type: 'Probe' });
    const producer = createProducer(database, { name: 'Offline Author-link probe' });
    const identity = database.prepare(
      'SELECT sync_uid AS syncUid, sync_version AS syncVersion FROM entries WHERE id = ?',
    ).get(entry.id) as { syncUid: string; syncVersion: number };
    const beforeSeq = Number(database.prepare('SELECT COALESCE(MAX(seq), 0) FROM sync_changes').pluck().get());

    linkEntryProducer(database, entry.id, producer.id);
    const afterLink = Number(database.prepare('SELECT sync_version FROM entries WHERE id = ?')
      .pluck().get(entry.id));
    unlinkEntryProducer(database, entry.id, producer.id);
    const afterUnlink = Number(database.prepare('SELECT sync_version FROM entries WHERE id = ?')
      .pluck().get(entry.id));
    const changes = database.prepare(`
      SELECT resource_version AS resourceVersion FROM sync_changes
      WHERE entity_kind = 'entry' AND entity_uid = ? AND seq > ? ORDER BY seq
    `).all(identity.syncUid, beforeSeq) as Array<{ resourceVersion: number }>;

    return afterLink === identity.syncVersion + 1
      && afterUnlink === identity.syncVersion + 2
      && changes.map(({ resourceVersion }) => resourceVersion).join(',')
        === `${identity.syncVersion + 1},${identity.syncVersion + 2}`;
  });

  check('journal Producer View later membership', () => {
    const producer = createProducer(database, { name: 'Offline Producer probe' });
    const before = database.prepare(`
      SELECT sync_uid AS syncUid, sync_version AS syncVersion FROM producers WHERE id = ?
    `).get(producer.id) as { syncUid: string; syncVersion: number };
    const beforeSeq = Number(database.prepare(
      'SELECT COALESCE(MAX(seq), 0) FROM sync_changes',
    ).pluck().get());

    addViewLaterProducer(database, producer.id);
    const afterAdd = Number(database.prepare(
      'SELECT sync_version FROM producers WHERE id = ?',
    ).pluck().get(producer.id));
    const addChange = database.prepare(`
      SELECT entity_kind AS entityKind, entity_uid AS entityUid,
             resource_version AS resourceVersion
      FROM sync_changes WHERE seq = ?
    `).get(beforeSeq + 1) as {
      entityKind: string; entityUid: string; resourceVersion: number;
    } | undefined;

    removeViewLaterProducer(database, producer.id);
    const afterRemove = Number(database.prepare(
      'SELECT sync_version FROM producers WHERE id = ?',
    ).pluck().get(producer.id));
    const producerChanges = Number(database.prepare(`
      SELECT COUNT(*) FROM sync_changes
      WHERE entity_kind = 'producer' AND entity_uid = ? AND seq > ?
    `).pluck().get(before.syncUid, beforeSeq));
    const snapshot = buildSyncSnapshot(database);
    const projectedProducer = snapshot.payload.producers.find((row) => row.id === producer.id);

    return before.syncVersion === 1
      && /^[0-9a-f-]{36}$/u.test(before.syncUid)
      && afterAdd === before.syncVersion + 1
      && addChange?.entityKind === 'producer'
      && addChange.entityUid === before.syncUid
      && addChange.resourceVersion === afterAdd
      && afterRemove === before.syncVersion + 2
      && producerChanges === 2
      && !listViewLaterProducerIds(database).includes(producer.id)
      && projectedProducer?.syncUid === before.syncUid
      && projectedProducer.syncVersion === afterRemove;
  });

  check('journal Producer tag identity and membership', () => {
    const author = createProducer(database, { name: 'Producer tag probe' });
    const before = database.prepare(`
      SELECT sync_uid AS syncUid, sync_version AS syncVersion FROM producers WHERE id = ?
    `).get(author.id) as { syncUid: string; syncVersion: number };
    const beforeSeq = Number(database.prepare('SELECT COALESCE(MAX(seq), 0) FROM sync_changes').pluck().get());
    database.prepare('INSERT INTO producer_tags (name, normalized_name) VALUES (?, ?)')
      .run('Probe Tag', 'probe tag');
    const tag = database.prepare('SELECT id, sync_uid AS syncUid FROM producer_tags WHERE normalized_name = ?')
      .get('probe tag') as { id: number; syncUid: string };
    database.prepare('INSERT INTO producer_tag_assignments (producer_id, tag_id) VALUES (?, ?)')
      .run(author.id, tag.id);
    database.prepare('UPDATE producer_tags SET name = ?, normalized_name = ? WHERE id = ?')
      .run('Renamed Probe Tag', 'renamed probe tag', tag.id);
    const after = Number(database.prepare('SELECT sync_version FROM producers WHERE id = ?').pluck().get(author.id));
    const changes = database.prepare(`
      SELECT resource_version AS resourceVersion FROM sync_changes
      WHERE entity_kind = 'producer' AND entity_uid = ? AND seq > ? ORDER BY seq
    `).all(before.syncUid, beforeSeq) as Array<{ resourceVersion: number }>;
    const snapshot = buildSyncSnapshot(database);
    const projectedTag = snapshot.payload.producerTags.find((row) => row.id === tag.id);
    const assigned = snapshot.payload.producerTagAssignments.some((row) => (
      row.producerId === author.id && row.tagId === tag.id
    ));

    return /^[0-9a-f-]{36}$/u.test(tag.syncUid)
      && after === before.syncVersion + 2
      && changes.map((change) => change.resourceVersion).join(',') === `${before.syncVersion + 1},${before.syncVersion + 2}`
      && projectedTag?.syncUid === tag.syncUid
      && projectedTag.name === 'Renamed Probe Tag'
      && assigned;
  });

  check('journal Producer rating values', () => {
    const author = createProducer(database, { name: 'Producer rating probe' });
    const work = createEntry(database, { title: 'Producer rating probe work', type: 'game' });
    linkEntryProducer(database, work.id, author.id);
    const slot = createProducerRatingSlot(database, { producerId: author.id, name: 'Probe rating' });
    const before = database.prepare(`
      SELECT sync_uid AS syncUid, sync_version AS syncVersion FROM producers WHERE id = ?
    `).get(author.id) as { syncUid: string; syncVersion: number };
    const beforeSeq = Number(database.prepare('SELECT COALESCE(MAX(seq), 0) FROM sync_changes').pluck().get());
    setProducerRating(database, { producerId: author.id, slotId: slot.id, stars: 4.5 });
    const change = database.prepare(`
      SELECT entity_kind AS entityKind, entity_uid AS entityUid, resource_version AS resourceVersion
      FROM sync_changes WHERE seq = ?
    `).get(beforeSeq + 1) as { entityKind: string; entityUid: string; resourceVersion: number } | undefined;
    const afterVersion = Number(database.prepare('SELECT sync_version FROM producers WHERE id = ?').pluck().get(author.id));
    return afterVersion === before.syncVersion + 1
      && change?.entityKind === 'producer'
      && change.entityUid === before.syncUid
      && change.resourceVersion === afterVersion;
  });

  check('journal shared rating layouts, Collections, and Author Directories', () => {
    const author = createProducer(database, { name: 'Resource owner probe' });
    const work = createEntry(database, { title: 'Resource work', type: 'resource-probe' });
    linkEntryProducer(database, work.id, author.id);
    const producerBefore = Number(database.prepare(
      'SELECT sync_version FROM producers WHERE id = ?',
    ).pluck().get(author.id));
    const directorySetBefore = Number(database.prepare(
      'SELECT sync_version FROM author_directory_sets WHERE producer_id = ?',
    ).pluck().get(author.id));
    const beforeSeq = Number(database.prepare('SELECT COALESCE(MAX(seq), 0) FROM sync_changes').pluck().get());

    createRatingSlot(database, { kind: 'producer', entryType: 'resource-probe', name: 'Axis' });
    const layout = database.prepare(`
      SELECT sync_uid AS syncUid, sync_version AS syncVersion
      FROM rating_slot_layouts WHERE subject_kind = 'producer' AND entry_type = 'resource-probe'
    `).get() as { syncUid: string; syncVersion: number };
    const collection = createCollection(database, { kind: 'producer', title: 'Resource collection' });
    addCollectionProducer(database, collection.id, author.id);
    const collectionVersion = Number(database.prepare(
      'SELECT sync_version FROM collections WHERE id = ?',
    ).pluck().get(collection.id));

    const directoryId = Number(database.prepare(`
      INSERT INTO author_directories (producer_id, title, description, sort_order)
      VALUES (?, 'Resource Directory', '', 0)
    `).run(author.id).lastInsertRowid);
    database.prepare(`
      INSERT INTO author_directory_entries (directory_id, producer_id, entry_id, sort_order)
      VALUES (?, ?, ?, 0)
    `).run(directoryId, author.id, work.id);
    const producerAfter = Number(database.prepare(
      'SELECT sync_version FROM producers WHERE id = ?',
    ).pluck().get(author.id));
    const directorySetAfter = Number(database.prepare(
      'SELECT sync_version FROM author_directory_sets WHERE producer_id = ?',
    ).pluck().get(author.id));
    const directoryUid = String(database.prepare(
      'SELECT sync_uid FROM author_directories WHERE id = ?',
    ).pluck().get(directoryId));
    const journalKinds = database.prepare(`
      SELECT entity_kind FROM sync_changes WHERE seq > ? ORDER BY seq
    `).pluck().all(beforeSeq) as string[];
    const snapshot = buildSyncSnapshot(database);
    return layout.syncVersion === 2
      && /^[0-9a-f-]{36}$/u.test(layout.syncUid)
      && collectionVersion === 2
      && /^[0-9a-f-]{36}$/u.test(directoryUid)
      && directorySetAfter === directorySetBefore + 2
      && producerAfter === producerBefore
      && journalKinds.includes('rating_layout')
      && journalKinds.includes('collection')
      && journalKinds.includes('author_directory_set')
      && snapshot.payload.collections.find((row) => row.id === collection.id)?.syncUid !== undefined
      && snapshot.payload.authorDirectories.find((row) => row.id === directoryId)?.syncUid === directoryUid
      && snapshot.payload.authorDirectorySets?.some((row) => (
        row.producerId === author.id && row.syncVersion === directorySetAfter
      )) === true
      && snapshot.payload.ratingLayouts?.some((row) => row.syncUid === layout.syncUid) === true
      && inspectDatabase(database).ok;
  });

  // Runs last: it merges every pending duplicate Author, so the database is not
  // the same afterwards.
  check('hand Collection and View later memberships to the merged Author', () => {
    const keeper = createProducer(database, { name: 'Merge Keeper' });
    const twin = createProducer(database, { name: 'Merge Keeper' });
    const work = createEntry(database, { title: 'Merged Work', type: 'game' });
    linkEntryProducer(database, work.id, twin.id);
    const shelf = createCollection(database, { kind: 'producer', title: 'Merged shelf' });
    addCollectionProducer(database, shelf.id, twin.id);
    addViewLaterProducer(database, twin.id);

    const plans = planProducerMerges(database);
    database.pragma('foreign_keys = OFF');
    try {
      executeProducerMerges(database, plans);
    } finally {
      database.pragma('foreign_keys = ON');
    }

    const orphanMemberships = (table: string): number => Number(database.prepare(
      `SELECT COUNT(*) FROM ${table} AS link
       LEFT JOIN producers AS producer ON producer.id = link.producer_id
       WHERE producer.id IS NULL`,
    ).pluck().get());
    // Which of the two rows survives is the merge's own decision.
    const survivorId = database.prepare(
      "SELECT id FROM producers WHERE name = 'Merge Keeper'",
    ).pluck().get() as number | undefined;
    return keeper.id !== twin.id
      && survivorId !== undefined
      && orphanMemberships('collection_producers') === 0
      && orphanMemberships('view_later_producers') === 0
      && database.prepare(
        'SELECT COUNT(*) FROM collection_producers WHERE producer_id = ?',
      ).pluck().get(survivorId) === 1
      && listViewLaterProducerIds(database).includes(survivorId);
  });

  check('durable bounded change feed acknowledgement', () => {
    const identity = getSyncIdentity(database);
    const input = { ...identity, protocolVersion: 1, clientId: 'probe', afterSeq: 0, limit: 1 };
    const page = readSyncChanges(database, input);
    if (page.changes.length !== 1 || page.nextSeq > page.highWaterSeq) return false;
    const ack = ackSyncChanges(database, { ...identity, protocolVersion: 1, clientId: 'probe', cursorSeq: page.nextSeq });
    return ack.ackSeq === page.nextSeq
      && readSyncChanges(database, { ...input, afterSeq: page.nextSeq }).ackSeq === page.nextSeq;
  });

  check('idempotent online Entry claim', () => {
    const input = {
      title: 'Online claim probe', type: 'game', syncUid: '44444444-4444-4444-8444-444444444444',
    };
    const first = createOnlineEntry(database, input);
    const retry = createOnlineEntry(database, input);
    const collision = createOnlineEntry(database, { ...input, title: 'Different claim' });
    return first.status === 'created' && retry.status === 'retry'
      && first.entry?.id === retry.entry?.id && collision.status === 'conflict'
      && database.prepare('SELECT COUNT(*) FROM entries WHERE sync_uid = ?')
        .pluck().get(input.syncUid) === 1;
  });

  check('offline Producer causal registry', () => {
    const columns = database.prepare('PRAGMA table_info(sync_offline_created_producers)').all() as Array<{name:string}>;
    return ['producer_uid','producer_id','create_op_id','client_id','library_id','sync_epoch'].every(name => columns.some(row => row.name === name));
  });
    check('keep the Author\u2019s own rating class apart from the works summary', () => {
      // Two classes, one subject: the works summary is what an unrated work inherits, the author's
      // own dimensions are about the person and are never inherited. Same author, same Gallery,
      // two partitions — and a work dimension brings the summary's dimension of the same name into
      // being by itself, which is what keeps a Gallery's template and its authors in step.
      const authorId = 1;
      const selfSlot = createProducerRatingSlot(database, {
        producerId: authorId, name: 'Charisma', kind: 'author_self',
      });
      setProducerRating(database, { producerId: authorId, slotId: selfSlot.id, stars: 5 });
      const selfRows = listAuthorSelfRatings(database, authorId);
      const summaryRows = listProducerRatings(database, authorId);
      return selfRows.length === 1
        && selfRows[0]?.name === 'Charisma'
        && selfRows[0]?.stars === 5
        // The summary never picks up the author's own dimension, and the own class never picks up
        // the summary's names: they are separate partitions, not one list with a flag on it.
        && summaryRows.every((row) => row.name !== 'Charisma')
        && selfRows.every((row) => row.name !== 'Quality')
        // 'Quality' and 'Taste' are work dimensions of 'game' (created above), so the summary has
        // had both since they appeared.
        && summaryRows.some((row) => row.name === 'Quality')
        && summaryRows.some((row) => row.name === 'Taste');
    });

  check('standalone Author independent Directory seed insert and immutable binding', () => {
    const seed='aaaaaaa1-1111-4111-8111-111111111111';
    const id=Number(database.prepare('INSERT INTO producers (name,directory_set_seed_uid) VALUES (?,?)').run('Directory seed probe',seed).lastInsertRowid);
    const set=database.prepare('SELECT sync_uid AS uid,sync_version AS version FROM author_directory_sets WHERE producer_id=?').get(id) as {uid:string;version:number};
    let immutable=false;try {database.prepare('UPDATE producers SET directory_set_seed_uid=NULL WHERE id=?').run(id);}catch {immutable=true;}
    return set.uid===seed && set.version===1 && immutable && buildSyncCapabilities(database, 'probe').featureFlags.offlineStandaloneAuthorDirectorySeed===true && inspectDatabase(database).ok;
  });
  check('database doctor clean', () => inspectDatabase(database).ok);
  } finally {
    database.close();
  }

  return { ok: checks.every((item) => item.passed), checks };
}
