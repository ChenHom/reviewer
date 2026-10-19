export async function transfer(sequelize: any, Account: any, from: number, to: number, amount: number) {
  return sequelize.transaction(async (t: any) => {
    await Account.decrement('balance', { by: amount, where: { id: from }, transaction: t });
    await Account.increment('balance', { by: amount, where: { id: to } });
  });
}
