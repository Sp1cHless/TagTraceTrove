<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { CollectionKind, CollectionRecordDto } from '@t3/shared';
import type { GalleryApi } from './api/gallery.js';
import { showNsfw } from './stores/preferences.js';
import EntryCard from './components/EntryCard.vue';
import IconButton from './components/IconButton.vue';
import PagedCardGrid from './components/PagedCardGrid.vue';
import { useI18n } from './i18n.js';
import { useNavigationMemory } from './navigation-memory.js';

const props = defineProps<{
  api: GalleryApi;
}>();

const emit = defineEmits<{
  back: [];
  'open-entry': [entryId: number];
  'open-author': [authorId: number];
}>();

const { t } = useI18n();
const navigationMemory = useNavigationMemory();
const savedState = navigationMemory.states.get('collections') as {
  kind?: CollectionKind;
  activeCollectionId?: number | null;
  returnScrollPositions?: number[];
} | undefined;

const kind = ref<CollectionKind>(savedState?.kind ?? 'entry');
const collections = ref<CollectionRecordDto[]>([]);
const activeCollectionId = ref<number | null>(savedState?.activeCollectionId ?? null);
const editing = ref(false);
const loading = ref(true);
const error = ref<string | null>(null);
const newTitle = ref('');
const hiddenEntryTypes = ref<Set<string>>(new Set());
const hiddenProducerIds = ref<Set<number>>(new Set());
const returnScrollPositions: number[] = [...(savedState?.returnScrollPositions ?? [])];

function rememberCollectionNavigationState(): void {
  navigationMemory.states.set('collections', {
    kind: kind.value,
    activeCollectionId: activeCollectionId.value,
    returnScrollPositions: [...returnScrollPositions],
  });
}

watch([kind, activeCollectionId], ([currentKind, collectionId]) => {
  navigationMemory.states.set('collections', {
    kind: currentKind,
    activeCollectionId: collectionId,
    returnScrollPositions: [...returnScrollPositions],
  });
});

async function scrollCurrentViewToTop(): Promise<void> {
  await nextTick();
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
}

async function restorePreviousScroll(): Promise<void> {
  const top = returnScrollPositions.pop() ?? 0;
  rememberCollectionNavigationState();
  await nextTick();
  window.scrollTo({ top, left: 0, behavior: 'auto' });
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const [records, galleries, authors] = await Promise.all([
      props.api.listCollections(kind.value),
      props.api.listGalleries(),
      kind.value === 'producer' ? props.api.listAuthors() : Promise.resolve([]),
    ]);
    collections.value = records;
    hiddenEntryTypes.value = new Set(
      galleries.filter((gallery) => gallery.nsfw).map((gallery) => gallery.type),
    );
    hiddenProducerIds.value = new Set(
      authors.filter((author) => author.nsfw).map((author) => author.id),
    );
    if (!findCollection(collections.value, activeCollectionId.value ?? 0)) {
      activeCollectionId.value = null;
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadEntry');
  } finally {
    loading.value = false;
  }
}

function switchKind(next: CollectionKind): void {
  if (kind.value === next) return;
  kind.value = next;
  activeCollectionId.value = null;
  editing.value = false;
  clearDrag();
  void load();
}

function findCollection(
  records: CollectionRecordDto[],
  id: number,
): CollectionRecordDto | null {
  for (const record of records) {
    if (record.id === id) return record;
    const nested = findCollection(record.children, id);
    if (nested !== null) return nested;
  }
  return null;
}

function parentOf(
  records: CollectionRecordDto[],
  id: number,
): CollectionRecordDto | null {
  for (const record of records) {
    if (record.children.some((child) => child.id === id)) return record;
    const nested = parentOf(record.children, id);
    if (nested !== null) return nested;
  }
  return null;
}

const activeCollection = computed(() => (
  findCollection(collections.value, activeCollectionId.value ?? 0)
));

// Back from a child folder returns to its parent folder, not the list.
async function closeCollection(): Promise<void> {
  const parent = parentOf(collections.value, activeCollectionId.value ?? 0);
  activeCollectionId.value = parent?.id ?? null;
  editing.value = false;
  clearDrag();
  await restorePreviousScroll();
}

