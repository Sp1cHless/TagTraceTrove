import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { inspectDatabase } from '../../src/database/doctor.js';
import { commitImportBatch } from '../../src/import/commit.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createSection } from '../../src/repositories/layout-repository.js';
import {
  findSiteWork,
  getSiteCrawlSource,
  listSiteCrawlSources,
  partitionKnownSiteWorks,
  recordCrawlObservation,
  recordSiteWork,
  siteWorkOrderKey,
} from '../../src/repositories/site-crawl-repository.js';
import type { ImportBatch, ImportCommitMapping } from '@t3/shared';

function setup(): { database: ReturnType<typeof createMigratedMemoryDatabase>; mapping: ImportCommitMapping } {
  const database = createMigratedMemoryDatabase();
  const section = createSection(database, { entryType: 'comic', name: '分类' });
  return {
    database,
    mapping: {
      entryType: 'comic',
      canonicalTagFacetId: section.defaultFacetId,
      sourceContentType: 'source url',
      externalKeyContentType: 'external key',
      fieldMappings: {},
      ignoredFields: [],
      authorRatings: [],
    },
  };
}

/** A folder listing export: the site identity and the listing cursor both ride on it. */
function folderBatch(works: Array<{ id: string; date?: string; url?: string }>): ImportBatch {
  return {
    source: 'hitomi.la',
    origin: { kind: 'folder', ref: 'folder-42', displayName: 'Folder 42' },
    warnings: [],
    entries: works.map((work) => ({
      externalKey: `hitomi.la:${work.id}`,
      title: `Work ${work.id}`,
      ...(work.date === undefined ? {} : { uploadDate: work.date }),
      sources: [{ url: work.url ?? `https://hitomi.la/galleries/${work.id}.html` }],
    })),
  };
}

function entryIds(database: ReturnType<typeof createMigratedMemoryDatabase>): number[] {
  return database.prepare('SELECT id FROM entries ORDER BY id').pluck().all() as number[];
}

