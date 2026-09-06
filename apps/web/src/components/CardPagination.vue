<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '../i18n.js';

/**
 * The page bar for card grids: one rounded container holding the page
 * numbers (1 … last), the current page highlighted by a darker round chip,
 * plus prev/next arrows and a jump input. Shown above and below the grid.
 */
const props = defineProps<{
  page: number;
  pageCount: number;
}>();

const emit = defineEmits<{
  'update:page': [page: number];
}>();

const { t } = useI18n();

// 1 2 3 … last: always keep the first and last page, plus the neighbours of
// the current one; gaps collapse into ellipses.
const pageItems = computed<Array<number | 'gap'>>(() => {
  const { page, pageCount } = props;
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }
  const wanted = new Set(
    [1, pageCount, page - 1, page, page + 1].filter((candidate) => candidate >= 1 && candidate <= pageCount),
  );
  const ordered = [...wanted].sort((left, right) => left - right);
  const items: Array<number | 'gap'> = [];
  let previous = 0;
  for (const candidate of ordered) {
    if (candidate - previous > 1) items.push('gap');
    items.push(candidate);
    previous = candidate;
  }
  return items;
});

function jumpToPage(event: Event): void {
  const input = event.target as HTMLInputElement;
  const requested = Number(input.value);
  input.value = '';
  if (Number.isFinite(requested) && requested >= 1) {
    emit('update:page', requested);
  }
}
</script>

<template>
  <nav class="card-pagination" data-testid="card-pagination" :aria-label="t('pagination.label')">
    <button
      class="card-pagination-arrow"
      type="button"
      :disabled="page <= 1"
      :aria-label="t('pagination.previous')"
      @click="emit('update:page', page - 1)"
    >‹</button>
    <template v-for="(item, index) in pageItems" :key="`${item}-${index}`">
      <span v-if="item === 'gap'" class="card-pagination-gap" aria-hidden="true">…</span>
      <button
        v-else
        type="button"
        class="card-pagination-page"
        :class="{ 'card-pagination-page-active': item === page }"
        :aria-current="item === page ? 'page' : undefined"
        @click="emit('update:page', item)"
      >{{ item }}</button>
    </template>
    <input
      class="card-pagination-jump"
      data-testid="card-pagination-jump"
      type="number"
      min="1"
      :max="pageCount"
      :placeholder="String(page)"
      :aria-label="t('pagination.jump')"
      @keydown.enter="jumpToPage"
      @blur="jumpToPage"
    >
    <button
      class="card-pagination-arrow"
      type="button"
      :disabled="page >= pageCount"
      :aria-label="t('pagination.next')"
      @click="emit('update:page', page + 1)"
    >›</button>
  </nav>
</template>

<style scoped>
.card-pagination {
  display: flex;
  width: fit-content;
  align-items: center;
  gap: 2px;
  margin-inline: auto;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--surface-muted);
}

.card-pagination-page,
.card-pagination-arrow {
  display: grid;
  min-width: 2rem;
  height: 2rem;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 999px;
  color: var(--text-muted);
  background: transparent;
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
  transition: color var(--transition-duration) ease, background-color var(--transition-duration) ease;
}

.card-pagination-page:hover,
.card-pagination-arrow:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--surface-hover);
}

/* The current page sits in a darker round chip than the bar. */
.card-pagination-page-active {
  color: var(--text-primary);
  background: var(--surface-hover);
  font-weight: 700;
  box-shadow: inset 0 0 0 1px var(--border-strong);
}

.card-pagination-page:focus-visible,
.card-pagination-arrow:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.card-pagination-arrow:disabled {
  opacity: 0.35;
  cursor: default;
}

.card-pagination-gap {
  min-width: 1.25rem;
  color: var(--text-muted);
  font-size: 0.85rem;
  text-align: center;
}

.card-pagination-jump {
  width: 3rem;
  height: 2rem;
  margin-inline: var(--space-1);
  padding: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  color: var(--text-primary);
  background: var(--surface);
  font: inherit;
  font-size: 0.85rem;
  text-align: center;
}

.card-pagination-jump:focus {
  border-color: var(--accent);
  outline: none;
}

.card-pagination-jump::-webkit-outer-spin-button,
.card-pagination-jump::-webkit-inner-spin-button {
  appearance: none;
  margin: 0;
}
</style>