async function goBack(): Promise<void> {
  if (activeCollection.value) await closeCollection();
  else emit('back');
}

defineExpose({ goBack });

function coversOf(record: CollectionRecordDto): string[] {
  const covers: string[] = [];
  for (const entry of visibleEntriesOf(record)) {
    if (entry.coverRef) covers.push(entry.coverRef);
    if (covers.length >= 3) return covers;
  }
  for (const producer of visibleProducersOf(record)) {
    covers.push(...producer.covers.slice(0, 3 - covers.length));
    if (covers.length >= 3) return covers;
  }
  return covers;
}

const visibleCollections = computed(() => (
  collections.value.filter((record) => showNsfw.value || !record.nsfw)
));

const visibleCollectionIds = computed(() => {
  const ids = new Set<number>();
  const visit = (records: CollectionRecordDto[]): void => {
    for (const record of records) {
      if (!showNsfw.value && record.nsfw) continue;
      ids.add(record.id);
      visit(record.children);
    }
  };
  visit(collections.value);
  return ids;
});

watch([showNsfw, collections], () => {
  if (activeCollectionId.value !== null && !visibleCollectionIds.value.has(activeCollectionId.value)) {
    activeCollectionId.value = null;
    editing.value = false;
  }
});

function visibleEntriesOf(record: CollectionRecordDto): CollectionRecordDto['entries'] {
  return record.entries.filter((entry) => (
    showNsfw.value || !hiddenEntryTypes.value.has(entry.type)
  ));
}

function visibleProducersOf(record: CollectionRecordDto): CollectionRecordDto['producers'] {
  return record.producers.filter((producer) => (
    showNsfw.value || !hiddenProducerIds.value.has(producer.id)
  ));
}

async function createCollection(): Promise<void> {
  const title = newTitle.value.trim();
  if (title === '') return;
  error.value = null;
  try {
    const created = await props.api.createCollection({ kind: kind.value, title });
    newTitle.value = '';
    await load();
    activeCollectionId.value = created.id;
    syncEditFields();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createEntry');
  }
}

// One nested level of folders inside an entry collection (e.g. a whole
// series in one place). The schema shapes exactly this: only entry
// collections may have a parent.
const newSubTitle = ref('');

async function createSubCollection(): Promise<void> {
  const title = newSubTitle.value.trim();
  if (title === '' || activeCollection.value === null) return;
  error.value = null;
  try {
    await props.api.createCollection({
      kind: 'entry',
      title,
      parentId: activeCollection.value.id,
    });
    newSubTitle.value = '';
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createEntry');
  }
}

const visibleChildren = computed(() => (
  (activeCollection.value?.children ?? []).filter((record) => showNsfw.value || !record.nsfw)
));

// Child folders never offer another level of nesting — exactly one level deep.
const isChildCollection = computed(() => (
  parentOf(collections.value, activeCollectionId.value ?? 0) !== null
));

// Directory-style drag: inside a folder's edit mode, a member work dropped on
// a child folder moves into it; a child work dropped on the parent target
// moves back out. Same interaction the Author page uses for its Directories.
const draggedEntryId = ref<number | null>(null);
const childDropTargetId = ref<number | null>(null);
const parentDropActive = ref(false);

function beginEntryDrag(entryId: number): void {
  if (editing.value) draggedEntryId.value = entryId;
}

function clearDrag(): void {
  draggedEntryId.value = null;
  childDropTargetId.value = null;
  parentDropActive.value = false;
}

function beginEditing(): void {
  clearDrag();
  editing.value = true;
  beginCollectionEdit();
}

function finishEditing(): void {
  editing.value = false;
  clearDrag();
}

function toggleEntrySelection(entryId: number): void {
  if (!editing.value) return;
  draggedEntryId.value = draggedEntryId.value === entryId ? null : entryId;
}

function openOrSelectEntry(entryId: number): void {
  if (editing.value) {
    toggleEntrySelection(entryId);
    return;
  }
  rememberCollectionNavigationState();
  emit('open-entry', entryId);
}

