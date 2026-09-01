/**
 * On My Way — File Storage via Supabase Storage
 *
 * Free tier includes 1GB — plenty for testing.
 * When ready to scale, swap this file for the R2 version.
 *
 * Migration later is 3 line changes in .env:
 *   Remove: SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET
 *   Add:    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */

const { createClient } = require("@supabase/supabase-js");
const { randomUUID }   = require("crypto");

// Service role key bypasses RLS — safe for server-side only
let _supabase = null;
function getClient() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY  // service_role key — never expose to frontend
    );
  }
  return _supabase;
}

const BUCKET = process.env.STORAGE_BUCKET || "onmyway-documents";

/**
 * Upload a document to Supabase Storage.
 * Returns the storage path (stored in DB — not the file itself).
 * All buckets are private by default — files never publicly accessible.
 */
async function uploadDocument(buffer, mimeType, folder, retainDays = 30) {
  const path = `${folder}/${randomUUID()}`;
  const supabase = getClient();

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, {
      contentType:  mimeType,
      cacheControl: "3600",
      upsert:       false,
      metadata: {
        retainDays:  String(retainDays),
        uploadedAt:  new Date().toISOString(),
      },
    });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  return path;
}

/**
 * Generate a time-limited signed URL (15 min default).
 * Only way to access files — bucket is private.
 */
async function getPresignedUrl(path, expiresInSeconds = 900) {
  const supabase = getClient();
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, expiresInSeconds);

  if (error) throw new Error(`Signed URL failed: ${error.message}`);
  return data.signedUrl;
}

/**
 * Permanently delete a file from Supabase Storage.
 * Called by auto-deletion jobs.
 */
async function deleteDocument(path) {
  if (!path) return;
  const supabase = getClient();
  const { error } = await supabase.storage
    .from(BUCKET)
    .remove([path]);

  if (error) console.error(`Storage delete failed for ${path}:`, error.message);
}

module.exports = { uploadDocument, getPresignedUrl, deleteDocument };
