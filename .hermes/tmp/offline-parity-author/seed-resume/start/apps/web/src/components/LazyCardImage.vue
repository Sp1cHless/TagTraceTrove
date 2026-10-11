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
  /**
   * Bump to re-read the picture's bytes from the server.
   *
   * Media is addressed by position, so an edited list hands out the same URL
   * for different bytes — and neither Vue's patch nor the browser re-reads an
   * image whose URL did not change. This path fetches with `cache: 'no-cache'`
   * and renders the result as an object URL, which is guaranteed to be the
   * bytes the server holds now.
   */
  refreshToken?: number;
  /**
   * Keep the previously loaded picture visible while the next one loads.
   *
   * A paged viewer must not drop its picture between pages: clearing first
   * collapses the whole media area (the pager and counter pile into the
   * corner) and reads as the image disappearing. Cards keep the default,
   * which clears before loading.
   */
  keepLastOnSrcChange?: boolean;
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
  if (!props.keepLastOnSrcChange) renderedSrc.value = undefined;
  fallbackAttemptedFor = null;
  cacheMissFor = null;
  hasLoaded.value = props.keepLastOnSrcChange && renderedSrc.value !== undefined;
  if (shouldLoad.value) void beginLoad();
});

let forcedUrl: string | null = null;
function releaseForcedUrl(): void {
  if (forcedUrl !== null) {
    URL.revokeObjectURL(forcedUrl);
    forcedUrl = null;
  }
}
async function reloadForced(): Promise<void> {
  const source = props.src;
  const sequence = ++loadSequence;
  releaseForcedUrl();
  releaseCachedHandle();
  hasLoaded.value = false;
  try {
    const response = await fetch(source, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Media request returned ${response.status}`);
    const objectUrl = URL.createObjectURL(await response.blob());
    if (sequence !== loadSequence || props.src !== source) {
      URL.revokeObjectURL(objectUrl);
      return;
    }
    forcedUrl = objectUrl;
    renderedSrc.value = objectUrl;
  } catch {
    // Fall back to whatever the address serves; a stale picture beats none.
    if (sequence === loadSequence) renderedSrc.value = source;
  }
}
let lastToken = props.refreshToken;
watch(() => props.refreshToken, (token) => {
  if (token === undefined || token === lastToken) return;
  lastToken = token;
  void reloadForced();
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
  releaseForcedUrl();
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
