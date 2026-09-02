<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { normalizeTag } from '@t3/shared';
import type {
  AuthorDetailResponse,
  AuthorDirectoryDto,
  FacetFilterOptions,
  ProducerRecordDto,
} from '@t3/shared';
import type { GalleryApi } from './api/gallery.js';
import FacetFilterBar, { type GalleryFacetFilters } from './components/FacetFilterBar.vue';
import { useI18n } from './i18n.js';

interface AuthorSummary {
  id: number;
  name: string;
  covers: string[];
  galleryType: string | null;
}

type AuthorWork = AuthorDetailResponse['looseEntries'][number];
type DirectoryCard = { kind: 'directory'; directory: AuthorDirectoryDto };
type WorkCard = { kind: 'work'; work: AuthorWork };
type AuthorCard = DirectoryCard | WorkCard;

const props = defineProps<{
  api: GalleryApi;
  authors: AuthorSummary[];
  initialAuthorId?: number | null;
  initialDirectoryId?: number | null;
  backLabel?: string | null;
}>();
const emit = defineEmits<{
  'open-entry': [payload: {
    work: AuthorWork;
    authorId: number;
    authorName: string;
    directoryId: number | null;
    directoryName: string | null;
  }];
  'open-tag': [payload: {
    tagId: number;
    tagName: string;
    authorId: number;
    authorName: string;
  }];
  'back': [];
  'authors-changed': [];
}>();
const { t } = useI18n();
const activeAuthor = ref<AuthorDetailResponse | null>(null);
const activeDirectoryId = ref<number | null>(null);
const editingAuthor = ref(false);
const editingDirectory = ref(false);
const page = ref(1);
const draggedWorkId = ref<number | null>(null);
const dropTarget = ref<string | null>(null);
const error = ref<string | null>(null);
const authorName = ref('');
const authorOccupation = ref('');
const authorArtwork = ref('');
const authorContent = ref('');
const tagEditorOpen = ref(false);
const tagName = ref('');
const editingTagId = ref<number | null>(null);
const editingTagName = ref('');
const directoryTitle = ref('');
const directoryDescription = ref('');

const activeDirectory = computed(() => activeAuthor.value?.directories
  .find((directory) => directory.id === activeDirectoryId.value) ?? null);
type AuthorSort = 'date-desc' | 'date-asc' | 'title-asc' | 'title-desc' | 'type';
// Newest first by default, mirroring the gallery's date order.
const authorSort = ref<AuthorSort>('date-desc');
// One page of loose works; Directories always render above them (they are
// drop targets, so they must never be pushed onto a later page).
const pageSize = 26;

function directoryDate(directory: AuthorDirectoryDto): number {
  return Math.max(0, ...directory.entries.map((entry) => entry.id));
}

function byTitle(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base' });
}

function compareAuthorCards(left: AuthorCard, right: AuthorCard): number {
  const direction = authorSort.value.endsWith('-desc') ? -1 : 1;
  const sortKey = authorSort.value === 'type' ? 'date-desc' : authorSort.value;
  const leftTitle = left.kind === 'directory' ? left.directory.title : left.work.title;
  const rightTitle = right.kind === 'directory' ? right.directory.title : right.work.title;
  if (sortKey.startsWith('title')) {
    return direction * byTitle(leftTitle, rightTitle);
  }
  const leftDate = left.kind === 'directory' ? directoryDate(left.directory) : left.work.id;
  const rightDate = right.kind === 'directory' ? directoryDate(right.directory) : right.work.id;
  const dateCompare = leftDate - rightDate;
  return direction * (dateCompare !== 0 ? dateCompare : byTitle(leftTitle, rightTitle));
}

const directoryCards = computed<DirectoryCard[]>(() => {
  if (!activeAuthor.value) return [];
  return activeAuthor.value.directories
    // A Directory stays visible while at least one of its works matches.
    .filter((directory) => directory.entries.some((work) => workMatches(work.id)))
    .map((directory) => ({ kind: 'directory' as const, directory }))
    .sort(compareAuthorCards);
});

const workCards = computed<WorkCard[]>(() => {
  if (!activeAuthor.value) return [];
  return activeAuthor.value.looseEntries
    .filter((work) => workMatches(work.id))
    .map((work) => ({ kind: 'work' as const, work }))
    .sort(compareAuthorCards);
});

// When the facet filter is active, Directories are unfolded: every matching
// work (loose or inside a Directory) becomes one plain card in a single
// sorted/paginated grid, so filtering sees ALL works — the pinned Directory
// row only renders while no filter is active.

