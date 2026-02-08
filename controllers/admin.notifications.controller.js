import Notification from '../models/Notification.js';
import { getIO } from '../utils/socket.js';

/**
 * Get recent admin notifications (userId: null means admin notification)
 */
export const getNotifications = async (req, res) => {
    try {
        const notifications = await Notification.find({ userId: null })
            .sort({ createdAt: -1 })
            .limit(50);

        const unreadCount = await Notification.countDocuments({ userId: null, isRead: false });

        res.json({
            success: true,
            notifications,
            unreadCount
        });
    } catch (error) {
        console.error('[ERROR] Get Admin Notifications:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch notifications' });
    }
};

/**
 * Mark admin notifications as read
 */
export const markAsRead = async (req, res) => {
    try {
        const { all, ids } = req.body;

        if (all) {
            await Notification.updateMany({ userId: null, isRead: false }, { isRead: true });
        } else if (ids && Array.isArray(ids) && ids.length > 0) {
            await Notification.updateMany(
                { _id: { $in: ids }, userId: null },
                { isRead: true }
            );
        }

        res.json({ success: true, message: 'Notifications updated' });
    } catch (error) {
        console.error('[ERROR] Mark Admin Notifications Read:', error);
        res.status(500).json({ success: false, message: 'Failed to update notifications' });
    }
};

/**
 * Helper to create a notification (Internal Use)
 */
export const createNotification = async (type, title, message, link = null) => {
    try {
        const notification = await Notification.create({ type, title, message, link });

        // Broadcast to admins
        try {
            getIO().to('admin_notifications').emit('new_notification', notification);
        } catch (socketError) {
            // Socket might not be init if running tests or server just started
        }
    } catch (error) {
        console.error('[ERROR] Create Notification Log:', error);
        // Don't crash the app if a notification fails
    }
};
