import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { commitImportBatch } from '../../src/import/commit.js';
import { commitSiteProbeExportPath } from '../../src/import/site-probe-path.js';
import { loadSiteProbeExport } from '../../src/import/site-probe.js';
import { getEntryDetail } from '../../src/repositories/entry-repository.js';

/**
 * The two halves of an import, and what a cut between them leaves.
 *
 * `commitSiteProbeExportPath` commits the library rows inside one transaction and then writes the
 * export's pictures file by file, so only the first half is atomic. A process cut in between — a
 * closed tab, a killed server, a full disk — leaves a work that is *in* the library with none of its
 * pictures, and every later import of the same export skips it, because the work is already there.
 * Measured before this test existed: the work came back with `coverRef: (none)` and `previewRefs: 0`,
 * and importing the same export again reported `created: 0, skippedExisting: 1, mediaStoredCount: 0`.
 *
 * The repair is therefore not "import again and hope": the second half reaches every work the batch
 * names, and writes only the pictures that work is *missing*.
 */
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const OTHER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const MAPPING = {
  entryType: 'comic',
  canonicalTagFacetId: null,
  sourceContentType: 'Source URL',
  externalKeyContentType: 'Source URL',
  fieldMappings: {},
};

/**
 * One work whose export lists a cover and two previews, the second of which *is* the cover.
 *
 * That repetition is a real shape — a site that publishes its cover inside the same container as its
 * previews — and it is what makes "is this picture already stored?" a question about content rather
 * than about counts.
 */
async function exportWithPictures(): Promise<{ exportRoot: string; assetRoot: string; metadata: string }> {
  const root = await mkdtemp(join(tmpdir(), 't3-media-repair-'));
  directories.push(root);
  const exportRoot = join(root, 'export');
  const listing = join(exportRoot, 'demo.test', 'listing_x');
  const item = join(listing, 'items', '42');
  await mkdir(join(item, 'cover'), { recursive: true });
  await mkdir(join(item, 'previews'), { recursive: true });
  await writeFile(join(item, 'cover', 'cover.png'), PNG);
  await writeFile(join(item, 'previews', '1.png'), OTHER_PNG);
  await writeFile(join(item, 'previews', '2.png'), PNG);
  const metadata = join(listing, 'metadata.json');
  await writeFile(metadata, JSON.stringify({
    source_site: 'demo.test',
    origin: { kind: 'search', ref: 'x' },
    items: [{
      source_site: 'demo.test',
      source_id: '42',
      title: 'A work whose commit was cut short',
      detail_url: 'https://demo.test/work/42',
      分类信息: { 作品: [], 登场人物: [], 分类标签: ['demo'], 作者: [] },
      cover: { local_path: 'items/42/cover/cover.png' },
      preview_images: [{ local_path: 'items/42/previews/1.png' },
                       { local_path: 'items/42/previews/2.png' }],
    }],
  }), 'utf8');
  return { exportRoot, assetRoot: join(root, 'assets'), metadata };
}

describe('an import that was cut between its two halves', () => {
  it('is repaired by importing the same export again, and a third import writes nothing', async () => {
    const { exportRoot, assetRoot, metadata } = await exportWithPictures();
    const database = createMigratedMemoryDatabase();
    const batch = await loadSiteProbeExport(metadata);

    // The interruption, exactly: the transaction alone, which is the first half of the commit.
    const interrupted = commitImportBatch(database, batch, MAPPING as never);
    const entryId = interrupted.entries[0]!.entryId;
    expect(getEntryDetail(database, entryId)?.coverRef ?? null).toBeNull();
    expect(getEntryDetail(database, entryId)?.previewRefs ?? []).toHaveLength(0);

    // The re-import. The work is already there, so the rows are skipped — but its pictures are not.
    const second = await commitSiteProbeExportPath(database, assetRoot, exportRoot,
                                                   { batch, mapping: MAPPING } as never);
    expect(second.skippedExistingEntryCount).toBe(1);
    expect(second.mediaRepairedCount).toBe(2);
    const repaired = getEntryDetail(database, entryId);
    expect(repaired?.coverRef).not.toBeNull();
    // One preview, not two: the export's second preview is byte-for-byte the cover, so it is the
    // cover rather than a second layer of the stack.
    expect(repaired?.previewRefs).toHaveLength(1);

    // And it is idempotent: the pictures are all present now, so nothing is written again. Writing a
    // preview twice would *append*, which is a second layer — not a no-op.
    const before = await readdir(join(assetRoot, 'entries', String(entryId)));
    const third = await commitSiteProbeExportPath(database, assetRoot, exportRoot,
                                                  { batch, mapping: MAPPING } as never);
    expect(third.mediaStoredCount).toBe(0);
    expect(getEntryDetail(database, entryId)?.previewRefs).toHaveLength(1);
    expect((await readdir(join(assetRoot, 'entries', String(entryId)))).sort())
      .toEqual(before.sort());
  });

  it('reaches the same end state as a commit that was never interrupted', async () => {
    const { exportRoot, assetRoot, metadata } = await exportWithPictures();
    const batch = await loadSiteProbeExport(metadata);

    const cut = createMigratedMemoryDatabase();
    const firstHalf = commitImportBatch(cut, batch, MAPPING as never);
    await commitSiteProbeExportPath(cut, assetRoot, exportRoot, { batch, mapping: MAPPING } as never);
    const afterRepair = getEntryDetail(cut, firstHalf.entries[0]!.entryId);

    const whole = createMigratedMemoryDatabase();
    const onePiece = await commitSiteProbeExportPath(whole, assetRoot, exportRoot,
                                                     { batch, mapping: MAPPING } as never);
    const control = getEntryDetail(whole, onePiece.entries[0]!.entryId);

    expect(afterRepair?.coverRef).toBe(control?.coverRef);
    expect(afterRepair?.previewRefs).toEqual(control?.previewRefs);
  });

  it('leaves a cover the person chose alone', async () => {
    const { exportRoot, assetRoot, metadata } = await exportWithPictures();
    const database = createMigratedMemoryDatabase();
    const batch = await loadSiteProbeExport(metadata);

    const created = await commitSiteProbeExportPath(database, assetRoot, exportRoot,
                                                    { batch, mapping: MAPPING } as never);
    const entryId = created.entries[0]!.entryId;
    const chosen = getEntryDetail(database, entryId)?.coverRef;
    expect(chosen).not.toBeNull();

    // The cover the work has is the person's — the editor lets them pick one, and a re-import must
    // not undo that. Only an empty cover is filled.
    const again = await commitSiteProbeExportPath(database, assetRoot, exportRoot,
                                                  { batch, mapping: MAPPING } as never);
    expect(again.mediaRepairedCount).toBe(0);
    expect(getEntryDetail(database, entryId)?.coverRef).toBe(chosen);
  });
});
