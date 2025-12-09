import 'dotenv/config';
import mongoose from 'mongoose';
import app from './app.js';
import { spawn } from 'node:child_process'; 

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

  //  route to fix the 404 ---
  app.get('/', (req, res) => {
    res.send('VKart API is running successfully!');
  });

  app.get('/ready', async (req, res) => {
    try { await mongoose.connection.db.admin().command({ ping: 1 }); res.status(200).send('ready'); }
    catch { res.status(500).send('not-ready'); }
  });

  app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));

  // Auto-start Chroma server in background (for AI vector search)
  spawn('npx', ['chroma', 'run', '--path', './chroma_db', '--port', '8000'], { 
    stdio: 'ignore', 
    detached: true, 
    shell: true 
  });
  console.log('Chroma vector DB started in background on port 8000');
})();