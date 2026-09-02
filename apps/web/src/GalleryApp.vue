<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { GalleryApi, GalleryEntrySummary } from './api/gallery.js';
import type {
  AuthorDetailResponse,
  CreateProducerRequest,
  EntryDetailResponse,
  FacetFilterOptions,
  GallerySummary,
} from '@t3/shared';
import AddAuthorPage from './AddAuthorPage.vue';
import AddEntryPage, { type ManualEntryDraft } from './AddEntryPage.vue';
import AdvancedEditingPage from './AdvancedEditingPage.vue';
import AuthorPage from './AuthorPage.vue';
import FacetFilterBar, { type GalleryFacetFilters } from './components/FacetFilterBar.vue';
import { supportedLocales, useI18n, type Locale } from './i18n.js';

type Theme = 'light' | 'dark';
interface AuthorLocation {
  authorId: number;
  authorName: string;
  directoryId: number | null;
  directoryName: string | null;
}
interface EntryTagResults {
  kind: 'entry';
  tagId: number;
  tagName: string;
  entries: GalleryEntrySummary[];
  sourceEntry: { id: number; type: string; title: string };
}
interface AuthorTagResults {
  kind: 'author';
  tagId: number;
  tagName: string;
  authors: Array<{ id: number; name: string }>;
  sourceAuthor: AuthorLocation;
}
type TagResults = EntryTagResults | AuthorTagResults;
type EntryOrigin = AuthorLocation | { tagResults: EntryTagResults };
type CreationView = 'entry' | 'author';
const props = defineProps<{ api: GalleryApi }>();
const galleries = ref<GallerySummary[]>([]);
const authors = ref<Array<{
  id: number;
  name: string;
  covers: string[];
  galleryType: string | null;
}>>([]);
const entries = ref<GalleryEntrySummary[]>([]);
// Facet filter state: options are aggregated per gallery type on the server;
// the active filters live here so switching galleries can reset them and bar
// updates reload the visible entries. Tag rows AND inside and across rows;
// the Author list ORs inside itself and ANDs with the tag rows.
const facetFilterOptions = ref<FacetFilterOptions | null>(null);
const facetFilters = ref<GalleryFacetFilters>({ conditions: [], authorIds: [] });
let galleryEntriesRequestSeq = 0;
type GallerySort = 'date-desc' | 'date-asc' | 'title-asc' | 'title-desc';
// Newest first by default: recent imports land at the top of the gallery.
const gallerySort = ref<GallerySort>('date-desc');
const sortedEntries = computed(() => {
  const list = [...entries.value];
  const direction = gallerySort.value.endsWith('-desc') ? -1 : 1;
  const byTitle = (a: GalleryEntrySummary, b: GalleryEntrySummary): number => (
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
  );
  if (gallerySort.value.startsWith('title')) {
    return list.sort((a, b) => direction * byTitle(a, b));
  }
  return list.sort((a, b) => {
    const dateCompare = String(a.uploadDate ?? '').localeCompare(String(b.uploadDate ?? ''));
    const tie = a.id - b.id;
    return direction * (dateCompare !== 0 ? dateCompare : tie);
  });
});
const activeEntry = ref<EntryDetailResponse | null>(null);
const activeType = ref<string | null>(null);
const editingEntry = ref(false);
const creationView = ref<CreationView | null>(null);
const sectionName = ref('');
const facetName = ref('');
const tagName = ref('');
const draggedTagId = ref<number | null>(null);
const sectionEditorOpen = ref(false);
const facetEditorSectionId = ref<number | null>(null);
const tagEditorFacetId = ref<number | null>(null);
const editingTagId = ref<number | null>(null);
const editingTagName = ref('');
const contentEditorOpen = ref(false);
const contentType = ref('');
const contentBody = ref('');
const editingContentId = ref<number | null>(null);
const editingContentType = ref('');
const editingContentBody = ref('');
const loading = ref(true);
const submitting = ref(false);
const error = ref<string | null>(null);
const theme = ref<Theme>('light');
const settingsOpen = ref(false);
const advancedView = ref(false);
const authorView = ref(false);
const authorEditorOpen = ref(false);
const newAuthorName = ref('');
const authorLinkEditorOpen = ref(false);
const authorSearchQuery = ref('');
const authorTarget = ref<AuthorLocation | null>(null);
const entryOrigin = ref<EntryOrigin | null>(null);
const tagResults = ref<TagResults | null>(null);
const authorTagOrigin = ref<AuthorTagResults | null>(null);
const nextTheme = computed<Theme>(() => (theme.value === 'light' ? 'dark' : 'light'));
const entryBackTarget = computed(() => {
  if (!entryOrigin.value) return activeType.value ?? '';
  if ('tagResults' in entryOrigin.value) return entryOrigin.value.tagResults.tagName;
  return entryOrigin.value.directoryName ?? entryOrigin.value.authorName;
});
const availableAuthors = computed(() => {
  const linkedIds = new Set(activeEntry.value?.producers.map((author) => author.id) ?? []);
  return authors.value.filter((author) => !linkedIds.has(author.id));
});
const filteredAvailableAuthors = computed(() => {
  const query = authorSearchQuery.value.trim().toLocaleLowerCase();
  return availableAuthors.value.filter((author) => (
    query === '' || author.name.toLocaleLowerCase().includes(query)
  ));
});
const { locale, setLocale, t } = useI18n();

function selectLocale(event: Event): void {
  const nextLocale = (event.target as HTMLSelectElement).value as Locale;
  if (supportedLocales.includes(nextLocale)) setLocale(nextLocale);
}

function toggleSettings(): void {
  settingsOpen.value = !settingsOpen.value;
}

function openAdvanced(): void {
  settingsOpen.value = false;
  creationView.value = null;
  tagResults.value = null;
  authorTagOrigin.value = null;
  entryOrigin.value = null;
  authorView.value = false;
  advancedView.value = true;
  activeEntry.value = null;
  editingEntry.value = false;
}

function closeAdvanced(): void {
  advancedView.value = false;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//u.test(value);
}

const mediaIndex = ref(0);
const mediaSlides = computed(() => {
  if (!activeEntry.value) return [] as string[];
  const slides: string[] = [];
  if (activeEntry.value.coverRef) slides.push(activeEntry.value.coverRef);
  slides.push(...(activeEntry.value.previewRefs ?? []));
  return [...new Set(slides)];
});
function mediaPrevious(): void {
  if (mediaIndex.value > 0) mediaIndex.value -= 1;
}
function mediaNext(): void {
  if (mediaIndex.value < mediaSlides.value.length - 1) mediaIndex.value += 1;
}
function stackLayers(entry: { coverRef: string | null; previewRefs: string[] }): string[] {
  const layers: string[] = [];
  if (entry.coverRef) layers.push(entry.coverRef);
  layers.push(...(entry.previewRefs ?? []));
  return layers;
}
function stackStyle(index: number, count: number): Record<string, string> {
  const previewCount = Math.max(0, count - 1);
  const step = previewCount > 0 ? Math.min(12, 34 / previewCount) : 0;
  const left = 28 - (index * step);
  const top = 3 + Math.min(index * 0.7, 3);
  const rotation = -Math.min(index * 2.2, 8);
  return {
    left: `${left}%`,
    top: `${top}%`,
    transform: `rotate(${rotation}deg)`,
    zIndex: String(count + 1 - index),
  };
}
function isBasicSection(section: { name: string }): boolean {
  const name = section.name.trim();
  return /^basic\s*information$/i.test(name) || /^basic$/i.test(name);
}

