/**
 * Scans every hitomi author export for importer-schema violations.
 * Run from apps/server: node_modules/.bin/tsx ../../.hermes/tmp/scan-hitomi-imports.mts
 */
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/package.json');
const { z } = require('zod') as typeof import('zod');

const EXPORTS = 'D:/Project/Dataextracted/site_probe/hitomi_la/exports';

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

const issueTally = new Map<string, number>();
const affectedAuthors: string[] = [];
let scannedAuthors = 0;
let scannedItems = 0;
let rejectedItems = 0;

for (const entry of await readdir(EXPORTS, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(EXPORTS, entry.name, 'metadata.json'), 'utf8'));
  } catch {
    continue;
  }
  const parsed = hitomiManifestSchema.safeParse(manifest);
  if (!parsed.success) continue;
  scannedAuthors += 1;
  let authorFailures = 0;
  for (const sourceId of parsed.data.items) {
    try {
      const document: unknown = JSON.parse(
        await readFile(join(EXPORTS, entry.name, 'items', sourceId, 'metadata.json'), 'utf8'),
      );
      scannedItems += 1;
      const result = hitomiItemSchema.safeParse(document);
      if (!result.success) {
        rejectedItems += 1;
        authorFailures += 1;
        for (const issue of result.error.issues) {
          const key = `${issue.path.join('.') || '(root)'}: ${issue.code} (${issue.message})`;
          issueTally.set(key, (issueTally.get(key) ?? 0) + 1);
        }
      }
    } catch (cause) {
      rejectedItems += 1;
      authorFailures += 1;
      const key = `unreadable: ${(cause as Error).message.slice(0, 60)}`;
      issueTally.set(key, (issueTally.get(key) ?? 0) + 1);
    }
  }
  if (authorFailures > 0) affectedAuthors.push(`${entry.name} (${authorFailures})`);
}

console.log(`scanned ${scannedAuthors} author folders, ${scannedItems} items`);
console.log(`rejected items: ${rejectedItems}`);
console.log(`affected authors (${affectedAuthors.length}): ${affectedAuthors.join(', ') || 'none'}`);
console.log('issue tally:');
for (const [key, count] of [...issueTally].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${count} × ${key}`);
}
