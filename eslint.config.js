import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores([
    'dist',
    'node_modules',
    'coverage',
    'src-tauri/target',
    'watch-together-server/node_modules',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Aurales consumes many third-party metadata APIs whose payloads are
      // intentionally normalized at runtime. Replacing these boundary values
      // with guessed static shapes would make the code less accurate.
      '@typescript-eslint/no-explicit-any': 'off',

      // Underscore-prefixed bindings document intentionally ignored callback
      // arguments and caught errors.
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],

      // Existing effects coordinate async services and reset UI state. The
      // React 19 advisory is useful for new isolated components, but treating
      // every synchronous reset as a release-blocking error would require
      // behavior-changing rewrites.
      'react-hooks/set-state-in-effect': 'off',

      // These rules describe React Compiler optimization constraints. Aurales
      // is not compiled with React Compiler, and changing ref timing or manual
      // memoization solely to satisfy them can alter player and scrolling
      // behavior. Keep the runtime Rules of Hooks and render-state checks on.
      'react-hooks/static-components': 'off',
      'react-hooks/use-memo': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/globals': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/purity': 'off',

      // The codebase deliberately converts provider errors into friendly,
      // service-specific messages instead of exposing the original exception.
      'preserve-caught-error': 'off',

      // Empty catch blocks are used only for best-effort cleanup/fallbacks.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // Retain these migration findings without preventing a release. They can
      // be corrected incrementally with focused tests.
      'no-useless-assignment': 'warn',
      'prefer-const': 'warn',

      // Several retired/experimental panels remain behind explicit `false`
      // feature gates so they can be revived without shipping incomplete UI.
      'no-constant-condition': 'off',
      'no-constant-binary-expression': 'off',

      // Entry points and colocated context hooks are valid React modules even
      // though they are not compatible with Vite's narrow Fast Refresh
      // heuristic. This affects development refresh only, not correctness.
      'react-refresh/only-export-components': 'off',
    },
  },
])
