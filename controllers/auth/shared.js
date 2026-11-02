import { OAuth2Client } from "google-auth-library";

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

export const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

export const APP_URL = (process.env.APP_URL || "https://vkart.balavardhan.dev").replace(/\/+$/, "");
