/**
 * BulkGrab - Constants and Configuration
 */

/**
 * QUOTA STRATEGY DECISION & ARCHITECTURE:
 * 
 * Free-tier download quota is configured to reset per browser session (whenever the
 * browser is closed and reopened), strictly adhering to the "per session" freemium spec.
 * 
 * State storage: chrome.storage.session
 * - Automatically cleaned up when the browser session terminates.
 * - Survives service worker idle suspensions without state loss.
 * 
 * To switch to a Calendar-Day / Daily Quota in the future:
 * 1. Move quota storage to `chrome.storage.local`.
 * 2. Save an ISO date key (e.g. `downloadQuotaDate = 'YYYY-MM-DD'`).
 * 3. In service-worker.js, compare today's date with the stored date and reset count if different.
 */
export const QUOTA_POLICY = 'SESSION'; // 'SESSION' | 'DAILY'

// Supported file extensions scanned by default on webpages.
// Easily configurable to add or remove specific extensions.
export const DEFAULT_FILE_EXTENSIONS = [
  // Documents
  'pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'txt', 'csv',
  // Images
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg',
  // Archives
  'zip', 'tar', 'gz', 'rar', '7z',
  // Media (Audio & Video)
  'mp3', 'wav', 'mp4', 'webm', 'ogg', 'mkv'
];

export const CATEGORY_MAP = {
  documents: ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'txt', 'csv'],
  images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'],
  archives: ['zip', 'tar', 'gz', 'rar', '7z'],
  media: ['mp3', 'wav', 'mp4', 'webm', 'ogg', 'mkv']
};

export function getFileCategory(extension) {
  const ext = (extension || '').toLowerCase();
  for (const [category, exts] of Object.entries(CATEGORY_MAP)) {
    if (exts.includes(ext)) return category;
  }
  return 'other';
}

// Free tier limit: Maximum downloads allowed per session
export const FREE_DOWNLOAD_LIMIT = 7;

// Storage keys for chrome.storage
export const STORAGE_KEYS = {
  LICENSE_STATUS: 'licenseStatus',           // 'free' | 'pro'
  SESSION_DOWNLOADS: 'sessionDownloadCount', // integer (stored in chrome.storage.session)
  STRIPE_SESSION_ID: 'stripeSessionId',      // string
};

// Message actions for runtime communication between components
export const MESSAGE_ACTIONS = {
  PING: 'BULKGRAB_PING',
  GET_STATUS: 'BULKGRAB_GET_STATUS',
  VERIFY_LICENSE: 'BULKGRAB_VERIFY_LICENSE',
  RESET_LICENSE: 'BULKGRAB_RESET_LICENSE',
  RESET_SESSION_QUOTA: 'BULKGRAB_RESET_SESSION_QUOTA',
  DOWNLOAD_FILES: 'BULKGRAB_DOWNLOAD_FILES',
  DOWNLOAD_PROGRESS: 'BULKGRAB_DOWNLOAD_PROGRESS',
  DOWNLOAD_ZIP: 'BULKGRAB_DOWNLOAD_ZIP',
  GET_PAGE_FILES: 'BULKGRAB_GET_PAGE_FILES',
  TOGGLE_PANEL: 'BULKGRAB_TOGGLE_PANEL',
  RESCAN: 'BULKGRAB_RESCAN',
  UPDATE_BADGE: 'BULKGRAB_UPDATE_BADGE',
  LICENSE_UPDATED: 'BULKGRAB_LICENSE_UPDATED',
  CHECK_PERMISSIONS: 'BULKGRAB_CHECK_PERMISSIONS',
  PROMPT_PERMISSIONS: 'BULKGRAB_PROMPT_PERMISSIONS',
  PERMISSION_RESPONSE: 'BULKGRAB_PERMISSION_RESPONSE',
  CREATE_ZIP: 'BULKGRAB_CREATE_ZIP'
};

// Stripe checkout / payment link placeholder
export const STRIPE_PAYMENT_URL = 'https://buy.stripe.com/test_placeholder_bulkgrab';
