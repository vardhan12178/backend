export const buildCookieOpts = (req, remember) => {
  const isProduction = process.env.NODE_ENV === 'production';
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' || isProduction;

  const opts = {
    httpOnly: true,
    secure,
    sameSite: isProduction ? 'None' : 'Lax',
    path: '/'
  };

  if (remember) opts.maxAge = 30 * 24 * 60 * 60 * 1000;
  return opts;
};

// For clearing cookies - must match sameSite/secure or browser won't delete it
export const buildClearCookieOpts = (req) => {
  const isProduction = process.env.NODE_ENV === 'production';
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' || isProduction;

  return {
    httpOnly: true,
    secure,
    sameSite: isProduction ? 'None' : 'Lax',
    path: '/'
  };
};
