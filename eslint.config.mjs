import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '.data/**', '.hermes/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
