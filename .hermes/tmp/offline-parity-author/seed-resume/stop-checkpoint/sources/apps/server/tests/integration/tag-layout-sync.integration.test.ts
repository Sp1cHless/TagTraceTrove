import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { inspectDatabase } from '../../src/database/doctor.js';
import { createApiApp } from '../../src/http/app.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import {
  applyEntryTagLayout,
  assignEntryTag,
  listEntryTags,
} from '../../src/repositories/entry-tag-repository.js';
import { createFacet, createSection } from '../../src/repositories/layout-repository.js';

type TestDatabase = ReturnType<typeof createMigratedMemoryDatabase>;

const databases: TestDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

function createComicLayout(database: TestDatabase) {
  const basic = createSection(database, { entryType: 'comic', name: 'Basic Information' });
  const series = createFacet(database, { sectionId: basic.id, name: 'Series' });
  const characters = createFacet(database, { sectionId: basic.id, name: 'Characters' });
  const language = createFacet(database, { sectionId: basic.id, name: 'Language' });
  const tags = createSection(database, { entryType: 'comic', name: 'Tags' });
  return { basic, series, characters, language, tags };
}

function createComicEntry(database: TestDatabase, title: string): number {
  return createEntry(database, { title, type: 'comic' }).id;
}

function facetIdByName(
  database: TestDatabase,
  entryId: number,
  tagName: string,
): number | null {
  const row = database.prepare(`
    SELECT assignment.facet_id AS facet_id
    FROM entry_tags AS assignment
    JOIN tags AS tag ON tag.id = assignment.tag_id
    WHERE assignment.entry_id = ? AND tag.name = ?
  `).get(entryId, tagName) as { facet_id: number } | undefined;
  return row?.facet_id ?? null;
}

