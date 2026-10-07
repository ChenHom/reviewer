<?php

class SettlementService
{
    public function payload($order)
    {
        return [
            "id" => $order->id,
            "amount" => $order->amount - $order->fee,
            "status" => "paid",
        ];
    }
}
