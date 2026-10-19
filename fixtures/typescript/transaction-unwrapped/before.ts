export async function debit(prisma: any, walletId: string, amount: number) {
  await prisma.$transaction(async (tx: any) => {
    const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } });
    await tx.wallet.update({ where: { id: walletId }, data: { balance: wallet.balance - amount } });
  });
}
