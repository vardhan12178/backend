import mongoose from 'mongoose';

const { Schema } = mongoose;

const settingsSchema = new Schema({
    // Store General
    storeName: { type: String, default: 'VKart', trim: true },
    tagline: { type: String, default: 'Premium Lifestyle Store', trim: true },
    supportEmail: { type: String, default: 'support@vkartshop.in', trim: true },
    supportPhone: { type: String, default: '+91 99999 12345', trim: true },

    // Store Branding
    storeLogo: { type: String, default: '' }, // URL to logo

    // Billing & Legal (Placeholder for now)
    gstNumber: { type: String, default: '', trim: true },
    address: { type: String, default: '', trim: true }
}, {
    timestamps: true,
    versionKey: false
});

// We only need one document effectively
const Settings = mongoose.model('Settings', settingsSchema);
export default Settings;
