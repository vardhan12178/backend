import 'dotenv/config';
import mongoose from 'mongoose';
import app from './app.js';

const PORT = process.env.PORT || 5000;

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      maxPoolSize: 10, serverSelectionTimeoutMS: 5000, socketTimeoutMS: 20000
    });
    console.log('Connected to MongoDB Atlas');
  } catch (e) {
    console.error('Mongo connection failed', e);
    process.exit(1);
  }

  app.get('/ready', async (req, res) => {
    try { await mongoose.connection.db.admin().command({ ping: 1 }); res.status(200).send('ready'); }
    catch { res.status(500).send('not-ready'); }
  });

  app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
})();