describe('site crawl state', () => {
  it('files every imported work under its site id and leaves the export folder behind', () => {
    const { database, mapping } = setup();
    const listing = { sourceSite: 'hitomi.la', sourceKind: 'folder' as const, sourceRef: 'folder-42' };

    // First harvest: the folder held two works and the export is deleted after.
    const first = commitImportBatch(database, folderBatch([
      { id: '100', date: '2026-01-10' },
      { id: '120', date: '2026-03-05' },
    ]), mapping);

    expect(first.entryCount).toBe(2);
    expect(first.skippedExistingEntryCount).toBe(0);
    expect(database.prepare('SELECT source_site, source_id, entry_id, work_date FROM site_works ORDER BY entry_id').all())
      .toEqual([
        { source_site: 'hitomi.la', source_id: '100', entry_id: 1, work_date: '2026-01-10' },
        { source_site: 'hitomi.la', source_id: '120', entry_id: 2, work_date: '2026-03-05' },
      ]);
    expect(getSiteCrawlSource(database, listing)).toMatchObject({
      sourceSite: 'hitomi.la',
      sourceKind: 'folder',
      sourceRef: 'folder-42',
      displayName: 'Folder 42',
      lastSeenSourceId: '120',
      lastSeenWorkDate: '2026-03-05',
      crawlCount: 1,
      libraryWorkCount: 2,
    });

    // A month later the folder holds two more works and the old export files are
    // gone. The crawler reads the cursor, fetches only the tail, and the two
    // held works are still recognised from the library alone.
    const digest = getSiteCrawlSource(database, listing)!;
    const tailAfterCursor = [
      ['100', '2026-01-10'],
      ['120', '2026-03-05'],
      ['140', '2026-04-01'],
      ['160', '2026-05-02'],
    ].filter(([id, date]) => siteWorkOrderKey(id!, date) > digest.lastSeenOrderKey!).map(([id]) => id);
    const { known, unknown } = partitionKnownSiteWorks(database, 'hitomi.la', ['100', '120', '140', '160']);
    expect(known.map((work) => work.sourceId)).toEqual(['100', '120']);
    expect(unknown).toEqual(['140', '160']);
    // The cursor alone is enough to name the tail: only these sort after it.
    expect(tailAfterCursor).toEqual(['140', '160']);

    const second = commitImportBatch(database, folderBatch([
      { id: '140', date: '2026-04-01' },
      { id: '160', date: '2026-05-02' },
    ]), mapping);

    expect(second.entryCount).toBe(2);
    expect(second.skippedExistingEntryCount).toBe(0);
    expect(entryIds(database)).toEqual([1, 2, 3, 4]);
    expect(getSiteCrawlSource(database, listing)).toMatchObject({
      lastSeenSourceId: '160',
      lastSeenWorkDate: '2026-05-02',
      crawlCount: 2,
      libraryWorkCount: 4,
    });
    expect(inspectDatabase(database).ok).toBe(true);
    database.close();
  });

  it('recognises a held work by its id even when the source re-spelled its URL', () => {
    const { database, mapping } = setup();
    const first = commitImportBatch(database, folderBatch([{ id: '77', date: '2026-02-02' }]), mapping);

    // The same work, re-listed under a new URL scheme. The retained id is the
    // identity, so the library must not grow a second Entry for it.
    const second = commitImportBatch(database, folderBatch([
      { id: '77', date: '2026-02-02', url: 'https://new.hitomi.la/work/77' },
    ]), mapping);

    expect(second.entryCount).toBe(0);
    expect(second.skippedExistingEntryCount).toBe(1);
    expect(second.existingEntryIds).toEqual([first.entries[0]!.entryId]);
    expect(entryIds(database)).toEqual([first.entries[0]!.entryId]);
    expect(database.prepare('SELECT COUNT(*) FROM entry_contents').pluck().get()).toBe(1);
    database.close();
  });

  it('records ids for works the library already held, backfilling a pre-existing library', () => {
    const { database, mapping } = setup();
    // An Entry imported before the crawl state existed: the site id was thrown
    // away, so only the Source URL identifies it.
    const first = commitImportBatch(database, {
      source: 'hitomi.la',
      warnings: [],
      entries: [
        {
          externalKey: 'hitomi.la:5',
          title: 'Older work',
          uploadDate: '2025-12-24',
          sources: [{ url: 'https://hitomi.la/galleries/5.html' }],
        },
      ],
    }, mapping);
    const entryId = first.entries[0]!.entryId;

    // Re-running one export over it records the id and the cursor, without
    // creating anything: the URL match skips, the skip path still files the id.
    const second = commitImportBatch(database, {
      source: 'hitomi.la',
      origin: { kind: 'folder', ref: 'legacy-folder' },
      warnings: [],
      entries: [
        {
          externalKey: 'hitomi.la:5',
          title: 'Older work',
          sources: [{ url: 'https://hitomi.la/galleries/5.html' }],
        },
      ],
    }, mapping);

    expect(second.entryCount).toBe(0);
    expect(findSiteWork(database, 'hitomi.la', '5')).toMatchObject({
      entryId,
      // The export omitted the date; the fallback reads it back from the Entry,
      // so a cursor built from already-held works still advances.
      workDate: '2025-12-24',
    });
    expect(getSiteCrawlSource(database, {
      sourceSite: 'hitomi.la',
      sourceKind: 'folder',
      sourceRef: 'legacy-folder',
    })).toMatchObject({ lastSeenSourceId: '5', lastSeenWorkDate: '2025-12-24' });
    database.close();
  });

  it('keeps a work id and a cursor unchanged when the export carries no origin', () => {
    const { database, mapping } = setup();
    commitImportBatch(database, {
      source: 'hitomi.la',
      warnings: [],
      entries: [{
        externalKey: 'hitomi.la:9',
        title: 'Hand-made manifest work',
        sources: [{ url: 'https://hitomi.la/galleries/9.html' }],
      }],
    }, mapping);

    // A hand-made manifest belongs to no tracked listing, so it leaves an id but
    // no cursor to advance.
    expect(findSiteWork(database, 'hitomi.la', '9')).not.toBeNull();
    expect(listSiteCrawlSources(database)).toEqual([]);
    database.close();
  });

  it('refuses a batch that lists the same work id twice', () => {
    const { database, mapping } = setup();
    expect(() => commitImportBatch(database, folderBatch([
      { id: '11' },
      { id: '11', url: 'https://hitomi.la/galleries/11-again.html' },
    ]), mapping)).toThrow(/Duplicate work id in Import batch: hitomi\.la:11/u);

    // The whole statement rolls back: no Entry, no id, no cursor.
    expect(entryIds(database)).toEqual([]);
    expect(listSiteCrawlSources(database)).toEqual([]);
    database.close();
  });

  it('never pulls a cursor backwards, and counts a visit that found nothing new', () => {
    const { database } = setup();
    const source = { sourceSite: 'hitomi.la', sourceKind: 'artist' as const, sourceRef: 'some-artist' };

    recordCrawlObservation(database, {
      ...source,
      works: [{ sourceId: '500', workDate: '2026-05-01' }],
    });
    // A later run that only re-reads old pages must not move the cursor back.
    const revisited = recordCrawlObservation(database, {
      ...source,
      works: [{ sourceId: '400', workDate: '2026-01-01' }],
    });
    expect(revisited).toMatchObject({
      lastSeenSourceId: '500',
      lastSeenWorkDate: '2026-05-01',
      crawlCount: 2,
    });

    // Nothing new at all: the cursor holds, the visit is still counted.
    const quiet = recordCrawlObservation(database, { ...source, displayName: 'Some Artist' });
    expect(quiet).toMatchObject({
      displayName: 'Some Artist',
      lastSeenSourceId: '500',
      crawlCount: 3,
    });
    database.close();
  });

  it('orders work ids numerically, and keeps an undated work behind a dated one', () => {
    const unordered = ['100', '9', '10', '1024', '2'];
    expect([...unordered].sort((left, right) => (
      siteWorkOrderKey(left, null) < siteWorkOrderKey(right, null) ? -1 : 1
    ))).toEqual(['2', '9', '10', '100', '1024']);

    // A site that publishes no dates still gets a pure id ordering.
    expect(siteWorkOrderKey('9', null) < siteWorkOrderKey('10', null)).toBe(true);
    // A dated work always outranks the same work without its date, so a work
    // the site dated late can never be skipped as "already passed".
    expect(siteWorkOrderKey('1', null) < siteWorkOrderKey('1', '2026-01-01')).toBe(true);
    expect(siteWorkOrderKey('1', '2026-01-01') < siteWorkOrderKey('1', '2026-01-02')).toBe(true);
    // Non-numeric ids keep a stable, if arbitrary, order.
    expect(siteWorkOrderKey('abc', null) < siteWorkOrderKey('abd', null)).toBe(true);
  });

  it('keeps the first sighting of a work that keeps arriving from new folders', () => {
    const { database } = setup();
    const entry = createEntry(database, { title: 'Work 31', type: 'comic' });
    const created = recordSiteWork(database, {
      sourceSite: 'hitomi.la',
      sourceId: '31',
      entryId: entry.id,
      detailUrl: 'https://hitomi.la/galleries/31.html',
      workDate: '2026-01-01',
    });
    database.prepare("UPDATE site_works SET first_seen_at = '2020-01-01 00:00:00'").run();

    const seenAgain = recordSiteWork(database, {
      sourceSite: 'hitomi.la',
      sourceId: '31',
      entryId: entry.id,
      workDate: '2026-01-01',
    });

    expect(seenAgain.firstSeenAt).toBe('2020-01-01 00:00:00');
    expect(seenAgain.detailUrl).toBe(created.detailUrl);
    expect(database.prepare('SELECT COUNT(*) FROM site_works').pluck().get()).toBe(1);
    database.close();
  });
});

