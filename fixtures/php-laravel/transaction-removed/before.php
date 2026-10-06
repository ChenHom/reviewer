<?php

class WalletService
{
    public function debit($wallet): void
    {
        DB::transaction(function () use ($wallet) {
            $wallet->debit();
        });
    }
}
