import type { T3Database } from '../database/connection.js';
import type { SourceCandidate } from '@t3/shared';
import { normalizeTag } from '@t3/shared';
import {
  ProviderRateLimitedError,
  type CatalogWork,
  type TitleCatalogProvider,
} from './catalog-provider.js';
import { buildTitleVariants } from './title-variants.js';
import { bandCandidates, type BandedCandidate } from './evidence.js';
import {
  getItem,
  getRun,
  updateRunStatus,
  upsertItem,
} from './repository.js';
import {
  listEntryIdsBySourceKey,
  listEntrySources,
  listAllEntrySources,
} from '../repositories/source-library-repository.js';
import type { SourceSearchAdapter } from './source-search-adapter.js';

/**
 * Resumable Source-maintenance search job (plan §15 Step 3, §B7). The loop
 * processes one Entry at a time, persists a checkpoint item after each, and
 * re-reads the run status from the database between items — pause and cancel
 * are plain status flips, so a server restart can never silently continue a
 * network job and a pause can never lose completed work. Concurrency is 1
 * per adapter by design.
 */

export interface SearchRunOptions {
  adapter: SourceSearchAdapter;
  catalogProviders?: TitleCatalogProvider[];
  /** Injectable clock for deterministic tests; defaults to real setTimeout. */
  delay?: (ms: number) => Promise<void>;
}

const PAUSE_BEFORE_NEXT_ENTRY_MS = 50;

const defaultDelay = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

interface OriginFacts {
  title: string;
  originUrls: string[];
}

function originFacts(database: T3Database, sourceKey: string, entryId: number): OriginFacts | null {
  const title = database.prepare('SELECT title FROM entries WHERE id = ?')
    .pluck().get(entryId) as string | undefined;
  if (title === undefined) return null;
  const originUrls = listEntrySources(database, entryId)
    .filter((source) => source.sourceKey === sourceKey)
    .map((source) => source.url);
  return { title, originUrls };
}

async function collectCatalogWorks(
  providers: TitleCatalogProvider[],
  variants: string[],
  signal: AbortSignal,
): Promise<CatalogWork[]> {
  const works: CatalogWork[] = [];
  const seenProviderIds = new Set<string>();
  for (const variant of variants) {
    for (const provider of providers) {
      try {
        for (const work of await provider.lookup({ value: variant }, signal)) {
          if (!seenProviderIds.has(work.providerId)) {
            seenProviderIds.add(work.providerId);
            works.push(work);
          }
        }
      } catch {
        // Provider failure only lowers evidence quality; it never fails the run.
      }
    }
  }
  return works;
}

function trustedTitlesFromCatalog(works: CatalogWork[], entryTitle: string) {
  const normalizedEntry = normalizeTag(entryTitle);
  const matched = works.filter((work) => work.titles.some((title) => (
    normalizeTag(title.value) === normalizedEntry && title.kind === 'title'
  )));
  const trusted: Array<{ value: string; kind: 'title' | 'alias' | 'romaji' }> = [
    { value: entryTitle, kind: 'title' },
  ];
  const seen = new Set<string>([normalizedEntry]);
  const catalogIds: string[] = [];
  const creators: string[] = [];
  for (const work of matched) {
    catalogIds.push(...Object.values(work.externalIds));
    for (const creator of work.creators) {
      if (!creators.some((existing) => normalizeTag(existing) === normalizeTag(creator))) {
        creators.push(creator);
      }
    }
    for (const title of work.titles) {
      const normalized = normalizeTag(title.value);
      if (normalized === '' || seen.has(normalized)) continue;
      seen.add(normalized);
      trusted.push({ value: title.value, kind: title.kind === 'title' ? 'alias' : title.kind });
    }
  }
  return { trusted, catalogIds: [...new Set(catalogIds)], creators };
}