async function deleteActiveEntry(): Promise<void> {
  if (!activeEntry.value) return;
  if (!window.confirm(t('entry.deleteConfirm', { title: activeEntry.value.title }))) return;
  error.value = null;
  try {
    await props.api.deleteEntry(activeEntry.value.id);
    await refreshGalleries();
    if (activeType.value) {
      await selectGallery(activeType.value);
    } else {
      await closeEntry();
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.deleteEntry');
  }
}
watch(activeEntry, () => {
  mediaIndex.value = 0;
});

// Layout template: rebuild this type's shared Section/Facet structure from
// the open Entry and re-map every Entry's tags onto it (see
// applyLayoutTemplate on the server). `showEmptyFacets` reveals empty named
// Facets so the rebuilt structure is visible even before tags are added.
const showEmptyFacets = ref(false);
const templateBusy = ref(false);
const templateNotice = ref<string | null>(null);
const tagLayoutBusy = ref(false);
const tagLayoutNotice = ref<string | null>(null);

async function saveLayoutTemplate(): Promise<void> {
  if (!activeEntry.value) return;
  const type = activeEntry.value.type;
  if (!window.confirm(t('template.applyConfirm', { type }))) return;
  templateBusy.value = true;
  templateNotice.value = null;
  error.value = null;
  try {
    const result = await props.api.applyEntryLayoutTemplate(activeEntry.value.id);
    // Facet ids all changed: reload the detail so tag rows point at the
    // rebuilt Facets and empty ones become visible via the toggle.
    activeEntry.value = await props.api.getEntry(activeEntry.value.id);
    templateNotice.value = t('template.applied', {
      type,
      entries: result.entriesAffected,
      relinked: result.tagsRelinked,
    });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('template.applyError');
  } finally {
    templateBusy.value = false;
  }
}

// Tag layout sync: the open Entry's tag→Facet placement becomes the standard
// for every other Entry of the same type. Unlike Save as template this does
// NOT touch the shared Section/Facet structure — it only moves misplaced tag
// assignments in peer Entries (see applyEntryTagLayout on the server).
async function applyActiveEntryTagLayout(): Promise<void> {
  if (!activeEntry.value) return;
  const type = activeEntry.value.type;
  if (!window.confirm(t('tagLayout.applyConfirm', { type }))) return;
  tagLayoutBusy.value = true;
  tagLayoutNotice.value = null;
  error.value = null;
  try {
    const result = await props.api.applyEntryTagLayout(activeEntry.value.id);
    tagLayoutNotice.value = t('tagLayout.applied', {
      type,
      entries: result.entriesAffected,
      tags: result.tagsMoved,
    });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('tagLayout.applyError');
  } finally {
    tagLayoutBusy.value = false;
  }
}

function inlineInputSize(value: string): number {
  return Math.max(5, value.length);
}

async function refreshGalleries(): Promise<void> {
  galleries.value = await props.api.listGalleries();
}

async function refreshAuthors(): Promise<void> {
  authors.value = await props.api.listAuthors();
}

async function selectGallery(entryType: string): Promise<void> {
  creationView.value = null;
  tagResults.value = null;
  authorTagOrigin.value = null;
  authorView.value = false;
  advancedView.value = false;
  activeType.value = entryType;
  activeEntry.value = null;
  editingEntry.value = false;
  resetLayoutEditors();
  facetFilters.value = { conditions: [], authorIds: [] };
  const [summaries, filterOptions] = await Promise.all([
    props.api.listEntries(entryType),
    props.api.listFacetFilterOptions(entryType),
  ]);
  entries.value = summaries;
  facetFilterOptions.value = filterOptions;
}

async function loadGalleryEntries(): Promise<void> {
  if (!activeType.value) return;
  const seq = ++galleryEntriesRequestSeq;
  const { conditions, authorIds } = facetFilters.value;
  const activeConditions = conditions.filter((condition) => condition.tagIds.length > 0);
  const hasFilters = activeConditions.length > 0 || authorIds.length > 0;
  const summaries = !hasFilters
    ? await props.api.listEntries(activeType.value)
    : await props.api.filterEntriesByFacets(activeType.value, activeConditions, authorIds);
  if (seq !== galleryEntriesRequestSeq) return; // superseded by a newer request
  entries.value = summaries;
}

async function onFacetFiltersChange(filters: GalleryFacetFilters): Promise<void> {
  facetFilters.value = filters;
  try {
    await loadGalleryEntries();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('gallery.filterError');
  }
}

function showAuthors(): void {
  creationView.value = null;
  tagResults.value = null;
  authorTagOrigin.value = null;
  authorTarget.value = null;
  entryOrigin.value = null;
  authorView.value = true;
  advancedView.value = false;
  activeType.value = null;
  activeEntry.value = null;
  editingEntry.value = false;
  resetLayoutEditors();
}

async function openEntryFromAuthor(payload: {
  work: AuthorDetailResponse['looseEntries'][number];
  authorId: number;
  authorName: string;
  directoryId: number | null;
  directoryName: string | null;
}): Promise<void> {
  await selectGallery(payload.work.type);
  await viewEntry(payload.work.id, {
    authorId: payload.authorId,
    authorName: payload.authorName,
    directoryId: payload.directoryId,
    directoryName: payload.directoryName,
  });
}

async function openEntry(entryId: number): Promise<void> {
  error.value = null;
  try {
    activeEntry.value = await props.api.getEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadEntry');
  }
}

async function viewEntry(entryId: number, origin: EntryOrigin | null = null): Promise<void> {
  entryOrigin.value = origin;
  editingEntry.value = false;
  resetLayoutEditors();
  await openEntry(entryId);
}

function startEditing(): void {
  editingEntry.value = true;
  resetLayoutEditors();
}

function closeEntry(): void {
  if (entryOrigin.value) {
    if ('tagResults' in entryOrigin.value) {
      tagResults.value = entryOrigin.value.tagResults;
      entryOrigin.value = null;
      activeEntry.value = null;
      activeType.value = null;
      editingEntry.value = false;
      resetLayoutEditors();
      return;
    }
    authorTarget.value = entryOrigin.value;
    entryOrigin.value = null;
    activeEntry.value = null;
    activeType.value = null;
    authorView.value = true;
    editingEntry.value = false;
    resetLayoutEditors();
    return;
  }
  activeEntry.value = null;
  editingEntry.value = false;
  resetLayoutEditors();
}

async function openEntryTag(tag: { id: number; name: string }): Promise<void> {
  if (editingEntry.value || !activeEntry.value) return;
  const sourceEntry = {
    id: activeEntry.value.id,
    type: activeEntry.value.type,
    title: activeEntry.value.title,
  };
  error.value = null;
  try {
    tagResults.value = {
      kind: 'entry',
      tagId: tag.id,
      tagName: tag.name,
      entries: await props.api.findEntriesByTag(tag.id),
      sourceEntry,
    };
    activeEntry.value = null;
    activeType.value = null;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadEntries');
  }
}

async function openAuthorTag(payload: {
  tagId: number;
  tagName: string;
  authorId: number;
  authorName: string;
}): Promise<void> {
  error.value = null;
  try {
    tagResults.value = {
      kind: 'author',
      tagId: payload.tagId,
      tagName: payload.tagName,
      authors: await props.api.findAuthorsByTag(payload.tagId),
      sourceAuthor: {
        authorId: payload.authorId,
        authorName: payload.authorName,
        directoryId: null,
        directoryName: null,
      },
    };
    authorView.value = false;
    authorTarget.value = null;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadAuthors');
  }
}

async function openTagEntry(entry: GalleryEntrySummary): Promise<void> {
  if (tagResults.value?.kind !== 'entry') return;
  const origin = tagResults.value;
  tagResults.value = null;
  activeType.value = entry.type;
  await viewEntry(entry.id, { tagResults: origin });
}

function openTagAuthor(author: { id: number; name: string }): void {
  if (tagResults.value?.kind !== 'author') return;
  authorTagOrigin.value = tagResults.value;
  tagResults.value = null;
  authorTarget.value = {
    authorId: author.id,
    authorName: author.name,
    directoryId: null,
    directoryName: null,
  };
  authorView.value = true;
}

function restoreAuthorTagResults(): void {
  if (!authorTagOrigin.value) return;
  tagResults.value = authorTagOrigin.value;
  authorTagOrigin.value = null;
  authorView.value = false;
  authorTarget.value = null;
}

async function closeTagResults(): Promise<void> {
  const current = tagResults.value;
  if (!current) return;
  tagResults.value = null;
  if (current.kind === 'entry') {
    activeType.value = current.sourceEntry.type;
    await viewEntry(current.sourceEntry.id);
    return;
  }
  authorTarget.value = current.sourceAuthor;
  authorView.value = true;
}

function openAuthorFromEntry(authorId: number): void {
  const author = activeEntry.value?.producers.find((producer) => producer.id === authorId);
  if (!author) return;
  authorTarget.value = {
    authorId,
    authorName: author.name,
    directoryId: null,
    directoryName: null,
  };
  entryOrigin.value = null;
  activeEntry.value = null;
  activeType.value = null;
  authorView.value = true;
  editingEntry.value = false;
  resetLayoutEditors();
}

function finishEditing(): void {
  editingEntry.value = false;
  resetLayoutEditors();
}

function resetLayoutEditors(): void {
  sectionEditorOpen.value = false;
  facetEditorSectionId.value = null;
  tagEditorFacetId.value = null;
  editingTagId.value = null;
  contentEditorOpen.value = false;
  editingContentId.value = null;
  draggedTagId.value = null;
  sectionName.value = '';
  facetName.value = '';
  tagName.value = '';
  editingTagName.value = '';
  contentType.value = '';
  contentBody.value = '';
  editingContentType.value = '';
  editingContentBody.value = '';
  authorEditorOpen.value = false;
  authorLinkEditorOpen.value = false;
  newAuthorName.value = '';
  authorSearchQuery.value = '';
}

async function createAndLinkAuthor(): Promise<void> {
  if (!activeEntry.value || !newAuthorName.value.trim()) return;
  const entryId = activeEntry.value.id;
  error.value = null;
  try {
    const author = await props.api.createAuthor({ name: newAuthorName.value });
    await props.api.linkEntryAuthor(entryId, author.id);
    authorEditorOpen.value = false;
    newAuthorName.value = '';
    await Promise.all([refreshAuthors(), openEntry(entryId)]);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createAuthor');
  }
}

async function linkExistingAuthor(authorId?: number): Promise<void> {
  const matchedAuthor = authorId === undefined
    ? filteredAvailableAuthors.value[0]
    : availableAuthors.value.find((author) => author.id === authorId);
  if (!activeEntry.value || !matchedAuthor) return;
  const entryId = activeEntry.value.id;
  error.value = null;
  try {
    await props.api.linkEntryAuthor(entryId, matchedAuthor.id);
    authorSearchQuery.value = '';
    authorLinkEditorOpen.value = false;
    await openEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.linkAuthor');
  }
}

async function unlinkAuthor(authorId: number): Promise<void> {
  if (!activeEntry.value) return;
  const entryId = activeEntry.value.id;
  error.value = null;
  try {
    await props.api.unlinkEntryAuthor(entryId, authorId);
    await openEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.unlinkAuthor');
  }
}

async function createContent(): Promise<void> {
  if (!activeEntry.value) return;
  const entryId = activeEntry.value.id;
  const nextSortOrder = activeEntry.value.contents.reduce(
    (highest, item) => Math.max(highest, item.sortOrder),
    -1,
  ) + 1;
  error.value = null;
  try {
    await props.api.createEntryContent(entryId, {
      contentType: contentType.value,
      content: contentBody.value,
      sortOrder: nextSortOrder,
    });
    contentType.value = '';
    contentBody.value = '';
    contentEditorOpen.value = false;
    await openEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.addContent');
  }
}

function beginContentEdit(content: EntryDetailResponse['contents'][number]): void {
  editingContentId.value = content.id;
  editingContentType.value = content.contentType;
  editingContentBody.value = content.content;
}

function cancelContentEdit(): void {
  editingContentId.value = null;
  editingContentType.value = '';
  editingContentBody.value = '';
}

async function saveContentEdit(contentId: number): Promise<void> {
  if (!activeEntry.value) return;
  const entryId = activeEntry.value.id;
  error.value = null;
  try {
    await props.api.updateEntryContent(contentId, {
      contentType: editingContentType.value,
      content: editingContentBody.value,
    });
    cancelContentEdit();
    await openEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.updateContent');
  }
}

async function deleteContent(contentId: number): Promise<void> {
  if (!activeEntry.value) return;
  const entryId = activeEntry.value.id;
  error.value = null;
  try {
    await props.api.deleteEntryContent(contentId);
    if (editingContentId.value === contentId) cancelContentEdit();
    await openEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.deleteContent');
  }
}

async function moveContent(contentId: number, offset: -1 | 1): Promise<void> {
  if (!activeEntry.value) return;
  const entryId = activeEntry.value.id;
  const orderedContentIds = activeEntry.value.contents.map((content) => content.id);
  const sourceIndex = orderedContentIds.indexOf(contentId);
  const targetIndex = sourceIndex + offset;
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= orderedContentIds.length) return;
  [orderedContentIds[sourceIndex], orderedContentIds[targetIndex]] = [
    orderedContentIds[targetIndex] as number,
    orderedContentIds[sourceIndex] as number,
  ];
  error.value = null;
  try {
    await props.api.reorderEntryContents(entryId, orderedContentIds);
    await openEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.reorderContent');
  }
}

