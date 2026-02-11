import helmet from 'helmet';
import cors from 'cors';
import mongoSanitize from 'express-mongo-sanitize';
import hpp from 'hpp';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';

// Shared CORS origin checker (used by both HTTP and Socket.io)
export const allowOrigin = (origin) => {
  if (!origin) return true;
  const normalized = String(origin).replace(/\/+$/, '');
  if ([
    'http://localhost:3000', 'http://127.0.0.1:3000',
    'http://localhost:5173', 'http://127.0.0.1:5173',
    'https://vkartshop.netlify.app',
    'https://vkart-admin.balavardhan.dev',
    'https://vkart.balavardhan.dev',
    'https://vkart-t64z.onrender.com'
  ].includes(normalized)) return true;
  if (/^https:\/\/[a-z0-9-]+--vkartshop\.netlify\.app$/.test(normalized)) return true;
  if (/^http:\/\/localhost:\d+$/.test(normalized) || /^http:\/\/127\.0\.0\.1:\d+$/.test(normalized)) return true;
  if (process.env.APP_ORIGIN && normalized === String(process.env.APP_ORIGIN).replace(/\/+$/, '')) return true;
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
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});

export const commonSecurity = [
  compression(),
  mongoSanitize(),
  hpp(),
];

const getCookieOpts = (req) => {
  const isProduction = process.env.NODE_ENV === 'production';
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' || isProduction;
  return {
    httpOnly: false,
    secure,
    sameSite: isProduction ? 'None' : 'Lax',
    path: '/',
  };
};

export const csrfMiddleware = (req, res, next) => {
  const token = req.cookies?.csrf_token;
  if (!token) {
    const newToken = crypto.randomBytes(24).toString('hex');
    res.cookie('csrf_token', newToken, getCookieOpts(req));
    req.csrfToken = newToken;
    return next();
  }
  req.csrfToken = token;
  next();
};

// CSRF Guard - Apply selectively to state-changing routes (not auth endpoints)
export const csrfGuard = (req, res, next) => {
  const method = String(req.method || 'GET').toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return next();

  // Exempt auth routes from CSRF (they use other protections)
  const exemptPaths = [
    '/api/login',
    '/api/register',
    '/api/auth/google',
    '/api/admin/login',
    '/api/admin/google',
    '/api/logout',
    '/api/admin/logout',
    '/api/forgot',
    '/api/reset',
    '/api/verify-email',
    '/api/resend-verify',
    '/razorpay/verify',
    '/api/wallet/verify',
    '/api/membership/verify',
  ];
  
  if (exemptPaths.some(path => req.path === path || req.originalUrl === path)) {
    return next();
  }

  const token = req.cookies?.csrf_token;
  const header = req.headers['x-csrf-token'];

  if (!token || !header) {
    return res.status(403).json({ error: 'invalid csrf token' });
  }

  // Use timing-safe comparison to prevent timing attacks
  try {
    const tokenBuf = Buffer.from(token, 'utf8');
    const headerBuf = Buffer.from(header, 'utf8');
    if (tokenBuf.length !== headerBuf.length || !crypto.timingSafeEqual(tokenBuf, headerBuf)) {
      return res.status(403).json({ error: 'invalid csrf token' });
    }
  } catch {
    return res.status(403).json({ error: 'invalid csrf token' });
  }
  next();
};

export const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true });
export const registerLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true });
export const forgotLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, standardHeaders: true });
export const resetLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, standardHeaders: true });
export const googleLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true });
export const aiChatLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, message: { error: 'Too many requests, please slow down' } });

// Global API rate limiter — 200 requests per minute per IP
export const globalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
  skip: (req) => req.path === '/health' || req.path === '/ready',
});
