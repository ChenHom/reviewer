import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createReferenceAdapter } from '../../src/adapters/reference-adapter.js';
import { validateAdapterResult } from '../../src/adapters/contracts.js';

async function fixture(name) {
  const source = await readFile(new URL(`../../fixtures/adapters/${name}.json`, import.meta.url), 'utf8');
  return JSON.parse(source);
}

test('reference adapter 回傳 descriptor 與 fixture 的 deep-cloned AdapterResult', async () => {
  const input = await fixture('mixed-language-blade');
  const adapter = createReferenceAdapter(input);
  const result = await adapter.analyze({ identity: input.identity }, { signal: { aborted: false } });

  assert.deepEqual(adapter.descriptor, input.adapterResult.adapterSet[0]);
  assert.deepEqual(result, input.adapterResult);
  assert.deepEqual(validateAdapterResult(result), { valid: true, errors: [] });

  result.obligations[0].changedRegions[0].path = 'mutated';
  const second = await adapter.analyze({ identity: input.identity }, { signal: { aborted: false } });
  assert.equal(second.obligations[0].changedRegions[0].path, 'resources/views/page.blade.php');
});

test('reference adapter 收到已 aborted signal 時回傳 TIMEOUT AdapterResult', async () => {
  const input = await fixture('mixed-language-blade');
  const adapter = createReferenceAdapter(input);
  const result = await adapter.analyze({ identity: input.identity }, { signal: { aborted: true } });

  assert.equal(result.complete, false);
  assert.equal(result.reasonCode, 'TIMEOUT');
  assert.deepEqual(result.diagnostics, ['TIMEOUT']);
  assert.ok(result.obligations.every(({ status, changedRegions }) =>
    status === 'TIMEOUT' && changedRegions.length === 0));
  assert.deepEqual(validateAdapterResult(result), { valid: true, errors: [] });
});
