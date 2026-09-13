/**
 * Diagnoses which hitomi export item fails the importer schema.
 * Run from apps/server: node_modules/.bin/tsx ../../.hermes/tmp/diagnose-hitomi-import.mts [authorFolder]
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/package.json');
const { z } = require('zod') as typeof import('zod');

const EXPORTS = 'D:/Project/Dataextracted/site_probe/hitomi_la/exports';

// Mirrors apps/server/src/import/site-probe.ts
const categorySchema = z.object({
  作品: z.array(z.string()).default([]),
  登场人物: z.array(z.string()).default([]),
  分类标签: z.array(z.string()).default([]),
  作者: z.array(z.string()).default([]),
  作品类型: z.array(z.string()).optional(),
});
const coverSchema = z.object({
  local_path: z.string().min(1).optional(),
  url: z.url().optional(),
  source_path: z.url().optional(),
});
const languageSchema = z.object({ code: z.string(), name: z.string() });
const previewImageSchema = z.object({ local_path: z.string().min(1).optional() });
const hitomiItemSchema = z.object({
  source_site: z.literal('hitomi.la'),
  source_id: z.string().min(1),
  title: z.string().trim().min(1),
  detail_url: z.url(),
  分类信息: categorySchema,
  language: languageSchema.optional(),
  date_added: z.string().optional(),
  page_count: z.number().int().nonnegative().optional(),
  cover: coverSchema.optional(),
  preview_images: z.array(previewImageSchema).optional(),
});
const hitomiManifestSchema = z.object({
  source_site: z.literal('hitomi.la'),
  items: z.array(z.string().regex(/^[A-Za-z0-9._-]+$/u)),
});

const authors = process.argv[2] ? [process.argv[2]] : ['bonnie', 'abe_inori', 'akchu'];
for (const author of authors) {
  const manifestPath = join(EXPORTS, author, 'metadata.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  const manifestResult = hitomiManifestSchema.safeParse(manifest);
  console.log(`\n=== ${author} ===`);
  if (!manifestResult.success) {
    console.log('  manifest rejected:', JSON.stringify(manifestResult.error.issues, null, 2));
    continue;
  }
  console.log(`  manifest ok, ${manifestResult.data.items.length} items`);
  let failures = 0;
  for (const sourceId of manifestResult.data.items) {
    const itemPath = join(EXPORTS, author, 'items', sourceId, 'metadata.json');
    let document: unknown;
    try {
      document = JSON.parse(await readFile(itemPath, 'utf8'));
    } catch (cause) {
      failures += 1;
      console.log(`  [${sourceId}] unreadable: ${(cause as Error).message}`);
      continue;
    }
    const result = hitomiItemSchema.safeParse(document);
    if (!result.success) {
      failures += 1;
      console.log(`  [${sourceId}] REJECTED`);
      for (const issue of result.error.issues) {
        console.log(`      ${issue.path.join('.') || '(root)'}: ${issue.code} — ${issue.message}`);
      }
    }
  }
  console.log(`  failures: ${failures}`);
}
