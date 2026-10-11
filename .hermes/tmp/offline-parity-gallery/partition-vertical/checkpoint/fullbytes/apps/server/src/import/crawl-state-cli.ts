import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../database/connection.js';
import { applyAllMigrations } from '../database/migrations.js';
import {
  getSiteCrawlSource,
  listSiteCrawlSources,
  partitionKnownSiteWorks,
  recordCrawlObservation,
  type SiteCrawlSourceKind,
} from '../repositories/site-crawl-repository.js';

/**
 * The crawl-state interface of a site_probe crawler. Update runs read a cursor
 * here before listing a site and report the visit back afterwards, so a folder
 * or author ingested months ago is not fetched a second time in full:
 *
 *   pnpm import:cursor status --site hitomi.la --kind artist --ref some-artist
 *   pnpm import:cursor filter --site hitomi.la --ids-file folder.json
 *   pnpm import:cursor set --site hitomi.la --kind folder --ref 12345 \
 *     --source-id 3220586 --work-date 2026-08-01 --commit
 *
 * Every command prints one JSON document on stdout. `filter` is the exact
 * answer for sites whose ids carry no usable order: list the folder, ask, and
 * fetch only the ids it reports as unknown.
 */

const USAGE = `Usage:
  pnpm import:cursor list   [--site <site>] [--db <path>]
  pnpm import:cursor status --site <site> --kind <kind> --ref <ref> [--db <path>]
  pnpm import:cursor filter --site <site> (--ids <a,b,c> | --ids-file <path>) [--db <path>]
  pnpm import:cursor set    --site <site> --kind <kind> --ref <ref>
                            [--source-id <id>] [--work-date <YYYY-MM-DD>]
                            [--display-name <name>] [--url <url>] --commit

  kind is one of: artist, folder, work, search
  --db defaults to apps/server/.data/library.db under the repo root.
  Commands other than 'set' never write; 'set' requires --commit.`;

const SOURCE_KINDS: ReadonlyArray<SiteCrawlSourceKind> = ['artist', 'folder', 'work', 'search'];

interface Flags {
  command: string;
  values: Map<string, string>;
  has: (name: string) => boolean;
  get: (name: string) => string | undefined;
}

function parseFlags(args: ReadonlyArray<string>): Flags | null {
  const [command, ...rest] = args;
  if (command === undefined) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith('--')) return null;
    const name = token.slice(2);
    if (name === 'commit') {
      values.set(name, 'true');
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) return null;
    values.set(name, value);
    index += 1;
  }
  return {
    command,
    values,
    has: (name) => values.has(name),
    get: (name) => values.get(name),
  };
}

function fail(message: string): never {
  console.error(message);
  console.error(USAGE);
  process.exit(1);
}

function requireFlag(flags: Flags, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value.trim() === '') fail(`Missing --${name}`);
  return value.trim();
}

function requireSourceKind(flags: Flags): SiteCrawlSourceKind {
  const raw = requireFlag(flags, 'kind');
  if (!SOURCE_KINDS.includes(raw as SiteCrawlSourceKind)) {
    fail(`--kind must be one of ${SOURCE_KINDS.join(', ')}`);
  }
  return raw as SiteCrawlSourceKind;
}

/** A listing the crawler writes out: a bare JSON array, a hitomi manifest, or plain lines. */
function readIdsDocument(rawText: string): string[] {
  const text = rawText.trim();
  if (text.startsWith('[') || text.startsWith('{')) {
    const document: unknown = JSON.parse(text);
    const items = Array.isArray(document)
      ? document
      : (document as { items?: unknown }).items;
    if (!Array.isArray(items)) {
      fail('The ids file must be a JSON array or an object with an "items" array');
    }
    return items.map((item) => {
      if (typeof item !== 'string' || item.trim() === '') {
        fail('Every id in the ids file must be a non-empty string');
      }
      return item.trim();
    });
  }
  return text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '');
}

const invocationRoot = process.env.INIT_CWD ?? process.cwd();
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(USAGE);
  process.exit(1);
}
const flags = parseFlags(args);
if (flags === null) fail('Unrecognized arguments: expected a subcommand followed by --flag value pairs');

const explicitDatabase = flags.get('db');
const candidatePaths = explicitDatabase !== undefined
  ? [resolve(invocationRoot, explicitDatabase)]
  : [
      resolve(invocationRoot, 'apps/server/.data/library.db'),
      resolve(invocationRoot, '.data/library.db'),
    ];
const databasePath = candidatePaths.find((candidate) => existsSync(candidate));
if (databasePath === undefined) {
  fail(`No library database found. Looked in: ${candidatePaths.join(', ')}`);
}

const database = openDatabase(databasePath);
try {
  // The crawl state lives in its own migration, and a crawler running ahead of
  // the server should not have to understand "no such table". Applying the
  // outstanding immutable migrations here matches `import:commit`.
  applyAllMigrations(database);
  switch (flags.command) {
    case 'list': {
      const site = flags.get('site');
      console.log(JSON.stringify({
        database: databasePath,
        sources: listSiteCrawlSources(database, site),
      }, null, 2));
      break;
    }
    case 'status': {
      const source = getSiteCrawlSource(database, {
        sourceSite: requireFlag(flags, 'site'),
        sourceKind: requireSourceKind(flags),
        sourceRef: requireFlag(flags, 'ref'),
      });
      console.log(JSON.stringify({ database: databasePath, source }, null, 2));
      break;
    }
    case 'filter': {
      const site = requireFlag(flags, 'site');
      const idsFile = flags.get('ids-file');
      const ids = idsFile !== undefined
        ? readIdsDocument(readFileSync(resolve(invocationRoot, idsFile), 'utf8'))
        : requireFlag(flags, 'ids').split(',').map((id) => id.trim()).filter((id) => id !== '');
      const { known, unknown } = partitionKnownSiteWorks(database, site, ids);
      console.log(JSON.stringify({
        database: databasePath,
        site,
        knownCount: known.length,
        unknownCount: unknown.length,
        known: known.map((work) => ({
          sourceId: work.sourceId,
          entryId: work.entryId,
          workDate: work.workDate,
        })),
        unknown,
      }, null, 2));
      break;
    }
    case 'set': {
      if (!flags.has('commit')) fail('Recording a cursor writes to the library; pass --commit');
      const sourceId = flags.get('source-id');
      const workDate = flags.get('work-date');
      const source = recordCrawlObservation(database, {
        sourceSite: requireFlag(flags, 'site'),
        sourceKind: requireSourceKind(flags),
        sourceRef: requireFlag(flags, 'ref'),
        displayName: flags.get('display-name') ?? null,
        url: flags.get('url') ?? null,
        works: sourceId === undefined ? [] : [{ sourceId, workDate: workDate ?? null }],
      });
      console.log(JSON.stringify({ database: databasePath, source }, null, 2));
      break;
    }
    default:
      fail(`Unknown command "${flags.command}"`);
  }
} finally {
  database.close();
}
