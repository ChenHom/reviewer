import test from 'node:test';
import assert from 'node:assert/strict';

import { globToRegExp, stringMatcher } from '../../src/config/matchers.js';
import { POLICY_FILES, createProjectPolicy, parseProjectConfig } from '../../src/config/project-config.js';
import { canonicalInterpreterSet } from '../../src/facts/interpreter.js';
import { PHP_LARAVEL_DOMAIN_INTERPRETERS } from '../../src/interpreters/php-laravel-domain.js';
import { DEFAULT_ONE_WAY_DOORS } from '../../src/routing.js';

const php = { id: 'php', presets: ['php-laravel', 'payments'] };

const full = {
  version: 1,
  presets: ['php-laravel'],
  rules: {
    sensitiveOperands: [{ pattern: '/wallet|balance|amount/i', operators: 'arithmetic' }],
    protectedCalls: [{ name: 'verifySignature' }, { receiver: 'Gate', name: 'authorize' }],
    protectedArguments: [{ argument: 'idempotencyKey', blocker: 'PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED' }, { argument: 0, name: 'charge' }],
    sideEffectCalls: [{ receiver: 'Mail', name: '/^(send|queue)$/' }],
    protectedPaths: ['database/migrations/**', 'config/payment.php'],
    oneWayDoors: ['CONSTANT_VALUE_CHANGED'],
  },
};

