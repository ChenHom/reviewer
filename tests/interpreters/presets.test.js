import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalInterpreterSet, validateFactInterpreters } from '../../src/facts/interpreter.js';
import { CORE_INTERPRETERS } from '../../src/interpreters/core.js';
import { PHP_LARAVEL_DOMAIN_INTERPRETERS } from '../../src/interpreters/php-laravel-domain.js';
import { PRESETS, resolveInterpreters } from '../../src/interpreters/presets/index.js';
import { LANGUAGES, languageFor } from '../../src/review/review.js';

test('php-laravel + payments 組出的 set 與原本的 PHP_LARAVEL_DOMAIN_INTERPRETERS 相同', () => {
  const resolved = resolveInterpreters(['php-laravel', 'payments']);
  assert.deepEqual(canonicalInterpreterSet(resolved), canonicalInterpreterSet(PHP_LARAVEL_DOMAIN_INTERPRETERS));
  assert.equal(PHP_LARAVEL_DOMAIN_INTERPRETERS.length, 18);
  assert.deepEqual(validateFactInterpreters(resolved), { valid: true, errors: [] });
});

test('語言層 interpreters 一律包含，preset 重複指定時不重複加入', () => {
  assert.deepEqual(resolveInterpreters([]), [...CORE_INTERPRETERS]);
  const twice = resolveInterpreters(['payments', 'payments']);
  assert.equal(twice.length, CORE_INTERPRETERS.length + PRESETS.payments.length);
  assert.throws(() => resolveInterpreters(['no-such-preset']), /PRESET_UNKNOWN:no-such-preset/);
});

test('languageFor 依副檔名選擇語言，不支援的副檔名回傳 null', () => {
  assert.equal(languageFor('app/Services/A.php').id, 'php');
  assert.equal(languageFor('app/Services/A.PHP').id, 'php');
  assert.equal(languageFor('README.md'), null);
  assert.equal(languageFor('a.php.bak'), null);
  for (const language of LANGUAGES) {
    for (const preset of language.presets) assert.ok(Object.hasOwn(PRESETS, preset), preset);
  }
});
