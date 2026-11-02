import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import speakeasy from "speakeasy";
import User from "../../models/User.js";
import { buildCookieOpts, buildClearCookieOpts } from "../../utils/cookies.js";
import { decrypt, HAS_VALID_KEY } from "../../utils/crypto.js";
import { GOOGLE_CLIENT_ID, googleClient } from "./shared.js";
import { buildSessionPayload } from "./session.controller.js";

// Login
export const login = async (req, res) => {
  try {
    const { username, password, remember, token2fa } = req.body;
    if (!username || !password) return res.status(400).json({ message: "Invalid payload" });

    const id = String(username).trim().toLowerCase();
    const user = await User.findOne({ $or: [{ username: id }, { email: id }] }).select(
      "+password +twoFactorSecretEnc"
    );

    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ message: "Invalid credentials" });

    if (user.blocked) {
      return res.status(403).json({ message: "Account suspended. Contact support." });
    }

    if (user.twoFactorEnabled) {
      if (!token2fa) {
        // Return opaque challenge token instead of raw userId
        const { create2FAChallenge } = await import("./twofactor.controller.js");
        const challengeToken = await create2FAChallenge(user._id);
        return res.json({
          require2FA: true,
          challengeToken,
        });
      }

      if (!user.twoFactorSecretEnc) {
        return res
          .status(500)
          .json({ message: "2FA secret missing. Please disable and enable 2FA again." });
      }

      if (!HAS_VALID_KEY) {
        return res.status(500).json({ message: "2FA key not configured on server" });
      }

      let base32Secret = null;
      try {
        base32Secret = decrypt(user.twoFactorSecretEnc);
      } catch (err) {
        console.error("2FA decrypt error in login:", err);
        return res.status(500).json({ message: "2FA verification failed" });
      }

      if (!base32Secret) {
        return res.status(500).json({ message: "2FA secret invalid" });
      }

      const ok = speakeasy.totp.verify({
        secret: base32Secret,
        encoding: "base32",
        token: token2fa,
        window: 1,
      });

      if (!ok) {
        return res.status(401).json({ message: "Invalid 2FA code" });
      }
    }

    const token = jwt.sign(
      { userId: user._id, roles: user.roles || ["user"] },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );
    res.cookie("jwt_token", token, buildCookieOpts(req, remember));

    const session = await buildSessionPayload(user._id);
    if (!session.authenticated) {
      res.clearCookie("jwt_token", buildClearCookieOpts(req));
      return res.status(401).json({ message: "Account unavailable" });
    }
    res.json({ ...session, token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Google Auth
export const googleAuth = async (req, res) => {
  try {
    const credential = req.body.credential || req.body.idToken;
    const remember = req.body.remember !== false;
    if (!credential) return res.status(400).json({ message: "Missing Google credential" });

    if (!googleClient) return res.status(500).json({ message: "Google client not configured" });

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload?.email) return res.status(400).json({ message: "Google account missing email" });

    const email = payload.email.toLowerCase();
    let user = await User.findOne({ email });

    if (!user) {
      user = await User.create({
        name: payload.name,
        username: email.split("@")[0],
        email,
        profileImage: payload.picture || "",
        password: await bcrypt.hash(crypto.randomBytes(10).toString("hex"), 11),
        emailVerified: true,
      });
    } else if (
      payload.picture &&
      (!user.profileImage || user.profileImage.includes("googleusercontent.com"))
    ) {
      user.profileImage = payload.picture;
      await user.save();
    }

    const token = jwt.sign(
      { userId: user._id, roles: user.roles || ["user"] },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );
    res.cookie("jwt_token", token, buildCookieOpts(req, remember));

    const session = await buildSessionPayload(user._id);
    if (!session.authenticated) {
      res.clearCookie("jwt_token", buildClearCookieOpts(req));
      return res.status(401).json({ message: "Account unavailable" });
    }
    res.json({ ...session, token });
  } catch (err) {
    console.error("Google login error:", err.message);
    res.status(401).json({ message: "Google sign-in failed" });
  }
};
