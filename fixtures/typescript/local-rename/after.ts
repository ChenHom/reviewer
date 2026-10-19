export function settle(entries: { amount: number }[]): number {
  let total = 0;
  for (const item of entries) {
    const amount = item.amount;
    total += amount;
  }
  return total;
}
