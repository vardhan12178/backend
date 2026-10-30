import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Sample ratings and reviews for the v2 catalog (demo content, labelled as such in the UI).
// Text lives in data/catalog-v2-reviews/*.json as { slug: [average, [[stars, title, body], ...]] };
// reviewer names, cities, dates, helpful votes and rating counts are derived here,
// deterministically, so every product shows the same reviews on every request.

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "catalog-v2-reviews");

// FNV-1a: small, stable string hash
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
const pick = (list, key) => list[hash(key) % list.length];
const between = (min, max, key) => min + (hash(key) % (max - min + 1));

// Names grouped by region so first name, surname and city fit together
const REGIONS = [
  { f: ["Ananya", "Sneha", "Pooja", "Rutuja", "Shruti", "Madhura", "Ketaki", "Gauri", "Prajakta", "Sayali", "Aditi", "Mrunal"],
    m: ["Aniket", "Rohan", "Omkar", "Sagar", "Tejas", "Shantanu", "Nikhil", "Pranav", "Vaibhav", "Siddharth", "Ajinkya", "Akshay"],
    s: ["Kulkarni", "Deshpande", "Joshi", "Patil", "Gokhale", "Bhosale", "Pawar", "Kale", "Jadhav", "Apte"],
    c: ["Pune", "Mumbai", "Nagpur", "Nashik", "Thane", "Kolhapur", "Aurangabad"] },
  { f: ["Lakshmi", "Divya", "Keerthana", "Meenakshi", "Harini", "Nivedha", "Janani", "Swathi", "Kavya", "Sowmya", "Revathi", "Aishwarya"],
    m: ["Karthik", "Arun", "Vignesh", "Prakash", "Saravanan", "Dinesh", "Hari", "Bharath", "Senthil", "Gokul", "Ashwin", "Ramesh"],
    s: ["Iyer", "Subramanian", "Krishnan", "Raman", "Natarajan", "Venkatesh", "Sundaram", "Balaji", "Murugan", "Rajendran"],
    c: ["Chennai", "Coimbatore", "Madurai", "Trichy", "Salem", "Vellore"] },
  { f: ["Priyanka", "Anusha", "Sravani", "Bhavana", "Sahithi", "Deepika", "Haritha", "Mounika", "Lavanya", "Navya", "Tejaswini", "Sindhu"],
    m: ["Srinivas", "Venkat", "Sai Kiran", "Ravi Teja", "Praveen", "Chaitanya", "Naveen", "Mahesh", "Harsha", "Kiran", "Vamsi", "Anil"],
    s: ["Reddy", "Rao", "Naidu", "Chowdary", "Varma", "Goud", "Yadav", "Kumar", "Prasad", "Murthy"],
    c: ["Hyderabad", "Vijayawada", "Visakhapatnam", "Warangal", "Guntur", "Tirupati"] },
  { f: ["Ritika", "Neha", "Shalini", "Kritika", "Simran", "Megha", "Tanvi", "Nidhi", "Shreya", "Ankita", "Payal", "Ishita"],
    m: ["Rahul", "Amit", "Vikas", "Saurabh", "Ankur", "Gaurav", "Abhishek", "Manish", "Rajat", "Varun", "Kunal", "Deepak"],
    s: ["Sharma", "Verma", "Gupta", "Agarwal", "Srivastava", "Mishra", "Tiwari", "Saxena", "Pandey", "Chauhan"],
    c: ["Delhi", "Lucknow", "Noida", "Gurugram", "Jaipur", "Kanpur", "Indore", "Bhopal"] },
  { f: ["Harpreet", "Gurleen", "Jasleen", "Navneet", "Simranjeet", "Manpreet", "Amrit", "Kirandeep", "Rupinder", "Baljeet", "Parminder", "Sukhleen"],
    m: ["Gurpreet", "Harjot", "Jaspreet", "Mandeep", "Arshdeep", "Karanveer", "Sukhdeep", "Navjot", "Inderpal", "Ravinder", "Tejinder", "Amandeep"],
    s: ["Singh", "Bains", "Gill", "Sandhu", "Dhillon", "Sidhu", "Grewal", "Bajwa", "Randhawa", "Bedi"],
    c: ["Ludhiana", "Amritsar", "Chandigarh", "Jalandhar", "Patiala", "Mohali"] },
  { f: ["Moumita", "Ishani", "Riya", "Debolina", "Sohini", "Paromita", "Tanushree", "Srijita", "Ankana", "Rimjhim", "Mitali", "Sayantika"],
    m: ["Arijit", "Sourav", "Debashish", "Abhijit", "Subhajit", "Anirban", "Ritam", "Sayan", "Indranil", "Partha", "Kaustav", "Tanmoy"],
    s: ["Banerjee", "Chatterjee", "Mukherjee", "Das", "Ghosh", "Bose", "Sen", "Dutta", "Roy", "Sarkar"],
    c: ["Kolkata", "Howrah", "Durgapur", "Siliguri", "Asansol", "Bhubaneswar"] },
  { f: ["Anjali", "Athira", "Gopika", "Aparna", "Nimisha", "Reshma", "Sreelakshmi", "Anagha", "Devika", "Neethu", "Arya", "Malavika"],
    m: ["Arjun", "Vishnu", "Akhil", "Sreejith", "Jithin", "Anoop", "Rahul", "Abhilash", "Nithin", "Sanjay", "Midhun", "Vivek"],
    s: ["Nair", "Menon", "Pillai", "Kurup", "Nambiar", "Panicker", "Warrier", "Kartha", "Unnithan", "Varma"],
    c: ["Kochi", "Thiruvananthapuram", "Kozhikode", "Thrissur", "Kottayam", "Kannur"] },
  { f: ["Hetal", "Khushi", "Dhruvi", "Nirali", "Krupa", "Foram", "Bhoomi", "Riddhi", "Jinal", "Mansi", "Palak", "Vidhi"],
    m: ["Harsh", "Jay", "Parth", "Chirag", "Dhaval", "Kalpesh", "Mehul", "Nirav", "Hardik", "Ketan", "Bhavin", "Darshan"],
    s: ["Patel", "Shah", "Mehta", "Desai", "Trivedi", "Parikh", "Joshi", "Modi", "Thakkar", "Vyas"],
    c: ["Ahmedabad", "Surat", "Vadodara", "Rajkot", "Gandhinagar", "Bhavnagar"] },
  { f: ["Spoorthi", "Bhoomika", "Chaitra", "Rakshitha", "Pallavi", "Shwetha", "Apoorva", "Sinchana", "Deeksha", "Kavana", "Ramya", "Yashaswini"],
    m: ["Manjunath", "Prajwal", "Raghavendra", "Darshan", "Kiran", "Sudeep", "Nagaraj", "Pavan", "Chethan", "Shashank", "Vinay", "Girish"],
    s: ["Gowda", "Hegde", "Shetty", "Bhat", "Rao", "Kamath", "Shenoy", "Acharya", "Nayak", "Prabhu"],
    c: ["Bengaluru", "Mysuru", "Mangaluru", "Hubballi", "Udupi", "Belagavi"] },
];

