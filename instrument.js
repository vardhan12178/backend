// Optional error monitoring. Loaded first by server.js; does nothing unless
// SENTRY_DSN is set. (For Sentry's automatic performance tracing of Express,
// start with `node --import ./instrument.js server.js` instead.)
import * as Sentry from "@sentry/node";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    release: process.env.RELEASE || undefined,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    // No cookies, auth headers or IPs leave the server.
    sendDefaultPii: false,
  });
}

export default Sentry;
