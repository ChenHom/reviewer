<?php

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

Route::post('/payments/notify', function (Request $request, Payment $payment) {
    if (!$payment->verificationSign($request->input('data'), $request->input('sign'))) {
        abort(403);
    }
    return $payment->settle($request->input('data'));
});

Route::get('/payments/status', function (Request $request, Payment $payment) {
    return $payment->status($request->input('id'));
});
