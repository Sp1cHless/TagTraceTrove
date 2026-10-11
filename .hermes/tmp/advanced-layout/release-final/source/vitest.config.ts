import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['apps/*/tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    passWithNoTests: false,
  },
});
