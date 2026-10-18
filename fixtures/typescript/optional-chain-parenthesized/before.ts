export function contact(order?: { customer: { email: string } }) {
  return order?.customer.email;
}
