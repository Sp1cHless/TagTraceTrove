import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import type { T3Database } from '../../src/database/connection.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createEntryContent } from '../../src/repositories/entry-content-repository.js';
import {
  createRun,
  getRun,
  listRunItems,
  updateRunStatus,
} from '../../src/source-maintenance/repository.js';
import {
  executeSearchRun,
  markRunningRunsPaused,
} from '../../src/source-maintenance/job-manager.js';
import { fakeAdapter } from '../../src/source-maintenance/adapters/fake.js';
import { ProviderRateLimitedError, type TitleCatalogProvider } from '../../src/source-maintenance/catalog-provider.js';
import type { SourceSearchAdapter, AdapterCandidate } from '../../src/source-maintenance/source-search-adapter.js';

function seedDatabase(): { database: T3Database; entryIds: number[] } {
  const database = createMigratedMemoryDatabase();
  const entryIds = [
    seed(database, 'Blue Box', 'https://hitomi.la/g/1.html'),
    seed(database, 'Other Work', 'https://hitomi.la/g/2.html'),
    seed(database, 'Third Work', 'https://hitomi.la/g/3.html'),
  ];
  return { database, entryIds };
}

function seed(database: T3Database, title: string, url: string): number {
  const entry = createEntry(database, { title, type: 'comic' });
  createEntryContent(database, {
    entryId: entry.id,
    contentType: 'Source URL',
    content: url,
    sortOrder: 0,
  });
  return entry.id;
}

function makeRun(database: T3Database): number {
  return createRun(database, {
    originSourceKey: 'known:hitomi',
    adapterKey: 'fake',
    targetOrigin: 'https://fake.test',
    markOriginInvalid: false,
    settings: {},
  }).id;
}

const catalogProvider: TitleCatalogProvider = {
  key: 'fixture',
  async lookup({ value }) {
    if (value.includes('blue box')) {
      return [{
        providerId: 'fixture:blue-box',
        titles: [
          { value: 'Blue Box', kind: 'title' },
          { value: 'Ao no Hako', kind: 'romaji' },
          { value: '青色之箱', kind: 'alias' },
        ],
        creators: ['MIURA Kouji'],
        externalIds: { fixture: 'blue-box' },
      }];
    }
    return [];
  },
};

