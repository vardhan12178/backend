import CatalogProduct from "../models/CatalogProduct.js";
import { CATEGORY_GROUPS, visibleStatuses } from "../services/catalog.service.js";

const SITE = "https://vkart.balavardhan.dev";
const today = new Date().toISOString().slice(0, 10);

const staticPages = [
  { loc: "/", changefreq: "daily", priority: "1.0" },
  { loc: "/products", changefreq: "daily", priority: "0.9" },
  { loc: "/blog", changefreq: "weekly", priority: "0.8" },
  { loc: "/about", changefreq: "monthly", priority: "0.7" },
  { loc: "/contact", changefreq: "monthly", priority: "0.7" },
  { loc: "/careers", changefreq: "monthly", priority: "0.6" },
  { loc: "/terms", changefreq: "yearly", priority: "0.3" },
  { loc: "/privacy", changefreq: "yearly", priority: "0.3" },
  { loc: "/license", changefreq: "yearly", priority: "0.3" },
  { loc: "/prime", changefreq: "monthly", priority: "0.5" },
];

// Blog posts IDs 1-12
const blogIds = Array.from({ length: 12 }, (_, i) => i + 1);

/**
 * GET /api/sitemap.xml
 * Dynamic sitemap: static pages, storefront categories, every visible product and the blog posts.
 */
export const getSitemap = async (_req, res) => {
  try {
    // Every product the storefront shows (archived ones are left out)
    const products = await CatalogProduct.find({ status: { $in: visibleStatuses() } })
      .select("slug updatedAt")
      .lean();

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

    // Static pages
    for (const p of staticPages) {
      xml += `  <url>\n`;
      xml += `    <loc>${SITE}${p.loc}</loc>\n`;
      xml += `    <lastmod>${today}</lastmod>\n`;
      xml += `    <changefreq>${p.changefreq}</changefreq>\n`;
      xml += `    <priority>${p.priority}</priority>\n`;
      xml += `  </url>\n`;
    }

    // Category pages
    for (const g of CATEGORY_GROUPS) {
      xml += `  <url>\n`;
      xml += `    <loc>${SITE}/products?cat=${g.slug}</loc>\n`;
      xml += `    <lastmod>${today}</lastmod>\n`;
      xml += `    <changefreq>daily</changefreq>\n`;
      xml += `    <priority>0.8</priority>\n`;
      xml += `  </url>\n`;
    }

    // Product pages
    for (const prod of products) {
      const lastmod = prod.updatedAt
        ? new Date(prod.updatedAt).toISOString().slice(0, 10)
        : today;
      xml += `  <url>\n`;
      xml += `    <loc>${SITE}/products/${prod.slug}</loc>\n`;
      xml += `    <lastmod>${lastmod}</lastmod>\n`;
      xml += `    <changefreq>weekly</changefreq>\n`;
      xml += `    <priority>0.8</priority>\n`;
      xml += `  </url>\n`;
    }

    // Blog posts
    for (const id of blogIds) {
      xml += `  <url>\n`;
      xml += `    <loc>${SITE}/blog/${id}</loc>\n`;
      xml += `    <lastmod>${today}</lastmod>\n`;
      xml += `    <changefreq>monthly</changefreq>\n`;
      xml += `    <priority>0.6</priority>\n`;
      xml += `  </url>\n`;
    }

    xml += `</urlset>`;

    res.set("Content-Type", "application/xml");
    res.send(xml);
  } catch (err) {
    console.error("Sitemap error:", err);
    res.status(500).send("Error generating sitemap");
  }
};
