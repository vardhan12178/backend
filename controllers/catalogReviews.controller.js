import * as reviews from "../services/catalog.userReviews.js";

const fail = (res, err, where) => {
  if (err instanceof reviews.ReviewError)
    return res.status(err.status).json({ message: err.message });
  console.error(`catalog reviews ${where}:`, err);
  return res.status(500).json({ message: "Server error" });
};

export const list = async (req, res) => {
  try {
    const { sort, page, limit } = req.query;
    res.json(
      await reviews.listReviews(req.params.slug, {
        sort,
        page,
        limit,
        viewerId: req.user?.userId || null,
      })
    );
  } catch (err) {
    fail(res, err, "list");
  }
};

export const create = async (req, res) => {
  try {
    res.status(201).json(await reviews.createReview(req.user.userId, req.params.slug, req.body));
  } catch (err) {
    fail(res, err, "create");
  }
};

export const update = async (req, res) => {
  try {
    res.json(await reviews.updateReview(req.user.userId, req.params.id, req.body));
  } catch (err) {
    fail(res, err, "update");
  }
};

export const remove = async (req, res) => {
  try {
    await reviews.deleteReview(req.user.userId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, "remove");
  }
};

export const helpful = async (req, res) => {
  try {
    res.json(await reviews.toggleHelpful(req.user.userId, req.params.id));
  } catch (err) {
    fail(res, err, "helpful");
  }
};

export const adminList = async (req, res) => {
  try {
    res.json(await reviews.adminList(req.query));
  } catch (err) {
    fail(res, err, "adminList");
  }
};

export const adminSetStatus = async (req, res) => {
  try {
    res.json(await reviews.adminSetStatus(req.params.id, req.body.status));
  } catch (err) {
    fail(res, err, "adminSetStatus");
  }
};
