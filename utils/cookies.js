export const buildCookieOpts = (req, remember) => {
  const origin = req.get('origin') || '';
  const host = req.get('host') || '';
  const crossSite = origin && !origin.includes(host);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
  const opts = { httpOnly: true, secure, sameSite: crossSite ? 'None' : 'Lax', path: '/' };
  if (remember) opts.maxAge = 30 * 24 * 60 * 60 * 1000;
  return opts;
};
