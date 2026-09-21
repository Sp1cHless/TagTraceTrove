import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  importBatchSchema,
  type ImportBatch,
  type ImportBatchOrigin,
  type ImportEntry,
} from '@t3/shared';
import { z } from 'zod';

/**
 * Which listing the export was harvested from. A crawler that walks one author,
 * folder or search fills this in so the library can keep its update cursor; an
 * export without it still imports, it just records no cursor. The key is
 * snake_case like every other field of an export document.
 */
const originSchema = z.object({
  kind: z.enum(['artist', 'folder', 'work', 'search']),
  ref: z.string().trim().min(1),
  display_name: z.string().trim().min(1).optional(),
  url: z.url().optional(),
});

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

const languageSchema = z.object({
  code: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
});
const previewImageSchema = z.object({
  local_path: z.string().min(1).optional(),
});

const comicItemSchema = z.object({
  source_site: z.literal('18comic.vip'),
  origin: originSchema.optional(),
  source_id: z.string().min(1),
  title: z.string().trim().min(1),
  detail_url: z.url(),
  分类信息: categorySchema,
  language: languageSchema.optional(),
  date_added: z.string().nullable().optional(),
  page_count: z.number().int().nonnegative().nullable().optional(),
  cover: coverSchema.optional(),
  preview_images: z.array(previewImageSchema).optional(),
});

const comicExportSchema = z.object({
  source_site: z.literal('18comic.vip'),
  origin: originSchema.optional(),
  items: z.array(comicItemSchema),
});

const hanimeItemSchema = z.object({
  source_site: z.literal('hanime1.me'),
  origin: originSchema.optional(),
  source_id: z.string().min(1),
  title: z.string().trim().min(1),
  video_url: z.url(),
  author: z.string().trim().min(1),
  source_tags_raw: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  分类信息: categorySchema.optional(),
  language: languageSchema.optional(),
  date_added: z.string().nullable().optional(),
  page_count: z.number().int().nonnegative().nullable().optional(),
  cover: coverSchema.optional(),
  preview_images: z.array(previewImageSchema).optional(),
});

const hanimeExportSchema = z.object({
  source_site: z.literal('hanime1.me'),
  origin: originSchema.optional(),
  items: z.array(hanimeItemSchema),
});

const hitomiManifestSchema = z.object({
  source_site: z.literal('hitomi.la'),
  origin: originSchema.optional(),
  items: z.array(z.string().regex(/^[A-Za-z0-9._-]+$/u)),
});

