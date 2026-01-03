import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Resend } from 'resend';
import { OAuth2Client } from 'google-auth-library';
import speakeasy from 'speakeasy';

import User from '../models/User.js';
import TokenBlacklist from "../models/TokenBlacklist.js";
import { buildCookieOpts, buildClearCookieOpts } from '../utils/cookies.js';
import { decrypt, HAS_VALID_KEY } from '../utils/crypto.js';
import { createNotification } from './admin.notifications.controller.js';

const resend = new Resend(process.env.RESEND_API_KEY || 'dummy_key');
const FROM_EMAIL = process.env.FROM_EMAIL || 'VKart <onboarding@resend.dev>';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// Register
export const register = async (req, res) => {
    let { name, username, email, password, confirmPassword } = req.body;
    const profileImage = req.file ? req.file.location : '';
    if (!username || !email || !password)
        return res.status(400).json({ message: 'Missing required fields' });
    if (password !== confirmPassword)
        return res.status(400).json({ message: 'Passwords do not match' });

    username = String(username).trim().toLowerCase();
    email = String(email).trim().toLowerCase();

    try {
        const existing = await User.findOne({ $or: [{ username }, { email }] });
        if (existing) {
            const field = existing.username === username ? 'Username' : 'Email';
            return res.status(409).json({ message: `${field} already exists` });
        }

        const hashedPassword = await bcrypt.hash(password, 11);
        const newUser = new User({ name, username, email, password: hashedPassword, profileImage });
        await newUser.save();

        // Notify Admins
        createNotification(
            'user',
            'New User Registered',
            `User ${username} (${email}) has joined the platform.`
        );

        res.status(201).json({ message: 'User registered successfully' });
    } catch (error) {
        if (error?.code === 11000) {
            const key = Object.keys(error.keyPattern || {})[0] || 'Account';
            return res.status(409).json({ message: `${key} already exists` });
        }
        if (!res.headersSent)
            res.status(500).json({ message: 'Internal server error' });
    }
};

// Login
export const login = async (req, res) => {
    const { username, password, remember, token2fa } = req.body;
    if (!username || !password)
        return res.status(400).json({ message: 'Invalid payload' });

    const id = String(username).trim().toLowerCase();
    const user = await User.findOne({ $or: [{ username: id }, { email: id }] })
        .select('+password +twoFactorSecretEnc');

    if (!user || !(await bcrypt.compare(password, user.password)))
        return res.status(401).json({ message: 'Invalid credentials' });

    if (user.blocked) {
        return res.status(403).json({ message: 'Account suspended. Contact support.' });
    }

    if (user.twoFactorEnabled) {
        if (!token2fa) {
            return res.json({
                require2FA: true,
                userId: user._id,
            });
        }

        if (!user.twoFactorSecretEnc) {
            return res.status(500).json({ message: '2FA secret missing. Please disable and enable 2FA again.' });
        }

        if (!HAS_VALID_KEY) {
            return res.status(500).json({ message: '2FA key not configured on server' });
        }

        let base32Secret = null;
        try {
            base32Secret = decrypt(user.twoFactorSecretEnc);
        } catch (err) {
            console.error('2FA decrypt error in login:', err);
            return res.status(500).json({ message: '2FA verification failed' });
        }

        if (!base32Secret) {
            return res.status(500).json({ message: '2FA secret invalid' });
        }

        const ok = speakeasy.totp.verify({
            secret: base32Secret,
            encoding: 'base32',
            token: token2fa,
            window: 1,
        });

        if (!ok) {
            return res.status(401).json({ message: 'Invalid 2FA code' });
        }
    }

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.cookie('jwt_token', token, buildCookieOpts(req, remember));
    res.json({ token });
};

// Google Auth
export const googleAuth = async (req, res) => {
    try {
        const credential = req.body.credential || req.body.idToken;
        if (!credential)
            return res.status(400).json({ message: 'Missing Google credential' });

        if (!googleClient)
            return res.status(500).json({ message: 'Google client not configured' });

        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: GOOGLE_CLIENT_ID,
        });

        const payload = ticket.getPayload();
        if (!payload?.email)
            return res.status(400).json({ message: 'Google account missing email' });

        const email = payload.email.toLowerCase();
        let user = await User.findOne({ email });

        if (!user) {
            user = await User.create({
                name: payload.name,
                username: email.split('@')[0],
                email,
                profileImage: payload.picture || '',
                password: await bcrypt.hash(crypto.randomBytes(10).toString('hex'), 11),
            });
        }

        const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
        res.cookie('jwt_token', token, buildCookieOpts(req, true));
        res.json({ token });
    } catch (err) {
        console.error('Google login error:', err.message);
        res.status(401).json({ message: 'Google sign-in failed' });
    }
};

