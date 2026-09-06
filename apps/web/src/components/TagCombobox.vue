<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from '../i18n.js';

/**
 * Reusable tag picker combobox: type-to-filter with the same lightweight
 * near-match ranking as the search page (exact / prefix / substring, and a
 * small edit-distance tolerance for 4+ character queries), then pick one
 * option. Used where a plain <select> cannot scale to large vocabularies.
 */
export interface TagComboboxOption {
  id: number;
  name: string;
}

const props = defineProps<{
  options: TagComboboxOption[];
  /** null = nothing chosen yet. */
  modelValue: number | null;
  placeholder?: string;
  testIdPrefix?: string;
  /** Option ids already picked in another row (disabled in this one). */
  takenIds?: number[];
}>();

const emit = defineEmits<{
  'update:modelValue': [value: number | null];
}>();

const { t } = useI18n();

const query = ref('');
const open = ref(false);
const rootElement = ref<HTMLElement | null>(null);

const selectedOption = computed(() => (
  props.options.find((option) => option.id === props.modelValue) ?? null
));

function normalize(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function matchScore(candidate: string, needle: string): number | null {
  const normalized = normalize(candidate);
  if (normalized === needle) return 0;
  if (normalized.startsWith(needle)) return 1;
  const words = normalized.split(/[\s\p{P}\p{S}]+/gu).filter(Boolean);
  if (words.some((word) => word === needle)) return 1;
  if (words.some((word) => word.startsWith(needle))) return 2;
  if (normalized.includes(needle)) return 3;
  if (needle.length < 4) return null;
  const threshold = needle.length >= 9 ? 2 : 1;
  const distance = Math.min(
    boundedLevenshtein(normalized, needle, threshold),
    ...words.map((word) => boundedLevenshtein(word, needle, threshold)),
  );
  return distance <= threshold ? 10 + distance : null;
}

function boundedLevenshtein(left: string, right: string, maxDistance: number): number {
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0]!;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const value = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + cost,
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[right.length] ?? maxDistance + 1;
}

const filteredOptions = computed(() => {
  const taken = new Set(props.takenIds ?? []);
  const candidates = props.options.filter(
    (option) => !taken.has(option.id) || option.id === props.modelValue,
  );
  const needle = normalize(query.value);
  if (needle === '') return candidates;
  return candidates
    .map((option, index) => ({ option, index, score: matchScore(option.name, needle) }))
    .filter((row): row is { option: TagComboboxOption; index: number; score: number } => row.score !== null)
    .sort((left, right) => (
      left.score - right.score || left.index - right.index
    ))
    .map((row) => row.option);
});

function toggleOpen(): void {
  open.value = !open.value;
  if (open.value) query.value = '';
}

function choose(option: TagComboboxOption): void {
  emit('update:modelValue', option.id);
  open.value = false;
  query.value = '';
}

function clearSelection(): void {
  emit('update:modelValue', null);
  open.value = false;
}

function onRootBlur(event: FocusEvent): void {
  if (!(event.relatedTarget instanceof Node) || !rootElement.value?.contains(event.relatedTarget)) {
    open.value = false;
  }
}
</script>

<template>
  <div
    ref="rootElement"
    class="tag-combobox"
    tabindex="-1"
    @focusout="onRootBlur"
  >
    <button
      type="button"
      class="tag-combobox__toggle"
      :data-testid="`${testIdPrefix ?? 'tag'}-combobox-toggle`"
      @click="toggleOpen"
    >
      <span :class="{ 'tag-combobox__placeholder': !selectedOption }">
        {{ selectedOption ? selectedOption.name : (placeholder ?? t('author.selectTag')) }}
      </span>
      <span class="tag-combobox__caret">▾</span>
    </button>
    <div
      v-if="open"
      class="tag-combobox__dropdown"
      :data-testid="`${testIdPrefix ?? 'tag'}-combobox-dropdown`"
    >
      <input
        v-model="query"
        class="tag-combobox__search"
        type="text"
        :data-testid="`${testIdPrefix ?? 'tag'}-combobox-input`"
        :placeholder="t('author.searchTagPlaceholder')"
        @keydown.esc="open = false"
      >
      <button
        v-for="option in filteredOptions"
        :key="option.id"
        type="button"
        class="tag-combobox__option"
        :class="{ 'tag-combobox__option--chosen': option.id === modelValue }"
        :data-testid="`${testIdPrefix ?? 'tag'}-combobox-option`"
        @click="choose(option)"
      >
        {{ option.name }}
      </button>
      <p v-if="filteredOptions.length === 0" class="tag-combobox__empty">
        {{ t('filter.noMatches') }}
      </p>
      <button
        v-if="modelValue !== null"
        type="button"
        class="tag-combobox__clear"
        :data-testid="`${testIdPrefix ?? 'tag'}-combobox-clear`"
        @click="clearSelection"
      >
        {{ t('tag.removeSelection') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.tag-combobox { position: relative; display: inline-flex; min-width: 12rem; }
.tag-combobox__toggle {
  display: inline-flex; width: 100%; align-items: center; justify-content: space-between; gap: 0.5rem;
  min-height: 2rem; padding: 0.3rem 0.6rem; border: 1px solid var(--border-subtle); border-radius: 0.55rem;
  color: var(--text-primary); background: var(--surface-muted); font: inherit; font-size: 0.85rem; cursor: pointer;
}
.tag-combobox__toggle:hover, .tag-combobox__toggle:focus-visible { border-color: var(--accent); outline: none; }
.tag-combobox__placeholder { color: var(--text-muted); }
.tag-combobox__caret { color: var(--text-muted); }
.tag-combobox__dropdown {
  position: absolute; z-index: 40; top: calc(100% + 0.3rem); left: 0; display: grid; gap: 0.1rem;
  min-width: 14rem; max-width: 22rem; max-height: 15rem; overflow-y: auto; padding: 0.3rem;
  border: 1px solid var(--border-subtle); border-radius: 0.6rem; background: var(--surface);
  box-shadow: 0 0.75rem 2rem rgb(15 23 42 / 14%);
}
.tag-combobox__search { width: 100%; margin-bottom: 0.15rem; padding: 0.4rem 0.6rem; border: 1px solid var(--border-subtle); border-radius: 0.55rem; background: var(--surface-muted); color: var(--text-primary); font: inherit; font-size: 0.85rem; }
.tag-combobox__search:focus { outline: none; border-color: var(--accent); }
.tag-combobox__option {
  display: flex; width: 100%; padding: 0.4rem 0.55rem; border: 0; border-radius: 0.45rem;
  color: var(--text-primary); background: transparent; font: inherit; font-size: 0.85rem; text-align: left; cursor: pointer;
}
.tag-combobox__option:hover, .tag-combobox__option:focus-visible { background: var(--surface-muted); outline: none; }
.tag-combobox__option--chosen { color: var(--accent); font-weight: 700; }
.tag-combobox__empty { margin: 0; padding: 0.35rem 0.55rem; color: var(--text-muted); font-size: 0.8rem; }
.tag-combobox__clear { padding: 0.35rem 0.55rem; border: 0; border-radius: 0.45rem; background: transparent; color: var(--text-muted); font: inherit; font-size: 0.78rem; text-align: left; cursor: pointer; }
.tag-combobox__clear:hover { color: var(--text-primary); background: var(--surface-muted); }
</style>
