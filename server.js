import 'dotenv/config';
import mongoose from 'mongoose';
import http from 'http';
import app from './app.js';
import { initSocket } from './utils/socket.js';
import { initRefundScheduler } from './services/refund.scheduler.js';
import redis from './utils/redis.js';

const PORT = process.env.PORT || 5000;
const SHUTDOWN_TIMEOUT = 15_000; // 15s max for graceful shutdown

// Validate required environment variables
const REQUIRED_ENV = ['JWT_SECRET', 'MONGO_URI'];
const missing = REQUIRED_ENV.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

// Warn about optional but important env vars
if (!process.env.AES_KEY || Buffer.from(process.env.AES_KEY, 'utf8').length !== 32) {
  console.warn('[WARN] AES_KEY is missing or not 32 bytes - 2FA will not work');
}

(async () => {
  // ── MongoDB connection ──
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      maxPoolSize: 10, serverSelectionTimeoutMS: 5000, socketTimeoutMS: 20000
    });
    console.log('[INFO] Connected to MongoDB Atlas');
  } catch (e) {
    console.error('[ERROR] Mongo connection failed', e);
    process.exit(1);
  }

  // MongoDB connection resilience — log events for observability
  mongoose.connection.on('disconnected', () => console.warn('[WARN] MongoDB disconnected — driver will auto-reconnect'));
  mongoose.connection.on('reconnected', () => console.log('[INFO] MongoDB reconnected'));
  mongoose.connection.on('error', (err) => console.error('[ERROR] MongoDB connection error:', err.message));

  // ── HTTP Server ──
  const server = http.createServer(app);

  // Request timeout — drop slow / idle connections after 30s
  server.setTimeout(30_000);

  // Initialize Socket.io
  initSocket(server);
  initRefundScheduler();

  server.listen(PORT, '0.0.0.0', () => console.log(`[INFO] Server running on port ${PORT}`));

  // ── Graceful Shutdown ──
  const shutdown = async (signal) => {
    console.log(`\n[INFO] ${signal} received — starting graceful shutdown`);

    // Stop accepting new connections
    server.close(() => console.log('[INFO] HTTP server closed'));

    // Force-kill after timeout
    const forceTimer = setTimeout(() => {
      console.error('[ERROR] Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT);
    forceTimer.unref();

    try {
      await mongoose.connection.close();
      console.log('[INFO] MongoDB connection closed');
    } catch (e) {
      console.error('[ERROR] MongoDB close error:', e.message);
    }

    try {
      await redis.quit();
      console.log('[INFO] Redis connection closed');
    } catch (e) {
      console.error('[ERROR] Redis close error:', e.message);
    }

    console.log('[INFO] Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})();
