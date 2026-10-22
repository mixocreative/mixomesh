import globals from 'globals';

export default [
  { ignores: ['dist/', 'node_modules/', 'public/', '.tmp/', '.audit/', '.npm-cache/', '**/*.ts'] },
  {
    files: ['src/**/*.js', 'tests/**/*.mjs', 'scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        BABYLON: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-undef': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-imports': 'error',
      'no-unreachable': 'error',
      'no-async-promise-executor': 'error',
      'no-fallthrough': 'error'
    }
  },
  {
    // Electron main/preload + the Listbridge host-side runner (CommonJS, Node).
    files: ['electron/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-async-promise-executor': 'error',
      'no-fallthrough': 'error'
    }
  },
  {
    // Test harnesses and dev scripts report via stdout by design.
    files: ['tests/**/*.mjs', 'scripts/**/*.mjs'],
    rules: { 'no-console': 'off' }
  }
];
