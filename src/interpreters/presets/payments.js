/**
 * 業務 preset `payments`：金流專案的預設規則（具名參數 `idempotencyKey`、簽章驗證 method 被移除）。
 * 專案可在 `.reviewer.json` 宣告同類規則；不啟用此 preset 的專案不會套用。
 */
import { structuredCallee } from '../../facts/structured.js';

export const PAYMENT_IDEMPOTENCY_INTERPRETER = Object.freeze({
  id: 'php-laravel-payment-idempotency',
  version: '1.0.0',
  interpret(fact) {
    if (
      fact?.kind !== 'CALL_ARGUMENT_CHANGED'
      || fact?.properties?.argument !== 'idempotencyKey'
    ) {
      return { handled: false };
    }

    return {
      handled: true,
      blockers: ['PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED'],
    };
  },
});

export const signatureVerificationMethod = /(verif\w*sign|check\w*sign|validate\w*sign|sign\w*(verif|check|valid))/i;

export const SIGNATURE_VERIFICATION_INTERPRETER = Object.freeze({
  id: 'php-laravel-signature-verification',
  version: '2.0.0',
  interpret(fact) {
    const method = structuredCallee(fact?.properties?.callee)?.name;
    if (
      fact?.kind !== 'CALL_REMOVED'
      || typeof method !== 'string'
      || !signatureVerificationMethod.test(method)
    ) {
      return { handled: false };
    }

    return { handled: true, blockers: ['SIGNATURE_VERIFICATION_REMOVED'] };
  },
});

export const PAYMENTS_PRESET = Object.freeze([
  PAYMENT_IDEMPOTENCY_INTERPRETER,
  SIGNATURE_VERIFICATION_INTERPRETER,
]);