async function moveEntryToCollection(targetId: number): Promise<void> {
  const entryId = draggedEntryId.value;
  const active = activeCollection.value;
  clearDrag();
  if (entryId === null || active === null || targetId === active.id) return;
  error.value = null;
  try {
    await props.api.removeCollectionEntry(active.id, entryId);
    await props.api.addCollectionEntry(targetId, entryId);
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createEntry');
  }
}

async function removeEntryFromActiveCollection(entryId: number): Promise<void> {
  const active = activeCollection.value;
  if (active === null) return;
  if (draggedEntryId.value === entryId) clearDrag();
  error.value = null;
  try {
    await props.api.removeCollectionEntry(active.id, entryId);
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createEntry');
  }
}

async function removeCollection(record: CollectionRecordDto): Promise<void> {
  error.value = null;
  try {
    await props.api.deleteCollection(record.id);
    if (activeCollectionId.value === record.id) activeCollectionId.value = null;
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createEntry');
  }
}

// Drag to reorder top-level folders (same interaction as the tab strips).
const draggedId = ref<number | null>(null);
const dropTargetId = ref<number | null>(null);

function onDragStart(record: CollectionRecordDto): void {
  if (editing.value) draggedId.value = record.id;
}

function onDragOver(record: CollectionRecordDto): void {
  if (draggedId.value !== null) dropTargetId.value = record.id;
}

async function onDrop(record: CollectionRecordDto): Promise<void> {
  const dragged = draggedId.value;
  draggedId.value = null;
  dropTargetId.value = null;
  if (!dragged || dragged === record.id) return;
  const current = collections.value.map((item) => item.id);
  const from = current.indexOf(dragged);
  const to = current.indexOf(record.id);
  if (from < 0 || to < 0) return;
  current.splice(to, 0, ...current.splice(from, 1));
  try {
    await props.api.reorderCollections(kind.value, current);
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createEntry');
  }
}

function canMoveCollection(recordId: number, direction: -1 | 1): boolean {
  const index = visibleCollections.value.findIndex((record) => record.id === recordId);
  return index >= 0 && index + direction >= 0 && index + direction < visibleCollections.value.length;
}

async function moveCollection(recordId: number, direction: -1 | 1): Promise<void> {
  const visibleIndex = visibleCollections.value.findIndex((record) => record.id === recordId);
  const target = visibleCollections.value[visibleIndex + direction];
  if (visibleIndex < 0 || !target) return;

  const orderedIds = collections.value.map((record) => record.id);
  const from = orderedIds.indexOf(recordId);
  const to = orderedIds.indexOf(target.id);
  if (from < 0 || to < 0) return;
  orderedIds.splice(to, 0, ...orderedIds.splice(from, 1));
  try {
    await props.api.reorderCollections(kind.value, orderedIds);
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createEntry');
  }
}

async function openRecord(record: CollectionRecordDto): Promise<void> {
  returnScrollPositions.push(Math.max(0, window.scrollY));
  activeCollectionId.value = record.id;
  rememberCollectionNavigationState();
  editing.value = false;
  clearDrag();
  syncEditFields();
  await scrollCurrentViewToTop();
}

function syncEditFields(): void {
  if (activeCollection.value) {
    editTitle.value = activeCollection.value.title;
    editDescription.value = activeCollection.value.description;
  }
}

// Inside one collection: inline title/description editing in edit mode.
const editTitle = ref('');
const editDescription = ref('');

function beginCollectionEdit(): void {
  if (!activeCollection.value) return;
  editTitle.value = activeCollection.value.title;
  editDescription.value = activeCollection.value.description;
}

const editingActive = computed(() => editing.value && activeCollection.value !== null);

async function saveCollectionEdit(): Promise<void> {
  if (!activeCollection.value) return;
  error.value = null;
  try {
    await props.api.updateCollection(activeCollection.value.id, {
      title: editTitle.value,
      description: editDescription.value,
    });
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createEntry');
  }
}

async function toggleNsfw(): Promise<void> {
  if (!activeCollection.value) return;
  try {
    await props.api.setCollectionNsfw(activeCollection.value.id, !activeCollection.value.nsfw);
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createEntry');
  }
}