test('完整的設定可以解析，digest 與 key 順序無關', () => {
  const parsed = parseProjectConfig(JSON.stringify(full));
  assert.equal(parsed.valid, true);
  assert.match(parsed.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(parsed.config.presets, ['php-laravel']);

  const reordered = { rules: full.rules, presets: full.presets, version: 1 };
  assert.equal(parseProjectConfig(JSON.stringify(reordered)).digest, parsed.digest);
  assert.notEqual(parseProjectConfig(JSON.stringify({ ...full, presets: ['payments'] })).digest, parsed.digest);

  const minimal = parseProjectConfig('{"version":1}');
  assert.equal(minimal.valid, true);
  assert.equal(minimal.config.presets, null);
  assert.deepEqual(minimal.config.rules.protectedPaths, []);
});

test('任何未知欄位、型別錯誤或無效規則都使設定無效（fail-closed）', () => {
  const invalid = (config) => parseProjectConfig(typeof config === 'string' ? config : JSON.stringify(config));
  const cases = [
    ['{', 'POLICY_CONFIG_PARSE_ERROR'],
    ['[]', 'POLICY_CONFIG_FIELD_INVALID:$'],
    [{}, 'POLICY_CONFIG_VERSION_UNSUPPORTED'],
    [{ version: 2 }, 'POLICY_CONFIG_VERSION_UNSUPPORTED'],
    [{ version: 1, ignore: ['X'] }, 'POLICY_CONFIG_KEY_UNKNOWN:ignore'],
    [{ version: 1, presets: 'php-laravel' }, 'POLICY_CONFIG_FIELD_INVALID:presets'],
    [{ version: 1, presets: ['laravel'] }, 'POLICY_CONFIG_PRESET_UNKNOWN:laravel'],
    [{ version: 1, rules: [] }, 'POLICY_CONFIG_FIELD_INVALID:rules'],
    [{ version: 1, rules: { ignoreFacts: [] } }, 'POLICY_CONFIG_KEY_UNKNOWN:rules.ignoreFacts'],
    [{ version: 1, rules: { sensitiveOperands: [{ pattern: 'amount' }] } }, 'POLICY_CONFIG_FIELD_INVALID:rules.sensitiveOperands[0].pattern'],
    [{ version: 1, rules: { sensitiveOperands: [{ pattern: '/(/' }] } }, 'POLICY_CONFIG_REGEX_INVALID:rules.sensitiveOperands[0].pattern'],
    [{ version: 1, rules: { sensitiveOperands: [{ operators: 'any' }] } }, 'POLICY_CONFIG_FIELD_INVALID:rules.sensitiveOperands[0]'],
    [{ version: 1, rules: { sensitiveOperands: [{ pattern: '/a/', operators: 'bitwise' }] } }, 'POLICY_CONFIG_FIELD_INVALID:rules.sensitiveOperands[0].operators'],
    [{ version: 1, rules: { sensitiveOperands: {} } }, 'POLICY_CONFIG_FIELD_INVALID:rules.sensitiveOperands'],
    [{ version: 1, rules: { protectedCalls: ['verify'] } }, 'POLICY_CONFIG_FIELD_INVALID:rules.protectedCalls[0]'],
    [{ version: 1, rules: { protectedCalls: [{}] } }, 'POLICY_CONFIG_FIELD_INVALID:rules.protectedCalls[0]'],
    [{ version: 1, rules: { protectedCalls: [{ name: '' }] } }, 'POLICY_CONFIG_FIELD_INVALID:rules.protectedCalls[0].name'],
    [{ version: 1, rules: { protectedCalls: [{ method: 'x' }] } }, 'POLICY_CONFIG_KEY_UNKNOWN:rules.protectedCalls[0].method'],
    [{ version: 1, rules: { sideEffectCalls: [{ receiver: 1 }] } }, 'POLICY_CONFIG_FIELD_INVALID:rules.sideEffectCalls[0].receiver'],
    [{ version: 1, rules: { protectedArguments: [{ name: 'charge' }] } }, 'POLICY_CONFIG_FIELD_INVALID:rules.protectedArguments[0]'],
    [{ version: 1, rules: { protectedArguments: [{ argument: -1 }] } }, 'POLICY_CONFIG_FIELD_INVALID:rules.protectedArguments[0].argument'],
    [{ version: 1, rules: { protectedArguments: [{ argument: 'k', blocker: 'lower' }] } }, 'POLICY_CONFIG_FIELD_INVALID:rules.protectedArguments[0].blocker'],
    [{ version: 1, rules: { protectedPaths: [''] } }, 'POLICY_CONFIG_FIELD_INVALID:rules.protectedPaths'],
    [{ version: 1, rules: { oneWayDoors: ['not a code'] } }, 'POLICY_CONFIG_FIELD_INVALID:rules.oneWayDoors'],
    [{ version: 1, routing: { aiTrackPaths: ['tests/**'] } }, 'POLICY_CONFIG_KEY_UNKNOWN:routing'],
  ];
  for (const [config, error] of cases) {
    const result = invalid(config);
    assert.equal(result.valid, false, JSON.stringify(config));
    assert.ok(result.errors.includes(error), `${JSON.stringify(config)} → ${result.errors}`);
  }
});

test('glob 與字串比對器', () => {
  const glob = (pattern, path) => globToRegExp(pattern).test(path);
  assert.equal(glob('database/migrations/**', 'database/migrations/2024_01_01_x.php'), true);
  assert.equal(glob('database/migrations/**', 'database/migrations/sub/x.php'), true);
  assert.equal(glob('database/migrations/**', 'database/seeds/x.php'), false);
  assert.equal(glob('**/*.md', 'README.md'), true);
  assert.equal(glob('**/*.md', 'docs/a/b.md'), true);
  assert.equal(glob('docs/*.md', 'docs/a/b.md'), false);
  assert.equal(glob('config/payment.php', 'config/paymentXphp'), false);
  assert.equal(glob('src/?.php', 'src/a.php'), true);
  assert.equal(glob('src/?.php', 'src/ab.php'), false);

  assert.equal(stringMatcher('reserveStock')('reserveStock'), true);
  assert.equal(stringMatcher('reserveStock')('reserveStockLater'), false);
  const regex = stringMatcher('/^check\\w*permission$/gi');
  assert.equal(regex('checkPermission'), true);
  assert.equal(regex('checkPermission'), true, 'g 旗標不可讓 test() 帶狀態');
  assert.throws(() => stringMatcher('/(/'), SyntaxError);
});

test('沒有設定時 policy 為預設值', () => {
  const policy = createProjectPolicy(null);
  assert.equal(policy.digest, null);
  assert.deepEqual(canonicalInterpreterSet(policy.interpretersFor(php)), canonicalInterpreterSet(PHP_LARAVEL_DOMAIN_INTERPRETERS));
  assert.deepEqual(policy.oneWayDoors, DEFAULT_ONE_WAY_DOORS);
  assert.equal(policy.isProtectedPath('database/migrations/x.php'), false);
  assert.deepEqual(POLICY_FILES, ['.reviewer.json', 'codingstandards.md']);
});

test('設定的 preset、規則、單向門與路徑都反映在 policy', () => {
  const parsed = parseProjectConfig(JSON.stringify(full));
  const policy = createProjectPolicy(parsed);
  const ids = policy.interpretersFor(php).map(({ id }) => id);
  assert.ok(ids.includes('php-laravel-transaction-boundary'));
  assert.ok(!ids.includes('php-laravel-payment-idempotency'), '只啟用 php-laravel preset');
  const rules = policy.interpretersFor(php).find(({ id }) => id === 'config-rules');
  assert.equal(rules.version, `1.0.0+${parsed.digest.slice(0, 16)}`);

  assert.ok(policy.oneWayDoors.includes('CONSTANT_VALUE_CHANGED'));
  assert.ok(policy.oneWayDoors.includes('PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED'));
  assert.ok(DEFAULT_ONE_WAY_DOORS.every((door) => policy.oneWayDoors.includes(door)), '不能移除預設單向門');
  assert.equal(policy.isProtectedPath('config/payment.php'), true);
  assert.equal(policy.isProtectedPath('config/app.php'), false);

  // 只有 protectedPaths 時不加入規則引擎
  const pathsOnly = createProjectPolicy(parseProjectConfig('{"version":1,"rules":{"protectedPaths":["a/**"]}}'));
  assert.ok(!pathsOnly.interpretersFor(php).some(({ id }) => id === 'config-rules'));
});