describe('applyEntryTagLayout', () => {
  it('moves every peer tag onto the source Entry Facet and reports counts', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const { series, language, tags } = createComicLayout(database);
      const source = createComicEntry(database, 'Standard work');
      assignEntryTag(database, { entryId: source, facetId: series.id, name: 'Azur Lane' });
      assignEntryTag(database, { entryId: source, facetId: tags.defaultFacetId, name: 'Favorite' });

      const peer = createComicEntry(database, 'Work two');
      assignEntryTag(database, { entryId: peer, facetId: language.id, name: 'Azur Lane' });
      assignEntryTag(database, { entryId: peer, facetId: series.id, name: 'Favorite' });
      assignEntryTag(database, { entryId: peer, facetId: series.id, name: 'GFL' });

      const result = applyEntryTagLayout(database, source);
      expect(result).toEqual({
        entryType: 'comic',
        entriesAffected: 1,
        tagsMoved: 2,
        entriesScanned: 1,
      });

      expect(facetIdByName(database, peer, 'Azur Lane')).toBe(series.id);
      expect(facetIdByName(database, peer, 'Favorite')).toBe(tags.defaultFacetId);
      // The source does not carry GFL, so the peer keeps its own placement.
      expect(facetIdByName(database, peer, 'GFL')).toBe(series.id);
      // The source Entry is the standard and is never rewritten.
      expect(facetIdByName(database, source, 'Azur Lane')).toBe(series.id);
      expect(facetIdByName(database, source, 'Favorite')).toBe(tags.defaultFacetId);

      expect(database.pragma('foreign_key_check')).toEqual([]);
      expect(inspectDatabase(database).ok).toBe(true);
    } finally {
      database.close();
    }
  });

  it('leaves peers that already match untouched and is idempotent', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const { series, language } = createComicLayout(database);
      const source = createComicEntry(database, 'Standard work');
      assignEntryTag(database, { entryId: source, facetId: series.id, name: 'Azur Lane' });

      const alreadyCorrect = createComicEntry(database, 'Work two');
      assignEntryTag(database, { entryId: alreadyCorrect, facetId: series.id, name: 'Azur Lane' });
      const misplaced = createComicEntry(database, 'Work three');
      assignEntryTag(database, { entryId: misplaced, facetId: language.id, name: 'Azur Lane' });

      const first = applyEntryTagLayout(database, source);
      expect(first).toEqual({
        entryType: 'comic',
        entriesAffected: 1,
        tagsMoved: 1,
        entriesScanned: 2,
      });
      expect(facetIdByName(database, misplaced, 'Azur Lane')).toBe(series.id);
      expect(facetIdByName(database, alreadyCorrect, 'Azur Lane')).toBe(series.id);

      const second = applyEntryTagLayout(database, source);
      expect(second.entriesAffected).toBe(0);
      expect(second.tagsMoved).toBe(0);
      expect(second.entriesScanned).toBe(2);
    } finally {
      database.close();
    }
  });

  it('never touches Entries of other types, even for the same tag name', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const { series, language } = createComicLayout(database);
      const source = createComicEntry(database, 'Comic standard');
      assignEntryTag(database, { entryId: source, facetId: series.id, name: 'Azur Lane' });
      const comicPeer = createComicEntry(database, 'Comic peer');
      assignEntryTag(database, { entryId: comicPeer, facetId: language.id, name: 'Azur Lane' });

      const mangaBasic = createSection(database, { entryType: 'manga', name: 'Basic Information' });
      const mangaLanguage = createFacet(database, { sectionId: mangaBasic.id, name: 'Language' });
      createSection(database, { entryType: 'manga', name: 'Tags' });
      const mangaEntry = createEntry(database, { title: 'Manga work', type: 'manga' });
      assignEntryTag(database, { entryId: mangaEntry.id, facetId: mangaLanguage.id, name: 'Azur Lane' });

      const result = applyEntryTagLayout(database, source);
      expect(result.entriesScanned).toBe(1);
      expect(result.tagsMoved).toBe(1);

      expect(facetIdByName(database, comicPeer, 'Azur Lane')).toBe(series.id);
      expect(facetIdByName(database, mangaEntry.id, 'Azur Lane')).toBe(mangaLanguage.id);
    } finally {
      database.close();
    }
  });

  it('counts peers without tags when the source carries no assignments', () => {
    const database = createMigratedMemoryDatabase();
    try {
      createComicLayout(database);
      const source = createComicEntry(database, 'Bare source');
      createComicEntry(database, 'Peer one');
      createComicEntry(database, 'Peer two');

      const result = applyEntryTagLayout(database, source);
      expect(result).toEqual({
        entryType: 'comic',
        entriesAffected: 0,
        tagsMoved: 0,
        entriesScanned: 2,
      });
    } finally {
      database.close();
    }
  });

  it('throws when the source Entry does not exist', () => {
    const database = createMigratedMemoryDatabase();
    try {
      createComicLayout(database);
      expect(() => applyEntryTagLayout(database, 9999)).toThrow('entry not found');
    } finally {
      database.close();
    }
  });

  it('aligns one tag across several misplacing peers in a single pass', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const { series, language } = createComicLayout(database);
      const source = createComicEntry(database, 'Standard work');
      assignEntryTag(database, { entryId: source, facetId: series.id, name: 'Azur Lane' });

      const peerOne = createComicEntry(database, 'Peer one');
      assignEntryTag(database, { entryId: peerOne, facetId: language.id, name: 'Azur Lane' });
      const peerTwo = createComicEntry(database, 'Peer two');
      assignEntryTag(database, { entryId: peerTwo, facetId: language.id, name: 'Azur Lane' });

      const result = applyEntryTagLayout(database, source);
      expect(result).toEqual({
        entryType: 'comic',
        entriesAffected: 2,
        tagsMoved: 2,
        entriesScanned: 2,
      });
      expect(facetIdByName(database, peerOne, 'Azur Lane')).toBe(series.id);
      expect(facetIdByName(database, peerTwo, 'Azur Lane')).toBe(series.id);

      // listEntryTags remains a faithful mirror of the moved state.
      const peerTags = listEntryTags(database, peerOne);
      expect(peerTags).toHaveLength(1);
      expect(peerTags[0]).toMatchObject({ name: 'Azur Lane', facetId: series.id });
    } finally {
      database.close();
    }
  });
});

describe('Tag layout HTTP route', () => {
  it('applies the source tag layout and reports moved assignments', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);
    const { series, language, tags } = createComicLayout(database);
    const source = createComicEntry(database, 'Standard work');
    assignEntryTag(database, { entryId: source, facetId: series.id, name: 'Azur Lane' });
    assignEntryTag(database, { entryId: source, facetId: tags.defaultFacetId, name: 'Favorite' });
    const peer = createComicEntry(database, 'Work two');
    assignEntryTag(database, { entryId: peer, facetId: language.id, name: 'Azur Lane' });

    const response = await app.request(`/api/entries/${source}/tag-layout/apply`, {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const result = await response.json() as {
      entryType: string;
      entriesAffected: number;
      tagsMoved: number;
      entriesScanned: number;
      backupPath: string | null;
      foreignKeyCheckPass: boolean;
      doctorPass: boolean;
    };
    expect(result).toMatchObject({
      entryType: 'comic',
      entriesAffected: 1,
      tagsMoved: 1,
      entriesScanned: 1,
      backupPath: null,
      foreignKeyCheckPass: true,
      doctorPass: true,
    });
    expect(facetIdByName(database, peer, 'Azur Lane')).toBe(series.id);

    const missing = await app.request('/api/entries/9999/tag-layout/apply', { method: 'POST' });
    expect(missing.status).toBe(404);
  });
});