// Works filtering (same facet filter bar as the Gallery, minus the Authors
// row — the author is fixed). Options are aggregated server-side for THIS
// author's works inside his dominant Gallery type; the filter bar only
// appears when all of his works share one type.
const authorFilterOptions = ref<FacetFilterOptions | null>(null);
const authorFilters = ref<GalleryFacetFilters>({ conditions: [], authorIds: [] });
const matchedWorkIds = ref<Set<number> | null>(null);
const authorWorksList = computed<Array<{ id: number; type: string }>>(() => {
  if (!activeAuthor.value) return [];
  return [
    ...activeAuthor.value.looseEntries.map((work) => ({ id: work.id, type: work.type })),
    ...activeAuthor.value.directories.flatMap((directory) =>
      directory.entries.map((entry) => ({ id: entry.id, type: entry.type }))),
  ];
});
// Cross-type Authors keep the plain list for now (single-type assumption).
const authorFilterType = computed<string | null>(() => {
  const types = new Set(authorWorksList.value.map((work) => work.type));
  return types.size === 1 ? [...types][0]! : null;
});
const filterActive = computed<boolean>(() => (
  authorFilters.value.conditions.some((condition) => condition.tagIds.length > 0)
));
function workMatches(workId: number): boolean {
  return matchedWorkIds.value === null || matchedWorkIds.value.has(workId);
}

async function resetAuthorFilters(): Promise<void> {
  authorFilters.value = { conditions: [], authorIds: [] };
  matchedWorkIds.value = null;
  authorFilterOptions.value = null;
  const type = authorFilterType.value;
  if (!activeAuthor.value || !type) return;
  try {
    authorFilterOptions.value = await props.api.listFacetFilterOptions(type, activeAuthor.value.id);
  } catch {
    authorFilterOptions.value = null;
  }
}

async function onAuthorFiltersChange(filters: GalleryFacetFilters): Promise<void> {
  authorFilters.value = filters;
  page.value = 1;
  const activeConditions = filters.conditions.filter((condition) => condition.tagIds.length > 0);
  const type = authorFilterType.value;
  const authorId = activeAuthor.value?.id;
  if (activeConditions.length === 0 || type === null || authorId === undefined) {
    matchedWorkIds.value = null;
    return;
  }
  try {
    const summaries = await props.api.filterEntriesByFacets(type, activeConditions, [authorId]);
    matchedWorkIds.value = new Set(summaries.map((summary) => summary.id));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('author.filterError');
    matchedWorkIds.value = null;
  }
}

watch(() => activeAuthor.value?.id, (id) => {
  if (id === undefined) {
    authorFilters.value = { conditions: [], authorIds: [] };
    matchedWorkIds.value = null;
    authorFilterOptions.value = null;
    return;
  }
  void resetAuthorFilters();
});

// Filtered view = one flat work list (loose works + Directory members,
// deduped by id); Directory rows are browsing structure only and dissolve
// while a filter is active.
const filterFlat = computed<boolean>(() => matchedWorkIds.value !== null);
const flatMatchedWorkCards = computed<WorkCard[]>(() => {
  if (!activeAuthor.value || matchedWorkIds.value === null) return [];
  const seen = new Set<number>();
  const works: WorkCard[] = [];
  for (const work of activeAuthor.value.looseEntries) {
    if (!workMatches(work.id) || seen.has(work.id)) continue;
    seen.add(work.id);
    works.push({ kind: 'work' as const, work });
  }
  for (const directory of activeAuthor.value.directories) {
    for (const work of directory.entries) {
      if (!workMatches(work.id) || seen.has(work.id)) continue;
      seen.add(work.id);
      works.push({ kind: 'work' as const, work });
    }
  }
  return works.sort(compareAuthorCards);
});
const displayCards = computed<WorkCard[]>(() => (
  filterFlat.value ? flatMatchedWorkCards.value : workCards.value
));
const hasAnyCards = computed(() => (
  displayCards.value.length > 0 || (!filterFlat.value && directoryCards.value.length > 0)
));
const pageCount = computed(() => Math.max(1, Math.ceil(displayCards.value.length / pageSize)));
const visibleWorkCards = computed<WorkCard[]>(() => (
  displayCards.value.slice((page.value - 1) * pageSize, page.value * pageSize)
));
const authorCoverCovers = computed<string[]>(() => {
  if (!activeAuthor.value) return [];
  const works: Array<{ coverRef: string | null; id: number }> = [
    ...activeAuthor.value.looseEntries.map((work) => ({ coverRef: work.coverRef, id: work.id })),
    ...activeAuthor.value.directories.flatMap((directory) => directory.entries.map((entry) => ({
      coverRef: entry.coverRef,
      id: entry.id,
    }))),
  ];
  return works
    .filter((work) => !!work.coverRef)
    .sort((a, b) => a.id - b.id)
    .slice(0, 4)
    .map((work) => work.coverRef as string);
});

