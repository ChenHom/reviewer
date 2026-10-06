<?php

class IwpNotifyHandler
{
    public function requestValidator(array $request)
    {
        $payment = app()->make(Payment::class);
    }
}
