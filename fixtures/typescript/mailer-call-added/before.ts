export async function ship(order: any, mailer: any) {
  await order.markShipped();
}
