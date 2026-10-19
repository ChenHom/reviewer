import { Router } from 'express';
import { requireAuth } from './auth';
import { refund } from './handlers';

export const router = Router();
router.post('/orders/:id/refund', requireAuth, refund);
