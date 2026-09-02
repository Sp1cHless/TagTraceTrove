<script setup lang="ts">
import { ref } from 'vue';
import TagChip from './TagChip.vue';

export interface TagItem {
  id: string;
  label: string;
}

const props = withDefaults(
  defineProps<{
    modelValue: TagItem[];
    removable?: boolean;
  }>(),
  { removable: true },
);

const emit = defineEmits<{
  'update:modelValue': [tags: TagItem[]];
}>();

const draggedId = ref<string>();

function startDrag(tagId: string, event: DragEvent): void {
  draggedId.value = tagId;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
  }
}

function dropOn(targetId: string): void {
  const sourceId = draggedId.value;
  draggedId.value = undefined;
  if (!sourceId || sourceId === targetId) return;

  const sourceIndex = props.modelValue.findIndex((tag) => tag.id === sourceId);
  const targetIndex = props.modelValue.findIndex((tag) => tag.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;

  const reordered = [...props.modelValue];
  const [draggedTag] = reordered.splice(sourceIndex, 1);
  if (!draggedTag) return;

  reordered.splice(targetIndex, 0, draggedTag);
  emit('update:modelValue', reordered);
}

function removeTag(tagId: string): void {
  emit(
    'update:modelValue',
    props.modelValue.filter((tag) => tag.id !== tagId),
  );
}
</script>

<template>
  <div class="tag-board" aria-label="Draggable tags">
    <TagChip
      v-for="tag in modelValue"
      :key="tag.id"
      :data-tag-id="tag.id"
      :label="tag.label"
      draggable
      :removable="removable"
      @dragstart="startDrag(tag.id, $event)"
      @dragend="draggedId = undefined"
      @dragover.prevent
      @drop.prevent="dropOn(tag.id)"
      @remove="removeTag(tag.id)"
    />
  </div>
</template>

<style scoped>
.tag-board {
  display: flex;
  min-height: 3.5rem;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 0.65rem;
  padding: 0.9rem;
  border: 1px dashed var(--border-subtle);
  border-radius: 0.9rem;
  background: var(--surface-muted);
}
</style>