<?php

class ShipmentService
{
    public function ship(Order $order): void
    {
        $order->markShipped();
    }
}
