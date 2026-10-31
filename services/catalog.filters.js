// Category-specific listing filters for catalog (RAM, screen size, clothing size, ...).
//
// Each storefront category lists its filters. A filter reads product-level `keySpecs.*` or
// variant-level `variants.*` fields and comes in one of four kinds:
//   values   - pick any of the distinct values found (multi-select, $in)
//   flag     - a single on/off option for a boolean field
//   ranges   - fixed numeric buckets (multi-select)
//   patterns - buckets matched by regex on a text field (multi-select)
// A values filter may map raw values to cleaner choices (`canon`), matched back with `pattern` (a regex).
// The URL carries a selection as f_<key>=a,b. Facet counts for a filter are computed with every
// other active filter applied, so options never lead to an empty page.

const gb = (v) => `${v} GB`;
const storage = (v) => (v >= 1024 ? `${v / 1024} TB` : `${v} GB`);
const inch = (v) => `${v}"`;
const cap = (v) => String(v).replace(/^./, (c) => c.toUpperCase());

// Clothing sizes: "S-38" -> "S", "UK 7" -> "7"; one-size items have nothing to filter on
const sizeCanon = (v) => {
  const s = String(v).trim().toUpperCase().replace(/^UK\s*/, "").split("-")[0];
  return /^ONE ?SIZE$/.test(s) || !s ? null : s;
};
const sizeLabel = (v) => (/^\d+$/.test(v) && Number(v) >= 3 && Number(v) <= 13 ? `UK ${v}` : v);
const sizePattern = (c) => `^(uk\\s*)?${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-\\d+)?$`;

// Colour families, so "Navy Blue", "Light Blue" and "Indigo" are one choice
const COLOURS = [
  ["Black", "black|charcoal"], ["White", "white|ivory|cream|off-white"], ["Grey", "grey|gray"],
  ["Blue", "blue|navy|indigo|denim"], ["Green", "green|olive|sage|teal|mint"], ["Red", "red|maroon|wine|burgundy"],
  ["Pink", "pink|mauve|rose|peach"], ["Purple", "purple|lavender|lilac"], ["Yellow", "yellow|mustard|lime"],
  ["Orange", "orange|rust"], ["Brown", "brown|khaki|beige|tan|camel"], ["Gold", "gold"],
  ["Silver", "silver|rhodium|oxidised|oxidized"], ["Multicolour", "multi"],
];
const colourCanon = (v) => COLOURS.find(([, re]) => new RegExp(re, "i").test(String(v)))?.[0] || null;
const colourPattern = (c) => COLOURS.find(([name]) => name === c)?.[1] || "^$";

const OS_PHONE = { key: "os", label: "Operating system", kind: "values", field: "keySpecs.os", type: "string" };

