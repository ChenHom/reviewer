<?php

class ShipmentService
{
    public function ship(Order $order): void
    {
        $order->markShipped();
        Mail::to($order->customer)->send(new OrderShipped($order));
    }
}
