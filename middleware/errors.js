export const notFound = (req, res) => res.status(404).json({ error: 'not_found' });

export const errorHandler = (err, req, res, next) => {
  // Optionally log with pino/winston here
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.code || 'server_error', message: err.message || 'Internal server error' });
};
