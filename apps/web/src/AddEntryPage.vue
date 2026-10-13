<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { normalizeTag, parseDurationSeconds } from '@t3/shared';
import type { ImportAuthorRating, ImportBatch, ImportCommitMapping, ImportCommitResult, ImportEntry, ImportPreview, RatingSlotDto } from '@t3/shared';
import type { GalleryApi } from './api/gallery.js';
import AdvancedImportPanel from './components/AdvancedImportPanel.vue';
import RuleBuilderPanel from './components/RuleBuilderPanel.vue';
import SuggestionInput from './components/SuggestionInput.vue';
import { entryStackLayerStyle, entryStackLayers } from './entry-media-stack.js';
import { collectDroppedFiles } from './dropped-files.js';
import { useI18n, type MessageKey } from './i18n.js';
import { showNsfw } from './stores/preferences.js';
import { copyText } from './clipboard.js';

export interface ManualEntryDraftRating {
  slotId: number;
  stars: number | null;
}

export interface ManualEntryDraft {
  title: string;
  type: string;
  /**
   * Not offered on this page any more: a work's date belongs to the work, so it comes from the page
   * (the advanced path) or is typed on the Entry. Kept in the draft so the Entry page's editing and
   * the offline queue keep one shape.
   */
  uploadDate: string | null;
  pageCount: number | null;
  /** A video's runtime in seconds, typed in any of h:mm:ss / mm:ss / m:ss / ss / s. */
  durationSeconds: number | null;
  coverFile: File | null;
  /** Up to three: an Entry shows a cover plus its previews, which is the stack's own limit of 4. */
  previewFiles: File[];
  ratings: ManualEntryDraftRating[];
  viewLater: boolean;
  /** The address the work was read from, stored as the Entry's Source once it exists. */
  sourceUrl: string | null;
  /**
   * An optional Author for this work, typed here rather than managed after the
   * fact. The commit resolves it through the producer vocabulary: an existing
   * Author (or an alias spelling) is linked, a new name creates one.
   */
  authorName?: string;
  contents?: Array<{ contentType: string; content: string }>;
  /** The template buttons hand the Entry straight to detailed editing. */
  openInEditor?: boolean;
}

const props = defineProps<{
  api: GalleryApi;
  /** Every Gallery's type, in the sidebar's order — used by the import paths to resolve a spelling. */
  galleryTypes: string[];
  /**
   * The same Galleries with the flag the sidebar marks them by. The type field offers these, so
   * choosing one is choosing something that exists; a type that does not exist is still created by
   * typing it, which is what the hint under the field says.
   */
  galleries: Array<{ type: string; nsfw: boolean }>;
  authors: Array<{ id: number; name: string; galleryType: string | null }>;
  submitting: boolean;
  /** The shell-level failure of the last submit attempt, shown beside the submit button. */
  submitError?: string | null | undefined;
  /**
   * Read-only view of the offline state, handed down by the app shell. The one-link fetch runs on
   * the server, so it cannot work offline: the button says so rather than failing.
   */
  offlineState?: { mode: 'online' | 'offline' } | undefined;
}>();
const emit = defineEmits<{
  back: [];
  submit: [draft: ManualEntryDraft];
  imported: [
    entryType: string,
    entryIds: number[],
    viewLater: boolean,
    /** Works this export carried but did not create, because the library had them. */
    existingEntryIds: number[],
    /**
     * Open the created work in the editor instead of the reading view: the review's "create your own
     * template" path ends there, where the app's own apply-to-all prompt takes over.
     */
    openInEditor: boolean,
  ];
  batchImported: [
    entryType: string,
    entryIds: number[],
    viewLater: boolean,
    warnings: string[],
    /** Works this run carried but did not create, because the library had them. */
    existingEntryIds: number[],
  ];
}>();
const { t } = useI18n();
const title = ref('');
const type = ref(props.galleryTypes[0] ?? '');
/** Whether the type field's own dropdown is open. */
const typeListOpen = ref(false);
const typeCombobox = ref<HTMLElement | null>(null);
/** The review's Gallery field is the same control: a dropdown that also takes a new name. */
const importTypeCombobox = ref<HTMLElement | null>(null);

/**
 * What the type field offers: the Galleries the sidebar would show, in the same order and under the
 * same preference — SFW only while that is the mode, everything once NSFW is on. A type that is not
 * in this list is not offered, because it does not exist yet; typing it creates it.
 */
const selectableGalleries = computed(() => (
  props.galleries.filter((gallery) => showNsfw.value || !gallery.nsfw)
));

function chooseGallery(galleryType: string): void {
  type.value = galleryType;
  typeListOpen.value = false;
  typeCombobox.value?.querySelector('input')?.focus();
}

const importTypeListOpen = ref(false);

function chooseImportGallery(galleryType: string): void {
  importType.value = galleryType;
  importTypeListOpen.value = false;
  // The Gallery decides the template, so the same change a typed value triggers has to happen here.
  void loadImportLayout();
}

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target as Node | null;
  if (typeListOpen.value
      && !(target && typeCombobox.value?.contains(target))) {
    typeListOpen.value = false;
  }
  if (importTypeListOpen.value
      && !(target && importTypeCombobox.value?.contains(target))) {
    importTypeListOpen.value = false;
  }
}

watch(typeListOpen, (open) => {
  if (open) document.addEventListener('pointerdown', onDocumentPointerDown);
  else document.removeEventListener('pointerdown', onDocumentPointerDown);
});

watch(importTypeListOpen, (open) => {
  if (open) document.addEventListener('pointerdown', onDocumentPointerDown);
  else document.removeEventListener('pointerdown', onDocumentPointerDown);
});
const uploadDate = ref('');
const pageCount = ref('');
const duration = ref('');
const durationError = ref<string | null>(null);
const durationInput = ref<HTMLInputElement | null>(null);
const coverFile = ref<File | null>(null);
const previewFiles = ref<File[]>([]);
/** Object URLs for the images chosen here, in the order they will be stored. */
const coverPreview = ref<string | null>(null);
const previewPreviews = ref<string[]>([]);
/** An Entry has four slots: one cover and three previews (the stack's own limit, `MAX_VISIBLE_LAYERS`). */
const MEDIA_LIMIT = 4;

/** Which of the four pages is open. Only the first has a specification so far. */
type AddPageTab = 'quick' | 'advanced' | 'rules' | 'files' | 'import';
const activeTab = ref<AddPageTab>('quick');
const addPages: Array<{ key: AddPageTab; label: MessageKey }> = [
  { key: 'quick', label: 'entry.pageQuick' },
  { key: 'advanced', label: 'entry.pageAdvanced' },
  { key: 'rules', label: 'entry.pageRules' },
  { key: 'files', label: 'entry.pageFiles' },
  { key: 'import', label: 'entry.pageImport' },
];

const mediaNotice = ref<string | null>(null);
const linkUrl = ref('');
const linkState = ref<'idle' | 'working' | 'done' | 'failed' | 'bug'>('idle');
const linkMessage = ref<string | null>(null);
const linkLogPath = ref<string | null>(null);
const linkSuggestsAdvanced = ref(false);
const linkCoverBytes = ref<number | null>(null);
const offline = computed(() => props.offlineState?.mode === 'offline');
const linkStatus = computed(() => {
  if (offline.value) return t('entry.linkOffline');
  if (linkState.value === 'working') return t('entry.linkWorking');
  if (linkState.value === 'done') return t('entry.linkDone');
  // Before anything has been asked: what this button is for. The line beside it is the one place
  // with room, and it is exactly where the answer will appear — so the space is never blank and the
  // button is never a mystery. A failure replaces it with its own message below.
  if (linkState.value === 'idle') return t('entry.tryLinkHint');
  return '';
});
const importPreview = ref<ImportPreview | null>(null);
const importFiles = ref<File[]>([]);
// Where this export came from. A dropped folder arrives as files the browser must upload after the
// commit; an export the server already holds (a crawl T³ started) is read in place, media included.
const importSource = ref<'upload' | 'path'>('upload');
const importType = ref(props.galleryTypes[0] ?? '');
const importLayout = ref<Awaited<ReturnType<GalleryApi['listLayout']>>>([]);
const manualContentType = ref('');
const manualViewLater = ref(false);
const authorName = ref('');
/**
 * The same server suggestions the Entry's own author link uses, through the
 * offline-aware facade: online they come from the server, offline from the
 * saved copy's vocabulary.
 */