export const SPEC_FILTERS = {
  mobiles: [
    { key: "ram", label: "RAM", kind: "values", field: "variants.keySpecs.ramGB", type: "number", format: gb },
    { key: "storage", label: "Storage", kind: "values", field: "variants.keySpecs.storageGB", type: "number", format: storage },
    { key: "5g", label: "Network", kind: "flag", field: "keySpecs.is5G", option: "5G" },
    { key: "battery", label: "Battery", kind: "ranges", field: "keySpecs.batteryMah", options: [
      { value: "lt5000", label: "Under 5,000 mAh", max: 5000 },
      { value: "5000", label: "5,000 – 5,999 mAh", min: 5000, max: 6000 },
      { value: "6000", label: "6,000 mAh & above", min: 6000 },
    ] },
    OS_PHONE,
  ],
  laptops: [
    { key: "cpu", label: "Processor", kind: "patterns", field: "keySpecs.processor", options: [
      { value: "apple", label: "Apple M-series", re: "apple" },
      { value: "intel", label: "Intel", re: "intel" },
      { value: "amd", label: "AMD Ryzen", re: "amd|ryzen" },
      { value: "snapdragon", label: "Snapdragon", re: "snapdragon|qualcomm" },
    ] },
    { key: "ram", label: "RAM", kind: "values", field: "variants.keySpecs.ramGB", type: "number", format: gb },
    { key: "storage", label: "Storage", kind: "values", field: "variants.keySpecs.storageGB", type: "number", format: storage },
    { key: "screen", label: "Screen size", kind: "ranges", field: "keySpecs.displayInch", options: [
      { value: "lt14", label: 'Under 14"', max: 14 },
      { value: "14", label: '14" – 15.4"', min: 14, max: 15.5 },
      { value: "15", label: '15.5" & above', min: 15.5 },
    ] },
    OS_PHONE,
  ],
  tablets: [
    { key: "storage", label: "Storage", kind: "values", field: "variants.keySpecs.storageGB", type: "number", format: storage },
    { key: "cellular", label: "Connectivity", kind: "flag", field: "variants.keySpecs.cellular", option: "Wi-Fi + Cellular" },
    { key: "screen", label: "Screen size", kind: "ranges", field: "keySpecs.displayInch", options: [
      { value: "lt11", label: 'Under 11"', max: 11 },
      { value: "11", label: '11" – 12.4"', min: 11, max: 12.5 },
      { value: "12", label: '12.5" & above', min: 12.5 },
    ] },
    OS_PHONE,
  ],
  tvs: [
    { key: "screen", label: "Screen size", kind: "values", fields: ["keySpecs.screenInch", "variants.keySpecs.screenInch"], type: "number", format: inch },
    { key: "res", label: "Resolution", kind: "patterns", field: "keySpecs.resolution", options: [
      { value: "4k", label: "4K Ultra HD", re: "3,?840|4k|uhd" },
      { value: "fhd", label: "Full HD", re: "1,?920|fhd|full hd" },
      { value: "hd", label: "HD Ready", re: "1,?366|hd ready" },
    ] },
    { key: "os", label: "Smart TV platform", kind: "patterns", field: "keySpecs.os", options: [
      { value: "google", label: "Google TV", re: "google" },
      { value: "webos", label: "webOS", re: "webos" },
      { value: "tizen", label: "Tizen", re: "tizen" },
    ] },
  ],
  monitors: [
    { key: "screen", label: "Screen size", kind: "ranges", field: "keySpecs.screenInch", options: [
      { value: "lt25", label: 'Up to 24"', max: 25 },
      { value: "25", label: '25" – 29"', min: 25, max: 30 },
      { value: "30", label: '30" & above', min: 30 },
    ] },
    { key: "res", label: "Resolution", kind: "patterns", field: "keySpecs.resolution", options: [
      { value: "fhd", label: "Full HD", re: "1,?920|fhd|full hd" },
      { value: "qhd", label: "QHD", re: "2,?560|1,?440|qhd" },
      { value: "4k", label: "4K", re: "3,?840|2,?160|4k|uhd" },
    ] },
    { key: "hz", label: "Refresh rate", kind: "ranges", field: "keySpecs.refreshRateHz", options: [
      { value: "lt100", label: "Up to 100 Hz", max: 101 },
      { value: "120", label: "120 – 180 Hz", min: 101, max: 181 },
      { value: "200", label: "200 Hz & above", min: 181 },
    ] },
    { key: "panel", label: "Panel", kind: "values", field: "keySpecs.panel", type: "string" },
    { key: "gaming", label: "Use", kind: "flag", field: "keySpecs.gaming", option: "Gaming" },
  ],
  audio: [
    { key: "type", label: "Type", kind: "patterns", field: "keySpecs.type", options: [
      { value: "earbuds", label: "Earbuds", re: "tws|earbud" },
      { value: "headphones", label: "Headphones", re: "over-ear|on-ear|headphone" },
      { value: "open", label: "Open-ear", re: "open" },
    ] },
    { key: "anc", label: "Features", kind: "flag", field: "keySpecs.anc", option: "Active noise cancellation" },
  ],
  wearables: [
    { key: "type", label: "Type", kind: "values", field: "keySpecs.type", type: "string" },
    { key: "calling", label: "Features", kind: "flag", field: "keySpecs.bluetoothCalling", option: "Bluetooth calling" },
    { key: "os", label: "Works with", kind: "values", field: "keySpecs.os", type: "string" },
  ],
  "fashion-men": [
    { key: "type", label: "Type", kind: "values", field: "keySpecs.productType", type: "string" },
    { key: "size", label: "Size", kind: "values", field: "variants.options.Size", type: "string", canon: sizeCanon, format: sizeLabel, pattern: sizePattern },
    { key: "color", label: "Colour", kind: "values", field: "variants.options.Color", type: "string", canon: colourCanon, pattern: colourPattern },
  ],
  appliances: [
    { key: "type", label: "Type", kind: "values", field: "keySpecs.type", type: "string" },
    { key: "star", label: "Energy rating", kind: "values", field: "keySpecs.starRating", type: "number", format: (v) => `${v} star` },
    { key: "inverter", label: "Features", kind: "flag", field: "keySpecs.inverter", option: "Inverter" },
  ],
  skincare: [
    { key: "type", label: "Type", kind: "values", field: "keySpecs.productType", type: "string" },
    { key: "skin", label: "Skin type", kind: "values", field: "keySpecs.skinTypes", type: "string", format: (v) => (v === "all" ? "All skin types" : cap(v)) },
  ],
  "kitchen-appliances": [{ key: "type", label: "Type", kind: "values", field: "keySpecs.productType", type: "string" }],
  grooming: [{ key: "type", label: "Type", kind: "values", field: "keySpecs.productType", type: "string" }],
  sports: [{ key: "type", label: "Type", kind: "values", field: "keySpecs.productType", type: "string" }],
};
SPEC_FILTERS["fashion-women"] = SPEC_FILTERS["fashion-men"];

