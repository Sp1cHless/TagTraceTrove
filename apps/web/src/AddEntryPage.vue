<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { normalizeTag } from '@t3/shared';
import type { ImportBatch, ImportCommitMapping, ImportCommitResult, ImportEntry, ImportPreview, RatingSlotDto } from '@t3/shared';
import type { GalleryApi } from './api/gallery.js';
import { collectDroppedFiles } from './dropped-files.js';
import { useI18n } from './i18n.js';

export interface ManualEntryDraftRating {
  slotId: number;
  stars: number | null;
}

export interface ManualEntryDraft {
  title: string;
  type: string;
  uploadDate: string | null;
  coverFile: File | null;
  previewFile: File | null;
  ratings: ManualEntryDraftRating[];
  viewLater: boolean;
}

const props = defineProps<{
  api: GalleryApi;
  galleryTypes: string[];
  authors: Array<{ id: number; name: string }>;
  submitting: boolean;
}>();
const emit = defineEmits<{
  back: [];
  submit: [draft: ManualEntryDraft];
  imported: [entryType: string, entryIds: number[], viewLater: boolean];
  batchImported: [entryType: string, entryIds: number[], viewLater: boolean];
}>();
const { t } = useI18n();
const title = ref('');
const type = ref(props.galleryTypes[0] ?? '');
const uploadDate = ref('');
const coverFile = ref<File | null>(null);
const previewFile = ref<File | null>(null);
const coverPreview = ref<string | null>(null);
const previewPreview = ref<string | null>(null);
const importPreview = ref<ImportPreview | null>(null);
const importFiles = ref<File[]>([]);
const importType = ref(props.galleryTypes[0] ?? '');
const importLayout = ref<Awaited<ReturnType<GalleryApi['listLayout']>>>([]);
const manualContentType = ref('');
const manualViewLater = ref(false);
const importViewLater = ref(false);
const committedImportEntryIds: number[] = [];
const manualRatingSlots = ref<RatingSlotDto[]>([]);
const manualRatings = ref<Record<number, number | null>>({});
const importRatingSlots = ref<RatingSlotDto[]>([]);
const importRatings = ref<Record<number, number | null>>({});
const batchRatingSlots = ref<RatingSlotDto[]>([]);
const batchRatings = ref<Record<number, number | null>>({});
const contentTypeOptions = ref<string[]>([]);
const canonicalFacetId = ref<number | null>(null);
const fieldDestinations = ref<Record<string, string>>({});
const producerMatches = ref<Record<string, number | null>>({});
// Live author list for auto-link matching. `props.authors` is only refreshed on
// single-import commit, so batch import keeps its own copy and re-fetches it
// whenever a commit creates producers — otherwise every batch item whose author
// was created earlier in the same batch would spawn a duplicate producer.
const authorOptions = ref<Array<{ id: number; name: string }>>(props.authors);
watch(() => props.authors, (list) => {
  authorOptions.value = list;
});
const createUnmatchedAuthors = ref(true);
const batchImportOpen = ref(false);
const batchImportFiles = ref<File[]>([]);
const batchImportType = ref(props.galleryTypes[0] ?? '');
const batchLayout = ref<Awaited<ReturnType<GalleryApi['listLayout']>>>([]);
const batchContentType = ref('');
const batchViewLater = ref(false);
const batchContentTypeOptions = ref<string[]>([]);
const batchImportBusy = ref(false);
const batchProgress = ref<{ total: number; current: number } | null>(null);
const batchResult = ref<string | null>(null);
const batchFolderName = computed(() => {
  const first = batchImportFiles.value[0];
  if (!first) return '';
  const path = (first as File & { webkitRelativePath?: string }).webkitRelativePath || first.name;
  return path.replace(/\\/gu, '/').split('/').filter(Boolean)[0] ?? '';
});
const importBusy = ref(false);
const importError = ref<string | null>(null);
const importResult = ref<string | null>(null);
const importFields = computed(() => [...new Set(
  importPreview.value?.batch.entries.flatMap((entry) => Object.keys(entry.fields ?? {})) ?? [],
)]);
const importedAuthorValues = computed(() => [...new Set(
  importPreview.value?.batch.entries.flatMap((entry) => {
    const value = entry.fields?.authors;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  }) ?? [],
)]);
const facets = computed(() => importLayout.value.flatMap((section) => (
  section.facets.map((facet) => ({ ...facet, sectionName: section.name }))
)));
const contentTypeFacetId = computed(() => findFacetIdByNames(importLayout.value, ['type']));
const batchContentTypeFacetId = computed(() => findFacetIdByNames(batchLayout.value, ['type']));
const previewEntry = computed(() => importPreview.value?.batch.entries[0] ?? null);

// Preview cover: export folders are not served by the dev/preview server, so
// resolve the cover file among the dropped files and render it as an object
// URL. Revoked whenever the preview changes or the page unmounts.
const previewCoverUrl = ref<string | null>(null);
let previewCoverUrlRevoke: (() => void) | null = null;

watch([previewEntry, importFiles], () => {
  if (previewCoverUrlRevoke) {
    previewCoverUrlRevoke();
    previewCoverUrlRevoke = null;
  }
  previewCoverUrl.value = null;
  const cover = previewEntry.value?.cover;
  if (!cover || /^https?:\/\//u.test(cover)) {
    previewCoverUrl.value = cover ?? null;
    return;
  }
  const file = selectedFile(cover);
  if (!file) return;
  const url = URL.createObjectURL(file);
  previewCoverUrl.value = url;
  previewCoverUrlRevoke = () => URL.revokeObjectURL(url);
}, { immediate: true });

onBeforeUnmount(() => {
  if (previewCoverUrlRevoke) previewCoverUrlRevoke();
});

const ratingStarValues: number[] = Array.from({ length: 10 }, (_, index) => (index + 1) / 2);

