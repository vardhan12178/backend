import Product from "../models/Product.js";

export const listReviews = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const reviews = await Product.aggregate([
      { $unwind: "$reviews" },
      {
        $project: {
          productId: "$_id",
          productTitle: "$title",
          review: "$reviews",
        },
      },
      { $sort: { "review.date": -1 } },
      { $limit: limit },
    ]);

    res.json({ reviews });
  } catch (err) {
    console.error("Admin list reviews error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const toggleReviewVisibility = async (req, res) => {
  try {
    const { productId, reviewId } = req.params;
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ message: "Product not found" });

    const review = product.reviews.id(reviewId);
    if (!review) return res.status(404).json({ message: "Review not found" });

    review.isHidden = !review.isHidden;
    await product.save();

    res.json({ message: "Review updated", review });
  } catch (err) {
    console.error("Admin toggle review error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const deleteReviewAdmin = async (req, res) => {
  try {
    const { productId, reviewId } = req.params;
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ message: "Product not found" });

    const review = product.reviews.id(reviewId);
    if (!review) return res.status(404).json({ message: "Review not found" });

    product.reviews.pull(reviewId);

    if (product.reviews.length > 0) {
      const ratings = product.reviews.map((r) => r.rating);
      product.rating = Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10;
    } else {
      product.rating = 0;
    }

    await product.save();

    res.json({ message: "Review deleted", newRating: product.rating, totalReviews: product.reviews.length });
  } catch (err) {
    console.error("Admin delete review error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};
