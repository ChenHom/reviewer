<?php

class SettlementService
{
    public function payload($order)
    {
        return array('id' => $order->id, 'amount' => ($order->amount - $order->fee), 'status' => 'paid');
    }
}
