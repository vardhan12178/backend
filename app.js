import express from 'express';
import cookieParser from 'cookie-parser';
import { helmetMiddleware, corsMiddleware, commonSecurity } from './middleware/security.js';
import { notFound, errorHandler } from './middleware/errors.js';

import authRoutes from './routes/auth.routes.js';
import profileRoutes from './routes/profile.routes.js';
import orderRoutes from './routes/order.routes.js';

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
  res.on('finish', () => console.log(`${req.method} ${req.originalUrl} ${res.statusCode} - ${Date.now()-t0}ms`));
  next();
});

// health
app.get('/health', (req, res) => res.status(200).send('ok'));

// routes
app.use('/api', authRoutes);
app.use('/api', profileRoutes);
app.use('/api', orderRoutes);

// 404 + errors
app.use(notFound);
app.use(errorHandler);

export default app;
