import { z } from 'zod';

export const TransferBody = z.object({
  amount: z.number().int().min(1),
  to: z.string().uuid(),
});
