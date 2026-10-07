<?php

class IwpNotifyHandler
{
    public function requestValidator(array $request)
    {
        $payment = app()->make(Payment::class);
        if (!$payment->verificationSign($request['data'], $request['sign'])) {
            throw new \Exception('notify signature error');
        }
    }
}
