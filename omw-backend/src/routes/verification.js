const express = require("express");
const multer  = require("multer");
const router  = express.Router();
const pool    = require("../db/pool");
const storage = require("../utils/storage");
const { setAppMetadata } = require("../utils/auth0Management");
const logger  = require("../utils/logger");

// Memory storage — files never touch disk, go directly to S3
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },  // 10MB max
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg","image/png","application/pdf"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only JPG, PNG, and PDF files accepted"));
  },
});

// ─── GET /api/verification/status ────────────────────────────────────────────
router.get("/status", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT status, account_type, has_interior_cam, has_exterior_cam,
              special_rate, submitted_date, reviewed_date, documents_purged_at
       FROM verifications
       WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.json({ status: "not_started" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    logger.error("GET /verification/status error", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /api/verification/submit ───────────────────────────────────────────
// Submit verification form data (no documents yet — those upload separately)
router.post("/submit", async (req, res) => {
  const {
    account_type, traveler_tier, special_rate,
    has_interior_cam, has_exterior_cam, background_declared,
  } = req.body;

  // Validate required camera confirmation for travelers
  if (account_type === "traveler") {
    if (!has_interior_cam || !has_exterior_cam) {
      return res.status(400).json({
        error: "Interior and exterior cameras must be confirmed for all travelers.",
      });
    }
    if (!background_declared) {
      return res.status(400).json({
        error: "Background eligibility declaration is required.",
      });
    }
  }

  try {
    const result = await pool.query(
      `INSERT INTO verifications
         (user_id, status, account_type, special_rate,
          has_interior_cam, has_exterior_cam, background_declared)
       VALUES ($1, 'pending', $2, $3, $4, $5, $6)
       ON CONFLICT (user_id)
       DO UPDATE SET
         status = 'pending',
         account_type = EXCLUDED.account_type,
         special_rate = EXCLUDED.special_rate,
         has_interior_cam = EXCLUDED.has_interior_cam,
         has_exterior_cam = EXCLUDED.has_exterior_cam,
         background_declared = EXCLUDED.background_declared,
         submitted_date = CURRENT_DATE
       RETURNING id`,
      [req.user.id, account_type, special_rate || "none",
       has_interior_cam || false, has_exterior_cam || false,
       background_declared || false]
    );

    // Update user's account type immediately
    await pool.query(
      "UPDATE users SET account_type = $1, traveler_tier = $2 WHERE id = $3",
      [account_type, traveler_tier || null, req.user.id]
    );

    res.json({ success: true, verification_id: result.rows[0].id });
  } catch (err) {
    logger.error("POST /verification/submit error", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /api/verification/upload/id ────────────────────────────────────────
// Upload government ID — encrypted directly to S3
router.post("/upload/id",
  upload.single("document"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file provided" });
    try {
      const key = await storage.uploadDocument(
        req.file.buffer,
        req.file.mimetype,
        `verifications/${req.user.id}/id`,
        365  // retain 30 days post-approval (cleanup job handles actual deletion)
      );

      await pool.query(
        "UPDATE verifications SET id_document_key = $1 WHERE user_id = $2",
        [key, req.user.id]
      );

      logger.info("ID document uploaded", { userId: req.user.id });
      res.json({ success: true, message: "ID document received and encrypted." });
    } catch (err) {
      logger.error("ID upload error", { error: err.message });
      res.status(500).json({ error: "Upload failed" });
    }
  }
);

// ─── POST /api/verification/upload/selfie ────────────────────────────────────
// Selfie upload — auto-deleted after 24 hours by cleanup job
router.post("/upload/selfie",
  upload.single("selfie"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file provided" });
    try {
      const key = await storage.uploadDocument(
        req.file.buffer,
        req.file.mimetype,
        `verifications/${req.user.id}/selfie`,
        1   // 1 day
      );

      await pool.query(
        "UPDATE verifications SET selfie_key = $1 WHERE user_id = $2",
        [key, req.user.id]
      );

      logger.info("Selfie uploaded — scheduled for 24hr deletion", { userId: req.user.id });
      res.json({
        success: true,
        message: "Selfie received. Auto-deleted within 24 hours per our privacy policy.",
      });
    } catch (err) {
      logger.error("Selfie upload error", { error: err.message });
      res.status(500).json({ error: "Upload failed" });
    }
  }
);

// ─── POST /api/verification/upload/abstract ───────────────────────────────────
// Driver's abstract upload — travelers only
router.post("/upload/abstract",
  upload.single("abstract"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file provided" });
    if (req.user.account_type === "passenger") {
      return res.status(403).json({ error: "Driver's abstract is for travelers only" });
    }

    const { abstract_date } = req.body;
    if (!abstract_date) {
      return res.status(400).json({ error: "Abstract issue date is required" });
    }

    // Validate abstract is within 30 days
    const issueDate = new Date(abstract_date);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    if (issueDate < thirtyDaysAgo) {
      return res.status(400).json({
        error: "Driver's abstract must be dated within the last 30 days.",
      });
    }

    try {
      const key = await storage.uploadDocument(
        req.file.buffer,
        req.file.mimetype,
        `verifications/${req.user.id}/abstract`,
        60
      );

      await pool.query(
        "UPDATE verifications SET abstract_key = $1 WHERE user_id = $2",
        [key, req.user.id]
      );

      logger.info("Driver abstract uploaded", { userId: req.user.id });
      res.json({ success: true, message: "Abstract received and encrypted." });
    } catch (err) {
      logger.error("Abstract upload error", { error: err.message });
      res.status(500).json({ error: "Upload failed" });
    }
  }
);

// ─── POST /api/verification/approve/:userId ───────────────────────────────────
// Admin endpoint — approve a verification (internal use only)
// In production: add admin role check middleware
router.post("/approve/:userId", async (req, res) => {
  try {
    const userRes = await pool.query(
      "SELECT * FROM users WHERE id = $1", [req.params.userId]
    );
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    const user = userRes.rows[0];

    // Update verification status
    await pool.query(
      `UPDATE verifications
       SET status = 'approved', reviewed_date = CURRENT_DATE
       WHERE user_id = $1`,
      [req.params.userId]
    );

    // Update user record
    await pool.query(
      "UPDATE users SET verified = true, verified_at = NOW() WHERE id = $1",
      [req.params.userId]
    );

    // Write verified status to Auth0 app_metadata (admin-only field)
    await setAppMetadata(user.auth0_id, {
      omw_verified:    true,
      omw_verifiedAt:  new Date().toISOString(),
      omw_accountType: user.account_type,
      omw_travelerTier: user.traveler_tier,
    });

    logger.info("User verification approved", { userId: req.params.userId });
    res.json({ success: true });
  } catch (err) {
    logger.error("Verification approve error", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
