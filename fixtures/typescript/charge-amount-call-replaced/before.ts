export async function chargeOrder(gateway: any, order: { id: string; items: number[] }) {
  return gateway.charge(orderTotal(order.items), order.id);
}
