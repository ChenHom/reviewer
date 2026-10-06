<?php

class FeeService
{
    public function net($order)
    {
        $gross = $order->amount;
        $fee = $order->fee;
        return $gross - $fee;
    }
}
