/**
 * Bulk-fills the fashion + home hero categories with generated-but-realistic
 * products (real brand names, real style/material vocabulary, combinatorial
 * variety) to bring the catalog from ~245 up toward ~500 products.
 * Run per category: node scripts/seed-fashion-home.js mens-shirts 23
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import Product from "../models/Product.js";

dotenv.config();

const INDIAN_NAMES = [
  "Rahul", "Priya", "Amit", "Sneha", "Vikram", "Anjali", "Karthik", "Neha",
  "Rohan", "Sanya", "Arjun", "Ishita", "Aditya", "Meera", "Siddharth", "Kavya",
  "Vihaan", "Aarav", "Diya", "Ananya", "Kabir", "Zara", "Reyansh", "Myra",
];
const REVIEW_LINES = [
  "Value for money, works exactly as described.",
  "Good quality, delivery was fast too.",
  "Better than expected for the price range.",
  "Solid quality, would recommend to others.",
  "Fast delivery, product matches the listing perfectly.",
  "Great fit and finish, happy with the purchase.",
  "Packaging was excellent, product came in perfect condition.",
  "Decent product, does what it says on the box.",
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function makeReviews(count) {
  const used = new Set();
  const reviews = [];
  for (let i = 0; i < count; i++) {
    let name;
    do { name = pick(INDIAN_NAMES); } while (used.has(name) && used.size < INDIAN_NAMES.length);
    used.add(name);
    reviews.push({
      rating: pick([4, 4, 5, 5, 5, 3]),
      comment: pick(REVIEW_LINES),
      reviewerName: name,
      reviewerEmail: `${name.toLowerCase()}${rand(100, 999)}@example.com`,
      date: new Date(Date.now() - rand(0, 90) * 86400000),
    });
  }
  return reviews;
}
function img(keyword, seed) { return `https://loremflickr.com/640/640/${encodeURIComponent(keyword)}?lock=${seed}`; }

// ---------------- CATEGORY DEFINITIONS ----------------
const CATEGORIES = {
  "mens-shirts": {
    group: "apparel", imgBase: "mens-shirt", priceRange: [499, 2999],
    brands: ["H&M", "Zara", "Levi's", "Allen Solly", "Van Heusen", "Peter England", "Arrow", "US Polo Assn.", "Louis Philippe", "Jack & Jones", "Tommy Hilfiger"],
    types: ["Slim Fit Cotton Shirt", "Formal Checked Shirt", "Casual Linen Shirt", "Printed Half Sleeve Shirt", "Oxford Button-Down Shirt", "Striped Formal Shirt", "Denim Shirt", "Regular Fit Poplin Shirt"],
    colors: ["Navy Blue", "White", "Black", "Maroon", "Olive Green", "Sky Blue", "Charcoal Grey", "Mustard Yellow", "Wine Red", "Beige"],
    materials: ["100% Cotton", "Cotton Blend", "Linen", "Poly-Cotton"],
    variantType: "Size", variantOptions: ["S", "M", "L", "XL", "XXL"],
  },
  "mens-shoes": {
    group: "footwear", imgBase: "mens-shoes", priceRange: [999, 6999],
    brands: ["Nike", "Adidas", "Puma", "Woodland", "Red Tape", "Bata", "Skechers", "Reebok", "Campus", "Liberty"],
    types: ["Running Shoes", "Casual Sneakers", "Formal Leather Shoes", "Sports Trainers", "Chukka Boots", "Loafers", "Canvas Sneakers", "Walking Shoes"],
    colors: ["Black", "White", "Tan", "Brown", "Grey", "Navy"],
    materials: ["Genuine Leather", "Mesh", "Synthetic Leather", "Canvas"],
    variantType: "Size", variantOptions: ["6", "7", "8", "9", "10", "11"],
  },
  "mens-watches": {
    group: "watch", imgBase: "mens-watch", priceRange: [999, 12999],
    brands: ["Fossil", "Titan", "Casio", "Timex", "Fastrack", "Citizen", "Seiko", "Daniel Wellington"],
    types: ["Chronograph Watch", "Analog Watch", "Smart Hybrid Watch", "Automatic Watch", "Digital Sports Watch", "Leather Strap Watch"],
    colors: ["Black Dial", "Blue Dial", "Silver", "Rose Gold", "Gunmetal"],
    materials: ["Stainless Steel", "Leather Strap", "Silicone Strap", "Titanium"],
  },
  "womens-dresses": {
    group: "apparel", imgBase: "womens-dress", priceRange: [699, 3999],
    brands: ["Zara", "H&M", "Vero Moda", "AND", "Global Desi", "W for Woman", "Biba", "Only", "Forever 21"],
    types: ["A-Line Maxi Dress", "Floral Wrap Dress", "Bodycon Party Dress", "Casual Shirt Dress", "Printed Kurta Dress", "Off-Shoulder Dress", "Denim Shirt Dress"],
    colors: ["Floral Print", "Black", "Red", "Emerald Green", "Blush Pink", "Navy Blue", "Mustard Yellow"],
    materials: ["Rayon", "Georgette", "Cotton", "Crepe", "Chiffon"],
    variantType: "Size", variantOptions: ["XS", "S", "M", "L", "XL"],
  },
  "tops": {
    group: "apparel", imgBase: "womens-top", priceRange: [399, 1999],
    brands: ["H&M", "Zara", "Vero Moda", "AND", "Only", "Forever 21", "Mango"],
    types: ["Ribbed Knit Top", "Puff Sleeve Blouse", "Crop Top", "Casual Cotton Top", "Printed Peplum Top", "Off-Shoulder Top", "Satin Cami Top"],
    colors: ["White", "Black", "Baby Pink", "Sage Green", "Beige", "Lavender"],
    materials: ["Cotton", "Polyester", "Rayon", "Satin"],
    variantType: "Size", variantOptions: ["XS", "S", "M", "L", "XL"],
  },
  "womens-shoes": {
    group: "footwear", imgBase: "womens-shoes", priceRange: [699, 4999],
    brands: ["Nike", "Adidas", "Puma", "Metro", "Catwalk", "Bata", "Steve Madden", "Crocs"],
    types: ["Running Shoes", "Ballet Flats", "Block Heel Sandals", "Wedge Sandals", "Casual Sneakers", "Ankle Boots", "Platform Heels"],
    colors: ["Black", "Nude", "White", "Tan", "Rose Gold", "Red"],
    materials: ["Synthetic Leather", "Mesh", "Suede", "Canvas"],
    variantType: "Size", variantOptions: ["4", "5", "6", "7", "8"],
  },
  "womens-bags": {
    group: "bag", imgBase: "handbag", priceRange: [599, 4999],
    brands: ["Caprese", "Baggit", "Lavie", "Hidesign", "Fossil", "Da Milano", "Accessorize"],
    types: ["Tote Bag", "Sling Bag", "Structured Handbag", "Backpack", "Clutch", "Crossbody Bag", "Potli Bag"],
    colors: ["Black", "Tan", "Beige", "Maroon", "Mustard", "Grey"],
    materials: ["Synthetic Leather", "Genuine Leather", "Canvas", "PU Leather"],
  },
  "womens-watches": {
    group: "watch", imgBase: "womens-watch", priceRange: [999, 9999],
    brands: ["Fossil", "Titan", "Fastrack", "Casio", "Daniel Wellington", "Timex"],
    types: ["Analog Watch", "Rose Gold Bracelet Watch", "Chronograph Watch", "Minimalist Watch", "Studded Dial Watch"],
    colors: ["Rose Gold", "Silver", "Gold", "Black Dial", "Mother of Pearl Dial"],
    materials: ["Stainless Steel", "Leather Strap", "Mesh Strap"],
  },
  "womens-jewellery": {
    group: "jewellery", imgBase: "jewellery", priceRange: [299, 3999],
    brands: ["Tanishq", "CaratLane", "Giva", "Voylla", "Zaveri Pearls", "Accessorize"],
    types: ["Gold Plated Necklace Set", "Kundan Earrings", "Pearl Bracelet", "Oxidized Silver Jhumkas", "American Diamond Ring", "Layered Chain Necklace"],
    colors: ["Gold Tone", "Silver Tone", "Rose Gold Tone", "Antique Finish"],
    materials: ["Brass", "925 Silver", "Alloy", "Pearl"],
  },
  "furniture": {
    group: "furniture", imgBase: "furniture", priceRange: [1999, 34999],
    brands: ["IKEA", "Urban Ladder", "Nilkamal", "Godrej Interio", "Pepperfry", "Durian", "Home Centre"],
    types: ["3-Seater Fabric Sofa", "Study Table with Drawer", "Wooden Bookshelf", "Queen Size Bed with Storage", "Recliner Chair", "Dining Table Set (4 Seater)", "Wardrobe with Mirror", "Bean Bag"],
    colors: ["Walnut Brown", "Oak Finish", "Charcoal Grey", "Beige", "White", "Espresso"],
    materials: ["Engineered Wood", "Solid Sheesham Wood", "Fabric Upholstery", "MDF"],
  },
  "home-decoration": {
    group: "decor", imgBase: "home-decor", priceRange: [249, 4999],
    brands: ["IKEA", "Home Centre", "Chumbak", "Fabindia", "Nestasia", "Urban Ladder"],
    types: ["Wall Clock", "Ceramic Vase Set", "Decorative Table Lamp", "Wall Art Canvas Print", "Scented Candle Set", "Photo Frame Set", "Artificial Plant with Pot", "Fairy Light String"],
    colors: ["White", "Terracotta", "Gold Accent", "Multicolor", "Pastel"],
    materials: ["Ceramic", "Wood", "Metal", "Glass", "MDF"],
  },
};

function descFor(group, brand, type, color, material) {
  switch (group) {
    case "apparel": return `${brand}'s ${type.toLowerCase()} in ${color.toLowerCase()} offers a comfortable, everyday fit.\n• Material: ${material}\n• Color: ${color}\n• Fit: Regular\n• Care: Machine wash, do not bleach`;
    case "footwear": return `${brand} ${type.toLowerCase()} built for comfort and everyday wear.\n• Upper Material: ${material}\n• Color: ${color}\n• Sole: Durable rubber outsole\n• Closure: Lace-up`;
    case "watch": return `${brand} ${type.toLowerCase()} with a ${color.toLowerCase()} and ${material.toLowerCase()} build.\n• Strap: ${material}\n• Dial Color: ${color}\n• Water Resistance: Up to 30m\n• Warranty: 2 years`;
    case "bag": return `${brand} ${type.toLowerCase()} crafted from ${material.toLowerCase()}.\n• Material: ${material}\n• Color: ${color}\n• Compartments: Multiple interior pockets\n• Closure: Zip closure`;
    case "jewellery": return `${brand} ${type.toLowerCase()} finished in ${color.toLowerCase()}.\n• Material: ${material}\n• Finish: ${color}\n• Occasion: Festive & everyday wear\n• Care: Keep away from moisture`;
    case "furniture": return `${brand} ${type.toLowerCase()} in a ${color.toLowerCase()} finish, built for durability.\n• Material: ${material}\n• Finish: ${color}\n• Assembly: Required, tools included\n• Warranty: 1 year against manufacturing defects`;
    case "decor": return `${brand} ${type.toLowerCase()} to add character to any room.\n• Material: ${material}\n• Color: ${color}\n• Style: Contemporary\n• Care: Wipe clean with a dry cloth`;
    default: return `${brand} ${type}.`;
  }
}

function buildProduct(spec) {
  const [minP, maxP] = spec.priceRange;
  const price = rand(minP, maxP);
  const discount = pick([4, 6, 8, 10, 12, 14, 15]);
  const rating = +(3.5 + Math.random() * 1.4).toFixed(2);
  const stock = rand(10, 80);
  return {
    title: spec.title,
    description: spec.description,
    category: spec.category,
    brand: spec.brand,
    price,
    discountPercentage: discount,
    rating: Math.min(rating, 5),
    stock,
    minimumOrderQuantity: 1,
    sku: spec.sku,
    tags: spec.tags,
    weight: rand(100, 3000),
    warrantyInformation: spec.group === "watch" || spec.group === "furniture" ? "2 year manufacturer warranty" : "No warranty on wear items",
    shippingInformation: "Ships in 1-3 business days",
    availabilityStatus: stock > 10 ? "In Stock" : "Low Stock",
    returnPolicy: "10 days return policy",
    thumbnail: img(spec.imgKeyword, spec.seed),
    images: [1, 2, 3].map((n) => img(spec.imgKeyword, spec.seed + n)),
    reviews: makeReviews(pick([1, 2, 2, 3])),
    variants: spec.variantType ? [{ type: spec.variantType, options: spec.variantOptions }] : [],
    isActive: true,
    isFeatured: Math.random() < 0.2,
    isIndianized: true,
  };
}

function generate(categoryKey, count) {
  const cfg = CATEGORIES[categoryKey];
  const combos = [];
  for (const brand of cfg.brands) {
    for (const type of cfg.types) {
      for (const color of cfg.colors) {
        combos.push({ brand, type, color });
      }
    }
  }
  const chosen = shuffle(combos).slice(0, count);
  return chosen.map((c, i) => {
    const material = pick(cfg.materials);
    const title = `${c.brand} ${c.color} ${c.type}`;
    const sku = `${categoryKey.toUpperCase()}-${title.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 28)}-${i}`;
    return {
      title,
      brand: c.brand,
      category: categoryKey,
      description: descFor(cfg.group, c.brand, c.type, c.color, material),
      priceRange: cfg.priceRange,
      tags: [categoryKey, c.brand.toLowerCase().replace(/[^a-z0-9]+/g, "-"), cfg.group],
      imgKeyword: cfg.imgBase,
      seed: sku.length + i * 7 + categoryKey.length,
      sku,
      group: cfg.group,
      variantType: cfg.variantType,
      variantOptions: cfg.variantOptions,
    };
  });
}

async function run() {
  const key = process.argv[2];
  const count = parseInt(process.argv[3] || "20", 10);
  if (!key || !CATEGORIES[key]) {
    console.error(`Usage: node scripts/seed-fashion-home.js <${Object.keys(CATEGORIES).join("|")}> <count>`);
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log("[INFO] MongoDB Connected");

  const specs = generate(key, count);
  const docs = specs.map(buildProduct);
  const result = await Product.insertMany(docs);
  console.log(`[SUCCESS] Inserted ${result.length} products into "${key}"`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => { console.error("[ERROR]", err); process.exit(1); });
