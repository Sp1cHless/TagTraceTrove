import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { buildTitleVariants } from './title-variants.js';
import { bandCandidates } from './evidence.js';
import { createEhentaiAdapter } from './adapters/ehentai.js';

/**
 * Live dry-run for Source maintenance (plan §B10: "Staging/live adapter 只
 * 搜索少量授权样本，不 commit 正式库"): pick a few random Entries of one
 * Source group from the FORMAL library — read-only, nothing is ever written
 * — search a live target for each, and print the evidence-banded candidates
 * exactly as the Advanced review would show them.
 *
 * Usage (needs a Node that can load better-sqlite3):
 *   tsx src/source-maintenance/live-match-cli.ts [sourceKey] [count]
 *   e.g. tsx src/source-maintenance/live-match-cli.ts known:hitomi 3
 */

const ORIGIN_SOURCE_KEY = process.argv[2] ?? 'known:hitomi';
const SAMPLE_COUNT = Math.max(1, Math.min(10, Number(process.argv[3] ?? 3) || 3));
const DATABASE_PATH = fileURLToPath(new URL('../../.data/library.db', import.meta.url));

interface PickedEntry {
  entryId: number;
  title: string;
  originUrl: string;
}

function extractHttpUrls(content: string): string[] {
  return content.match(/https?:\/\/[^\s<>"']+/giu) ?? [];
}

function pickRandomEntries(database: InstanceType<typeof Database>, count: number): PickedEntry[] {
  const rows = database.prepare(`
    SELECT s.entry_id AS entryId, e.title, s.content
    FROM entry_contents AS s
    JOIN entries AS e ON e.id = s.entry_id
    WHERE s.content LIKE '%hitomi.la%'
    ORDER BY s.entry_id, s.sort_order, s.id
  `).all() as Array<{ entryId: number; title: string; content: string }>;

  const byEntry = new Map<number, PickedEntry>();
  for (const row of rows) {
    if (byEntry.has(row.entryId)) continue;
    const originUrl = extractHttpUrls(row.content).find((url) => url.includes('hitomi.la'));
    if (originUrl !== undefined) {
      byEntry.set(row.entryId, { entryId: row.entryId, title: row.title, originUrl });
    }
  }

  const all = [...byEntry.values()];
  for (let i = all.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j]!, all[i]!];
  }
  return all.slice(0, count);
}

const adapter = createEhentaiAdapter();

async function main(): Promise<void> {
  const database = new Database(DATABASE_PATH, { readonly: true, fileMustExist: true });
  database.pragma('query_only = 1');
  try {
    const entries = pickRandomEntries(database, SAMPLE_COUNT);
    if (entries.length === 0) {
      console.log(`no entries with ${ORIGIN_SOURCE_KEY} URLs found in the library`);
      return;
    }
    console.log(`live dry-run: ${entries.length} random Entries from ${ORIGIN_SOURCE_KEY} -> E-Hentai`);
    console.log('(read-only; nothing will be written to the library)\n');

    let exact = 0;
    let withCandidates = 0;
    let noMatch = 0;
    let failed = 0;

    for (const entry of entries) {
      console.log(`Entry #${entry.entryId}: ${entry.title}`);
      console.log(`  origin: ${entry.originUrl}`);
      let candidates;
      try {
        candidates = await adapter.search({ title: entry.title, signal: new AbortController().signal });
      } catch (cause) {
        failed += 1;
        console.log(`  ERROR: ${cause instanceof Error ? cause.message : String(cause)}`);
        continue;
      }
      const variants = buildTitleVariants(entry.title);
      // hitomi slugs end in the mirrored e-hentai gallery id:
      // ...-3133339.html -> ehentai:3133339
      const originIds = [...entry.originUrl.matchAll(/-(\d+)\.html/gu)]
        .map((match) => `ehentai:${match[1]}`);
      const banded = bandCandidates(candidates, {
        trustedTitles: variants.map((value) => ({ value, kind: 'title' as const })),
        originExternalIds: originIds,
        isUrlOwnedByOtherEntry: () => false,
      }).slice(0, 3);

      if (banded.length === 0) {
        noMatch += 1;
        console.log('  no candidates');
      } else {
        withCandidates += 1;
      }
      for (const candidate of banded) {
        if (candidate.band === 'exact-safe') exact += 1;
        const tags = ((candidate.adapterEvidence?.tags as string[] | undefined) ?? [])
          .filter((tag) => tag.startsWith('parody:') || tag.startsWith('artist:') || tag.startsWith('group:'))
          .slice(0, 3)
          .join(', ');
        console.log(`  [${candidate.band}] ${candidate.title}`);
        console.log(`      ${candidate.url}${tags === '' ? '' : `  | ${tags}`}`);
        console.log(`      reasons: ${candidate.reasons.join('; ')}`);
      }
      // Politeness: e-hentai enforces request quotas aggressively.
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    console.log('\nsummary:');
    console.log(`  entries: ${entries.length} | entries with candidates: ${withCandidates} | exact-safe hits: ${exact} | no-match: ${noMatch} | errors: ${failed}`);
    console.log('nothing was written to the library.');
  } finally {
    database.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
