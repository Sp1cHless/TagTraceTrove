<script setup lang="ts">
import AppIcon from './AppIcon.vue';
import type { IconName } from './icons.js';

/**
 * Pure icon button (icon brief §9): a native 44×44 button whose accessible
 * name doubles as the tooltip copy. Undeclared attributes (data-testid,
 * aria-pressed, aria-expanded, aria-controls, listeners) fall through to the
 * root button, so pages keep their existing wiring.
 */
withDefaults(defineProps<{
  icon: IconName;
  label: string;
  active?: boolean;
  disabled?: boolean;
  size?: 16 | 20 | 24;
}>(), {
  active: false,
  disabled: false,
  size: 20,
});
</script>

<template>
  <button
    type="button"
    class="icon-button"
    :class="`icon-button--${icon}`"
    :data-active="active ? 'true' : undefined"
    :disabled="disabled"
    :aria-label="label"
  >
    <AppIcon :name="icon" :size="size" />
    <span class="icon-tooltip" aria-hidden="true">{{ label }}</span>
  </button>
</template>
