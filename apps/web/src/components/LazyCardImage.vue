<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useAttrs } from 'vue';

defineOptions({ inheritAttrs: false });

const props = defineProps<{
  src: string;
  alt: string;
}>();
const attrs = useAttrs();

const imageElement = ref<HTMLImageElement | null>(null);
const shouldLoad = ref(false);
const hasLoaded = ref(false);
let observer: IntersectionObserver | null = null;

onMounted(() => {
  if (typeof IntersectionObserver === 'undefined' || !imageElement.value) {
    shouldLoad.value = true;
    return;
  }

  observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    shouldLoad.value = true;
    observer?.disconnect();
    observer = null;
  }, { rootMargin: '240px 0px' });
  observer.observe(imageElement.value);
});

onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <img
    v-bind="attrs"
    ref="imageElement"
    :src="shouldLoad ? props.src : undefined"
    :alt="props.alt"
    :style="{ visibility: hasLoaded ? 'visible' : 'hidden' }"
    loading="eager"
    decoding="async"
    @load="hasLoaded = true"
  >
</template>
