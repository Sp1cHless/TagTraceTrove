<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string;
    draggable?: boolean;
    removable?: boolean;
  }>(),
  {
    draggable: false,
    removable: false,
  },
);

defineEmits<{
  remove: [];
}>();
</script>

<template>
  <span class="tag-chip" :draggable="draggable">
    <span class="tag-chip__grip" aria-hidden="true">⠿</span>
    <span>{{ label }}</span>
    <button
      v-if="removable"
      class="tag-chip__remove"
      type="button"
      :aria-label="`Remove ${label}`"
      @click.stop="$emit('remove')"
    >
      ×
    </button>
  </span>
</template>

<style scoped>
.tag-chip {
  display: inline-flex;
  min-height: 2rem;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.7rem;
  border: 1px solid var(--tag-border);
  border-radius: 0.65rem;
  color: var(--tag-text);
  background: var(--tag-background);
  box-shadow: 0 1px 2px rgb(15 23 42 / 8%);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1;
  cursor: grab;
  user-select: none;
  transition:
    border-color 140ms ease,
    background-color 140ms ease,
    transform 140ms ease;
}

.tag-chip:hover {
  border-color: var(--tag-border-hover);
  transform: translateY(-1px);
}

.tag-chip:active {
  cursor: grabbing;
  transform: translateY(0);
}

.tag-chip__grip {
  color: var(--text-muted);
  font-size: 1rem;
}

.tag-chip__remove {
  width: 1.25rem;
  height: 1.25rem;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: inherit;
  background: transparent;
  font: inherit;
  line-height: 1;
  cursor: pointer;
}

.tag-chip__remove:hover,
.tag-chip__remove:focus-visible {
  background: var(--tag-remove-hover);
  outline: none;
}
</style>