import Pincode from "../models/Pincode.js";

// Delivery estimates for product pages.
//
// PIN codes are checked against India Post's directory (the `pincodes` collection, filled by
// scripts/pincodes/import.js). Until that import has run, the first digits of the PIN code are
// used instead: they encode the postal circle, so they still give the state.
//
// The dates are estimates for this demo store: zones are measured from sample warehouses,
// not from a courier's serviceability API.

export const PIN_RE = /^[1-9][0-9]{5}$/;

// Warehouses the zones are measured from
export const HUBS = [
  { city: "Delhi NCR", lat: 28.61, lng: 77.21 },
  { city: "Mumbai", lat: 19.08, lng: 72.88 },
  { city: "Bengaluru", lat: 12.97, lng: 77.59 },
  { city: "Hyderabad", lat: 17.39, lng: 78.49 },
  { city: "Chennai", lat: 13.08, lng: 80.27 },
  { city: "Kolkata", lat: 22.57, lng: 88.36 },
];

// Postal circles by the first two digits, with the 3- and 4-digit exceptions inside them
const BY_2 = {
  11: "Delhi", 12: "Haryana", 13: "Haryana", 14: "Punjab", 15: "Punjab", 16: "Punjab",
  17: "Himachal Pradesh", 18: "Jammu and Kashmir", 19: "Jammu and Kashmir",
  20: "Uttar Pradesh", 21: "Uttar Pradesh", 22: "Uttar Pradesh", 23: "Uttar Pradesh", 24: "Uttar Pradesh",
  25: "Uttar Pradesh", 26: "Uttar Pradesh", 27: "Uttar Pradesh", 28: "Uttar Pradesh",
  30: "Rajasthan", 31: "Rajasthan", 32: "Rajasthan", 33: "Rajasthan", 34: "Rajasthan",
  36: "Gujarat", 37: "Gujarat", 38: "Gujarat", 39: "Gujarat",
  40: "Maharashtra", 41: "Maharashtra", 42: "Maharashtra", 43: "Maharashtra", 44: "Maharashtra",
  45: "Madhya Pradesh", 46: "Madhya Pradesh", 47: "Madhya Pradesh", 48: "Madhya Pradesh", 49: "Chhattisgarh",
  50: "Telangana", 51: "Andhra Pradesh", 52: "Andhra Pradesh", 53: "Andhra Pradesh",
  56: "Karnataka", 57: "Karnataka", 58: "Karnataka", 59: "Karnataka",
  60: "Tamil Nadu", 61: "Tamil Nadu", 62: "Tamil Nadu", 63: "Tamil Nadu", 64: "Tamil Nadu",
  67: "Kerala", 68: "Kerala", 69: "Kerala",
  70: "West Bengal", 71: "West Bengal", 72: "West Bengal", 73: "West Bengal", 74: "West Bengal",
  75: "Odisha", 76: "Odisha", 77: "Odisha", 78: "Assam", 79: "Assam",
  80: "Bihar", 81: "Bihar", 82: "Bihar", 83: "Bihar", 84: "Bihar", 85: "Bihar",
};
const BY_3 = {
  160: "Chandigarh", 194: "Ladakh", 246: "Uttarakhand", 248: "Uttarakhand", 249: "Uttarakhand", 263: "Uttarakhand",
  403: "Goa", 737: "Sikkim", 744: "Andaman and Nicobar Islands",
  790: "Arunachal Pradesh", 791: "Arunachal Pradesh", 792: "Arunachal Pradesh", 793: "Meghalaya", 794: "Meghalaya",
  795: "Manipur", 796: "Mizoram", 797: "Nagaland", 798: "Nagaland", 799: "Tripura",
  814: "Jharkhand", 815: "Jharkhand", 816: "Jharkhand", 822: "Jharkhand", 825: "Jharkhand", 826: "Jharkhand",
  827: "Jharkhand", 828: "Jharkhand", 829: "Jharkhand", 831: "Jharkhand", 832: "Jharkhand", 833: "Jharkhand",
  834: "Jharkhand", 835: "Jharkhand",
};
const BY_4 = { 6825: "Lakshadweep" };

