import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mergeConfig } from 'vitest/config';
import base from '../../vitest.config.js';
const target = resolve('apps/web/src/offline/offline-api.ts').replace(/\\/g, '/');
const candidate = resolve('.hermes/tmp/recovery3-bundle-candidate.ts');
export default mergeConfig(base, {
  plugins: [{ name: 'recovery-candidate-isolated-input', enforce: 'pre', load(id: string) {
    if (id.replace(/\\/g, '/').split('?')[0] === target) return readFileSync(candidate, 'utf8');
  } }],
});
