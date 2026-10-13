import { nativeBrowserFeatures } from './browser-native-features.js';
import 'core-js/actual/structured-clone';
import 'core-js/actual/array/at';
import 'core-js/actual/object/has-own';

export function browserCompatibilityReport() {
  const cssSupports = (value: string): boolean => globalThis.CSS?.supports?.(value) === true;
  return {
    target: 'Chromium/WebView 90+',
    nativeFeatures: nativeBrowserFeatures,
    polyfills: Object.entries(nativeBrowserFeatures).filter(([, supported]) => !supported).map(([name]) => name),
    secureContext: globalThis.isSecureContext,
    indexedDB: typeof globalThis.indexedDB !== 'undefined',
    cacheStorage: typeof globalThis.caches !== 'undefined',
    clipboard: typeof navigator.clipboard?.writeText === 'function',
    storageEstimate: typeof navigator.storage?.estimate === 'function',
    storagePersistence: typeof navigator.storage?.persist === 'function',
    webCrypto: typeof globalThis.crypto?.subtle?.digest === 'function',
    rangeMediaQueries: globalThis.matchMedia?.('(width >= 0px)').matches === true,
    containerQueries: cssSupports('container-type: inline-size'),
    colorMix: cssSupports('color: color-mix(in srgb, black, white)'),
    dynamicViewport: cssSupports('height: 100dvh'),
  };
}
