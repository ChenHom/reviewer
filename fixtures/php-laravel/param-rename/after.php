<?php

class FreezeService
{
    public function freeze(int $userId, float $value)
    {
        return $this->repository->create(['user_id' => $userId, 'amount' => $value]);
    }
}
