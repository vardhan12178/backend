import express from 'express';
import mongoose from 'mongoose';
import cookieParser from 'cookie-parser';
import { helmetMiddleware, corsMiddleware, commonSecurity, csrfMiddleware, csrfGuard, globalApiLimiter } from './middleware/security.js';
import { notFound, errorHandler } from './middleware/errors.js';

import authRoutes from './routes/auth.routes.js';
import profileRoutes from './routes/profile.routes.js';
import orderRoutes from './routes/order.routes.js';
import aiRoutes from './routes/ai.routes.js';
import twoFactorRoutes from './routes/twofactor.routes.js';
import razorpayRoutes from './routes/razorpay.routes.js';
import productRoutes from "./routes/product.routes.js";
import adminUsersRoutes from './routes/admin.users.routes.js';
import adminSettingsRoutes from './routes/admin.settings.routes.js';
import adminNotificationRoutes from './routes/admin.notifications.routes.js';
import adminReviewsRoutes from './routes/admin.reviews.routes.js';
import couponRoutes from './routes/coupon.routes.js';
import userNotificationRoutes from './routes/user.notifications.routes.js';
import walletRoutes from './routes/wallet.routes.js';
import saleRoutes from './routes/sale.routes.js';
import membershipRoutes from './routes/membership.routes.js';
import homeRoutes from './routes/home.routes.js';
import blogRoutes from './routes/blog.routes.js';
import newsletterRoutes from './routes/newsletter.routes.js';
import { getSitemap } from './controllers/sitemap.controller.js';

const app = express();

app.set('trust proxy', 1);
app.use(helmetMiddleware);
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(commonSecurity);
app.use(corsMiddleware);
app.options('*', corsMiddleware);
app.use(globalApiLimiter);
app.use(csrfMiddleware);
// Note: csrfGuard is now applied with exemptions for auth routes (see middleware/security.js)
app.use(csrfGuard);

// lightweight request timing
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () =>
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} - ${Date.now() - t0}ms`)
  );
  next();
});

// health
app.get('/health', (req, res) => res.status(200).send('ok'));

// routes
app.use('/api', authRoutes);
app.use('/api', profileRoutes);
app.use('/api', orderRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api', twoFactorRoutes);
app.use('/api', razorpayRoutes);
app.use('/api', productRoutes);
app.use('/api/admin', adminUsersRoutes);
app.use('/api/admin/settings', adminSettingsRoutes);
app.use('/api/admin/notifications', adminNotificationRoutes);
app.use('/api/admin/reviews', adminReviewsRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/user/notifications', userNotificationRoutes);
app.use('/api', walletRoutes);
app.use('/api/sales', saleRoutes);
app.use('/api/membership', membershipRoutes);
app.use('/api', homeRoutes);
app.use('/api', blogRoutes);
app.use('/api/newsletter', newsletterRoutes);
app.get('/sitemap.xml', getSitemap);

// root + readiness (must be before 404 handler)
app.get('/', (req, res) => res.send('VKart API is running successfully!'));
app.get('/ready', async (req, res) => {
  try { await mongoose.connection.db.admin().command({ ping: 1 }); res.status(200).send('ready'); }
  catch { res.status(500).send('not-ready'); }
});

// 404 + errors
app.use(notFound);
app.use(errorHandler);

export default app;
