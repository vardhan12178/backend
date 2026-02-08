import User from '../models/User.js';
import bcrypt from 'bcryptjs';
import redis, { CACHE_TTL } from '../utils/redis.js';

/* GET /api/profile - Cached */
export const getProfile = async (req, res) => {
    const userId = req.user.userId;
    const cacheKey = `profile:${userId}`;

    // 1. Try Redis Cache
    try {
        const cachedProfile = await redis.get(cacheKey);
        if (cachedProfile) {
            const profile = JSON.parse(cachedProfile);
            // Skip stale cache entries that lack membership data
            if ('membership' in profile) {
                profile.isPrime = !!(profile.membership?.endDate && new Date(profile.membership.endDate) > new Date());
                return res.json(profile);
            }
            // Stale cache — delete and fall through to DB
            await redis.del(cacheKey);
        }
    } catch (err) {
        console.warn("Redis Get Error:", err.message);
    }

    // 2. Fallback to Database
    try {
        const user = await User.findById(userId)
            .select('name username email profileImage createdAt twoFactorEnabled suppress2faPrompt membership')
            .lean();

        if (!user) return res.status(404).json({ message: 'User not found' });

        // Compute isPrime virtual (lean() doesn't run virtuals)
        user.isPrime = !!(user.membership?.endDate && new Date(user.membership.endDate) > new Date());

        // 3. Save to Redis (Expires in 1 hour)
        try {
            await redis.set(cacheKey, JSON.stringify(user), 'EX', CACHE_TTL.PROFILE);
        } catch (err) {
            console.warn("Redis Set Error:", err.message);
        }

        return res.json(user);
    } catch (err) {
        console.error('Profile error:', err);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

/* -------------------- UPDATE NAME -------------------- */
export const updateName = async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ message: 'Name is required' });
        const user = await User.findByIdAndUpdate(
            req.user.userId,
            { name: name.trim() },
            { new: true }
        ).select('-password -__v');
        // Invalidate cache
        try { await redis.del(`profile:${req.user.userId}`); } catch {}
        return res.json(user);
    } catch (err) {
        console.error('Update name error:', err);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

/* -------------------- CART -------------------- */
export const getCart = async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).select('cart').lean();
        if (!user) return res.status(404).json({ message: 'User not found' });
        return res.json({ cart: user.cart || [] });
    } catch (err) {
        console.error('Get cart error:', err);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

export const updateCart = async (req, res) => {
    try {
        const items = Array.isArray(req.body.cart) ? req.body.cart : [];
        const user = await User.findByIdAndUpdate(
            req.user.userId,
            { cart: items },
            { new: true }
        ).select('cart');
        if (!user) return res.status(404).json({ message: 'User not found' });
        return res.json({ cart: user.cart || [] });
    } catch (err) {
        console.error('Update cart error:', err);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

/* -------------------- WISHLIST -------------------- */
export const getWishlist = async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).select('wishlist').lean();
        if (!user) return res.status(404).json({ message: 'User not found' });
        return res.json({ wishlist: user.wishlist || [] });
    } catch (err) {
        console.error('Get wishlist error:', err);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

export const updateWishlist = async (req, res) => {
    try {
        const items = Array.isArray(req.body.wishlist) ? req.body.wishlist : [];
        const user = await User.findByIdAndUpdate(
            req.user.userId,
            { wishlist: items },
            { new: true }
        ).select('wishlist');
        if (!user) return res.status(404).json({ message: 'User not found' });
        return res.json({ wishlist: user.wishlist || [] });
    } catch (err) {
        console.error('Update wishlist error:', err);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

/* -------------------- ADDRESSES -------------------- */
export const listAddresses = async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).select('addresses').lean();
        if (!user) return res.status(404).json({ message: 'User not found' });
        return res.json({ addresses: user.addresses || [] });
    } catch (err) {
        console.error('List addresses error:', err);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

export const addAddress = async (req, res) => {
    try {
        const payload = req.body || {};
        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (payload.isDefault) {
            user.addresses = (user.addresses || []).map(a => ({ ...a.toObject(), isDefault: false }));
        }
        user.addresses.push(payload);
        await user.save();

        return res.status(201).json({ addresses: user.addresses });
    } catch (err) {
        console.error('Add address error:', err);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

export const updateAddress = async (req, res) => {
    try {
        const addrId = req.params.id;
        const payload = req.body || {};
        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const idx = user.addresses.findIndex(a => a._id.toString() === addrId);
        if (idx === -1) return res.status(404).json({ message: 'Address not found' });

        if (payload.isDefault) {
            user.addresses = user.addresses.map(a => ({ ...a.toObject(), isDefault: false }));
        }
        user.addresses[idx] = { ...user.addresses[idx].toObject(), ...payload };
        await user.save();

        return res.json({ addresses: user.addresses });
    } catch (err) {
        console.error('Update address error:', err);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

export const deleteAddress = async (req, res) => {
    try {
        const addrId = req.params.id;
        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const before = user.addresses.length;
        user.addresses = user.addresses.filter(a => a._id.toString() !== addrId);
        if (user.addresses.length === before) {
            return res.status(404).json({ message: 'Address not found' });
        }
        await user.save();
        return res.json({ addresses: user.addresses });
    } catch (err) {
        console.error('Delete address error:', err);
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

/* -------------------- CHANGE PASSWORD -------------------- */
export const changePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword, confirmPassword } = req.body;

        if (!currentPassword || !newPassword || !confirmPassword)
            return res.status(400).json({ message: 'All fields are required' });
        if (String(newPassword).length < 8)
            return res.status(400).json({ message: 'New password must be at least 8 characters' });
        if (newPassword !== confirmPassword)
            return res.status(400).json({ message: 'Passwords do not match' });

        const user = await User.findById(req.user.userId).select('+password');
        if (!user) return res.status(404).json({ message: 'User not found' });

        const valid = await bcrypt.compare(currentPassword, user.password);
        if (!valid) return res.status(400).json({ message: 'Current password is incorrect' });

        user.password = await bcrypt.hash(newPassword, 11);
        await user.save();

        // Invalidate profile cache
        try { await redis.del(`profile:${req.user.userId}`); } catch {}

        return res.json({ message: 'Password changed successfully' });
    } catch (err) {
        console.error('Change password error:', err);
        return res.status(500).json({ message: 'Internal server error' });
    }
};
