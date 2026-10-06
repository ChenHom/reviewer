<?php

class PaymentService
{
    public function retry($gateway, $requestId, $amount, $attempt)
    {
        return $gateway->charge(
            idempotencyKey: $requestId . ':' . $attempt,
            amount: $amount,
        );
    }
}
