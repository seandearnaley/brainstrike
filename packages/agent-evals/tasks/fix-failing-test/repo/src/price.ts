/** A cart's total in cents after a percentage discount, rounded to the nearest cent. */
export function totalWithDiscount(
  pricesInCents: readonly number[],
  discountPercent: number
): number {
  const subtotal = pricesInCents.reduce((sum, price) => sum + price, 0);
  return Math.round((subtotal * discountPercent) / 100);
}
