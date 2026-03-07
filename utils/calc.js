export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const computeTotals = ({ products = [], shipping = 0, taxRate }) => {
  const subtotal = round2(products.reduce((s, p) => s + p.quantity * p.price, 0));
  const effectiveRate = Number(taxRate) / (1 + Number(taxRate));
  const tax = round2(subtotal * effectiveRate);
  const totalPrice = round2(subtotal + round2(shipping));
  return { subtotal, tax, totalPrice };
};
