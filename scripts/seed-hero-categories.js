/**
 * One-off seed script: adds realistic, current-generation products for the
 * "hero" categories (starting with smartphones + laptops) to bulk up the
 * catalog beyond the original DummyJSON import. Run per-batch with:
 *   node scripts/seed-hero-categories.js smartphones
 *   node scripts/seed-hero-categories.js laptops
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
  "Solid build quality, would recommend to others.",
  "Fast delivery, product matches the listing perfectly.",
  "Great performance for daily use, happy with the purchase.",
  "Packaging was excellent, product came in perfect condition.",
  "Decent product, does what it says on the box.",
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

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
      reviewerEmail: `${name.toLowerCase()}${Math.floor(Math.random() * 900 + 100)}@example.com`,
      date: new Date(Date.now() - Math.floor(Math.random() * 90) * 86400000),
    });
  }
  return reviews;
}

function img(keyword, seed) {
  return `https://loremflickr.com/640/640/${encodeURIComponent(keyword)}?lock=${seed}`;
}

function buildProduct(spec) {
  const discount = spec.discountPercentage ?? pick([4, 6, 8, 10, 12, 14, 15]);
  const rating = spec.rating ?? +(3.6 + Math.random() * 1.3).toFixed(2);
  const stock = spec.stock ?? Math.floor(Math.random() * 60 + 15);
  const seedBase = spec.sku;
  return {
    title: spec.title,
    description: spec.description,
    category: spec.category,
    brand: spec.brand,
    price: spec.price,
    discountPercentage: discount,
    rating: Math.min(rating, 5),
    stock,
    minimumOrderQuantity: 1,
    sku: spec.sku,
    tags: spec.tags,
    weight: spec.weight,
    dimensions: spec.dimensions,
    warrantyInformation: spec.warranty || "1 year manufacturer warranty",
    shippingInformation: "Ships in 1-3 business days",
    availabilityStatus: stock > 10 ? "In Stock" : "Low Stock",
    returnPolicy: "10 days return policy",
    thumbnail: img(spec.imgKeyword, seedBase),
    images: [1, 2, 3].map((n) => img(spec.imgKeyword, seedBase + n)),
    reviews: makeReviews(pick([1, 2, 2, 3])),
    variants: spec.variants || [],
    isActive: true,
    isFeatured: Math.random() < 0.25,
    isIndianized: true,
  };
}

// ---------------- SMARTPHONES ----------------
const smartphones = [
  { title: "Apple iPhone 16 (128GB)", brand: "Apple", price: 79900, tags: ["ios", "5g", "flagship"], imgKeyword: "iphone", weight: 170, dimensions: { width: 7.8, height: 14.7, depth: 0.8 }, description: "Apple's latest flagship with the A18 chip and a redesigned camera control button.\n• Chip: A18 Bionic\n• Display: 6.1-inch Super Retina XDR\n• Camera: 48MP Fusion + 12MP Ultra Wide\n• Battery: Up to 22 hours video playback", variants: [{ type: "Storage", options: ["128GB", "256GB", "512GB"] }, { type: "Color", options: ["Black", "White", "Pink", "Teal"] }] },
  { title: "Apple iPhone 16 Pro (256GB)", brand: "Apple", price: 129900, tags: ["ios", "5g", "flagship", "pro"], imgKeyword: "iphone-pro", weight: 199, dimensions: { width: 7.7, height: 14.99, depth: 0.83 }, description: "Titanium design with A18 Pro chip and 5x telephoto camera.\n• Chip: A18 Pro\n• Display: 6.3-inch ProMotion 120Hz\n• Camera: 48MP Triple system with 5x zoom\n• Battery: Up to 27 hours video playback", variants: [{ type: "Storage", options: ["256GB", "512GB", "1TB"] }, { type: "Color", options: ["Black Titanium", "Natural Titanium", "Desert Titanium"] }] },
  { title: "Samsung Galaxy S24 Ultra (256GB)", brand: "Samsung", price: 129999, tags: ["android", "5g", "flagship", "s-pen"], imgKeyword: "samsung-galaxy", weight: 232, dimensions: { width: 7.9, height: 16.24, depth: 0.86 }, description: "Snapdragon 8 Gen 3 with built-in S Pen and Galaxy AI features.\n• Processor: Snapdragon 8 Gen 3 for Galaxy\n• Display: 6.8-inch Dynamic AMOLED 2X, 120Hz\n• Camera: 200MP wide + 50MP periscope telephoto\n• Battery: 5000mAh with 45W fast charging", variants: [{ type: "Storage", options: ["256GB", "512GB", "1TB"] }, { type: "Color", options: ["Titanium Black", "Titanium Gray", "Titanium Violet"] }] },
  { title: "Samsung Galaxy S24 FE (128GB)", brand: "Samsung", price: 59999, tags: ["android", "5g"], imgKeyword: "samsung-phone", weight: 213, dimensions: { width: 7.65, height: 16.2, depth: 0.82 }, description: "Flagship features in a more accessible package.\n• Processor: Exynos 2400\n• Display: 6.7-inch Dynamic AMOLED 2X\n• Camera: 50MP Triple camera setup\n• Battery: 4700mAh", variants: [{ type: "Color", options: ["Graphite", "Mint", "Yellow"] }] },
  { title: "Samsung Galaxy Z Fold6 (512GB)", brand: "Samsung", price: 164999, tags: ["android", "5g", "foldable"], imgKeyword: "foldable-phone", weight: 239, dimensions: { width: 15.42, height: 13.24, depth: 1.25 }, description: "A book-style foldable with a large internal display for multitasking.\n• Processor: Snapdragon 8 Gen 3\n• Main Display: 7.6-inch foldable AMOLED\n• Cover Display: 6.3-inch AMOLED\n• Battery: 4400mAh", variants: [{ type: "Color", options: ["Silver Shadow", "Pink", "Navy"] }] },
  { title: "OnePlus 12 (256GB)", brand: "OnePlus", price: 64999, tags: ["android", "5g", "flagship"], imgKeyword: "oneplus", weight: 220, dimensions: { width: 7.58, height: 16.44, depth: 0.94 }, description: "Hasselblad-tuned camera system with Snapdragon 8 Gen 3.\n• Processor: Snapdragon 8 Gen 3\n• Display: 6.82-inch LTPO AMOLED, 120Hz\n• Camera: 50MP Hasselblad Triple camera\n• Battery: 5400mAh with 100W SuperVOOC charging", variants: [{ type: "Color", options: ["Flowy Emerald", "Silky Black"] }] },
  { title: "OnePlus 12R (128GB)", brand: "OnePlus", price: 39999, tags: ["android", "5g"], imgKeyword: "oneplus-phone", weight: 207, dimensions: { width: 7.55, height: 16.35, depth: 0.89 }, description: "Flagship-grade performance at a mid-range price.\n• Processor: Snapdragon 8 Gen 2\n• Display: 6.78-inch LTPO AMOLED, 120Hz\n• Camera: 50MP Sony LYT-600 main sensor\n• Battery: 5500mAh with 100W charging", variants: [{ type: "Color", options: ["Iron Gray", "Cool Blue"] }] },
  { title: "Xiaomi 14 Civi (256GB)", brand: "Xiaomi", price: 42999, tags: ["android", "5g"], imgKeyword: "xiaomi-phone", weight: 189, dimensions: { width: 7.35, height: 15.8, depth: 0.76 }, description: "Slim design with Leica-tuned dual selfie cameras.\n• Processor: Snapdragon 8s Gen 3\n• Display: 6.55-inch AMOLED, 120Hz\n• Camera: 50MP Leica Triple camera\n• Battery: 4700mAh with 67W charging" },
  { title: "Redmi Note 13 Pro+ 5G (256GB)", brand: "Redmi", price: 31999, tags: ["android", "5g", "budget-flagship"], imgKeyword: "redmi-phone", weight: 204, dimensions: { width: 7.61, height: 16.28, depth: 0.89 }, description: "200MP camera and curved AMOLED display at a mid-range price.\n• Processor: Dimensity 7200 Ultra\n• Display: 6.67-inch Curved AMOLED, 120Hz\n• Camera: 200MP OIS main sensor\n• Battery: 5000mAh with 120W HyperCharge" },
  { title: "POCO X6 Pro 5G (256GB)", brand: "POCO", price: 26999, tags: ["android", "5g", "gaming"], imgKeyword: "poco-phone", weight: 186, dimensions: { width: 7.6, height: 16.24, depth: 0.79 }, description: "Dimensity 8300-Ultra chip built for gaming performance.\n• Processor: Dimensity 8300-Ultra\n• Display: 6.67-inch Flow AMOLED, 120Hz\n• Camera: 64MP OIS main sensor\n• Battery: 5000mAh with 67W charging" },
  { title: "Vivo X100 (256GB)", brand: "Vivo", price: 63999, tags: ["android", "5g", "camera-phone"], imgKeyword: "vivo-phone", weight: 196, dimensions: { width: 7.35, height: 15.4, depth: 0.86 }, description: "ZEISS co-engineered optics with the Dimensity 9300 chip.\n• Processor: Dimensity 9300\n• Display: 6.78-inch AMOLED, 120Hz\n• Camera: 50MP ZEISS Triple camera\n• Battery: 5000mAh with 120W FlashCharge" },
  { title: "Vivo V30 Pro 5G (256GB)", brand: "Vivo", price: 41999, tags: ["android", "5g"], imgKeyword: "vivo-v-series", weight: 186, dimensions: { width: 7.3, height: 15.65, depth: 0.75 }, description: "Portrait-focused ZEISS cameras in a slim frame.\n• Processor: Dimensity 8200 Ultra\n• Display: 6.78-inch AMOLED, 120Hz\n• Camera: 50MP ZEISS Portrait camera\n• Battery: 5000mAh with 80W FlashCharge" },
  { title: "Oppo Reno 12 Pro 5G (256GB)", brand: "Oppo", price: 39999, tags: ["android", "5g"], imgKeyword: "oppo-phone", weight: 183, dimensions: { width: 7.34, height: 16.05, depth: 0.77 }, description: "AI-powered portrait photography with a lightweight design.\n• Processor: Dimensity 7300-Energy\n• Display: 6.7-inch AMOLED, 120Hz\n• Camera: 50MP Portrait Triple camera\n• Battery: 5000mAh with 80W SuperVOOC" },
  { title: "Realme GT 6 (256GB)", brand: "Realme", price: 45999, tags: ["android", "5g", "flagship"], imgKeyword: "realme-phone", weight: 199, dimensions: { width: 7.59, height: 16.22, depth: 0.89 }, description: "Snapdragon 8s Gen 3 with fast 120W charging.\n• Processor: Snapdragon 8s Gen 3\n• Display: 6.78-inch LTPO AMOLED, 144Hz\n• Camera: 50MP Sony LYT-808 main sensor\n• Battery: 5500mAh with 120W charging" },
  { title: "Realme 12 Pro+ 5G (256GB)", brand: "Realme", price: 29999, tags: ["android", "5g"], imgKeyword: "realme-pro", weight: 190, dimensions: { width: 7.4, height: 16.2, depth: 0.83 }, description: "Periscope telephoto camera in the mid-range segment.\n• Processor: Snapdragon 6 Gen 1\n• Display: 6.7-inch Curved AMOLED, 120Hz\n• Camera: 50MP Periscope Telephoto (3x zoom)\n• Battery: 5000mAh with 67W charging" },
  { title: "Google Pixel 8 (128GB)", brand: "Google", price: 65999, tags: ["android", "5g", "stock-android"], imgKeyword: "google-pixel", weight: 187, dimensions: { width: 7.09, height: 15.09, depth: 0.89 }, description: "Google Tensor G3 with class-leading computational photography.\n• Chip: Google Tensor G3\n• Display: 6.2-inch OLED, 120Hz\n• Camera: 50MP Octa PD main sensor\n• Battery: 4575mAh, 7 years of OS updates" },
  { title: "Google Pixel 8 Pro (256GB)", brand: "Google", price: 106999, tags: ["android", "5g", "flagship"], imgKeyword: "pixel-pro", weight: 213, dimensions: { width: 7.65, height: 16.25, depth: 0.89 }, description: "Pro-grade cameras with a temperature sensor and 7 years of updates.\n• Chip: Google Tensor G3\n• Display: 6.7-inch LTPO OLED, 120Hz\n• Camera: 50MP Triple camera with 5x telephoto\n• Battery: 5050mAh" },
  { title: "Nothing Phone (2a) (256GB)", brand: "Nothing", price: 27999, tags: ["android", "5g", "unique-design"], imgKeyword: "nothing-phone", weight: 190, dimensions: { width: 7.6, height: 16.14, depth: 0.81 }, description: "Transparent Glyph Interface design with balanced mid-range specs.\n• Processor: Dimensity 7200 Pro\n• Display: 6.7-inch AMOLED, 120Hz\n• Camera: 50MP Dual camera with OIS\n• Battery: 5000mAh with 45W charging" },
  { title: "Nothing Phone (2) (256GB)", brand: "Nothing", price: 44999, tags: ["android", "5g", "unique-design"], imgKeyword: "nothing-phone-2", weight: 201, dimensions: { width: 7.62, height: 16.2, depth: 0.86 }, description: "Snapdragon 8+ Gen 1 with the signature Glyph lighting system.\n• Processor: Snapdragon 8+ Gen 1\n• Display: 6.7-inch LTPO OLED, 120Hz\n• Camera: 50MP Dual camera with OIS\n• Battery: 4700mAh with 45W charging" },
  { title: "Motorola Edge 50 Pro (256GB)", brand: "Motorola", price: 31999, tags: ["android", "5g"], imgKeyword: "motorola-phone", weight: 186, dimensions: { width: 7.19, height: 16.1, depth: 0.81 }, description: "Curved pOLED display with fast 125W TurboPower charging.\n• Processor: Snapdragon 7 Gen 3\n• Display: 6.7-inch pOLED, 144Hz\n• Camera: 50MP OIS Triple camera\n• Battery: 4500mAh with 125W charging" },
  { title: "iQOO 12 5G (256GB)", brand: "iQOO", price: 52999, tags: ["android", "5g", "gaming"], imgKeyword: "iqoo-phone", weight: 199, dimensions: { width: 7.63, height: 16.28, depth: 0.86 }, description: "Snapdragon 8 Gen 3 tuned for high frame-rate gaming.\n• Processor: Snapdragon 8 Gen 3\n• Display: 6.78-inch LTPO AMOLED, 144Hz\n• Camera: 50MP OIS Triple camera\n• Battery: 5000mAh with 120W FlashCharge" },
  { title: "Asus ROG Phone 8 (256GB)", brand: "Asus", price: 69999, tags: ["android", "5g", "gaming"], imgKeyword: "gaming-phone", weight: 225, dimensions: { width: 7.65, height: 16.31, depth: 0.87 }, description: "Purpose-built gaming phone with AirTrigger shoulder buttons.\n• Processor: Snapdragon 8 Gen 3\n• Display: 6.78-inch AMOLED, 165Hz\n• Camera: 50MP Sony IMX890 main sensor\n• Battery: 5500mAh with 65W charging" },
  { title: "Honor 200 Pro 5G (512GB)", brand: "Honor", price: 52999, tags: ["android", "5g", "camera-phone"], imgKeyword: "honor-phone", weight: 190, dimensions: { width: 7.55, height: 16.15, depth: 0.85 }, description: "Portrait cameras co-developed with Studio Harcourt Paris.\n• Processor: Snapdragon 8s Gen 3\n• Display: 6.78-inch Curved OLED, 120Hz\n• Camera: 50MP Portrait Triple camera\n• Battery: 5200mAh with 100W charging" },
  { title: "Infinix Zero 30 5G (256GB)", brand: "Infinix", price: 21999, tags: ["android", "5g", "budget"], imgKeyword: "infinix-phone", weight: 189, dimensions: { width: 7.5, height: 16.2, depth: 0.79 }, description: "Curved AMOLED display and 4K selfie camera at a budget price.\n• Processor: Dimensity 8020\n• Display: 6.78-inch Curved AMOLED, 144Hz\n• Camera: 50MP OIS main sensor\n• Battery: 5000mAh with 68W charging" },
  { title: "Tecno Camon 30 Premier 5G (512GB)", brand: "Tecno", price: 29999, tags: ["android", "5g"], imgKeyword: "tecno-phone", weight: 197, dimensions: { width: 7.55, height: 16.35, depth: 0.83 }, description: "Variable aperture main camera in an affordable flagship-style body.\n• Processor: Dimensity 8300 Ultimate\n• Display: 6.78-inch Curved AMOLED, 120Hz\n• Camera: 50MP Variable Aperture main sensor\n• Battery: 5160mAh with 70W charging" },
];

// ---------------- LAPTOPS ----------------
const laptops = [
  { title: "Apple MacBook Air 13-inch M3 (8GB/256GB)", brand: "Apple", price: 114900, tags: ["macos", "ultrabook"], imgKeyword: "macbook-air", weight: 1240, dimensions: { width: 30.41, height: 21.5, depth: 1.13 }, description: "Fanless M3 chip design with all-day battery life.\n• Chip: Apple M3 (8-core CPU)\n• Display: 13.6-inch Liquid Retina\n• RAM/Storage: 8GB Unified Memory / 256GB SSD\n• Battery: Up to 18 hours", variants: [{ type: "RAM", options: ["8GB", "16GB", "24GB"] }, { type: "Color", options: ["Midnight", "Starlight", "Space Gray"] }] },
  { title: "Apple MacBook Pro 14-inch M3 Pro (18GB/512GB)", brand: "Apple", price: 199900, tags: ["macos", "pro"], imgKeyword: "macbook-pro", weight: 1550, dimensions: { width: 31.26, height: 22.12, depth: 1.55 }, description: "M3 Pro chip with Liquid Retina XDR display for professional workloads.\n• Chip: Apple M3 Pro (12-core CPU)\n• Display: 14.2-inch Liquid Retina XDR\n• RAM/Storage: 18GB Unified Memory / 512GB SSD\n• Battery: Up to 18 hours" },
  { title: "Dell XPS 13 (Core Ultra 7, 16GB/512GB)", brand: "Dell", price: 134990, tags: ["windows", "ultrabook"], imgKeyword: "dell-xps", weight: 1200, dimensions: { width: 29.55, height: 19.85, depth: 1.4 }, description: "Compact InfinityEdge display with Intel Core Ultra performance.\n• Processor: Intel Core Ultra 7 155H\n• Display: 13.4-inch FHD+ InfinityEdge\n• RAM/Storage: 16GB LPDDR5 / 512GB SSD\n• Battery: Up to 12 hours" },
  { title: "Dell Inspiron 15 (Core i5, 16GB/512GB)", brand: "Dell", price: 62990, tags: ["windows"], imgKeyword: "dell-inspiron", weight: 1630, dimensions: { width: 35.75, height: 23.13, depth: 1.79 }, description: "Everyday productivity laptop with a large 15.6-inch display.\n• Processor: Intel Core i5-1334U\n• Display: 15.6-inch FHD\n• RAM/Storage: 16GB DDR4 / 512GB SSD\n• Battery: Up to 8 hours" },
  { title: "HP Spectre x360 14 (Core Ultra 7, 16GB/1TB)", brand: "HP", price: 164999, tags: ["windows", "2-in-1", "convertible"], imgKeyword: "hp-spectre", weight: 1360, dimensions: { width: 29.95, height: 22.12, depth: 1.7 }, description: "Convertible 2-in-1 with a gem-cut design and OLED display option.\n• Processor: Intel Core Ultra 7 155H\n• Display: 14-inch 2.8K OLED Touch\n• RAM/Storage: 16GB / 1TB SSD\n• Battery: Up to 17 hours" },
  { title: "HP Pavilion 15 (Ryzen 5, 16GB/512GB)", brand: "HP", price: 54999, tags: ["windows"], imgKeyword: "hp-pavilion", weight: 1750, dimensions: { width: 35.9, height: 23.13, depth: 1.79 }, description: "Reliable everyday laptop with AMD Ryzen performance.\n• Processor: AMD Ryzen 5 7530U\n• Display: 15.6-inch FHD\n• RAM/Storage: 16GB DDR4 / 512GB SSD\n• Battery: Up to 10 hours" },
  { title: "HP Envy x360 14 (Core Ultra 5, 16GB/512GB)", brand: "HP", price: 89999, tags: ["windows", "2-in-1"], imgKeyword: "hp-envy", weight: 1440, dimensions: { width: 31.35, height: 22.06, depth: 1.79 }, description: "Convertible laptop with an OLED display and AI-enhanced webcam.\n• Processor: Intel Core Ultra 5 125U\n• Display: 14-inch 2.2K OLED Touch\n• RAM/Storage: 16GB / 512GB SSD\n• Battery: Up to 13 hours" },
  { title: "Lenovo ThinkPad X1 Carbon Gen 12 (Core Ultra 7, 32GB/1TB)", brand: "Lenovo", price: 189999, tags: ["windows", "business"], imgKeyword: "thinkpad", weight: 1120, dimensions: { width: 31.55, height: 22.14, depth: 1.49 }, description: "Business-grade ultrabook with MIL-SPEC durability testing.\n• Processor: Intel Core Ultra 7 165U\n• Display: 14-inch 2.8K OLED\n• RAM/Storage: 32GB LPDDR5x / 1TB SSD\n• Battery: Up to 16.5 hours" },
  { title: "Lenovo Legion 5 Pro (Ryzen 7, RTX 4060, 16GB/1TB)", brand: "Lenovo", price: 139990, tags: ["windows", "gaming"], imgKeyword: "lenovo-legion", weight: 2450, dimensions: { width: 35.94, height: 26.16, depth: 2.62 }, description: "Gaming laptop with a high refresh QHD display and RTX 4060 GPU.\n• Processor: AMD Ryzen 7 7745HX\n• GPU: NVIDIA GeForce RTX 4060 8GB\n• Display: 16-inch QHD+ 165Hz\n• RAM/Storage: 16GB DDR5 / 1TB SSD" },
  { title: "Lenovo IdeaPad Slim 5 (Ryzen 5, 16GB/512GB)", brand: "Lenovo", price: 54990, tags: ["windows"], imgKeyword: "lenovo-ideapad", weight: 1550, dimensions: { width: 32.19, height: 21.5, depth: 1.7 }, description: "Slim everyday laptop with a 2.8K OLED display option.\n• Processor: AMD Ryzen 5 7530U\n• Display: 14-inch 2.2K OLED\n• RAM/Storage: 16GB LPDDR5 / 512GB SSD\n• Battery: Up to 12 hours" },
  { title: "Asus ROG Zephyrus G14 (Ryzen 9, RTX 4070, 32GB/1TB)", brand: "Asus", price: 209990, tags: ["windows", "gaming"], imgKeyword: "asus-rog", weight: 1650, dimensions: { width: 31.2, height: 22.65, depth: 1.59 }, description: "Compact 14-inch gaming laptop with flagship-level performance.\n• Processor: AMD Ryzen 9 8945HS\n• GPU: NVIDIA GeForce RTX 4070 8GB\n• Display: 14-inch QHD+ 165Hz\n• RAM/Storage: 32GB LPDDR5x / 1TB SSD" },
  { title: "Asus Zenbook 14 OLED (Core Ultra 7, 16GB/1TB)", brand: "Asus", price: 99990, tags: ["windows", "ultrabook"], imgKeyword: "asus-zenbook", weight: 1220, dimensions: { width: 31.35, height: 22.03, depth: 1.59 }, description: "Lightweight OLED ultrabook built for creators.\n• Processor: Intel Core Ultra 7 155H\n• Display: 14-inch 2.8K OLED\n• RAM/Storage: 16GB / 1TB SSD\n• Battery: Up to 14 hours" },
  { title: "Asus Vivobook 15 (Core i5, 16GB/512GB)", brand: "Asus", price: 52990, tags: ["windows"], imgKeyword: "asus-vivobook", weight: 1700, dimensions: { width: 35.9, height: 23.5, depth: 1.99 }, description: "Everyday laptop with a NumberPad touchpad and full-HD display.\n• Processor: Intel Core i5-1334U\n• Display: 15.6-inch FHD OLED\n• RAM/Storage: 16GB / 512GB SSD\n• Battery: Up to 10 hours" },
  { title: "Acer Swift Go 14 (Core Ultra 5, 16GB/512GB)", brand: "Acer", price: 64999, tags: ["windows", "ultrabook"], imgKeyword: "acer-swift", weight: 1320, dimensions: { width: 31.35, height: 21.99, depth: 1.59 }, description: "Slim ultrabook with an AI-enhanced Copilot key.\n• Processor: Intel Core Ultra 5 125H\n• Display: 14-inch 2.8K OLED\n• RAM/Storage: 16GB LPDDR5x / 512GB SSD\n• Battery: Up to 12 hours" },
  { title: "Acer Aspire 7 (Ryzen 5, RTX 2050, 16GB/512GB)", brand: "Acer", price: 57999, tags: ["windows", "gaming"], imgKeyword: "acer-aspire", weight: 2100, dimensions: { width: 36.28, height: 24.5, depth: 1.99 }, description: "Budget-friendly laptop with discrete graphics for light gaming.\n• Processor: AMD Ryzen 5 7535HS\n• GPU: NVIDIA GeForce RTX 2050 4GB\n• Display: 15.6-inch FHD 144Hz\n• RAM/Storage: 16GB / 512GB SSD" },
  { title: "Acer Predator Helios Neo 16 (Core i7, RTX 4060, 16GB/1TB)", brand: "Acer", price: 149999, tags: ["windows", "gaming"], imgKeyword: "acer-predator", weight: 2600, dimensions: { width: 35.5, height: 26.5, depth: 2.35 }, description: "16-inch gaming laptop with a mini-LED display option.\n• Processor: Intel Core i7-13650HX\n• GPU: NVIDIA GeForce RTX 4060 8GB\n• Display: 16-inch WQXGA 165Hz\n• RAM/Storage: 16GB DDR5 / 1TB SSD" },
  { title: "MSI Modern 14 (Core i5, 16GB/512GB)", brand: "MSI", price: 54990, tags: ["windows"], imgKeyword: "msi-modern", weight: 1400, dimensions: { width: 32.3, height: 21.6, depth: 1.59 }, description: "Slim business laptop with a comfortable full-size keyboard.\n• Processor: Intel Core i5-1335U\n• Display: 14-inch FHD\n• RAM/Storage: 16GB DDR4 / 512GB SSD\n• Battery: Up to 10 hours" },
  { title: "MSI Katana 15 (Core i7, RTX 4060, 16GB/1TB)", brand: "MSI", price: 119990, tags: ["windows", "gaming"], imgKeyword: "msi-katana", weight: 2250, dimensions: { width: 35.9, height: 25.4, depth: 2.5 }, description: "Gaming laptop with Cooler Boost 5 thermal design.\n• Processor: Intel Core i7-13620H\n• GPU: NVIDIA GeForce RTX 4060 8GB\n• Display: 15.6-inch FHD 144Hz\n• RAM/Storage: 16GB DDR5 / 1TB SSD" },
  { title: "Samsung Galaxy Book4 Pro (Core Ultra 7, 16GB/1TB)", brand: "Samsung", price: 174990, tags: ["windows", "amoled"], imgKeyword: "galaxy-book", weight: 1560, dimensions: { width: 35.4, height: 22.9, depth: 1.15 }, description: "AMOLED touch display with Samsung's mobile ecosystem integration.\n• Processor: Intel Core Ultra 7 155H\n• Display: 16-inch 3K AMOLED Touch\n• RAM/Storage: 16GB / 1TB SSD\n• Battery: Up to 21 hours" },
  { title: "Microsoft Surface Laptop 6 (Core Ultra 7, 16GB/512GB)", brand: "Microsoft", price: 149999, tags: ["windows", "premium"], imgKeyword: "surface-laptop", weight: 1340, dimensions: { width: 30.83, height: 22.28, depth: 1.69 }, description: "Premium build quality with a vibrant PixelSense touch display.\n• Processor: Intel Core Ultra 7 165H\n• Display: 13.8-inch PixelSense Touch\n• RAM/Storage: 16GB / 512GB SSD\n• Battery: Up to 19 hours" },
  { title: "LG Gram 16 (Core Ultra 7, 16GB/1TB)", brand: "LG", price: 139990, tags: ["windows", "lightweight"], imgKeyword: "lg-gram", weight: 1199, dimensions: { width: 35.5, height: 23.5, depth: 1.66 }, description: "16-inch laptop that weighs under 1.2kg for maximum portability.\n• Processor: Intel Core Ultra 7 155H\n• Display: 16-inch WQXGA IPS\n• RAM/Storage: 16GB LPDDR5 / 1TB SSD\n• Battery: Up to 19.5 hours" },
  { title: "Infinix InBook Y2 Plus (Core i5, 16GB/512GB)", brand: "Infinix", price: 34999, tags: ["windows", "budget"], imgKeyword: "infinix-laptop", weight: 1700, dimensions: { width: 32.4, height: 21.4, depth: 1.79 }, description: "Budget-friendly productivity laptop with a metal chassis.\n• Processor: Intel Core i5-1155G7\n• Display: 15.6-inch FHD\n• RAM/Storage: 16GB / 512GB SSD\n• Battery: Up to 8 hours" },
  { title: "HP 15s (Core i3, 8GB/512GB)", brand: "HP", price: 37999, tags: ["windows", "budget"], imgKeyword: "hp-laptop", weight: 1690, dimensions: { width: 35.85, height: 23.63, depth: 1.79 }, description: "Entry-level laptop suited for browsing, study, and office work.\n• Processor: Intel Core i3-1215U\n• Display: 15.6-inch FHD\n• RAM/Storage: 8GB DDR4 / 512GB SSD\n• Battery: Up to 9 hours" },
  { title: "Acer Aspire Lite (Ryzen 5, 8GB/512GB)", brand: "Acer", price: 39999, tags: ["windows", "budget"], imgKeyword: "acer-lite", weight: 1470, dimensions: { width: 32.35, height: 21.49, depth: 1.69 }, description: "Compact and lightweight laptop for everyday computing.\n• Processor: AMD Ryzen 5 7520U\n• Display: 14-inch FHD\n• RAM/Storage: 8GB LPDDR5 / 512GB SSD\n• Battery: Up to 8 hours" },
  { title: "Acer Chromebook 315 (Celeron, 4GB/64GB)", brand: "Acer", price: 21999, tags: ["chromeos", "budget"], imgKeyword: "chromebook", weight: 1690, dimensions: { width: 36.3, height: 23.7, depth: 1.99 }, description: "Simple, fast Chrome OS laptop for students and web browsing.\n• Processor: Intel Celeron N4500\n• Display: 15.6-inch FHD\n• RAM/Storage: 4GB / 64GB eMMC\n• Battery: Up to 12.5 hours" },
];

const CATEGORY_MAP = { smartphones, laptops };

async function run() {
  const key = process.argv[2];
  if (!key || !CATEGORY_MAP[key]) {
    console.error(`Usage: node scripts/seed-hero-categories.js <${Object.keys(CATEGORY_MAP).join("|")}>`);
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log("[INFO] MongoDB Connected");

  const specs = CATEGORY_MAP[key].map((s) => ({ ...s, category: key, sku: `${key.toUpperCase()}-${s.title.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 24)}` }));
  const docs = specs.map(buildProduct);

  const result = await Product.insertMany(docs);
  console.log(`[SUCCESS] Inserted ${result.length} products into "${key}"`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => { console.error("[ERROR]", err); process.exit(1); });
