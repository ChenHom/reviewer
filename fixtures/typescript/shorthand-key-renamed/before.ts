export function payload(order: { total: number }) {
  const amount = order.total;
  return { amount };
}
