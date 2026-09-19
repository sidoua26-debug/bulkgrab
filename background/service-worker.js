/**
 * BulkGrab - Service Worker (Background)
 * Manages chrome.downloads, license status, and session download quotas.
 */

import { STORAGE_KEYS, MESSAGE_ACTIONS } from '../utils/constants.js';

// Initialize default state on extension install or update
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[BulkGrab Service Worker] Extension installed/updated:', details.reason);
  
  const existing = await chrome.storage.local.get(STORAGE_KEYS.LICENSE_STATUS);
  if (!existing[STORAGE_KEYS.LICENSE_STATUS]) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.LICENSE_STATUS]: 'free',
      [STORAGE_KEYS.STRIPE_SESSION_ID]: ''
    });
    console.log('[BulkGrab Service Worker] Initialized default license status: free');
  }

  // Initialize session download counter in chrome.storage.session
  if (chrome.storage.session) {
    const sessionData = await chrome.storage.session.get(STORAGE_KEYS.SESSION_DOWNLOADS);
    if (sessionData[STORAGE_KEYS.SESSION_DOWNLOADS] === undefined) {
      await chrome.storage.session.set({ [STORAGE_KEYS.SESSION_DOWNLOADS]: 0 });
    }
  }
});

// Listener for runtime messages from Popup and Content Scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return false;

  console.log('[BulkGrab Service Worker] Received message:', message.action, 'from', sender.tab ? 'tab ' + sender.tab.id : 'popup/options');

  if (message.action === MESSAGE_ACTIONS.GET_STATUS) {
    (async () => {
      try {
        const local = await chrome.storage.local.get([STORAGE_KEYS.LICENSE_STATUS, STORAGE_KEYS.STRIPE_SESSION_ID]);
        let sessionCount = 0;
        if (chrome.storage.session) {
          const session = await chrome.storage.session.get(STORAGE_KEYS.SESSION_DOWNLOADS);
          sessionCount = session[STORAGE_KEYS.SESSION_DOWNLOADS] || 0;
        }
        sendResponse({
          status: 'ok',
          licenseStatus: local[STORAGE_KEYS.LICENSE_STATUS] || 'free',
          stripeSessionId: local[STORAGE_KEYS.STRIPE_SESSION_ID] || '',
          sessionDownloads: sessionCount
        });
      } catch (err) {
        console.error('[BulkGrab Service Worker] Error getting status:', err);
        sendResponse({ status: 'error', error: err.message });
      }
    })();
    return true; // Keep message channel open for async response
  }

  return false;
});
