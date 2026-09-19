/**
 * BulkGrab - Constants and Configuration
 */

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

// Free tier limit: Maximum downloads allowed per session
export const FREE_DOWNLOAD_LIMIT = 3;

// Storage keys for chrome.storage
export const STORAGE_KEYS = {
  LICENSE_STATUS: 'licenseStatus',           // 'free' | 'pro'
  SESSION_DOWNLOADS: 'sessionDownloadCount', // integer
  STRIPE_SESSION_ID: 'stripeSessionId',      // string
};

// Message actions for runtime communication between components
export const MESSAGE_ACTIONS = {
  GET_STATUS: 'BULKGRAB_GET_STATUS',
  VERIFY_LICENSE: 'BULKGRAB_VERIFY_LICENSE',
  RESET_LICENSE: 'BULKGRAB_RESET_LICENSE',
  DOWNLOAD_FILES: 'BULKGRAB_DOWNLOAD_FILES',
  GET_PAGE_FILES: 'BULKGRAB_GET_PAGE_FILES',
  TOGGLE_PANEL: 'BULKGRAB_TOGGLE_PANEL'
};

// Stripe checkout / payment link placeholder
export const STRIPE_PAYMENT_URL = 'https://buy.stripe.com/test_placeholder_bulkgrab';
