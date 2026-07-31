/**
 * Root ESLint config for Prana OPS (TypeScript, backend + frontend).
 * Uses @typescript-eslint. Type-aware linting is intentionally kept light for
 * the scaffolding phase; stricter rules can be layered in as stories 1.2+ land.
 */
module.exports = {
  root: true,
  env: {
    node: true,
    browser: true,
    es2022: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    'no-console': 'off',
  },
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'build/',
    '**/*.d.ts',
    'web/dist/',
  ],
};
