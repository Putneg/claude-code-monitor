import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier/flat';

export default defineConfig(
  globalIgnores([
    'dist/',
    'coverage/',
    '.superpowers/',
    '.e2e-data/',
    '.vitest/',
    'test-results/',
    'playwright-report/',
    'data/',
    'src/server/pricing/snapshot.ts',
  ]),
  js.configs.recommended,
  // For every file, not only .ts: in .svelte scripts it replaces core no-unused-vars, which reports the
  // parameter names of function types (onPreset: (preset: Preset) => void) as unused variables.
  tseslint.configs.recommended,
  {
    // Same rule as tsc's noUnusedParameters: a leading underscore marks a parameter that is unused on purpose.
    rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: {
          // src/web/main.ts is the one .ts file outside tsconfig.json; it is checked with tsconfig.web.json's options.
          allowDefaultProject: ['src/web/main.ts'],
          defaultProject: 'tsconfig.web.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  svelte.configs.recommended,
  {
    files: ['**/*.svelte'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
    // Every component is `lang="ts"`: svelte-check reports unknown names, and core no-undef
    // would flag type-only DOM names such as `AddEventListenerOptions`.
    rules: { 'no-undef': 'off' },
  },
  {
    files: ['src/server/**', 'src/shared/**', 'scripts/**', 'tests/**', '*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/web/**'],
    languageOptions: { globals: globals.browser },
  },
  // Last, so it wins: turns off the rules that conflict with Prettier's layout.
  eslintConfigPrettier,
);
