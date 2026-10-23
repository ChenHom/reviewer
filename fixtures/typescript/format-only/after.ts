import { Money } from "./money";

/**
 * Applies a discount rate to the order total.
 */
export function applyDiscount(
  order: { total: Money; code?: string },
  rate: number,
): Money {
  const discount = (order.total.multiply(rate));
  return order.total.subtract(discount.min(order.total)); // never exceeds the total
}

export const LABELS = { paid: "Paid", refunded: "Refunded", "3": "other" };
