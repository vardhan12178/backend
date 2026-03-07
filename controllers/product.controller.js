import Product from "../models/Product.js";
import User from "../models/User.js";
import redis, { CACHE_TTL, invalidatePattern } from "../utils/redis.js";
import { vectorizeProduct } from "../services/ai.service.js";
import { getActiveSale, overlaySalePricing } from "./sale.controller.js";
import path from "path";

const DEFAULT_LIST_LIMIT = 12;
const MAX_LIST_LIMIT = 60;

const PRODUCT_LIST_PROJECTION = {
    _id: 1,
    title: 1,
    description: 1,
    category: 1,
    brand: 1,
    rating: 1,
    stock: 1,
    thumbnail: 1,
    images: 1,
    price: "$effectivePrice",
    discountPercentage: "$effectiveDiscountPercentage",
    onSale: "$onSale",
    saleName: "$saleName",
    saleId: "$saleId",
    originalPrice: {
        $cond: [
            { $eq: ["$onSale", true] },
            "$price",
            "$$REMOVE",
        ],
    },
    originalDiscountPercentage: {
        $cond: [
            { $eq: ["$onSale", true] },
            "$discountPercentage",
            "$$REMOVE",
        ],
    },
};

const toPositiveInt = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return Math.min(Math.trunc(parsed), max);
};

const toFiniteNumber = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const normalizeText = (value) => String(value || "").trim();
const cachePart = (value) => encodeURIComponent(String(value ?? ""));

const buildSaleSummary = (sale) =>
    sale ? { _id: sale._id, name: sale.name, endDate: sale.endDate } : null;

const buildEmptyCatalogResponse = ({ page, limit, activeSale }) => ({
    products: [],
    activeSale: buildSaleSummary(activeSale),
    pagination: {
        page,
        limit,
        total: 0,
        totalPages: 0,
    },
});

const buildEmptyFiltersResponse = ({ activeSale }) => ({
    categories: [],
    priceRange: { min: 0, max: 0 },
    activeSale: buildSaleSummary(activeSale),
});

const getIsPrimeUser = async (userId) => {
    if (!userId) return false;
    const user = await User.findById(userId).select("membership").lean();
    return !!(user?.membership?.endDate && new Date() < new Date(user.membership.endDate));
};

const normalizeSaleCategories = (sale) =>
    (sale?.categories || [])
        .map((entry) => ({
            category: normalizeText(entry.category).toLowerCase(),
            discountPercent: Number(entry.discountPercent) || 0,
            primeDiscountPercent: Number(entry.primeDiscountPercent) || 0,
        }))
        .filter((entry) => entry.category && (entry.discountPercent > 0 || entry.primeDiscountPercent > 0));

const buildCatalogMatch = ({ q, category, minRating, saleOnly, activeSale }) => {
    const match = { isActive: true };
    const searchTerm = normalizeText(q);
    const normalizedCategory = normalizeText(category).toLowerCase();
    const rating = toFiniteNumber(minRating);
    const saleCategories = normalizeSaleCategories(activeSale);
    const saleCategoryNames = saleCategories.map((entry) => entry.category);

    if (searchTerm) match.$text = { $search: searchTerm };
    if (rating !== null && rating > 0) match.rating = { $gte: rating };

    if (saleOnly) {
        if (!saleCategoryNames.length) {
            return { empty: true, match };
        }
        if (normalizedCategory) {
            if (!saleCategoryNames.includes(normalizedCategory)) {
                return { empty: true, match };
            }
            match.category = normalizedCategory;
        } else {
            match.category = { $in: saleCategoryNames };
        }
    } else if (normalizedCategory) {
        match.category = normalizedCategory;
    }

    return { empty: false, match, hasSearch: Boolean(searchTerm) };
};

