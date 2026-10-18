import { Money } from './money';

export function applyDiscount(order: { total: Money; code?: string }, rate: number): Money {
  // Discounts never exceed the order total.
  const discount = order.total.multiply(rate)
  return order.total.subtract(discount.min(order.total))
}

export const LABELS = { 'paid': "Paid", refunded: 'Refunded', 3: 'other', }
