import Sale from "../models/Sale.js";
import redis, { CACHE_TTL } from "../utils/redis.js";

const SALE_CACHE_KEY = "sale:active";

export const getActiveSale = async () => {
  // Try Redis cache first
  try {
    const cached = await redis.get(SALE_CACHE_KEY);
    if (cached !== null) {
      return cached === "null" ? null : JSON.parse(cached);
    }
  } catch (err) {
    console.warn("Redis sale cache read error:", err.message);
  }

  const sale = await Sale.findOne({
    isActive: true,
    startDate: { $lte: new Date() },
    endDate: { $gte: new Date() },
  }).lean();

  // Cache result (even null) in Redis
  try {
    await redis.set(SALE_CACHE_KEY, sale ? JSON.stringify(sale) : "null", "EX", CACHE_TTL.SALE);
  } catch (err) {
    console.warn("Redis sale cache write error:", err.message);
  }

  return sale || null;
};

export const clearSaleCache = async () => {
  try { await redis.del(SALE_CACHE_KEY); } catch { /* ignore */ }
  // Also clear home page cache since it includes activeSale data
  try { await redis.del("home:data"); } catch { /* ignore */ }
};

export const overlaySalePricing = (products, sale, isPrime = false) => {
  if (!sale || !sale.categories?.length) return products;

  const catMap = new Map(
    sale.categories.map((c) => [c.category.toLowerCase(), c])
  );

  return products.map((p) => {
    const cat = catMap.get((p.category || "").toLowerCase());
    if (!cat) return p;

    const salePercent =
      isPrime && cat.primeDiscountPercent > 0
        ? cat.primeDiscountPercent
        : cat.discountPercent;

    // Calculate original MRP from current price & discount, then apply sale discount
    const originalMrp = p.discountPercentage > 0
      ? p.price / (1 - p.discountPercentage / 100)
      : p.price * 1.2; // fallback MRP if no existing discount
    const salePrice = Math.round(originalMrp * (1 - salePercent / 100));

    return {
      ...p,
      originalPrice: p.price,
      originalDiscountPercentage: p.discountPercentage,
      price: salePrice,
      discountPercentage: salePercent,
      saleName: sale.name,
      saleId: sale._id,
      onSale: true,
    };
  });
};

export const getActiveSalePublic = async (req, res) => {
  try {
    const sale = await getActiveSale();
    if (!sale) return res.json({ sale: null });
    res.json({ sale });
  } catch (err) {
    console.error("Get active sale error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const listSales = async (req, res) => {
  try {
    const sales = await Sale.find().sort({ createdAt: -1 }).lean();
    res.json(sales);
  } catch (err) {
    console.error("List sales error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const getSaleById = async (req, res) => {
  try {
    const sale = await Sale.findById(req.params.id).lean();
    if (!sale) return res.status(404).json({ message: "Sale not found" });
    res.json(sale);
  } catch (err) {
    console.error("Get sale error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const createSale = async (req, res) => {
  try {
    // Enforce single active sale: deactivate all others when creating an active sale
    if (req.body.isActive !== false) {
      await Sale.updateMany({ isActive: true }, { isActive: false });
    }
    const sale = await Sale.create(req.body);
    clearSaleCache();
    res.status(201).json(sale);
  } catch (err) {
    if (err.code === 11000)
      return res.status(409).json({ message: "Sale slug already exists" });
    console.error("Create sale error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const updateSale = async (req, res) => {
  try {
    // Enforce single active sale: deactivate all others when activating this sale
    if (req.body.isActive === true) {
      await Sale.updateMany({ _id: { $ne: req.params.id }, isActive: true }, { isActive: false });
    }
    const sale = await Sale.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!sale) return res.status(404).json({ message: "Sale not found" });
    clearSaleCache();
    res.json(sale);
  } catch (err) {
    console.error("Update sale error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const deleteSale = async (req, res) => {
  try {
    const sale = await Sale.findByIdAndDelete(req.params.id);
    if (!sale) return res.status(404).json({ message: "Sale not found" });
    clearSaleCache();
    res.json({ message: "Sale deleted" });
  } catch (err) {
    console.error("Delete sale error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};
