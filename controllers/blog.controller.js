/**
 * Blog controller — serves static blog data via API.
 * In future this can be backed by a MongoDB Blog model.
 */

const POSTS = [
  { id: "1", title: "Top 10 Smart Desk Upgrades for 2025", summary: "Wireless chargers, monitor arms, and ergonomic stands — the smartest desk upgrades to boost workflow and cut clutter.", author: "VKart Editorial", date: "2025-08-02", tags: ["Setups", "Productivity"], readingMinutes: 6 },
  { id: "2", title: "Minimal Workspace Guide: Build a Clean, Calm Desk Setup", summary: "A step-by-step guide to creating a distraction-free desk layout using minimal accessories and VKart-approved essentials.", author: "VKart Editorial", date: "2025-07-26", tags: ["Minimal", "Workspace"], readingMinutes: 5 },
  { id: "3", title: "The Ultimate Everyday Carry (EDC) Starter Kit", summary: "Daily-use essentials that actually matter — durable cables, PD chargers, compact power banks, and portable stands.", author: "VKart Tech Desk", date: "2025-07-20", tags: ["Everyday Tech", "Guides"], readingMinutes: 6 },
  { id: "4", title: "Choosing the Best Bluetooth Speakers Under ₹2,000", summary: "Battery life, bass response, waterproof ratings, and build — a practical guide to picking a great budget speaker.", author: "VKart Editorial", date: "2025-07-12", tags: ["Audio", "Buying Guide"], readingMinutes: 7 },
  { id: "5", title: "Best Budget Webcams for Work-From-Home in 2025", summary: "Clear video calls without spending much — here are webcams with good microphones, wide FOV, and sharp low-light performance.", author: "VKart Tech Desk", date: "2025-07-03", tags: ["WFH", "Cameras"], readingMinutes: 5 },
  { id: "6", title: "Charging 101: Fast Chargers, GaN Tech & Cable Types Explained", summary: "A clean breakdown of PD, QC, GaN, wattage ratings, and cable categories — explained without jargon.", author: "VKart Editorial", date: "2025-06-28", tags: ["Accessories", "Tech Basics"], readingMinutes: 8 },
  { id: "7", title: "Weekly Drops: New Gadgets Worth Checking Out", summary: "Every Friday we highlight the newest accessories, tools, and desk upgrades added to VKart.", author: "VKart Editorial", date: "2025-06-21", tags: ["New Arrivals", "Highlights"], readingMinutes: 4 },
  { id: "8", title: "2025 Home Setup Guide: Affordable Add-ons for Small Spaces", summary: "Storage racks, cable sleeves, LED strips, and multi-functional organizers to transform any room without overspending.", author: "VKart Home Desk", date: "2025-06-14", tags: ["Home", "Organization"], readingMinutes: 6 },
  { id: "9", title: "How to Pick a Good 4K Monitor (Simple Breakdown)", summary: "A jargon-free guide to choosing the right panel type, refresh rate, size, HDR grade, and stand quality.", author: "VKart Tech Desk", date: "2025-06-05", tags: ["Displays", "Buying Guide"], readingMinutes: 7 },
  { id: "10", title: "5 Accessories That Make Your Laptop Last Longer", summary: "A quick guide to cooling pads, protective sleeves, stands, and cleaning kits that extend your laptop's lifespan.", author: "VKart Editorial", date: "2025-05-28", tags: ["Laptops", "Everyday Tech"], readingMinutes: 4 },
  { id: "11", title: "Cable Management for Beginners (No Tools Needed)", summary: "Simple fixes — Velcro straps, adhesive clips, under-desk sleeves — to instantly clean up your workspace.", author: "VKart Editorial", date: "2025-05-20", tags: ["Workspace", "Setups"], readingMinutes: 4 },
  { id: "12", title: "Best Tech Gifts Under ₹1,000", summary: "Thoughtful, budget-friendly tech gifts — perfect for birthdays, office events, and last-minute surprises.", author: "VKart Deals", date: "2025-05-14", tags: ["Gifts", "Deals"], readingMinutes: 5 },
];

/**
 * GET /api/blog — List all blog posts (summary only, no full content).
 */
export const listPosts = (_req, res) => {
  const { tag } = _req.query;
  let posts = POSTS;
  if (tag) {
    posts = posts.filter((p) => p.tags.some((t) => t.toLowerCase() === tag.toLowerCase()));
  }
  res.json({ posts, total: posts.length });
};

/**
 * GET /api/blog/:id — Get a single blog post by id.
 * Full content is served from the frontend static data,
 * but the API provides meta needed for SEO / social crawlers.
 */
export const getPost = (req, res) => {
  const post = POSTS.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: "Post not found" });
  res.json({ post });
};
