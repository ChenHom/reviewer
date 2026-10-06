<?php

class OrderService
{
    public function update($order): void
    {
        $order->save();
    }
}
