import User from '../models/User.js';
import Settings from '../models/Settings.js';

/**
 * Get global store settings.
 * Admin identity (name/email/avatar/role) lives on GET /api/admin/verify
 * instead — that endpoint is reachable by every admin regardless of module
 * permissions, whereas this one is gated behind settings:read.
 */
export const getSettings = async (req, res) => {
    try {
        let settings = await Settings.findOne();
        if (!settings) {
            settings = await Settings.create({});
        }

        res.json({ store: settings });
    } catch (error) {
        console.error('[ERROR] Get Settings:', error);
        res.status(500).json({ message: 'Failed to fetch settings' });
    }
};

/**
 * Update Global Store Settings
 */
export const updateStoreSettings = async (req, res) => {
    try {
        const { storeName, tagline, supportEmail, supportPhone, freeShippingThreshold, primeEnabled } = req.body;

        let settings = await Settings.findOne();
        if (!settings) {
            settings = new Settings({});
        }

        if (storeName) settings.storeName = storeName;
        if (tagline) settings.tagline = tagline;
        if (supportEmail) settings.supportEmail = supportEmail;
        if (supportPhone) settings.supportPhone = supportPhone;
        if (freeShippingThreshold !== undefined) settings.freeShippingThreshold = Number(freeShippingThreshold);
        if (primeEnabled !== undefined) settings.primeEnabled = Boolean(primeEnabled);

        await settings.save();
        res.json({ message: 'Store settings updated', settings });
    } catch (error) {
        console.error('[ERROR] Update Store Settings:', error);
        res.status(500).json({ message: 'Failed to update store settings' });
    }
};

export const getAnnouncements = async (req, res) => {
    try {
        let settings = await Settings.findOne();
        if (!settings) settings = await Settings.create({});
        const active = (settings.announcements || []).filter(a => a.isActive).sort((a, b) => a.sortOrder - b.sortOrder);
        res.json(active);
    } catch (error) {
        console.error('[ERROR] Get Announcements:', error);
        res.status(500).json({ message: 'Failed to fetch announcements' });
    }
};

export const updateAnnouncements = async (req, res) => {
    try {
        const { announcements } = req.body;
        if (!Array.isArray(announcements)) {
            return res.status(400).json({ message: 'announcements must be an array' });
        }
        let settings = await Settings.findOne();
        if (!settings) settings = new Settings({});
        settings.announcements = announcements;
        await settings.save();
        res.json({ message: 'Announcements updated', announcements: settings.announcements });
    } catch (error) {
        console.error('[ERROR] Update Announcements:', error);
        res.status(500).json({ message: 'Failed to update announcements' });
    }
};

/**
 * Update Admin Profile (Name, Avatar)
 *
 * Email is intentionally not editable here — it's the account's login
 * identifier (checked via $or on username/email at /admin/login), unique
 * and required on the User model, and changing it safely needs its own
 * verify-before-switch flow (confirm new address, handle collisions, etc.).
 * Until that exists, email stays read-only to avoid a self-lockout footgun.
 */
export const updateAdminProfile = async (req, res) => {
    try {
        const { name } = req.body;
        const user = await User.findById(req.user.userId);

        if (!user) return res.status(404).json({ message: 'User not found' });

        if (name) user.name = name;

        // Handle Avatar Upload
        if (req.file) {
            user.profileImage = req.file.location;
        }

        await user.save();

        res.json({
            message: 'Profile updated successfully',
            admin: {
                name: user.name,
                email: user.email,
                profileImage: user.profileImage
            }
        });
    } catch (error) {
        console.error('[ERROR] Update Admin Profile:', error);
        res.status(500).json({ message: 'Failed to update profile' });
    }
};
