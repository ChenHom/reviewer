<?php

class CheckoutService
{
    public function checkout($rows)
    {
        foreach ($rows as $row) {
            try {
                $this->deliveries->updateOrCreate($row['attributes'], $row['values']);
            } catch (\Exception $exception) {
                \DB::rollBack();
                return false;
            }
        }
        return true;
    }
}
