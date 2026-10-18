export function settle(entries: { amount: number }[]): number {
  let sum = 0;
  for (const entry of entries) {
    const value = entry.amount;
    sum += value;
  }
  return sum;
}
