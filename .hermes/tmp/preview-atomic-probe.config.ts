import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';
import root from '../../vitest.config';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
export default defineConfig({...root,resolve:{alias:{'fake-indexeddb':require.resolve('fake-indexeddb')}},test:{...root.test,include:['.hermes/tmp/preview-atomic-probe.test.ts']}});
