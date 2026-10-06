<?php

class ExampleService
{
    public function total(int $price, int $quantity): int
    {
        $total = $price * $quantity;

        return $total;
    }
}
