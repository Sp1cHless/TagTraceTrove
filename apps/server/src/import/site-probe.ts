import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { importBatchSchema, type ImportBatch, type ImportEntry } from '@t3/shared';
import { z } from 'zod';

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
const previewImageSchema = z.object({
  local_path: z.string().min(1).optional(),
});

const comicItemSchema = z.object({
  source_site: z.literal('18comic.vip'),
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
  items: z.array(comicItemSchema),
});

const hanimeItemSchema = z.object({
  source_site: z.literal('hanime1.me'),
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
  items: z.array(hanimeItemSchema),
});

const hitomiManifestSchema = z.object({
  source_site: z.literal('hitomi.la'),
  items: z.array(z.string().regex(/^[A-Za-z0-9._-]+$/u)),
});

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

export interface SiteProbeLoadOptions {
  preserveRelativeMediaPaths?: boolean;
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
  languageName: string | undefined,
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
      ...(item.language ? { language: [item.language.name] } : {}),
    },
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
    return importBatchSchema.parse({
      source: comicResult.data.source_site,
      entries: comicResult.data.items.map((item) => adaptComicItem(item, exportRoot, options)),
      warnings: [],
    });
  }

  const hanimeResult = hanimeExportSchema.safeParse(rawDocument);
  if (hanimeResult.success) {
    return importBatchSchema.parse({
      source: hanimeResult.data.source_site,
      entries: hanimeResult.data.items.map((item) => adaptHanimeItem(item, exportRoot, options)),
      warnings: [],
    });
  }

  const comicItemResult = comicItemSchema.safeParse(rawDocument);
  if (comicItemResult.success) {
    const item = comicItemResult.data;
    const media = directItemMediaPaths(item);
    return importBatchSchema.parse({
      source: item.source_site,
      entries: [adaptComicItem(item, exportRoot, options, media.coverPath, media.previewPaths)],
      warnings: [],
    });
  }

  const hanimeItemResult = hanimeItemSchema.safeParse(rawDocument);
  if (hanimeItemResult.success) {
    const item = hanimeItemResult.data;
    const media = directItemMediaPaths(item);
    return importBatchSchema.parse({
      source: item.source_site,
      entries: [adaptHanimeItem(item, exportRoot, options, media.coverPath, media.previewPaths)],
      warnings: [],
    });
  }

  const hitomiItemResult = hitomiItemSchema.safeParse(rawDocument);
  if (hitomiItemResult.success) {
    const item = hitomiItemResult.data;
    const media = directItemMediaPaths(item);
    return importBatchSchema.parse({
      source: item.source_site,
      entries: [adaptHitomiItem(item, exportRoot, options, media.coverPath, media.previewPaths[0], media.previewPaths)],
      warnings: [],
    });
  }

  const hitomiManifestResult = hitomiManifestSchema.safeParse(rawDocument);
  if (hitomiManifestResult.success) {
    const entries = await Promise.all(
      hitomiManifestResult.data.items.map(async (sourceId) => {
        const itemPath = resolveLocalPath(exportRoot, `items/${sourceId}/metadata.json`, {});
        const itemDocument: unknown = JSON.parse(await readFile(itemPath, 'utf8'));
        return adaptHitomiItem(hitomiItemSchema.parse(itemDocument), exportRoot, options);
      }),
    );

    return importBatchSchema.parse({
      source: hitomiManifestResult.data.source_site,
      entries,
      warnings: [],
    });
  }

  throw new Error('Unsupported site_probe export format');
}