const FEMALE = /women|saree|kurti|dress|-top|earrings|necklace|bangle|ring|handbag|shoulder-bag|salwar|co-ord|tinted-sunscreen/;
const MALE = /beard|trimmer|razor|hair-wax|groomer|-polo|shirt|chinos|501|511|jeans/;

// Every combination of first name + surname + city, shuffled once, handed out in order:
// no reviewer name repeats anywhere in the catalog
function namePool(gender) {
  const out = [];
  REGIONS.forEach((r, ri) => {
    for (const first of r[gender]) for (const last of r.s) out.push({ name: `${first} ${last}`, city: r.c[hash(first + last) % r.c.length], ri });
  });
  return out.sort((a, b) => hash(`${gender}:${a.name}`) - hash(`${gender}:${b.name}`));
}

function loadRaw() {
  const all = {};
  if (!fs.existsSync(DIR)) return all;
  for (const file of fs.readdirSync(DIR).sort()) {
    if (file.endsWith(".json")) Object.assign(all, JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")));
  }
  return all;
}

function build(raw) {
  const pools = { f: namePool("f"), m: namePool("m") };
  const next = { f: 0, m: 0 };
  const used = new Set();
  const take = (gender) => {
    const pool = pools[gender];
    while (used.has(pool[next[gender] % pool.length].name)) next[gender]++;
    const person = pool[next[gender]++ % pool.length];
    used.add(person.name);
    return person;
  };
  const out = new Map();
  for (const slug of Object.keys(raw).sort()) {
    const [average, items] = raw[slug];
    const reviews = items.map(([stars, title, body], i) => {
      const gender = FEMALE.test(slug) ? "f" : MALE.test(slug) ? "m" : (hash(`${slug}:${i}:g`) % 2 ? "f" : "m");
      const { name, city } = take(gender);
      return { id: `${slug}-${i + 1}`, stars, title, body, name, city };
    });
    out.set(slug, { average, reviews });
  }
  return out;
}

const DATA = build(loadRaw());

/** Share of each star rating (5..1) whose mean is the average. */
export function breakdown(average) {
  const over = average - 4;
  const p1 = Math.max(0.02, 0.06 - over * 0.06);
  const p2 = Math.max(0.015, 0.04 - over * 0.04);
  const p3 = Math.max(0.04, 0.12 - over * 0.12);
  const rest = 1 - p1 - p2 - p3;
  const p5 = Math.min(rest, Math.max(0, average - (3 * p3 + 2 * p2 + p1) - 4 * rest));
  return [p5, rest - p5, p3, p2, p1];
}

// Cheaper products sell (and get rated) more
function ratingCount(slug, price = 0) {
  if (price < 2000) return between(2400, 26000, slug);
  if (price < 20000) return between(900, 9800, slug);
  if (price < 80000) return between(320, 4200, slug);
  return between(70, 1600, slug);
}

const DAY = 86400000;
const NEWEST = Date.UTC(2026, 9, 28);
const OLDEST = Date.UTC(2025, 10, 1);

// Launch dates matter for electronics; for fashion and other everyday items the date is when
// the product was added to the catalog, so their reviews spread over the whole window
const EVERGREEN = new Set(["fashion", "skincare", "grooming", "kitchen-appliances", "sports"]);

function launchTime(p) {
  const m = !EVERGREEN.has(p.category) && /^(\d{4})-(\d{2})/.exec(p.launchDate || "");
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, 1) : OLDEST;
}

