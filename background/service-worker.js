/**
 * BulkGrab - Service Worker (Background)
 * Manages chrome.downloads, license status, and session download quotas.
 */

import { STORAGE_KEYS, MESSAGE_ACTIONS, FREE_DOWNLOAD_LIMIT } from '../utils/constants.js';

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

/**
 * Wait for a specific chrome.downloads download to finish or error.
 * Free tier downloads one by one sequentially.
 */
function waitForDownloadCompletion(downloadId, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let timer = null;

    const changeListener = (delta) => {
      if (delta.id !== downloadId) return;

      if (delta.state && delta.state.current === 'complete') {
        cleanup();
        resolve({ downloadId, success: true });
      } else if (delta.error || (delta.state && delta.state.current === 'interrupted')) {
        cleanup();
        reject(new Error(delta.error?.current || 'Download was interrupted'));
      }
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(changeListener);
    };

    chrome.downloads.onChanged.addListener(changeListener);

    timer = setTimeout(() => {
      cleanup();
      // On timeout, we assume file is downloading in background
      resolve({ downloadId, success: true, timedOut: true });
    }, timeoutMs);
  });
}

/**
 * Process a batch of files for download.
 * Free tier: enforces 3-download session limit and downloads one at a time.
 * Pro tier: unlimited batch downloads.
 */
async function handleDownloadFiles(files, senderTabId) {
  if (!Array.isArray(files) || files.length === 0) {
    return { status: 'error', message: 'No files specified for download.' };
  }

  // 1. Check license status
  const localData = await chrome.storage.local.get(STORAGE_KEYS.LICENSE_STATUS);
  const licenseStatus = localData[STORAGE_KEYS.LICENSE_STATUS] || 'free';
  const isPro = licenseStatus === 'pro';

  // 2. Check session quota for Free tier
  let currentUsed = 0;
  if (chrome.storage.session) {
    const sessionData = await chrome.storage.session.get(STORAGE_KEYS.SESSION_DOWNLOADS);
    currentUsed = sessionData[STORAGE_KEYS.SESSION_DOWNLOADS] || 0;
  }

  if (!isPro) {
    const remaining = FREE_DOWNLOAD_LIMIT - currentUsed;

    if (remaining <= 0) {
      return {
        status: 'quota_exceeded',
        message: `Free tier limit reached (${FREE_DOWNLOAD_LIMIT}/${FREE_DOWNLOAD_LIMIT} downloads used this session). Upgrade to Pro for unlimited downloads!`,
        used: currentUsed,
        limit: FREE_DOWNLOAD_LIMIT
      };
    }

    if (files.length > remaining) {
      return {
        status: 'quota_exceeded',
        message: `Free tier allows up to ${FREE_DOWNLOAD_LIMIT} downloads per session. You have ${remaining} download(s) left, but selected ${files.length}. Please select fewer files or upgrade to Pro!`,
        used: currentUsed,
        limit: FREE_DOWNLOAD_LIMIT,
        remaining
      };
    }
  }

  // 3. Sequential Download Execution (one by one)
  const results = [];
  let successfulCount = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const currentIndex = i + 1;

    // Send progress to tab if available
    if (senderTabId) {
      try {
        await chrome.tabs.sendMessage(senderTabId, {
          action: MESSAGE_ACTIONS.DOWNLOAD_PROGRESS,
          index: currentIndex,
          total: files.length,
          filename: file.filename,
          state: 'downloading'
        });
      } catch (err) {
        // Tab may have closed or not listening, ignore
      }
    }

    try {
      // Clean filename for safety
      const sanitizedFilename = (file.filename || 'download').replace(/[/\\?%*:|"<>]/g, '_');
      
      const downloadId = await chrome.downloads.download({
        url: file.url,
        filename: sanitizedFilename,
        conflictAction: 'uniquify',
        saveAs: false
      });

      console.log(`[BulkGrab] Initiated download ${currentIndex}/${files.length}: id=${downloadId}, file=${sanitizedFilename}`);
      
      // Wait for sequential completion before next file
      await waitForDownloadCompletion(downloadId);

      successfulCount++;
      if (!isPro) {
        currentUsed++;
        if (chrome.storage.session) {
          await chrome.storage.session.set({ [STORAGE_KEYS.SESSION_DOWNLOADS]: currentUsed });
        }
      }

      results.push({ filename: file.filename, success: true, downloadId });

      // Notify progress update
      if (senderTabId) {
        try {
          await chrome.tabs.sendMessage(senderTabId, {
            action: MESSAGE_ACTIONS.DOWNLOAD_PROGRESS,
            index: currentIndex,
            total: files.length,
            filename: file.filename,
            state: 'completed',
            sessionDownloads: currentUsed
          });
        } catch (_) {}
      }
    } catch (err) {
      console.error(`[BulkGrab] Download failed for ${file.url}:`, err);
      results.push({ filename: file.filename, success: false, error: err.message });
      
      if (senderTabId) {
        try {
          await chrome.tabs.sendMessage(senderTabId, {
            action: MESSAGE_ACTIONS.DOWNLOAD_PROGRESS,
            index: currentIndex,
            total: files.length,
            filename: file.filename,
            state: 'failed',
            error: err.message
          });
        } catch (_) {}
      }
    }
  }

  return {
    status: 'ok',
    totalFiles: files.length,
    downloadedCount: successfulCount,
    sessionDownloads: currentUsed,
    results
  };
}

// Runtime message dispatcher
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return false;

  const tabId = sender.tab ? sender.tab.id : null;

  // 1. Status query
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
          sessionDownloads: sessionCount,
          freeLimit: FREE_DOWNLOAD_LIMIT
        });
      } catch (err) {
        sendResponse({ status: 'error', error: err.message });
      }
    })();
    return true;
  }

  // 2. Download files request
  if (message.action === MESSAGE_ACTIONS.DOWNLOAD_FILES) {
    (async () => {
      try {
        const result = await handleDownloadFiles(message.files, tabId);
        sendResponse(result);
      } catch (err) {
        console.error('[BulkGrab Service Worker] handleDownloadFiles error:', err);
        sendResponse({ status: 'error', message: err.message });
      }
    })();
    return true;
  }

  // 3. Reset session quota (for testing or new sessions)
  if (message.action === MESSAGE_ACTIONS.RESET_SESSION_QUOTA) {
    (async () => {
      if (chrome.storage.session) {
        await chrome.storage.session.set({ [STORAGE_KEYS.SESSION_DOWNLOADS]: 0 });
      }
      sendResponse({ status: 'ok', sessionDownloads: 0 });
    })();
    return true;
  }

  return false;
});
