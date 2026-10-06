<?php

class OrderService
{
    public function update($order): void
    {
        $this->authorize('update', $order);
        $order->save();
    }
}
