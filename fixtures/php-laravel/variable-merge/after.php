<?php

class FeeService
{
    public function net($order)
    {
        $gross = $order->amount;
        $gross = $order->fee;
        return $gross - $gross;
    }
}
