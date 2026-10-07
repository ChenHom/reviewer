<?php

class LoginController
{
    public function __construct()
    {
        $this->middleware('guest:admin')->except('logout');
    }
}
