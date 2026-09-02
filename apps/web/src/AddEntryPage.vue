<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { normalizeTag } from '@t3/shared';
import type { ImportCommitMapping, ImportCommitResult, ImportPreview } from '@t3/shared';
import type { GalleryApi } from './api/gallery.js';
import { collectDroppedFiles } from './dropped-files.js';
import { useI18n } from './i18n.js';

export interface ManualEntryDraft {
  title: string;
  type: string;
  uploadDate: string | null;
  coverFile: File | null;
  previewFile: File | null;
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
  imported: [entryType: string];
  batchImported: [];
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

const FIELD_FACET_RULES: Array<{ match: string[]; facet: string }> = [
  { match: ['works', '作品'], facet: 'series' },
  { match: ['characters', 'character', '登场人物'], facet: 'characters' },
  { match: ['contentTypes', 'types', '作品类型'], facet: 'type' },
  { match: ['language'], facet: 'language' },
];

function normalizedName(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

// 'producer'-vocabulary taxonomy aliases (author-name dictionary, e.g.
// 'bob' -> '鲍勃'), fetched once per page. An imported author name resolves
// through it to its canonical spelling before auto-linking, so dictionary
// merges survive re-imports of any spelling and are never re-created.
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
    if (canonical === undefined) return current;
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
  importType.value = resolveImportType(itemType, props.galleryTypes);
  producerMatches.value = Object.fromEntries(await Promise.all(
    importedAuthorValues.value.map(async (name) => {
      const canonical = await resolveProducerName(name);
      const match = authorOptions.value.find((author) => (
        author.name.localeCompare(canonical, undefined, { sensitivity: 'base' }) === 0
      ));
      return [name, match ? match.id : null];
    }),
  ));
  await loadImportLayout();
}

async function prepareImport(files: File[]): Promise<void> {
  importBusy.value = true;
  importError.value = null;
  importResult.value = null;
  try {
    await loadImportPreview(files, preferredImportType(props.galleryTypes));
  } catch (cause) {
    importError.value = cause instanceof Error ? cause.message : t('import.previewError');
  } finally {
    importBusy.value = false;
  }
}

async function loadImportLayout(): Promise<void> {
  const resolvedType = resolveImportType(importType.value, props.galleryTypes);
  if (!resolvedType) return;
  importType.value = resolvedType;
  importLayout.value = await props.api.listLayout(resolvedType);
  canonicalFacetId.value = autoCanonicalFacetId(importLayout.value);
  fieldDestinations.value = autoMapFieldDestinations(importLayout.value, importFields.value);
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
  const result = await props.api.commitImport(importPreview.value.batch, {
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
  return result;
}

async function commitFolderImport(): Promise<void> {
  importBusy.value = true;
  importError.value = null;
  try {
    const result = await commitCurrentImport();
    importResult.value = t('import.completed', { count: result.entryCount });
    emit('imported', importType.value.trim());
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
      await loadImportPreview(item.files, itemType);
      const result = await commitCurrentImport();
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
  importResult.value = null;
  importError.value = null;
  batchResult.value = t('import.batchDone', { success: succeedCount, failed: failedCount });
  emit('batchImported');
}

function submit(): void {
  emit('submit', {
    title: title.value.trim(),
    type: type.value.trim(),
    uploadDate: uploadDate.value || null,
    coverFile: coverFile.value,
    previewFile: previewFile.value,
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
          <input v-model="type" name="type" list="add-entry-gallery-types" required autocomplete="off">
          <datalist id="add-entry-gallery-types">
            <option v-for="galleryType in galleryTypes" :key="galleryType" :value="galleryType" />
          </datalist>
        </label>
        <label>{{ t('entry.uploadDate') }}<input v-model="uploadDate" name="uploadDate" type="date"></label>
        <button class="primary-button" type="submit" :disabled="submitting">
          {{ submitting ? t('entry.creating') : t('entry.create') }}
        </button>
      </div>
    </form>

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
        <input v-model="batchImportType" list="add-entry-gallery-types" required>
      </label>
      <p v-if="batchImportFiles.length > 0" class="muted">
        {{ t('import.batchLoaded', { path: batchFolderName, count: batchImportFiles.length }) }}
      </p>
      <p v-if="batchImportBusy && batchProgress" class="muted" role="status">
        {{ t('import.batchProgress', { current: batchProgress.current, total: batchProgress.total }) }}
      </p>
      <p v-if="batchResult" class="success-message" role="status">{{ batchResult }}</p>
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
          <input v-model="importType" list="add-entry-gallery-types" required @change="loadImportLayout">
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
.folder-dropzone { min-height: 180px; padding: 1.5rem; text-align: center; }
.batch-import { display: grid; gap: 1rem; padding: 1.25rem; border: 1px solid var(--border-subtle); border-radius: 16px; background: var(--surface); }
.batch-import h3 { margin: 0; }
.batch-import-toggle { display: flex; }
.batch-progress-overlay { position: fixed; inset: 0; display: grid; place-items: center; padding: 1rem; background: rgb(0 0 0 / 45%); z-index: 40; }
.batch-progress-card { display: grid; gap: 0.75rem; min-width: 18rem; padding: 1.25rem; border-radius: 16px; background: var(--surface); box-shadow: 0 1rem 3rem rgb(0 0 0 / 25%); }
.batch-progress-card p { margin: 0; }
.batch-progress-card progress { width: 100%; }
.browse-label { color: var(--accent); text-decoration: underline; }
.import-review { display: grid; gap: 1rem; padding: 1.25rem; border: 1px solid var(--border-subtle); border-radius: 20px; background: var(--surface); }
.import-review header h3, .import-review header p { margin: .2rem 0; }
.import-review > label, .mapping-list label, .producer-review label { display: grid; gap: .4rem; }
.mapping-list, .producer-review { display: grid; gap: .75rem; padding: 1rem; border-radius: 14px; background: var(--surface-muted); }
.mapping-list label, .producer-review label:not(.checkbox-label) { grid-template-columns: minmax(120px, .5fr) minmax(220px, 1fr); align-items: center; }
.checkbox-label { grid-template-columns: auto 1fr; justify-content: start; }
.success-message { color: var(--accent); }
@media (max-width: 760px) { .entry-composer { grid-template-columns: 1fr; } }
</style>