const buildEffectivePriceStages = (activeSale, isPrime) => {
    const saleCategories = normalizeSaleCategories(activeSale);
    if (!saleCategories.length) {
        return [
            {
                $addFields: {
                    effectivePrice: "$price",
                    effectiveDiscountPercentage: "$discountPercentage",
                    onSale: false,
                    saleName: null,
                    saleId: null,
                },
            },
        ];
    }

    const saleDiscountExpression = isPrime
        ? {
            $cond: [
                { $gt: [{ $ifNull: ["$_saleCategoryConfig.primeDiscountPercent", 0] }, 0] },
                { $ifNull: ["$_saleCategoryConfig.primeDiscountPercent", 0] },
                { $ifNull: ["$_saleCategoryConfig.discountPercent", 0] },
            ],
        }
        : { $ifNull: ["$_saleCategoryConfig.discountPercent", 0] };

    return [
        {
            $addFields: {
                _saleCategoryConfig: {
                    $first: {
                        $filter: {
                            input: saleCategories,
                            as: "saleCategory",
                            cond: {
                                $eq: [
                                    { $toLower: "$category" },
                                    "$$saleCategory.category",
                                ],
                            },
                        },
                    },
                },
            },
        },
        {
            $addFields: {
                _saleDiscountPercent: saleDiscountExpression,
            },
        },
        {
            $addFields: {
                effectivePrice: {
                    $cond: [
                        { $gt: [{ $ifNull: ["$_saleDiscountPercent", 0] }, 0] },
                        {
                            $round: [
                                {
                                    $multiply: [
                                        {
                                            $cond: [
                                                { $gt: ["$discountPercentage", 0] },
                                                {
                                                    $divide: [
                                                        "$price",
                                                        {
                                                            $subtract: [
                                                                1,
                                                                { $divide: ["$discountPercentage", 100] },
                                                            ],
                                                        },
                                                    ],
                                                },
                                                { $multiply: ["$price", 1.2] },
                                            ],
                                        },
                                        {
                                            $subtract: [
                                                1,
                                                { $divide: ["$_saleDiscountPercent", 100] },
                                            ],
                                        },
                                    ],
                                },
                                0,
                            ],
                        },
                        "$price",
                    ],
                },
                effectiveDiscountPercentage: {
                    $cond: [
                        { $gt: [{ $ifNull: ["$_saleDiscountPercent", 0] }, 0] },
                        "$_saleDiscountPercent",
                        "$discountPercentage",
                    ],
                },
                onSale: { $gt: [{ $ifNull: ["$_saleDiscountPercent", 0] }, 0] },
                saleName: {
                    $cond: [
                        { $gt: [{ $ifNull: ["$_saleDiscountPercent", 0] }, 0] },
                        activeSale?.name || null,
                        null,
                    ],
                },
                saleId: {
                    $cond: [
                        { $gt: [{ $ifNull: ["$_saleDiscountPercent", 0] }, 0] },
                        activeSale?._id || null,
                        null,
                    ],
                },
            },
        },
        {
            $project: {
                _saleCategoryConfig: 0,
                _saleDiscountPercent: 0,
            },
        },
    ];
};

const buildPriceStages = ({ minPrice, maxPrice }) => {
    const min = toFiniteNumber(minPrice);
    const max = toFiniteNumber(maxPrice);
    const priceMatch = {};

    if (min !== null && min >= 0) priceMatch.$gte = min;
    if (max !== null && max >= 0) priceMatch.$lte = max;

    return Object.keys(priceMatch).length
        ? [{ $match: { effectivePrice: priceMatch } }]
        : [];
};

const buildSortStage = ({ sort, hasSearch }) => {
    if (sort === "price_asc") return { effectivePrice: 1, createdAt: -1 };
    if (sort === "price_desc") return { effectivePrice: -1, createdAt: -1 };
    if (sort === "rating_desc") return { rating: -1, createdAt: -1 };
    if (sort === "newest") return { createdAt: -1 };
    if (hasSearch) return { _textScore: -1, isFeatured: -1, rating: -1, createdAt: -1 };
    return { isFeatured: -1, rating: -1, createdAt: -1 };
};

const buildCatalogStages = ({ q, category, minRating, minPrice, maxPrice, saleOnly, activeSale, isPrime }) => {
    const { empty, match, hasSearch } = buildCatalogMatch({ q, category, minRating, saleOnly, activeSale });
    if (empty) return { empty: true, hasSearch: false, stages: [] };

    const stages = [
        { $match: match },
        ...(hasSearch ? [{ $addFields: { _textScore: { $meta: "textScore" } } }] : []),
        ...buildEffectivePriceStages(activeSale, isPrime),
        ...buildPriceStages({ minPrice, maxPrice }),
    ];

    return { empty: false, hasSearch, stages };
};

const buildProductsCacheKey = ({ q, category, minPrice, maxPrice, minRating, sort, page, limit, saleOnly, activeSale, isPrime }) =>
    [
        "products:list",
        `q=${cachePart(normalizeText(q).toLowerCase())}`,
        `category=${cachePart(normalizeText(category).toLowerCase())}`,
        `minPrice=${cachePart(minPrice ?? "")}`,
        `maxPrice=${cachePart(maxPrice ?? "")}`,
        `minRating=${cachePart(minRating ?? "")}`,
        `sort=${cachePart(sort || "relevance")}`,
        `page=${page}`,
        `limit=${limit}`,
        `sale=${saleOnly ? 1 : 0}`,
        `saleId=${cachePart(activeSale?._id || "none")}`,
        `prime=${isPrime ? 1 : 0}`,
    ].join(":");

const buildFiltersCacheKey = ({ q, minRating, saleOnly, activeSale, isPrime }) =>
    [
        "products:filters",
        `q=${cachePart(normalizeText(q).toLowerCase())}`,
        `minRating=${cachePart(minRating ?? "")}`,
        `sale=${saleOnly ? 1 : 0}`,
        `saleId=${cachePart(activeSale?._id || "none")}`,
        `prime=${isPrime ? 1 : 0}`,
    ].join(":");

