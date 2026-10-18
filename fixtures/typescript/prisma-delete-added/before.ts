import type { PrismaClient } from '@prisma/client';

export async function cancelOrder(prisma: PrismaClient, id: string) {
  await prisma.order.update({ where: { id }, data: { status: 'CANCELLED' } });
}
