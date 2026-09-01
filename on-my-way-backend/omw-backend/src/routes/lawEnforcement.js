const express = require("express");
const { body, validationResult } = require("express-validator");
const router  = express.Router();
const pool    = require("../db/pool");
const logger  = require("../utils/logger");

// ─────────────────────────────────────────────────────────────────────────────
// LAW ENFORCEMENT ACCESS LOG
//
// Every disclosure of user data to law enforcement is logged here.
// This log is PERMANENT — never deleted.
//
// Policy (matches in-app privacy disclosure):
//   • Court order / search warrant required for standard requests
//   • Three emergency exceptions (no warrant):
//     1. Life endangerment
//     2. Child endangerment
//     3. Active sex trafficking investigation
//   • Users are notified when legally permissible
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/law-enforcement/log
// Internal use only — called by On My Way staff when handling a request.
// In production: add strict admin-only authentication middleware.
router.post("/log",
  [
    body("requesting_agency").isString().trim().notEmpty(),
    body("warrant_type").isIn([
      "court_order","search_warrant","emergency_life",
      "emergency_child","emergency_trafficking","subpoena"
    ]),
    body("target_user_id").isUUID(),
    body("data_disclosed").isString().trim().notEmpty(),
    body("disclosed_by").isString().trim().notEmpty(),
    body("legal_review").isBoolean(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const {
      requesting_agency, badge_number, warrant_number, warrant_type,
      target_user_id, data_disclosed, disclosed_by, legal_review, legal_notes,
    } = req.body;

    // Enforce warrant requirement for non-emergency requests
    const emergencyTypes = ["emergency_life","emergency_child","emergency_trafficking"];
    const isEmergency    = emergencyTypes.includes(warrant_type);

    if (!isEmergency && !warrant_number) {
      return res.status(400).json({
        error: "Warrant number is required for non-emergency law enforcement requests.",
        policy: "On My Way requires a valid court order or warrant for all standard disclosures.",
      });
    }

    if (!isEmergency && !legal_review) {
      return res.status(400).json({
        error: "Legal review confirmation is required for non-emergency requests.",
      });
    }

    try {
      const result = await pool.query(
        `INSERT INTO law_enforcement_log
           (requesting_agency, badge_number, warrant_number, warrant_type,
            target_user_id, data_disclosed, disclosed_by, legal_review, legal_notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, created_at`,
        [requesting_agency, badge_number || null, warrant_number || null,
         warrant_type, target_user_id, data_disclosed, disclosed_by,
         legal_review, legal_notes || null]
      );

      logger.warn("LAW ENFORCEMENT DISCLOSURE", {
        log_id:           result.rows[0].id,
        agency:           requesting_agency,
        warrant_type,
        is_emergency:     isEmergency,
        target_user_id,
        disclosed_by,
      });

      res.status(201).json({
        success:    true,
        log_id:     result.rows[0].id,
        logged_at:  result.rows[0].created_at,
        is_emergency: isEmergency,
        note: isEmergency
          ? "Emergency disclosure logged. No warrant required under On My Way emergency policy."
          : "Warrant-based disclosure logged. Legal review confirmed.",
      });
    } catch (err) {
      logger.error("Law enforcement log error", { error: err.message });
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// GET /api/law-enforcement/log
// Retrieve the full audit log (admin only)
router.get("/log", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*, u.auth0_id AS target_auth0_id
       FROM law_enforcement_log l
       LEFT JOIN users u ON u.id = l.target_user_id
       ORDER BY l.created_at DESC
       LIMIT 100`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error("Law enforcement log GET error", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