describe('a search that is an author', () => {
  const authorBatch = (keyword: string, works: Array<{ id: string; date?: string; authors: string[] }>) => ({
    source: '18comic.vip',
    origin: { kind: 'search' as const, ref: keyword },
    warnings: [],
    entries: works.map((work) => ({
      externalKey: `18comic.vip:${work.id}`,
      title: `Work ${work.id}`,
      ...(work.date === undefined ? {} : { uploadDate: work.date }),
      fields: { authors: work.authors },
      sources: [{ url: `https://18comic.vip/album/${work.id}/` }],
    })),
  });

  it('registers the creator as an author, and not as a second spelling', () => {
    const database = createMigratedMemoryDatabase();
    const section = createSection(database, { entryType: 'comic', name: '分类' });
    const mapping = {
      entryType: 'comic',
      canonicalTagFacetId: section.defaultFacetId,
      sourceContentType: 'source url',
      externalKeyContentType: 'external key',
      fieldMappings: {
        authors: { kind: 'producer' as const, createUnmatched: true, existingProducerIds: {} },
      },
      ignoredFields: [],
      authorRatings: [],
    };

    // The keyword is the author, though the card spells it differently.
    commitImportBatch(database, authorBatch('kakao', [
      { id: '1', date: '2026-01-01', authors: ['Kakao'] },
      { id: '2', date: '2026-05-05', authors: ['Kakao'] },
    ]), mapping);

    const sources = listSiteCrawlSources(database, '18comic.vip');
    const search = sources.find((source) => source.sourceKind === 'search');
    const author = sources.find((source) => source.sourceKind === 'artist');
    expect(search?.sourceRef).toBe('kakao');
    // One author row, keyed by the normalised name, displaying the card's spelling.
    expect(author?.sourceRef).toBe('kakao');
    expect(author?.displayName).toBe('Kakao');
    expect(author?.lastSeenSourceId).toBe('2');
    expect(author?.lastSeenWorkDate).toBe('2026-05-05');
    database.close();
  });

  it('records no author when the keyword is not one', () => {
    const database = createMigratedMemoryDatabase();
    const section = createSection(database, { entryType: 'comic', name: '分类' });
    const mapping = {
      entryType: 'comic',
      canonicalTagFacetId: section.defaultFacetId,
      sourceContentType: 'source url',
      externalKeyContentType: 'external key',
      fieldMappings: {
        authors: { kind: 'producer' as const, createUnmatched: true, existingProducerIds: {} },
      },
      ignoredFields: [],
      authorRatings: [],
    };

    // A tag search: many creators, none of them the keyword. Their works are in the
    // library either way, so nothing is invented as an author.
    commitImportBatch(database, authorBatch('full color', [
      { id: '10', date: '2026-01-01', authors: ['Alpha'] },
      { id: '11', date: '2026-02-02', authors: ['Beta'] },
    ]), mapping);

    const sources = listSiteCrawlSources(database, '18comic.vip');
    expect(sources.map((source) => source.sourceKind)).toEqual(['search']);
    expect(database.prepare('SELECT COUNT(*) FROM producers').pluck().get()).toBe(2);
    database.close();
  });
});
