/**
 * Preset registry：依名稱組出 interpreter set（語言層 interpreters 一律包含）。
 */
import { CORE_INTERPRETERS } from '../core.js';
import { NODE_PRESET } from './node.js';
import { PAYMENTS_PRESET } from './payments.js';
import { PHP_LARAVEL_PRESET } from './php-laravel.js';

export const PRESETS = Object.freeze({
  'php-laravel': PHP_LARAVEL_PRESET,
  payments: PAYMENTS_PRESET,
  node: NODE_PRESET,
});

/**
 * 各 preset 適用的語言（語言 id，見 `src/review/review.js` 的 `LANGUAGES`）。
 * `payments` 只比對 method 名稱與具名參數，與框架無關。
 */
export const PRESET_LANGUAGES = Object.freeze({
  'php-laravel': Object.freeze(['php']),
  payments: Object.freeze(['php', 'ts']),
  node: Object.freeze(['ts']),
});

/**
 * 依 preset 名稱組出 interpreter set：語言層 interpreters 加上各 preset，id 重複者只保留一次。
 * 指定 `language` 時略過不適用該語言的 preset。
 *
 * @param {string[]} [names=[]] - preset 名稱。
 * @param {{language?: string}} [options={}] - 選項。
 * @returns {object[]} interpreters。
 * @throws {Error} `PRESET_UNKNOWN:<name>`。
 */
export function resolveInterpreters(names = [], { language } = {}) {
  const interpreters = [...CORE_INTERPRETERS];
  for (const name of names) {
    if (!Object.hasOwn(PRESETS, name)) throw new Error(`PRESET_UNKNOWN:${name}`);
    if (language !== undefined && !PRESET_LANGUAGES[name].includes(language)) continue;
    for (const interpreter of PRESETS[name]) {
      if (!interpreters.some(({ id }) => id === interpreter.id)) interpreters.push(interpreter);
    }
  }
  return interpreters;
}
