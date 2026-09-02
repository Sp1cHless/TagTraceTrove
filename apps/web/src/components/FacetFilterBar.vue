<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { FacetFilterCondition, FacetFilterOptions } from '@t3/shared';
import { useI18n } from '../i18n.js';

/**
 * Gallery filter state owned by GalleryApp: tag rows (AND inside a row and
 * across rows) plus one optional Author row (OR inside the author list, AND
 * with every tag row).
 */
export interface GalleryFacetFilters {
  conditions: FacetFilterCondition[];
  authorIds: number[];
}

type RowMode = 'tag' | 'author';

interface ChoiceOption {
  key: string;
  label: string;
  kind: RowMode;
  /** tag row only: undefined = facet not chosen yet, null = all tags. */
  facetId?: number | null;
  disabled: boolean;
}

interface ItemOption {
  id: number;
  name: string;
}

interface FilterRow {
  mode: RowMode;
  /** undefined = still choosing the Facet (tag rows only). */
  facetId: number | undefined | null;
  tagIds: number[];
  authorIds: number[];
  facetQuery: string;
  itemQuery: string;
  facetOpen: boolean;
  itemOpen: boolean;
}

const props = defineProps<{
  options: FacetFilterOptions;
  modelValue: GalleryFacetFilters;
  /** Author page mode: hide the Authors row (the author is fixed already). */
  hideAuthors?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [filters: GalleryFacetFilters];
}>();

const { t } = useI18n();

function freshRow(): FilterRow {
  return {
    mode: 'tag',
    facetId: undefined,
    tagIds: [],
    authorIds: [],
    facetQuery: '',
    itemQuery: '',
    facetOpen: false,
    itemOpen: false,
  };
}

const rows = ref<FilterRow[]>([]);
const itemInputs = ref<Array<HTMLInputElement | null>>([]);
const filterError = ref<string | null>(null);
let errorTimer: ReturnType<typeof setTimeout> | undefined;

// Switching the active gallery resets the whole bar; edits inside the bar are
// the component's own state and are never overwritten from outside.
watch(() => props.options.entryType, () => {
  rows.value = [freshRow()];
}, { immediate: true });

// An external reset (e.g. re-entering the same gallery after a delete) clears
// the filters to empty — mirror that in the rows. Self-emitted clears already
// left the rows empty, so they do not loop.
watch(() => props.modelValue.conditions.length + props.modelValue.authorIds.length, (total) => {
  if (total === 0 && rows.value.some((row) => (
    row.facetId !== undefined || row.tagIds.length > 0 || row.authorIds.length > 0
  ))) {
    rows.value = [freshRow()];
    closeAllDropdowns();
  }
});

function setItemInput(index: number, element: unknown): void {
  itemInputs.value[index] = element as HTMLInputElement | null;
}

function showFilterError(message: string): void {
  filterError.value = message;
  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    filterError.value = null;
  }, 3200);
}

function rowLabel(row: FilterRow): string {
  if (row.mode === 'author') return t('filter.authors');
  if (row.facetId === null) return t('filter.allTags');
  const facet = props.options.facets.find((candidate) => candidate.facetId === row.facetId);
  return facet ? facet.facetName : '';
}

function rowHint(row: FilterRow): string {
  if (row.mode === 'author') return t('filter.authorsHint');
  if (row.facetId === null) return t('filter.allTagsHint');
  const facet = props.options.facets.find((candidate) => candidate.facetId === row.facetId);
  return facet ? `${facet.sectionName} / ${facet.facetName}` : '';
}

function tagOptionsForRow(row: FilterRow): ItemOption[] {
  if (row.mode === 'author') {
    return props.options.authors.map((author) => ({ id: author.authorId, name: author.name }));
  }
  if (row.facetId === null) {
    return props.options.allTags.map((tag) => ({ id: tag.tagId, name: tag.name }));
  }
  const facet = props.options.facets.find((candidate) => candidate.facetId === row.facetId);
  return (facet?.tags ?? []).map((tag) => ({ id: tag.tagId, name: tag.name }));
}

function selectedIds(row: FilterRow): number[] {
  return row.mode === 'author' ? row.authorIds : row.tagIds;
}

function filteredItemOptions(row: FilterRow): ItemOption[] {
  const query = row.itemQuery.trim().toLocaleLowerCase();
  const selected = new Set(selectedIds(row));
  return tagOptionsForRow(row).filter((option) => (
    !selected.has(option.id)
    && (query === '' || option.name.toLocaleLowerCase().includes(query))
  ));
}

