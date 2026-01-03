import User from '../models/User.js';
import Settings from '../models/Settings.js';

/**
 * Get all settings: Global Store Config + Current Admin Profile
 */
export const getSettings = async (req, res) => {
    try {
        // 1. Fetch Global Settings (or create default if not exists)
        let settings = await Settings.findOne();
        if (!settings) {
            settings = await Settings.create({});
        }

        // 2. Fetch Current Admin Profile
        // req.user is populated by authenticateJWT middleware
        const admin = await User.findById(req.user.userId);

        res.json({
            store: settings,
            admin: {
                name: admin.name,
                username: admin.username,
                email: admin.email,
                profileImage: admin.profileImage,
                role: 'admin' // Implicit, since this route is admin-protected
            }
        });
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
        const { storeName, tagline, supportEmail, supportPhone } = req.body;

        // Upsert settings
        let settings = await Settings.findOne();
        if (!settings) {
            settings = new Settings({});
        }

        if (storeName) settings.storeName = storeName;
        if (tagline) settings.tagline = tagline;
        if (supportEmail) settings.supportEmail = supportEmail;
        if (supportPhone) settings.supportPhone = supportPhone;

        // Handle Logo Upload if present
        if (req.file) {
            settings.storeLogo = req.file.location;
        }

        await settings.save();
        res.json({ message: 'Store settings updated', settings });
    } catch (error) {
        console.error('[ERROR] Update Store Settings:', error);
        res.status(500).json({ message: 'Failed to update store settings' });
    }
};

/**
 * Update Admin Profile (Name, Password, Avatar)
 */
export const updateAdminProfile = async (req, res) => {
    try {
        const { name, email } = req.body;
        const user = await User.findById(req.user.userId);

        if (!user) return res.status(404).json({ message: 'User not found' });

        if (name) user.name = name;
        if (email) user.email = email; // Might strictly checking this later

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
