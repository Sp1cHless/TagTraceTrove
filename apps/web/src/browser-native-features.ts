// Evaluated before polyfills so diagnostics distinguish native support.
export const nativeBrowserFeatures = {
  structuredClone: typeof globalThis.structuredClone === 'function',
  arrayAt: typeof Array.prototype.at === 'function',
  objectHasOwn: typeof Object.hasOwn === 'function',
};
