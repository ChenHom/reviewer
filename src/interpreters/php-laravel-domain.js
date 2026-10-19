/**
 * PHP/Laravel 的預設 interpreter set（相容入口）。
 *
 * Interpreters 已依層拆開：語言層 `core.js`、框架 preset `presets/php-laravel.js`、
 * 業務 preset `presets/payments.js`。`PHP_LARAVEL_DOMAIN_INTERPRETERS` 維持原本的成員，
 * 等同 `resolveInterpreters(['php-laravel', 'payments'])`。
 */
import { CORE_INTERPRETERS } from './core.js';
import { PAYMENTS_PRESET } from './presets/payments.js';
import { PHP_LARAVEL_PRESET } from './presets/php-laravel.js';

export * from './core.js';
export * from './presets/payments.js';
export * from './presets/php-laravel.js';

export const PHP_LARAVEL_DOMAIN_INTERPRETERS = Object.freeze([
  ...PAYMENTS_PRESET,
  ...PHP_LARAVEL_PRESET,
  ...CORE_INTERPRETERS,
]);