async function createSection(): Promise<void> {
  if (!activeEntry.value) return;
  error.value = null;
  try {
    await props.api.createSection({ entryType: activeEntry.value.type, name: sectionName.value });
    sectionName.value = '';
    sectionEditorOpen.value = false;
    await openEntry(activeEntry.value.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createSection');
  }
}

async function addEntryTag(facetId: number | null): Promise<void> {
  if (!activeEntry.value || facetId === null) return;
  error.value = null;
  try {
    await props.api.assignEntryTag(activeEntry.value.id, {
      facetId,
      name: tagName.value,
    });
    tagName.value = '';
    tagEditorFacetId.value = null;
    const entryId = activeEntry.value.id;
    await openEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.addTag');
  }
}

async function createNamedFacet(sectionId: number): Promise<void> {
  if (!activeEntry.value) return;
  const newFacetName = facetName.value.trim();
  if (newFacetName === '') return;
  error.value = null;
  const section = activeEntry.value.sections.find((item) => item.id === sectionId);
  const existing = section?.facets.find((facet) => facet.name === newFacetName);
  if (existing) {
    if (existing.tags.length > 0) {
      error.value = t('error.duplicateFacet', { name: newFacetName });
      return;
    }
    tagEditorFacetId.value = existing.id;
    facetName.value = '';
    facetEditorSectionId.value = null;
    return;
  }
  try {
    await props.api.createFacet({
      sectionId,
      name: newFacetName,
    });
    await openEntry(activeEntry.value.id);
    tagEditorFacetId.value = activeEntry.value?.sections
      .find((section) => section.id === sectionId)
      ?.facets.find((facet) => facet.name === newFacetName)?.id ?? null;
    facetName.value = '';
    facetEditorSectionId.value = null;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createFacet');
  }
}

async function moveFacet(sectionId: number, facetId: number, offset: -1 | 1): Promise<void> {
  if (!activeEntry.value) return;
  const section = activeEntry.value.sections.find((item) => item.id === sectionId);
  if (!section) return;
  const orderedFacetIds = section.facets.map((facet) => facet.id);
  const sourceIndex = orderedFacetIds.indexOf(facetId);
  const targetIndex = sourceIndex + offset;
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= orderedFacetIds.length) return;
  [orderedFacetIds[sourceIndex], orderedFacetIds[targetIndex]] = [
    orderedFacetIds[targetIndex] as number,
    orderedFacetIds[sourceIndex] as number,
  ];
  error.value = null;
  try {
    await props.api.reorderSectionFacets(sectionId, orderedFacetIds);
    await openEntry(activeEntry.value.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.reorderFacet');
  }
}

async function removeFacet(facetId: number): Promise<void> {
  if (!activeEntry.value) return;
  const facet = activeEntry.value.sections
    .flatMap((section) => section.facets)
    .find((candidate) => candidate.id === facetId);
  if (!facet || facet.name === '') return;
  if (!window.confirm(t('facet.deleteConfirm', { name: facet.name }))) return;
  error.value = null;
  try {
    await props.api.deleteFacet(facetId);
    await openEntry(activeEntry.value.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.deleteFacet');
  }
}

function visibleFacets(section: EntryDetailResponse['sections'][number]) {
  if (showEmptyFacets.value) {
    // Show every named Facet (even empty ones) plus any unnamed Facet that
    // carries tags or is being edited — empty unnamed Facets stay hidden.
    return section.facets.filter((facet) => facet.name.length > 0
      || facet.tags.length > 0
      || tagEditorFacetId.value === facet.id);
  }
  return section.facets.filter((facet) => facet.tags.length > 0
    || (facet.name.length > 0 && tagEditorFacetId.value === facet.id));
}

function emptyUnnamedFacetId(section: EntryDetailResponse['sections'][number]): number | null {
  return section.facets.find((facet) => facet.name.length === 0 && facet.tags.length === 0)?.id
    ?? null;
}

function beginTagDrag(tagId: number): void {
  if (!editingEntry.value) return;
  draggedTagId.value = tagId;
}

function beginTagRename(tag: EntryDetailResponse['sections'][number]['facets'][number]['tags'][number]): void {
  if (!editingEntry.value) return;
  editingTagId.value = tag.id;
  editingTagName.value = tag.name;
}

async function saveTagRename(tagId: number): Promise<void> {
  if (!activeEntry.value || editingTagId.value !== tagId || !editingTagName.value.trim()) return;
  const entryId = activeEntry.value.id;
  error.value = null;
  try {
    await props.api.renameEntryTag(entryId, tagId, editingTagName.value);
    editingTagId.value = null;
    editingTagName.value = '';
    await openEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.renameTag');
  }
}

async function moveDraggedTag(targetFacetId: number): Promise<void> {
  if (!editingEntry.value || !activeEntry.value || draggedTagId.value === null) return;
  const entryId = activeEntry.value.id;
  const tagId = draggedTagId.value;
  draggedTagId.value = null;
  error.value = null;
  try {
    await props.api.moveEntryTag(entryId, tagId, targetFacetId);
    await openEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.moveTag');
  }
}

async function removeTag(tagId: number): Promise<void> {
  if (!activeEntry.value) return;
  const entryId = activeEntry.value.id;
  error.value = null;
  try {
    await props.api.removeEntryTag(entryId, tagId);
    await openEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.removeTag');
  }
}

async function initialize(): Promise<void> {
  try {
    await Promise.all([refreshGalleries(), refreshAuthors()]);
    const firstType = galleries.value[0]?.type;
    if (firstType) {
      await selectGallery(firstType);
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadGalleries');
  } finally {
    loading.value = false;
  }
}

function openCreation(view: CreationView): void {
  creationView.value = view;
  tagResults.value = null;
  activeEntry.value = null;
  authorView.value = false;
  advancedView.value = false;
}

async function submitEntry(draft: ManualEntryDraft): Promise<void> {
  error.value = null;
  submitting.value = true;
  const targetType = draft.type;
  try {
    const created = await props.api.createEntry({
      title: draft.title,
      type: targetType,
      uploadDate: draft.uploadDate,
    });
    if (draft.coverFile) await props.api.uploadEntryMedia(created.id, 'cover', draft.coverFile);
    if (draft.previewFile) await props.api.uploadEntryMedia(created.id, 'preview', draft.previewFile);
    await refreshGalleries();
    await selectGallery(targetType);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createEntry');
  } finally {
    submitting.value = false;
  }
}

async function submitAuthor(draft: CreateProducerRequest): Promise<void> {
  error.value = null;
  submitting.value = true;
  try {
    const created = await props.api.createAuthor(draft);
    await refreshAuthors();
    showAuthors();
    authorTarget.value = {
      authorId: created.id,
      authorName: created.name,
      directoryId: null,
      directoryName: null,
    };
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createAuthor');
  } finally {
    submitting.value = false;
  }
}

async function finishImport(entryType: string): Promise<void> {
  await Promise.all([refreshGalleries(), refreshAuthors()]);
  await selectGallery(entryType);
}

async function finishBatchImport(): Promise<void> {
  // Batch import commits many items and stays on the Add Entry page; refresh
  // cached galleries/authors so other views see the new entries and producers
  // without navigating away (unlike finishImport).
  await Promise.all([refreshGalleries(), refreshAuthors()]);
}

onMounted(initialize);
</script>

<template>
  <div class="gallery-app" :data-theme="theme">
    <header class="app-header">
      <div>
        <p class="eyebrow">{{ t('app.tagline') }}</p>
        <h1>{{ t('gallery.title') }}</h1>
        <p class="subtitle">{{ t('gallery.subtitle') }}</p>
      </div>
      <div class="header-controls">
        <button
          class="theme-toggle"
          type="button"
          :aria-label="t('theme.switch', { theme: t(`theme.${nextTheme}`) })"
          @click="theme = nextTheme"
        >
          {{ t(`theme.${nextTheme}`) }}
        </button>
        <button
          data-testid="settings-button"
          class="theme-toggle"
          type="button"
          :aria-expanded="settingsOpen"
          @click="toggleSettings"
        >
          {{ t('settings.open') }}
        </button>
        <section v-if="settingsOpen" data-testid="settings-panel" class="settings-panel">
          <h2>{{ t('settings.title') }}</h2>
          <label>
            {{ t('settings.language') }}
            <select data-testid="language-select" :value="locale" @change="selectLocale">
              <option value="en">{{ t('settings.english') }}</option>
              <option value="zh-CN">{{ t('settings.chinese') }}</option>
            </select>
          </label>
          <button
            data-testid="advanced-entry"
            class="advanced-entry"
            type="button"
            @click="openAdvanced"
          >
            <span>{{ t('settings.advanced') }}</span>
            <small>{{ t('settings.advancedHint') }}</small>
          </button>
        </section>
      </div>
    </header>

    <main class="app-layout">
      <aside class="sidebar">
        <div class="section-heading">
          <h2>{{ t('gallery.yours') }}</h2>
          <span>{{ galleries.length }}</span>
        </div>
        <p v-if="loading" class="muted">{{ t('gallery.loading') }}</p>
        <p v-else-if="galleries.length === 0 && authors.length === 0" class="empty-copy">
          {{ t('gallery.empty') }}
        </p>
        <nav v-else class="gallery-list" :aria-label="t('gallery.navigation')">
          <button
            v-for="gallery in galleries"
            :key="gallery.type"
            type="button"
            class="gallery-link"
            :class="{ active: activeType === gallery.type }"
            :data-gallery-type="gallery.type"
            @click="selectGallery(gallery.type)"
          >
            <span>{{ gallery.type }}</span>
            <span class="count">{{ gallery.entryCount }}</span>
          </button>
          <button
            v-if="authors.length > 0"
            data-testid="author-navigation"
            type="button"
            class="gallery-link author-link"
            :class="{ active: authorView }"
            @click="showAuthors"
          >
            <span>{{ t('author.navigation') }}</span>
            <span class="count">{{ authors.length }}</span>
          </button>
        </nav>

        <div class="create-actions">
          <button
            data-testid="add-entry-navigation"
            class="primary-button"
            type="button"
            @click="openCreation('entry')"
          >
            {{ t('entry.new') }}
          </button>
          <button
            data-testid="add-author-navigation"
            class="secondary-button"
            type="button"
            @click="openCreation('author')"
          >
            {{ t('author.new') }}
          </button>
        </div>
      </aside>

      <section class="content-panel">
        <p v-if="error" class="error-message" role="alert">{{ error }}</p>
        <AdvancedEditingPage
          v-if="advancedView"
          :api="api"
          @back="closeAdvanced"
          @authors-changed="refreshAuthors"
        />
        <AddEntryPage
          v-else-if="creationView === 'entry'"
          :api="api"
          :authors="authors"
          :gallery-types="galleries.map((gallery) => gallery.type)"
          :submitting="submitting"
          @back="creationView = null"
          @submit="submitEntry"
          @imported="finishImport"
          @batch-imported="finishBatchImport"
        />
        <AddAuthorPage
          v-else-if="creationView === 'author'"
          :submitting="submitting"
          @back="creationView = null"
          @submit="submitAuthor"
        />
        <section v-else-if="tagResults" data-testid="tag-results" class="tag-results">
          <button type="button" class="back-button" @click="closeTagResults">
            {{ t('entry.back', {
              type: tagResults.kind === 'entry'
                ? tagResults.sourceEntry.title
                : tagResults.sourceAuthor.authorName,
            }) }}
          </button>
          <p class="eyebrow">{{ t(`tag.${tagResults.kind}Results`) }}</p>
          <h2>{{ tagResults.tagName }}</h2>
          <p
            v-if="tagResults.kind === 'entry' && tagResults.entries.length === 0
              || tagResults.kind === 'author' && tagResults.authors.length === 0"
            class="muted"
          >
            {{ t('tag.noResults') }}
          </p>
          <div v-else class="entry-grid">
            <article
              v-for="entry in tagResults.kind === 'entry' ? tagResults.entries : []"
              :key="`entry-${entry.id}`"
              class="entry-card"
            >
              <button
                type="button"
                class="entry-card-main"
                :data-tag-entry-id="entry.id"
                @click="openTagEntry(entry)"
              >
                <div class="entry-stack">
                  <img
                    v-for="(ref, stackIndex) in stackLayers(entry)"
                    :key="`${ref}-${stackIndex}`"
                    class="entry-stack-image"
                    :style="stackStyle(stackIndex, stackLayers(entry).length)"
                    :src="api.assetUrl(ref)"
                    :alt="entry.title"
                  >
                  <span v-if="stackLayers(entry).length === 0" class="entry-placeholder" aria-hidden="true">
                    {{ entry.title.slice(0, 1).toUpperCase() }}
                  </span>
                </div>
                <span class="entry-meta"><strong>{{ entry.title }}</strong><small>{{ entry.type }}</small></span>
              </button>
            </article>
            <article
              v-for="author in tagResults.kind === 'author' ? tagResults.authors : []"
              :key="`author-${author.id}`"
              class="entry-card"
            >
              <button
                type="button"
                class="entry-card-main"
                :data-tag-author-id="author.id"
                @click="openTagAuthor(author)"
              >
                <span class="entry-placeholder" aria-hidden="true">
                  {{ author.name.slice(0, 1).toUpperCase() }}
                </span>
                <span class="entry-meta"><strong>{{ author.name }}</strong></span>
              </button>
            </article>
          </div>
        </section>
        <AuthorPage
          v-else-if="authorView"
          :api="api"
          :authors="authors"
          :initial-author-id="authorTarget?.authorId ?? null"
          :initial-directory-id="authorTarget?.directoryId ?? null"
          :back-label="authorTagOrigin ? t('entry.back', { type: authorTagOrigin.tagName }) : null"
          @open-entry="openEntryFromAuthor"
          @open-tag="openAuthorTag"
          @back="restoreAuthorTagResults"
          @authors-changed="refreshAuthors"
        />
        <article
          v-else-if="activeEntry"
          data-testid="entry-detail"
          class="entry-detail"
          :data-edit-mode="String(editingEntry)"
        >
          <div class="detail-toolbar">
            <button data-testid="entry-back" class="back-button" type="button" @click="closeEntry">
              {{ t('entry.back', { type: entryBackTarget }) }}
            </button>
            <div class="detail-toolbar-actions" data-testid="detail-actions">
              <template v-if="editingEntry">
                <button
                  data-testid="finish-entry-editing"
                  class="secondary-button toolbar-action-primary"
                  type="button"
                  @click="finishEditing"
                >
                  {{ t('entry.done') }}
                </button>
                <button
                  data-testid="save-template-button"
                  class="secondary-button"
                  type="button"
                  :disabled="templateBusy"
                  @click="saveLayoutTemplate"
                >
                  {{ templateBusy ? t('template.applying') : t('template.save') }}
                </button>
                <button
                  data-testid="apply-tag-layout-button"
                  class="secondary-button"
                  type="button"
                  :disabled="tagLayoutBusy"
                  @click="applyActiveEntryTagLayout"
                >
                  {{ tagLayoutBusy ? t('tagLayout.applying') : t('tagLayout.save') }}
                </button>
                <button
                  data-testid="toggle-empty-facets"
                  class="secondary-button"
                  :class="{ 'toolbar-action-active': showEmptyFacets }"
                  type="button"
                  @click="showEmptyFacets = !showEmptyFacets"
                >
                  {{ showEmptyFacets ? t('template.hideEmptyFacets') : t('template.showEmptyFacets') }}
                </button>
                <button
                  data-testid="delete-entry"
                  class="secondary-button danger-button"
                  type="button"
                  @click="deleteActiveEntry"
                >
                  {{ t('entry.delete') }}
                </button>
              </template>
              <button
                v-else
                data-testid="start-entry-editing"
                class="secondary-button"
                type="button"
                @click="startEditing"
              >
                {{ t('entry.edit') }}
              </button>
            </div>
          </div>
          <p v-if="templateNotice" class="template-notice" data-testid="template-notice" role="status">
            {{ templateNotice }}
          </p>
          <p v-if="tagLayoutNotice" class="template-notice" data-testid="tag-layout-notice" role="status">
            {{ tagLayoutNotice }}
          </p>
          <p class="eyebrow">{{ activeEntry.type }}</p>
          <h2>{{ activeEntry.title }}</h2>

          <div v-if="mediaSlides.length > 0" class="entry-media-viewer">
            <img
              class="entry-media-image"
              :src="api.assetUrl(mediaSlides[mediaIndex] ?? '')"
              :alt="activeEntry.title"
            >
            <button
              v-if="mediaIndex > 0"
              class="media-nav media-prev"
              type="button"
              :aria-label="t('media.previous')"
              @click="mediaPrevious"
            >‹</button>
            <button
              v-if="mediaIndex < mediaSlides.length - 1"
              class="media-nav media-next"
              type="button"
              :aria-label="t('media.next')"
              @click="mediaNext"
            >›</button>
            <span v-if="mediaSlides.length > 1" class="media-count">
              {{ mediaIndex + 1 }} / {{ mediaSlides.length }}
            </span>
          </div>

          <section v-if="activeEntry.producers.length || editingEntry" class="detail-section">
            <h3>{{ t('entry.producers') }}</h3>
            <div class="chip-row">
              <span
                v-for="producer in activeEntry.producers"
                :key="producer.id"
                class="detail-chip"
                :data-entry-author-id="producer.id"
                @dblclick="!editingEntry && openAuthorFromEntry(producer.id)"
              >
                {{ producer.name }}
                <button
                  v-if="editingEntry"
                  type="button"
                  class="remove-tag-button"
                  :data-unlink-author-id="producer.id"
                  :aria-label="t('author.unlink', { name: producer.name })"
                  @click="unlinkAuthor(producer.id)"
                >×</button>
              </span>
              <button
                v-if="editingEntry && !authorEditorOpen"
                data-testid="add-entry-author"
                type="button"
                class="add-button add-tag-button"
                @click="authorEditorOpen = true"
              >
                {{ t('author.new') }}
              </button>
              <form
                v-else-if="editingEntry"
                data-testid="create-entry-author-form"
                class="compact-editor"
                @submit.prevent="createAndLinkAuthor"
              >
                <input
                  v-model="newAuthorName"
                  name="authorName"
                  :size="inlineInputSize(newAuthorName)"
                  required
                  autocomplete="off"
                  :placeholder="t('author.namePlaceholder')"
                  @keydown.enter.prevent="createAndLinkAuthor"
                  @blur="newAuthorName.trim() && createAndLinkAuthor()"
                >
              </form>
              <button
                v-if="editingEntry && availableAuthors.length > 0 && !authorLinkEditorOpen"
                data-testid="link-entry-author"
                type="button"
                class="add-button add-tag-button"
                @click="authorLinkEditorOpen = true"
              >
                {{ t('author.linkExisting') }}
              </button>
            </div>
            <div
              v-if="editingEntry && availableAuthors.length > 0 && authorLinkEditorOpen"
              data-testid="link-existing-author-form"
              class="compact-editor author-link-editor"
            >
              <input
                v-model="authorSearchQuery"
                name="existingAuthorName"
                :size="inlineInputSize(authorSearchQuery)"
                autocomplete="off"
                :placeholder="t('author.chooseExisting')"
                @keydown.enter.prevent="linkExistingAuthor()"
                @blur="authorSearchQuery.trim() && linkExistingAuthor()"
              >
              <div data-testid="author-suggestions" class="author-suggestions">
                <button
                  v-for="author in filteredAvailableAuthors"
                  :key="author.id"
                  type="button"
                  @mousedown.prevent
                  @click="linkExistingAuthor(author.id)"
                >
                  {{ author.name }}
                </button>
                <span v-if="filteredAvailableAuthors.length === 0" class="muted">
                  {{ t('author.noMatches') }}
                </span>
              </div>
            </div>
          </section>

          <div data-testid="entry-information-board" class="information-board">
            <p v-if="activeEntry.sections.length === 0" class="information-empty">
              {{ t('information.empty') }}
            </p>
            <section
              v-for="section in activeEntry.sections"
              :key="section.id"
              class="information-section"
              :data-section-id="section.id"
            >
              <header class="information-section-header">
                <h3>{{ section.name }}</h3>
                <span
                  v-if="isBasicSection(section) && (activeEntry.pageCount !== null || activeEntry.uploadDate)"
                  class="information-stats"
                >
                  <span v-if="activeEntry.pageCount !== null" class="information-stat">
                    {{ t('entry.pageCount', { count: activeEntry.pageCount }) }}
                  </span>
                  <span v-if="activeEntry.uploadDate" class="information-stat">
                    {{ t('entry.uploadDate', { date: activeEntry.uploadDate }) }}
                  </span>
                </span>
              </header>
              <div class="facet-table">
                <div
                  v-for="(facet, facetIndex) in visibleFacets(section)"
                  :key="facet.id"
                  class="facet-row"
                  :data-facet-id="facet.id"
                  :data-unnamed-facet="String(facet.name.length === 0)"
                  :aria-label="facet.name || t('information.directTags', { section: section.name })"
                  @dragover.prevent
                  @drop="moveDraggedTag(facet.id)"
                >
                  <div class="facet-label-column" data-facet-label>
                    <span v-if="facet.name" class="facet-name">{{ facet.name }}</span>
                    <div
                      v-if="editingEntry && facet.name"
                      class="facet-sort-controls"
                    >
                      <button
                        :data-move-facet-up-id="facet.id"
                        type="button"
                        :disabled="facetIndex === 0"
                        :aria-label="t('facet.moveUp', { name: facet.name })"
                        @click.stop="moveFacet(section.id, facet.id, -1)"
                      >
                        ↑
                      </button>
                      <button
                        :data-move-facet-down-id="facet.id"
                        type="button"
                        :disabled="facetIndex === visibleFacets(section).length - 1"
                        :aria-label="t('facet.moveDown', { name: facet.name })"
                        @click.stop="moveFacet(section.id, facet.id, 1)"
                      >
                        ↓
                      </button>
                      <button
                        :data-delete-facet-id="facet.id"
                        class="facet-delete"
                        type="button"
                        :aria-label="t('facet.delete', { name: facet.name })"
                        @click.stop="removeFacet(facet.id)"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                  <div class="facet-tag-column" data-tag-column>
                    <div class="chip-row">
                      <span
                        v-for="tag in facet.tags"
                        :key="tag.id"
                        class="detail-chip draggable-chip"
                        :draggable="editingEntry && editingTagId !== tag.id"
                        :data-detail-tag-id="tag.id"
                        @dragstart="beginTagDrag(tag.id)"
                        @dragend="draggedTagId = null"
                        @dblclick="editingEntry ? beginTagRename(tag) : openEntryTag(tag)"
                      >
                        <input
                          v-if="editingTagId === tag.id"
                          v-model="editingTagName"
                          :data-rename-entry-tag-id="tag.id"
                          :size="inlineInputSize(editingTagName)"
                          required
                          autocomplete="off"
                          :aria-label="t('tag.rename')"
                          @click.stop
                          @dblclick.stop
                          @keydown.enter.prevent="saveTagRename(tag.id)"
                          @blur="saveTagRename(tag.id)"
                        >
                        <span v-else>{{ tag.name }}</span>
                        <button
                          v-if="editingEntry"
                          type="button"
                          class="remove-tag-button"
                          :data-remove-entry-tag-id="tag.id"
                          :aria-label="t('tag.remove', { name: tag.name })"
                          @click.stop="removeTag(tag.id)"
                        >
                          ×
                        </button>
                      </span>
                      <button
                        v-if="editingEntry && tagEditorFacetId !== facet.id"
                        class="add-button add-tag-button"
                        type="button"
                        :data-add-tag-facet-id="facet.id"
                        @click="tagEditorFacetId = facet.id"
                      >
                        {{ t('tag.add') }}
                      </button>
                      <form
                        v-else-if="editingEntry"
                        class="compact-editor tag-editor"
                        :data-create-tag-facet-id="facet.id"
                        @submit.prevent="addEntryTag(facet.id)"
                      >
                        <input
                          v-model="tagName"
                          name="tagName"
                          :size="inlineInputSize(tagName)"
                          required
                          autocomplete="off"
                          :placeholder="t('tag.namePlaceholder')"
                          @blur="tagName.trim() && addEntryTag(facet.id)"
                        >
                      </form>
                    </div>
                  </div>
                </div>
              </div>
              <div
                v-if="editingEntry && visibleFacets(section).length === 0"
                class="facet-row empty-section-controls"
                :data-empty-section-controls="section.id"
              >
                <div class="facet-label-column">
                  <button
                    v-if="facetEditorSectionId !== section.id"
                    class="add-button"
                    type="button"
                    :data-add-facet-section-id="section.id"
                    @click="facetEditorSectionId = section.id"
                  >
                    {{ t('facet.add') }}
                  </button>
                  <form
                    v-else
                    class="compact-editor"
                    :data-create-facet-section-id="section.id"
                    @submit.prevent="createNamedFacet(section.id)"
                  >
                    <input
                      v-model="facetName"
                      name="facetName"
                      :size="inlineInputSize(facetName)"
                      required
                      autocomplete="off"
                      :placeholder="t('facet.namePlaceholder')"
                      @blur="facetName.trim() && createNamedFacet(section.id)"
                    >
                  </form>
                </div>
                <div class="facet-tag-column">
                  <button
                    v-if="emptyUnnamedFacetId(section) !== null
                      && tagEditorFacetId !== emptyUnnamedFacetId(section)"
                    class="add-button add-tag-button"
                    type="button"
                    :data-add-direct-tag-section-id="section.id"
                    @click="tagEditorFacetId = emptyUnnamedFacetId(section)"
                  >
                    {{ t('tag.add') }}
                  </button>
                  <form
                    v-else
                    class="compact-editor tag-editor"
                    :data-create-tag-facet-id="emptyUnnamedFacetId(section)"
                    @submit.prevent="addEntryTag(emptyUnnamedFacetId(section))"
                  >
                    <input
                      v-model="tagName"
                      name="tagName"
                      :size="inlineInputSize(tagName)"
                      required
                      autocomplete="off"
                      :placeholder="t('tag.namePlaceholder')"
                      @blur="tagName.trim() && addEntryTag(emptyUnnamedFacetId(section))"
                    >
                  </form>
                </div>
              </div>
              <div v-else-if="editingEntry" class="add-facet-control">
                <button
                  v-if="facetEditorSectionId !== section.id"
                  class="add-button"
                  type="button"
                  :data-add-facet-section-id="section.id"
                  @click="facetEditorSectionId = section.id"
                >
                  {{ t('facet.add') }}
                </button>
                <form
                  v-else
                  class="compact-editor"
                  :data-create-facet-section-id="section.id"
                  @submit.prevent="createNamedFacet(section.id)"
                >
                  <input
                    v-model="facetName"
                    name="facetName"
                    :size="inlineInputSize(facetName)"
                    required
                    autocomplete="off"
                    :placeholder="t('facet.namePlaceholder')"
                    @blur="facetName.trim() && createNamedFacet(section.id)"
                  >
                </form>
              </div>
            </section>

            <div v-if="editingEntry" class="add-section-control">
              <button
                v-if="!sectionEditorOpen"
                data-testid="add-section-button"
                class="add-button"
                type="button"
                @click="sectionEditorOpen = true"
              >
                {{ t('section.add') }}
              </button>
              <form
                v-else
                data-testid="create-section-form"
                class="compact-editor"
                @submit.prevent="createSection"
              >
                <input
                  v-model="sectionName"
                  name="sectionName"
                  :size="inlineInputSize(sectionName)"
                  required
                  autocomplete="off"
                  :placeholder="t('section.namePlaceholder')"
                  @blur="sectionName.trim() && createSection()"
                >
              </form>
            </div>
          </div>

          <section v-if="activeEntry.contents.length || editingEntry" class="detail-section content-section">
            <h3>{{ t('content.title') }}</h3>
            <p v-if="activeEntry.contents.length === 0" class="content-empty">
              {{ t('content.empty') }}
            </p>
            <div
              v-for="(content, contentIndex) in activeEntry.contents"
              :key="content.id"
              class="content-item"
              :data-content-id="content.id"
            >
              <form
                v-if="editingContentId === content.id"
                :data-testid="`edit-content-form-${content.id}`"
                class="content-editor"
                @submit.prevent="saveContentEdit(content.id)"
              >
                <label>
                  {{ t('content.label') }}
                  <input
                    v-model="editingContentType"
                    name="contentType"
                    required
                    autocomplete="off"
                  >
                </label>
                <label>
                  {{ t('content.body') }}
                  <textarea v-model="editingContentBody" name="content" rows="4" />
                </label>
                <div class="content-editor-actions">
                  <button class="primary-button compact-submit" type="submit">
                    {{ t('content.save') }}
                  </button>
                  <button class="secondary-button" type="button" @click="cancelContentEdit">
                    {{ t('content.cancel') }}
                  </button>
                </div>
              </form>
              <template v-else>
                <div class="content-item-header">
                  <span>{{ content.contentType }}</span>
                  <div v-if="editingEntry" class="content-item-actions">
                    <button
                      class="content-action-button"
                      type="button"
                      :data-move-content-up-id="content.id"
                      :aria-label="t('content.moveUp', { label: content.contentType })"
                      :disabled="contentIndex === 0"
                      @click="moveContent(content.id, -1)"
                    >
                      ↑
                    </button>
                    <button
                      class="content-action-button"
                      type="button"
                      :data-move-content-down-id="content.id"
                      :aria-label="t('content.moveDown', { label: content.contentType })"
                      :disabled="contentIndex === activeEntry.contents.length - 1"
                      @click="moveContent(content.id, 1)"
                    >
                      ↓
                    </button>
                    <button
                      class="content-action-button"
                      type="button"
                      :data-edit-content-id="content.id"
                      :aria-label="t('content.edit', { label: content.contentType })"
                      @click="beginContentEdit(content)"
                    >
                      {{ t('content.editAction') }}
                    </button>
                    <button
                      class="content-action-button danger-action"
                      type="button"
                      :data-delete-content-id="content.id"
                      :aria-label="t('content.delete', { label: content.contentType })"
                      @click="deleteContent(content.id)"
                    >
                      {{ t('content.deleteAction') }}
                    </button>
                  </div>
                </div>
                <a
                  v-if="isHttpUrl(content.content)"
                  class="content-link"
                  :href="content.content"
                  target="_blank"
                  rel="noopener noreferrer"
                >{{ content.content }}</a>
                <p v-else>{{ content.content }}</p>
              </template>
            </div>
            <div v-if="editingEntry" class="add-content-control">
              <button
                v-if="!contentEditorOpen"
                data-testid="add-content-button"
                class="add-button"
                type="button"
                @click="contentEditorOpen = true"
              >
                {{ t('content.add') }}
              </button>
              <form
                v-else
                data-testid="create-content-form"
                class="content-editor"
                @submit.prevent="createContent"
              >
                <label>
                  {{ t('content.label') }}
                  <input
                    v-model="contentType"
                    name="contentType"
                    required
                    autocomplete="off"
                    :placeholder="t('content.typePlaceholder')"
                  >
                </label>
                <label>
                  {{ t('content.body') }}
                  <textarea
                    v-model="contentBody"
                    name="content"
                    rows="4"
                    :placeholder="t('content.bodyPlaceholder')"
                  />
                </label>
                <button class="primary-button compact-submit" type="submit">
                  {{ t('content.addAction') }}
                </button>
              </form>
            </div>
          </section>
        </article>
        <template v-else-if="activeType">
          <div class="content-heading">
            <div>
              <p class="eyebrow">{{ t('gallery.eyebrow') }}</p>
              <h2 data-testid="active-gallery-title">{{ activeType }}</h2>
            </div>
            <div class="content-heading-actions">
              <label class="sort-control">
                <span>{{ t('gallery.sortLabel') }}</span>
                <select v-model="gallerySort" data-testid="gallery-sort">
                  <option value="date-desc">{{ t('gallery.sortDateNewest') }}</option>
                  <option value="date-asc">{{ t('gallery.sortDateOldest') }}</option>
                  <option value="title-asc">{{ t('gallery.sortTitleAz') }}</option>
                  <option value="title-desc">{{ t('gallery.sortTitleZa') }}</option>
                </select>
              </label>
              <span>
                {{ t(entries.length === 1 ? 'gallery.entryCountOne' : 'gallery.entryCount', {
                  count: entries.length,
                }) }}
              </span>
            </div>
          </div>
          <div v-if="facetFilterOptions
            && (facetFilterOptions.facets.length > 0 || facetFilterOptions.allTags.length > 0)"
            class="gallery-filter-wrap"
          >
            <FacetFilterBar
              :options="facetFilterOptions"
              :model-value="facetFilters"
              @update:model-value="onFacetFiltersChange"
            />
          </div>
          <div data-testid="entry-list" class="entry-grid">
            <article
              v-for="entry in sortedEntries"
              :key="entry.id"
              class="entry-card"
            >
              <button
                type="button"
                class="entry-card-main"
                :data-entry-id="entry.id"
                @click="viewEntry(entry.id)"
              >
                <div class="entry-stack">
                  <img
                    v-for="(ref, stackIndex) in stackLayers(entry)"
                    :key="`${ref}-${stackIndex}`"
                    class="entry-stack-image"
                    :style="stackStyle(stackIndex, stackLayers(entry).length)"
                    :src="api.assetUrl(ref)"
                    :alt="entry.title"
                  >
                  <span v-if="stackLayers(entry).length === 0" class="entry-placeholder" aria-hidden="true">
                    {{ entry.title.slice(0, 1).toUpperCase() }}
                  </span>
                </div>
                <span class="entry-meta">
                  <strong>{{ entry.title }}</strong>
                  <small>{{ entry.type }}</small>
                </span>
              </button>
            </article>
          </div>
        </template>
        <div v-else-if="!loading" class="welcome-state">
          <p class="eyebrow">{{ t('welcome.eyebrow') }}</p>
          <h2>{{ t('welcome.title') }}</h2>
          <p>{{ t('welcome.body') }}</p>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.gallery-app {
  min-height: 100vh;
  padding: clamp(1rem, 3vw, 2.5rem);
  color: var(--text-primary);
  background: var(--page-background);
}

.app-header,
.app-layout {
  width: min(76rem, 100%);
  margin-inline: auto;
}

.app-header,
.section-heading,
.content-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.content-heading-actions { display: flex; align-items: center; gap: 0.75rem; }
.content-heading-actions > span { color: var(--text-muted); }
.gallery-filter-wrap { margin-bottom: 1rem; }
.sort-control { display: flex; align-items: center; gap: 0.35rem; color: var(--text-muted); font-size: 0.85rem; }
.sort-control select { font: inherit; }

.app-header { margin-bottom: 1.5rem; }
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 0.25rem; font-size: clamp(2rem, 5vw, 3.25rem); letter-spacing: -0.05em; }
h2 { margin-bottom: 0; }
.subtitle, .muted, .empty-copy, .form-hint, .entry-card p, .content-heading > span, .welcome-state p { color: var(--text-muted); }
.subtitle { margin-bottom: 0; }
.eyebrow { margin-bottom: 0.35rem; color: var(--accent); font-size: 0.72rem; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }

.theme-toggle,
.gallery-link,
.primary-button {
  border: 1px solid var(--border-subtle);
  font: inherit;
  cursor: pointer;
}
.theme-toggle { padding: 0.55rem 0.8rem; border-radius: 0.7rem; color: var(--text-primary); background: var(--surface); }
.header-controls { position: relative; display: flex; align-items: center; gap: 0.5rem; }
.settings-panel { position: absolute; z-index: 10; top: calc(100% + 0.5rem); right: 0; width: min(36rem, calc(100vw - 2rem)); padding: 1rem; border: 1px solid var(--border-subtle); border-radius: 0.8rem; background: var(--surface); box-shadow: 0 0.75rem 2rem rgb(15 23 42 / 14%); }
.settings-panel h2 { margin-bottom: 0.8rem; font-size: 1rem; }
.settings-panel label { display: grid; gap: 0.4rem; color: var(--text-muted); font-size: 0.8rem; font-weight: 700; }
.settings-panel select { width: 100%; padding: 0.55rem 0.65rem; border: 1px solid var(--border-subtle); border-radius: 0.55rem; color: var(--text-primary); background: var(--surface-muted); font: inherit; }
.advanced-entry { display: grid; gap: 0.15rem; width: 100%; margin-top: 0.9rem; padding: 0.65rem 0.7rem; border: 1px solid var(--border-subtle); border-radius: 0.6rem; color: var(--text-primary); background: var(--surface-muted); font: inherit; text-align: left; cursor: pointer; }
.advanced-entry small { color: var(--text-muted); font-weight: 400; font-size: 0.72rem; }
.advanced-entry:hover, .advanced-entry:focus-visible { border-color: var(--accent); outline: none; }

.app-layout { display: grid; grid-template-columns: 18rem minmax(0, 1fr); gap: 1rem; }
.sidebar,
.content-panel { border: 1px solid var(--border-subtle); border-radius: 1rem; background: var(--surface); box-shadow: 0 0.5rem 1.5rem rgb(15 23 42 / 6%); }
.sidebar { padding: 1rem; }
.content-panel { min-height: 30rem; padding: clamp(1rem, 3vw, 1.75rem); }
.section-heading { margin-bottom: 0.8rem; }
.section-heading h2 { font-size: 0.95rem; }
.section-heading > span, .count { color: var(--text-muted); font-size: 0.78rem; }
.gallery-list { display: grid; gap: 0.35rem; }
.gallery-link { display: flex; justify-content: space-between; width: 100%; padding: 0.65rem 0.75rem; border-color: transparent; border-radius: 0.65rem; color: var(--text-primary); background: transparent; text-align: left; }
.gallery-link:hover, .gallery-link.active { color: var(--tag-text); background: var(--tag-background); border-color: var(--tag-border); }

.create-form { display: grid; gap: 0.8rem; margin-top: 1.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border-subtle); }
.create-form label { display: grid; gap: 0.35rem; font-size: 0.8rem; font-weight: 700; }
.create-form input { width: 100%; padding: 0.6rem 0.7rem; border: 1px solid var(--border-subtle); border-radius: 0.6rem; color: var(--text-primary); background: var(--surface-muted); }
.create-form input:focus { border-color: var(--accent); outline: 2px solid color-mix(in srgb, var(--accent) 20%, transparent); }
.form-hint { margin: -0.2rem 0 0; font-size: 0.72rem; line-height: 1.45; }
.primary-button { padding: 0.65rem 0.8rem; border-color: var(--accent); border-radius: 0.65rem; color: white; background: var(--accent); font-weight: 750; }
.primary-button:hover { background: var(--accent-hover); }
.primary-button:disabled { cursor: wait; opacity: 0.65; }

.content-heading { margin-bottom: 1.25rem; }
.content-heading h2 { font-size: clamp(1.5rem, 4vw, 2.25rem); letter-spacing: -0.035em; }
.entry-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr)); gap: 0.8rem; }
.entry-card { position: relative; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: 0.8rem; background: var(--surface-muted); }
.entry-card:hover, .entry-card:focus-within { border-color: var(--accent); transform: translateY(-1px); }
.entry-card-main { display: block; width: 100%; padding: 0; border: 0; color: var(--text-primary); background: transparent; font: inherit; text-align: left; cursor: pointer; }
.entry-card-main:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.entry-placeholder { display: grid; min-height: 8rem; place-items: center; color: var(--tag-text); background: var(--tag-background); font-size: 2rem; font-weight: 850; }
.entry-stack { position: relative; aspect-ratio: 4 / 3; overflow: hidden; isolation: isolate; background: var(--surface-muted); }
.entry-stack-image { position: absolute; width: 70%; height: 94%; object-fit: contain; object-position: center; border: 1px solid color-mix(in srgb, var(--border-subtle) 75%, transparent); border-radius: 0.15rem; background: var(--surface); box-shadow: 0 0.18rem 0.45rem rgb(15 23 42 / 16%); transform-origin: 50% 100%; }
.entry-stack-image:first-child { box-shadow: 0 0.28rem 0.7rem rgb(15 23 42 / 22%); }
.entry-stack .entry-placeholder { height: 100%; }
.entry-media-viewer { position: relative; margin: 1rem 0 1.25rem; max-width: 24rem; }
.entry-media-image { display: block; width: 100%; max-height: 24rem; object-fit: contain; border: 1px solid var(--border-subtle); border-radius: 0.8rem; background: var(--surface-muted); }
.media-nav { position: absolute; top: 50%; transform: translateY(-50%); width: 2rem; height: 2rem; border: 0; border-radius: 999px; color: var(--text-primary); background: rgb(0 0 0 / 45%); font-size: 1.25rem; line-height: 1; cursor: pointer; }
.media-prev { left: 0.5rem; }
.media-next { right: 0.5rem; }
.media-count { position: absolute; bottom: 0.5rem; right: 0.5rem; padding: 0.15rem 0.5rem; border-radius: 999px; color: var(--text-primary); background: rgb(0 0 0 / 45%); font-size: 0.75rem; }
.entry-meta { display: grid; gap: 0.25rem; padding: 0.85rem; }
.entry-meta small { color: var(--text-muted); }
.secondary-button { border: 1px solid var(--border-subtle); border-radius: 0.55rem; color: var(--text-primary); background: var(--surface); font: inherit; cursor: pointer; }
.secondary-button:hover, .secondary-button:focus-visible { border-color: var(--accent); outline: none; }
.entry-detail > h2 { margin-bottom: 1.5rem; font-size: clamp(1.7rem, 4vw, 2.5rem); }
.detail-toolbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1.5rem; }
.detail-toolbar-actions { display: grid; gap: 0.4rem; justify-items: stretch; }
.detail-toolbar-actions .secondary-button { text-align: left; white-space: nowrap; }
.toolbar-action-primary { color: white; border-color: var(--accent); background: var(--accent); }
.toolbar-action-active { border-color: var(--accent); color: var(--accent); }
.template-notice { margin: -0.75rem 0 0.75rem; padding: 0.5rem 0.7rem; border-radius: 0.55rem; color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); font-size: 0.8rem; }
.back-button { padding: 0; border: 0; color: var(--accent); background: transparent; font: inherit; cursor: pointer; }
.secondary-button { padding: 0.45rem 0.7rem; }
.detail-section { padding: 1rem 0; border-top: 1px solid var(--border-subtle); }
.detail-section h3 { margin-bottom: 0.75rem; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.06em; }
.information-board { margin-top: 0.25rem; border-top: 1px solid var(--border-subtle); }
.information-empty { margin: 0; padding: 1rem 0; color: var(--text-muted); font-size: 0.8rem; }
.information-section { padding: 1.1rem 0; }
.information-section + .information-section { border-top: 1px dashed var(--border-subtle); }
.information-section-header h3 { margin-bottom: 0.55rem; font-size: 0.86rem; letter-spacing: 0.035em; }
.information-section-header { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; }
.information-stats { display: inline-flex; flex-wrap: wrap; gap: 0.5rem 0.9rem; margin-bottom: 0.55rem; }
.information-stat { color: var(--text-muted); font-size: 0.78rem; }
.facet-table { display: grid; }
.facet-row { display: grid; grid-template-columns: minmax(6.5rem, 9.5rem) minmax(0, 1fr); min-height: 2.8rem; border-radius: 0.55rem; }
.facet-row:has(.draggable-chip:active) { background: var(--surface-muted); }
.facet-label-column { min-width: 0; padding: 0.65rem 0.9rem 0.65rem 0; border-right: 1px dashed color-mix(in srgb, var(--border-subtle) 58%, transparent); color: var(--text-muted); font-size: 0.76rem; line-height: 1.4; }
.facet-tag-column { min-width: 0; padding: 0.55rem 0 0.55rem 1rem; }
.facet-name { display: block; overflow-wrap: anywhere; }
.chip-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
.detail-chip { display: inline-flex; align-items: center; padding: 0.35rem 0.6rem; border: 1px solid var(--tag-border); border-radius: 999px; color: var(--tag-text); background: var(--tag-background); font-size: 0.78rem; }
.draggable-chip[draggable='true'] { cursor: grab; }
.draggable-chip[draggable='true']:active { cursor: grabbing; }
.remove-tag-button { margin-left: 0.35rem; padding: 0; border: 0; color: inherit; background: transparent; font: inherit; line-height: 1; cursor: pointer; opacity: 0.55; }
.remove-tag-button:hover, .remove-tag-button:focus-visible { opacity: 1; }
.add-facet-control { padding-top: 0.55rem; }
.add-section-control { padding: 0.9rem 0; border-top: 1px dashed var(--border-subtle); }
.add-button { padding: 0.38rem 0.6rem; border: 1px dashed var(--border-subtle); border-radius: 0.55rem; color: var(--text-muted); background: transparent; font: inherit; font-size: 0.76rem; cursor: pointer; }
.add-button:hover, .add-button:focus-visible { border-color: var(--accent); color: var(--accent); outline: none; background: var(--surface-muted); }
.add-tag-button { padding: 0.3rem 0.55rem; border-radius: 999px; }
.compact-editor { display: inline-flex; flex: 0 1 auto; flex-wrap: wrap; align-items: center; gap: 0.4rem; max-width: 100%; }
.compact-editor input { min-width: 0; max-width: 100%; flex: 0 1 auto; padding: 0.46rem 0.58rem; border: 1px solid var(--border-subtle); border-radius: 0.52rem; color: var(--text-primary); background: var(--surface); font: inherit; font-size: 0.8rem; }
.compact-editor input:focus { border-color: var(--accent); outline: 2px solid color-mix(in srgb, var(--accent) 18%, transparent); }
.author-link-editor { position: relative; display: inline-grid; margin-top: 0.45rem; }
.author-suggestions { position: absolute; z-index: 5; top: calc(100% + 0.25rem); left: 0; display: grid; min-width: 100%; max-height: 12rem; overflow-y: auto; padding: 0.25rem; border: 1px solid var(--border-subtle); border-radius: 0.55rem; background: var(--surface); box-shadow: 0 0.65rem 1.5rem rgb(15 23 42 / 12%); }
.author-suggestions button { padding: 0.45rem 0.55rem; border: 0; border-radius: 0.4rem; color: var(--text-primary); background: transparent; font: inherit; text-align: left; cursor: pointer; }
.author-suggestions button:hover, .author-suggestions button:focus-visible { color: var(--accent); background: var(--surface-muted); outline: none; }
.author-suggestions .muted { padding: 0.45rem 0.55rem; white-space: nowrap; }
.compact-submit { padding: 0.46rem 0.62rem; }
.tag-editor { min-width: 0; }
.content-item { padding: 0.75rem; border-radius: 0.65rem; background: var(--surface-muted); }
.content-item + .content-item { margin-top: 0.5rem; }
.content-item-header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.content-item-header > span { color: var(--accent); font-size: 0.72rem; font-weight: 750; }
.content-item-actions { display: flex; gap: 0.5rem; }
.content-action-button { border: 0; color: var(--accent); background: transparent; cursor: pointer; }
.content-action-button:disabled { cursor: default; opacity: 0.3; }
.danger-action { color: #a12626; }
.danger-button { border-color: #a12626; color: #a12626; }
.content-editor-actions { display: flex; gap: 0.5rem; }
.content-item p { margin: 0.35rem 0 0; white-space: pre-wrap; }
.content-link { display: inline-block; margin: 0.35rem 0 0; color: var(--accent); overflow-wrap: anywhere; }
.error-message { padding: 0.75rem; border-radius: 0.6rem; color: #a12626; background: #fff0f0; }
.welcome-state { max-width: 30rem; margin: 8rem auto; text-align: center; }

@media (max-width: 44rem) {
  .app-header { align-items: flex-start; }
  .header-controls { flex-wrap: wrap; justify-content: flex-end; }
  .app-layout { grid-template-columns: 1fr; }
  .content-panel { min-height: 20rem; }
  .facet-row { grid-template-columns: minmax(4.75rem, 6rem) minmax(0, 1fr); }
  .facet-label-column { padding-right: 0.6rem; }
  .facet-tag-column { padding-left: 0.7rem; }
}
</style>
