import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  importBatchSchema,
  parseDurationSeconds,
  type ImportBatch,
  type ImportBatchOrigin,
  type ImportEntry,
} from '@t3/shared';
import { z } from 'zod';

/**
 * A work's runtime as an export may spell it, parsed into whole seconds on the way in.
 *
 * The spelling is the exporter's business: an OpenGraph duration is a bare number of seconds
 * (`og:video:duration` `805`), while a card or a player's own label reads `13:25` or `1:02:36`. All
 * of them mean the same thing, so all of them are accepted and what the Entry receives is already
 * the unit its column stores.
 *
 * A value that is none of them fails the item's schema instead of arriving as `null`: the field is
 * written by an adapter, so a spelling it cannot read is that adapter's defect rather than a work
 * that has no runtime — and "the duration silently vanished" is the failure a person cannot see.
 */
const durationSchema = z.union([z.number(), z.string().trim().min(1)])
  .nullable()
  .optional()
  .refine(
    (value) => value === null || value === undefined || parseDurationSeconds(value) !== null,
    { message: 'Duration must be h:mm:ss, mm:ss, m:ss, ss or s' },
  )
  .transform((value) => (value === null || value === undefined
    ? value
    : parseDurationSeconds(value)));

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
  duration: durationSchema,
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
  /**
   * A video's runtime, the peer of `page_count`. It is the one field a rule cannot be expected to
   * read: on all five video pages measured (2026-10-08) the runtime lives inside the player, and
   * only two publish it in the served HTML at all. An adapter for a video site therefore declares
   * it itself — see the note beside `_SCALAR_FIELDS` in the tool — and this is the door that value
   * comes through.
   */
  duration: durationSchema,
  preview_images: z.array(previewImageSchema).optional(),
  /**
   * The two fields a learned adapter writes at the item's top level — measured on the first real
   * generated adapter (`www.bilinovel.com`, 2026-10-03), whose record carried `author: "十夜"` and
   * a `description` of the work's synopsis beside an empty `分类信息`. Reading only `分类信息` lost
   * the author the picker had found, and there was no channel at all for the synopsis.
   */
  author: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
});

const SITES_WITH_OWN_SCHEMA = new Set(['18comic.vip', 'hanime1.me', 'hitomi.la']);

/**
 * A whole listing's worth of neutral items.
 *
 * The gap this closes was measured on the way to wiring the SiteProbe chain: the neutral contract
 * accepted one work and nothing else, so a *listing* export from any site without its own schema was
 * rejected with `Unsupported site_probe export format`. That is the ordinary case for a site that
 * gained a rule set through the Builder — its search results are a batch document — so the only
 * importable export was a single work, which is the opposite of what a crawl is for.
 *
 * The two guards of the single-item branch apply unchanged: it is tried last, and only for a site
 * without a schema of its own, so a known site whose export stopped matching its own schema keeps
 * failing loudly instead of importing here with its tags emptied.
 */
/**
 * A listing that carries only its works' **ids**, with each work's own document beside it.
 *
 * This is what the tool writes for a site whose adapter declares no manifest shape of its own — a
 * learned rule set, and so exactly the ordinary case for a site the Builder added. T³ answered it
 * with `Unsupported site_probe export format` while a finished crawl sat on disk, measured on a real
 * manwa.me work (2026-09-22). The export is not wrong: `items/<id>/metadata.json` holds the work and
 * the listing names it, so the ids are read back into their documents rather than refused.
 */
const idListManifestSchema = z.object({
  source_site: z.string().trim().min(1),
  origin: originSchema.optional(),
  items: z.array(z.string().trim().min(1)),
});

/**
 * The works an id-only listing names, read from the documents beside it.
 *
 * A missing or unreadable document is named in the warnings rather than dropped: an export that
 * lists a work it does not carry is a finding about that export, and the person sees it.
 */
async function idListEntries(
  ids: readonly string[],
  exportRoot: string,
  options: SiteProbeLoadOptions,
): Promise<{ entries: ImportEntry[]; warnings: string[] }> {
  const entries: ImportEntry[] = [];
  const warnings: string[] = [];
  for (const id of ids) {
    let documentPath: string;
    let raw: unknown;
    try {
      documentPath = itemMetadataPath(exportRoot, id);
      raw = JSON.parse(await readExportText(documentPath, options));
    } catch {
      warnings.push(`${id}: the listing names this work but items/${id}/metadata.json is not readable`);
      continue;
    }
    const parsed = neutralItemSchema.safeParse(raw);
    if (!parsed.success) {
      warnings.push(`${id}: items/${id}/metadata.json is not a work document`);
      continue;
    }
    entries.push(adaptNeutralItem(parsed.data, exportRoot, options));
  }
  return { entries, warnings };
}

const neutralBatchSchema = z.object({
  source_site: z.string().trim().min(1),
  origin: originSchema.optional(),
  items: z.array(neutralItemSchema),
});

export interface SiteProbeLoadOptions {
  preserveRelativeMediaPaths?: boolean;
  /** Read an export path only after the server verifies real-path containment. */
  readExportFile?: (path: string) => Promise<Buffer>;
}

async function readExportText(path: string, options: SiteProbeLoadOptions): Promise<string> {
  const bytes = options.readExportFile === undefined
    ? await readFile(path)
    : await options.readExportFile(path);
  return bytes.toString('utf8');
}

