const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const User = require('../models/User');

const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 10000000
  },
  fileFilter(req, file, cb) {
    if (!file.originalname.match(/\.(jpg|jpeg|png)$/)) {
      return cb(new Error('Please upload an image'));
    }
    cb(undefined, true);
  }
});

router.post('/register', async (req, res) => {
  try {
    const { name, username, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 8);
    const user = new User({ name, username, email, password: hashedPassword });
    await user.save();
    res.status(201).send({ message: 'User registered successfully' });
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) {
      throw new Error('User not found');
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      throw new Error('Invalid credentials');
    }
    const token = jwt.sign({ _id: user._id }, 'my_secret_key', { expiresIn: '30d' });
    res.cookie('jwt_token', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.send({ token });
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

router.get('/profile', async (req, res) => {
  try {
    const token = req.cookies.jwt_token;
    const decoded = jwt.verify(token, 'my_secret_key');
    const user = await User.findById(decoded._id);
    if (!user) {
      throw new Error('User not found');
    }
    res.send(user);
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

router.post('/profile/upload', upload.single('profilePicture'), async (req, res) => {
  try {
    const token = req.cookies.jwt_token;
    const decoded = jwt.verify(token, 'my_secret_key');
    const user = await User.findById(decoded._id);
    if (!user) {
      throw new Error('User not found');
    }
    user.profilePicture = req.file.filename;
    await user.save();
    res.send({ profilePicture: req.file.filename });
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

module.exports = router;
