<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { normalizeTag, type RelationSuggestion } from '@t3/shared';
import type { GalleryApi, PendingOfflineEntryCreate, PendingOfflineEntryTagOptions, PendingOfflineEntryTagValue } from '../api/gallery.js';
import { useI18n } from '../i18n.js';
import { showNsfw } from '../stores/preferences.js';
import SuggestionInput from './SuggestionInput.vue';

const props = defineProps<{ api: GalleryApi; entry: PendingOfflineEntryCreate;
  saveTags?: (key: string, tags: PendingOfflineEntryTagValue[]) => Promise<void>;
  createTag?: ((key: string, name: string, facetId: number) => Promise<void>) | undefined;
  createFacet?: ((key: string, name: string, sectionId: number) => Promise<void>) | undefined }>();
const emit = defineEmits<{ saved: [tags: PendingOfflineEntryTagValue[]]; cancel: [] }>();
const { t } = useI18n();
const options = ref<PendingOfflineEntryTagOptions | null>(null);
const draft = ref<PendingOfflineEntryTagValue[]>([]);
const facetId = ref(0);
const loading = ref(true);
const saving = ref(false);
const newTagName = ref('');
const newFacetName = ref('');
const sectionId = ref(0);
const facetCommitted = ref(false);
const canCreateFacet = computed(() => options.value?.canCreateFacet === true && !!props.api.enqueueOfflinePendingEntryFacetCreate);
const canCreate = computed(() => options.value?.canCreateTag === true && !!props.api.enqueueOfflinePendingEntryTagCreate);
const error = ref<string | null>(null);
let alive = true;
let committed = false;
const writable = computed(() => props.entry.status === 'pending' && props.entry.canEditTags === true);
const vector = (tags: PendingOfflineEntryTagValue[]) => JSON.stringify(tags
  .map((tag) => ({ name: normalizeTag(tag.name), facetId: tag.facetId }))
  .sort((a, b) => a.name.localeCompare(b.name)));
const changed = computed(() => options.value !== null && vector(draft.value) !== vector(options.value.tags));
const valid = computed(() => options.value !== null && draft.value.every((tag) =>
  options.value!.facets.some((facet) => facet.id === tag.facetId)));
const excludeIds = computed(() => (options.value?.availableTags ?? [])
  .filter((tag) => draft.value.some((assigned) => normalizeTag(assigned.name) === normalizeTag(tag.name)))
  .map((tag) => tag.id));

onBeforeUnmount(() => { alive = false; });
onMounted(async () => {
  try {
    if (!writable.value || !props.api.getPendingOfflineEntryTagOptions) throw new Error(t('search.pendingTagsUnavailable'));
    const loaded = await props.api.getPendingOfflineEntryTagOptions(props.entry.localKey);
    if (!alive) return;
    options.value = loaded;
    draft.value = loaded.tags.map((tag) => ({ ...tag }));
    facetId.value = loaded.facets[0]?.id ?? 0;
    sectionId.value = loaded.sections?.[0]?.id ?? 0;
  } catch (cause) {
    if (alive) error.value = cause instanceof Error ? cause.message : t('search.pendingTagsError');
  } finally {
    if (alive) loading.value = false;
  }
});

async function suggestions(query: string, excluded: number[], signal: AbortSignal): Promise<RelationSuggestion[]> {
  const loaded = options.value;
  if (!loaded || !alive || !writable.value) return [];
  try {
    const found = await props.api.suggestTags({ q: query, excludeIds: excluded, vocabulary: 'entry',
      entryType: props.entry.type, includeNsfw: showNsfw.value ? 'true' : 'false' }, signal);
    if (!alive || signal.aborted) return [];
    // Only identities in this saved copy are eligible; a newly discovered remote
    // Tag must not be silently introduced into the local causal edit.
    return found.filter((candidate) => loaded.availableTags.some((tag) =>
      tag.id === candidate.id && normalizeTag(tag.name) === normalizeTag(candidate.name)));
  } catch {
    // Offline there is no suggestion endpoint: the saved vocabulary is the
    // typeahead source, or the editor would offer nothing at all. The
    // availableTags set already carries the same eligibility contract.
    if (!alive || signal.aborted) return [];
    const wanted = normalizeTag(query.trim());
    return loaded.availableTags
      .filter((tag) => !excluded.includes(tag.id) && (wanted === '' || normalizeTag(tag.name).includes(wanted)))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 20)
      .map((tag) => ({ id: tag.id, name: tag.name, sameContextUsageCount: 0, totalUsageCount: 0 }));
  }
}