describe('search job manager', () => {
  it('processes every origin entry once and finishes in review', async () => {
    const { database } = seedDatabase();
    try {
      const runId = makeRun(database);
      const outcome = await executeSearchRun(database, runId, {
        adapter: fakeAdapter,
        catalogProviders: [catalogProvider],
        delay: async () => undefined,
      });
      expect(outcome).toBe('review');
      const run = getRun(database, runId)!;
      expect(run.status).toBe('review');
      expect(run.counts).toEqual({ total: 3, processed: 3, matched: 1, ambiguous: 0, noMatch: 2, errors: 0 });

      // 'Blue Box' resolves through the fixture catalog alias graph and the
      // fake target: unique alias hit + work kind + creator evidence.
      const items = listRunItems(database, runId, 1, 20, 'all').items;
      const blueBox = items.find((item) => item.entryTitleSnapshot === 'Blue Box')!;
      console.log('DBG errorText:', blueBox.errorText);
      expect(blueBox.candidates.length).toBeGreaterThan(0);
      expect(blueBox.candidates.map((candidate) => candidate.band)).toContain('exact-safe');
      expect(blueBox.selectedUrl).toBe('https://fake.test/work/100');
      // The query budget keeps the full title plus separator variants only.
      expect(blueBox.queryTitles).toEqual(['blue box']);
    } finally {
      database.close();
    }
  });

  it('pauses between entries when the status flips and resumes without redoing work', async () => {
    const { database } = seedDatabase();
    try {
      const runId = makeRun(database);
      let processed = 0;
      const pausingDelay = async () => {
        processed += 1;
        if (processed === 1) updateRunStatus(database, runId, 'paused');
        await Promise.resolve();
      };
      const firstOutcome = await executeSearchRun(database, runId, {
        adapter: fakeAdapter, catalogProviders: [catalogProvider], delay: pausingDelay,
      });
      expect(firstOutcome).toBe('paused');
      const pausedRun = getRun(database, runId)!;
      expect(pausedRun.status).toBe('paused');
      expect(pausedRun.counts.processed).toBe(1);

      const secondOutcome = await executeSearchRun(database, runId, {
        adapter: fakeAdapter, catalogProviders: [catalogProvider], delay: async () => undefined,
      });
      expect(secondOutcome).toBe('review');
      const resumed = getRun(database, runId)!;
      expect(resumed.counts.total).toBe(3);
      expect(resumed.counts.processed).toBe(3);
    } finally {
      database.close();
    }
  });

  it('stops for cancelled runs and keeps already processed checkpoints', async () => {
    const { database } = seedDatabase();
    try {
      const runId = makeRun(database);
      let processed = 0;
      const cancellingDelay = async () => {
        processed += 1;
        if (processed === 1) updateRunStatus(database, runId, 'cancelled');
        await Promise.resolve();
      };
      const outcome = await executeSearchRun(database, runId, {
        adapter: fakeAdapter, catalogProviders: [catalogProvider], delay: cancellingDelay,
      });
      expect(outcome).toBe('cancelled');
      const run = getRun(database, runId)!;
      expect(run.status).toBe('cancelled');
      expect(run.counts.processed).toBe(1);
      // Restart cannot resurrect a cancelled run.
      expect(await executeSearchRun(database, runId, {
        adapter: fakeAdapter, catalogProviders: [catalogProvider], delay: async () => undefined,
      })).toBe('missing');
    } finally {
      database.close();
    }
  });

  it('persists per-entry adapter errors and still completes the run', async () => {
    const { database } = seedDatabase();
    try {
      const failing: SourceSearchAdapter = {
        ...fakeAdapter,
        async search({ title }) {
          if (title === 'blue box') throw new Error('adapter exploded');
          return [];
        },
      };
      const runId = makeRun(database);
      const outcome = await executeSearchRun(database, runId, {
        adapter: failing, catalogProviders: [catalogProvider], delay: async () => undefined,
      });
      expect(outcome).toBe('review');
      const run = getRun(database, runId)!;
      expect(run.counts.errors).toBe(1);
      expect(run.counts.processed).toBe(3);
      const failed = listRunItems(database, runId, 1, 20, 'unresolved').items
        .find((item) => item.errorText !== null);
      expect(failed?.errorText).toBe('adapter exploded');
    } finally {
      database.close();
    }
  });

  it('pauses the run when the target rate limits and leaves an error checkpoint', async () => {
    const { database } = seedDatabase();
    try {
      const rateLimited: SourceSearchAdapter = {
        ...fakeAdapter,
        async search() {
          throw new ProviderRateLimitedError(30_000);
        },
      };
      const runId = makeRun(database);
      const outcome = await executeSearchRun(database, runId, {
        adapter: rateLimited, catalogProviders: [catalogProvider], delay: async () => undefined,
      });
      expect(outcome).toBe('paused');
      const run = getRun(database, runId)!;
      expect(run.status).toBe('paused');
      expect(run.counts.errors).toBe(1);
    } finally {
      database.close();
    }
  });

  it('merges adapter candidates by canonical URL across query variants', async () => {
    const { database } = seedDatabase();
    try {
      const duplicating: SourceSearchAdapter = {
        ...fakeAdapter,
        async search({ title }): Promise<AdapterCandidate[]> {
          const base = await fakeAdapter.search({ title, signal: AbortSignal.timeout(1000) });
          return [...base, ...base];
        },
      };
      const runId = makeRun(database);
      await executeSearchRun(database, runId, {
        adapter: duplicating, catalogProviders: [catalogProvider], delay: async () => undefined,
      });
      const items = listRunItems(database, runId, 1, 20, 'all').items;
      const blueBox = items.find((item) => item.entryTitleSnapshot === 'Blue Box')!;
      console.log('DBG errorText:', blueBox.errorText);
      const urls = blueBox.candidates.map((candidate) => candidate.url);
      expect(new Set(urls).size).toBe(urls.length);
    } finally {
      database.close();
    }
  });

  it('marks running runs paused on startup recovery', async () => {
    const { database } = seedDatabase();
    try {
      const runId = makeRun(database);
      updateRunStatus(database, runId, 'running');
      expect(markRunningRunsPaused(database)).toBe(1);
      expect(getRun(database, runId)!.status).toBe('paused');
      expect(markRunningRunsPaused(database)).toBe(0);
    } finally {
      database.close();
    }
  });
});
