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
  renameEntryTag,
} from '../repositories/entry-tag-repository.js';
import {
  createEntry,
  getEntryDetail,
  listGalleries,
  updateEntry,
} from '../repositories/entry-repository.js';
import { createFacet, createSection } from '../repositories/layout-repository.js';
import { assignProducerTag, findProducers } from '../repositories/producer-tag-repository.js';
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

    check('database doctor clean', () => inspectDatabase(database).ok);
  } finally {
    database.close();
  }

  return { ok: checks.every((item) => item.passed), checks };
}
