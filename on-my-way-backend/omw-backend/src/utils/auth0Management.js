const { ManagementClient } = require("auth0");

// ─── MANAGEMENT API CLIENT ────────────────────────────────────────────────────
// This is the server-side Management API client.
// Uses the M2M client secret — NEVER sent to the frontend.
// Can do everything: write app_metadata, delete users, update roles.
let _client = null;

function getManagementClient() {
  if (!_client) {
    _client = new ManagementClient({
      domain:       process.env.AUTH0_DOMAIN,
      clientId:     process.env.AUTH0_MGMT_CLIENT_ID,
      clientSecret: process.env.AUTH0_MGMT_CLIENT_SECRET,
    });
  }
  return _client;
}

/**
 * Write app_metadata for a user.
 * app_metadata is admin-only — cannot be written from the SPA.
 * Used to store: verified status, account type, tier, special rate.
 *
 * This is more secure than user_metadata because:
 *   - Users cannot overwrite it themselves
 *   - Only our server can set these values
 *   - Prevents users from self-promoting to Elite tier, etc.
 */
async function setAppMetadata(auth0UserId, metadata) {
  const mgmt = getManagementClient();
  return mgmt.users.update(
    { id: auth0UserId },
    { app_metadata: metadata }
  );
}

/**
 * Get the full Auth0 user record (includes app_metadata, identities, etc.)
 */
async function getAuth0User(auth0UserId) {
  const mgmt = getManagementClient();
  return mgmt.users.get({ id: auth0UserId });
}

/**
 * Permanently delete a user from Auth0.
 * Called when a user requests account deletion.
 * Irreversible — Auth0 user is gone.
 */
async function deleteAuth0User(auth0UserId) {
  const mgmt = getManagementClient();
  return mgmt.users.delete({ id: auth0UserId });
}

/**
 * Block a user (suspend without deletion — for driver rating violations).
 */
async function blockUser(auth0UserId, reason) {
  const mgmt = getManagementClient();
  return mgmt.users.update(
    { id: auth0UserId },
    {
      blocked: true,
      app_metadata: { suspended: true, suspensionReason: reason, suspendedAt: new Date().toISOString() }
    }
  );
}

module.exports = { setAppMetadata, getAuth0User, deleteAuth0User, blockUser };
