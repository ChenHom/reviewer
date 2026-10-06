<?php

class FreezeService
{
    public function freeze(int $userId, float $amount)
    {
        return $this->repository->create(['user_id' => $userId, 'amount' => $amount]);
    }
}
