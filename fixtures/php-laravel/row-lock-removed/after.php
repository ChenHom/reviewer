<?php

class FreezeObserver
{
    public function created($model)
    {
        \DB::transaction(function () use ($model) {
            $cashFlow = CashFlow::query()->find($model->cash_flows_id);
            $cashFlow->update(['amount' => $cashFlow->amount - $model->amount]);
        });
    }
}
