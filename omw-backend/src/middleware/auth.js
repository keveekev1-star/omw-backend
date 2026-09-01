const { expressjwt: jwt } = require("express-jwt");
const jwksRsa              = require("jwks-rsa");
const pool                 = require("../db/pool");

const DOMAIN   = process.env.AUTH0_DOMAIN;
const AUDIENCE = process.env.AUTH0_AUDIENCE;

// ─── VALIDATE JWT FROM AUTH0 ──────────────────────────────────────────────────
// Verifies the token is real, not expired, and issued by our Auth0 tenant.
// Attaches decoded payload to req.auth
const checkJwt = jwt({
  secret: jwksRsa.expressJwtSecret({
    cache:              true,
    cacheMaxEntries:    5,
    cacheMaxAge:        600000,          // 10 minutes
    rateLimit:          true,
    jwksRequestsPerMinute: 10,
    jwksUri: `https://${DOMAIN}/.well-known/jwks.json`,
  }),
  audience:   AUDIENCE,
  issuer:     `https://${DOMAIN}/`,
  algorithms: ["RS256"],
});

// ─── ATTACH DB USER TO REQUEST ────────────────────────────────────────────────
// After JWT is validated, look up (or create) the user in our database.
// Attaches req.user (our DB user row).
async function attachUser(req, res, next) {
  try {
    const auth0Id = req.auth?.sub;
    if (!auth0Id) return res.status(401).json({ error: "No user identity" });

    // Look up existing user
    let result = await pool.query(
      "SELECT * FROM users WHERE auth0_id = $1 AND deleted_at IS NULL",
      [auth0Id]
    );

    if (result.rows.length === 0) {
      // First time this user has hit the API — create minimal record
      // Account type will be updated when they complete signup
      result = await pool.query(
        `INSERT INTO users (auth0_id, account_type, verified)
         VALUES ($1, 'passenger', false)
         ON CONFLICT (auth0_id) DO UPDATE SET updated_at = NOW()
         RETURNING *`,
        [auth0Id]
      );
    }

    req.user = result.rows[0];
    next();
  } catch (err) {
    console.error("attachUser error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ─── REQUIRE VERIFIED TRAVELER ────────────────────────────────────────────────
function requireTraveler(req, res, next) {
  if (req.user?.account_type !== "traveler") {
    return res.status(403).json({ error: "Traveler account required" });
  }
  if (!req.user?.verified) {
    return res.status(403).json({ error: "Account not yet verified" });
  }
  next();
}

// ─── REQUIRE MINIMUM RATING ───────────────────────────────────────────────────
function requireMinRating(min = 3.5) {
  return (req, res, next) => {
    const rating = parseFloat(req.user?.rating || 5);
    if (req.user?.rating_count > 0 && rating < min) {
      return res.status(403).json({
        error: `Account suspended: rating ${rating} is below the minimum ${min} required for all services.`,
        rating,
        minimum: min,
      });
    }
    next();
  };
}

module.exports = { checkJwt, attachUser, requireTraveler, requireMinRating };