function usageTotals(record: CollectionRecordDto): string {
  // Derived from the members, consistent with the author pages: views and
  // likes are sums, the last view is the members' most recent one.
  const views = record.entries.length + record.producers.length;
  return t('usage.viewCount', { count: views });
}

onMounted(load);
</script>

<template>
  <section data-testid="collections-page" class="recent-page">
    <header class="recent-toolbar">
      <h2>{{ t('collections.title') }}</h2>
      <IconButton
        v-if="!editing"
        data-testid="collections-edit-toggle"
        icon="edit"
        :label="t('entry.edit')"
        @click="beginEditing"
      />
      <button
        v-else
        data-testid="collections-edit-toggle"
        class="secondary-button"
        type="button"
        @click="finishEditing"
      >
        {{ t('entry.done') }}
      </button>
    </header>

    <div class="recent-tab-shell">
      <div class="recent-tabs" data-testid="collections-kind-tabs" role="tablist">
      <button
        type="button"
        class="recent-tab"
        :class="{ 'recent-tab-active': kind === 'entry' }"
        data-testid="collections-kind-entry"
        @click="switchKind('entry')"
      >{{ t('collections.worksTab') }}</button>
      <button
        type="button"
        class="recent-tab"
        :class="{ 'recent-tab-active': kind === 'producer' }"
        data-testid="collections-kind-producer"
        @click="switchKind('producer')"
      >{{ t('collections.authorsTab') }}</button>
      </div>

      <div class="recent-tab-panel" data-testid="collections-panel" role="tabpanel">
        <p v-if="error" class="error-message" role="alert">{{ error }}</p>
    <p v-else-if="loading" class="muted">{{ t('import.preparing') }}</p>

    <template v-else-if="activeCollection">
        <div class="collection-detail" data-testid="collection-detail">
          <div class="collection-detail-head">
            <button class="back-button" type="button" @click="closeCollection">
              {{ t('collections.backToList') }}
            </button>
          <button
            data-testid="collection-nsfw-toggle"
            class="secondary-button"
            type="button"
            @click="toggleNsfw"
          >
            {{ activeCollection.nsfw ? t('gallery.nsfwBadge') : t('gallery.sfwBadge') }}
          </button>
        </div>
        <template v-if="editingActive">
          <label class="collection-edit-row">
            {{ t('collections.nameLabel') }}
            <input v-model="editTitle" name="collectionTitle" required>
          </label>
          <label class="collection-edit-row">
            {{ t('collections.descriptionLabel') }}
            <textarea v-model="editDescription" name="collectionDescription" rows="3" />
          </label>
          <button class="primary-button compact-submit" type="button" @click="saveCollectionEdit">
            {{ t('author.save') }}
          </button>
        </template>
        <template v-else>
          <h3>{{ activeCollection.title }}</h3>
          <p v-if="activeCollection.description" class="collection-description">
            {{ activeCollection.description }}
          </p>
        </template>

        <p
          v-if="editing && activeCollection.kind === 'entry' && (isChildCollection || visibleChildren.length > 0)"
          class="collection-organize-hint"
          data-testid="collection-organize-hint"
        >
          {{ t('collections.organizeHint') }}
        </p>

        <button
          v-if="editing && isChildCollection && draggedEntryId !== null"
          type="button"
          class="move-to-parent-target"
          data-testid="move-entry-to-parent"
          :class="{ 'drop-active': parentDropActive }"
          @dragover.prevent="draggedEntryId !== null && (parentDropActive = true)"
          @dragleave="parentDropActive = false"
          @drop.prevent="moveEntryToCollection(parentOf(collections, activeCollectionId ?? 0)!.id)"
          @click="moveEntryToCollection(parentOf(collections, activeCollectionId ?? 0)!.id)"
        >
          {{ t('collections.moveOut') }}
        </button>

        <div v-if="editing && activeCollection.kind === 'entry' && !isChildCollection" class="collection-create-row">
          <input
            v-model="newSubTitle"
            name="newSubCollectionTitle"
            data-testid="new-sub-collection-title"
            :placeholder="t('collections.subNamePlaceholder')"
            @keydown.enter.prevent="createSubCollection"
          >
          <button class="add-button" type="button" data-testid="create-sub-collection" @click="createSubCollection">
            + {{ t('collections.newSub') }}
          </button>
        </div>
        <PagedCardGrid
          v-if="visibleChildren.length > 0"
          :items="visibleChildren"
          :page-key="`collections:${kind}:${activeCollectionId}:children`"
          grid-class="recent-grid"
          grid-testid="collection-children"
          v-slot="{ items }"
        >
          <article
            v-for="child in items"
            :key="child.id"
            class="entry-card collection-card"
            :class="{ 'recent-tab-drop': childDropTargetId === child.id }"
            @dragover.prevent="draggedEntryId !== null && (childDropTargetId = child.id)"
            @dragleave="childDropTargetId === child.id && (childDropTargetId = null)"
            @drop.prevent="moveEntryToCollection(child.id)"
          >
            <button type="button" class="entry-card-main" :data-collection-id="child.id" @click="openRecord(child)">
              <span class="directory-cover">
                <template v-for="coverRef in coversOf(child).slice(0, 3)" :key="coverRef">
                  <img :src="api.assetUrl(coverRef)" :alt="child.title" loading="lazy" decoding="async">
                </template>
                <span
                  v-for="slot in Math.max(0, 3 - coversOf(child).length)"
                  :key="'slot-' + slot"
                  class="mini-placeholder"
                  aria-hidden="true"
                />
              </span>
              <span class="entry-meta">
                <strong>{{ child.title }}<span v-if="child.nsfw" class="collection-nsfw-mark"> 🔞</span></strong>
                <small class="entry-usage-note">
                  {{ t('collections.entryCount', { count: visibleEntriesOf(child).length }) }}
                </small>
              </span>
            </button>
            <button
              v-if="editing && draggedEntryId !== null"
              type="button"
              class="collection-move-target"
              :data-move-to-collection-id="child.id"
              @click.stop="moveEntryToCollection(child.id)"
            >
              {{ t('collections.moveHere') }}
            </button>
            <button
              v-if="editing"
              type="button"
              class="view-later-remove"
              :data-testid="'delete-sub-collection-' + child.id"
              :aria-label="t('collections.delete')"
              @click.stop="removeCollection(child)"
            >×</button>
          </article>
        </PagedCardGrid>

        <PagedCardGrid
          v-if="visibleEntriesOf(activeCollection).length > 0"
          :items="visibleEntriesOf(activeCollection)"
          :page-key="`collections:${kind}:${activeCollectionId}:entries`"
          grid-class="recent-grid recent-grid-compact"
          v-slot="{ items }"
        >
          <EntryCard
            v-for="entry in items"
            :key="entry.id"
            :api="api"
            :entry="entry"
            :draggable="editing ? 'true' : undefined"
            :class="{ 'collection-entry-selected': editing && draggedEntryId === entry.id }"
            :data-collection-entry-id="entry.id"
            :aria-pressed="editing ? draggedEntryId === entry.id : undefined"
            data-testid="collection-entry-card"
            @open="openOrSelectEntry(entry.id)"
            @dragstart="beginEntryDrag(entry.id)"
            @dragend="clearDrag"
          >
            <template #corner>
              <button
                v-if="editing"
                type="button"
                class="view-later-remove"
                :data-remove-collection-entry-id="entry.id"
                :aria-label="t('collections.removeMember')"
                @click.stop="removeEntryFromActiveCollection(entry.id)"
              >×</button>
            </template>
          </EntryCard>
        </PagedCardGrid>
        <div v-if="visibleProducersOf(activeCollection).length > 0" class="author-list">
          <button
            v-for="producer in visibleProducersOf(activeCollection)"
            :key="producer.id"
            type="button"
            class="author-list-card"
            :data-author-id="producer.id"
            @click="emit('open-author', producer.id)"
          >
            <span v-if="producer.covers.length" class="author-list-cover">
              <img v-for="coverRef in producer.covers" :key="coverRef" :src="api.assetUrl(coverRef)" :alt="producer.name" loading="lazy" decoding="async">
            </span>
            <span v-else class="author-list-badge">{{ producer.name.slice(0, 1).toUpperCase() }}</span>
            <strong>{{ producer.name }}</strong>
          </button>
        </div>
      </div>
    </template>

    <template v-else>
      <div v-if="editing" class="collection-create-row">
        <input
          v-model="newTitle"
          name="newCollectionTitle"
          data-testid="new-collection-title"
          :placeholder="t('collections.namePlaceholder')"
          @keydown.enter.prevent="createCollection"
        >
        <button class="add-button" type="button" data-testid="create-collection" @click="createCollection">
          + {{ t('collections.new') }}
        </button>
      </div>
      <p v-if="visibleCollections.length === 0" class="muted">{{ t('collections.empty') }}</p>
      <PagedCardGrid v-else :items="visibleCollections" :page-key="`collections:${kind}:root`" grid-class="recent-grid" v-slot="{ items }">
        <article
          v-for="record in items"
          :key="record.id"
          class="entry-card collection-card"
          :class="{ 'recent-tab-drop': dropTargetId === record.id }"
          :draggable="editing ? 'true' : undefined"
          @dragstart="onDragStart(record)"
          @dragover.prevent="onDragOver(record)"
          @drop.prevent="onDrop(record)"
          @dragend="draggedId = null; dropTargetId = null"
        >
          <button type="button" class="entry-card-main" :data-collection-id="record.id" @click="openRecord(record)">
            <span class="directory-cover">
              <template v-for="coverRef in coversOf(record).slice(0, 3)" :key="coverRef">
                <img :src="api.assetUrl(coverRef)" :alt="record.title" loading="lazy" decoding="async">
              </template>
              <span
                v-for="slot in Math.max(0, 3 - coversOf(record).length)"
                :key="'slot-' + slot"
                class="mini-placeholder"
                aria-hidden="true"
              />
            </span>
            <span class="entry-meta">
              <strong>{{ record.title }}<span v-if="record.nsfw" class="collection-nsfw-mark"> 🔞</span></strong>
              <small class="entry-usage-note">
                {{ record.kind === 'entry'
                  ? t('collections.entryCount', { count: visibleEntriesOf(record).length })
                  : t('collections.authorCount', { count: visibleProducersOf(record).length }) }}
              </small>
            </span>
          </button>
          <div v-if="editing" class="collection-order-controls">
            <button
              type="button"
              class="collection-order-button"
              :data-testid="'move-collection-up-' + record.id"
              :aria-label="t('collections.moveUp', { name: record.title })"
              :disabled="!canMoveCollection(record.id, -1)"
              @click.stop="moveCollection(record.id, -1)"
            >↑</button>
            <button
              type="button"
              class="collection-order-button"
              :data-testid="'move-collection-down-' + record.id"
              :aria-label="t('collections.moveDown', { name: record.title })"
              :disabled="!canMoveCollection(record.id, 1)"
              @click.stop="moveCollection(record.id, 1)"
            >↓</button>
          </div>
          <button
            v-if="editing"
            type="button"
            class="view-later-remove"
            :data-testid="'delete-collection-' + record.id"
            :aria-label="t('collections.delete')"
            @click.stop="removeCollection(record)"
          >×</button>
        </article>
      </PagedCardGrid>
    </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.recent-grid-compact { grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr)); gap: 0.8rem; }