function facetChoices(): ChoiceOption[] {
  const takenFacets = new Set<number>();
  let allTagsTaken = false;
  let authorsTaken = false;
  for (const row of rows.value) {
    if (row.mode === 'author') {
      authorsTaken = true;
    } else if (row.facetId === null) {
      allTagsTaken = true;
    } else if (row.facetId !== undefined) {
      takenFacets.add(row.facetId);
    }
  }
  const choices: ChoiceOption[] = props.options.facets.map((facet) => ({
    key: `facet-${facet.facetId}`,
    label: facet.facetName,
    kind: 'tag',
    facetId: facet.facetId,
    disabled: takenFacets.has(facet.facetId),
  }));
  choices.push({
    key: 'all-tags',
    label: t('filter.allTags'),
    kind: 'tag',
    facetId: null,
    disabled: allTagsTaken,
  });
  if (!props.hideAuthors) {
    choices.push({
      key: 'authors',
      label: t('filter.authors'),
      kind: 'author',
      disabled: authorsTaken,
    });
  }
  return choices;
}

function filteredFacetChoices(query: string): ChoiceOption[] {
  const normalized = query.trim().toLocaleLowerCase();
  return facetChoices().filter((choice) => (
    normalized === '' || choice.label.toLocaleLowerCase().includes(normalized)
  ));
}

function emitFilters(): void {
  const conditions: FacetFilterCondition[] = rows.value
    .filter((row): row is FilterRow & { mode: 'tag'; facetId: number | null } => (
      row.mode === 'tag' && row.facetId !== undefined && row.tagIds.length > 0
    ))
    .map((row) => ({ facetId: row.facetId, tagIds: row.tagIds }));
  const authorIds = rows.value
    .filter((row) => row.mode === 'author')
    .flatMap((row) => row.authorIds);
  emit('update:modelValue', { conditions, authorIds });
}

function closeAllDropdowns(): void {
  for (const row of rows.value) {
    row.facetOpen = false;
    row.itemOpen = false;
  }
}

function addRow(): void {
  rows.value.push(freshRow());
}

function removeRow(index: number): void {
  rows.value.splice(index, 1);
  if (rows.value.length === 0) {
    rows.value.push(freshRow());
  }
  closeAllDropdowns();
  filterError.value = null;
  emitFilters();
}

function chooseFacet(row: FilterRow, choice: ChoiceOption): void {
  if (choice.disabled) return;
  if (choice.kind === 'author') {
    row.mode = 'author';
    row.facetId = undefined;
    row.tagIds = [];
    row.facetQuery = '';
    row.facetOpen = false;
  } else {
    if (row.mode === 'author') row.authorIds = [];
    row.mode = 'tag';
    if (row.facetId === choice.facetId) return;
    row.facetId = choice.facetId;
    // Drop chosen tags that do not exist under the newly chosen Facet.
    const allowed = new Set(tagOptionsForRow(row).map((option) => option.id));
    row.tagIds = row.tagIds.filter((tagId) => allowed.has(tagId));
  }
  row.itemQuery = '';
  const rowIndex = rows.value.indexOf(row);
  row.itemOpen = true;
  void nextTick(() => {
    itemInputs.value[rowIndex]?.focus();
  });
  filterError.value = null;
  emitFilters();
}

function isTagTakenElsewhere(row: FilterRow, tagId: number): boolean {
  return rows.value.some((candidate) => (
    candidate !== row && candidate.mode === 'tag' && candidate.tagIds.includes(tagId)
  ));
}

function addItem(row: FilterRow, option: ItemOption): void {
  if (row.mode === 'tag') {
    if (isTagTakenElsewhere(row, option.id)) {
      showFilterError(t('filter.duplicateTag', { name: option.name }));
      return;
    }
    if (row.tagIds.includes(option.id)) return;
    row.tagIds.push(option.id);
  } else {
    if (row.authorIds.includes(option.id)) return;
    row.authorIds.push(option.id);
  }
  row.itemQuery = '';
  filterError.value = null;
  emitFilters();
}

function removeItem(row: FilterRow, id: number): void {
  if (row.mode === 'author') {
    row.authorIds = row.authorIds.filter((authorId) => authorId !== id);
  } else {
    row.tagIds = row.tagIds.filter((tagId) => tagId !== id);
  }
  filterError.value = null;
  emitFilters();
}

function chipName(row: FilterRow, id: number): string {
  const option = tagOptionsForRow(row).find((candidate) => candidate.id === id);
  return option?.name ?? String(id);
}

function clearAll(): void {
  rows.value = [freshRow()];
  closeAllDropdowns();
  filterError.value = null;
  emitFilters();
}

function hasActiveFilters(): boolean {
  return props.modelValue.conditions.length > 0 || props.modelValue.authorIds.length > 0;
}

