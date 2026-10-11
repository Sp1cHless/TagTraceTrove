<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import type { PendingOfflineEntryCreate } from '../api/gallery.js';
import { useI18n } from '../i18n.js';

type Values = { title: string; uploadDate: string | null; pageCount: number | null };
const props = defineProps<{ entry: PendingOfflineEntryCreate;
  saveMetadata: (key: string, values: Values) => Promise<void> }>();
const emit = defineEmits<{ saved: [values: Values]; cancel: [] }>();
const { t } = useI18n();
const title = ref(props.entry.title);
const date = ref(props.entry.uploadDate ?? '');
const pages = ref(props.entry.pageCount === null ? '' : String(props.entry.pageCount));
const saving = ref(false);
const error = ref<string | null>(null);
let alive = true;
let committed = false;
onBeforeUnmount(() => { alive = false; });
const writable = computed(() => props.entry.status === 'pending' && props.entry.canEditMetadata === true);
const values = computed<Values>(() => ({ title: title.value.trim(), uploadDate: date.value.trim() || null,
  pageCount: pages.value.trim() ? Number(pages.value) : null }));
const valid = computed(() => values.value.title.length > 0 && (values.value.pageCount === null
  || (Number.isSafeInteger(values.value.pageCount) && values.value.pageCount >= 0)));
const changed = computed(() => values.value.title !== props.entry.title
  || values.value.uploadDate !== props.entry.uploadDate || values.value.pageCount !== props.entry.pageCount);
async function save(): Promise<void> {
  if (committed || saving.value || !writable.value || !valid.value || !changed.value) return;
  const desired = { ...values.value };
  saving.value = true;
  error.value = null;
  try {
    await props.saveMetadata(props.entry.localKey, desired);
    committed = true;
    if (alive) emit('saved', desired);
  } catch (cause) {
    if (alive) error.value = cause instanceof Error ? cause.message : t('search.pendingMetadataError');
  } finally { if (!committed) saving.value = false; }
}
</script>

<template>
  <form v-if="writable" class="pending-metadata-editor" data-testid="pending-metadata-form" @submit.prevent="save">
    <label>{{ t('search.pendingMetadataTitle') }}<input v-model="title" data-testid="pending-metadata-title" type="text" :disabled="saving" required></label>
    <label>{{ t('search.pendingMetadataDate') }}<input v-model="date" data-testid="pending-metadata-date" type="text" placeholder="YYYY-MM-DD" :disabled="saving"></label>
    <label>{{ t('search.pendingMetadataPages') }}<input v-model="pages" data-testid="pending-metadata-pages" type="text" inputmode="numeric" :disabled="saving"></label>
    <p v-if="!valid" role="alert">{{ t('search.pendingMetadataInvalid') }}</p>
    <p v-if="error" role="alert" data-testid="pending-metadata-error">{{ error }}</p>
    <div class="pending-metadata-actions">
      <button type="submit" class="primary-button" :disabled="saving || !valid || !changed">{{ t('search.pendingSaveMetadata') }}</button>
      <button type="button" class="secondary-button" :disabled="saving" @click="emit('cancel')">{{ t('search.pendingCancelTags') }}</button>
    </div>
  </form>
  <p v-else role="alert" data-testid="pending-metadata-error">{{ t('search.pendingMetadataUnavailable') }}</p>
</template>

<style scoped>
.pending-metadata-editor, .pending-metadata-editor label { display: grid; gap: 0.5rem; }
.pending-metadata-editor { margin-block: 0.5rem; }
.pending-metadata-editor input, .pending-metadata-editor button { min-height: 44px; min-width: 44px; }
.pending-metadata-editor input { width: 100%; min-width: 0; box-sizing: border-box; }
.pending-metadata-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
</style>
