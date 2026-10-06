<?php

class WalletService
{
    public function debit($wallet): void
    {
        $wallet->debit();
    }
}