function selectTag(candidate: RelationSuggestion): void {
  const loaded = options.value;
  if (!loaded || !writable.value || saving.value || !loaded.facets.some((facet) => facet.id === facetId.value)) return;
  const cached = loaded.availableTags.find((tag) => tag.id === candidate.id);
  if (!cached || draft.value.some((tag) => normalizeTag(tag.name) === normalizeTag(cached.name))) return;
  draft.value.push({ name: cached.name, facetId: facetId.value });
}

async function createFacet(): Promise<void> {
  if (saving.value || facetCommitted.value || committed || changed.value || !writable.value || !canCreateFacet.value || !newFacetName.value.trim() || !sectionId.value) return;
  saving.value = true; error.value = null;
  const name = newFacetName.value.trim();
  try {
    if (props.createFacet) await props.createFacet(props.entry.localKey, name, sectionId.value);
    else await props.api.enqueueOfflinePendingEntryFacetCreate!(props.entry.localKey, name, sectionId.value);
    facetCommitted.value = true;
    const loaded = await props.api.getPendingOfflineEntryTagOptions!(props.entry.localKey);
    if (alive) { options.value = loaded; facetId.value = loaded.facets.find(row => row.name === name)?.id ?? facetId.value; newFacetName.value = ''; facetCommitted.value = false; }
  } catch (cause) {
    if (alive) error.value = facetCommitted.value ? t('search.pendingTagsRefreshError') : cause instanceof Error ? cause.message : t('search.pendingTagsError');
  } finally { saving.value = false; }
}

async function create(): Promise<void> {
  if (committed || saving.value || !writable.value || !canCreate.value || !newTagName.value.trim() || changed.value) return;
  saving.value = true; error.value = null;
  const name = newTagName.value.trim(); const selectedFacet = facetId.value;
  try {
    if (props.createTag) await props.createTag(props.entry.localKey, name, selectedFacet);
    else await props.api.enqueueOfflinePendingEntryTagCreate!(props.entry.localKey, name, selectedFacet);
    committed = true;
    if (alive) emit('saved', [...draft.value.filter(row => normalizeTag(row.name) !== normalizeTag(name)), { name, facetId: selectedFacet }]);
  } catch (cause) {
    if (alive) error.value = cause instanceof Error ? cause.message : t('search.pendingTagsError');
  } finally { if (!committed) saving.value = false; }
}

async function save(): Promise<void> {
  if (committed || saving.value || !writable.value || !changed.value || !valid.value || (!props.saveTags && !props.api.enqueueOfflinePendingEntryTags)) return;
  saving.value = true;

  error.value = null;
  const desired = draft.value.map((tag) => ({ ...tag }));
  try {
    if (props.saveTags) await props.saveTags(props.entry.localKey, desired);
    else await props.api.enqueueOfflinePendingEntryTags!(props.entry.localKey, desired);
    committed = true;
    if (alive) emit('saved', desired);
  } catch (cause) {
    if (alive) error.value = cause instanceof Error ? cause.message : t('search.pendingTagsError');
  } finally {
    if (!committed) saving.value = false;

  }
}
</script>

