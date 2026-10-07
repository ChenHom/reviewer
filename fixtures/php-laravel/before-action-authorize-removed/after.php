<?php

return new class () extends BaseController {
    protected $beforeActionList = [
        'verifyToken',
    ];

    public function run()
    {
        return $this->settings->update($this->request->getParams());
    }
};
