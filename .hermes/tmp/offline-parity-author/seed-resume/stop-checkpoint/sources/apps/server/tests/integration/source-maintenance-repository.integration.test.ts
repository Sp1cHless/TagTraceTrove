import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import type { T3Database } from '../../src/database/connection.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createEntryContent } from '../../src/repositories/entry-content-repository.js';
import {
  listSourceLibrary,
} from '../../src/repositories/source-library-repository.js';
import {
  createRun,
  deleteRun,
  getItem,
  getRun,
  getSourceStatus,
  listItemEntries,
  listRunItems,
  listRunsByStatus,
  listSourceStatuses,
  patchItem,
  setSourceStatus,
  updateRunStatus,
  upsertItem,
} from '../../src/source-maintenance/repository.js';

function seedEntryWithSource(
  database: T3Database,
  title: string,
  url: string,
): number {
  const entry = createEntry(database, { title, type: 'comic' });
  createEntryContent(database, {
    entryId: entry.id,
    contentType: 'Source URL',
    content: url,
    sortOrder: 0,
  });
  return entry.id;
}

describe('source status overlay', () => {
  it('annotates a derived Source group without changing derived membership', () => {
    const database = createMigratedMemoryDatabase();
    try {
      seedEntryWithSource(database, 'Work A', 'https://hitomi.la/a.html');
      seedEntryWithSource(database, 'Work B', 'https://hitomi.la/b.html');

      const before = listSourceLibrary(database).find((source) => source.sourceKey === 'known:hitomi');
      expect(before).toMatchObject({ entryCount: 2, entryUrlCount: 2, state: 'active', statusNote: null });

      setSourceStatus(database, 'known:hitomi', 'invalid', 'site moved to example.test');
      const after = listSourceLibrary(database).find((source) => source.sourceKey === 'known:hitomi');
      // The annotation changes the badge only; membership and URL counts are identical.
      expect(after).toMatchObject({ entryCount: 2, entryUrlCount: 2, state: 'invalid', statusNote: 'site moved to example.test' });
      expect(getSourceStatus(database, 'known:hitomi')).toMatchObject({ state: 'invalid' });
      expect(listSourceStatuses(database)).toHaveLength(1);

      // Re-marking active restores the neutral view; Content stays untouched.
      setSourceStatus(database, 'known:hitomi', 'active', '');
      expect(listSourceLibrary(database).find((source) => source.sourceKey === 'known:hitomi'))
        .toMatchObject({ state: 'active', statusNote: null });
      expect(getSourceStatus(database, 'unknown:nothing')).toBeNull();
    } finally {
      database.close();
    }
  });
});

describe('source maintenance runs and items', () => {
  it('persists a run, checkpoints items and derives counts', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const entryA = seedEntryWithSource(database, 'Blue box', 'https://hitomi.la/a.html');
      const entryB = seedEntryWithSource(database, 'Other work', 'https://hitomi.la/b.html');

      const run = createRun(database, {
        originSourceKey: 'known:hitomi',
        adapterKey: 'fake',
        targetOrigin: 'https://fake.test',
        markOriginInvalid: true,
        settings: { note: 'first migration batch' },
      });
      expect(run).toMatchObject({ status: 'draft', markOriginInvalid: true, counts: expect.objectContaining({ total: 0 }) });

      updateRunStatus(database, run.id, 'running');
      upsertItem(database, run.id, {
        entryId: entryA,
        entryTitleSnapshot: 'Blue box',
        originUrls: ['https://hitomi.la/a.html'],
        queryTitles: ['blue box'],
        candidates: [{
          url: 'https://fake.test/work/1',
          title: 'Blue box',
          band: 'exact-safe',
          reasons: ['normalized title equals trusted title'],
          adapterEvidence: { query: 'blue box' },
        }],
      });
      upsertItem(database, run.id, {
        entryId: entryB,
        entryTitleSnapshot: 'Other work',
        originUrls: ['https://hitomi.la/b.html'],
        errorText: 'adapter rate limit exhausted',
      });

      const running = getRun(database, run.id)!;
      expect(running.status).toBe('running');
      expect(running.counts).toEqual({ total: 2, processed: 2, matched: 1, ambiguous: 0, noMatch: 0, errors: 1 });
      expect(listRunsByStatus(database, 'running')).toHaveLength(1);

      const itemA = getItem(database, run.id, entryA)!;
      expect(itemA.candidates[0]).toMatchObject({ url: 'https://fake.test/work/1', band: 'exact-safe' });

      patchItem(database, run.id, entryA, { decision: 'accept', selectedUrl: 'https://fake.test/work/1' });
      expect(getItem(database, run.id, entryA)).toMatchObject({ decision: 'accept', selectedUrl: 'https://fake.test/work/1' });

      const pendingPage = listRunItems(database, run.id, 1, 20, 'pending');
      expect(pendingPage.total).toBe(1);
      expect(pendingPage.items[0]?.entryId).toBe(entryB);
      const acceptedPage = listRunItems(database, run.id, 1, 20, 'accepted');
      expect(acceptedPage.total).toBe(1);

      expect(listItemEntries(database, run.id)).toEqual([
        { entryId: entryA, decision: 'accept', selectedUrl: 'https://fake.test/work/1' },
        { entryId: entryB, decision: 'pending', selectedUrl: null },
      ]);
    } finally {
      database.close();
    }
  });

  it('cascades item deletion with the run and keeps per-run isolation', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const entry = seedEntryWithSource(database, 'Isolated', 'https://hitomi.la/c.html');
      const first = createRun(database, {
        originSourceKey: 'known:hitomi', adapterKey: 'fake', targetOrigin: 'https://fake.test',
        markOriginInvalid: false, settings: {},
      });
      const second = createRun(database, {
        originSourceKey: 'known:hitomi', adapterKey: 'fake', targetOrigin: 'https://fake.test',
        markOriginInvalid: false, settings: {},
      });
      upsertItem(database, first.id, { entryId: entry, entryTitleSnapshot: 'Isolated', originUrls: [] });
      upsertItem(database, second.id, { entryId: entry, entryTitleSnapshot: 'Isolated', originUrls: [] });

      deleteRun(database, first.id);
      expect(getRun(database, first.id)).toBeNull();
      expect(getItem(database, first.id, entry)).toBeNull();
      // The second run keeps its own item snapshot untouched.
      expect(getItem(database, second.id, entry)).not.toBeNull();
    } finally {
      database.close();
    }
  });

  it('rejects item rows that point at missing entries', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const run = createRun(database, {
        originSourceKey: 'known:hitomi', adapterKey: 'fake', targetOrigin: '',
        markOriginInvalid: false, settings: {},
      });
      expect(() => upsertItem(database, run.id, {
        entryId: 999_999,
        entryTitleSnapshot: 'Ghost',
        originUrls: [],
      })).toThrow();
    } finally {
      database.close();
    }
  });
});
