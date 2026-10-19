export function payload(order: { total: number }) {
  const total = order.total;
  return { total };
}
