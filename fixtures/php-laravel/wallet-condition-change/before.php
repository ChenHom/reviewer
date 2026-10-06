<?php

class WalletService
{
    public function canDebit(int $balance, int $amount): bool
    {
        return $balance < $amount;
    }
}