const hitomiItemSchema = z.object({
  source_site: z.literal('hitomi.la'),
  origin: originSchema.optional(),
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

/**
 * The fallback shape: any site, and only the fields that survive with no site
 * rule.
 *
 * Level 0 reads a URL no folder under `tool/` claims, and can promise a title and
 * a cover and nothing else. This document therefore asks for the work's identity
 * and those two fields, and leaves every other field absent rather than empty —
 * an empty 分类信息 becomes a tag review full of nothing.
 *
 * It is tried last, and only for a site that has no schema of its own: the three
 * site schemas above are stricter on purpose, and an export for a known site that
 * stops matching its own schema must keep failing loudly rather than quietly
 * importing here with empty tags.
 */
const neutralItemSchema = z.object({
  schema_version: z.number().int().optional(),
  source_site: z.string().trim().min(1),
  origin: originSchema.optional(),
  source_id: z.string().min(1),
  title: z.string().trim().min(1),
  detail_url: z.url(),
  cover: coverSchema.optional(),
  分类信息: categorySchema.optional(),
  language: languageSchema.optional(),
  date_added: z.string().nullable().optional(),
  page_count: z.number().int().nonnegative().nullable().optional(),
  preview_images: z.array(previewImageSchema).optional(),
});

const SITES_WITH_OWN_SCHEMA = new Set(['18comic.vip', 'hanime1.me', 'hitomi.la']);

export interface SiteProbeLoadOptions {
  preserveRelativeMediaPaths?: boolean;
}

/** Renders schema issues as `field: reason` pairs so a bad export names its own field. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function adaptOrigin(
  origin: z.infer<typeof originSchema> | undefined,
): ImportBatchOrigin | undefined {
  if (origin === undefined) return undefined;
  return {
    kind: origin.kind,
    ref: origin.ref,
    ...(origin.display_name === undefined ? {} : { displayName: origin.display_name }),
    ...(origin.url === undefined ? {} : { url: origin.url }),
  };
}

function resolveLocalPath(
  exportRoot: string,
  localPath: string,
  options: SiteProbeLoadOptions,
): string {
  const resolvedPath = resolve(exportRoot, localPath);
  const relativePath = relative(exportRoot, resolvedPath);

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Local media path escapes the export root: ${localPath}`);
  }

  return options.preserveRelativeMediaPaths
    ? relativePath.split(sep).join('/')
    : resolvedPath;
}

interface ItemMediaPaths {
  source_id: string;
  cover?: { local_path?: string | undefined } | undefined;
  preview_images?: Array<{ local_path?: string | undefined }> | undefined;
}

function directItemMediaPaths(item: ItemMediaPaths): {
  coverPath?: string;
  previewPaths: string[];
} {
  const itemPrefix = `items/${item.source_id}/`;
  const makeRelative = (path: string): string => {
    const portable = path.replaceAll('\\', '/');
    return portable.startsWith(itemPrefix) ? portable.slice(itemPrefix.length) : portable;
  };
  const coverPath = item.cover?.local_path
    ? makeRelative(item.cover.local_path)
    : undefined;
  const previewPaths = item.preview_images
    ?.map((image) => image.local_path)
    .filter((path): path is string => !!path)
    .map(makeRelative) ?? [];
  return { ...(coverPath ? { coverPath } : {}), previewPaths };
}

/**
 * Sites like 18comic also list the work's language among their plain tags
 * (分类标签 contains 中文 while `language.name` is 中文 too). Keeping both
 * makes commit collide: the same name would land on the canonical Tags Facet
 * AND the mapped Language Facet. Language is carried by the `language` field,
 * so the duplicated plain-tag entry is dropped.
 */
function excludeLanguageTag(
  names: string[],
  languageName: string | null | undefined,
): string[] {
  if (!languageName) return names;
  const excluded = languageName.normalize('NFKC').trim().toLocaleLowerCase();
  if (!excluded) return names;
  return names.filter((name) => (
    name.normalize('NFKC').trim().toLocaleLowerCase() !== excluded
  ));
}

function adaptComicItem(
  item: z.infer<typeof comicItemSchema>,
  exportRoot: string,
  options: SiteProbeLoadOptions,
  coverPath = item.cover?.local_path,
  previewPaths = item.preview_images
    ?.map((image) => image.local_path)
    .filter((path): path is string => !!path) ?? [],
): ImportEntry {
  const cover = coverPath
    ? resolveLocalPath(exportRoot, coverPath, options)
    : item.cover?.url;
  const previews = previewPaths.map((path) => resolveLocalPath(exportRoot, path, options));
  const uploadDate = item.date_added ? item.date_added.slice(0, 10) : undefined;

  return {
    externalKey: `${item.source_site}:${item.source_id}`,
    title: item.title,
    ...(cover ? { cover } : {}),
    ...(previews[0] ? { preview: previews[0] } : {}),
    ...(previews.length > 0 ? { previews } : {}),
    ...(uploadDate ? { uploadDate } : {}),
    ...(item.page_count === null || item.page_count === undefined ? {} : { pageCount: item.page_count }),
    tags: excludeLanguageTag(item.分类信息.分类标签, item.language?.name)
      .map((name) => ({ name, sourceField: '分类标签' })),
    fields: {
      works: item.分类信息.作品,
      characters: item.分类信息.登场人物,
      authors: item.分类信息.作者,
      ...(item.分类信息.作品类型 ? { contentTypes: item.分类信息.作品类型 } : {}),
      ...(item.language?.name ? { language: [item.language.name] } : {}),
    },
    sources: [{ label: item.source_site, url: item.detail_url }],
  };
}

function adaptHanimeItem(
  item: z.infer<typeof hanimeItemSchema>,
  exportRoot: string,
  options: SiteProbeLoadOptions,
  coverPath = item.cover?.local_path,
  previewPaths = item.preview_images
    ?.map((image) => image.local_path)
    .filter((path): path is string => !!path) ?? [],
): ImportEntry {
  const cover = coverPath
    ? resolveLocalPath(exportRoot, coverPath, options)
    : item.cover?.source_path;
  const previews = previewPaths.map((path) => resolveLocalPath(exportRoot, path, options));
  const uploadDate = item.date_added ? item.date_added.slice(0, 10) : undefined;
  const categories = item.分类信息;

  return {
    externalKey: `${item.source_site}:${item.source_id}`,
    title: item.title,
    ...(cover ? { cover } : {}),
    ...(previews[0] ? { preview: previews[0] } : {}),
    ...(previews.length > 0 ? { previews } : {}),
    ...(uploadDate ? { uploadDate } : {}),
    ...(item.page_count === null || item.page_count === undefined ? {} : { pageCount: item.page_count }),
    tags: excludeLanguageTag(categories?.分类标签 ?? item.tags, item.language?.name).map((name) => ({
      name,
      sourceField: categories ? '分类标签' : 'tags',
    })),
    fields: {
      ...(categories ? {
        works: categories.作品,
        characters: categories.登场人物,
      } : {}),
      authors: categories?.作者.length ? categories.作者 : [item.author],
      ...(categories?.作品类型 ? { contentTypes: categories.作品类型 } : {}),
      ...(item.language?.name ? { language: [item.language.name] } : {}),
      sourceTagsRaw: item.source_tags_raw,
    },
    sources: [{ label: item.source_site, url: item.video_url }],
  };
}

function adaptHitomiItem(
  item: z.infer<typeof hitomiItemSchema>,
  exportRoot: string,
  options: SiteProbeLoadOptions,
  coverPath = item.cover?.local_path,
  previewPath = item.preview_images?.[0]?.local_path,
  previewPaths = item.preview_images?.map((image) => image.local_path).filter((path): path is string => !!path) ?? [],
): ImportEntry {
  const cover = coverPath
    ? resolveLocalPath(exportRoot, coverPath, options)
    : undefined;
  const previews = previewPaths
    .map((path) => resolveLocalPath(exportRoot, path, options))
    .filter((path): path is string => !!path);
  const preview = previewPath
    ? resolveLocalPath(exportRoot, previewPath, options)
    : previews[0];
  const uploadDate = item.date_added ? item.date_added.slice(0, 10) : undefined;

  return {
    externalKey: `${item.source_site}:${item.source_id}`,
    title: item.title,
    ...(cover ? { cover } : {}),
    ...(preview ? { preview } : {}),
    ...(previews.length > 0 ? { previews } : {}),
    ...(uploadDate ? { uploadDate } : {}),
    ...(item.page_count === undefined ? {} : { pageCount: item.page_count }),
    tags: excludeLanguageTag(item.分类信息.分类标签, item.language?.name)
      .map((name) => ({ name, sourceField: '分类标签' })),
    fields: {
      works: item.分类信息.作品,
      characters: item.分类信息.登场人物,
      authors: item.分类信息.作者,
      contentTypes: item.分类信息.作品类型 ?? [],
      ...(item.language?.name ? { language: [item.language.name] } : {}),
    },
    sources: [{ label: item.source_site, url: item.detail_url }],
  };
}

/**
 * The Level 0 item. Every field beyond the title and the cover is optional here,
 * so an absent 分类信息 stays absent instead of arriving as an empty tag list.
 */
function adaptNeutralItem(
  item: z.infer<typeof neutralItemSchema>,
  exportRoot: string,
  options: SiteProbeLoadOptions,
  coverPath = item.cover?.local_path,
  previewPaths = item.preview_images
    ?.map((image) => image.local_path)
    .filter((path): path is string => !!path) ?? [],
): ImportEntry {
  const cover = coverPath
    ? resolveLocalPath(exportRoot, coverPath, options)
    : item.cover?.url;
  const previews = previewPaths.map((path) => resolveLocalPath(exportRoot, path, options));
  const uploadDate = item.date_added ? item.date_added.slice(0, 10) : undefined;
  const categories = item.分类信息;

  return {
    externalKey: `${item.source_site}:${item.source_id}`,
    title: item.title,
    ...(cover ? { cover } : {}),
    ...(previews[0] ? { preview: previews[0] } : {}),
    ...(previews.length > 0 ? { previews } : {}),
    ...(uploadDate ? { uploadDate } : {}),
    ...(item.page_count === null || item.page_count === undefined ? {} : { pageCount: item.page_count }),
    tags: (categories?.分类标签 ?? []).map((name) => ({ name, sourceField: '分类标签' })),
    ...(categories ? {
      fields: {
        works: categories.作品,
        characters: categories.登场人物,
        authors: categories.作者,
        ...(categories.作品类型 ? { contentTypes: categories.作品类型 } : {}),
        ...(item.language?.name ? { language: [item.language.name] } : {}),
      },
    } : {}),
    sources: [{ label: item.source_site, url: item.detail_url }],
  };
}

export async function loadSiteProbeExport(
  metadataPath: string,
  options: SiteProbeLoadOptions = {},
): Promise<ImportBatch> {
  const rawDocument: unknown = JSON.parse(await readFile(metadataPath, 'utf8'));
  const exportRoot = dirname(metadataPath);
  const comicResult = comicExportSchema.safeParse(rawDocument);

  if (comicResult.success) {
    const comicOrigin = adaptOrigin(comicResult.data.origin);
    return importBatchSchema.parse({
      source: comicResult.data.source_site,
      ...(comicOrigin ? { origin: comicOrigin } : {}),
      entries: comicResult.data.items.map((item) => adaptComicItem(item, exportRoot, options)),
      warnings: [],
    });
  }

  const hanimeResult = hanimeExportSchema.safeParse(rawDocument);
  if (hanimeResult.success) {
    const hanimeOrigin = adaptOrigin(hanimeResult.data.origin);
    return importBatchSchema.parse({
      source: hanimeResult.data.source_site,
      ...(hanimeOrigin ? { origin: hanimeOrigin } : {}),
      entries: hanimeResult.data.items.map((item) => adaptHanimeItem(item, exportRoot, options)),
      warnings: [],
    });
  }

  const comicItemResult = comicItemSchema.safeParse(rawDocument);
  if (comicItemResult.success) {
    const item = comicItemResult.data;
    const media = directItemMediaPaths(item);
    const origin = adaptOrigin(item.origin);
    return importBatchSchema.parse({
      source: item.source_site,
      ...(origin ? { origin } : {}),
      entries: [adaptComicItem(item, exportRoot, options, media.coverPath, media.previewPaths)],
      warnings: [],
    });
  }

  const hanimeItemResult = hanimeItemSchema.safeParse(rawDocument);
  if (hanimeItemResult.success) {
    const item = hanimeItemResult.data;
    const media = directItemMediaPaths(item);
    const origin = adaptOrigin(item.origin);
    return importBatchSchema.parse({
      source: item.source_site,
      ...(origin ? { origin } : {}),
      entries: [adaptHanimeItem(item, exportRoot, options, media.coverPath, media.previewPaths)],
      warnings: [],
    });
  }

  const hitomiItemResult = hitomiItemSchema.safeParse(rawDocument);
  if (hitomiItemResult.success) {
    const item = hitomiItemResult.data;
    const media = directItemMediaPaths(item);
    const origin = adaptOrigin(item.origin);
    return importBatchSchema.parse({
      source: item.source_site,
      ...(origin ? { origin } : {}),
      entries: [adaptHitomiItem(item, exportRoot, options, media.coverPath, media.previewPaths[0], media.previewPaths)],
      warnings: [],
    });
  }

  const hitomiManifestResult = hitomiManifestSchema.safeParse(rawDocument);
  if (hitomiManifestResult.success) {
    const warnings: string[] = [];
    const entries: ImportEntry[] = [];
    const manifestOrigin = adaptOrigin(hitomiManifestResult.data.origin);
    for (const sourceId of hitomiManifestResult.data.items) {
      const relativeItemPath = `items/${sourceId}/metadata.json`;
      const itemPath = resolveLocalPath(exportRoot, relativeItemPath, {});
      let itemDocument: unknown;
      try {
        itemDocument = JSON.parse(await readFile(itemPath, 'utf8'));
      } catch (cause) {
        // A manifest can outlive an item folder (an interrupted extraction
        // leaves the id behind). One absent work must not block the folder.
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
          warnings.push(`Skipped work ${sourceId}: ${relativeItemPath} is missing`);
          continue;
        }
        throw new Error(`Export work ${sourceId} could not be read: ${(cause as Error).message}`);
      }
      const parsedItem = hitomiItemSchema.safeParse(itemDocument);
      if (!parsedItem.success) {
        throw new Error(
          `Export work ${sourceId} does not match the hitomi.la export schema: `
          + describeIssues(parsedItem.error),
        );
      }
      entries.push(adaptHitomiItem(parsedItem.data, exportRoot, options));
    }

    return importBatchSchema.parse({
      source: hitomiManifestResult.data.source_site,
      ...(manifestOrigin ? { origin: manifestOrigin } : {}),
      entries,
      warnings,
    });
  }

  const neutralResult = neutralItemSchema.safeParse(rawDocument);
  if (neutralResult.success && !SITES_WITH_OWN_SCHEMA.has(neutralResult.data.source_site)) {
    const item = neutralResult.data;
    const media = directItemMediaPaths(item);
    const origin = adaptOrigin(item.origin);
    return importBatchSchema.parse({
      source: item.source_site,
      ...(origin ? { origin } : {}),
      entries: [adaptNeutralItem(item, exportRoot, options, media.coverPath, media.previewPaths)],
      warnings: [],
    });
  }

  throw new Error('Unsupported site_probe export format');
}