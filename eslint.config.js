import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';

export default [
  {
    ignores: ['docs/**', 'fixtures/**', 'node_modules/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: {
        URL: 'readonly',
      },
      sourceType: 'module',
    },
    plugins: {
      jsdoc,
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true }],
    },
  },
  {
    files: ['src/**/*.js'],
    plugins: {
      jsdoc,
    },
    rules: {
      'jsdoc/require-description': 'error',
      'jsdoc/require-jsdoc': ['error', { contexts: ['FunctionDeclaration'] }],
      'jsdoc/require-param-description': 'error',
      'jsdoc/require-returns-description': 'error',
    },
  },
];
