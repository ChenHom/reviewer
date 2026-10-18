export class WalletService {
  debit(wallet: { balance: number }, amount: number) {
    wallet.balance = wallet.balance + amount;
    return wallet;
  }
}
