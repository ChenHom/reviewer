export async function ship(order: any, mailer: any) {
  await order.markShipped();
  await mailer.send(order.customerEmail, 'shipped');
}
