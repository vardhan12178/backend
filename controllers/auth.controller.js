import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { sendEmail, emailTemplate } from '../services/email.service.js';
import { OAuth2Client } from 'google-auth-library';
import speakeasy from 'speakeasy';

import User from '../models/User.js';
import TokenBlacklist from "../models/TokenBlacklist.js";
import { buildCookieOpts, buildClearCookieOpts } from '../utils/cookies.js';
import { decrypt, HAS_VALID_KEY } from '../utils/crypto.js';
import { createNotification } from './admin.notifications.controller.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

const APP_URL = (process.env.APP_URL || 'https://vkartshop.netlify.app').replace(/\/+$/, '');

const createEmailVerifyToken = () => {
    const tokenRaw = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(tokenRaw).digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    return { tokenRaw, tokenHash, expiresAt };
};

// Register
export const register = async (req, res) => {
    let { name, username, email, password, confirmPassword } = req.body;
    const profileImage = req.file ? req.file.location : '';
    if (!username || !email || !password)
        return res.status(400).json({ message: 'Missing required fields' });
    if (String(password).length < 8)
        return res.status(400).json({ message: 'Password must be at least 8 characters' });
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

        // Email verification
        const { tokenRaw, tokenHash, expiresAt } = createEmailVerifyToken();
        newUser.emailVerifyTokenHash = tokenHash;
        newUser.emailVerifyExpiresAt = expiresAt;
        await newUser.save();

        const verifyLink = `${APP_URL}/verify-email?token=${tokenRaw}`;
        await sendEmail({
            to: newUser.email,
            subject: 'Verify your VKart email',
            html: emailTemplate({
                title: 'Verify your email',
                body: 'Thanks for signing up. Please verify your email to secure your account.',
                ctaLabel: 'Verify Email',
                ctaUrl: verifyLink,
            })
        });

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
  try {
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
            // Return opaque challenge token instead of raw userId
            const { create2FAChallenge } = await import('./twofactor.controller.js');
            const challengeToken = await create2FAChallenge(user._id);
            return res.json({
                require2FA: true,
                challengeToken,
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

    const token = jwt.sign(
        { userId: user._id, roles: user.roles || ["user"] },
        process.env.JWT_SECRET,
        { expiresIn: '30d' }
    );
    res.cookie('jwt_token', token, buildCookieOpts(req, remember));
    res.json({ token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
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
                emailVerified: true,
            });
        }

        const token = jwt.sign(
            { userId: user._id, roles: user.roles || ["user"] },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );
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

            const link = `${APP_URL}/reset-password?token=${tokenRaw}`;

            try {
                await sendEmail({
                    to: user.email,
                    subject: 'VKart password reset',
                    html: emailTemplate({
                        title: 'Reset your password',
                        body: 'Click the link below to reset your password. The link expires in 30 minutes.',
                        ctaLabel: 'Reset Password',
                        ctaUrl: link,
                    }),
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
  try {
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

    const roles = Array.isArray(user.roles) ? user.roles : ["user"];
    if (!roles.includes("admin")) {
        return res.status(403).json({ message: "Access denied: Not an admin" });
    }

    const token = jwt.sign({ userId: user._id, roles }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.cookie("jwt_token", token, buildCookieOpts(req, true));
    res.json({ token, role: "admin" });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
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

        if (!email) {
            return res.status(400).json({ message: "Google account missing email" });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(403).json({ message: "Access denied: Not an admin" });
        }

        const roles = Array.isArray(user.roles) ? user.roles : ["user"];
        if (!roles.includes("admin")) {
            return res.status(403).json({ message: "Access denied: Not an admin" });
        }

        const token = jwt.sign({ userId: user._id, roles }, process.env.JWT_SECRET, { expiresIn: "30d" });
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
        const roles = Array.isArray(decoded?.roles) ? decoded.roles : [];
        if (!roles.includes("admin")) {
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

// Verify Email
export const verifyEmail = async (req, res) => {
    try {
        const token = String(req.query.token || "");
        if (!token) return res.status(400).json({ message: "Missing token" });

        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const user = await User.findOne({
            emailVerifyTokenHash: tokenHash,
            emailVerifyExpiresAt: { $gt: new Date() },
        });

        if (!user) {
            return res.status(400).json({ message: "Invalid or expired token" });
        }

        user.emailVerified = true;
        user.emailVerifyTokenHash = undefined;
        user.emailVerifyExpiresAt = undefined;
        await user.save();

        return res.json({ message: "Email verified successfully" });
    } catch (err) {
        console.error("Verify email error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// Resend verification (logged-in user)
export const resendVerifyEmail = async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ message: "User not found" });
        if (user.emailVerified) return res.json({ message: "Email already verified" });

        const { tokenRaw, tokenHash, expiresAt } = createEmailVerifyToken();
        user.emailVerifyTokenHash = tokenHash;
        user.emailVerifyExpiresAt = expiresAt;
        await user.save();

        const verifyLink = `${APP_URL}/verify-email?token=${tokenRaw}`;
        await sendEmail({
            to: user.email,
            subject: "Verify your VKart email",
            html: emailTemplate({
                title: "Verify your email",
                body: "Please verify your email to enable all features.",
                ctaLabel: "Verify Email",
                ctaUrl: verifyLink,
            }),
        });

        return res.json({ message: "Verification email sent" });
    } catch (err) {
        console.error("Resend verify error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};