function suggestAuthor(query: string, excludeIds: number[], signal: AbortSignal) {
  return props.api.suggestProducers({ q: query, excludeIds }, signal);
}
const initialContentType = ref('');
const initialContentText = ref('');
// The composer stays a plain cover + fields form: the Gallery template is edited
// on the Entry itself, where the structure it applies to is visible. This only
// decides what the secondary button offers.
const entryTypeExists = computed(() => props.galleryTypes.includes(type.value.trim()));
const isNewGallery = computed(() => {
  const candidate = type.value.trim();
  return candidate !== '' && !entryTypeExists.value;
});
const importViewLater = ref(false);
const committedImportEntryIds: number[] = [];
const manualRatingSlots = ref<RatingSlotDto[]>([]);
const manualRatings = ref<Record<number, number | null>>({});
// Import reviews Author ratings instead of per-work ratings: a bulk import
// cannot judge every work, while the Author score is one decision per name.
// Dimensions are the import Gallery's Entry rating slots, which the server
// mirrors onto the Author by name. Values are keyed by author name and survive
// every batch item so each commit re-sends the same reviewed values.
const authorRatingSlots = ref<RatingSlotDto[]>([]);
const authorRatingOpen = ref<Record<string, boolean>>({});
const authorRatings = ref<Record<string, Record<string, number | null>>>({});
const contentTypeOptions = ref<string[]>([]);
const canonicalFacetId = ref<number | null>(null);
const fieldDestinations = ref<Record<string, string>>({});
const producerMatches = ref<Record<string, number | null>>({});
// Live author list for auto-link matching. `props.authors` is only refreshed on
// single-import commit, so batch import keeps its own copy and re-fetches it
// whenever a commit creates producers — otherwise every batch item whose author
// was created earlier in the same batch would spawn a duplicate producer.
const authorOptions = ref<Array<{ id: number; name: string; galleryType: string | null }>>(props.authors);
watch(() => props.authors, (list) => {
  authorOptions.value = list;
});
const createUnmatchedAuthors = ref(true);
/**
 * One Author for the whole batch, typed here rather than in a mapped field.
 * The commit resolves it through the same 'producer' vocabulary as imported
 * names, so an existing Author — or an alias spelling of one — is linked
 * instead of duplicated, and only a name nobody holds creates a new Author.
 */
const importAuthorName = ref('');
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
/**
 * This Gallery has no template yet: no Sections, no Facets.
 *
 * A commit needs a Facet to put Tags in, so this is the state the import cannot finish from — and
 * the one the review has to say out loud, because an import that quietly drops a work's Tags is
 * worse than one that stops and asks. Two ways out, both here: take the common template, or create
 * this Gallery's own by opening the work's editor.
 */
const hasNoTemplate = computed(() => importPreview.value !== null && importLayout.value.length === 0);
const commonTemplateBusy = ref(false);

async function useCommonTemplate(): Promise<void> {
  const type = importType.value.trim();
  if (type === '' || commonTemplateBusy.value) return;
  commonTemplateBusy.value = true;
  importError.value = null;
  try {
    await props.api.applyCommonTemplate(type);
    // A Gallery may have applied the earlier, slot-less version of the template; the back-fill is
    // idempotent, so calling it here covers both without either call caring which case it is.
    await props.api.applyCommonTemplateRatingSlots(type);
    // The Facets the Gallery now has are the ones the Tags need, so everything downstream reloads:
    // the canonical Facet, the per-field destinations, the rating slots, and the template preview.
    await loadImportLayout();
  } catch (cause) {
    importError.value = cause instanceof Error ? cause.message : t('import.commonTemplateError');
  } finally {
    commonTemplateBusy.value = false;
  }
}

/**
 * Create this Gallery's own template instead: commit the work, then open its editor.
 *
 * The work has to exist before there is anything to edit, so this commits with no tag Facet (the
 * Tags of this one work are lost — the notice says so) and hands the created Entry to the parent,
 * which opens it in the editor. Finishing that edit raises the app's own "apply to all" prompt,
 * which is the same door the quick page uses.
 */
async function createOwnTemplate(): Promise<void> {
  if (importBusy.value || importPreview.value === null) return;
  importBusy.value = true;
  importError.value = null;
  try {
    const result = await commitCurrentImport({ allowNoTemplate: true });
    committedImportEntryIds.splice(
      0, committedImportEntryIds.length, ...result.entries.map((record) => record.entryId));
    emit(
      'imported',
      importType.value.trim(),
      committedImportEntryIds,
      importViewLater.value,
      result.existingEntryIds,
      true,
    );
  } catch (cause) {
    importError.value = cause instanceof Error ? cause.message : t('import.commitError');
  } finally {
    importBusy.value = false;
  }
}
const batchContentTypeFacetId = computed(() => findFacetIdByNames(batchLayout.value, ['type']));
const previewEntry = computed(() => importPreview.value?.batch.entries[0] ?? null);

// Preview cover: export folders are not served by the dev/preview server, so
// resolve the cover file among the dropped files and render it as an object
// URL. Revoked whenever the preview changes or the page unmounts.
const previewCoverUrl = ref<string | null>(null);
let previewCoverUrlRevoke: (() => void) | null = null;

