import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';

export default [
  {
    ignores: ['docs/**', 'fixtures/**', 'node_modules/**', 'analyzers/ts/node_modules/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'tests/**/*.js', 'analyzers/ts/**/*.js'],
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
    files: ['src/**/*.js', 'analyzers/ts/**/*.js'],
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
