export async function debit(prisma: any, walletId: string, amount: number) {
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
  await prisma.wallet.update({ where: { id: walletId }, data: { balance: wallet.balance - amount } });
}
