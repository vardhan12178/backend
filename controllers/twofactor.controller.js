import speakeasy from "speakeasy";
import qrcode from "qrcode";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { buildCookieOpts } from "../utils/cookies.js";
import { encrypt, decrypt, HAS_VALID_KEY } from "../utils/crypto.js";

/* 1) Generate Secret + QR */
export const setup2FA = async (req, res) => {
    try {
        const secret = speakeasy.generateSecret({
            name: `VKart (${req.user.email})`,
            length: 20,
        });

        const qr = await qrcode.toDataURL(secret.otpauth_url);

        res.json({
            qr,
            manualEntryKey: secret.base32,
            secret: secret.base32,
        });
    } catch (err) {
        console.error("2FA setup error:", err);
        res.status(500).json({ message: "Error generating setup" });
    }
};

/* 2) Enable 2FA */
export const enable2FA = async (req, res) => {
    try {
        const { token, secret } = req.body;
        if (!token || !secret) return res.status(400).json({ message: "Missing data" });

        const ok = speakeasy.totp.verify({
            secret,
            encoding: "base32",
            token,
            window: 1,
        });

        if (!ok) return res.status(400).json({ message: "Invalid code" });

        if (!HAS_VALID_KEY)
            return res.status(500).json({ message: "2FA key not configured on server" });

        req.user.twoFactorSecretEnc = encrypt(secret);
        req.user.twoFactorEnabled = true;
        await req.user.save();

        res.json({ message: "2FA enabled" });
    } catch (err) {
        console.error("2FA enable error:", err);
        res.status(500).json({ message: "Error enabling 2FA" });
    }
};

/* 3) Disable 2FA */
export const disable2FA = async (req, res) => {
    try {
        req.user.twoFactorEnabled = false;
        req.user.twoFactorSecretEnc = undefined;
        await req.user.save();
        res.json({ message: "2FA disabled" });
    } catch (err) {
        console.error("2FA disable error:", err);
        res.status(500).json({ message: "Error disabling 2FA" });
    }
};

/* 4) Verify (Login) */
export const verify2FA = async (req, res) => {
    try {
        const { userId, token } = req.body;
        if (!userId || !token)
            return res.status(400).json({ message: "Missing parameters" });

        const user = await User.findById(userId).select("+twoFactorSecretEnc");
        if (!user || !user.twoFactorEnabled)
            return res.status(400).json({ message: "2FA not enabled" });

        if (!user.twoFactorSecretEnc)
            return res.status(400).json({ message: "No 2FA secret found" });

        if (!HAS_VALID_KEY)
            return res.status(500).json({ message: "2FA key not configured on server" });

        const base32Secret = decrypt(user.twoFactorSecretEnc);
        if (!base32Secret)
            return res.status(500).json({ message: "Could not read 2FA secret" });

        const ok = speakeasy.totp.verify({
            secret: base32Secret,
            encoding: "base32",
            token,
            window: 1,
        });

        if (!ok) return res.status(400).json({ message: "Invalid verification code" });

        const jwtToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
            expiresIn: "30d",
        });
        res.cookie("jwt_token", jwtToken, buildCookieOpts(req, true));
        res.json({ token: jwtToken });
    } catch (err) {
        console.error("2FA verify error:", err);
        res.status(500).json({ message: "Error verifying 2FA" });
    }
};

/* 5) Suppress Popup */
export const suppress2FAPrompt = async (req, res) => {
    try {
        req.user.suppress2faPrompt = true;
        await req.user.save();
        res.json({ message: "2FA prompt suppressed" });
    } catch (err) {
        console.error("2FA suppress error:", err);
        res.status(500).json({ message: "Error suppressing prompt" });
    }
};
