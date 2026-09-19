/**
 * BulkGrab - Content Script
 * Scans page DOM for downloadable links and manages the floating Grabber panel.
 */

console.log('[BulkGrab Content Script] Initialized on', window.location.href);

// Basic ping/pong and placeholder for Step 1 scaffolding
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.action === 'BULKGRAB_PING') {
    sendResponse({ status: 'alive', url: window.location.href });
  }
  return false;
});
