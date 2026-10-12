import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  describeFindings,
  primaryFinding,
  siteprobeLineSchema,
  type SiteprobeFinding,
} from '@t3/shared';
import { loadSiteProbeExport } from '../../src/import/site-probe.js';

/**
 * Phase E's focused check (plan §5-E): the generic export parses to the right entries, and the
 * tool's *structured* failure reaches the boundary the UI reads — never just "0 items".
 *
 * Two halves, and neither is a second importer:
 * * `loadSiteProbeExport` — the existing pure parser — is handed a temporary generic batch and must
 *   yield the right entry count, which is what the review screen counts;
 * * a `result`/`error`/`probe` line carrying `findings` must survive `siteprobeLineSchema`, and
 *   `describeFindings` must name the failing stage with advice — the data boundary the panel reads.
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function writeMetadata(document: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 't3-phase-e-'));
  temporaryDirectories.push(directory);
  const metadataPath = join(directory, 'metadata.json');
  await writeFile(metadataPath, JSON.stringify(document), 'utf8');
  return metadataPath;
}

const finding = (over: Partial<SiteprobeFinding> = {}): SiteprobeFinding => ({
  code: 'WORK_FIELD_EMPTY',
  stage: 'work',
  severity: 'error',
  message: '2 work(s) had no title',
  ...over,
});

describe('the generic export parses to the entries the review counts', () => {
  it('reads a neutral batch into one entry per item', async () => {
    const metadataPath = await writeMetadata({
      source_site: 'demo.test',
      items: [
        { source_site: 'demo.test', source_id: '1', title: 'A work',
          detail_url: 'https://demo.test/work/1' },
        { source_site: 'demo.test', source_id: '2', title: 'Another',
          detail_url: 'https://demo.test/work/2' },
      ],
    });
    const batch = await loadSiteProbeExport(metadataPath);
    expect(batch.source).toBe('demo.test');
    expect(batch.entries).toHaveLength(2);
    expect(batch.entries.map((entry) => entry.externalKey)).toEqual(['demo.test:1', 'demo.test:2']);
  });

  it('keeps the three custom sites strict: a known site that stops matching fails loudly', async () => {
    // A neutral document that names a site with its own schema must NOT be accepted by the neutral
    // branch (plan §5-E.2): the strict schema wins, and a mismatch stays a loud failure.
    const metadataPath = await writeMetadata({
      source_site: '18comic.vip',
      items: [{ source_site: '18comic.vip', source_id: '1', title: 'x',
        detail_url: 'https://18comic.vip/album/1' }],
    });
    await expect(loadSiteProbeExport(metadataPath)).rejects.toThrow();
  });
});

describe('findings reach the UI data boundary', () => {
  it('a result line with findings validates and survives', () => {
    const line = siteprobeLineSchema.safeParse({
      event: 'result', command: 'run', site: 'demo.test', kind: 'search', ref: 'q',
      works: 0, listing: '/tmp/x', export: '/tmp/x/metadata.json', review_html: null,
      origin: null, media: {}, warnings: [], findings: [finding()],
    });
    expect(line.success).toBe(true);
    if (line.success && line.data.event === 'result') {
      expect(line.data.findings?.[0]?.code).toBe('WORK_FIELD_EMPTY');
    }
  });

  it('an error line carries the reason beside its own code', () => {
    const line = siteprobeLineSchema.safeParse({
      event: 'error', command: 'run', code: 'RUN_FAILED', message: 'nothing usable was read',
      findings: [finding({ code: 'LISTING_ROWS_EMPTY', stage: 'listing' })],
    });
    expect(line.success).toBe(true);
  });

  it('a probe line validates and reports its stages', () => {
    const line = siteprobeLineSchema.safeParse({
      event: 'probe', target: 'work', input: 'https://demo.test/work/1', ok: false,
      budget: { seconds: 90, used: 1.2 }, export: null,
      stages: [{ stage: 'work', status: 'failed', detail: '0 work(s) read', findings: [finding()] }],
      findings: [finding()],
    });
    expect(line.success).toBe(true);
  });

  it('describes the worst finding first, with advice and the failing stage', () => {
    const described = describeFindings([
      finding({ code: 'COVER_URL_EMPTY', stage: 'media', severity: 'info', message: 'no cover' }),
      finding({ code: 'LISTING_ROWS_EMPTY', stage: 'listing', severity: 'error',
        message: 'the listing produced no card' }),
    ]);
    expect(described[0]?.code).toBe('LISTING_ROWS_EMPTY');
    expect(described[0]?.stage).toBe('listing');
    expect(described[0]?.advice).toBeTruthy();
    expect(primaryFinding([finding({ severity: 'warning' }), finding({ severity: 'error' })])?.severity)
      .toBe('error');
  });

  it('shows an unknown code rather than dropping it, with no advice', () => {
    const described = describeFindings([finding({ code: 'SOMETHING_NEW' })]);
    expect(described).toHaveLength(1);
    expect(described[0]?.advice).toBeNull();
  });
});
