import crypto from "crypto";
import redis from "../utils/redis.js";

const CHECKOUT_ORDER_PREFIX = "checkout:order:";
const CHECKOUT_VERIFY_PREFIX = "checkout:verify:";
const MEMBERSHIP_ORDER_PREFIX = "membership:order:";
const WALLET_ORDER_PREFIX = "wallet:order:";

const CHECKOUT_ORDER_TTL_SEC = 20 * 60; // 20 minutes
const CHECKOUT_VERIFY_TTL_SEC = 15 * 60; // 15 minutes
const MEMBERSHIP_ORDER_TTL_SEC = 20 * 60; // 20 minutes
const WALLET_ORDER_TTL_SEC = 20 * 60; // 20 minutes

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

const popJson = async (key) => {
  const value = await getJson(key);
  if (value) await redis.del(key);
  return value;
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

export const consumeCheckoutVerificationToken = async (token) => {
  if (!token) return null;
  return popJson(`${CHECKOUT_VERIFY_PREFIX}${token}`);
};

export const getCheckoutVerificationToken = async (token) => {
  if (!token) return null;
  return getJson(`${CHECKOUT_VERIFY_PREFIX}${token}`);
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