const FIELD_FACET_RULES: Array<{ match: string[]; facet: string }> = [
  { match: ['works', '作品'], facet: 'series' },
  { match: ['characters', 'character', '登场人物'], facet: 'characters' },
  { match: ['contentTypes', 'types', '作品类型'], facet: 'type' },
  { match: ['language'], facet: 'language' },
];

function normalizedName(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

// Values of one imported field as they will land as Tags. Array-shaped fields
// only (producers and tag fields are arrays; anything else is not taggable).
function fieldStringValues(entry: ImportEntry, field: string): string[] {
  const value = entry.fields?.[field];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = normalizedName(name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Tag names that will land on each Facet of the target template for the first
// previewed Entry: canonical Tags, field→facet mappings, and the manual
// content type. Recomputed live so the preview follows every mapping change.
const previewTagsByFacetId = computed<Record<number, string[]>>(() => {
  const entry = previewEntry.value;
  if (!entry) return {};
  const map: Record<number, string[]> = {};
  const push = (facetId: number | null, name: string): void => {
    if (facetId === null) return;
    const key = normalizedName(name);
    if (!key) return;
    const list = map[facetId] ?? (map[facetId] = []);
    if (!list.some((existing) => normalizedName(existing) === key)) list.push(name.trim());
  };
  for (const tag of entry.tags ?? []) {
    push(canonicalFacetId.value, resolveEntryNameForPreview(tag.name, entryAliases));
  }
  for (const field of Object.keys(entry.fields ?? {})) {
    const destination = fieldDestinations.value[field] ?? 'ignore';
    if (!destination.startsWith('tag:')) continue;
    const facetId = Number(destination.slice(4));
    for (const name of fieldStringValues(entry, field)) {
      push(facetId, resolveEntryNameForPreview(name, entryAliases));
    }
  }
  if (manualContentType.value.trim() && contentTypeFacetId.value !== null) {
    push(contentTypeFacetId.value, manualContentType.value.trim());
  }
  return map;
});

const previewAuthorNames = computed<string[]>(() => {
  const entry = previewEntry.value;
  if (!entry) return [];
  const names: string[] = [];
  for (const field of Object.keys(entry.fields ?? {})) {
    if ((fieldDestinations.value[field] ?? 'ignore') !== 'producer') continue;
    for (const name of fieldStringValues(entry, field)) {
      const matchedId = producerMatches.value[name];
      const matched = authorOptions.value.find((author) => author.id === matchedId);
      names.push(matched ? matched.name : name);
    }
  }
  return dedupeNames(names);
});

const previewContentRows = computed<Array<{ label: string; values: string[] }>>(() => {
  const entry = previewEntry.value;
  if (!entry) return [];
  return Object.keys(entry.fields ?? {})
    .filter((field) => (fieldDestinations.value[field] ?? 'ignore') === 'content')
    .map((field) => ({ label: field, values: fieldStringValues(entry, field) }))
    .filter((row) => row.values.length > 0);
});

// 'producer'-vocabulary taxonomy aliases (author-name dictionary, e.g.
// 'bob' -> '鲍勃'), fetched once per page. An imported author name resolves
// through it to its canonical spelling before auto-linking, so dictionary
// merges survive re-imports of any spelling and are never re-created.
let entryAliasesPromise: Promise<Map<string, string>> | null = null;
let entryAliases = new Map<string, string>();

async function loadEntryAliases(): Promise<Map<string, string>> {
  entryAliasesPromise ??= props.api.listTaxonomyAliases('entry')
    .then((aliases) => new Map(aliases.map((alias) => [alias.normalizedAlias, alias.canonicalName])))
    .catch(() => new Map());
  return entryAliasesPromise;
}

// Synchronous dictionary resolution for the preview card: walks the alias
// chain in the already-loaded map, skipping empty canonical placeholders so
// the preview shows exactly the name the import will store.
function resolveEntryNameForPreview(name: string, aliases: Map<string, string>): string {
  let current = name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const visited = new Set<string>();
  for (;;) {
    const normalized = normalizeTag(current);
    if (visited.has(normalized) || normalized === '') return current;
    visited.add(normalized);
    const canonical = aliases.get(normalized);
    if (canonical === undefined || canonical.trim() === '') return current;
    current = canonical;
  }
}

let producerAliasesPromise: Promise<Map<string, string>> | null = null;

function loadProducerAliases(): Promise<Map<string, string>> {
  producerAliasesPromise ??= props.api.listTaxonomyAliases('producer')
    .then((aliases) => new Map(aliases.map((alias) => [alias.normalizedAlias, alias.canonicalName])))
    .catch(() => new Map());
  return producerAliasesPromise;
}

async function resolveProducerName(name: string): Promise<string> {
  const aliases = await loadProducerAliases();
  let current = name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const visited = new Set<string>();
  for (;;) {
    const normalized = normalizeTag(current);
    if (visited.has(normalized)) return current;
    visited.add(normalized);
    const canonical = aliases.get(normalized);
    // Placeholder dictionary rows carry an empty canonical name — skip them
    // exactly like the server-side resolver, or the match resolves to ''
    // and every import silently creates a duplicate author.
    if (canonical === undefined || canonical.trim() === '') return current;
    current = canonical;
  }
}

function resolveImportType(value: string, types: string[]): string {
  const trimmed = value.trim();
  return types.find((candidate) => normalizedName(candidate) === normalizedName(trimmed)) ?? trimmed;
}

function findFacetIdByNames(layout: Awaited<ReturnType<GalleryApi['listLayout']>>, names: string[]): number | null {
  for (const section of layout) {
    for (const facet of section.facets) {
      if (facet.name && names.includes(normalizedName(facet.name))) return facet.id;
    }
  }
  return null;
}

function autoCanonicalFacetId(layout: Awaited<ReturnType<GalleryApi['listLayout']>>): number | null {
  const tagsSection = layout.find((section) => normalizedName(section.name) === 'tags');
  if (tagsSection && tagsSection.facets.length > 0) return tagsSection.facets[0]!.id;
  const firstFacet = layout[0]?.facets[0];
  return firstFacet?.id ?? null;
}

function autoMapFieldDestinations(
  layout: Awaited<ReturnType<GalleryApi['listLayout']>>,
  fields: string[],
): Record<string, string> {
  const destinations: Record<string, string> = {};
  for (const field of fields) {
    if (normalizedName(field) === 'authors') {
      destinations[field] = 'producer';
      continue;
    }
    const rule = FIELD_FACET_RULES.find((candidate) => candidate.match.includes(field));
    const facetId = rule ? findFacetIdByNames(layout, [rule.facet]) : null;
    destinations[field] = facetId ? `tag:${facetId}` : 'ignore';
  }
  return destinations;
}

function preferredImportType(types: string[]): string {
  return types.find((candidate) => /^comic/i.test(candidate))
    ?? types.find((candidate) => /comic/i.test(candidate))
    ?? types[0] ?? '';
}

function replacePreview(target: 'cover' | 'preview', file: File): void {
  if (!file.type.startsWith('image/')) return;
  const previous = target === 'cover' ? coverPreview.value : previewPreview.value;
  if (previous) URL.revokeObjectURL(previous);
  const objectUrl = URL.createObjectURL(file);
  if (target === 'cover') {
    coverFile.value = file;
    coverPreview.value = objectUrl;
  } else {
    previewFile.value = file;
    previewPreview.value = objectUrl;
  }
}

function dropImage(event: DragEvent, target: 'cover' | 'preview'): void {
  const file = event.dataTransfer?.files.item(0);
  if (file) replacePreview(target, file);
}

function chooseImage(event: Event, target: 'cover' | 'preview'): void {
  const file = (event.target as HTMLInputElement).files?.item(0);
  if (file) replacePreview(target, file);
}

async function chooseFolder(event: Event): Promise<void> {
  const files = [...((event.target as HTMLInputElement).files ?? [])];
  if (files.length > 0) await prepareImport(files);
}

async function dropFolder(event: DragEvent): Promise<void> {
  if (!event.dataTransfer) return;
  await prepareImport(await collectDroppedFiles(event.dataTransfer));
}

async function loadImportPreview(itemFiles: File[], itemType: string): Promise<void> {
  importFiles.value = itemFiles;
  importPreview.value = await props.api.previewSiteProbeFolder(itemFiles);
  entryAliases = await loadEntryAliases();
  importType.value = resolveImportType(itemType, props.galleryTypes);
  producerMatches.value = Object.fromEntries(await Promise.all(
    importedAuthorValues.value.map(async (name) => {
      const canonical = await resolveProducerName(name);
      // Normalize before comparing: stray spaces or width variants in either
      // the site spelling or the stored name must not break the auto-match
      // (a miss silently creates a duplicate author on commit).
      const normalized = (value: string) => value
        .normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
      const target = normalized(canonical);
      const match = authorOptions.value.find((author) => normalized(author.name) === target);
      return [name, match ? match.id : null];
    }),
  ));
  await loadImportLayout();
}

async function prepareImport(files: File[]): Promise<void> {
  importBusy.value = true;
  importError.value = null;
  importResult.value = null;
  manualContentType.value = '';
  try {
    await loadImportPreview(files, preferredImportType(props.galleryTypes));
  } catch (cause) {
    importError.value = cause instanceof Error ? cause.message : t('import.previewError');
  } finally {
    importBusy.value = false;
  }
}

async function loadRatingSlots(entryType: string, target: 'manual' | 'import' | 'batch'): Promise<void> {
  try {
    const slots = await props.api.listRatingSlots(entryType);
    if (target === 'manual') {
      manualRatingSlots.value = slots;
      manualRatings.value = Object.fromEntries(slots.map((slot) => [slot.id, null]));
    } else if (target === 'import') {
      importRatingSlots.value = slots;
      importRatings.value = Object.fromEntries(slots.map((slot) => [slot.id, null]));
    } else {
      batchRatingSlots.value = slots;
      batchRatings.value = Object.fromEntries(slots.map((slot) => [slot.id, null]));
    }
  } catch {
    if (target === 'manual') manualRatingSlots.value = [];
    else if (target === 'import') importRatingSlots.value = [];
    else batchRatingSlots.value = [];
  }
}

function ratingValue(map: Record<number, number | null>, slotId: number): string {
  const value = map[slotId];
  return value === null || value === undefined ? '' : String(value);
}

function setRatingValue(
  map: Record<number, number | null>,
  slotId: number,
  event: Event,
): void {
  const value = (event.target as HTMLSelectElement).value;
  map[slotId] = value === '' ? null : Number(value);
}

async function loadTypeFacetOptions(entryType: string, typeFacetId: number | null): Promise<string[]> {
  if (typeFacetId === null) return [];
  try {
    const options = await props.api.listFacetFilterOptions(entryType);
    const facet = options.facets.find((candidate) => candidate.facetId === typeFacetId);
    return facet ? facet.tags.map((tag) => tag.name) : [];
  } catch {
    return [];
  }
}

const importLayoutResolvedType = ref('');

// The preview card must always mirror the currently selected Gallery:
// reload the template whenever the resolved type drifts from the loaded one.
watch(importType, () => {
  if (!importPreview.value) return;
  const resolved = resolveImportType(importType.value, props.galleryTypes);
  if (resolved && resolved !== importLayoutResolvedType.value) {
    void loadImportLayout();
  }
});

async function loadImportLayout(): Promise<void> {
  const resolvedType = resolveImportType(importType.value, props.galleryTypes);
  if (!resolvedType) return;
  importType.value = resolvedType;
  // Skip the network refetch when this Gallery is already loaded, but always
  // recompute the derived state below (fresh previews need fresh mappings).
  if (importLayoutResolvedType.value !== resolvedType || importLayout.value.length === 0) {
    importLayoutResolvedType.value = resolvedType;
    importLayout.value = await props.api.listLayout(resolvedType);
  }
  canonicalFacetId.value = autoCanonicalFacetId(importLayout.value);
  contentTypeOptions.value = await loadTypeFacetOptions(resolvedType, contentTypeFacetId.value);
  await loadRatingSlots(resolvedType, 'import');
  fieldDestinations.value = autoMapFieldDestinations(importLayout.value, importFields.value);
}

async function loadBatchLayout(): Promise<void> {
  const resolvedType = resolveImportType(batchImportType.value, props.galleryTypes);
  if (!resolvedType) {
    batchLayout.value = [];
    batchContentTypeOptions.value = [];
    return;
  }
  try {
    batchLayout.value = await props.api.listLayout(resolvedType);
  } catch {
    batchLayout.value = [];
  }
  batchContentTypeOptions.value = await loadTypeFacetOptions(
    resolvedType,
    findFacetIdByNames(batchLayout.value, ['type']),
  );
  await loadRatingSlots(resolvedType, 'batch');
}

function selectedFile(relativePath: string): File | null {
  const normalized = relativePath.replace(/\\/gu, '/').replace(/^\/+/, '');
  return importFiles.value.find((file) => {
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    return path.replace(/\\/gu, '/').endsWith(`/${normalized}`) || path === normalized;
  }) ?? null;
}

async function commitCurrentImport(): Promise<ImportCommitResult> {
  if (!importPreview.value) throw new Error(t('import.previewError'));
  if (canonicalFacetId.value === null) throw new Error(t('import.layoutRequired'));
  const fieldMappings: ImportCommitMapping['fieldMappings'] = {};
  const ignoredFields: string[] = [];
  for (const field of importFields.value) {
    const destination = fieldDestinations.value[field] ?? 'ignore';
    if (destination === 'ignore') {
      ignoredFields.push(field);
    } else if (destination === 'producer') {
      const matched = Object.entries(producerMatches.value)
        .filter(([, id]) => id !== null);
      const resolvedIds = Object.fromEntries(await Promise.all(
        matched.map(async ([name, id]) => [await resolveProducerName(name), id as number]),
      ));
      fieldMappings[field] = {
        kind: 'producer',
        createUnmatched: createUnmatchedAuthors.value,
        existingProducerIds: resolvedIds,
      };
    } else if (destination.startsWith('tag:')) {
      fieldMappings[field] = { kind: 'tag', facetId: Number(destination.slice(4)) };
    } else {
      fieldMappings[field] = { kind: 'content', contentType: field };
    }
  }

  // The manually entered content type merges into every Entry's contentTypes
  // field before commit; the reviewed mapping then sends those values to the
  // template's Type Facet. A manual value always forces that mapping so a
  // stale "ignore"/content destination cannot silently drop the input.
  const manualType = manualContentType.value.trim();
  const typeFacetId = findFacetIdByNames(importLayout.value, ['type']);
  const injectContentType = manualType !== '' && typeFacetId !== null;
  if (injectContentType) {
    fieldMappings.contentTypes = { kind: 'tag', facetId: typeFacetId };
    const ignoredIndex = ignoredFields.indexOf('contentTypes');
    if (ignoredIndex >= 0) ignoredFields.splice(ignoredIndex, 1);
  }
  const batch: ImportBatch = injectContentType
    ? {
      ...importPreview.value.batch,
      entries: importPreview.value.batch.entries.map((entry) => ({
        ...entry,
        fields: {
          ...(entry.fields ?? {}),
          contentTypes: dedupeNames([...fieldStringValues(entry, 'contentTypes'), manualType]),
        },
      })),
    }
    : importPreview.value.batch;

  const result = await props.api.commitImport(batch, {
    entryType: importType.value.trim(),
    canonicalTagFacetId: canonicalFacetId.value,
    sourceContentType: 'Source URL',
    externalKeyContentType: 'External Key',
    fieldMappings,
    ignoredFields,
  });
  for (let index = 0; index < result.entries.length; index += 1) {
    const entryRecord = result.entries[index]!;
    const imported = importPreview.value.batch.entries[index];
    const cover = imported?.cover;
    if (cover && !/^https?:\/\//u.test(cover)) {
      const file = selectedFile(cover);
      if (file) await props.api.uploadEntryMedia(entryRecord.entryId, 'cover', file);
    }
    const previews = imported?.previews ?? (imported?.preview ? [imported.preview] : []);
    for (const preview of previews) {
      if (preview && !/^https?:\/\//u.test(preview)) {
        const file = selectedFile(preview);
        if (file) await props.api.uploadEntryMedia(entryRecord.entryId, 'preview', file);
      }
    }
  }
  // Imported data carries no ratings — apply the ones chosen at review time
  // (the batch flow overwrites importRatings with the batch-wide values).
  for (const [slotId, stars] of Object.entries(importRatings.value)) {
    if (stars === null) continue;
    for (const entryRecord of result.entries) {
      await props.api.setEntryRating(entryRecord.entryId, Number(slotId), stars);
    }
  }
  return result;
}

async function commitFolderImport(): Promise<void> {
  importBusy.value = true;
  importError.value = null;
  try {
    const result = await commitCurrentImport();
    const committedIds = result.entries.map((record) => record.entryId);
    committedImportEntryIds.splice(0, committedImportEntryIds.length, ...committedIds);
    importResult.value = t('import.completed', { count: result.entryCount });
    emit('imported', importType.value.trim(), committedImportEntryIds, importViewLater.value);
  } catch (cause) {
    importError.value = cause instanceof Error ? cause.message : t('import.commitError');
  } finally {
    importBusy.value = false;
  }
}

function itemsByFolder(files: File[]): Array<{ key: string; files: File[] }> {
  const map = new Map<string, File[]>();
  for (const file of files) {
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const normalized = path.replace(/\\/gu, '/');
    const match = /^(.+?)\/items\/([^/]+)\//u.exec(normalized);
    if (!match) continue;
    const key = `${match[1]}/items/${match[2]}/`;
    const list = map.get(key) ?? [];
    list.push(file);
    map.set(key, list);
  }
  return [...map.entries()].map(([key, groupFiles]) => ({ key, files: groupFiles }));
}

async function dropBatchFolder(event: DragEvent): Promise<void> {
  if (!event.dataTransfer) return;
  batchImportFiles.value = await collectDroppedFiles(event.dataTransfer);
}

function chooseBatchFolder(event: Event): void {
  const input = event.target as HTMLInputElement;
  batchImportFiles.value = input.files ? [...input.files] : [];
}

async function runBatchImport(): Promise<void> {
  if (batchImportBusy.value) return;
  const itemType = batchImportType.value.trim();
  if (!itemType) return;
  const folderItems = itemsByFolder(batchImportFiles.value);
  const committedEntryIds: number[] = [];
  if (folderItems.length === 0) {
    batchResult.value = t('import.batchEmpty');
    return;
  }
  batchImportBusy.value = true;
  batchResult.value = null;
  batchProgress.value = { total: folderItems.length, current: 0 };
  let succeedCount = 0;
  let failedCount = 0;
  for (const item of folderItems) {
    batchProgress.value.current += 1;
    try {
      manualContentType.value = batchContentType.value.trim();
      await loadImportPreview(item.files, itemType);
      // loadImportLayout resets the per-import ratings — reapply the
      // batch-wide choices after the preview, before the commit.
      importRatings.value = { ...batchRatings.value };
      const result = await commitCurrentImport();
      for (const record of result.entries) committedEntryIds.push(record.entryId);
      // A commit that created producers means new author names entered the DB.
      // Refresh the local author list so later items by the same author
      // auto-link to that producer instead of creating duplicates.
      if (result.createdProducerCount > 0) {
        try {
          authorOptions.value = await props.api.listAuthors();
        } catch {
          // Non-fatal: the item itself committed; a later same-author item may
          // duplicate, but that beats counting this successful item as failed.
        }
      }
      succeedCount += 1;
    } catch {
      failedCount += 1;
    }
  }
  batchProgress.value = null;
  batchImportBusy.value = false;
  importPreview.value = null;
  importFiles.value = [];
  manualContentType.value = '';
  importRatings.value = {};
  importResult.value = null;
  importError.value = null;
  batchResult.value = t('import.batchDone', { success: succeedCount, failed: failedCount });
  emit('batchImported', itemType, committedEntryIds, batchViewLater.value);
}

async function loadManualRatingSlots(): Promise<void> {
  const resolvedType = resolveImportType(type.value, props.galleryTypes);
  if (!resolvedType) return;
  await loadRatingSlots(resolvedType, 'manual');
}

function submit(): void {
  emit('submit', {
    title: title.value.trim(),
    type: type.value.trim(),
    uploadDate: uploadDate.value || null,
    coverFile: coverFile.value,
    previewFile: previewFile.value,
    ratings: Object.entries(manualRatings.value)
      .map(([slotId, stars]) => ({ slotId: Number(slotId), stars }))
      .filter((rating) => rating.stars !== null),
    viewLater: manualViewLater.value,
  });
}

onBeforeUnmount(() => {
  if (coverPreview.value) URL.revokeObjectURL(coverPreview.value);
  if (previewPreview.value) URL.revokeObjectURL(previewPreview.value);
});
</script>

<template>
  <section data-testid="add-entry-page" class="add-page">
    <header class="add-page-toolbar">
      <button data-testid="add-entry-back" class="back-button" type="button" @click="emit('back')">
        {{ t('entry.back', { type: t('gallery.title') }) }}
      </button>
      <h2>{{ t('entry.new') }}</h2>
    </header>

    <form data-testid="manual-entry-form" class="entry-composer" @submit.prevent="submit">
      <div class="media-composer">
        <label
          data-testid="entry-cover-dropzone"
          class="media-dropzone cover-dropzone"
          @dragover.prevent
          @drop.prevent="dropImage($event, 'cover')"
        >
          <img v-if="coverPreview" :src="coverPreview" :alt="t('entry.cover')">
          <span v-else class="dropzone-plus">+</span>
          <strong>{{ t('entry.cover') }}</strong>
          <input type="file" accept="image/*" @change="chooseImage($event, 'cover')">
        </label>
        <label
          v-if="coverFile"
          data-testid="entry-preview-dropzone"
          class="media-dropzone preview-dropzone"
          @dragover.prevent
          @drop.prevent="dropImage($event, 'preview')"
        >
          <img v-if="previewPreview" :src="previewPreview" :alt="t('entry.preview')">
          <span v-else class="dropzone-plus">+</span>
          <strong>{{ t('entry.preview') }}</strong>
          <input type="file" accept="image/*" @change="chooseImage($event, 'preview')">
        </label>
      </div>

      <div class="entry-fields">
        <label>{{ t('entry.title') }}<input v-model="title" name="title" required autocomplete="off"></label>
        <label>
          {{ t('entry.type') }}
          <input v-model="type" name="type" list="add-entry-gallery-types" required autocomplete="off" @change="loadManualRatingSlots">
          <datalist id="add-entry-gallery-types">
            <option v-for="galleryType in galleryTypes" :key="galleryType" :value="galleryType" />
          </datalist>
        </label>
        <label>{{ t('entry.uploadDate') }}<input v-model="uploadDate" name="uploadDate" type="date"></label>
        <div v-if="manualRatingSlots.length > 0" data-testid="manual-entry-ratings" class="rating-select-list">
          <strong class="rating-select-title">{{ t('rating.title') }}</strong>
          <label v-for="slot in manualRatingSlots" :key="slot.id" class="rating-select-row">
            <span>{{ slot.name }}</span>
            <select :value="ratingValue(manualRatings, slot.id)" @change="setRatingValue(manualRatings, slot.id, $event)">
              <option value="">{{ t('rating.unrated') }}</option>
              <option v-for="value in ratingStarValues" :key="value" :value="value">
                {{ t('rating.starsOption', { stars: value }) }}
              </option>
            </select>
          </label>
        </div>
        <label class="checkbox-label" data-testid="manual-entry-view-later">
          <input v-model="manualViewLater" type="checkbox">
          {{ t('entry.viewLaterCheckbox') }}
        </label>
        <button class="primary-button" type="submit" :disabled="submitting">
          {{ submitting ? t('entry.creating') : t('entry.create') }}
        </button>
      </div>
    </form>

    <div data-testid="desktop-entry-import" class="desktop-entry-import">
    <label
      class="folder-dropzone"
      @dragover.prevent
      @drop.prevent="dropFolder"
    >
      <span class="dropzone-plus">+</span>
      <strong>{{ t('import.folderTitle') }}</strong>
      <span>{{ t('import.folderHint') }}</span>
      <span class="browse-label">{{ t('import.browseFolder') }}</span>
      <input type="file" webkitdirectory multiple @change="chooseFolder">
    </label>

    <div class="batch-import-toggle">
      <button
        class="secondary-button"
        type="button"
        :disabled="batchImportBusy"
        @click="batchImportOpen = !batchImportOpen"
      >
        {{ t('import.batchButton') }}
      </button>
    </div>

    <section v-if="batchImportOpen" data-testid="batch-import" class="batch-import">
      <h3>{{ t('import.batchTitle') }}</h3>
      <p class="muted">{{ t('import.batchSubtitle') }}</p>
      <label class="folder-dropzone" @dragover.prevent @drop.prevent="dropBatchFolder">
        <span class="dropzone-plus">+</span>
        <strong>{{ t('import.batchHint') }}</strong>
        <span class="browse-label">{{ t('import.batchBrowse') }}</span>
        <input type="file" webkitdirectory multiple @change="chooseBatchFolder">
      </label>
      <label>
        {{ t('import.batchType') }}
        <input v-model="batchImportType" list="add-entry-gallery-types" required @change="loadBatchLayout">
      </label>
      <label v-if="batchContentTypeFacetId !== null" data-testid="batch-content-type">
        {{ t('import.contentType') }}
        <input
          v-model="batchContentType"
          list="batch-content-type-options"
          :placeholder="t('import.contentTypePlaceholder')"
          autocomplete="off"
        >
        <span class="muted">{{ t('import.contentTypeHint') }}</span>
      </label>
      <datalist id="batch-content-type-options">
        <option v-for="name in batchContentTypeOptions" :key="name" :value="name" />
      </datalist>
      <div v-if="batchRatingSlots.length > 0" data-testid="batch-ratings" class="rating-select-list">
        <strong class="rating-select-title">{{ t('rating.title') }}</strong>
        <label v-for="slot in batchRatingSlots" :key="slot.id" class="rating-select-row">
          <span>{{ slot.name }}</span>
          <select :value="ratingValue(batchRatings, slot.id)" @change="setRatingValue(batchRatings, slot.id, $event)">
            <option value="">{{ t('rating.unrated') }}</option>
            <option v-for="value in ratingStarValues" :key="value" :value="value">
              {{ t('rating.starsOption', { stars: value }) }}
            </option>
          </select>
        </label>
        <span class="muted">{{ t('import.ratingsHint') }}</span>
      </div>
      <p v-if="batchImportFiles.length > 0" class="muted">
        {{ t('import.batchLoaded', { path: batchFolderName, count: batchImportFiles.length }) }}
      </p>
      <p v-if="batchImportBusy && batchProgress" class="muted" role="status">
        {{ t('import.batchProgress', { current: batchProgress.current, total: batchProgress.total }) }}
      </p>
      <p v-if="batchResult" class="success-message" role="status">{{ batchResult }}</p>
      <label class="checkbox-label" data-testid="batch-view-later">
        <input v-model="batchViewLater" type="checkbox">
        {{ t('entry.viewLaterCheckbox') }}
      </label>
      <button
        class="primary-button"
        type="button"
        :disabled="batchImportBusy || batchImportFiles.length === 0"
        @click="runBatchImport"
      >
        {{ t('import.batchRun') }}
      </button>
    </section>

    <section v-if="!batchImportBusy && (importBusy || importPreview || importError)" data-testid="import-review" class="import-review">
      <p v-if="importBusy" class="muted">{{ t('import.preparing') }}</p>
      <p v-if="importError" class="error-message" role="alert">{{ importError }}</p>
      <template v-if="importPreview">
        <header>
          <p class="eyebrow">{{ importPreview.source }}</p>
          <h3>{{ t('import.ready', { count: importPreview.entryCount }) }}</h3>
          <p class="muted">{{ t('import.summary', {
            tags: importPreview.uniqueTagCount,
            covers: importPreview.entriesMissingCover,
          }) }}</p>
        </header>
        <label>
          {{ t('entry.type') }}
          <select v-model="importType" name="importType" required @change="loadImportLayout">
            <option v-for="galleryType in galleryTypes" :key="galleryType" :value="galleryType">
              {{ galleryType }}
            </option>
          </select>
        </label>
        <label class="checkbox-label" data-testid="import-view-later">
          <input v-model="importViewLater" type="checkbox">
          {{ t('entry.viewLaterCheckbox') }}
        </label>
        <label>
          {{ t('import.canonicalTags') }}
          <select v-model="canonicalFacetId" required>
            <option :value="null" disabled>{{ t('import.selectFacet') }}</option>
            <option v-for="facet in facets" :key="facet.id" :value="facet.id">
              {{ facet.sectionName }} / {{ facet.name || 'Tags' }}
            </option>
          </select>
        </label>
        <label v-if="contentTypeFacetId !== null" data-testid="import-content-type">
          {{ t('import.contentType') }}
          <input
            v-model="manualContentType"
            list="import-content-type-options"
            :placeholder="t('import.contentTypePlaceholder')"
            autocomplete="off"
          >
          <span class="muted">{{ t('import.contentTypeHint') }}</span>
        </label>
        <datalist id="import-content-type-options">
          <option v-for="name in contentTypeOptions" :key="name" :value="name" />
        </datalist>
        <div v-if="importRatingSlots.length > 0" data-testid="import-ratings" class="rating-select-list">
          <strong class="rating-select-title">{{ t('rating.title') }}</strong>
          <label v-for="slot in importRatingSlots" :key="slot.id" class="rating-select-row">
            <span>{{ slot.name }}</span>
            <select :value="ratingValue(importRatings, slot.id)" @change="setRatingValue(importRatings, slot.id, $event)">
              <option value="">{{ t('rating.unrated') }}</option>
              <option v-for="value in ratingStarValues" :key="value" :value="value">
                {{ t('rating.starsOption', { stars: value }) }}
              </option>
            </select>
          </label>
          <span class="muted">{{ t('import.ratingsHint') }}</span>
        </div>
        <section
          v-if="previewEntry"
          data-testid="import-template-preview"
          class="template-preview"
        >
          <h4>{{ t('import.templatePreview') }}</h4>
          <p class="muted">
            {{ t('import.templatePreviewSample', {
              type: importType.trim() || '—',
              count: importPreview.entryCount,
            }) }}
          </p>
          <article class="preview-card">
            <p class="eyebrow">{{ importType.trim() }}</p>
            <div class="preview-card-head">
              <img
                v-if="previewCoverUrl"
                class="preview-cover"
                :src="previewCoverUrl"
                :alt="previewEntry.title"
              >
              <h5>{{ previewEntry.title }}</h5>
            </div>
            <div v-if="previewAuthorNames.length > 0" class="preview-chip-row">
              <span class="preview-chip preview-chip-author" data-testid="preview-author-chip">
                {{ previewAuthorNames.join(' / ') }}
              </span>
            </div>
            <div class="preview-board">
              <section
                v-for="section in importLayout"
                :key="section.id"
                class="preview-section"
              >
                <h6>{{ section.name }}</h6>
                <div
                  v-for="facet in section.facets"
                  :key="facet.id"
                  class="preview-facet-row"
                >
                  <div class="preview-facet-label">
                    <span v-if="facet.name">{{ facet.name }}</span>
                  </div>
                  <div class="preview-facet-tags">
                    <span
                      v-for="tag in previewTagsByFacetId[facet.id] ?? []"
                      :key="tag"
                      class="preview-chip"
                    >{{ tag }}</span>
                  </div>
                </div>
              </section>
            </div>
            <div v-if="previewContentRows.length > 0" class="preview-content">
              <div v-for="row in previewContentRows" :key="row.label" class="preview-content-row">
                <span class="preview-content-label">{{ row.label }}</span>
                <span>{{ row.values.join(' / ') }}</span>
              </div>
            </div>
            <p
              v-if="previewAuthorNames.length === 0
                && Object.keys(previewTagsByFacetId).length === 0
                && previewContentRows.length === 0"
              class="muted"
            >
              {{ t('import.previewNoTags') }}
            </p>
          </article>
        </section>
        <div class="mapping-list">
          <label v-for="field in importFields" :key="field">
            <span>{{ field }}</span>
            <select v-model="fieldDestinations[field]">
              <option value="ignore">{{ t('import.ignore') }}</option>
              <option value="producer">{{ t('import.authors') }}</option>
              <option value="content">{{ t('import.content') }}</option>
              <option v-for="facet in facets" :key="facet.id" :value="`tag:${facet.id}`">
                {{ t('import.tagsDestination', {
                  section: facet.sectionName,
                  facet: facet.name || t('import.canonicalTags'),
                }) }}
              </option>
            </select>
          </label>
        </div>
        <section v-if="Object.values(fieldDestinations).includes('producer')" class="producer-review">
          <label class="checkbox-label">
            <input v-model="createUnmatchedAuthors" type="checkbox">
            {{ t('import.createAuthors') }}
          </label>
          <label v-for="name in importedAuthorValues" :key="name">
            <span>{{ name }}</span>
            <select v-model="producerMatches[name]">
              <option :value="null">{{ t('import.createAuthor') }}</option>
              <option v-for="author in authorOptions" :key="author.id" :value="author.id">
                {{ t('import.linkAuthor', { name: author.name }) }}
              </option>
            </select>
          </label>
        </section>
        <p v-if="facets.length === 0" class="error-message">
          {{ t('import.layoutRequired') }}
        </p>
        <button
          class="primary-button"
          type="button"
          :disabled="importBusy || canonicalFacetId === null"
          @click="commitFolderImport"
        >
          {{ t('import.commit', { count: importPreview.entryCount }) }}
        </button>
        <p v-if="importResult" class="success-message">{{ importResult }}</p>
      </template>
    </section>
    </div>
  </section>
</template>

<style scoped>
.add-page { display: grid; gap: 1.5rem; }
.add-page-toolbar { display: flex; align-items: center; gap: 1rem; }
.add-page-toolbar h2 { margin: 0; }
.entry-composer { display: grid; grid-template-columns: minmax(240px, .8fr) minmax(280px, 1fr); gap: 1.5rem; padding: 1.25rem; border: 1px solid var(--border-subtle); border-radius: 20px; background: var(--surface); }
.media-composer { display: flex; align-items: flex-start; gap: .85rem; min-height: 310px; }
.media-dropzone, .folder-dropzone { position: relative; overflow: hidden; display: grid; place-items: center; align-content: center; gap: .45rem; border: 1px dashed var(--border-subtle); border-radius: 16px; color: var(--text-muted); cursor: pointer; background: var(--surface-muted); }
.media-dropzone { flex: 1; min-height: 310px; }
.preview-dropzone { flex: .65; }
.media-dropzone img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.media-dropzone strong { z-index: 1; }
.dropzone-plus { font-size: 2.6rem; line-height: 1; font-weight: 300; }
.media-dropzone input, .folder-dropzone input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.entry-fields { display: grid; align-content: start; gap: 1rem; }
.entry-fields label { display: grid; gap: .4rem; }
.desktop-entry-import { display: grid; gap: 1.5rem; }
.folder-dropzone { min-height: 180px; padding: 1.5rem; text-align: center; }
.batch-import { display: grid; gap: 1rem; padding: 1.25rem; border: 1px solid var(--border-subtle); border-radius: 16px; background: var(--surface); }
.batch-import h3 { margin: 0; }
.batch-import-toggle { display: flex; }
.batch-progress-overlay { position: fixed; inset: 0; display: grid; place-items: center; padding: 1rem; background: rgb(0 0 0 / 45%); z-index: 40; }
.batch-progress-card { display: grid; gap: 0.75rem; min-width: 18rem; padding: 1.25rem; border-radius: 16px; background: var(--surface); box-shadow: 0 1rem 3rem rgb(0 0 0 / 25%); }
.batch-progress-card p { margin: 0; }
.batch-progress-card progress { width: 100%; }
.browse-label { color: var(--accent); text-decoration: underline; }
.template-preview { display: grid; gap: .5rem; padding: 1rem; border-radius: 14px; background: var(--surface-muted); }
.template-preview h4 { margin: 0; }
.preview-card { display: grid; gap: .8rem; padding: 1rem; border: 1px solid var(--border-subtle); border-radius: 14px; background: var(--surface); }
.preview-card-head { display: flex; align-items: flex-start; gap: 0.8rem; }
.preview-cover { width: 4.5rem; height: 6rem; object-fit: cover; border-radius: 0.5rem; flex-shrink: 0; }
.preview-card h5 { margin: 0; font-size: 1.05rem; }
.preview-chip-row { display: flex; flex-wrap: wrap; gap: .4rem; }
.preview-chip { display: inline-flex; align-items: center; padding: .18rem .6rem; border-radius: 999px; background: var(--surface-muted); border: 1px solid var(--border-subtle); font-size: .8rem; }
.preview-chip-author { border-color: var(--accent); color: var(--accent); }
.preview-board { display: grid; gap: .9rem; }
.preview-section { display: grid; gap: .4rem; padding-top: .5rem; border-top: 1px dashed var(--border-subtle); }
.preview-section h6 { margin: 0; font-size: .85rem; letter-spacing: .04em; text-transform: uppercase; color: var(--text-muted); }
.preview-facet-row { display: grid; grid-template-columns: minmax(6.5rem, 9.5rem) minmax(0, 1fr); min-height: 1.9rem; }
.preview-facet-label { padding: .3rem .7rem .3rem 0; border-right: 1px dashed color-mix(in srgb, var(--border-subtle) 58%, transparent); color: var(--text-muted); font-size: .76rem; }
.preview-facet-tags { display: flex; flex-wrap: wrap; align-content: flex-start; gap: .35rem; padding: .3rem 0 .3rem .7rem; }
.preview-content { display: grid; gap: .35rem; padding-top: .5rem; border-top: 1px dashed var(--border-subtle); font-size: .85rem; }
.preview-content-row { display: grid; grid-template-columns: minmax(6.5rem, 9.5rem) minmax(0, 1fr); }
.preview-content-label { color: var(--text-muted); }
.import-review { display: grid; gap: 1rem; padding: 1.25rem; border: 1px solid var(--border-subtle); border-radius: 20px; background: var(--surface); }
.import-review header h3, .import-review header p { margin: .2rem 0; }
.import-review > label, .mapping-list label, .producer-review label { display: grid; gap: .4rem; }
.mapping-list, .producer-review { display: grid; gap: .75rem; padding: 1rem; border-radius: 14px; background: var(--surface-muted); }
.mapping-list label, .producer-review label:not(.checkbox-label) { grid-template-columns: minmax(120px, .5fr) minmax(220px, 1fr); align-items: center; }
.checkbox-label { grid-template-columns: auto 1fr; justify-content: start; }
.rating-select-list { display: grid; gap: .45rem; padding: .8rem; border-radius: 12px; background: var(--surface-muted); }
.rating-select-title { font-size: .8rem; color: var(--text-muted); }
.rating-select-row { display: grid; grid-template-columns: minmax(8rem, 1fr) minmax(8rem, 1fr); align-items: center; gap: .6rem; }
.success-message { color: var(--accent); }
@media (max-width: 760px) {
  .add-page-toolbar { align-items: flex-start; flex-wrap: wrap; }
  .add-page-toolbar h2 { flex-basis: 100%; }
  .entry-composer { grid-template-columns: 1fr; padding: 0.8rem; gap: 1rem; min-width: 0; }
  .media-composer { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); min-height: 0; }
  .media-dropzone { min-height: 13rem; }
  .cover-dropzone:only-child { grid-column: 1 / -1; }
  .entry-fields input:not([type='checkbox']),
  .entry-fields select,
  .entry-fields textarea { box-sizing: border-box; width: 100%; min-width: 0; min-height: 44px; }
  .entry-fields .primary-button { width: 100%; min-height: 44px; }
  .checkbox-label { min-height: 44px; align-items: center; }
  .desktop-entry-import { display: none; }
}
</style>
