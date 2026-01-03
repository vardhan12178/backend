import helmet from 'helmet';
import cors from 'cors';
import mongoSanitize from 'express-mongo-sanitize';
import hpp from 'hpp';
import compression from 'compression';
import rateLimit from 'express-rate-limit';

const allowOrigin = (origin) => {
  if (!origin) return false;
  if ([
    'http://localhost:3000', 'http://127.0.0.1:3000',
    'http://localhost:5173', 'http://127.0.0.1:5173',
    'https://vkartshop.netlify.app',
    'https://vkart.balavardhan.dev'
  ].includes(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+--vkartshop\.netlify\.app$/.test(origin)) return true;
  if (process.env.APP_ORIGIN && origin === process.env.APP_ORIGIN) return true;
  return false;
};

export const corsMiddleware = cors({
  origin(origin, cb) { allowOrigin(origin) ? cb(null, true) : cb(null, false); },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Requested-With', 'X-CSRF-Token', 'Authorization'],
  maxAge: 86400,
});

export const helmetMiddleware = helmet({
  contentSecurityPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginEmbedderPolicy: false,
});

export const commonSecurity = [
  compression(),
  mongoSanitize(),
  hpp(),
];

export const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true });
export const registerLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true });
export const forgotLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, standardHeaders: true });
export const resetLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, standardHeaders: true });
export const googleLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true });
export const aiChatLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, message: { error: 'Too many requests, please slow down' } });

