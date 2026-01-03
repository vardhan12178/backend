import Product from "../models/Product.js";
import User from "../models/User.js";
import redis from "../utils/redis.js";
import { vectorizeProduct } from "../services/ai.service.js";
import path from "path";

/* GET /api/products - List with filters & cache */
export const getProducts = async (req, res) => {
    try {
        const { q, category, minPrice, maxPrice, minRating, sort, page = 1 } = req.query;
        const limit = Number(req.query.limit) || 20;

        // Check if the request matches the default landing page criteria
        const isDefaultView = !q && !category && !minPrice && !maxPrice && !minRating && (sort === "newest" || !sort) && Number(page) === 1;
        const cacheKey = `products:default:page1:limit${limit}`;

        if (isDefaultView) {
            try {
                const cachedData = await redis.get(cacheKey);
                if (cachedData) {
                    return res.json(JSON.parse(cachedData));
                }
            } catch (err) {
                console.warn("Redis Error:", err.message);
            }
        }

        const query = { isActive: true };
        if (q && q.trim()) query.$text = { $search: q.trim() };
        if (category) query.category = category;
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

        const [products, count] = await Promise.all([
            Product.find(query)
                .select('title description category brand price discountPercentage rating stock thumbnail images')
                .sort(sortObj)
                .skip(skip)
                .limit(limit)
                .lean(),
            countPromise
        ]);

        const response = {
            products,
            pagination: {
                page: Number(page),
                limit,
                total: count,
                totalPages: Math.ceil(count / limit),
            },
        };

        if (isDefaultView) {
            try {
                await redis.set(cacheKey, JSON.stringify(response), "EX", 300);
            } catch (err) {
                console.warn("Redis Set Error:", err.message);
            }
        }

        res.json(response);
    } catch (err) {
        console.error("Products list error:", err);
        res.status(500).json({ error: "Server error" });
    }
};

/* GET /api/products/:id - Details */
export const getProductById = async (req, res) => {
    const productId = req.params.id;
    const cacheKey = `product:${productId}`;

    // 1. Attempt to retrieve from Cache (Fail-safe)
    try {
        const cachedProduct = await redis.get(cacheKey);
        if (cachedProduct) {
            return res.json(JSON.parse(cachedProduct));
        }
    } catch (err) {
        // If Redis fails, log warning but continue to database
        console.warn(`Redis Get Error: ${err.message}`);
    }

    // 2. If Cache Miss or Redis Error, Query Database
    try {
        const product = await Product.findById(productId)
            .populate('reviews.userId', 'name username email profileImage');

        if (!product) {
            return res.status(404).json({ error: "Product not found" });
        }

        // 3. Update Cache (Fail-safe)
        try {
            // Set key with 1 hour expiration (3600 seconds)
            await redis.set(cacheKey, JSON.stringify(product), "EX", 3600);
        } catch (err) {
            console.warn(`Redis Set Error: ${err.message}`);
        }

        res.json(product);
    } catch (err) {
        console.error("Product fetch error:", err);
        res.status(500).json({ error: "Server error" });
    }
};

/* POST /api/admin/products - Create */
export const createProduct = async (req, res) => {
    try {
        const data = req.body;
        data.createdBy = req.user.userId;

        const product = await Product.create(data);

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
        const updated = await Product.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
        );

        if (!updated)
            return res.status(404).json({ error: "Product not found" });

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

        // Recalculate product rating
        const ratings = product.reviews.map((r) => r.rating);
        product.rating = (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1);

        await product.save();

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
        let sortedReviews = [...product.reviews];
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

        // Recalculate product rating
        if (product.reviews.length > 0) {
            const ratings = product.reviews.map(r => r.rating);
            product.rating = (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1);
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