// Other-language spellings of an author's name (e.g. "bob" under "鲍勃"),
// derived from the 'producer'-vocabulary taxonomy dictionary. Shown as a
// faded sub-line under the display name on author cards.
const authorAlternates = ref<Map<string, string[]>>(new Map());

function alternatesFor(name: string): string {
  return (authorAlternates.value.get(normalizeTag(name)) ?? []).join(' / ');
}

async function loadAuthorAlternates(): Promise<void> {
  try {
    const aliases = await props.api.listTaxonomyAliases('producer');
    const map = new Map<string, string[]>();
    for (const alias of aliases) {
      // Placeholder rows (imported name, canonical not filled yet) carry no
      // canonical and must not appear under any author's alternates.
      if (alias.normalizedCanonical === '') continue;
      const key = alias.normalizedCanonical;
      const names = map.get(key) ?? [];
      if (!names.includes(alias.alias)) names.push(alias.alias);
      map.set(key, names);
    }
    authorAlternates.value = map;
  } catch {
    authorAlternates.value = new Map();
  }
}

async function refreshAuthor(): Promise<void> {
  if (!activeAuthor.value) return;
  activeAuthor.value = await props.api.getAuthor(activeAuthor.value.id);
  if (page.value > pageCount.value) page.value = pageCount.value;
}

async function openAuthor(authorId: number): Promise<void> {
  error.value = null;
  try {
    activeAuthor.value = await props.api.getAuthor(authorId);
    activeDirectoryId.value = null;
    editingAuthor.value = false;
    page.value = 1;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadAuthor');
  }
}

function openWork(work: AuthorWork): void {
  if (!activeAuthor.value) return;
  emit('open-entry', {
    work,
    authorId: activeAuthor.value.id,
    authorName: activeAuthor.value.name,
    directoryId: activeDirectoryId.value,
    directoryName: activeDirectory.value?.title ?? null,
  });
}

onMounted(async () => {
  await loadAuthorAlternates();
  if (props.initialAuthorId) {
    await openAuthor(props.initialAuthorId);
    if (props.initialDirectoryId) activeDirectoryId.value = props.initialDirectoryId;
  }
});

function closeAuthor(): void {
  if (props.backLabel) {
    emit('back');
    return;
  }
  activeAuthor.value = null;
  activeDirectoryId.value = null;
  editingAuthor.value = false;
  editingDirectory.value = false;
}

function beginAuthorEdit(): void {
  if (!activeAuthor.value) return;
  authorName.value = activeAuthor.value.name;
  authorOccupation.value = activeAuthor.value.occupation ?? '';
  authorArtwork.value = activeAuthor.value.artworkRef ?? '';
  authorContent.value = activeAuthor.value.content ?? '';
  editingAuthor.value = true;
}

async function saveAuthor(): Promise<void> {
  if (!activeAuthor.value) return;
  error.value = null;
  try {
    await props.api.updateAuthor(activeAuthor.value.id, {
      name: authorName.value,
      occupation: authorOccupation.value || null,
      artworkRef: authorArtwork.value || null,
      content: authorContent.value || null,
    });
    editingAuthor.value = false;
    await refreshAuthor();
    emit('authors-changed');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.updateAuthor');
  }
}

async function deleteActiveAuthor(): Promise<void> {
  if (!activeAuthor.value) return;
  if (!window.confirm(t('author.deleteConfirm', { name: activeAuthor.value.name }))) return;
  error.value = null;
  try {
    await props.api.deleteAuthor(activeAuthor.value.id);
    emit('authors-changed');
    closeAuthor();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.deleteAuthor');
  }
}

async function addTag(): Promise<void> {
  if (!activeAuthor.value || !tagName.value.trim()) return;
  error.value = null;
  try {
    await props.api.assignAuthorTag(activeAuthor.value.id, tagName.value);
    tagName.value = '';
    tagEditorOpen.value = false;
    await refreshAuthor();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.addAuthorTag');
  }
}

function beginTagRename(tag: AuthorDetailResponse['tags'][number]): void {
  if (!editingAuthor.value) return;
  editingTagId.value = tag.tagId;
  editingTagName.value = tag.name;
}

