import User from '../models/User.js';
import redis from '../utils/redis.js';

/* GET /api/profile - Cached */
export const getProfile = async (req, res) => {
    const userId = req.user.userId;
    const cacheKey = `profile:${userId}`;

    // 1. Try Redis Cache
    try {
        const cachedProfile = await redis.get(cacheKey);
        if (cachedProfile) {
            return res.json(JSON.parse(cachedProfile));
        }
    } catch (err) {
        console.warn("Redis Get Error:", err.message);
    }

    // 2. Fallback to Database
    try {
        const user = await User.findById(userId)
            .select('name username email profileImage createdAt twoFactorEnabled suppress2faPrompt')
            .lean();

        if (!user) return res.status(404).json({ message: 'User not found' });

        // 3. Save to Redis (Expires in 1 hour)
        try {
            await redis.set(cacheKey, JSON.stringify(user), 'EX', 3600);
        } catch (err) {
            console.warn("Redis Set Error:", err.message);
        }

        return res.json(user);
    } catch (err) {
        console.error('Profile error:', err);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

/* POST /api/profile/upload - Invalidates Cache */
export const uploadProfileImage = async (req, res) => {
    try {
        if (!req.file?.location) {
            return res.status(400).json({ message: 'No image uploaded' });
        }

        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        // Update DB
        user.profileImage = req.file.location;
        await user.save();

        // 4. INVALIDATE CACHE (Crucial Step)
        // We delete the old cache so the next GET /profile fetches the new image
        try {
            await redis.del(`profile:${req.user.userId}`);
        } catch (err) {
            console.warn("Redis Delete Error:", err.message);
        }

        return res.json({
            name: user.name,
            username: user.username,
            email: user.email,
            profileImage: user.profileImage,
            createdAt: user.createdAt,
            twoFactorEnabled: user.twoFactorEnabled,
            suppress2faPrompt: user.suppress2faPrompt,
        });
    } catch (err) {
        console.error('Profile upload error:', err);
        return res.status(500).json({ message: 'Internal server error' });
    }
};
