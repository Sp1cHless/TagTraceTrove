import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.integration.test.ts'],
    exclude: [...configDefaults.exclude, '.hermes/**'],
    passWithNoTests: false,
  },
});
