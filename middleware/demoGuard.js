import jwt from "jsonwebtoken";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
// Signing out must always work, even for the read-only admin
const ALWAYS_ALLOWED = new Set([
  "/api/logout",
  "/api/admin/logout",
  "/api/auth/demo/shopper",
  "/api/auth/demo/admin",
]);
// The shared shopper can do everything a shopper does except lock other visitors out of the account
const SHOPPER_BLOCKED = [/^\/api\/profile\/password/, /^\/api\/2fa\//, /^\/api\/profile\/email/];

// Demo tokens carry a `demo` claim. The demo admin is strictly read-only; the demo shopper cannot change credentials.
export const demoGuard = (req, res, next) => {
  if (SAFE.has(String(req.method).toUpperCase())) return next();
  const path = req.originalUrl.split("?")[0];
  if (ALWAYS_ALLOWED.has(path)) return next();

  const bearer = req.headers.authorization;
  const token = req.cookies?.jwt_token || (bearer?.startsWith("Bearer ") ? bearer.slice(7) : null);
  if (!token) return next();

  let claim;
  try {
    claim = jwt.verify(token, process.env.JWT_SECRET)?.demo;
  } catch {
    return next();
  }
  if (claim === "admin") {
    return res
      .status(403)
      .json({ message: "The demo admin is read-only. Sign in as a shopper to place orders." });
  }
  if (claim === "shopper" && SHOPPER_BLOCKED.some((re) => re.test(path))) {
    return res
      .status(403)
      .json({ message: "Credentials can't be changed on the shared demo account." });
  }
  return next();
};
