import crypto from "crypto";
import redis from "../utils/redis.js";

const CHECKOUT_ORDER_PREFIX = "checkout:order:";
const CHECKOUT_VERIFY_PREFIX = "checkout:verify:";
const MEMBERSHIP_ORDER_PREFIX = "membership:order:";
const WALLET_ORDER_PREFIX = "wallet:order:";
const WEBHOOK_CONFIRM_PREFIX = "webhook:confirmed:";
const CHECKOUT_VERIFIED_PREFIX = "checkout:verified:";
const CHECKOUT_CLAIM_PREFIX = "checkout:claim:";

const CHECKOUT_ORDER_TTL_SEC = 20 * 60; // 20 minutes
const CHECKOUT_VERIFY_TTL_SEC = 15 * 60; // 15 minutes
const MEMBERSHIP_ORDER_TTL_SEC = 20 * 60; // 20 minutes
const WALLET_ORDER_TTL_SEC = 20 * 60; // 20 minutes
const WEBHOOK_CONFIRM_TTL_SEC = 24 * 60 * 60; // 24 hours
const CHECKOUT_CLAIM_TTL_SEC = 2 * 60; // longer than any single order transaction

const safeParse = (raw) => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const setJson = async (key, value, ttlSec) => {
  await redis.set(key, JSON.stringify(value), "EX", ttlSec);
};

const getJson = async (key) => safeParse(await redis.get(key));

// GET + DEL in one MULTI block so two concurrent callers can never both
// receive the same session (the old get-then-del let both through).
const popJson = async (key) => {
  const results = await redis.multi().get(key).del(key).exec();
  const [getErr, raw] = results?.[0] || [];
  if (getErr) throw getErr;
  return safeParse(raw);
};

// Checkout payment session ----------------------------------------------------
export const saveCheckoutOrderSession = async (orderId, payload) => {
  if (!orderId) return;
  await setJson(`${CHECKOUT_ORDER_PREFIX}${orderId}`, payload, CHECKOUT_ORDER_TTL_SEC);
};

export const getCheckoutOrderSession = async (orderId) => {
  if (!orderId) return null;
  return getJson(`${CHECKOUT_ORDER_PREFIX}${orderId}`);
};

export const consumeCheckoutOrderSession = async (orderId) => {
  if (!orderId) return null;
  return popJson(`${CHECKOUT_ORDER_PREFIX}${orderId}`);
};

export const issueCheckoutVerificationToken = async (payload) => {
  const token = crypto.randomBytes(24).toString("hex");
  await setJson(`${CHECKOUT_VERIFY_PREFIX}${token}`, payload, CHECKOUT_VERIFY_TTL_SEC);
  return token;
};

export const discardCheckoutVerificationToken = async (token) => {
  if (!token) return;
  await redis.del(`${CHECKOUT_VERIFY_PREFIX}${token}`);
};

export const consumeCheckoutVerificationToken = async (token) => {
  if (!token) return null;
  return popJson(`${CHECKOUT_VERIFY_PREFIX}${token}`);
};

export const getCheckoutVerificationToken = async (token) => {
  if (!token) return null;
  return getJson(`${CHECKOUT_VERIFY_PREFIX}${token}`);
};

// Makes /razorpay/verify idempotent per Razorpay order: the first successful
// verify records its token, and any repeat (double click, client retry after
// a dropped response) gets that same token back instead of a second one.
// Returns the token that won — ours if we were first, otherwise the earlier one.
export const rememberVerifiedCheckout = async (rzpOrderId, token) => {
  const key = `${CHECKOUT_VERIFIED_PREFIX}${rzpOrderId}`;
  const won = await redis.set(key, token, "EX", CHECKOUT_VERIFY_TTL_SEC, "NX");
  if (won === "OK") return token;
  return (await redis.get(key)) || token;
};

export const getVerifiedCheckoutToken = async (rzpOrderId) => {
  if (!rzpOrderId) return null;
  return redis.get(`${CHECKOUT_VERIFIED_PREFIX}${rzpOrderId}`);
};

// Short-lived lock so only one order-placement request at a time can use a
// given verification token. The unique index on Order.paymentId is the hard
// guarantee; this just turns a concurrent duplicate into a clean 409 early.
export const claimCheckoutVerificationToken = async (token) => {
  if (!token) return false;
  const res = await redis.set(`${CHECKOUT_CLAIM_PREFIX}${token}`, "1", "EX", CHECKOUT_CLAIM_TTL_SEC, "NX");
  return res === "OK";
};

export const releaseCheckoutVerificationClaim = async (token) => {
  if (!token) return;
  await redis.del(`${CHECKOUT_CLAIM_PREFIX}${token}`);
};

// Webhook confirmation record --------------------------------------------------
// Recorded independently of the client's own checkout session (never
// overwrites/consumes it) so a webhook delivered around the same moment as
// the browser's own verify call can't race it. Exists purely so /verify has
// a fallback source of truth if the browser's handler callback never fires
// (tab closed, network drop right after a successful payment).
export const saveWebhookConfirmation = async (orderId, payload) => {
  if (!orderId) return;
  await setJson(`${WEBHOOK_CONFIRM_PREFIX}${orderId}`, payload, WEBHOOK_CONFIRM_TTL_SEC);
};

export const getWebhookConfirmation = async (orderId) => {
  if (!orderId) return null;
  return getJson(`${WEBHOOK_CONFIRM_PREFIX}${orderId}`);
};

export const consumeWebhookConfirmation = async (orderId) => {
  if (!orderId) return null;
  return popJson(`${WEBHOOK_CONFIRM_PREFIX}${orderId}`);
};

// Membership payment session --------------------------------------------------
export const saveMembershipOrderSession = async (orderId, payload) => {
  if (!orderId) return;
  await setJson(`${MEMBERSHIP_ORDER_PREFIX}${orderId}`, payload, MEMBERSHIP_ORDER_TTL_SEC);
};

export const getMembershipOrderSession = async (orderId) => {
  if (!orderId) return null;
  return getJson(`${MEMBERSHIP_ORDER_PREFIX}${orderId}`);
};

export const consumeMembershipOrderSession = async (orderId) => {
  if (!orderId) return null;
  return popJson(`${MEMBERSHIP_ORDER_PREFIX}${orderId}`);
};

// Wallet top-up payment session ----------------------------------------------
export const saveWalletOrderSession = async (orderId, payload) => {
  if (!orderId) return;
  await setJson(`${WALLET_ORDER_PREFIX}${orderId}`, payload, WALLET_ORDER_TTL_SEC);
};

export const getWalletOrderSession = async (orderId) => {
  if (!orderId) return null;
  return getJson(`${WALLET_ORDER_PREFIX}${orderId}`);
};

export const consumeWalletOrderSession = async (orderId) => {
  if (!orderId) return null;
  return popJson(`${WALLET_ORDER_PREFIX}${orderId}`);
};
