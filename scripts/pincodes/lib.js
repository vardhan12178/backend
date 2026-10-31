// Turns India Post's All India Pincode Directory (one row per post office) into one
// document per PIN code. Column names differ between the CSV download and the
// data.gov.in API, so headers are matched loosely.

const FIELDS = {
  pincode: ["pincode", "pin", "pincodes"],
  office: ["officename", "office", "postofficename"],
  officeType: ["officetype", "officetypes"],
  delivery: ["delivery", "deliverystatus"],
  district: ["district", "districtname"],
  state: ["statename", "state"],
  lat: ["latitude", "lat"],
  lng: ["longitude", "long", "lng"],
};

const squash = (s) => String(s).toLowerCase().replace(/[^a-z]/g, "");

// Minimal RFC 4180 parser: quoted fields, escaped quotes, commas and newlines inside quotes
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  const [header = [], ...body] = rows;
  return body.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])));
}

const SMALL = new Set(["and", "of", "the"]);
export const titleCase = (s) =>
  String(s || "").trim().toLowerCase().replace(/\s+/g, " ")
    .split(" ")
    .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.replace(/(^|[-(])([a-z])/g, (m, p, c) => p + c.toUpperCase())))
    .join(" ");

// "INDIRANAGAR (BANGALORE) S.O" -> "Indiranagar"
export const cleanOffice = (s) =>
  titleCase(String(s || "").replace(/\s*\(.*?\)\s*/g, " ").trim().replace(/\s+(s\.?o|b\.?o|h\.?o|g\.?p\.?o|mdg)\.?$/i, ""));

const num = (v) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const inIndia = (lat, lng) => lat != null && lng != null && lat > 6 && lat < 38 && lng > 68 && lng < 98;

export function normalizeRecord(raw) {
  const byKey = new Map(Object.entries(raw).map(([k, v]) => [squash(k), v]));
  const get = (name) => {
    for (const alias of FIELDS[name]) if (byKey.has(alias)) return String(byKey.get(alias) ?? "").trim();
    return "";
  };
  const pincode = get("pincode").replace(/\D/g, "");
  if (!/^[1-9][0-9]{5}$/.test(pincode)) return null;
  const lat = num(get("lat"));
  const lng = num(get("lng"));
  return {
    pincode,
    office: cleanOffice(get("office")),
    officeType: get("officeType").toUpperCase().replace(/\W/g, ""), // HO, SO, BO
    delivery: !/non/i.test(get("delivery")),
    district: titleCase(get("district")),
    state: titleCase(get("state").replace(/&/g, " and ")),
    location: inIndia(lat, lng) ? { lat, lng } : null,
  };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mostCommon = (xs) => {
  const counts = new Map();
  xs.filter(Boolean).forEach((x) => counts.set(x, (counts.get(x) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
};

// Several post offices share a PIN code: name it after its head or sub office, take the most
// common district and state, and the median of the published coordinates.
export function aggregate(records) {
  const byPin = new Map();
  for (const r of records) {
    if (!r) continue;
    if (!byPin.has(r.pincode)) byPin.set(r.pincode, []);
    byPin.get(r.pincode).push(r);
  }
  const rank = (r) => (r.officeType === "HO" ? 0 : r.officeType === "SO" ? 1 : 2) + (r.delivery ? 0 : 3);
  return [...byPin.entries()].map(([pin, offices]) => {
    const main = [...offices].sort((a, b) => rank(a) - rank(b))[0];
    const located = offices.map((o) => o.location).filter(Boolean);
    return {
      _id: pin,
      area: main.office,
      district: mostCommon(offices.map((o) => o.district)),
      state: mostCommon(offices.map((o) => o.state)),
      delivery: offices.some((o) => o.delivery),
      location: located.length
        ? { lat: +median(located.map((l) => l.lat)).toFixed(4), lng: +median(located.map((l) => l.lng)).toFixed(4) }
        : undefined,
    };
  });
}
