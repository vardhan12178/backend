import mongoose from 'mongoose';

const { Schema } = mongoose;

const announcementSchema = new Schema(
  {
    text: { type: String, required: true, trim: true, maxlength: 200 },
    link: { type: String, trim: true },
    bgColor: { type: String, trim: true, default: '#4F46E5' },
    textColor: { type: String, trim: true, default: '#FFFFFF' },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { _id: true }
);

const settingsSchema = new Schema({
    // Store General
    storeName: { type: String, default: 'VKart', trim: true },
    tagline: { type: String, default: 'Premium Lifestyle Store', trim: true },
    supportEmail: { type: String, default: 'support@vkartshop.in', trim: true },
    supportPhone: { type: String, default: '+91 99999 12345', trim: true },

    // Store Branding
    storeLogo: { type: String, default: '' },

    // Billing & Legal
    gstNumber: { type: String, default: '', trim: true },
    address: { type: String, default: '', trim: true },

    // Announcements
    announcements: { type: [announcementSchema], default: [] },

    // Shipping
    freeShippingThreshold: { type: Number, default: 499, min: 0 },

    // Prime
    primeEnabled: { type: Boolean, default: true },
}, {
    timestamps: true,
    versionKey: false
});

// We only need one document effectively
const Settings = mongoose.model('Settings', settingsSchema);
export default Settings;
