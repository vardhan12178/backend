import crypto from "crypto";

// Normalizes a Mongo ObjectId, populated doc, {$oid} literal, or plain string
// into a comparable string id. Previously duplicated (identically) across
// order.controller.js, wallet.controller.js, membership.controller.js, and
// payment.controller.js.
export const toIdString = (v) => {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    if (typeof v.toHexString === "function") return v.toHexString();
    if (typeof v.$oid === "string") return v.$oid;
    if (typeof v.id === "string") return v.id;
    if (v._id) return toIdString(v._id);
  }
  return String(v);
};

// Constant-time string comparison, used for verifying Razorpay webhook/
// payment signatures. Previously duplicated (identically) across
// wallet.controller.js, membership.controller.js, and payment.controller.js.
export const secureEqual = (a, b) => {
  const aBuf = Buffer.from(String(a || ""), "utf8");
  const bBuf = Buffer.from(String(b || ""), "utf8");
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
};
