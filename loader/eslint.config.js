import js from '@eslint/js'
import globals from 'globals'

export default [
  { ignores: ['node_modules/', 'cache/'] },
  js.configs.recommended,
  { languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } } },
  { files: ['public/**'], languageOptions: { globals: { ...globals.browser } } },
]
