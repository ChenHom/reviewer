export async function chargeOrder(gateway: any, order: { id: string }) {
  return gateway.charge(1000, order.id);
}
