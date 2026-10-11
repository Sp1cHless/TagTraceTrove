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
import { createMangabzAdapter } from '../../src/source-maintenance/adapters/mangabz.js';
import { createEhentaiAdapter } from '../../src/source-maintenance/adapters/ehentai.js';
import { createManhuaguiAdapter } from '../../src/source-maintenance/adapters/manhuagui.js';
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
      expect(run.counts).toEqual({ total: 3, processed: 3, matched: 1, ambiguous: 1, noMatch: 2, errors: 0 });

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

  it('keeps candidate catalog identities distinct and bridges an origin gallery id without auto-selection', async () => {
    const { database } = seedDatabase();
    try {
      const adapter: SourceSearchAdapter = {
        ...fakeAdapter,
        async search({ title }) {
          if (title !== 'blue box') return [];
          return [
            { url: 'https://fake.test/work/3133339', title: 'Unrelated label', catalogIds: ['ehentai:3133339'], adapterEvidence: {} },
            { url: 'https://fake.test/work/other', title: 'Different work', catalogIds: ['ehentai:999', 'blue-box'], adapterEvidence: {} },
            { url: 'https://fake.test/work/stranger', title: 'Stranger', catalogIds: ['ehentai:888'], adapterEvidence: {} },
          ];
        },
      };
      const entryId = seed(database, 'Blue Box', 'https://hitomi.la/g/blue-box-3133339.html');
      const runId = makeRun(database);
      expect(await executeSearchRun(database, runId, {
        adapter, catalogProviders: [catalogProvider], delay: async () => undefined,
      })).toBe('review');
      const item = listRunItems(database, runId, 1, 20, 'all').items.find((row) => row.entryId === entryId)!;
      expect(item.errorText).toBeNull();
      const byUrl = new Map(item.candidates.map((candidate) => [candidate.url, candidate]));
      expect(byUrl.get('https://fake.test/work/3133339')).toMatchObject({
        catalogIds: ['ehentai:3133339'], band: 'strong-review',
        reasons: ['external id equals the id embedded in the origin source URL'],
      });
      expect(byUrl.get('https://fake.test/work/other')).toMatchObject({
        catalogIds: ['ehentai:999', 'blue-box'], band: 'strong-review',
        reasons: expect.arrayContaining(['resolved to the same external catalog identity']),
      });
      expect(byUrl.get('https://fake.test/work/stranger')).toMatchObject({
        catalogIds: ['ehentai:888'], band: 'ambiguous',
        reasons: ['no trusted identity evidence (similarity alone is never eligible)'],
      });
      expect(item.selectedUrl).toBeNull();
    } finally {
      database.close();
    }
  });

  it('flags a target URL shared by this Entry and another Entry as conflict before review', async () => {
    const { database, entryIds } = seedDatabase();
    try {
      for (const entryId of entryIds.slice(0, 2)) {
        createEntryContent(database, {
          entryId, contentType: 'Source URL', content: 'https://fake.test/work/100', sortOrder: 1,
        });
      }
      const runId = makeRun(database);
      expect(await executeSearchRun(database, runId, {
        adapter: fakeAdapter, catalogProviders: [catalogProvider], delay: async () => undefined,
      })).toBe('review');
      const item = listRunItems(database, runId, 1, 20, 'all').items.find((row) => row.entryId === entryIds[0])!;
      expect(item.candidates.find((candidate) => candidate.url === 'https://fake.test/work/100')?.band).toBe('conflict');
      expect(item.selectedUrl).toBeNull();
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

  it.each([429, 503, 509, 403])('pauses on real E-Hentai HTTP %i without checkpointing later entries', async (status) => {
    const { database } = seedDatabase();
    try {
      let calls = 0;
      const adapter = createEhentaiAdapter(async () => {
        calls += 1;
        return new Response('', { status, headers: { 'retry-after': '30' } });
      });
      const runId = makeRun(database);
      expect(await executeSearchRun(database, runId, {
        adapter, delay: async () => undefined,
      })).toBe('paused');
      expect(calls).toBe(1);
      expect(getRun(database, runId)!.counts).toMatchObject({ processed: 1, errors: 1 });
      expect(listRunItems(database, runId, 1, 20, 'all').items).toHaveLength(1);
    } finally { database.close(); }
  });

  it.each([429, 503, 509])('pauses on real Mangabz HTTP %i', async (status) => {
    const { database } = seedDatabase();
    try {
      let calls = 0;
      const adapter = createMangabzAdapter(async () => {
        calls += 1;
        return new Response('', { status });
      });
      const runId = makeRun(database);
      expect(await executeSearchRun(database, runId, { adapter, delay: async () => undefined })).toBe('paused');
      expect(calls).toBe(1);
      expect(getRun(database, runId)!.counts.processed).toBe(1);
    } finally { database.close(); }
  });

  it('pauses on real template-based Manhuagui HTTP 403', async () => {
    const { database } = seedDatabase();
    try {
      let calls = 0;
      const adapter = createManhuaguiAdapter(async () => {
        calls += 1;
        return new Response('', { status: 403 });
      });
      const runId = makeRun(database);
      expect(await executeSearchRun(database, runId, { adapter, delay: async () => undefined })).toBe('paused');
      expect(calls).toBe(1);
      expect(getRun(database, runId)!.counts.processed).toBe(1);
    } finally { database.close(); }
  });

  it('does not swallow a catalog provider rate limit before target search', async () => {
    const { database } = seedDatabase();
    try {
      let targetCalls = 0;
      const adapter: SourceSearchAdapter = { ...fakeAdapter, async search() { targetCalls += 1; return []; } };
      const provider: TitleCatalogProvider = {
        key: 'limited',
        async lookup() { throw new ProviderRateLimitedError(30_000); },
      };
      const runId = makeRun(database);
      expect(await executeSearchRun(database, runId, {
        adapter, catalogProviders: [provider], delay: async () => undefined,
      })).toBe('paused');
      expect(targetCalls).toBe(0);
      expect(getRun(database, runId)!.counts.processed).toBe(1);
    } finally { database.close(); }
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
