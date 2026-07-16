import globals from 'globals';

export default [
  { ignores: ['dist/', 'node_modules/', 'public/', '.tmp/', '.npm-cache/', '**/*.ts'] },
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
    // Test harnesses and dev scripts report via stdout by design.
    files: ['tests/**/*.mjs', 'scripts/**/*.mjs'],
    rules: { 'no-console': 'off' }
  }
];
