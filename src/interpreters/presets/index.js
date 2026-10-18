/**
 * Preset registry：依名稱組出 interpreter set（語言層 interpreters 一律包含）。
 */
import { CORE_INTERPRETERS } from '../core.js';
import { PAYMENTS_PRESET } from './payments.js';
import { PHP_LARAVEL_PRESET } from './php-laravel.js';

export const PRESETS = Object.freeze({
  'php-laravel': PHP_LARAVEL_PRESET,
  payments: PAYMENTS_PRESET,
});

/**
 * 依 preset 名稱組出 interpreter set：語言層 interpreters 加上各 preset，id 重複者只保留一次。
 *
 * @param {string[]} [names=[]] - preset 名稱。
 * @returns {object[]} interpreters。
 * @throws {Error} `PRESET_UNKNOWN:<name>`。
 */
export function resolveInterpreters(names = []) {
  const interpreters = [...CORE_INTERPRETERS];
  for (const name of names) {
    if (!Object.hasOwn(PRESETS, name)) throw new Error(`PRESET_UNKNOWN:${name}`);
    for (const interpreter of PRESETS[name]) {
      if (!interpreters.some(({ id }) => id === interpreter.id)) interpreters.push(interpreter);
    }
  }
  return interpreters;
}