export const getProducts = async (req, res) => {
    try {
        const activeSale = await getActiveSale();
        const saleOnly = req.query.sale === "true";
        const page = toPositiveInt(req.query.page, 1);
        const limit = toPositiveInt(req.query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
        const isPrime = await getIsPrimeUser(req.user?.userId);

        const cacheKey = buildProductsCacheKey({
            q: req.query.q,
            category: req.query.category,
            minPrice: req.query.minPrice,
            maxPrice: req.query.maxPrice,
            minRating: req.query.minRating,
            sort: req.query.sort,
            page,
            limit,
            saleOnly,
            activeSale,
            isPrime,
        });

        try {
            const cached = await redis.get(cacheKey);
            if (cached) {
                return res.json(JSON.parse(cached));
            }
        } catch (err) {
            console.warn("Products cache read error:", err.message);
        }

        const { empty, hasSearch, stages } = buildCatalogStages({
            q: req.query.q,
            category: req.query.category,
            minRating: req.query.minRating,
            minPrice: req.query.minPrice,
            maxPrice: req.query.maxPrice,
            saleOnly,
            activeSale,
            isPrime,
        });

        if (empty) {
            return res.json(buildEmptyCatalogResponse({ page, limit, activeSale }));
        }

        const skip = (page - 1) * limit;
        const sortStage = buildSortStage({ sort: req.query.sort, hasSearch });

        const [aggregated] = await Product.aggregate([
            ...stages,
            {
                $facet: {
                    products: [
                        { $sort: sortStage },
                        { $skip: skip },
                        { $limit: limit },
                        { $project: PRODUCT_LIST_PROJECTION },
                    ],
                    totalCount: [{ $count: "total" }],
                },
            },
        ]);

        const products = aggregated?.products || [];
        const total = aggregated?.totalCount?.[0]?.total || 0;
        const response = {
            products,
            activeSale: buildSaleSummary(activeSale),
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };

        try {
            await redis.set(cacheKey, JSON.stringify(response), "EX", CACHE_TTL.PRODUCTS_LIST);
        } catch (err) {
            console.warn("Products cache write error:", err.message);
        }

        res.json(response);
    } catch (err) {
        console.error("Products list error:", err);
        res.status(500).json({ error: "Server error" });
    }
};

export const getProductFilters = async (req, res) => {
    try {
        const activeSale = await getActiveSale();
        const saleOnly = req.query.sale === "true";
        const isPrime = await getIsPrimeUser(req.user?.userId);
        const stageParams = {
            q: req.query.q,
            category: "",
            minRating: req.query.minRating,
            minPrice: null,
            maxPrice: null,
            saleOnly,
            activeSale,
            isPrime,
        };

        const cacheKey = buildFiltersCacheKey({
            q: req.query.q,
            minRating: req.query.minRating,
            saleOnly,
            activeSale,
            isPrime,
        });

        try {
            const cached = await redis.get(cacheKey);
            if (cached) {
                return res.json(JSON.parse(cached));
            }
        } catch (err) {
            console.warn("Product filters cache read error:", err.message);
        }

        const { empty } = buildCatalogStages(stageParams);

        if (empty) {
            return res.json(buildEmptyFiltersResponse({ activeSale }));
        }

        const categoryStages = buildCatalogStages(stageParams).stages;
        const priceStages = buildCatalogStages(stageParams).stages;
        const [categoryRows, priceRows] = await Promise.all([
            Product.aggregate([
                ...categoryStages,
                {
                    $group: {
                        _id: "$category",
                        count: { $sum: 1 },
                    },
                },
                { $sort: { _id: 1 } },
            ]),
            Product.aggregate([
                ...priceStages,
                {
                    $group: {
                        _id: null,
                        min: { $min: "$effectivePrice" },
                        max: { $max: "$effectivePrice" },
                    },
                },
            ]),
        ]);

        const categories = (categoryRows || [])
            .map((entry) => {
                const value = normalizeText(entry._id);
                return value
                    ? {
                        slug: value.toLowerCase().replace(/\s+/g, "-"),
                        label: value.replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()),
                        count: entry.count,
                    }
                    : null;
            })
            .filter(Boolean);

        const bounds = priceRows?.[0] || {};
        const response = {
            categories,
            priceRange: {
                min: Math.round(bounds.min || 0),
                max: Math.round(bounds.max || 0),
            },
            activeSale: buildSaleSummary(activeSale),
        };

        try {
            await redis.set(cacheKey, JSON.stringify(response), "EX", CACHE_TTL.PRODUCTS_LIST);
        } catch (err) {
            console.warn("Product filters cache write error:", err.message);
        }

        res.json(response);
    } catch (err) {
        console.error("Product filters error:", err);
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
