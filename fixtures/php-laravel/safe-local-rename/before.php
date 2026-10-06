<?php

class ExampleService
{
    public function total(int $price, int $quantity): int
    {
        $subtotal = $price * $quantity;

        return $subtotal;
    }
}
