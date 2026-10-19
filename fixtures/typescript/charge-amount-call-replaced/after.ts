export async function chargeOrder(gateway: any, order: { id: string; items: number[] }) {
  return gateway.charge(orderSubtotal(order.items), order.id);
}
