const express  = require("express");
const { body, validationResult } = require("express-validator");
const { v4: uuid } = require("uuid");
const router   = express.Router();
const pool     = require("../db/pool");
const { setAppMetadata, deleteAuth0User } = require("../utils/auth0Management");
const logger   = require("../utils/logger");

// ─── GET /api/users/me ────────────────────────────────────────────────────────
// Returns the current user's On My Way profile.
// Never returns GPS coordinates — those are never stored.
router.get("/me", async (req, res) => {
  try {
    const { id, auth0_id, account_type, traveler_tier, special_rate,
            verified, verified_at, rating, rating_count, created_at } = req.user;
    res.json({
      id, auth0_id, account_type, traveler_tier, special_rate,
      verified, verified_at, rating, rating_count,
      member_since: created_at,
    });
  } catch (err) {
    logger.error("GET /me error", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── PUT /api/users/me/profile ────────────────────────────────────────────────
// Update account type and tier after signup completion.
// Writes to both our DB and Auth0 app_metadata (server-side — secure).
router.put("/me/profile",
  body("account_type").isIn(["traveler","passenger"]),
  body("traveler_tier").optional().isIn(["starter","pro","elite"]),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { account_type, traveler_tier, special_rate } = req.body;
    try {
      // Update our DB
      await pool.query(
        `UPDATE users
         SET account_type = $1, traveler_tier = $2, special_rate = $3, updated_at = NOW()
         WHERE id = $4`,
        [account_type, traveler_tier || null, special_rate || "none", req.user.id]
      );

      // Write to Auth0 app_metadata (admin-only — users cannot self-modify this)
      await setAppMetadata(req.user.auth0_id, {
        omw_accountType:  account_type,
        omw_travelerTier: traveler_tier || null,
        omw_specialRate:  special_rate || "none",
        omw_updatedAt:    new Date().toISOString(),
      });

      res.json({ success: true, account_type, traveler_tier });
    } catch (err) {
      logger.error("PUT /me/profile error", { error: err.message });
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ─── GET /api/users/me/export ─────────────────────────────────────────────────
// Data export — WPA / GDPR requirement.
// Returns everything On My Way has about the user.
// No GPS coordinates (we never stored them).
router.get("/me/export", async (req, res) => {
  try {
    const userId = req.user.id;

    const [userRes, tripsRes, contributionsRes, ratingsRes] = await Promise.all([
      pool.query("SELECT * FROM users WHERE id = $1", [userId]),
      pool.query(
        `SELECT id, status, distance_miles, region, contribution,
                peak_rate, trip_date, completed_at
         FROM trips
         WHERE driver_id = $1 OR passenger_id = $1
         ORDER BY trip_date DESC`,
        [userId]
      ),
      pool.query(
        `SELECT amount, distance_miles, trip_date, peak_rate
         FROM contributions
         WHERE driver_id = $1 OR passenger_id = $1
         ORDER BY trip_date DESC`,
        [userId]
      ),
      pool.query(
        `SELECT score, created_at FROM ratings WHERE rated_id = $1`,
        [userId]
      ),
    ]);

    const exportData = {
      export_generated_at: new Date().toISOString(),
      note: "On My Way never stores GPS coordinates. Location data stays on your device only.",
      profile: userRes.rows[0],
      trips:   tripsRes.rows,
      contributions: contributionsRes.rows,
      ratings: ratingsRes.rows,
    };

    // Log the export request
    await pool.query(
      `INSERT INTO export_requests (user_id, status, completed_at)
       VALUES ($1, 'completed', NOW())`,
      [userId]
    );

    res.json(exportData);
  } catch (err) {
    logger.error("GET /me/export error", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── DELETE /api/users/me ─────────────────────────────────────────────────────
// Full account deletion — WPA / GDPR requirement.
// Soft-deletes the account now; hard deletion runs after 30 days (cleanup job).
// Auth0 user is deleted immediately.
router.delete("/me", async (req, res) => {
  const userId   = req.user.id;
  const auth0Id  = req.user.auth0_id;
  const client   = await pool.connect();

  try {
    await client.query("BEGIN");

    // Soft-delete the user record (hard delete in 30 days by cleanup job)
    await client.query(
      "UPDATE users SET deleted_at = NOW(), active = false WHERE id = $1",
      [userId]
    );

    // Log the deletion request
    await client.query(
      `INSERT INTO deletion_requests
         (user_id, status, deleted_profile)
       VALUES ($1, 'processing', true)`,
      [userId]
    );

    await client.query("COMMIT");

    // Delete Auth0 user immediately (async — don't block response)
    deleteAuth0User(auth0Id).catch(err =>
      logger.error("Auth0 delete failed", { userId, error: err.message })
    );

    logger.info("User deletion initiated", { userId });
    res.json({
      success: true,
      message: "Account deletion initiated. Your data will be permanently removed within 30 days.",
      note: "GPS coordinates were never stored — there is no location history to delete.",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error("DELETE /me error", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

module.exports = router;
