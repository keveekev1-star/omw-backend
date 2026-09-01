const cron    = require("node-cron");
const pool    = require("../db/pool");
const storage = require("../utils/storage");
const logger  = require("../utils/logger");

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-DELETION JOBS
// Implements data minimization (WPA, GDPR, PIPEDA, Washington MHMD).
// Runs on a schedule — no GPS coordinates are ever stored, so those are
// handled at the collection layer (never sent to server).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JOB 1 — Selfie photos: delete after 24 hours
 * Selfies are used only for identity match during verification.
 * No reason to keep them after the check is complete.
 * Runs every hour.
 */
cron.schedule("0 * * * *", async () => {
  logger.info("CLEANUP: Running selfie purge job");
  try {
    const result = await pool.query(`
      SELECT id, selfie_key
      FROM verifications
      WHERE selfie_key IS NOT NULL
        AND created_at < NOW() - INTERVAL '24 hours'
    `);

    for (const row of result.rows) {
      await storage.deleteDocument(row.selfie_key);
      await pool.query(
        "UPDATE verifications SET selfie_key = NULL WHERE id = $1",
        [row.id]
      );
      logger.info(`CLEANUP: Deleted selfie for verification ${row.id}`);
    }
    logger.info(`CLEANUP: Selfie purge complete — ${result.rows.length} deleted`);
  } catch (err) {
    logger.error("CLEANUP: Selfie purge failed", { error: err.message });
  }
});

/**
 * JOB 2 — ID documents and abstracts: delete 30 days after approval
 * Once a driver is verified, we no longer need their raw documents.
 * Verification STATUS is kept in the DB. Documents are gone from S3.
 * Runs daily at 2 AM Pacific.
 */
cron.schedule("0 2 * * *", async () => {
  logger.info("CLEANUP: Running document purge job (30-day post-approval)");
  try {
    const result = await pool.query(`
      SELECT id, id_document_key, abstract_key
      FROM verifications
      WHERE status = 'approved'
        AND reviewed_date < CURRENT_DATE - INTERVAL '30 days'
        AND (id_document_key IS NOT NULL OR abstract_key IS NOT NULL)
    `);

    for (const row of result.rows) {
      if (row.id_document_key) await storage.deleteDocument(row.id_document_key);
      if (row.abstract_key)    await storage.deleteDocument(row.abstract_key);

      await pool.query(
        `UPDATE verifications
         SET id_document_key = NULL,
             abstract_key = NULL,
             documents_purged_at = NOW()
         WHERE id = $1`,
        [row.id]
      );
      logger.info(`CLEANUP: Documents purged for verification ${row.id}`);
    }
    logger.info(`CLEANUP: Document purge complete — ${result.rows.length} records`);
  } catch (err) {
    logger.error("CLEANUP: Document purge failed", { error: err.message });
  }
});

/**
 * JOB 3 — Trip timestamps: scrub precise timestamps after 90 days
 * We keep trip_date (day precision) for 7 years (tax).
 * We delete created_at and completed_at (time precision) after 90 days
 * to prevent inference of location patterns from timing data.
 * Runs daily at 3 AM Pacific.
 */
cron.schedule("0 3 * * *", async () => {
  logger.info("CLEANUP: Running trip timestamp scrub job");
  try {
    const result = await pool.query(`
      UPDATE trips
      SET completed_at = NULL,
          timestamps_purged_at = NOW()
      WHERE completed_at IS NOT NULL
        AND completed_at < NOW() - INTERVAL '90 days'
        AND timestamps_purged_at IS NULL
      RETURNING id
    `);
    logger.info(`CLEANUP: Trip timestamps scrubbed — ${result.rowCount} records`);
  } catch (err) {
    logger.error("CLEANUP: Trip timestamp scrub failed", { error: err.message });
  }
});

/**
 * JOB 4 — Contribution records: delete after 7 years (IRS requirement)
 * Tax records must be kept 7 years. After that, they are permanently deleted.
 * Runs on the 1st of each month.
 */