export const filtersFor = (category) => SPEC_FILTERS[category] || [];

const toList = (v) => (Array.isArray(v) ? v : String(v ?? "").split(",")).map((s) => String(s).trim()).filter(Boolean);
const fieldsOf = (f) => f.fields || [f.field];

/** Active selections for the category: { key: [values] }, unknown keys and values dropped. */
export function parseSelections(query = {}, category) {
  const out = {};
  for (const f of filtersFor(category)) {
    const raw = toList(query[`f_${f.key}`]).slice(0, 20);
    if (!raw.length) continue;
    let values;
    if (f.kind === "values") {
      values = f.type === "number"
        ? raw.map(Number).filter(Number.isFinite)
        : raw.map((s) => s.slice(0, 60));
    } else if (f.kind === "flag") {
      values = raw.includes("1") ? ["1"] : [];
    } else {
      const known = new Set(f.options.map((o) => o.value));
      values = raw.filter((v) => known.has(v));
    }
    if (values.length) out[f.key] = [...new Set(values)];
  }
  return out;
}

// { field: cond } on a product-level path, or $elemMatch on the variants array
function onField(field, cond) {
  if (!field.startsWith("variants.")) return { [field]: cond };
  return { variants: { $elemMatch: { [field.slice("variants.".length)]: cond } } };
}

const rangeCond = (o) => ({ ...(o.min != null ? { $gte: o.min } : {}), ...(o.max != null ? { $lt: o.max } : {}) });

/** $match for one filter's selected values. */
export function matchFor(f, values) {
  if (f.kind === "flag") return onField(f.field, true);
  if (f.kind === "values") {
    const fields = fieldsOf(f);
    const conds = f.pattern
      ? fields.flatMap((field) => values.map((v) => ({ [field]: { $regex: f.pattern(String(v)), $options: "i" } })))
      : fields.map((field) => ({ [field]: { $in: values } }));
    return conds.length === 1 ? conds[0] : { $or: conds };
  }
  const picked = f.options.filter((o) => values.includes(o.value));
  if (f.kind === "ranges") return { $or: picked.map((o) => onField(f.field, rangeCond(o))) };
  return { $or: picked.map((o) => ({ [f.field]: { $regex: o.re, $options: "i" } })) };
}

/** $match stages for the selections, optionally leaving one filter out (for its own facet). */
export function narrowStages(category, selections, except) {
  return filtersFor(category)
    .filter((f) => f.key !== except && selections[f.key]?.length)
    .map((f) => ({ $match: matchFor(f, selections[f.key]) }));
}

