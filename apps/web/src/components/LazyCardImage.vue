<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useAttrs, watch } from 'vue';
import {
  cachedMediaObjectUrls,
  type CachedMediaObjectUrlHandle,
} from '../offline/cached-media-object-urls.js';

defineOptions({ inheritAttrs: false });

const props = defineProps<{
  src: string;
  alt: string;
}>();
const attrs = useAttrs();

const imageElement = ref<HTMLImageElement | null>(null);
const shouldLoad = ref(false);
const hasLoaded = ref(false);
const renderedSrc = ref<string>();
let observer: IntersectionObserver | null = null;
let cachedHandle: CachedMediaObjectUrlHandle | null = null;
let fallbackAttemptedFor: string | null = null;
let cacheMissFor: string | null = null;
let loadSequence = 0;

function releaseCachedHandle(): void {
  if (cachedHandle !== null) cachedMediaObjectUrls.release(cachedHandle);
  cachedHandle = null;
}

async function beginLoad(): Promise<void> {
  const source = props.src;
  if (cachedHandle?.sourceUrl === source && renderedSrc.value === cachedHandle.objectUrl) return;
  const sequence = ++loadSequence;
  releaseCachedHandle();
  hasLoaded.value = false;
  if (cacheMissFor === source) {
    if (shouldLoad.value) renderedSrc.value = source;
    return;
  }
  if (typeof globalThis.caches === 'undefined' || typeof URL.createObjectURL !== 'function') {
    if (shouldLoad.value) renderedSrc.value = source;
    return;
  }
  const handle = await cachedMediaObjectUrls.acquire(source);
  if (sequence !== loadSequence || props.src !== source) {
    if (handle !== null) cachedMediaObjectUrls.release(handle);
    return;
  }
  if (handle === null) {
    cacheMissFor = source;
    if (shouldLoad.value) renderedSrc.value = source;
    return;
  }
  cachedHandle = handle;
  hasLoaded.value = handle.loaded;
  renderedSrc.value = handle.objectUrl;
}

watch(() => props.src, () => {
  loadSequence += 1;
  releaseCachedHandle();
  renderedSrc.value = undefined;
  fallbackAttemptedFor = null;
  cacheMissFor = null;
  hasLoaded.value = false;
  if (shouldLoad.value) void beginLoad();
});

async function handleError(): Promise<void> {
  hasLoaded.value = false;
  const source = props.src;
  if (cachedHandle !== null) {
    cachedMediaObjectUrls.discard(cachedHandle);
    cachedHandle = null;
    fallbackAttemptedFor = source;
    renderedSrc.value = source;
    return;
  }
  if (renderedSrc.value !== source || fallbackAttemptedFor === source) return;
  fallbackAttemptedFor = source;
  const sequence = loadSequence;
  const handle = await cachedMediaObjectUrls.acquire(source);
  if (handle === null) return;
  if (sequence !== loadSequence || props.src !== source) {
    cachedMediaObjectUrls.release(handle);
    return;
  }
  cachedHandle = handle;
  hasLoaded.value = handle.loaded;
  renderedSrc.value = handle.objectUrl;
}

function handleLoad(): void {
  hasLoaded.value = true;
  if (cachedHandle !== null) cachedMediaObjectUrls.markLoaded(cachedHandle);
}

onMounted(() => {
  if (typeof IntersectionObserver === 'undefined' || !imageElement.value) {
    shouldLoad.value = true;
    void beginLoad();
    return;
  }

  void beginLoad();
  observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    shouldLoad.value = true;
    void beginLoad();
    observer?.disconnect();
    observer = null;
  }, { rootMargin: '240px 0px' });
  observer.observe(imageElement.value);
});

onBeforeUnmount(() => {
  loadSequence += 1;
  observer?.disconnect();
  releaseCachedHandle();
});
</script>

<template>
  <img
    v-bind="attrs"
    ref="imageElement"
    :src="renderedSrc"
    :alt="hasLoaded ? props.alt : ''"
    :style="{ visibility: hasLoaded ? 'visible' : 'hidden' }"
    loading="eager"
    decoding="async"
    @load="handleLoad"
    @error="handleError"
  >
</template>
