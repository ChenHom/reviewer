import js from '@eslint/js';

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
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true }],
    },
  },
];
