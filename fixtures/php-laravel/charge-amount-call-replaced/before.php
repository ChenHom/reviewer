<?php

class OrderChargeService
{
    public function charge(Order $order, PaymentGateway $gateway)
    {
        return $gateway->charge($order->grandTotal(), $order->id);
    }
}