watch([previewEntry, importFiles, importSource], () => {
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
  // A server-run crawl hands the review an **absolute path** into the export tree: the file is on
  // the server's disk, not among the files the page holds, so the guarded export-file route serves
  // it. This shape arrived when covers started landing for real — before the media fix, a cover
  // that reached this review was always a remote URL and showed; one read from the export was
  // invisible here, which read as "the cover disappeared" on the very run that had fixed it.
  if (importSource.value === 'path') {
    previewCoverUrl.value = props.api.siteprobeExportFileUrl(cover);
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
    // The picker's own promise, kept: the row a person marked as the work's synopsis is imported as
    // its Content, so it arrives destined for Content rather than Ignore. The review can still send
    // it anywhere else — this is a default, not a decision.
    if (normalizedName(field) === 'description') {
      destinations[field] = 'content';
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

/** Every image on this page, in storage order: the cover first, then its previews. */
const mediaRefs = computed<string[]>(() => [
  ...(coverPreview.value ? [coverPreview.value] : []),
  ...previewPreviews.value,
]);
const mediaFull = computed(() => mediaRefs.value.length >= MEDIA_LIMIT);

/**
 * The layers the preview shows, in the order the work card stacks them.
 *
 * The geometry is the shared one (`entryStackLayerStyle` — the rotated overlap a saved Entry shows
 * in the gallery), so this preview and the Entry it becomes are one derivation and cannot drift.
 * The three CSS rules that wrap it are local to this page on purpose: the card's own copy lives in
 * `EntryCard.vue`, which the mobile build also renders, and refactoring a shared visual belongs in
 * a change about that, not in a form rewrite.
 */
const stackRefs = computed<string[]>(() => mediaRefs.value);
const stackLayerStyle = (index: number): Record<string, string> => entryStackLayerStyle(
  index,
  entryStackLayers({ coverRef: null, previewRefs: stackRefs.value }).length,
);

/** Add images in order: the first one kept becomes the cover, everything after it a preview. */
function addImages(files: File[]): void {
  const images = files.filter((file) => file.type.startsWith('image/'));
  if (images.length === 0) return;
  mediaNotice.value = null;
  let over = 0;
  for (const file of images) {
    if (coverFile.value === null) {
      coverFile.value = file;
      coverPreview.value = URL.createObjectURL(file);
      continue;
    }
    if (previewFiles.value.length >= MEDIA_LIMIT - 1) {
      over += 1;
      continue;
    }
    previewFiles.value = [...previewFiles.value, file];
    previewPreviews.value = [...previewPreviews.value, URL.createObjectURL(file)];
  }
  if (over > 0) mediaNotice.value = t('entry.mediaLimit');
}

function dropImages(event: DragEvent): void {
  addImages([...(event.dataTransfer?.files ?? [])]);
}

/** The one-link fetch: the server reads the page with no site rule and fills in what it finds. */
async function tryLink(): Promise<void> {
  const url = linkUrl.value.trim();
  if (url === '' || offline.value || linkState.value === 'working') return;
  linkState.value = 'working';
  linkMessage.value = null;
  linkLogPath.value = null;
  linkSuggestsAdvanced.value = false;
  try {
    const meta = await props.api.fetchSiteProbeLinkMeta(url);
    if (meta.verdict === 'found') {
      // A title the person already typed is theirs to keep; the cover is what this button is for.
      if (meta.title && title.value.trim() === '') title.value = meta.title;
      linkCoverBytes.value = meta.coverBytes;
      if (meta.coverDataUrl) useFetchedCover(meta.coverDataUrl, meta.coverMimeType);
      linkState.value = 'done';
      return;
    }
    linkState.value = meta.verdict === 'bug' ? 'bug' : 'failed';
    linkSuggestsAdvanced.value = meta.verdict === 'needs-advanced';
    linkLogPath.value = meta.logPath;
    linkMessage.value = meta.verdict === 'needs-advanced'
      ? t('entry.linkNeedsAdvanced')
      : meta.verdict === 'invalid'
        ? t('entry.linkInvalid')
        : t('entry.linkBug');
  } catch (cause) {
    linkState.value = 'bug';
    linkMessage.value = cause instanceof Error ? cause.message : t('entry.linkBug');
  }
}

/**
 * The fetched cover becomes an ordinary chosen file, so creating the Entry needs no second path.
 *
 * The bytes arrive inside the answer as a data URL (`coverDataUrl`), so nothing is fetched and no file
 * exists in between: Level 0 read the page and kept nothing, and this page hands those bytes to the
 * same upload path a dropped image takes. That is why the two are indistinguishable from here on.
 *
 * The name only has to carry the right extension — the media store picks the stored file's extension
 * from the mime type it is given — so it is derived from that type.
 */
function useFetchedCover(coverDataUrl: string, mimeType: string | null): void {
  const base64 = coverDataUrl.slice(coverDataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const type = mimeType ?? 'image/jpeg';
  const extension = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  addImages([new File([bytes], `cover.${extension}`, { type })]);
}

async function copyDiagnostics(): Promise<void> {
  const lines = [
    'T3 link fetch',
    'url      ' + linkUrl.value.trim(),
    'log      ' + (linkLogPath.value ?? '(none)'),
    'cover    ' + (linkCoverBytes.value === null ? '(none)' : String(linkCoverBytes.value) + ' bytes'),
    'status   ' + linkState.value,
    'message  ' + (linkMessage.value ?? ''),
  ];
  try {
    await copyText(lines.join(String.fromCharCode(10)));
    mediaNotice.value = t('entry.diagnosticsCopied');
  } catch {
    // A clipboard the browser refuses is not worth an error of its own; the log path stays visible.
  }
}

function chooseImages(event: Event, target: 'cover' | 'preview'): void {
  void target;
  addImages([...((event.target as HTMLInputElement).files ?? [])]);
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
  importSource.value = 'upload';
  const from = activeTab.value;
  await applyImportPreview(await props.api.previewSiteProbeFolder(itemFiles), itemType, from);
}

/**
 * Everything the review screen needs once a preview exists, whatever produced it.
 *
 * Shared between the two doors on purpose: a dropped export folder arrives as files the browser
 * uploads, and an export T³ fetched itself arrives as a path the server reads — but the review, the
 * Author matching and the field mapping are the same screen and must behave identically.
 *
 * `from` is the page the person was on when they started this, and the review takes over the import
 * page **only if they are still there**. It used to take over unconditionally, so preparing a folder
 * — or waiting out a crawl that then produces its review — pulled the person out of whatever page
 * they had moved to in the meantime, which reads as the page doing something on its own. Every door
 * below passes the page it was opened from: the folder drop and the two panels that can finish with
 * an export.
 */
async function applyImportPreview(preview: ImportPreview, itemType: string,
                                  from: AddPageTab): Promise<void> {
  if (activeTab.value === from) activeTab.value = 'import';
  importPreview.value = preview;
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

/** The address the advanced page handed to the rule-building page (it carries it over verbatim). */
const ruleDraftUrl = ref('');

/** The advanced page found no rule for this address: build one, starting from the address itself. */
function openRuleBuilding(url: string): void {
  ruleDraftUrl.value = url;
  activeTab.value = 'rules';
}

/**
 * The SiteProbe panel finished a crawl: review the export it produced.
 *
 * `from` is the page the panel lives on, so a person who moved elsewhere while the crawl ran keeps
 * reading what they moved to — the review is waiting on the import page when they get back to it.
 */
async function useExportPreview(payload: { preview: ImportPreview; source: 'path' },
                                from: AddPageTab): Promise<void> {
  importBusy.value = true;
  importError.value = null;
  importResult.value = null;
  manualContentType.value = '';
  try {
    importFiles.value = [];
    importSource.value = payload.source;
    await applyImportPreview(payload.preview, preferredImportType(props.galleryTypes), from);
  } catch (cause) {
    importError.value = cause instanceof Error ? cause.message : t('import.previewError');
  } finally {
    importBusy.value = false;
  }
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

async function loadRatingSlots(entryType: string, target: 'manual' | 'import'): Promise<void> {
  try {
    const slots = await props.api.listRatingSlots(entryType);
    if (target === 'manual') {
      manualRatingSlots.value = slots;
      manualRatings.value = Object.fromEntries(slots.map((slot) => [slot.id, null]));
    } else {
      // Reloaded for every batch item: keep the reviewed Author values and only
      // drop dimensions the newly resolved Gallery no longer defines.
      const dimensions = new Set(slots.map((slot) => slot.name));
      authorRatingSlots.value = slots;
      authorRatings.value = Object.fromEntries(Object.entries(authorRatings.value).map(
        ([name, values]) => [
          name,
          Object.fromEntries(Object.entries(values).filter(([dimension]) => dimensions.has(dimension))),
        ],
      ));
    }
  } catch {
    if (target === 'manual') manualRatingSlots.value = [];
    else authorRatingSlots.value = [];
  }
}

function authorRatingValue(name: string, dimension: string): string {
  const value = authorRatings.value[name]?.[dimension];
  return value === null || value === undefined ? '' : String(value);
}

function setAuthorRatingValue(name: string, dimension: string, event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  const values = authorRatings.value[name] ?? {};
  values[dimension] = value === '' ? null : Number(value);
  authorRatings.value = { ...authorRatings.value, [name]: values };
}

function toggleAuthorRating(name: string, event: Event): void {
  authorRatingOpen.value = {
    ...authorRatingOpen.value,
    [name]: (event.target as HTMLInputElement).checked,
  };
}

/**
 * An Author rating can only be recorded on the Author's own dominant Gallery,
 * so the review offers it for new Authors and for linked Authors that already
 * belong to the import Gallery.
 */
function canRateAuthor(name: string): boolean {
  if (authorRatingSlots.value.length === 0) return false;
  const matchedId = producerMatches.value[name];
  if (matchedId === null || matchedId === undefined) return true;
  const author = authorOptions.value.find((candidate) => candidate.id === matchedId);
  const galleryType = author?.galleryType ?? null;
  return galleryType === null || galleryType === importType.value.trim();
}

function reviewedAuthorRatings(): ImportAuthorRating[] {
  const ratings: ImportAuthorRating[] = [];
  for (const [name, values] of Object.entries(authorRatings.value)) {
    if (authorRatingOpen.value[name] !== true) continue;
    for (const [slotName, stars] of Object.entries(values)) {
      if (stars === null || stars === undefined) continue;
      ratings.push({ name, slotName, stars });
    }
  }
  return ratings;
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
}

function selectedFile(relativePath: string): File | null {
  const normalized = relativePath.replace(/\\/gu, '/').replace(/^\/+/, '');
  return importFiles.value.find((file) => {
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    return path.replace(/\\/gu, '/').endsWith(`/${normalized}`) || path === normalized;
  }) ?? null;
}

async function commitCurrentImport(options: { allowNoTemplate?: boolean } = {}): Promise<ImportCommitResult> {
  if (!importPreview.value) throw new Error(t('import.previewError'));
  // Committing with no canonical Facet drops this batch's Tags. That is only ever right on the
  // "create your own template" path, where the notice has already said so and the alternative is a
  // dead end — the Tags of *this* work are the price of a Gallery that can carry the next one's.
  if (canonicalFacetId.value === null && options.allowNoTemplate !== true) {
    throw new Error(t('import.layoutRequired'));
  }
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

  const commit = importSource.value === 'path'
    ? props.api.commitImportPath(batch, {
      entryType: importType.value.trim(),
      canonicalTagFacetId: canonicalFacetId.value,
      sourceContentType: 'Source URL',
      externalKeyContentType: 'External Key',
      fieldMappings,
      ignoredFields,
      authorRatings: reviewedAuthorRatings(),
      ...(importAuthorName.value.trim() === '' ? {} : { authorName: importAuthorName.value.trim() }),
    })
    : props.api.commitImport(batch, {
      entryType: importType.value.trim(),
      canonicalTagFacetId: canonicalFacetId.value,
      sourceContentType: 'Source URL',
      externalKeyContentType: 'External Key',
      fieldMappings,
      ignoredFields,
      authorRatings: reviewedAuthorRatings(),
      ...(importAuthorName.value.trim() === '' ? {} : { authorName: importAuthorName.value.trim() }),
    });
  const result = await commit;
  const importedEntriesByExternalKey = new Map(
    importPreview.value.batch.entries
      .filter((entry): entry is typeof entry & { externalKey: string } => entry.externalKey !== undefined)
      .map((entry) => [entry.externalKey, entry]),
  );
  for (let index = 0; index < result.entries.length; index += 1) {
    const entryRecord = result.entries[index]!;
    const imported = entryRecord.externalKey === undefined
      ? (result.skippedExistingEntryCount === 0 ? importPreview.value.batch.entries[index] : undefined)
      : importedEntriesByExternalKey.get(entryRecord.externalKey);
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
  // ---- interruption repair (added 2026-10-05) ----------------------------------------------
  // The uploads above are one awaited request per picture, and the rows were committed before any
  // of them. Closing the tab in the middle of that loop leaves a work that is in the library with
  // none — or some — of its pictures, and every later import of the same folder *skips* it, because
  // the work is already there. So a re-import has to finish the job rather than pass over it.
  //
  // Only what is missing is sent: a cover the work already has is the person's (the editor lets
  // them pick one), and a preview ref *appends*, so sending the same picture twice puts it on two
  // layers of the stack rather than being a no-op.
  //
  // What the browser can decide is bounded by what it has: the files, not the library's stored
  // bytes. So it fills what is *empty* instead of proving by content which pictures are there —
  // that is the whole of the interruption this loop has to survive, and it can never duplicate.
  // The server-side import of the same export does the content-exact version, because there it has
  // the files on disk (`storeExportMedia`).
  for (const skipped of result.skippedExisting ?? []) {
    const imported = skipped.externalKey === undefined
      ? undefined
      : importedEntriesByExternalKey.get(skipped.externalKey);
    if (!imported) continue;
    const detail = await props.api.getEntry(skipped.entryId);
    if (detail.coverRef === null) {
      const cover = imported.cover;
      const file = cover && !/^https?:\/\//u.test(cover) ? selectedFile(cover) : undefined;
      if (file) await props.api.uploadEntryMedia(skipped.entryId, 'cover', file);
    }
    if (detail.previewRefs.length === 0) {
      for (const preview of imported.previews ?? (imported.preview ? [imported.preview] : [])) {
        const file = preview && !/^https?:\/\//u.test(preview) ? selectedFile(preview) : undefined;
        if (file) await props.api.uploadEntryMedia(skipped.entryId, 'preview', file);
      }
    }
  }
  // ---- end interruption repair --------------------------------------------------------------
  // Imported data carries no work ratings any more: the review records Author
  // ratings inside the commit instead, and individual works are rated from
  // their own detail pages.
  return result;
}

/**
 * How long the commit is waited for before the page stops waiting.
 *
 * A commit that never settles leaves the button reading 准备导入… for ever, which is exactly the
 * report "it shows Preparing Import and then just stays there". Measured on this machine the commit
 * itself takes ~37ms, so this bound is only ever reached by something genuinely stuck. Two minutes,
 * not less: a large batch stores every picture's thumbnail, and a deadline that fires during honest
 * work would be its own bug. Retrying is safe — a commit skips works the library already holds.
 */
const COMMIT_DEADLINE_MS = 120_000;

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t('import.commitTimeout'))), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function commitFolderImport(): Promise<void> {
  importBusy.value = true;
  importError.value = null;
  try {
    const result = await withDeadline(commitCurrentImport(), COMMIT_DEADLINE_MS);
    const committedIds = result.entries.map((record) => record.entryId);
    committedImportEntryIds.splice(0, committedImportEntryIds.length, ...committedIds);
    importResult.value = t('import.completed', { count: result.entryCount });
    emit(
      'imported',
      importType.value.trim(),
      committedImportEntryIds,
      importViewLater.value,
      result.existingEntryIds,
      false,
    );
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

/**
 * Reviews the batch before it runs. The Author decisions and Author ratings are
 * per name and are re-sent by every commit in the batch, so the review only
 * needs one representative work to list the Authors it will touch.
 */
async function reviewBatchFolder(): Promise<void> {
  const first = itemsByFolder(batchImportFiles.value)[0];
  if (!first) return;
  try {
    await loadImportPreview(first.files, batchImportType.value);
  } catch {
    // A single unreadable work must not block the batch: the run reports its
    // own per-item failures.
    importPreview.value = null;
  }
}

async function dropBatchFolder(event: DragEvent): Promise<void> {
  if (!event.dataTransfer) return;
  batchImportFiles.value = await collectDroppedFiles(event.dataTransfer);
  await reviewBatchFolder();
}

async function chooseBatchFolder(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  batchImportFiles.value = input.files ? [...input.files] : [];
  await reviewBatchFolder();
}

async function runBatchImport(): Promise<void> {
  if (batchImportBusy.value) return;
  const itemType = batchImportType.value.trim();
  if (!itemType) return;
  const folderItems = itemsByFolder(batchImportFiles.value);
  const committedEntryIds: number[] = [];
  // A work the run found already imported is still part of what this folder
  // holds, and the folder it came from says something the work did not.
  const existingEntryIds: number[] = [];
  if (folderItems.length === 0) {
    batchResult.value = t('import.batchEmpty');
    return;
  }
  batchImportBusy.value = true;
  batchResult.value = null;
  const batchWarnings: string[] = [];
  batchProgress.value = { total: folderItems.length, current: 0 };
  let succeedCount = 0;
  let failedCount = 0;
  for (const item of folderItems) {
    batchProgress.value.current += 1;
    try {
      manualContentType.value = batchContentType.value.trim();
      await loadImportPreview(item.files, itemType);
      const result = await commitCurrentImport();
      for (const record of result.entries) committedEntryIds.push(record.entryId);
      existingEntryIds.push(...result.existingEntryIds);
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
      batchWarnings.push(...result.warnings);
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
  importResult.value = null;
  importError.value = null;
  batchResult.value = t('import.batchDone', { success: succeedCount, failed: failedCount });
  if (existingEntryIds.length > 0) {
    batchWarnings.push(t('import.batchDuplicates', { count: existingEntryIds.length }));
  }
  // Emit the type the commits actually used, not the raw text the user typed:
  // the batch review loads its cards by that type, and a typed `comic` resolves
  // to the stored `Comic`, so passing the raw text would show an empty group.
  emit(
    'batchImported',
    importType.value.trim(),
    committedEntryIds,
    batchViewLater.value,
    batchWarnings,
    existingEntryIds,
  );
}

/**
 * The runtime, in the unit the Entry stores. An empty box means "no runtime"; anything else has to
 * be one of the accepted shapes, and that is checked where a person can still fix it rather than
 * being dropped on the way to the library.
 */
function durationSecondsValue(): number | null {
  const raw = duration.value.trim();
  return raw === '' ? null : parseDurationSeconds(raw);
}

function durationIsValid(): boolean {
  const raw = duration.value.trim();
  if (raw === '' || parseDurationSeconds(raw) !== null) {
    durationError.value = null;
    return true;
  }
  durationError.value = t('error.durationFormat');
  void nextTick(() => durationInput.value?.focus());
  return false;
}

function manualDraft(): ManualEntryDraft {
  return {
    title: title.value.trim(),
    type: type.value.trim(),
    uploadDate: uploadDate.value || null,
    pageCount: pageCount.value === '' ? null : Number(pageCount.value),
    durationSeconds: durationSecondsValue(),
    coverFile: coverFile.value,
    previewFiles: [...previewFiles.value],
    sourceUrl: linkUrl.value.trim() === '' ? null : linkUrl.value.trim(),
    contents: initialContentType.value.trim() && initialContentText.value.trim()
      ? [{ contentType: initialContentType.value.trim(), content: initialContentText.value.trim() }]
      : [],
    ratings: Object.entries(manualRatings.value)
      .map(([slotId, stars]) => ({ slotId: Number(slotId), stars }))
      .filter((rating) => rating.stars !== null),
    viewLater: manualViewLater.value,
    ...(authorName.value.trim() === '' ? {} : { authorName: authorName.value.trim() }),
  };
}

function submit(): void {
  if (!durationIsValid()) return;
  emit('submit', manualDraft());
}

/**
 * The template path: create the work with what is filled in and open it in edit
 * mode. An existing Gallery applies its template by itself; a new one starts
 * from the bare Entry, where the template can be built and applied from there.
 */
function submitWithTemplate(): void {
  if (!durationIsValid()) return;
  emit('submit', { ...manualDraft(), openInEditor: true });
}

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  if (coverPreview.value) URL.revokeObjectURL(coverPreview.value);
  for (const url of previewPreviews.value) URL.revokeObjectURL(url);
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

    <!-- Four pages, one per way of getting a work in. The tab strip is the same component the
         Collections page uses (`.recent-tabs`, global CSS), so the active tab is joined to the
         panel below it the way a folder tab is. -->
    <div class="recent-tab-shell">
      <div class="recent-tabs" role="tablist" :aria-label="t('entry.pages')">
        <button
          v-for="page in addPages"
          :key="page.key"
          type="button"
          class="recent-tab"
          :class="{ 'recent-tab-active': activeTab === page.key }"
          :data-testid="`add-entry-tab-${page.key}`"
          role="tab"
          :aria-selected="activeTab === page.key"
          @click="activeTab = page.key"
        >{{ t(page.label) }}</button>
      </div>

      <div class="recent-tab-panel" role="tabpanel">
    <form
      v-if="activeTab === 'quick'"
      data-testid="manual-entry-form"
      class="entry-composer"
      @submit.prevent="submit"
    >
      <div class="media-composer" @dragover.prevent @drop.prevent="dropImages">
        <template v-if="mediaRefs.length === 0">
          <label data-testid="entry-cover-dropzone" class="media-dropzone cover-dropzone">
            <span class="dropzone-plus">+</span>
            <strong>{{ t('entry.cover') }}</strong>
            <input type="file" accept="image/*" multiple @change="chooseImages($event, 'cover')">
          </label>
        </template>
        <template v-else>
          <!-- Upper half: the cover as the Entry will show it. One image is the cover itself; from
               the second on it is the work card's own overlapped stack, computed by the shared
               `entryStackLayerStyle`, so what is previewed here is what the gallery will render. -->
          <div class="media-cover-slot" data-testid="entry-cover-slot">
            <img
              v-if="stackRefs.length === 1"
              class="cover-single"
              :src="stackRefs[0]"
              :alt="t('entry.cover')"
            >
            <div v-else class="entry-stack" data-testid="entry-media-stack">
              <img
                v-for="(ref, index) in stackRefs"
                :key="ref"
                class="entry-stack-image"
                :src="ref"
                :alt="t('entry.cover')"
                :style="stackLayerStyle(index)"
              >
            </div>
          </div>
          <!-- Lower half: the same box, offering a preview rather than a cover. -->
          <label
            v-if="!mediaFull"
            data-testid="entry-preview-dropzone"
            class="media-dropzone preview-dropzone"
          >
            <span class="dropzone-plus">+</span>
            <strong>{{ t('entry.addMoreAsPreview') }}</strong>
            <input type="file" accept="image/*" multiple @change="chooseImages($event, 'preview')">
          </label>
          <p v-else class="media-limit" data-testid="entry-media-limit">
            {{ t('entry.mediaFull') }}
          </p>
        </template>
        <p v-if="mediaNotice" class="media-notice" data-testid="entry-media-notice" role="status">
          {{ mediaNotice }}
        </p>
      </div>

      <div class="entry-fields">
        <!-- The address first: it is what the one-link fetch reads, and once the Entry exists it is
             stored as the work's Source. -->
        <label>
          {{ t('entry.sourceUrl') }}
          <input
            v-model="linkUrl"
            data-testid="entry-source-url"
            name="sourceUrl"
            autocomplete="off"
            :placeholder="t('entry.placeholderUrl')"
          >
        </label>
        <div class="link-row">
          <button
            type="button"
            class="secondary-button"
            data-testid="entry-try-link"
            :disabled="submitting || linkState === 'working' || offline || linkUrl.trim() === ''"
            @click="tryLink"
          >{{ t('entry.tryLink') }}</button>
          <span class="muted link-status" data-testid="entry-link-status">{{ linkStatus }}</span>
        </div>
        <p v-if="linkMessage" class="link-message" data-testid="entry-link-message">
          <span>{{ linkMessage }}</span>
          <button
            v-if="linkSuggestsAdvanced"
            type="button"
            class="link-inline"
            data-testid="entry-open-advanced"
            @click="activeTab = 'advanced'"
          >{{ t('entry.openAdvanced') }}</button>
          <button
            v-if="linkLogPath"
            type="button"
            class="link-inline"
            data-testid="entry-copy-diagnostics"
            @click="copyDiagnostics"
          >{{ t('entry.copyDiagnostics') }}</button>
        </p>
        <label>{{ t('entry.title') }}<input v-model="title" name="title" required autocomplete="off"></label>
        <label>
          {{ t('entry.type') }}
          <div ref="typeCombobox" class="type-combobox">
            <!-- No `list=` here on purpose: the browser draws its own dropdown indicator for a
                 datalist, and with the button below that was two arrows. The list still exists for
                 the batch field, and this field is offered by our own button. -->
            <input
              v-model="type"
              name="type"
              required
              autocomplete="off"
              role="combobox"
              aria-controls="add-entry-gallery-list"
              :aria-expanded="typeListOpen"
              @click="typeListOpen = true"
              @keydown.esc="typeListOpen = false"
            >
            <!-- A native datalist only opens on the second click and shows nothing at all in some
                 browsers, which reads as a broken field. This is the same list, opened on purpose. -->
            <button
              type="button"
              class="type-combobox-toggle"
              data-testid="type-gallery-toggle"
              :aria-label="t('entry.chooseGallery')"
              :aria-expanded="typeListOpen"
              @click="typeListOpen = !typeListOpen"
            >▾</button>
            <ul
              v-if="typeListOpen"
              id="add-entry-gallery-list"
              class="type-combobox-list"
              data-testid="type-gallery-list"
              role="listbox"
              :aria-label="t('entry.chooseGallery')"
            >
              <li v-for="gallery in selectableGalleries" :key="gallery.type">
                <button
                  type="button"
                  role="option"
                  :class="{ selected: gallery.type === type.trim() }"
                  :aria-selected="gallery.type === type.trim()"
                  :data-gallery-option="gallery.type"
                  @click="chooseGallery(gallery.type)"
                >
                  <span>{{ gallery.type }}</span>
                  <!-- The same mark the sidebar puts beside a Gallery: this one is NSFW. -->
                  <span v-if="gallery.nsfw" class="nsfw-mark" data-testid="gallery-nsfw-mark">🔞</span>
                </button>
              </li>
              <li v-if="selectableGalleries.length === 0" class="type-combobox-empty">
                {{ t('entry.galleryListEmpty') }}
              </li>
            </ul>
          </div>
          <small class="muted type-hint">{{ t('entry.typeChoiceHint') }}</small>
          <datalist id="add-entry-gallery-types">
            <option v-for="galleryType in galleryTypes" :key="galleryType" :value="galleryType" />
          </datalist>
        </label>
        <!-- Three short fields on one row: a page count needs four digits, a date needs ten, and a
             runtime needs the eight of `h:mm:ss`. Each is as wide as its content, not as wide as the
             row — and the View later box, which is neither of them, moved to its own line below so
             the three facts about the work keep the row. -->
        <div class="fields-inline">
          <label>
            {{ t('entry.pageCountLabel') }}
            <input v-model="pageCount" name="pageCount" type="number" min="1" step="1">
          </label>
          <label>
            {{ t('entry.uploadDateLabel') }}
            <input
              v-model="uploadDate"
              name="uploadDate"
              data-testid="manual-entry-upload-date"
              autocomplete="off"
              :placeholder="t('entry.placeholderDate')"
            >
          </label>
          <label>
            {{ t('entry.durationLabel') }}
            <input
              ref="durationInput"
              v-model="duration"
              name="duration"
              data-testid="manual-entry-duration"
              autocomplete="off"
              :placeholder="t('entry.placeholderDuration')"
              :aria-invalid="durationError !== null"
            >
          </label>
        </div>
        <p class="field-hint" data-testid="upload-date-hint">{{ t('entry.uploadDateHint') }}</p>
        <p
          v-if="durationError"
          class="field-hint field-error"
          role="alert"
          data-testid="manual-entry-duration-error"
        >{{ durationError }}</p>
        <label class="checkbox-label" data-testid="manual-entry-view-later">
          <input v-model="manualViewLater" type="checkbox">
          {{ t('entry.viewLaterCheckbox') }}
        </label>
        <div class="fields-inline">
          <label class="grow">{{ t('entry.initialContentType') }}
            <input v-model="initialContentType" data-testid="manual-initial-content-type" :required="initialContentText.trim() !== ''" :placeholder="t('entry.placeholderContentType')">
          </label>
          <label class="grow">{{ t('entry.initialContentText') }}
            <input v-model="initialContentText" data-testid="manual-initial-content-text" :required="initialContentType.trim() !== ''" :placeholder="t('entry.placeholderContentText')">
          </label>
          <label class="grow">{{ t('entry.authorLabel') }}
            <SuggestionInput
              mode="creatable-text"
              name="authorName"
              data-testid="manual-entry-author"
              :provider="suggestAuthor"
              :aria-label="t('entry.authorLabel')"
              :placeholder="t('entry.authorPlaceholder')"
              @select="(suggestion) => { authorName = suggestion.name }"
              @submit-text="(text) => { authorName = text }"
            />
          </label>
        </div>
        <div class="template-action-row">
          <button
            type="button"
            class="secondary-button"
            data-testid="create-with-template"
            :disabled="submitting || title.trim() === '' || type.trim() === ''"
            @click="submitWithTemplate"
          >
            {{ isNewGallery ? t('entry.templateNewGalleryAction') : t('entry.templateExistingAction') }}
          </button>
          <span class="muted">{{ t('entry.templateHint') }}</span>
        </div>
        <!-- The form is taller than the viewport and the submit button is its last
             element: a failure announced only at the page top reads as a click
             that did nothing. The message has to sit where the click landed. -->
        <p v-if="submitError" class="error-message" role="alert" data-testid="entry-create-error">{{ submitError }}</p>
        <button class="primary-button" type="submit" :disabled="submitting">
          {{ submitting ? t('entry.creating') : t('entry.create') }}
        </button>
      </div>
    </form>

    <!-- The advanced path: an address decides the site, the site's own rules decide what can be read,
         and a listing can be filtered before anything is downloaded — the way to secure data a
         simple fetch cannot read. -->
    <section v-else-if="activeTab === 'advanced'" data-testid="add-entry-advanced" class="add-page-section">
      <AdvancedImportPanel :api="api" @preview="useExportPreview($event, 'advanced')" @build-rule="openRuleBuilding" />
    </section>

    <!-- Rules for a site that has none yet: a guided sequence, one state at a time, that runs the
         tool's adapter builder and ends at the import review. -->
    <section v-else-if="activeTab === 'rules'" data-testid="add-entry-rules" class="add-page-section">
      <RuleBuilderPanel :api="api" :draft-url="ruleDraftUrl" @preview="useExportPreview($event, 'rules')" />
    </section>

    <!-- `files`, named: this used to be a bare `v-else`, which also swallowed the import tab — so
         the review screen carried the folder dropzone above it, the whole files page copied over. -->
    <section v-else-if="activeTab === 'files'" data-testid="add-entry-files" class="add-page-section">
    <!-- The folder and batch blocks keep their own test hook: the page around them moved, their
         behaviour did not, and a test that drives an import should not have to care which tab it
         lives on beyond opening it. -->
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
    </div>
    </section>

    <section v-if="activeTab === 'import'" data-testid="add-entry-import" class="add-page-section">
      <div v-if="!batchImportBusy && (importBusy || importPreview || importError)" data-testid="import-review" class="import-review">
      <p v-if="importBusy" class="muted">{{ t('import.preparing') }}</p>
      <!-- While there is no preview, a failure belongs here: this is the whole screen.
           Once a preview exists the report moves down beside the button — see below. -->
      <p v-if="importError && !importPreview" class="error-message" role="alert">{{ importError }}</p>
      <template v-if="importPreview">
        <header>
          <p class="eyebrow">{{ importPreview.source }}</p>
          <h3>{{ t('import.ready', { count: importPreview.entryCount }) }}</h3>
          <p class="muted">{{ t('import.summary', {
            tags: importPreview.uniqueTagCount,
            covers: importPreview.entriesMissingCover,
          }) }}</p>
        </header>
        <div v-if="importPreview.warnings.length > 0" class="import-warnings" data-testid="import-warnings">
          <p class="import-warnings-title">{{ t('import.skippedItems', { count: importPreview.warnings.length }) }}</p>
          <ul>
            <li v-for="warning in importPreview.warnings" :key="warning">{{ warning }}</li>
          </ul>
        </div>
        <label>
          <span class="import-type-label">
            {{ t('entry.type') }}
            <!-- Said where the Gallery is chosen, because this is the moment it matters: a Gallery
                 with no template cannot receive the works' Tags at all. -->
            <strong
              v-if="hasNoTemplate"
              data-testid="import-no-template-notice"
              class="no-template-notice"
            >{{ t('import.noTemplateNotice') }}</strong>
          </span>
          <!-- The quick page's own field, for the same reason: an import may be the first work of a
               new Gallery, and a `<select>` cannot say a type that is not in the list yet. -->
          <div ref="importTypeCombobox" class="type-combobox">
            <input
              v-model="importType"
              name="importType"
              required
              autocomplete="off"
              role="combobox"
              aria-controls="import-gallery-list"
              :aria-expanded="importTypeListOpen"
              data-testid="import-type-input"
              @click="importTypeListOpen = true"
              @change="loadImportLayout"
              @keydown.esc="importTypeListOpen = false"
            >
            <button
              type="button"
              class="type-combobox-toggle"
              data-testid="import-type-toggle"
              :aria-label="t('entry.chooseGallery')"
              :aria-expanded="importTypeListOpen"
              @click="importTypeListOpen = !importTypeListOpen"
            >▾</button>
            <ul
              v-if="importTypeListOpen"
              id="import-gallery-list"
              class="type-combobox-list"
              data-testid="import-type-list"
              role="listbox"
              :aria-label="t('entry.chooseGallery')"
            >
              <li v-for="gallery in selectableGalleries" :key="gallery.type">
                <button
                  type="button"
                  role="option"
                  :class="{ selected: gallery.type === importType.trim() }"
                  :aria-selected="gallery.type === importType.trim()"
                  :data-gallery-option="gallery.type"
                  @click="chooseImportGallery(gallery.type)"
                >
                  <span>{{ gallery.type }}</span>
                  <span v-if="gallery.nsfw" class="nsfw-mark">🔞</span>
                </button>
              </li>
              <li v-if="selectableGalleries.length === 0" class="type-combobox-empty">
                {{ t('entry.galleryListEmpty') }}
              </li>
            </ul>
          </div>
          <small class="muted type-hint">{{ t('entry.typeChoiceHint') }}</small>
        </label>
        <div class="import-first-row">
          <label class="checkbox-label" data-testid="import-view-later">
            <input v-model="importViewLater" type="checkbox">
            {{ t('entry.viewLaterCheckbox') }}
          </label>
          <template v-if="hasNoTemplate">
            <button
              class="secondary-button"
              type="button"
              data-testid="import-use-common-template"
              :disabled="commonTemplateBusy"
              @click="useCommonTemplate"
            >
              {{ commonTemplateBusy ? t('import.commonTemplateWorking') : t('import.useCommonTemplate') }}
            </button>
            <button
              class="secondary-button"
              type="button"
              data-testid="import-create-template"
              :disabled="importBusy"
              @click="createOwnTemplate"
            >
              {{ t('import.createOwnTemplate') }}
            </button>
            <span class="muted" data-testid="import-create-template-hint">
              {{ t('import.createOwnTemplateHint') }}
            </span>
          </template>
        </div>
        <label>
          {{ t('import.canonicalTags') }}
          <select v-model="canonicalFacetId" class="t3-library-text" required>
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
              <h5 class="t3-library-text">{{ previewEntry.title }}</h5>
            </div>
            <div v-if="previewAuthorNames.length > 0" class="preview-chip-row">
              <span class="preview-chip preview-chip-author t3-library-text" data-testid="preview-author-chip">
                {{ previewAuthorNames.join(' / ') }}
              </span>
            </div>
            <div class="preview-board">
              <section
                v-for="section in importLayout"
                :key="section.id"
                class="preview-section"
              >
                <h6 class="t3-library-text">{{ section.name }}</h6>
                <div
                  v-for="facet in section.facets"
                  :key="facet.id"
                  class="preview-facet-row"
                >
                  <div class="preview-facet-label">
                    <span v-if="facet.name" class="t3-library-text">{{ facet.name }}</span>
                  </div>
                  <div class="preview-facet-tags">
                    <span
                      v-for="tag in previewTagsByFacetId[facet.id] ?? []"
                      :key="tag"
                      class="preview-chip t3-library-text"
                    >{{ tag }}</span>
                  </div>
                </div>
              </section>
            </div>
            <div v-if="previewContentRows.length > 0" class="preview-content">
              <div v-for="row in previewContentRows" :key="row.label" class="preview-content-row">
                <span class="preview-content-label">{{ row.label }}</span>
                    <span class="t3-library-text">{{ row.values.join(' / ') }}</span>
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
          <!-- The batch's Author, beside the field mapping rather than in a row of
               its own: it is one short name, and the commit links every created
               work to it. Typing a name an Author already holds links that one. -->
          <label class="import-author-field">
            <span>{{ t('import.batchAuthor') }}</span>
            <input
              v-model="importAuthorName"
              data-testid="import-author-name"
              autocomplete="off"
              :placeholder="t('import.batchAuthorPlaceholder')"
              list="add-entry-author-names"
            >
            <datalist id="add-entry-author-names">
              <option v-for="author in authorOptions" :key="author.id" :value="author.name" />
            </datalist>
          </label>
        </div>
        <section v-if="Object.values(fieldDestinations).includes('producer')" class="producer-review">
          <label class="checkbox-label">
            <input v-model="createUnmatchedAuthors" type="checkbox">
            {{ t('import.createAuthors') }}
          </label>
          <template v-for="name in importedAuthorValues" :key="name">
            <label>
                  <span class="t3-library-text">{{ name }}</span>
              <select v-model="producerMatches[name]" :data-testid="`import-author-match-${name}`">
                <option :value="null">{{ t('import.createAuthor') }}</option>
                <option v-for="author in authorOptions" :key="author.id" :value="author.id">
                  {{ t('import.linkAuthor', { name: author.name }) }}
                </option>
              </select>
            </label>
            <div v-if="canRateAuthor(name)" class="import-author-rating">
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  :data-testid="`author-rating-toggle-${name}`"
                  :checked="authorRatingOpen[name] === true"
                  @change="toggleAuthorRating(name, $event)"
                >
                {{ t('import.authorRating') }}
              </label>
              <div
                v-if="authorRatingOpen[name] === true"
                class="rating-select-list"
                :data-testid="`author-ratings-${name}`"
              >
                <label v-for="slot in authorRatingSlots" :key="slot.id" class="rating-select-row">
                  <span class="t3-library-text">{{ slot.name }}</span>
                  <select
                    :value="authorRatingValue(name, slot.name)"
                    :data-testid="`author-rating-${name}-${slot.name}`"
                    @change="setAuthorRatingValue(name, slot.name, $event)"
                  >
                    <option value="">{{ t('rating.unrated') }}</option>
                    <option v-for="value in ratingStarValues" :key="value" :value="value">
                      {{ t('rating.starsOption', { stars: value }) }}
                    </option>
                  </select>
                </label>
                <span class="muted">{{ t('import.authorRatingHint') }}</span>
              </div>
            </div>
          </template>
        </section>
        <p v-if="facets.length === 0" class="error-message">
          {{ t('import.layoutRequired') }}
        </p>
        <!-- A failed commit is reported here, not at the top of the review. Measured on a phone:
             the review is about 2600px tall and the button is the last thing on it, so an error
             rendered in the header sat hundreds of pixels above the finger — the import looked like
             it did nothing at all. `role="alert"` alone is not enough; the message has to be where
             the person is looking. -->
        <p
          v-if="importError && importPreview"
          class="error-message"
          role="alert"
          data-testid="import-commit-error"
        >{{ importError }}</p>
        <button
          v-if="!batchImportOpen"
          class="primary-button"
          type="button"
          :disabled="importBusy || canonicalFacetId === null"
          @click="commitFolderImport"
        >
          <!-- A disabled button that still reads "Import 2 Entries" is a button that does nothing when
               tapped, which is what a person reports as "the import does not react". While the review
               is still being prepared it says so instead. -->
          {{ importBusy
            ? t('import.preparing')
            : t('import.commit', { count: importPreview.entryCount }) }}
        </button>
        <p v-else class="muted" data-testid="batch-review-hint">
          {{ t('import.batchReviewHint') }}
        </p>
        <p v-if="importResult" class="success-message">{{ importResult }}</p>
      </template>
      </div>
    </section>
      </div>
    </div>
  </section>
</template>

<style scoped>
.add-page { display: grid; gap: 1.5rem; }
.add-page-toolbar { display: flex; align-items: center; gap: 1rem; }
.add-page-toolbar h2 { margin: 0; }
.entry-composer { display: grid; grid-template-columns: minmax(240px, .8fr) minmax(280px, 1fr); gap: 1.5rem; padding: 1.25rem; border: 1px solid var(--border-subtle); border-radius: 20px; background: var(--surface); }
.media-composer { display: flex; flex-direction: column; gap: .85rem; min-height: 310px; }
/* The media column is a vertical split: the cover's own display on top, the add box under it. */
.media-cover-slot { display: grid; place-items: center; flex: 1 1 auto; min-height: 190px; padding: .75rem; border: 1px solid var(--border-subtle); border-radius: 16px; background: var(--surface-muted); }
.cover-single { max-width: 100%; max-height: 100%; border-radius: 10px; object-fit: contain; }
/* The entry's own stack, on the card's geometry (`entryStackLayerStyle`) and its three rules —
   mirrored rather than extracted, so a change about this form never touches the work card that the
   mobile build also renders. If the card's look changes, this must change with it. */
.entry-stack { position: relative; width: 100%; aspect-ratio: 4 / 3; overflow: hidden; isolation: isolate; perspective: 28rem; perspective-origin: 50% 50%; transform-style: preserve-3d; }
.entry-stack-image { position: absolute; display: block; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--border-subtle) 75%, transparent); border-radius: .15rem; box-shadow: .18rem .18rem .45rem rgb(15 23 42 / 16%); transform-style: preserve-3d; }
.entry-stack-image:first-child { box-shadow: .28rem .28rem .7rem rgb(15 23 42 / 22%); }
.media-limit { margin: 0; padding: .6rem .8rem; border: 1px dashed var(--border-subtle); border-radius: 14px; color: var(--text-muted); font-size: .82rem; text-align: center; }
.media-notice { margin: .25rem 0 0; padding: .5rem .7rem; border-radius: 10px; background: var(--surface-muted); color: var(--text-muted); font-size: .82rem; }
.link-row { display: flex; align-items: center; gap: .6rem; }
.link-status { font-size: .82rem; }
.link-message { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin: 0; font-size: .85rem; color: var(--text-muted); }
.link-inline { padding: 0; border: 0; background: none; color: var(--accent); font: inherit; text-decoration: underline; cursor: pointer; }
/* A row of short fields, each as wide as what goes in it. Flex rather than a grid: the date field's
   hint belongs under the whole row, and a grid stretched the page count across the page. */
/* Bottom-aligned: a label whose text wraps to two lines (a narrow window, e.g. "Duration
   (optional)") then drops its box below the others', and the row stops reading as one row of
   fields. Aligning the bottoms keeps every box on the same line whatever the text does. */
.fields-inline { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.9rem 1.25rem; }
/* Desktop: the short fields share their row instead of stacking half-empty
   boxes; on a phone the row wraps and each field keeps a usable width. */
@media (max-width: 43.999rem) {
  /* A phone stacks these rows; every field takes the full width instead of
     shrinking to its content (the suggestion component's default width is
     small, which read as "the Author box is tiny"). */
  .fields-inline label { flex: 1 1 100%; min-width: 0; }
  .fields-inline input:not([type='checkbox']) { width: 100%; }
}
@media (min-width: 44rem) {
  .fields-inline { flex-wrap: nowrap; }
  .fields-inline label { flex: 1 1 0; min-width: 0; }
  .fields-inline input:not([type='checkbox']) { width: 100%; }
}
.fields-inline input[name='pageCount'] { width: 6rem; }
.fields-inline [data-testid='manual-entry-upload-date'] { width: 11rem; }
/* `h:mm:ss` is eight characters; the box holds them without the row stretching. */
.fields-inline input[name='duration'] { width: 7rem; }
.field-error { color: var(--danger, #b3261e); }
.field-hint { margin: 0; color: var(--text-muted); font-size: 0.82rem; }
.type-hint { color: var(--text-muted); }
/* One line: the view-later box, then the two doors out of "this Gallery has no template". */
.import-first-row { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; }
/* Said where the Gallery is chosen: prominent, because ignoring it loses data. */
.import-type-label { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: .5rem; }
.no-template-notice { color: var(--text-warning, #c9822a); font-weight: 700; }
.type-combobox { position: relative; display: flex; align-items: center; gap: 0.35rem; }
.type-combobox input { flex: 1 1 auto; min-width: 0; }
.type-combobox-toggle { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; min-height: var(--control-min-height); padding: 0.45rem 0.6rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); color: var(--text-muted); background: var(--surface-muted); font: inherit; cursor: pointer; }
.type-combobox-toggle:hover { border-color: var(--accent); color: var(--accent); }
.type-combobox-list { position: absolute; z-index: 20; top: calc(100% + 0.25rem); left: 0; right: 0; max-height: 14rem; overflow-y: auto; margin: 0; padding: 0.25rem; list-style: none; border: 1px solid var(--border-subtle); border-radius: 0.6rem; background: var(--surface); box-shadow: 0 0.6rem 1.6rem rgb(15 23 42 / 18%); }
.type-combobox-list button { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; width: 100%; padding: 0.4rem 0.55rem; border: 0; border-radius: 0.45rem; color: var(--text-primary); background: transparent; font: inherit; font-size: 0.85rem; text-align: left; cursor: pointer; }
.type-combobox-list button:hover, .type-combobox-list button:focus-visible { background: var(--surface-muted); outline: none; }
.type-combobox-list button.selected { color: var(--accent); }
.type-combobox-empty { padding: 0.45rem 0.55rem; color: var(--text-muted); font-size: 0.82rem; }
.add-page-section { display: grid; gap: 1rem; }
.media-dropzone, .folder-dropzone { position: relative; overflow: hidden; display: grid; place-items: center; align-content: center; gap: .45rem; border: 1px dashed var(--border-subtle); border-radius: 16px; color: var(--text-muted); cursor: pointer; background: var(--surface-muted); }
.media-dropzone { flex: 1; min-height: 310px; }
.preview-dropzone { flex: .65; }
.media-dropzone img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.media-dropzone strong { z-index: 1; }
.dropzone-plus { font-size: 2.6rem; line-height: 1; font-weight: 300; }
.media-dropzone input, .folder-dropzone input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.entry-fields { display: grid; align-content: start; gap: 1rem; }
.entry-fields label { display: grid; gap: .4rem; }
/* The same control as every other field in the app (`.secondary-button`, the inline editors): a
   bordered rounded rectangle on the surface. These fields were plain browser boxes. */
/* The suggestion dropdown is an inline-flex component with its own compact
   input; inside this form it wears the same box as every other field. */
.entry-fields :deep(.suggestion-input),
.entry-fields :deep(.suggestion-input input) { width: 100%; box-sizing: border-box; }
.entry-fields :deep(.suggestion-input input) {
  min-height: var(--control-min-height);
  padding: 0.45rem 0.7rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  color: var(--text-primary);
  background: var(--surface);
  font: inherit;
}
.entry-fields input:not([type='checkbox']),
.entry-fields select,
.entry-fields textarea {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: var(--control-min-height);
  padding: 0.45rem 0.7rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  color: var(--text-primary);
  background: var(--surface);
  font: inherit;
}
.entry-fields input:not([type='checkbox']):focus,
.entry-fields select:focus,
.entry-fields textarea:focus {
  border-color: var(--accent);
  outline: 2px solid color-mix(in srgb, var(--accent) 18%, transparent);
}
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
.template-action-row { display: grid; gap: .35rem; justify-items: start; }
.template-action-row .secondary-button { max-width: 100%; text-align: left; }
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
.import-author-rating { display: grid; gap: .4rem; }
.import-author-rating > .checkbox-label { min-height: 0; }
.producer-review label.rating-select-row { grid-template-columns: minmax(8rem, 1fr) minmax(8rem, 1fr); }
.checkbox-label { grid-template-columns: auto 1fr; justify-content: start; }
.rating-select-list { display: grid; gap: .45rem; padding: .8rem; border-radius: 12px; background: var(--surface-muted); }
.rating-select-title { font-size: .8rem; color: var(--text-muted); }
.rating-select-row { display: grid; grid-template-columns: minmax(8rem, 1fr) minmax(8rem, 1fr); align-items: center; gap: .6rem; }
.success-message { color: var(--accent); }
.import-warnings { display: grid; gap: .35rem; padding: .7rem .85rem; border-radius: 12px; background: var(--surface-muted); font-size: .8rem; }
.import-warnings-title { margin: 0; color: var(--text-muted); }
.import-warnings ul { margin: 0; padding-left: 1.1rem; }
/* The single-column form, and why the breakpoint is this wide.
 *
 * The two-column form needs 584px (a 240px media column, a 280px fields column, their gap and the
 * card's padding), and the shell keeps its 288px sidebar until 44rem — so a two-column form needs a
 * **936px** viewport before it has room. Measured on a real window: at 768, 844 and 920 the page laid
 * out 936px wide in the viewport and the document scrolled sideways (34 elements past the edge, the
 * field inputs at 852). This page's own breakpoint used to be 760px, which is the width *the form*
 * wants in a world without the sidebar — hence the 761-936px window where the page was neither.
 * Phones are unaffected: measured at 320, 360, 390 and 430 with no overflow either way. */
@media (max-width: 60rem) {
  .add-page-toolbar { align-items: flex-start; flex-wrap: wrap; }
  .add-page-toolbar h2 { flex-basis: 100%; }
  .entry-composer { grid-template-columns: 1fr; padding: 0.8rem; gap: 1rem; min-width: 0; }
  .media-composer { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); min-height: 0; }
  .media-dropzone { min-height: 13rem; }
  .cover-dropzone:only-child { grid-column: 1 / -1; }
  .entry-fields input:not([type='checkbox']),
  .entry-fields select,
  .entry-fields textarea { box-sizing: border-box; width: 100%; min-width: 0; min-height: 44px; }
  /* The suggestion input lives inside another component, so the field rule
     above cannot reach it; the phone height has to be repeated here. */
  .entry-fields :deep(.suggestion-input input) { min-height: 44px; }
  .entry-fields .primary-button { width: 100%; min-height: 44px; }
  .checkbox-label { min-height: 44px; align-items: center; }
  .type-combobox-list button { min-height: 44px; }
  .desktop-entry-import { display: none; }

  /* The review screen. It had no rules of its own here, and its rows are grids with hard minimums —
     `minmax(120px, .5fr) minmax(220px, 1fr)` is 340px before any gap — so on a phone the whole card
     laid out wider than the screen and the shell clipped it: measured at a 390px viewport, the review
     was 420px wide with 69 elements past the right edge, and the commit button's right end was cut
     off. The same two moves as everywhere else: let the boxes be narrower than their content, and
     stack a two-column row instead of keeping it side by side. */
  .import-review { padding: 0.9rem; min-width: 0; }
  .import-review > * { min-width: 0; }
  .import-review select,
  .import-review input:not([type='checkbox']) {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    min-height: 44px;
  }
  .mapping-list, .producer-review { padding: 0.8rem; min-width: 0; }
  .mapping-list label,
  .producer-review label:not(.checkbox-label),
  .rating-select-row,
  .producer-review label.rating-select-row { grid-template-columns: minmax(0, 1fr); }
  .import-review > button.primary-button { width: 100%; min-height: 44px; }

  /* The facet row is a two-column grid whose label column takes its *maximum* (9.5rem) and leaves the
     tags whatever is left over: measured at a 390px viewport, 152px for the label and **54px** for the
     tags — narrower than one chip, so every tag sat on a line of its own instead of wrapping across.
     Stacked, the tags get the whole width back. */
  .preview-facet-row, .preview-content-row { grid-template-columns: minmax(0, 1fr); }
  .preview-facet-label { padding: 0.3rem 0 0.1rem; border-right: 0; }
  .preview-facet-tags { padding-left: 0; }
  /* And the preview is nested four deep, so it was spending 145px of the 351px available on padding
     before a single tag was drawn. Trimmed here, not removed: the nesting is what says which box is
     which. */
  .template-preview, .preview-card { padding: 0.7rem; }
}
</style>
