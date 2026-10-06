<?php

Route::group(['middleware' => ['loginBasic:admin']], function () {
    Route::get('/', 'DashboardController@index')->name('dashboard.index');
});
