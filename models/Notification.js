import mongoose from 'mongoose';

const { Schema } = mongoose;

const notificationSchema = new Schema({
    userId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        default: null // null = admin notification, ObjectId = user-specific notification
    },
    type: {
        type: String,
        enum: ['order', 'alert', 'user', 'system', 'return', 'refund'],
        required: true
    },
    title: { type: String, required: true },
    message: { type: String, required: true },
    isRead: { type: Boolean, default: false },
    link: { type: String },
}, {
    timestamps: true,
    versionKey: false
});

// Auto-delete notifications older than 30 days to keep DB clean
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

const Notification = mongoose.model('Notification', notificationSchema);
export default Notification;