// Forgot Password
export const forgotPassword = async (req, res) => {
    try {
        const raw = (req.body.emailOrUsername || '').toString().trim().toLowerCase();
        if (!raw) return res.json({ message: 'If an account exists, a reset link was sent.' });

        const user = await User.findOne({ $or: [{ email: raw }, { username: raw }] });
        if (user?.email) {
            const tokenRaw = crypto.randomBytes(32).toString('hex');
            const tokenHash = crypto.createHash('sha256').update(tokenRaw).digest('hex');
            user.resetPasswordTokenHash = tokenHash;
            user.resetPasswordExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
            await user.save();

            const appUrl = (process.env.APP_URL || 'https://vkartshop.netlify.app').replace(/\/+$/, '');
            const link = `${appUrl}/reset-password?token=${tokenRaw}`;

            try {
                await resend.emails.send({
                    from: FROM_EMAIL,
                    to: user.email,
                    subject: 'VKart password reset',
                    html: `<p>Click to reset (expires in 30m)</p>
                   <p><a href="${link}">Reset Password</a></p>
                   <p>${link}</p>`,
                });
            } catch {
                console.warn('Email send skipped in test env');
            }
        }
        res.json({ message: 'If an account exists, a reset link was sent.' });
    } catch {
        res.json({ message: 'If an account exists, a reset link was sent.' });
    }
};

// Reset Password
export const resetPassword = async (req, res) => {
    try {
        const { token, password, confirmPassword } = req.body;
        if (!token || !password || !confirmPassword)
            return res.status(400).json({ message: 'Invalid payload' });
        if (password !== confirmPassword)
            return res.status(400).json({ message: 'Passwords do not match' });
        if (password.length < 8)
            return res.status(400).json({ message: 'Use at least 8 characters' });

        const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
        const user = await User.findOne({
            resetPasswordTokenHash: tokenHash,
            resetPasswordExpiresAt: { $gt: new Date() },
        }).select('+password');

        if (!user)
            return res.status(400).json({ message: 'Invalid or expired token' });

        user.password = await bcrypt.hash(password, 11);
        user.resetPasswordTokenHash = undefined;
        user.resetPasswordExpiresAt = undefined;
        await user.save();

        res.clearCookie('jwt_token', buildClearCookieOpts(req));
        res.json({ message: 'Password reset successful' });
    } catch {
        res.status(500).json({ message: 'Internal server error' });
    }
};

// Admin Login
export const adminLogin = async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
        return res.status(400).json({ message: "Invalid payload" });

    const id = String(username).trim().toLowerCase();
    const user = await User.findOne({ $or: [{ username: id }, { email: id }] }).select("+password");

    if (!user || !(await bcrypt.compare(password, user.password)))
        return res.status(401).json({ message: "Invalid credentials" });

    if (user.blocked) {
        return res.status(403).json({ message: "Account suspended. Contact support." });
    }

    const adminEmails = ["balavardhan12178@gmail.com", "balavardhanpula@gmail.com"];
    if (!adminEmails.includes(user.email)) {
        return res.status(403).json({ message: "Access denied: Not an admin" });
    }

    const token = jwt.sign({ userId: user._id, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.cookie("jwt_token", token, buildCookieOpts(req, true));
    res.json({ token, role: "admin" });
};

// Admin Google Auth
export const adminGoogleAuth = async (req, res) => {
    try {
        const credential = req.body.credential || req.body.idToken;
        if (!credential) return res.status(400).json({ message: "Missing Google credential" });

        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        const email = payload?.email?.toLowerCase();

        const adminEmails = ["balavardhan12178@gmail.com", "balavardhanpula@gmail.com"];
        if (!email || !adminEmails.includes(email)) {
            return res.status(403).json({ message: "Access denied: Not an admin" });
        }

        let user = await User.findOne({ email });
        if (!user) {
            user = await User.create({
                name: payload.name,
                username: email.split("@")[0],
                email,
                profileImage: payload.picture || "",
                password: await bcrypt.hash(crypto.randomBytes(10).toString("hex"), 11),
            });
        }

        const token = jwt.sign({ userId: user._id, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "30d" });
        res.cookie("jwt_token", token, buildCookieOpts(req, true));
        res.json({ token, role: "admin" });
    } catch (err) {
        console.error("Admin Google login error:", err.message);
        res.status(401).json({ message: "Google sign-in failed" });
    }
};

// Admin Verify
export const verifyAdmin = async (req, res) => {
    try {
        const token = req.cookies.jwt_token || req.headers.authorization?.split(" ")[1];
        if (!token) return res.status(401).json({ valid: false, message: "No token" });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.role !== "admin") {
            return res.status(401).json({ valid: false, message: "Not an admin" });
        }

        const user = await User.findById(decoded.userId);
        if (!user || user.blocked) {
            return res.status(401).json({ valid: false, message: "Invalid user" });
        }

        res.json({ valid: true });
    } catch (err) {
        console.error("Admin verify error:", err.message);
        res.status(401).json({ valid: false, message: "Invalid token" });
    }
};

// Logout
export const logout = async (req, res) => {
    try {
        const token = req.cookies.jwt_token || req.headers.authorization?.split(" ")[1];
        if (token) {
            await TokenBlacklist.create({
                token,
                expiredAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            });
        }
        res.clearCookie("jwt_token", buildClearCookieOpts(req));
        res.json({ message: "Logged out successfully" });
    } catch (err) {
        console.error("Logout error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
