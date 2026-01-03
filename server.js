import 'dotenv/config';
import mongoose from 'mongoose';
import http from 'http';
import app from './app.js';
import { initSocket } from './utils/socket.js';

const PORT = process.env.PORT || 5000;

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
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      maxPoolSize: 10, serverSelectionTimeoutMS: 5000, socketTimeoutMS: 20000
    });
    console.log('[INFO] Connected to MongoDB Atlas');
  } catch (e) {
    console.error('[ERROR] Mongo connection failed', e);
    process.exit(1);
  }

  //  route to fix the 404 ---
  app.get('/', (req, res) => {
    res.send('VKart API is running successfully!');
  });

  app.get('/ready', async (req, res) => {
    try { await mongoose.connection.db.admin().command({ ping: 1 }); res.status(200).send('ready'); }
    catch { res.status(500).send('not-ready'); }
  });

  // Create HTTP Server for Socket.io
  const server = http.createServer(app);

  // Initialize Socket.io
  initSocket(server);

  server.listen(PORT, '0.0.0.0', () => console.log(`[INFO] Server running on port ${PORT}`));
})();