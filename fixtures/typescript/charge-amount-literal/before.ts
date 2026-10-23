export async function chargeOrder(gateway: any, order: { id: string }) {
  return gateway.charge(100, order.id);
}