<template>
  <div class="pending-tag-editor">
    <p v-if="loading">{{ t('search.pendingTagsLoading') }}</p>
    <form v-else-if="options" data-testid="pending-tag-form" @submit.prevent="save">
      <p v-if="!options.facets.length">{{ t('search.pendingTagsNoFacets') }}</p>
      <div v-for="(tag, index) in draft" :key="normalizeTag(tag.name)" class="pending-tag-row">
        <span>{{ tag.name }}</span>
        <select v-model.number="tag.facetId" data-testid="pending-tag-row-facet" :disabled="saving || !writable" :aria-label="t('search.pendingTagFacet')">
          <option v-for="facet in options.facets" :key="facet.id" :value="facet.id">{{ facet.name || t('search.pendingUnnamedFacet') }}</option>
        </select>
        <button type="button" data-testid="pending-tag-remove" :disabled="saving || !writable" :aria-label="t('search.pendingRemoveTag', { name: tag.name })" @click="draft.splice(index, 1)">×</button>
      </div>
      <div v-if="options.facets.length && writable && !saving" class="pending-tag-add">
        <select v-model.number="facetId" data-testid="pending-tag-add-facet" :aria-label="t('search.pendingTagFacet')">
          <option v-for="facet in options.facets" :key="facet.id" :value="facet.id">{{ facet.name || t('search.pendingUnnamedFacet') }}</option>
        </select>
        <SuggestionInput mode="id-only" name="pending-entry-tag" :provider="suggestions" :exclude-ids="excludeIds" :aria-label="t('search.pendingAddTag')" :placeholder="t('search.pendingAddTag')" @select="selectTag" />
      </div>
      <div v-if="canCreate && options.facets.length && writable" class="pending-tag-add">
        <input v-model="newTagName" data-testid="pending-new-tag-name" :disabled="saving || committed" :aria-label="t('search.pendingNewTagName')" :placeholder="t('search.pendingNewTagName')">
        <button type="button" data-testid="pending-new-tag-create" :disabled="saving || committed || changed || !newTagName.trim()" @click="create">{{ t('search.pendingCreateTag') }}</button>
        <span v-if="changed">{{ t('search.pendingSaveBeforeCreateTag') }}</span>
      </div>
      <div v-if="canCreateFacet && writable" class="pending-tag-add">
        <template v-if="options.sections?.length">
          <select v-model.number="sectionId" data-testid="pending-new-facet-section" :disabled="saving || facetCommitted" :aria-label="t('search.pendingFacetSection')"><option v-for="section in options.sections" :key="section.id" :value="section.id">{{ section.name }}</option></select>
          <input v-model="newFacetName" data-testid="pending-new-facet-name" :disabled="saving || facetCommitted" :placeholder="t('search.pendingNewFacetName')" :aria-label="t('search.pendingNewFacetName')">
          <button type="button" data-testid="pending-new-facet-create" :disabled="saving || facetCommitted || changed || !newFacetName.trim()" @click="createFacet">{{ t('search.pendingCreateFacet') }}</button>
          <span v-if="changed">{{ t('search.pendingSaveBeforeCreateTag') }}</span>
        </template>
        <p v-else>{{ t('search.pendingFacetSectionRequired') }}</p>
      </div>
      <div class="pending-tag-actions">
        <button type="submit" class="primary-button" :disabled="saving || !writable || !changed || !valid">{{ t('search.pendingSaveTags') }}</button>
        <button type="button" class="secondary-button" :disabled="saving" @click="emit('cancel')">{{ t('search.pendingCancelTags') }}</button>
      </div>
    </form>
    <p v-if="error" role="alert" data-testid="pending-tag-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.pending-tag-editor form { display: grid; gap: 0.5rem; }
.pending-tag-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 0.5rem; align-items: center; }
.pending-tag-row > span { overflow-wrap: anywhere; }
.pending-tag-row select, .pending-tag-row button, .pending-tag-add select { min-height: 44px; min-width: 44px; }
.pending-tag-add, .pending-tag-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
</style>
