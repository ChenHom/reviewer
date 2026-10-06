<?php

Route::group(['middleware' => ['auth:admin', 'loginBasic:admin']], function () {
    Route::get('/', 'DashboardController@index')->name('dashboard.index');
});
