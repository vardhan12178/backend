export const notFound = (req, res) => res.status(404).json({ error: 'not_found' });

export const errorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  const status = err.status || 500;
  const isProd = process.env.NODE_ENV === 'production';

  // Always log server errors for debugging
  if (status >= 500) {
    console.error(`[ERROR] ${req.method} ${req.originalUrl}:`, err.stack || err.message);
  }

  res.status(status).json({
    error: err.code || 'server_error',
    // In production, only expose messages for client errors (4xx), never for 5xx
    message: status < 500
      ? (err.message || 'Bad request')
      : (isProd ? 'Internal server error' : (err.message || 'Internal server error')),
  });
};
