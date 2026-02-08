import Notification from '../models/Notification.js';
import { getIO } from '../utils/socket.js';

/**
 * Get notifications for the logged-in user
 */
export const getUserNotifications = async (req, res) => {
    try {
        const notifications = await Notification.find({ userId: req.user.userId })
            .sort({ createdAt: -1 })
            .limit(50);

        const unreadCount = await Notification.countDocuments({
            userId: req.user.userId,
            isRead: false
        });

        res.json({
            success: true,
            notifications,
            unreadCount
        });
    } catch (error) {
        console.error('[ERROR] Get User Notifications:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch notifications' });
    }
};

/**
 * Mark user notifications as read
 */
export const markUserNotificationsRead = async (req, res) => {
    try {
        const { all, ids } = req.body;

        if (all) {
            await Notification.updateMany(
                { userId: req.user.userId, isRead: false },
                { isRead: true }
            );
        } else if (ids && Array.isArray(ids) && ids.length > 0) {
            await Notification.updateMany(
                { _id: { $in: ids }, userId: req.user.userId },
                { isRead: true }
            );
        }

        res.json({ success: true, message: 'Notifications updated' });
    } catch (error) {
        console.error('[ERROR] Mark User Notifications Read:', error);
        res.status(500).json({ success: false, message: 'Failed to update notifications' });
    }
};

/**
 * Helper to create a user notification (Internal Use)
 */
export const createUserNotification = async (userId, type, title, message, link = null) => {
    try {
        const notification = await Notification.create({
            userId,
            type,
            title,
            message,
            link
        });

        // Emit to the specific user's room
        try {
            getIO().to(`user_${userId}`).emit('user_notification', notification);
        } catch (socketError) {
            // Socket might not be initialized
        }

        return notification;
    } catch (error) {
        console.error('[ERROR] Create User Notification:', error);
    }
};
