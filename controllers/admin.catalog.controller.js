import { invalidatePattern } from "../utils/redis.js";
import { listAdminProducts, updateProductMeta, updateVariant, bulkSetStatus, AdminEditError } from "../services/catalog.admin.js";

// Admin endpoints for the catalog (mounted at /api/admin/v2). Writes clear the cached
// /api/v2 responses so the storefront shows the change straight away.

const fail = (res, err, where) => {
  if (err instanceof AdminEditError) return res.status(err.status).json({ message: err.message });
  console.error(`admin catalog ${where}:`, err);
  return res.status(500).json({ message: "Server error" });
};

const clearStoreCache = () => invalidatePattern("catalog:*").catch((err) => console.error("catalog cache clear failed:", err.message));

export const listProducts = async (req, res) => {
  try {
    res.json(await listAdminProducts(req.query));
  } catch (err) {
    fail(res, err, "listProducts");
  }
};

export const patchProduct = async (req, res) => {
  try {
    const row = await updateProductMeta(req.params.id, req.body);
    await clearStoreCache();
    res.json(row);
  } catch (err) {
    fail(res, err, "patchProduct");
  }
};

export const bulkStatus = async (req, res) => {
  try {
    const result = await bulkSetStatus(req.body);
    if (result.updated) await clearStoreCache();
    res.json(result);
  } catch (err) {
    fail(res, err, "bulkStatus");
  }
};

export const patchVariant = async (req, res) => {
  try {
    const row = await updateVariant(req.params.id, req.params.sku, req.body);
    await clearStoreCache();
    res.json(row);
  } catch (err) {
    fail(res, err, "patchVariant");
  }
};