function itemMetadataPath(exportRoot: string, id: string): string {
  if (id === '' || id === '.' || id === '..' || isAbsolute(id)
      || /^[A-Za-z]:/u.test(id) || /[\\/]/u.test(id)) {
    throw new Error('Export item ID must be a single path segment');
  }
  return join(exportRoot, 'items', id, 'metadata.json');
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
    ...(item.duration === null || item.duration === undefined ? {} : { durationSeconds: item.duration }),
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
  // A learned adapter names the author at the item's top level, so `分类信息.作者` is empty for
  // every generated adapter — the same fallback the hanime adapter has always had, because its own
  // export puts one author beside an empty category block.
  const authors = (categories?.作者.length ?? 0) > 0
    ? categories!.作者
    : (item.author === undefined ? [] : [item.author]);
  const fields: Record<string, string[]> = {};
  if (categories) {
    if (categories.作品.length > 0) fields.works = categories.作品;
    if (categories.登场人物.length > 0) fields.characters = categories.登场人物;
    // Empty is absent, not a field with no values: an empty `分类信息` is what a learned adapter
    // writes, and a row of nothing in the review is a decision a person has to make about nothing.
    const contentTypes = categories.作品类型 ?? [];
    if (contentTypes.length > 0) fields.contentTypes = contentTypes;
  }
  if (authors.length > 0) fields.authors = authors;
  if (item.language?.name) fields.language = [item.language.name];
  // The synopsis is a field a person reviews like any other: its destination decides whether it
  // becomes a Content row (the review's `Content`), and the review names the type.
  if (item.description !== undefined) fields.description = [item.description];

  return {
    externalKey: `${item.source_site}:${item.source_id}`,
    title: item.title,
    ...(cover ? { cover } : {}),
    ...(previews[0] ? { preview: previews[0] } : {}),
    ...(previews.length > 0 ? { previews } : {}),
    ...(uploadDate ? { uploadDate } : {}),
    ...(item.page_count === null || item.page_count === undefined ? {} : { pageCount: item.page_count }),
    ...(item.duration === null || item.duration === undefined ? {} : { durationSeconds: item.duration }),
    tags: (categories?.分类标签 ?? []).map((name) => ({ name, sourceField: '分类标签' })),
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
    sources: [{ label: item.source_site, url: item.detail_url }],
  };
}

export async function loadSiteProbeExport(
  metadataPath: string,
  options: SiteProbeLoadOptions = {},
): Promise<ImportBatch> {
  const rawDocument: unknown = JSON.parse(await readExportText(metadataPath, options));
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
      const itemPath = itemMetadataPath(exportRoot, sourceId);
      let itemDocument: unknown;
      try {
        itemDocument = JSON.parse(await readExportText(itemPath, options));
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

  const neutralBatchResult = neutralBatchSchema.safeParse(rawDocument);
  if (neutralBatchResult.success
    && !SITES_WITH_OWN_SCHEMA.has(neutralBatchResult.data.source_site)) {
    const batchOrigin = adaptOrigin(neutralBatchResult.data.origin);
    return importBatchSchema.parse({
      source: neutralBatchResult.data.source_site,
      ...(batchOrigin ? { origin: batchOrigin } : {}),
      entries: neutralBatchResult.data.items.map(
        // The paths in a listing's own document are written against the *export root* — the tool
        // records `items/<id>/cover/cover.jpg` for every site, its own schema or not — and that
        // document sits in that root. Stripping the item prefix here resolved one directory too
        // shallow, so a listing imported with no media at all and one warning per file.
        (item) => adaptNeutralItem(item, exportRoot, options),
      ),
      warnings: [],
    });
  }

  const idListResult = idListManifestSchema.safeParse(rawDocument);
  if (idListResult.success && !SITES_WITH_OWN_SCHEMA.has(idListResult.data.source_site)) {
    const { entries, warnings } = await idListEntries(idListResult.data.items, exportRoot, options);
    const batchOrigin = adaptOrigin(idListResult.data.origin);
    return importBatchSchema.parse({
      source: idListResult.data.source_site,
      ...(batchOrigin ? { origin: batchOrigin } : {}),
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

  const unreadableDuration = unreadableDurationReport(rawDocument);
  if (unreadableDuration !== null) throw new Error(unreadableDuration);
  throw new Error('Unsupported site_probe export format');
}

/**
 * Why nothing matched, when the reason is a runtime the importer cannot read.
 *
 * An unreadable duration fails that item's schema, and a document whose items match no shape would
 * otherwise be reported as `Unsupported site_probe export format` — a sentence naming nothing a
 * person can act on, while the actual fault is one field with one wrong value. This looks at the
 * field that failed and says what was wrong with it, with the work named.
 */
function unreadableDurationReport(document: unknown): string | null {
  const asRecord = (value: unknown): Record<string, unknown> | null => (
    value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
  );
  const root = asRecord(document);
  if (root === null) return null;
  const items = Array.isArray(root.items) ? root.items : [document];
  for (const item of items) {
    const record = asRecord(item);
    if (record === null) continue;
    const written = record.duration;
    if (written === undefined || written === null) continue;
    if (parseDurationSeconds(written) !== null) continue;
    const sourceId = typeof record.source_id === 'string' ? record.source_id : '?';
    return `Work ${sourceId} has a duration this importer cannot read: ${JSON.stringify(written)}`
      + ' (expected h:mm:ss, mm:ss, m:ss, ss or s)';
  }
  return null;
}