function canAddRow(): boolean {
  return facetChoices().some((choice) => !choice.disabled);
}

function onBarPointerDown(event: PointerEvent): void {
  if (!(event.target as HTMLElement).closest('.filter-combobox')) {
    closeAllDropdowns();
  }
}
</script>

<template>
  <div
    class="facet-filter-bar"
    data-testid="facet-filter-bar"
    @pointerdown="onBarPointerDown"
  >
    <div class="facet-filter-bar__head">
      <span class="facet-filter-bar__label">{{ t('filter.label') }}</span>
      <button
        v-if="hasActiveFilters()"
        class="filter-action"
        type="button"
        data-testid="clear-facet-filters"
        @click="clearAll"
      >
        {{ t('filter.clearAll') }}
      </button>
    </div>

    <p v-if="filterError" class="filter-error" data-testid="filter-error" role="alert">
      {{ filterError }}
    </p>

    <div v-for="(row, rowIndex) in rows" :key="rowIndex" class="filter-row">
      <!-- Facet / dimension picker (combobox with free input). -->
      <div class="filter-combobox filter-combobox--facet">
        <button
          v-if="row.mode === 'tag' && row.facetId === undefined"
          class="facet-select-button"
          type="button"
          data-testid="facet-picker-button"
          @click="
            closeAllDropdowns();
            row.facetOpen = !row.facetOpen;
          "
        >
          {{ t('filter.facetPlaceholder') }} ▾
        </button>
        <button
          v-else
          class="facet-select-button facet-select-button--chosen"
          type="button"
          data-testid="facet-picker-chosen"
          :title="rowHint(row)"
          @click="
            closeAllDropdowns();
            row.facetOpen = !row.facetOpen;
          "
        >
          {{ rowLabel(row) }} ▾
        </button>
        <div v-if="row.facetOpen" class="filter-dropdown" data-testid="facet-dropdown">
          <input
            v-model="row.facetQuery"
            class="filter-input filter-dropdown__search"
            type="text"
            :placeholder="t('filter.facetSearchPlaceholder')"
          >
          <button
            v-for="choice in filteredFacetChoices(row.facetQuery)"
            :key="choice.key"
            class="filter-option"
            :class="{ 'filter-option--disabled': choice.disabled }"
            type="button"
            :disabled="choice.disabled"
            @click="chooseFacet(row, choice)"
          >
            <span class="filter-option__label">{{ choice.label }}</span>
            <span v-if="choice.disabled" class="filter-option__hint">{{ t('filter.alreadyUsed') }}</span>
          </button>
          <p v-if="filteredFacetChoices(row.facetQuery).length === 0" class="filter-dropdown__empty">
            {{ t('filter.noMatches') }}
          </p>
        </div>
      </div>

      <!-- Chosen tags/authors as removable chips. -->
      <span
        v-for="id in row.mode === 'author' ? row.authorIds : row.tagIds"
        :key="id"
        class="filter-tag-chip"
        data-testid="filter-tag-chip"
      >
        <span>{{ chipName(row, id) }}</span>
        <button
          class="filter-tag-chip__remove"
          type="button"
          :aria-label="t('filter.removeTag', { name: chipName(row, id) })"
          @click="removeItem(row, id)"
        >
          ×
        </button>
      </span>

      <!-- Item picker: tags of the chosen Facet, or Authors. -->
      <div
        v-if="row.mode === 'author' || (row.mode === 'tag' && row.facetId !== undefined)"
        class="filter-combobox filter-combobox--tags"
      >
        <input
          :ref="(element) => setItemInput(rowIndex, element)"
          v-model="row.itemQuery"
          class="filter-input filter-combobox__input"
          type="text"
          data-testid="tag-picker-input"
          :placeholder="row.mode === 'author' ? t('filter.authorPlaceholder') : t('filter.tagPlaceholder')"
          @focus="
            closeAllDropdowns();
            row.facetOpen = false;
            row.itemOpen = true;
          "
          @keydown.esc="row.itemOpen = false"
        >
        <div v-if="row.itemOpen" class="filter-dropdown" data-testid="tag-dropdown">
          <button
            v-for="option in filteredItemOptions(row)"
            :key="option.id"
            class="filter-option"
            type="button"
            @click="addItem(row, option)"
          >
            {{ option.name }}
          </button>
          <p v-if="filteredItemOptions(row).length === 0" class="filter-dropdown__empty">
            {{ t('filter.noMatches') }}
          </p>
        </div>
      </div>

      <button
        class="filter-row__remove"
        type="button"
        :aria-label="t('filter.removeRow')"
        data-testid="remove-filter-row"
        @click="removeRow(rowIndex)"
      >
        ×
      </button>
    </div>

    <div class="facet-filter-bar__actions">
      <button
        class="filter-action"
        type="button"
        data-testid="add-facet-filter"
        :disabled="!canAddRow()"
        @click="addRow"
      >
        + {{ t('filter.addFacet') }}
      </button>
      <p class="filter-note">{{ t('filter.andNote') }}</p>
    </div>
  </div>
