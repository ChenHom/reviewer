<?php

class PaymentRouteServiceProvider
{
    public function map()
    {
        Route::post('/admin/refunds', function (Request $request) {
            $this->verifySign($request->all(), $request->header('X-Sign'));

            return app(RefundService::class)->refundAll($request->input('ids'));
        });

        Route::get('/orders/{id}/status', function (Request $request, $id) {
            return app(OrderService::class)->status($id);
        });
    }
}