async function saveTagRename(tagId: number): Promise<void> {
  if (!activeAuthor.value || editingTagId.value !== tagId || !editingTagName.value.trim()) return;
  try {
    await props.api.renameAuthorTag(activeAuthor.value.id, tagId, editingTagName.value);
    editingTagId.value = null;
    editingTagName.value = '';
    await refreshAuthor();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.renameAuthorTag');
  }
}

async function removeTag(tagId: number): Promise<void> {
  if (!activeAuthor.value) return;
  try {
    await props.api.removeAuthorTag(activeAuthor.value.id, tagId);
    await refreshAuthor();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.removeAuthorTag');
  }
}

function nextDirectoryTitle(): string {
  const base = t('directory.defaultTitle');
  const titles = new Set(activeAuthor.value?.directories.map((directory) => directory.title) ?? []);
  if (!titles.has(base)) return base;
  let suffix = 2;
  while (titles.has(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}

async function createDirectory(entryIds?: number[]): Promise<void> {
  if (!activeAuthor.value) return;
  error.value = null;
  try {
    await props.api.createAuthorDirectory(activeAuthor.value.id, {
      title: nextDirectoryTitle(),
      ...(entryIds ? { entryIds } : {}),
    });
    draggedWorkId.value = null;
    await refreshAuthor();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createDirectory');
  }
}

function beginWorkDrag(workId: number): void {
  if (editingAuthor.value) draggedWorkId.value = workId;
}

function cardKey(card: AuthorCard): string {
  return `${card.kind}-${card.kind === 'work' ? card.work.id : card.directory.id}`;
}

function markDropTarget(card: AuthorCard): void {
  if (editingAuthor.value && draggedWorkId.value !== null) dropTarget.value = cardKey(card);
}

function clearDragState(): void {
  draggedWorkId.value = null;
  dropTarget.value = null;
}

async function mergeWithWork(targetWorkId: number): Promise<void> {
  const sourceWorkId = draggedWorkId.value;
  if (!editingAuthor.value || sourceWorkId === null || sourceWorkId === targetWorkId) return;
  dropTarget.value = null;
  await createDirectory([sourceWorkId, targetWorkId]);
}

async function moveToDirectory(directoryId: number): Promise<void> {
  if (!editingAuthor.value || !activeAuthor.value || draggedWorkId.value === null) return;
  const workId = draggedWorkId.value;
  clearDragState();
  try {
    await props.api.moveEntryToAuthorDirectory(activeAuthor.value.id, directoryId, workId);
    await refreshAuthor();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.moveToDirectory');
  }
}

function openDirectory(directory: AuthorDirectoryDto): void {
  activeDirectoryId.value = directory.id;
  editingDirectory.value = false;
}

function beginDirectoryEdit(): void {
  if (!activeDirectory.value) return;
  directoryTitle.value = activeDirectory.value.title;
  directoryDescription.value = activeDirectory.value.description;
  editingDirectory.value = true;
}

async function saveDirectory(): Promise<void> {
  if (!activeDirectory.value) return;
  try {
    await props.api.updateAuthorDirectory(activeDirectory.value.id, {
      title: directoryTitle.value,
      description: directoryDescription.value,
    });
    editingDirectory.value = false;
    await refreshAuthor();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.updateDirectory');
  }
}

async function removeFromDirectory(): Promise<void> {
  if (!activeAuthor.value || !activeDirectory.value || draggedWorkId.value === null) return;
  const workId = draggedWorkId.value;
  clearDragState();
  try {
    await props.api.removeEntryFromAuthorDirectory(
      activeAuthor.value.id,
      activeDirectory.value.id,
      workId,
    );
    await refreshAuthor();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.removeFromDirectory');
  }
}
</script>

<template>
  <section class="author-page" data-testid="author-page">
    <p v-if="error" class="author-error" role="alert">{{ error }}</p>

    <template v-if="activeDirectory && activeAuthor">
      <div class="author-toolbar">
        <button type="button" class="text-button" @click="activeDirectoryId = null">
          {{ t('directory.back', { author: activeAuthor.name }) }}
        </button>
        <button
          v-if="!editingDirectory"
          data-testid="start-directory-editing"
          type="button"
          class="secondary-button"
          @click="beginDirectoryEdit"
        >
          {{ t('directory.edit') }}
        </button>
        <div v-else class="directory-edit-actions">
          <button
            data-testid="finish-directory-editing"
            type="button"
            class="secondary-button"
            @click="saveDirectory"
          >
            {{ t('directory.done') }}
          </button>
          <button
            data-testid="directory-remove-target"
            type="button"
            class="directory-remove-target"
            :class="{ 'drop-target': draggedWorkId !== null }"
            @dragover.prevent
            @drop.prevent="removeFromDirectory"
          >
            {{ t('directory.removeWork') }}
          </button>
        </div>
      </div>
      <div
        v-if="editingDirectory"
        data-testid="directory-edit-form"
        class="author-edit-form"
      >
        <label>{{ t('directory.title') }}<input v-model="directoryTitle" name="directoryTitle" required></label>
        <label>{{ t('directory.description') }}<textarea v-model="directoryDescription" name="directoryDescription" rows="4" /></label>
      </div>
      <header v-else class="directory-heading">
        <h2>{{ activeDirectory.title }}</h2>
        <p>{{ activeDirectory.description }}</p>
      </header>
      <p v-if="activeDirectory.entries.length === 0" class="muted">{{ t('directory.empty') }}</p>
      <div v-else class="author-card-grid">
        <article
          v-for="work in activeDirectory.entries"
          :key="work.id"
          class="author-card"
          :data-directory-work-id="work.id"
          :draggable="editingDirectory"
          @dragstart="editingDirectory && (draggedWorkId = work.id)"
          @dragend="clearDragState"
        >
          <button type="button" class="author-card-main" @click="openWork(work)">
            <img v-if="work.coverRef" :src="api.assetUrl(work.coverRef)" :alt="work.title">
            <span v-else class="cover-placeholder">{{ work.title.slice(0, 1).toUpperCase() }}</span>
            <span class="author-card-meta"><strong>{{ work.title }}</strong><small>{{ work.type }}</small></span>
          </button>
        </article>
      </div>
    </template>

    <template v-else-if="activeAuthor">
      <section data-testid="author-information-board" class="author-information-board">
        <div class="author-toolbar">
          <button type="button" class="text-button" @click="closeAuthor">
            {{ props.backLabel ?? t('author.backToList') }}
          </button>
          <button
            v-if="!editingAuthor"
            data-testid="start-author-editing"
            type="button"
            class="secondary-button"
            @click="beginAuthorEdit"
          >
            {{ t('author.edit') }}
          </button>
          <button v-else type="button" class="secondary-button" @click="editingAuthor = false">
            {{ t('author.done') }}
          </button>
          <button
            v-if="editingAuthor"
            data-testid="delete-author"
            type="button"
            class="secondary-button danger-button"
            @click="deleteActiveAuthor"
          >
            {{ t('author.delete') }}
          </button>
        </div>
        <form v-if="editingAuthor" class="author-edit-form" @submit.prevent="saveAuthor">
          <label>{{ t('author.name') }}<input v-model="authorName" name="authorName" required></label>
          <label>{{ t('author.occupation') }}<input v-model="authorOccupation" name="authorOccupation"></label>
          <label>{{ t('author.artwork') }}<input v-model="authorArtwork" name="authorArtwork"></label>
          <label>{{ t('author.content') }}<textarea v-model="authorContent" name="authorContent" rows="5" /></label>
          <button type="submit" class="primary-button">{{ t('author.save') }}</button>
        </form>
        <div v-else class="author-basics">
          <template v-if="activeAuthor.artworkRef">
            <img :src="api.assetUrl(activeAuthor.artworkRef)" :alt="activeAuthor.name" class="author-artwork">
          </template>
          <div v-else-if="authorCoverCovers.length" class="author-artwork author-cover-grid" :aria-label="activeAuthor.name">
            <img v-for="coverRef in authorCoverCovers" :key="coverRef" :src="api.assetUrl(coverRef)" :alt="activeAuthor.name">
          </div>
          <div v-else class="author-artwork author-cover-placeholder">{{ activeAuthor.name.slice(0, 1).toUpperCase() }}</div>
          <div>
            <p class="eyebrow">{{ t('author.occupation') }}</p>
            <h2>
              {{ activeAuthor.name }}
              <span v-if="activeAuthor.galleryType" class="author-gallery-badge" data-testid="author-gallery-badge">
                {{ activeAuthor.galleryType }}
              </span>
            </h2>
            <p>{{ activeAuthor.occupation }}</p>
          </div>
        </div>

        <div class="author-row" data-testid="author-tag-row">
          <strong>{{ t('author.tags') }}</strong>
          <div class="tag-row">
            <span
              v-for="tag in activeAuthor.tags"
              :key="tag.tagId"
              class="author-tag"
              :data-author-tag-id="tag.tagId"
              @click="!editingAuthor && emit('open-tag', {
                tagId: tag.tagId,
                tagName: tag.name,
                authorId: activeAuthor.id,
                authorName: activeAuthor.name,
              })"
              @dblclick="beginTagRename(tag)"
            >
              <input
                v-if="editingTagId === tag.tagId"
                v-model="editingTagName"
                :data-rename-author-tag-id="tag.tagId"
                @keydown.enter.prevent="saveTagRename(tag.tagId)"
                @blur="saveTagRename(tag.tagId)"
              >
              <template v-else>{{ tag.name }}</template>
              <button v-if="editingAuthor" type="button" :aria-label="t('tag.remove', { name: tag.name })" @click="removeTag(tag.tagId)">×</button>
            </span>
            <button v-if="editingAuthor && !tagEditorOpen" type="button" class="add-button" @click="tagEditorOpen = true">{{ t('tag.add') }}</button>
            <form v-else-if="editingAuthor" class="compact-editor" @submit.prevent="addTag">
              <input v-model="tagName" name="authorTagName" required :placeholder="t('tag.namePlaceholder')" @blur="tagName.trim() && addTag()">
            </form>
          </div>
        </div>
        <div class="author-row author-content-row">
          <strong>{{ t('author.content') }}</strong>
          <p>{{ activeAuthor.content }}</p>
        </div>
      </section>

      <section class="author-works">
        <div class="works-heading">
          <h2>{{ t('author.works') }}</h2>
          <label class="sort-control">
            <span>{{ t('author.sortLabel') }}</span>
            <select v-model="authorSort" data-testid="author-sort">
              <option value="date-desc">{{ t('author.sortDateNewest') }}</option>
              <option value="date-asc">{{ t('author.sortDateOldest') }}</option>
              <option value="title-asc">{{ t('author.sortTitleAz') }}</option>
              <option value="title-desc">{{ t('author.sortTitleZa') }}</option>
              <option value="type">{{ t('author.sortType') }}</option>
            </select>
          </label>
          <button
            v-if="editingAuthor"
            data-testid="add-author-directory"
            type="button"
            class="add-button"
            @click="createDirectory()"
          >
            {{ t('directory.add') }}
          </button>
        </div>
        <div
          v-if="authorFilterOptions && authorFilterType
            && (authorFilterOptions.facets.length > 0 || authorFilterOptions.allTags.length > 0)"
          class="author-filter-wrap"
        >
          <FacetFilterBar
            :options="authorFilterOptions"
            :model-value="authorFilters"
            hide-authors
            @update:model-value="onAuthorFiltersChange"
          />
        </div>
        <p v-if="!hasAnyCards" class="muted">
          {{ filterActive && authorWorksList.length > 0
            ? t('author.noFilteredWorks')
            : t('author.emptyWorks') }}
        </p>
        <template v-else>
          <div
            v-if="directoryCards.length > 0 && !filterFlat"
            data-testid="author-directory-row"
            class="author-card-grid directory-row"
          >
            <article
              v-for="card in directoryCards"
              :key="cardKey(card)"
              data-author-card
              class="author-card"
              :class="{
                'directory-card': card.kind === 'directory',
                'drop-target': dropTarget === cardKey(card),
              }"
              :data-author-directory-id="card.directory.id"
              :draggable="false"
              @dragenter.prevent="markDropTarget(card)"
              @dragleave="dropTarget === cardKey(card) && (dropTarget = null)"
              @dragover.prevent
              @drop.prevent="moveToDirectory(card.directory.id)"
            >
              <button
                data-directory-open
                type="button"
                class="author-card-main"
                @click="openDirectory(card.directory)"
              >
                <span class="directory-cover">
                  <template v-for="work in card.directory.entries.slice(0, 3)" :key="work.id">
                    <img v-if="work.coverRef" :src="api.assetUrl(work.coverRef)" :alt="work.title">
                    <span v-else class="mini-placeholder">{{ work.title.slice(0, 1) }}</span>
                  </template>
                </span>
                <span class="author-card-meta"><strong>{{ card.directory.title }}</strong><small>{{ card.directory.entries.length }} {{ t('author.works') }}</small></span>
              </button>
            </article>
          </div>
          <div v-if="visibleWorkCards.length > 0" class="author-card-grid">
            <article
              v-for="card in visibleWorkCards"
              :key="cardKey(card)"
              data-author-card
              class="author-card"
              :class="{
                'drop-target': dropTarget === cardKey(card),
              }"
              :data-author-work-id="card.work.id"
              :draggable="editingAuthor && !filterFlat"
              @dragstart="beginWorkDrag(card.work.id)"
              @dragend="clearDragState"
              @dragenter.prevent="markDropTarget(card)"
              @dragleave="dropTarget === cardKey(card) && (dropTarget = null)"
              @dragover.prevent
              @drop.prevent="mergeWithWork(card.work.id)"
            >
              <button type="button" class="author-card-main" @click="openWork(card.work)">
                <img v-if="card.work.coverRef" :src="api.assetUrl(card.work.coverRef)" :alt="card.work.title">
                <span v-else class="cover-placeholder">{{ card.work.title.slice(0, 1).toUpperCase() }}</span>
                <span class="author-card-meta"><strong>{{ card.work.title }}</strong><small>{{ card.work.type }}</small></span>
              </button>
            </article>
          </div>
        </template>
        <nav v-if="pageCount > 1" class="pagination">
          <button type="button" :disabled="page === 1" @click="page -= 1">{{ t('author.previousPage') }}</button>
          <span>{{ t('author.page', { page, pages: pageCount }) }}</span>
          <button data-testid="author-next-page" type="button" :disabled="page === pageCount" @click="page += 1">{{ t('author.nextPage') }}</button>
        </nav>
      </section>
    </template>

    <template v-else>
      <header class="author-list-heading"><p class="eyebrow">{{ t('author.navigation') }}</p><h2>{{ t('author.title') }}</h2><p>{{ t('author.subtitle') }}</p></header>
      <div class="author-list">
        <button v-for="author in authors" :key="author.id" type="button" class="author-list-card" :data-author-id="author.id" @click="openAuthor(author.id)">
          <span v-if="author.covers.length" class="author-list-cover">
            <img v-for="coverRef in author.covers" :key="coverRef" :src="api.assetUrl(coverRef)" :alt="author.name">
          </span>
          <span v-else class="author-list-badge">{{ author.name.slice(0, 1).toUpperCase() }}</span>
          <strong>{{ author.name }}</strong>
          <small v-if="author.galleryType" class="author-gallery-badge" data-testid="author-list-gallery">
            {{ author.galleryType }}
          </small>
          <small v-if="alternatesFor(author.name)" class="author-name-alternates">
            {{ alternatesFor(author.name) }}
          </small>
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.author-page { display: grid; gap: 1rem; }
.author-toolbar, .works-heading, .pagination { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.directory-edit-actions { display: grid; justify-items: stretch; gap: 0.35rem; }
.directory-remove-target { padding: 0.35rem 0.6rem; border: 1px dashed #b84a4a; border-radius: 0.5rem; color: #a12626; background: transparent; font: inherit; cursor: pointer; transition: transform 140ms ease, background 140ms ease; }
.directory-remove-target.drop-target { transform: scale(1.04); background: color-mix(in srgb, #b84a4a 14%, transparent); }
.text-button { padding: 0; border: 0; color: var(--accent); background: transparent; font: inherit; cursor: pointer; }
.secondary-button, .primary-button, .add-button, .pagination button { padding: 0.45rem 0.7rem; border: 1px solid var(--border-subtle); border-radius: 0.55rem; color: var(--text-primary); background: var(--surface); font: inherit; cursor: pointer; }
.danger-button { border-color: #a12626; color: #a12626; }
.primary-button { color: white; border-color: var(--accent); background: var(--accent); }
.add-button { border-style: dashed; color: var(--text-muted); background: transparent; }
.author-information-board { overflow: hidden; border: 1px solid var(--border-subtle); border-radius: 0.9rem; background: var(--surface-muted); }
.author-information-board > * { margin: 0; padding: 1rem; }
.author-information-board > * + * { border-top: 1px solid var(--border-subtle); }
.author-basics { display: flex; align-items: center; gap: 1rem; }
.author-basics h2 { margin: 0; font-size: clamp(1.6rem, 4vw, 2.4rem); }
.author-basics p { margin: 0.25rem 0 0; color: var(--text-muted); }
.author-artwork { width: 7rem; height: 7rem; border-radius: 0.8rem; object-fit: cover; }
.author-cover-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.15rem; padding: 0; overflow: hidden; background: var(--tag-background); }
.author-cover-grid img { width: 100%; height: 100%; object-fit: cover; border-radius: 0.15rem; min-width: 0; }
.author-cover-placeholder { display: grid; place-items: center; color: var(--tag-text); background: var(--tag-background); font-size: 2rem; font-weight: 850; }
.sort-control { display: flex; align-items: center; gap: 0.4rem; margin-left: auto; color: var(--text-muted); font-size: 0.85rem; }
.sort-control select { font: inherit; }
.author-row { display: grid; grid-template-columns: 7rem minmax(0, 1fr); align-items: start; gap: 1rem; }
.author-row > strong { font-size: 0.8rem; }
.author-content-row p { margin: 0; white-space: pre-wrap; }
.tag-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.author-tag { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.35rem 0.6rem; border: 1px solid var(--tag-border); border-radius: 999px; color: var(--tag-text); background: var(--tag-background); font-size: 0.78rem; }
.author-tag button { border: 0; color: inherit; background: transparent; cursor: pointer; }
.author-edit-form { display: grid; gap: 0.8rem; }
.author-edit-form label { display: grid; gap: 0.35rem; color: var(--text-muted); font-size: 0.8rem; font-weight: 700; }
.author-edit-form input, .author-edit-form textarea, .compact-editor input { padding: 0.6rem; border: 1px solid var(--border-subtle); border-radius: 0.55rem; color: var(--text-primary); background: var(--surface); font: inherit; }
.author-works { display: grid; gap: 0.85rem; margin-top: 0.5rem; }
.works-heading h2 { margin: 0; }
.author-card-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 0.8rem; }
.directory-row {
  padding-bottom: 0.9rem;
  margin-bottom: 0.4rem;
  border-bottom: 1px dashed var(--border-subtle);
}
@media (max-width: 52rem) {
  .author-card-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 30rem) {
  .author-card-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
.author-card { overflow: hidden; border: 1px solid var(--border-subtle); border-radius: 0.8rem; background: var(--surface-muted); transition: transform 140ms ease, border-color 140ms ease; }
.author-card[draggable='true'] { cursor: grab; }
.author-card:hover, .author-card:focus-within { border-color: var(--accent); transform: translateY(-1px); }
.author-card.drop-target { z-index: 1; border-color: var(--accent); transform: scale(1.045); box-shadow: 0 0 0 0.3rem color-mix(in srgb, var(--accent) 18%, transparent); }
.author-card-main { display: block; width: 100%; padding: 0; border: 0; color: var(--text-primary); background: transparent; font: inherit; text-align: left; cursor: pointer; }
.author-card-main > img, .cover-placeholder, .directory-cover { width: 100%; height: 8rem; }
.author-card-main > img { display: block; object-fit: contain; }
.cover-placeholder { display: grid; place-items: center; color: var(--tag-text); background: var(--tag-background); font-size: 2rem; font-weight: 850; }
.author-card-meta { display: grid; gap: 0.25rem; padding: 0.8rem; }
.author-card-meta small { color: var(--text-muted); }
.directory-cover { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.2rem; padding: 0.45rem; background: color-mix(in srgb, var(--tag-background) 65%, var(--surface)); }
.directory-cover img, .mini-placeholder { width: 100%; height: 100%; min-width: 0; object-fit: cover; border-radius: 0.35rem; }
.mini-placeholder { display: grid; place-items: center; color: var(--tag-text); background: var(--surface); }
.author-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr)); gap: 0.8rem; }
.author-list-card { display: grid; gap: 0.45rem; padding: 0.6rem; border: 1px solid var(--border-subtle); border-radius: 0.8rem; color: var(--text-primary); background: var(--surface-muted); font: inherit; text-align: left; cursor: pointer; align-content: start; }
.author-list-cover { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.15rem; width: 100%; aspect-ratio: 3 / 4; overflow: hidden; border-radius: 0.5rem; background: var(--tag-background); }
.author-list-cover img { width: 100%; height: 100%; object-fit: cover; min-width: 0; }
.author-list-badge { display: grid; place-items: center; width: 100%; aspect-ratio: 3 / 4; border-radius: 0.5rem; color: var(--tag-text); background: var(--tag-background); font-size: 2rem; font-weight: 850; }
.author-list-card > strong { font-size: 0.82rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.author-name-alternates { font-size: 0.66rem; font-weight: 400; color: var(--text-muted); opacity: 0.72; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.directory-heading p, .author-list-heading p, .muted { color: var(--text-muted); }
.pagination { justify-content: center; }
.pagination button:disabled { cursor: default; opacity: 0.4; }
.author-error { padding: 0.75rem; border-radius: 0.6rem; color: #a12626; background: #fff0f0; }
.author-filter-wrap { margin-bottom: 0.35rem; }
.author-gallery-badge {
  display: inline-block;
  padding: 0.12rem 0.5rem;
  border-radius: 999px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  font-size: 0.68rem;
  font-weight: 700;
  vertical-align: middle;
}
.author-basics h2 .author-gallery-badge { margin-left: 0.4rem; }
.author-list-card > .author-gallery-badge { justify-self: start; }
.eyebrow { margin-bottom: 0.35rem; color: var(--accent); font-size: 0.72rem; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }
@media (max-width: 38rem) { .author-row { grid-template-columns: 1fr; gap: 0.4rem; } }
</style>