export async function executeSearchRun(
  database: T3Database,
  runId: number,
  options: SearchRunOptions,
): Promise<'review' | 'paused' | 'cancelled' | 'missing'> {
  const run = getRun(database, runId);
  if (run === null || run.status === 'committed' || run.status === 'cancelled') return 'missing';
  const { adapter } = options;
  const delay = options.delay ?? defaultDelay;

  const entryIds = listEntryIdsBySourceKey(database, run.originSourceKey);

  // URL ownership across the whole library, cached once per run pass.
  const ownership = new Map<string, Set<number>>();
  for (const source of listAllEntrySources(database)) {
    const owners = ownership.get(source.url) ?? new Set<number>();
    owners.add(source.entryId);
    ownership.set(source.url, owners);
  }

  const runSignal = new AbortController();
  updateRunStatus(database, runId, 'running');

  for (const entryId of entryIds) {
    // Pause and cancel are durable status flips the loop honours between items.
    const current = getRun(database, runId);
    if (current === null || current.status !== 'running') {
      runSignal.abort();
      return current?.status === 'paused' ? 'paused'
        : current?.status === 'cancelled' ? 'cancelled' : 'paused';
    }
    // Resume support: entries with a checkpoint item are already processed.
    if (getItem(database, runId, entryId) !== null) continue;

    const facts = originFacts(database, run.originSourceKey, entryId);
    if (facts === null) continue;

    try {
      const variants = buildTitleVariants(facts.title);
      const catalogWorks = options.catalogProviders
        ? await collectCatalogWorks(options.catalogProviders, variants, runSignal.signal)
        : [];
      const { trusted, catalogIds, creators } = trustedTitlesFromCatalog(catalogWorks, facts.title);

      const merged = new Map<string, SourceCandidate>();
      for (const variant of variants) {
        await delay(adapter.rateLimit.minDelayMs);
        const candidates = await adapter.search({ title: variant, signal: runSignal.signal });
        for (const candidate of candidates) {
          const canonicalUrl = adapter.canonicalizeItemUrl(new URL(candidate.url));
          const existing = merged.get(canonicalUrl);
          if (existing) {
            existing.adapterEvidence = {
              ...existing.adapterEvidence,
              queries: [...(Array.isArray(existing.adapterEvidence.queries)
                ? existing.adapterEvidence.queries : []), variant],
            };
            continue;
          }
          merged.set(canonicalUrl, {
            url: canonicalUrl,
            title: candidate.title,
            ...(candidate.language === undefined ? {} : { language: candidate.language }),
            ...(candidate.creators === undefined ? {} : { creators: candidate.creators }),
            ...(candidate.workKind === undefined ? {} : { workKind: candidate.workKind }),
            ...(candidate.thumbnailUrl === undefined ? {} : { thumbnailUrl: candidate.thumbnailUrl }),
            band: 'ambiguous',
            reasons: [],
            adapterEvidence: { ...candidate.adapterEvidence, queries: [variant] },
          });
        }
      }

      const rawCandidates = [...merged.values()].map((candidate) => ({
        url: candidate.url,
        title: candidate.title,
        ...(candidate.language === undefined ? {} : { language: candidate.language }),
        ...(candidate.creators === undefined ? {} : { creators: candidate.creators }),
        ...(candidate.workKind === undefined ? {} : { workKind: candidate.workKind }),
        ...(candidate.thumbnailUrl === undefined ? {} : { thumbnailUrl: candidate.thumbnailUrl }),
        catalogIds,
      }));
      const banded: BandedCandidate[] = bandCandidates(
        rawCandidates,
        {
          trustedTitles: trusted,
          entryCatalogIds: catalogIds,
          entryCreators: creators,
          isUrlOwnedByOtherEntry: (url) => {
            const owners = ownership.get(url);
            return owners !== undefined && owners.has(entryId) === false && owners.size > 0;
          },
        },
      );

      const defaultSelection = banded.find((candidate) => candidate.band === 'exact-safe');
      const candidateRecords: SourceCandidate[] = banded.slice(0, 20).map((candidate) => ({
        url: candidate.url,
        title: candidate.title,
        ...(candidate.language === undefined ? {} : { language: candidate.language }),
        ...(candidate.creators === undefined ? {} : { creators: candidate.creators }),
        ...(candidate.workKind === undefined ? {} : { workKind: candidate.workKind }),
        ...(candidate.thumbnailUrl === undefined ? {} : { thumbnailUrl: candidate.thumbnailUrl }),
        ...(candidate.catalogIds === undefined ? {} : { catalogIds: candidate.catalogIds }),
        band: candidate.band,
        reasons: candidate.reasons,
        adapterEvidence: candidate.adapterEvidence ?? {},
      }));
      upsertItem(database, runId, {
        entryId,
        entryTitleSnapshot: facts.title,
        originUrls: facts.originUrls,
        queryTitles: variants,
        candidates: candidateRecords,
        decision: 'pending',
        selectedUrl: defaultSelection?.url ?? null,
      });
      if (adapter.rateLimit.minDelayMs > 0) {
        await delay(PAUSE_BEFORE_NEXT_ENTRY_MS);
      }
    } catch (cause) {
      if (cause instanceof ProviderRateLimitedError) {
        // Persist the partial state and pause; never retry in a tight loop.
        upsertItem(database, runId, {
          entryId,
          entryTitleSnapshot: facts.title,
          originUrls: facts.originUrls,
          errorText: 'catalog or target rate limited; run paused for review',
        });
        updateRunStatus(database, runId, 'paused');
        return 'paused';
      }
      upsertItem(database, runId, {
        entryId,
        entryTitleSnapshot: facts.title,
        originUrls: facts.originUrls,
        errorText: cause instanceof Error ? cause.message.slice(0, 480) : String(cause).slice(0, 480),
      });
    }
  }

  const finalRun = getRun(database, runId);
  if (finalRun === null) return 'missing';
  if (finalRun.status === 'running') {
    updateRunStatus(database, runId, 'review');
    return 'review';
  }
  runSignal.abort();
  return finalRun.status === 'cancelled' ? 'cancelled' : 'paused';
}

/** Server-startup recovery: a run that was mid-flight when the process died
 * becomes 'paused'; the user must explicitly Resume it (plan §17). */
export function markRunningRunsPaused(database: T3Database): number {
  const result = database.prepare(`
    UPDATE source_maintenance_runs
    SET status = 'paused', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'running'
  `).run();
  return result.changes;
}
