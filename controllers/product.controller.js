import Product from "../models/Product.js";
import User from "../models/User.js";
import redis, { CACHE_TTL, invalidatePattern } from "../utils/redis.js";
import { vectorizeProduct } from "../services/ai.service.js";
import { getActiveSale, overlaySalePricing } from "./sale.controller.js";
import path from "path";

/* GET /api/products - List with filters & cache */
export const getProducts = async (req, res) => {
    try {
        const { q, category, minPrice, maxPrice, minRating, sort, page = 1, sale } = req.query;
        const limit = Number(req.query.limit) || 20;

        // Check if the request matches the default landing page criteria
        const isDefaultView = !q && !category && !sale && !minPrice && !maxPrice && !minRating && (sort === "newest" || !sort) && Number(page) === 1;
        const cacheKey = `products:raw:page1:limit${limit}`;

        let products, count;

        // Try cache for default view (raw products without sale overlay)
        let fromCache = false;
        if (isDefaultView) {
            try {
                const cachedData = await redis.get(cacheKey);
                if (cachedData) {
                    const parsed = JSON.parse(cachedData);
                    products = parsed.products;
                    count = parsed.total;
                    fromCache = true;
                }
            } catch (err) {
                console.warn("Redis Error:", err.message);
            }
        }

        if (!fromCache) {
            const query = { isActive: true };
            if (q && q.trim()) query.$text = { $search: q.trim() };
            if (category) query.category = category;

            // Sale filter: restrict to active sale categories only
            if (sale === 'true' && !category) {
                const activeSale = await getActiveSale();
                if (activeSale?.categories?.length) {
                    const saleCats = activeSale.categories.map(c => new RegExp(`^${c.category}$`, 'i'));
                    query.category = { $in: saleCats };
                } else {
                    // No active sale — return empty
                    return res.json({ products: [], activeSale: null, pagination: { page: 1, limit, total: 0, totalPages: 0 } });
                }
            }

            if (minPrice || maxPrice) {
                query.price = {};
                if (minPrice) query.price.$gte = Number(minPrice);
                if (maxPrice) query.price.$lte = Number(maxPrice);
            }
            if (minRating) query.rating = { $gte: Number(minRating) };

            let sortObj = { isFeatured: -1, rating: -1, createdAt: -1 };
            if (sort === "price_asc") sortObj = { price: 1 };
            if (sort === "price_desc") sortObj = { price: -1 };
            if (sort === "rating_desc") sortObj = { rating: -1 };
            if (sort === "newest") sortObj = { createdAt: -1 };

            const skip = (Number(page) - 1) * limit;

            const countPromise = isDefaultView
                ? Product.estimatedDocumentCount()
                : Product.countDocuments(query);

            [products, count] = await Promise.all([
                Product.find(query)
                    .select('title description category brand price discountPercentage rating stock thumbnail images')
                    .sort(sortObj)
                    .skip(skip)
                    .limit(limit)
                    .lean(),
                countPromise
            ]);

            // Cache raw products for default view
            if (isDefaultView) {
                try {
                    await redis.set(cacheKey, JSON.stringify({ products, total: count }), "EX", CACHE_TTL.PRODUCTS_LIST);
                } catch (err) {
                    console.warn("Redis Set Error:", err.message);
                }
            }
        }

        // Always apply sale overlay fresh (depends on user's Prime status)
        const activeSale = await getActiveSale();

        // Check if logged-in user is Prime for sale pricing
        let isPrime = false;
        if (req.user?.userId) {
            const u = await User.findById(req.user.userId).select("membership").lean();
            if (u?.membership?.endDate && new Date() < new Date(u.membership.endDate)) isPrime = true;
        }

        const overlaid = activeSale
            ? overlaySalePricing(products, activeSale, isPrime)
            : products;

        const response = {
            products: overlaid,
            activeSale: activeSale ? { _id: activeSale._id, name: activeSale.name, endDate: activeSale.endDate } : null,
            pagination: {
                page: Number(page),
                limit,
                total: count,
                totalPages: Math.ceil(count / limit),
            },
        };

        res.json(response);
    } catch (err) {
        console.error("Products list error:", err);
        res.status(500).json({ error: "Server error" });
    }
};

/* GET /api/products/suggest?q=... — fast autocomplete */
export const suggestProducts = async (req, res) => {
    try {
        const q = (req.query.q || "").trim();
        if (!q || q.length < 2) return res.json([]);

        const cacheKey = `suggest:${q.toLowerCase().slice(0, 40)}`;
        try {
            const cached = await redis.get(cacheKey);
            if (cached) return res.json(JSON.parse(cached));
        } catch {}

        const results = await Product.find({
            isActive: true,
            title: { $regex: q, $options: "i" },
        })
            .select("title thumbnail category price")
            .limit(8)
            .lean();

        try { await redis.set(cacheKey, JSON.stringify(results), "EX", 300); } catch {}
        res.json(results);
    } catch (err) {
        console.error("Suggest error:", err);
        res.status(500).json([]);
    }
};