// The field as an array: variant paths already are; a scalar becomes [x]; a missing field []
const asArray = (path) => ({
  $cond: [{ $isArray: `$${path}` }, `$${path}`, { $cond: [{ $eq: [{ $type: `$${path}` }, "missing"] }, [], [`$${path}`]] }],
});

/** Aggregation stages that count products per option of one filter. */
export function facetStages(f) {
  if (f.kind === "values") {
    const fields = fieldsOf(f);
    const values = fields.length === 1 ? asArray(fields[0]) : { $setUnion: fields.map(asArray) };
    return [
      { $project: { v: values } },
      { $unwind: "$v" },
      { $match: { v: { $ne: null } } },
      { $group: { _id: { p: "$_id", v: "$v" } } },
      { $group: { _id: "$_id.v", ids: { $push: "$_id.p" } } },
    ];
  }
  if (f.kind === "flag") {
    return [{ $match: onField(f.field, true) }, { $count: "count" }, { $project: { _id: "1", count: 1 } }];
  }
  const test = (o) => (f.kind === "ranges"
    ? { $anyElementTrue: [{ $map: { input: asArray(f.field), as: "x", in: {
      $and: [
        ...(o.min != null ? [{ $gte: ["$$x", o.min] }] : [{ $ne: ["$$x", null] }]),
        ...(o.max != null ? [{ $lt: ["$$x", o.max] }] : []),
      ] } } }] }
    : { $regexMatch: { input: { $toString: { $ifNull: [`$${f.field}`, ""] } }, regex: o.re, options: "i" } });
  return [{ $group: { _id: null, ...Object.fromEntries(f.options.map((o, i) => [`o${i}`, { $sum: { $cond: [test(o), 1, 0] } }])) } }];
}

const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL", "5XL"];
const sizeRank = (v) => {
  const s = String(v).toUpperCase().replace(/^UK\s*/, "");
  const letter = SIZE_ORDER.indexOf(s.split("-")[0]);
  if (letter >= 0) return [0, letter];
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? [1, n] : [2, 0];
};
const byValue = (a, b) => {
  if (typeof a.value === "number" && typeof b.value === "number") return a.value - b.value;
  const [ga, na] = sizeRank(a.value);
  const [gb2, nb] = sizeRank(b.value);
  return ga - gb2 || na - nb || String(a.value).localeCompare(String(b.value));
};

/**
 * Turns raw facet output into { key, label, kind, options: [{ value, label, count }] }, or null to hide it.
 * `total` is the number of products before any spec filter; selected options always stay listed.
 */
export function shapeFacet(f, raw, total, selected = []) {
  let options;
  if (f.kind === "values") {
    // Count each product once per choice, after mapping raw values to choices
    const byChoice = new Map();
    for (const r of raw) {
      const value = f.canon ? f.canon(r._id) : r._id;
      if (value == null) continue;
      if (!byChoice.has(value)) byChoice.set(value, new Set());
      r.ids.forEach((id) => byChoice.get(value).add(String(id)));
    }
    options = [...byChoice].map(([value, ids]) => ({ value, label: f.format ? f.format(value) : String(value), count: ids.size }));
    for (const v of selected) {
      if (!options.some((o) => String(o.value) === String(v))) options.push({ value: v, label: f.format ? f.format(v) : String(v), count: 0 });
    }
    options.sort(byValue);
  } else if (f.kind === "flag") {
    const count = raw[0]?.count || 0;
    options = count || selected.length ? [{ value: "1", label: f.option, count }] : [];
  } else {
    const row = raw[0] || {};
    options = f.options.map((o, i) => ({ value: o.value, label: o.label, count: row[`o${i}`] || 0 }))
      .filter((o) => o.count > 0 || selected.includes(o.value));
  }
  // A choice that can't narrow anything (one option covering every product) isn't worth showing
  const useful = selected.length > 0 || (f.kind === "flag" ? options.length && options[0].count < total : options.length >= 2);
  if (!useful) return null;
  return { key: f.key, label: f.label, kind: f.kind === "flag" ? "flag" : "multi", options: options.map((o) => ({ ...o, value: String(o.value) })) };
}

