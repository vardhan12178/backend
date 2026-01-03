import { validationResult } from "express-validator";
import Order from "../models/Order.js";
import User from "../models/User.js";
import { createNotification } from "./admin.notifications.controller.js";

/* CREATE ORDER */
export const createOrder = async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });

    const { products, shippingAddress } = req.body;

    const stage = typeof req.body.stage === "string" ? req.body.stage : undefined;
    const tax = Number(req.body.tax) || 0;
    const shipping = Number(req.body.shipping) || 0;

    const user = await User.findById(req.user.userId).lean();
    if (!user) return res.status(404).json({ message: "User not found" });

    const newOrder = new Order({
        userId: user._id,
        customer: {
            name: user.name,
            email: user.email,
            phone: user.phone || "",
        },
        products,
        tax,
        shipping,
        stage,
        shippingAddress,
    });

    await newOrder.save();

    await User.updateOne(
        { _id: user._id },
        { $push: { orders: newOrder._id } }
    );

    // Notify Admins
    createNotification(
        'order',
        `New Order #${newOrder._id}`,
        `Order placed by ${user.name} for ₹${newOrder.totalPrice || 'N/A'}.`,
        `/admin/orders`
    );

    res.status(201).json(newOrder);
};

/* GET ALL ORDERS (User) */
export const getUserOrders = async (req, res) => {
    const user = await User.findById(req.user.userId)
        .populate("orders")
        .lean();

    if (!user) return res.status(404).json({ message: "User not found" });

    res.json(user.orders);
};

/* PAGINATED ORDERS (User) */
export const getUserOrdersPaged = async (req, res) => {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
        Order.find({ userId: req.user.userId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        Order.countDocuments({ userId: req.user.userId }),
    ]);

    res.json({ page, limit, total, items });
};

/* ADMIN - GET ALL ORDERS */
export const getAllOrders = async (req, res) => {
    const orders = await Order.find()
        .sort({ createdAt: -1 })
        .lean();

    res.json(orders);
};

/* ADMIN - GET ORDER BY ID */
export const getOrderById = async (req, res) => {
    const order = await Order.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ message: "Order not found" });

    res.json(order);
};

/* ADMIN - UPDATE ORDER STAGE */
export const updateOrderStage = async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    const newStage = req.body.stage;

    // Cannot update completed orders
    if (["DELIVERED", "CANCELLED"].includes(order.stage)) {
        return res.status(400).json({
            message: "Order is already completed or cancelled.",
        });
    }

    // Update stage
    order.stage = newStage;

    // Push timeline entry
    order.statusHistory.push({
        stage: newStage,
        date: new Date(),
    });

    await order.save();

    res.json({
        message: "Order stage updated successfully",
        order,
    });
};
