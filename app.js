import express from 'express';
import cookieParser from 'cookie-parser';
import { helmetMiddleware, corsMiddleware, commonSecurity } from './middleware/security.js';
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

const app = express();

app.set('trust proxy', 1);
app.use(helmetMiddleware);
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(commonSecurity);
app.use(corsMiddleware);
app.options('*', corsMiddleware);

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

// 404 + errors
app.use(notFound);
app.use(errorHandler);

export default app;