/* Folder covers mirror the author Directory card: three vertical strips in a
   fixed-height frame, not a 2x2 square grid. */
.directory-cover { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.2rem; width: 100%; height: 8rem; padding: 0.45rem; background: color-mix(in srgb, var(--tag-background) 65%, var(--surface)); }
.directory-cover img { width: 100%; height: 100%; min-width: 0; object-fit: cover; border-radius: 0.35rem; }
.mini-placeholder { display: grid; place-items: center; width: 100%; height: 100%; min-width: 0; border-radius: 0.35rem; color: var(--tag-text); background: var(--surface); }
.collection-nsfw-mark { font-size: 0.8rem; }
.recent-page { display: grid; gap: 1rem; }
.recent-toolbar { display: flex; align-items: center; gap: 1rem; }
.recent-toolbar h2 { margin: 0; flex: 1; }
.recent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr)); gap: 0.8rem; }
.entry-card { position: relative; }
.collection-entry-selected { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 24%, transparent); }
.collection-organize-hint { margin: 0; padding: 0.6rem 0.75rem; border-radius: var(--radius-control); color: var(--text-muted); background: var(--accent-soft); font-size: 0.78rem; line-height: 1.45; }
.collection-move-target { display: flex; align-items: center; justify-content: center; width: calc(100% - 0.8rem); min-height: 44px; margin: 0.4rem; padding: 0.35rem 0.6rem; border: 1px dashed var(--accent); border-radius: var(--radius-control); color: var(--accent); background: var(--accent-soft); font: inherit; font-weight: 650; cursor: pointer; touch-action: manipulation; }
.collection-order-controls { position: absolute; z-index: 3; top: 0.05rem; right: 0.05rem; display: grid; }
.collection-order-button { display: grid; width: 44px; height: 44px; padding: 0; place-items: center; border: 0; border-radius: 50%; color: #fff; background: radial-gradient(circle, rgb(0 0 0 / 58%) 0 0.78rem, transparent 0.82rem); font: inherit; font-weight: 800; cursor: pointer; touch-action: manipulation; }
.collection-order-button:hover:not(:disabled), .collection-order-button:focus-visible:not(:disabled) { background: radial-gradient(circle, rgb(0 0 0 / 78%) 0 0.78rem, transparent 0.82rem); outline: none; }
.collection-order-button:disabled { opacity: 0.32; cursor: default; }
.view-later-remove { position: absolute; top: 0.05rem; left: 0.05rem; z-index: 2; display: grid; width: 44px; height: 44px; padding: 0; place-items: center; border: 0; border-radius: 50%; background: radial-gradient(circle, rgb(0 0 0 / 58%) 0 0.68rem, transparent 0.72rem); color: #fff; font: inherit; font-size: 0.9rem; line-height: 1; cursor: pointer; touch-action: manipulation; }
.view-later-remove:hover { background: radial-gradient(circle, rgb(0 0 0 / 78%) 0 0.68rem, transparent 0.72rem); }
.collection-detail { display: grid; gap: 0.8rem; }
.collection-detail-head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.collection-detail h3 { margin: 0; }
.collection-description { margin: 0; color: var(--text-muted); white-space: pre-wrap; }
.collection-edit-row { display: grid; gap: 0.35rem; }
.collection-create-row { display: flex; gap: 0.5rem; }
.collection-create-row input { flex: 1; }
.collection-edit-row input,
.collection-edit-row textarea,
.collection-create-row input {
  min-height: var(--control-min-height);
  padding: 0.45rem 0.65rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  color: var(--text-primary);
  background: var(--surface-muted);
  font: inherit;
}
.collection-edit-row textarea { min-height: 0; resize: vertical; }
.collection-edit-row input:focus,
.collection-edit-row textarea:focus,
.collection-create-row input:focus { border-color: var(--accent); outline: 2px solid color-mix(in srgb, var(--accent) 18%, transparent); }
.entry-usage-note { color: var(--text-muted); }
.move-to-parent-target { justify-self: start; min-height: 44px; padding: 0.35rem 0.6rem; border: 1px dashed var(--accent); border-radius: 0.5rem; color: var(--accent); background: var(--accent-soft); font: inherit; font-weight: 650; cursor: pointer; touch-action: manipulation; transition: transform 140ms ease, background 140ms ease; }
.move-to-parent-target.drop-active { transform: scale(1.04); border-color: var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.entry-card[draggable='true'] { cursor: grab; }
.recent-tab-drop { border-style: dashed; border-color: var(--accent); }
@media (max-width: 44rem) {
  .recent-toolbar,
  .collection-detail-head { align-items: flex-start; flex-wrap: wrap; }
  .collection-create-row { flex-wrap: wrap; }
  .collection-create-row input { flex-basis: 100%; min-width: 0; min-height: 44px; }
  .collection-create-row button,
  .collection-detail-head button { min-height: 44px; }
}
</style>
