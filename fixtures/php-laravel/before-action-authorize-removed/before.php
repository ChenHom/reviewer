<?php

return new class () extends BaseController {
    protected $beforeActionList = [
        'verifyToken',
        'authorize',
    ];

    public function run()
    {
        return $this->settings->update($this->request->getParams());
    }
};