/* GET /api/products/:id - Details */
export const getProductById = async (req, res) => {
    const productId = req.params.id;
    const cacheKey = `product:${productId}`;

    // 1. Attempt to retrieve from Cache (Fail-safe)
    let product = null;
    try {
        const cachedProduct = await redis.get(cacheKey);
        if (cachedProduct) {
            product = JSON.parse(cachedProduct);
        }
    } catch (err) {
        console.warn(`Redis Get Error: ${err.message}`);
    }

    // 2. If Cache Miss or Redis Error, Query Database
    try {
        if (!product) {
            const dbProduct = await Product.findById(productId)
                .populate('reviews.userId', 'name username email profileImage');

            if (!dbProduct) {
                return res.status(404).json({ error: "Product not found" });
            }

            product = dbProduct.toObject ? dbProduct.toObject() : dbProduct;

            // Cache the raw product (without sale overlay)
            try {
                await redis.set(cacheKey, JSON.stringify(product), "EX", CACHE_TTL.PRODUCT_DETAIL);
            } catch (err) {
                console.warn(`Redis Set Error: ${err.message}`);
            }
        }

        // Always apply sale overlay (even on cache hit)
        let isPrime = false;
        if (req.user?.userId) {
            const u = await User.findById(req.user.userId).select("membership").lean();
            if (u?.membership?.endDate && new Date() < new Date(u.membership.endDate)) isPrime = true;
        }

        const sale = await getActiveSale();
        const [overlaid] = sale
            ? overlaySalePricing([product], sale, isPrime)
            : [product];

        res.json(overlaid);
    } catch (err) {
        console.error("Product fetch error:", err);
        res.status(500).json({ error: "Server error" });
    }
};

/* Whitelist allowed product fields */
const PRODUCT_FIELDS = [
    'title', 'description', 'category', 'brand', 'price',
    'discountPercentage', 'stock', 'thumbnail', 'images',
    'tags', 'sku', 'weight', 'dimensions', 'isFeatured', 'isActive',
    'variants',
];
const pickFields = (body) => {
    const data = {};
    for (const key of PRODUCT_FIELDS) {
        if (body[key] !== undefined) data[key] = body[key];
    }
    return data;
};

/* POST /api/admin/products - Create */
export const createProduct = async (req, res) => {
    try {
        const data = pickFields(req.body);
        data.createdBy = req.user.userId;

        const product = await Product.create(data);

        // Invalidate product list cache
        await invalidatePattern("products:*");

        // Real-time Vectorization (Fire and forget to keep UI fast)
        vectorizeProduct(product);

        res.status(201).json({ message: "Product created", product });
    } catch (err) {
        console.error("Create product error:", err);
        res.status(500).json({ error: "Server error" });
    }
};

/* PUT /api/admin/products/:id - Update */
export const updateProduct = async (req, res) => {
    try {
        const updates = pickFields(req.body);
        const updated = await Product.findByIdAndUpdate(
            req.params.id,
            updates,
            { new: true, runValidators: true }
        );

        if (!updated)
            return res.status(404).json({ error: "Product not found" });

        // Invalidate caches for this product and listings
        await Promise.all([
            redis.del(`product:${req.params.id}`),
            invalidatePattern("products:*"),
        ]);

        // Re-vectorize if title or description changed (Fire and forget)
        if (req.body.title || req.body.description) {
            vectorizeProduct(updated);
        }

        res.json({ message: "Product updated", product: updated });
    } catch (err) {
        console.error("Update product error:", err);
        res.status(500).json({ error: "Server error" });
    }
};

/* DELETE /api/admin/products/:id - Delete */
export const deleteProduct = async (req, res) => {
    try {
        const deleted = await Product.findByIdAndDelete(req.params.id);

        if (!deleted)
            return res.status(404).json({ error: "Product not found" });

        // Invalidate caches
        await Promise.all([
            redis.del(`product:${req.params.id}`),
            invalidatePattern("products:*"),
        ]);

        res.json({ message: "Product deleted" });
    } catch (err) {
        console.error("Delete product error:", err);
        res.status(500).json({ error: "Server error" });
    }
};

/* GET /api/admin/products - Admin List */
export const getAdminProducts = async (req, res) => {
    try {
        const list = await Product.find().sort({ createdAt: -1 });
        res.json(list);
    } catch (err) {
        console.error("Admin list products error:", err);
        res.status(500).json({ error: "Server error" });
    }
};