// Cities next to a warehouse, by sorting district (first three digits)
const METRO_3 = {
  110: "Delhi", 121: "Faridabad", 122: "Gurugram", 201: "Noida", 400: "Mumbai", 401: "Thane", 411: "Pune",
  500: "Hyderabad", 560: "Bengaluru", 600: "Chennai", 700: "Kolkata",
};

const HUB_STATES = new Set(["delhi", "haryana", "maharashtra", "karnataka", "telangana", "tamil nadu", "west bengal"]);
const REMOTE_STATES = new Set([
  "arunachal pradesh", "manipur", "meghalaya", "mizoram", "nagaland", "tripura", "sikkim",
  "jammu and kashmir", "ladakh", "andaman and nicobar islands", "lakshadweep",
]);
const NO_COD_STATES = new Set(["ladakh", "andaman and nicobar islands", "lakshadweep"]);
const LARGE_ITEMS = new Set(["appliances"]); // storefront category: ACs, fridges, washing machines

const DAYS = { metro: [1, 2], regional: [2, 3], national: [3, 5], remote: [6, 9] };

const key = (state) => String(state || "").toLowerCase().replace(/&/g, "and").replace(/\s+/g, " ").trim();

export function stateFromPrefix(pin) {
  if (!PIN_RE.test(pin)) return null;
  return BY_4[pin.slice(0, 4)] || BY_3[pin.slice(0, 3)] || BY_2[pin.slice(0, 2)] || null;
}

const toRad = (d) => (d * Math.PI) / 180;
export function distanceKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

export const nearestHub = (loc) =>
  HUBS.map((h) => ({ ...h, km: Math.round(distanceKm(loc, h)) })).sort((a, b) => a.km - b.km)[0];

export function zoneFor({ pin, state, location }) {
  const s = key(state);
  if (REMOTE_STATES.has(s)) return "remote";
  if (location?.lat != null && location?.lng != null) {
    const { km } = nearestHub(location);
    if (km <= 60) return "metro";
    if (km <= 450) return "regional";
    return "national";
  }
  if (METRO_3[pin.slice(0, 3)]) return "metro";
  return HUB_STATES.has(s) ? "regional" : "national";
}

// Pure estimate, given what is known about the PIN code
export function estimate({ pin, place, category }) {
  if (pin[0] === "9") {
    return { pincode: pin, valid: true, serviceable: false, reason: "We don't deliver to Army Postal Service (APO/FPO) addresses yet." };
  }
  const zone = zoneFor({ pin, state: place.state, location: place.location });
  const large = LARGE_ITEMS.has(category);
  const [min, max] = DAYS[zone];
  return {
    pincode: pin,
    valid: true,
    serviceable: true,
    place: { area: place.area || null, district: place.district || METRO_3[pin.slice(0, 3)] || null, state: place.state },
    zone,
    days: { min: min + (large ? 1 : 0), max: max + (large ? 1 : 0) },
    cod: !NO_COD_STATES.has(key(place.state)),
    installation: large,
    source: place.source,
  };
}

// Whether the India Post directory has been imported; re-checked every 10 minutes
let directory = { ready: null, at: 0 };
async function hasDirectory() {
  if (directory.ready !== null && Date.now() - directory.at < 10 * 60 * 1000) return directory.ready;
  const ready = Boolean(await Pincode.exists({}));
  directory = { ready, at: Date.now() };
  return ready;
}
export const resetDirectoryCache = () => { directory = { ready: null, at: 0 }; };

export async function deliveryFor(pin, { category } = {}) {
  if (!PIN_RE.test(pin)) return { pincode: pin, valid: false, reason: "Enter a valid 6-digit PIN code." };
  const army = pin[0] === "9";

  if (!army && (await hasDirectory())) {
    const doc = await Pincode.findById(pin).lean();
    if (!doc) return { pincode: pin, valid: false, reason: "We couldn't find this PIN code. Please check it." };
    return estimate({ pin, category, place: { ...doc, source: "india-post" } });
  }

  const state = army ? "Army Postal Service" : stateFromPrefix(pin);
  if (!state) return { pincode: pin, valid: false, reason: "We couldn't find this PIN code. Please check it." };
  return estimate({ pin, category, place: { state, source: "prefix" } });
}
