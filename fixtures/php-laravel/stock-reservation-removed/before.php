<?php

class ShipmentService
{
    public function ship(Order $order): void
    {
        $this->inventory->reserveStock($order->sku, $order->quantity);
        $order->markShipped();
    }
}
