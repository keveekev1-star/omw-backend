const express = require("express");
const { body, validationResult } = require("express-validator");
const router  = express.Router();
const pool    = require("../db/pool");
const { requireTraveler, requireMinRating } = require("../middleware/auth");
const logger  = require("../utils/logger");

// ─── POST /api/trips ──────────────────────────────────────────────────────────
// Create a new trip record when a traveler broadcasts a route.
// PRIVACY: Only distance_miles and region accepted — NO coordinates.
// GPS calculation happens client-side. Only the result is sent here.
router.post("/",
  requireTraveler,
  requireMinRating(3.5),
  [
    body("distance_miles").isFloat({ min: 0.1, max: 500 }),
    body("region").isString().trim().isLength({ min: 2, max: 100 }),
    body("contribution").isFloat({ min: 0 }),
    body("peak_rate").isBoolean(),
    body("seats").optional().isInt({ min: 1, max: 8 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    // Explicitly reject any coordinate data if accidentally sent
    if (req.body.lat || req.body.lon || req.body.latitude || req.body.longitude ||
        req.body.coordinates || req.body.route || req.body.pickup || req.body.dropoff) {
      return res.status(400).json({
        error: "GPS coordinates must not be sent to the server. Send distance_miles and region only.",
        privacy_note: "On My Way never stores location data server-side.",
      });
    }

    try {
      const { distance_miles, region, contribution, peak_rate } = req.body;

      const result = await pool.query(
        `INSERT INTO trips
           (driver_id, distance_miles, region, contribution, peak_rate, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         RETURNING id, status, distance_miles, region, contribution, trip_date`,
        [req.user.id, distance_miles, region, contribution, peak_rate]
      );

      // Also create contribution record for tax purposes
      await pool.query(
        `INSERT INTO contributions
           (trip_id, driver_id, amount, peak_rate, distance_miles, trip_date)
         VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)`,
        [result.rows[0].id, req.user.id, contribution, peak_rate, distance_miles]
      );

      res.status(201).json(result.rows[0]);
    } catch (err) {
      logger.error("POST /trips error", { error: err.message });
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ─── GET /api/trips ───────────────────────────────────────────────────────────
// Trip history for the current user. No coordinates ever returned.
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.status, t.distance_miles, t.region,
              t.contribution, t.peak_rate, t.trip_date,
              u_driver.account_type   AS driver_type,
              CASE WHEN t.driver_id = $1
                   THEN 'driver' ELSE 'passenger' END AS my_role
       FROM trips t
       LEFT JOIN users u_driver ON u_driver.id = t.driver_id
       WHERE t.driver_id = $1 OR t.passenger_id = $1
       ORDER BY t.trip_date DESC, t.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error("GET /trips error", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── PATCH /api/trips/:id/complete ───────────────────────────────────────────
// Mark a trip as completed and record the final contribution.
router.patch("/:id/complete",
  [body("final_contribution").isFloat({ min: 0 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const result = await pool.query(
        `UPDATE trips
         SET status = 'completed',
             contribution = $1,
             completed_at = NOW()
         WHERE id = $2
           AND (driver_id = $3 OR passenger_id = $3)
           AND status = 'active'
         RETURNING *`,
        [req.body.final_contribution, req.params.id, req.user.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Trip not found or already completed" });
      }

      // Update contribution record
      await pool.query(
        "UPDATE contributions SET amount = $1 WHERE trip_id = $2",
        [req.body.final_contribution, req.params.id]
      );

      res.json({ success: true, trip: result.rows[0] });
    } catch (err) {
      logger.error("PATCH /trips/:id/complete error", { error: err.message });
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ─── POST /api/trips/:id/rate ─────────────────────────────────────────────────
router.post("/:id/rate",
  [body("score").isInt({ min: 1, max: 5 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const tripRes = await pool.query(
        "SELECT * FROM trips WHERE id = $1 AND status = 'completed'",
        [req.params.id]
      );
      if (tripRes.rows.length === 0) {
        return res.status(404).json({ error: "Completed trip not found" });
      }

      const trip = tripRes.rows[0];
      const myId = req.user.id;
      const ratedId = trip.driver_id === myId ? trip.passenger_id : trip.driver_id;

      if (!ratedId) return res.status(400).json({ error: "Cannot determine who to rate" });

      await pool.query(
        `INSERT INTO ratings (trip_id, rater_id, rated_id, score)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [req.params.id, myId, ratedId, req.body.score]
      );

      // Check if rating drops below 3.5 — if so flag for review
      const avgRes = await pool.query(
        "SELECT AVG(score) as avg FROM ratings WHERE rated_id = $1",
        [ratedId]
      );
      const avg = parseFloat(avgRes.rows[0]?.avg || 5);
      if (avg < 3.5) {
        logger.warn("Driver rating below 3.5 — flagged for review", { userId: ratedId, avg });
        // In production: trigger notification to admin
      }

      res.json({ success: true });
    } catch (err) {
      logger.error("POST /trips/:id/rate error", { error: err.message });
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

module.exports = router;
