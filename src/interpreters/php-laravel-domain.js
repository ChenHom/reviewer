/**
 * PHP/Laravel 第一批 deterministic domain interpreters。
 *
 * Adapter 僅輸出 provider-neutral facts；這一層才把 fact 映射成
 * review blockers。每個 interpreter 都有穩定 id/version，會被綁入
 * AnalysisContextBinding。
 */

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

export const TRANSACTION_BOUNDARY_INTERPRETER = Object.freeze({
  id: 'php-laravel-transaction-boundary',
  version: '1.0.0',
  interpret(fact) {
    if (
      fact?.kind !== 'CALL_REMOVED'
      || fact?.properties?.callee !== 'DB::transaction'
    ) {
      return { handled: false };
    }

    return {
      handled: true,
      blockers: ['TRANSACTION_BOUNDARY_REMOVED'],
    };
  },
});

const authorizationCallees = new Set([
  '$this->authorize',
  'Gate::authorize',
]);

export const AUTHORIZATION_GUARD_INTERPRETER = Object.freeze({
  id: 'php-laravel-authorization-guard',
  version: '1.0.0',
  interpret(fact) {
    if (
      fact?.kind !== 'CALL_REMOVED'
      || !authorizationCallees.has(fact?.properties?.callee)
    ) {
      return { handled: false };
    }

    return {
      handled: true,
      blockers: ['AUTHORIZATION_GUARD_REMOVED'],
    };
  },
});

export const PHP_LARAVEL_DOMAIN_INTERPRETERS = Object.freeze([
  PAYMENT_IDEMPOTENCY_INTERPRETER,
  TRANSACTION_BOUNDARY_INTERPRETER,
  AUTHORIZATION_GUARD_INTERPRETER,
]);