</template>

<style scoped>
.facet-filter-bar {
  display: grid;
  gap: 0.5rem;
  padding: 0.7rem 0.75rem;
  border: 1px solid var(--border-subtle);
  border-radius: 0.9rem;
  background: var(--surface);
}

.facet-filter-bar__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.facet-filter-bar__label {
  color: var(--accent);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.facet-filter-bar__actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.filter-note {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.72rem;
}

.filter-error {
  margin: 0;
  padding: 0.35rem 0.55rem;
  border-radius: 0.5rem;
  color: #a12626;
  background: color-mix(in srgb, #a12626 10%, transparent);
  font-size: 0.8rem;
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.45rem;
}

.filter-combobox {
  position: relative;
}

.filter-dropdown {
  position: absolute;
  z-index: 30;
  top: calc(100% + 0.3rem);
  left: 0;
  display: grid;
  gap: 0.1rem;
  min-width: 13rem;
  max-width: 22rem;
  max-height: 14rem;
  overflow-y: auto;
  padding: 0.3rem;
  border: 1px solid var(--border-subtle);
  border-radius: 0.6rem;
  background: var(--surface);
  box-shadow: 0 0.75rem 2rem rgb(15 23 42 / 14%);
}

.filter-dropdown__search {
  width: 100%;
  margin-bottom: 0.15rem;
}

.filter-dropdown__empty {
  margin: 0;
  padding: 0.35rem 0.55rem;
  color: var(--text-muted);
  font-size: 0.8rem;
}

.filter-option {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.4rem 0.55rem;
  border: 0;
  border-radius: 0.45rem;
  color: var(--text-primary);
  background: transparent;
  font: inherit;
  font-size: 0.85rem;
  text-align: left;
  cursor: pointer;
}

.filter-option:hover,
.filter-option:focus-visible {
  background: var(--surface-muted);
  outline: none;
}

.filter-option--disabled {
  color: var(--text-muted);
  cursor: default;
}

.filter-option--disabled:hover {
  background: transparent;
}

.filter-option__hint {
  color: var(--text-muted);
  font-size: 0.7rem;
}

.facet-select-button {
  display: inline-flex;
  min-height: 2rem;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.7rem;
  border: 1px solid var(--border-subtle);
  border-radius: 0.65rem;
  color: var(--text-muted);
  background: var(--surface-muted);
  font: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}

.facet-select-button:hover,
.facet-select-button:focus-visible {
  border-color: var(--border-strong, var(--border-subtle));
  color: var(--text-primary);
  outline: none;
}

.facet-select-button--chosen {
  color: var(--text-primary);
  background: var(--tag-background);
  border-color: var(--tag-border);
}

.filter-combobox__input {
  min-width: 9rem;
}

.filter-input {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--border-subtle);
  border-radius: 0.55rem;
  color: var(--text-primary);
  background: var(--surface-muted);
  font: inherit;
  font-size: 0.85rem;
}

.filter-input::placeholder {
  color: var(--text-muted);
}

.filter-input:focus {
  outline: none;
  border-color: var(--accent);
}

.filter-tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.6rem;
  border: 1px solid var(--tag-border);
  border-radius: 0.6rem;
  color: var(--tag-text);
  background: var(--tag-background);
  font-size: 0.8rem;
  font-weight: 600;
}

.filter-tag-chip__remove {
  width: 1.1rem;
  height: 1.1rem;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: inherit;
  background: transparent;
  font: inherit;
  line-height: 1;
  cursor: pointer;
}

.filter-tag-chip__remove:hover,
.filter-tag-chip__remove:focus-visible {
  background: var(--tag-remove-hover);
  outline: none;
}

.filter-row__remove {
  width: 1.6rem;
  height: 1.6rem;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: var(--text-muted);
  background: transparent;
  font: inherit;
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
}

.filter-row__remove:hover,
.filter-row__remove:focus-visible {
  color: var(--text-primary);
  background: var(--surface-muted);
  outline: none;
}

.filter-action {
  padding: 0.3rem 0.65rem;
  border: 1px solid var(--border-subtle);
  border-radius: 0.55rem;
  color: var(--text-muted);
  background: transparent;
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
}

.filter-action:hover:not(:disabled),
.filter-action:focus-visible {
  border-color: var(--accent);
  color: var(--accent);
  outline: none;
}

.filter-action:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
