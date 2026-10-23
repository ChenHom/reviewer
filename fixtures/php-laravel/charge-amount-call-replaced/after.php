<?php

class OrderChargeService
{
    public function charge(Order $order, PaymentGateway $gateway)
    {
        return $gateway->charge($order->subtotal(), $order->id);
    }
}
