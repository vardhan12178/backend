const express = require('express');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const User = require('./models/User'); // Import the User model

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(cookieParser());

app.use(cors({
    origin: ['http://localhost:3000', 'https://vkartshop.netlify.app'],
    credentials: true,
}));

const JWT_SECRET = process.env.JWT_SECRET || 'my_secret_key'; 

// Connect to MongoDB Atlas
mongoose.connect('mongodb+srv://balavardhan12178:itUwOI4YXYvZh2Qs@vkart.ixjzyfj.mongodb.net/vkart?retryWrites=true&w=majority', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('Connected to MongoDB Atlas');
}).catch(err => {
  console.error('Failed to connect to MongoDB Atlas', err);
});

// Registration Endpoint
app.post('/api/register', async (req, res) => {
  const { username, email, password, confirmPassword } = req.body;

  if (password !== confirmPassword) {
    return res.status(400).json({ message: 'Passwords do not match' });
  }

  try {
    const existingUser = await User.findOne({ username });

    if (existingUser) {
      return res.status(409).json({ message: 'Username already exists' });
    }

    const newUser = new User({ username, email, password });
    await newUser.save();

    res.status(201).json({ message: 'User registered successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Login Endpoint
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await User.findOne({ username, password });

    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '30d' });

    res.cookie('jwt_token', token, {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, 
      secure: process.env.NODE_ENV === 'production', 
      sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'Lax',
    });

    res.json({ token });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Verify Endpoint
app.get('/api/verify', (req, res) => {
  const token = req.cookies.jwt_token;

  if (!token) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ userId: decoded.userId });
  } catch (error) {
    res.status(401).json({ message: 'Invalid token' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