/* POST /api/admin/products/upload - Upload Image */
export const uploadProductImageHandler = (req, res) => {
    try {
        if (!req.file?.location) {
            return res.status(400).json({ message: "No image uploaded" });
        }

        return res.json({
            url: req.file.location,
            key: req.file.key,
            message: "Image uploaded successfully",
        });
    } catch (err) {
        console.error("Product image upload error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};

/* POST /api/products/:id/reviews - Add Review */
export const addReview = async (req, res) => {
    try {
        const { rating, comment } = req.body;

        // Validate rating
        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ error: "Invalid rating (1-5)" });
        }

        // Validate comment
        if (!comment || comment.trim().length < 10) {
            return res.status(400).json({ error: "Comment must be at least 10 characters" });
        }

        // Fetch product and user in parallel
        const [product, user] = await Promise.all([
            Product.findById(req.params.id),
            User.findById(req.user.userId).select('name username email')
        ]);

        if (!product) return res.status(404).json({ error: "Product not found" });
        if (!user) return res.status(404).json({ error: "User not found" });

        // Check for existing review
        const existingReview = product.reviews.find(
            r => r.userId && r.userId.toString() === req.user.userId
        );

        if (existingReview) {
            return res.status(400).json({ error: "You have already reviewed this product" });
        }

        // Create review object
        const review = {
            rating: Number(rating),
            comment: comment.trim(),
            userId: req.user.userId,
            reviewerName: user.name || user.username || "Anonymous",
            reviewerEmail: user.email || "",
            date: new Date(),
        };

        product.reviews.push(review);

        const ratings = product.reviews.map((r) => r.rating);
        product.rating = Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10;

        await product.save();

        // Invalidate product detail cache so new review shows immediately
        await redis.del(`product:${req.params.id}`);

        res.status(201).json({
            message: "Review added successfully",
            review: {
                ...review,
                _id: product.reviews[product.reviews.length - 1]._id
            },
            newRating: product.rating,
            totalReviews: product.reviews.length
        });
    } catch (err) {
        console.error("Add review error:", err);
        res.status(500).json({ error: "Server error" });
    }
};

/* GET /api/products/:id/reviews - List Reviews */
export const getReviews = async (req, res) => {
    try {
        const { page = 1, limit = 10, sort = 'newest' } = req.query;

        const product = await Product.findById(req.params.id)
            .select('reviews rating title')
            .populate('reviews.userId', 'name username email profileImage');

        if (!product) return res.status(404).json({ error: "Product not found" });

        // Sort reviews based on query parameter
        let sortedReviews = [...product.reviews].filter((r) => !r.isHidden);
        if (sort === 'newest') sortedReviews.sort((a, b) => new Date(b.date) - new Date(a.date));
        else if (sort === 'oldest') sortedReviews.sort((a, b) => new Date(a.date) - new Date(b.date));
        else if (sort === 'highest') sortedReviews.sort((a, b) => b.rating - a.rating);
        else if (sort === 'lowest') sortedReviews.sort((a, b) => a.rating - b.rating);

        // Paginate reviews
        const skip = (Number(page) - 1) * Number(limit);
        const paginatedReviews = sortedReviews.slice(skip, skip + Number(limit));

        res.json({
            reviews: paginatedReviews,
            total: product.reviews.length,
            rating: product.rating,
            productTitle: product.title,
            pagination: {
                page: Number(page),
                limit: Number(limit),
                totalPages: Math.ceil(product.reviews.length / limit),
            },
        });
    } catch (err) {
        console.error("Get reviews error:", err);
        res.status(500).json({ error: "Server error" });
    }
};

/* DELETE /api/products/:id/reviews/:reviewId - Delete Review */
export const deleteReview = async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ error: "Product not found" });

        // Find review by ID and verify ownership
        const reviewIndex = product.reviews.findIndex(
            r => r._id.toString() === req.params.reviewId &&
                r.userId.toString() === req.user.userId
        );

        if (reviewIndex === -1) {
            return res.status(404).json({ error: "Review not found or unauthorized" });
        }

        // Remove review
        product.reviews.splice(reviewIndex, 1);

        if (product.reviews.length > 0) {
            const ratings = product.reviews.map(r => r.rating);
            product.rating = Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10;
        } else {
            product.rating = 0;
        }

        await product.save();

        res.json({
            message: "Review deleted",
            newRating: product.rating,
            totalReviews: product.reviews.length
        });
    } catch (err) {
        console.error("Delete review error:", err);
        res.status(500).json({ error: "Server error" });
    }
};
