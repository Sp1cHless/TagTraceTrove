import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '.data/**',
      '.hermes/**',
      'spikes/**/android/**',
      'spikes/**/web-dist/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
