<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { normalizeTag } from '@t3/shared';
import type { GalleryApi, PendingOfflineEntryCreate } from '../api/gallery.js';
import { useI18n } from '../i18n.js';

type Author = { producerUid: string; name: string };
const props = defineProps<{ api: GalleryApi; entry: PendingOfflineEntryCreate;
  saveAuthors: (key: string, producerUids: string[]) => Promise<void>;
  createAuthor?: ((key: string, name: string) => Promise<Author>) | undefined }>();
const emit = defineEmits<{ saved: [authors: Author[]]; cancel: [] }>();
const { t } = useI18n();
const available = ref<Author[]>([]);
const draft = ref<Author[]>([]);
const query = ref('');
const newName = ref('');
const canCreateAuthor = ref(false);
const loading = ref(true);
const loaded = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
let alive = true;
let committed = false;
const writable = computed(() => props.entry.status === 'pending' && props.entry.canEditAuthors === true);
const vector = (rows: Author[]) => JSON.stringify(rows.map(row => row.producerUid).sort());
const original = ref('[]');
const changed = computed(() => vector(draft.value) !== original.value);
const suggestions = computed(() => {
  const q = normalizeTag(query.value);
  if (!q) return [];
  const selected = new Set(draft.value.map(row => row.producerUid));
  return available.value.filter(row => !selected.has(row.producerUid) && normalizeTag(row.name).includes(q)).slice(0, 20);
});
onBeforeUnmount(() => { alive = false; });
onMounted(async () => {
  try {
    if (!writable.value || !props.api.getPendingOfflineEntryAuthorOptions) throw new Error(t('search.pendingAuthorsUnavailable'));
    const options = await props.api.getPendingOfflineEntryAuthorOptions(props.entry.localKey);
    if (!alive) return;
    available.value = options.authors.map(row => ({ ...row }));
    canCreateAuthor.value = 'canCreateAuthor' in options && options.canCreateAuthor === true;
    draft.value = (props.entry.authors ?? []).map(row => ({ ...row }));
    original.value = vector(draft.value);
    loaded.value = true;
  } catch (cause) {
    if (alive) error.value = cause instanceof Error ? cause.message : t('search.pendingAuthorsError');
  } finally { if (alive) loading.value = false; }
});
function add(author: Author): void {
  if (!writable.value || saving.value || draft.value.some(row => row.producerUid === author.producerUid)) return;
  draft.value.push({ ...author });
  query.value = '';
}
async function create(): Promise<void> {
  const name = newName.value.trim();
  if (committed || saving.value || !writable.value || !canCreateAuthor.value || !props.createAuthor || changed.value || !name) return;
  saving.value = true;
  error.value = null;
  try {
    const author = await props.createAuthor(props.entry.localKey, name);
    committed = true;
    if (alive) emit('saved', [...draft.value.map(row => ({ ...row })), { ...author }]);
  } catch (cause) {
    if (alive) error.value = cause instanceof Error ? cause.message : t('search.pendingAuthorsError');
  } finally { if (!committed) saving.value = false; }
}
async function save(): Promise<void> {
  if (committed || saving.value || !writable.value || !changed.value) return;
  saving.value = true;
  error.value = null;
  const desired = draft.value.map(row => ({ ...row }));
  try {
    await props.saveAuthors(props.entry.localKey, desired.map(row => row.producerUid));
    committed = true;
    if (alive) emit('saved', desired);
  } catch (cause) {
    if (alive) error.value = cause instanceof Error ? cause.message : t('search.pendingAuthorsError');
  } finally { if (!committed) saving.value = false; }
}
</script>

<template>
  <div class="pending-author-editor">
    <p v-if="loading">{{ t('search.pendingAuthorsLoading') }}</p>
    <form v-else-if="loaded" data-testid="pending-author-form" @submit.prevent="save">
      <div v-for="(author, index) in draft" :key="author.producerUid" class="pending-author-row">
        <span>{{ author.name }}</span>
        <button type="button" data-testid="pending-author-remove" :disabled="saving || !writable" :aria-label="t('search.pendingRemoveAuthor', { name: author.name })" @click="draft.splice(index, 1)">×</button>
      </div>
      <input v-model="query" type="search" data-testid="pending-author-query" :disabled="saving || !writable" :aria-label="t('search.pendingAddAuthor')" :placeholder="t('search.pendingAddAuthor')">
      <div v-if="query.trim()" class="pending-author-options">
        <button v-for="author in suggestions" :key="author.producerUid" type="button" data-testid="pending-author-option" :disabled="saving || !writable" @click="add(author)">{{ author.name }}</button>
        <p v-if="!suggestions.length">{{ t('search.pendingAuthorsNoMatches') }}</p>
      </div>
      <div v-if="canCreateAuthor && createAuthor" class="pending-author-create">
        <input v-model="newName" data-testid="pending-author-new-name" :disabled="saving || !writable || changed" :aria-label="t('search.pendingNewAuthorName')" :placeholder="t('search.pendingNewAuthorName')">
        <button type="button" data-testid="pending-author-create" :disabled="saving || !writable || changed || !newName.trim()" @click="create">{{ t('search.pendingCreateAuthor') }}</button>
        <small v-if="changed">{{ t('search.pendingSaveBeforeCreateAuthor') }}</small>
      </div>
      <div class="pending-author-actions">
        <button type="submit" class="primary-button" :disabled="saving || !writable || !changed">{{ t('search.pendingSaveAuthors') }}</button>
        <button type="button" class="secondary-button" :disabled="saving" @click="emit('cancel')">{{ t('search.pendingCancelTags') }}</button>
      </div>
    </form>
    <p v-if="error" role="alert" data-testid="pending-author-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.pending-author-editor form { display: grid; gap: 0.5rem; }
.pending-author-row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.pending-author-row span { overflow-wrap: anywhere; }
.pending-author-editor input, .pending-author-editor button { min-height: 44px; min-width: 44px; }
.pending-author-options, .pending-author-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
</style>