cron.schedule("0 4 1 * *", async () => {
  logger.info("CLEANUP: Running contribution 7-year purge job");
  try {
    const result = await pool.query(`
      DELETE FROM contributions
      WHERE retain_until < CURRENT_DATE
      RETURNING id
    `);
    logger.info(`CLEANUP: Contributions purged — ${result.rowCount} records`);
  } catch (err) {
    logger.error("CLEANUP: Contribution purge failed", { error: err.message });
  }
});

/**
 * JOB 5 — Soft-deleted user accounts: hard delete after 30 days
 * When a user deletes their account, we soft-delete (set deleted_at).
 * After 30 days we permanently delete their DB record and Auth0 account.
 * Runs daily at 4 AM Pacific.
 */
cron.schedule("0 4 * * *", async () => {
  logger.info("CLEANUP: Running hard-delete job for soft-deleted accounts");
  try {
    const { deleteAuth0User } = require("../utils/auth0Management");

    const result = await pool.query(`
      SELECT id, auth0_id
      FROM users
      WHERE deleted_at IS NOT NULL
        AND deleted_at < NOW() - INTERVAL '30 days'
    `);

    for (const row of result.rows) {
      // Delete from Auth0
      try {
        await deleteAuth0User(row.auth0_id);
      } catch (err) {
        logger.warn(`CLEANUP: Auth0 delete failed for ${row.auth0_id}`, { error: err.message });
      }

      // Hard delete from our DB (cascades to trips, verifications, etc.)
      await pool.query("DELETE FROM users WHERE id = $1", [row.id]);
      logger.info(`CLEANUP: Hard deleted user ${row.id}`);
    }
    logger.info(`CLEANUP: Hard-delete job complete — ${result.rows.length} users`);
  } catch (err) {
    logger.error("CLEANUP: Hard-delete job failed", { error: err.message });
  }
});

/**
 * JOB 6 — Raw ratings: aggregate and delete after 1 year
 * Individual ratings are aggregated into users.rating and deleted.
 * Only the average and count are kept long-term.
 * Runs on the 1st of each month.
 */
cron.schedule("0 5 1 * *", async () => {
  logger.info("CLEANUP: Running ratings aggregation and purge job");
  try {
    // Update aggregate ratings first
    await pool.query(`
      UPDATE users u
      SET rating = sub.avg_score,
          rating_count = sub.cnt
      FROM (
        SELECT rated_id,
               ROUND(AVG(score)::numeric, 2) AS avg_score,
               COUNT(*) AS cnt
        FROM ratings
        GROUP BY rated_id
      ) sub
      WHERE u.id = sub.rated_id
    `);

    // Delete old raw ratings
    const result = await pool.query(`
      DELETE FROM ratings
      WHERE purge_after < CURRENT_DATE
      RETURNING id
    `);
    logger.info(`CLEANUP: Ratings purged — ${result.rowCount} records`);
  } catch (err) {
    logger.error("CLEANUP: Ratings purge failed", { error: err.message });
  }
});

/**
 * JOB 7 — Temporary export files: delete after 48 hours
 * Data export files are stored in S3 temporarily.
 * Runs every 6 hours.
 */
cron.schedule("0 */6 * * *", async () => {
  logger.info("CLEANUP: Running export file purge job");
  try {
    const result = await pool.query(`
      SELECT id, s3_key
      FROM export_requests
      WHERE status = 'completed'
        AND s3_key IS NOT NULL
        AND completed_at < NOW() - INTERVAL '48 hours'
    `);

    for (const row of result.rows) {
      await storage.deleteDocument(row.s3_key);
      await pool.query(
        "UPDATE export_requests SET s3_key = NULL WHERE id = $1",
        [row.id]
      );
    }
    logger.info(`CLEANUP: Export files purged — ${result.rows.length} files`);
  } catch (err) {
    logger.error("CLEANUP: Export purge failed", { error: err.message });
  }
});

logger.info("CLEANUP: All scheduled jobs registered");

module.exports = {};
