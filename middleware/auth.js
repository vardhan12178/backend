import jwt from 'jsonwebtoken';

export const authenticateJWT = (req, res, next) => {
  const bearer = req.headers.authorization;
  const token = req.cookies?.jwt_token || (bearer?.startsWith('Bearer ') ? bearer.slice(7) : null);
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
    if (err) return res.status(403).json({ error: 'forbidden' });
    req.user = payload; // { userId }
    next();
  });
};