/** { average, count } for a product, or null when it has no sample reviews. */
export function ratingFor(p) {
  const entry = DATA.get(p.slug);
  if (!entry) return null;
  return { average: entry.average, count: ratingCount(p.slug, p.priceRange?.min) };
}

/** Rating summary plus the written reviews, newest first, with dates after launch. */
export function reviewsFor(p) {
  const entry = DATA.get(p.slug);
  if (!entry) return null;
  const { average, count } = ratingFor(p);
  const shares = breakdown(average);
  const stars = [5, 4, 3, 2, 1].map((s, i) => ({ stars: s, count: Math.round(count * shares[i]) }));
  // First reviews a few days after launch, and at least a week between oldest and newest
  const start = Math.min(Math.max(OLDEST, launchTime(p) + 4 * DAY), NEWEST - 7 * DAY);
  const span = NEWEST - start;
  const variants = (p.variants || []).filter((v) => Object.keys(v.options || {}).length);
  const reviews = entry.reviews
    .map((r) => {
      const v = variants.length > 1 ? pick(variants, `${r.id}:v`) : null;
      return {
        ...r,
        date: new Date(start + (hash(`${r.id}:d`) % span)).toISOString().slice(0, 10),
        variant: v ? Object.entries(v.options).map(([k, val]) => `${k}: ${val}`).join(", ") : null,
        helpful: hash(`${r.id}:h`) % 5 === 0 ? 0 : between(1, 140, `${r.id}:hv`),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  return { average, count, reviewCount: Math.max(reviews.length, Math.round(count * 0.11)), stars, reviews, sample: true };
}
