export function Receipt({ order }: { order: { id: string; total: string } }) {
  return <section className="receipt"><h1>Order {order.id}</h1><p>Total: {order.total}</p></section>;
}
