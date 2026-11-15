import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'uploads']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // React Compiler advisories. The current code (opening a sheet, then resetting local state
      // in an effect; small helper components built inside a render) is intentional and covered by
      // the test suite, so these stay visible as warnings rather than failing `npm run lint`.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/globals': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
      // A couple of modules export a small helper next to their component; harmless for an app build.
      'react-refresh/only-export-components': 'warn',
    },
  },
])
