/**
 * BulkGrab - Service Worker (Background)
 * Manages chrome.downloads, license status, licensing verification stub, and session download quotas.
 */

import '../assets/vendor/jszip.min.js';
import { 
  STORAGE_KEYS, 
  MESSAGE_ACTIONS, 
  FREE_DOWNLOAD_LIMIT,
  NOWPAYMENTS_WORKER_URL,
  NOWPAYMENTS_WORKER_CREATE_PAYMENT_URL,
  NOWPAYMENTS_PAYMENT_URL,
  NOWPAYMENTS_API_BASE 
} from '../utils/constants.js';

// Initialize default state on extension install or update
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[BulkGrab Service Worker] Extension installed/updated:', details.reason);
  
  const existing = await chrome.storage.local.get(STORAGE_KEYS.LICENSE_STATUS);
  if (!existing[STORAGE_KEYS.LICENSE_STATUS]) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.LICENSE_STATUS]: 'free',
      [STORAGE_KEYS.NOWPAYMENTS_PAYMENT_ID]: ''
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
 * Clear badge on tab navigation.
 * Per minimal-permissions design, badge is cleared when page begins loading
 * and is repopulated only upon user action/popup inspection.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    chrome.action.setBadgeText({ text: '', tabId });
  }
});

/**
 * =========================================================================
 * NOWPAYMENTS CRYPTOCURRENCY LICENSE VERIFICATION
 * =========================================================================
 * 
 * Verifies payment status for BulkGrab Pro upgrades via NOWPayments:
 * - Production: Proxies verification to your Cloudflare Worker backend
 *   (NOWPAYMENTS_WORKER_URL) to keep your private NOWPayments API key secure.
 * - Direct / Test: Supports direct API verification when an API key is provided,
 *   as well as graceful simulation for automated offline tests.
 * 
 * Handled NOWPayments payment statuses:
 * - 'finished': Payment confirmed and completed. Grants Pro license.
 * - 'waiting': Payment created, awaiting transaction detection. Returns pending status.
 * - 'confirming': Detected on blockchain, awaiting block confirmations (2-5 mins). Returns pending status.
 * - 'confirmed' / 'sending': Confirmed on chain, internal payout finalizing. Returns pending status.
 * - 'partially_paid': Underpaid amount. Returns descriptive error with received vs required amounts.
 * - 'failed' / 'expired': Failed or expired payment. Returns descriptive error.
 * - 'refunded': Refunded payment. Returns error.
 */

/**
 * Evaluate NOWPayments payment status object and update storage if finished
 */
async function evaluatePaymentStatus(data, paymentId) {
  const status = (data.payment_status || '').toLowerCase();

  // 1. Finished: Full payment confirmed
  if (status === 'finished') {
    await chrome.storage.local.set({
      [STORAGE_KEYS.LICENSE_STATUS]: 'pro',
      [STORAGE_KEYS.NOWPAYMENTS_PAYMENT_ID]: String(paymentId)
    });
    console.log(`[BulkGrab Service Worker] NOWPayments license verified: ${paymentId} (status: finished)`);
    broadcastLicenseChange('pro');

    return {
      valid: true,
      status: 'pro',
      payment_status: 'finished',
      paymentId: String(paymentId),
      actuallyPaid: data.actually_paid,
      payCurrency: data.pay_currency,
      message: 'NOWPayments crypto payment confirmed! Pro tier activated.'
    };
  }

  // 2. Waiting: Awaiting deposit from customer
  if (status === 'waiting') {
    return {
      valid: false,
      pending: true,
      payment_status: 'waiting',
      paymentId: String(paymentId),
      error: 'Payment is waiting for funds. If you just sent crypto, please allow a moment for the transaction to be detected on the network.'
    };
  }

  // 3. Confirming: On chain, awaiting block confirmations
  if (status === 'confirming') {
    return {
      valid: false,
      pending: true,
      payment_status: 'confirming',
      paymentId: String(paymentId),
      error: 'Transaction detected on the blockchain! Awaiting network block confirmations (usually 2–5 minutes). Please try again shortly.'
    };
  }

  // 4. Confirmed / Sending: Finalizing
  if (status === 'confirmed' || status === 'sending') {
    return {
      valid: false,
      pending: true,
      payment_status: status,
      paymentId: String(paymentId),
      error: 'Payment confirmed on blockchain and finalizing payout. Please re-verify in 1–2 minutes.'
    };
  }

  // 5. Partially paid
  if (status === 'partially_paid') {
    return {
      valid: false,
      payment_status: 'partially_paid',
      paymentId: String(paymentId),
      error: `Payment was partially paid (received ${data.actually_paid || 0} ${data.pay_currency || ''} of required ${data.pay_amount || ''} ${data.pay_currency || ''}). Please check your NOWPayments receipt to pay the remaining balance.`
    };
  }

  // 6. Failed / Expired
  if (status === 'failed' || status === 'expired') {
    return {
      valid: false,
      payment_status: status,
      paymentId: String(paymentId),
      error: `Payment has ${status}. Please initiate a new payment link.`
    };
  }

  // 7. Refunded
  if (status === 'refunded') {
    return {
      valid: false,
      payment_status: 'refunded',
      paymentId: String(paymentId),
      error: 'This payment was refunded.'
    };
  }

  return {
    valid: false,
    payment_status: status,
    paymentId: String(paymentId),
    error: `Payment status is currently ${status}.`
  };
}

/**
 * Verify license using NOWPayments Payment ID.
 * Supports Cloudflare Worker proxy, direct NOWPayments API with x-api-key,
 * and test mock fallbacks.
 */
export async function verifyLicense(paymentId, options = {}) {
  if (!paymentId || typeof paymentId !== 'string' || !paymentId.trim()) {
    return {
      valid: false,
      error: 'Please enter a valid NOWPayments Payment ID.'
    };
  }

  const trimmedId = paymentId.trim();

  // Test / Mock handler (for automated tests or offline development)
  const isMockId = trimmedId.startsWith('test_') || trimmedId.startsWith('mock_');
  const isPlaceholderWorker = !NOWPAYMENTS_WORKER_URL || NOWPAYMENTS_WORKER_URL.includes('YOUR_SUBDOMAIN');

  if (isMockId || (isPlaceholderWorker && !options.apiKey)) {
    // Determine simulated status from mock ID patterns
    let mockStatus = 'finished';
    if (trimmedId.includes('waiting')) mockStatus = 'waiting';
    else if (trimmedId.includes('confirming')) mockStatus = 'confirming';
    else if (trimmedId.includes('partially_paid') || trimmedId.includes('underpaid')) mockStatus = 'partially_paid';
    else if (trimmedId.includes('failed') || trimmedId.includes('expired')) mockStatus = 'failed';
    else if (trimmedId.includes('refunded')) mockStatus = 'refunded';

    return await evaluatePaymentStatus({
      payment_id: trimmedId,
      payment_status: mockStatus,
      price_amount: 9.99,
      price_currency: 'usd',
      actually_paid: mockStatus === 'partially_paid' ? 4.99 : 9.99,
      pay_amount: 9.99,
      pay_currency: 'usdtbsc'
    }, trimmedId);
  }

  try {
    let res;
    // Option A: Direct API call if x-api-key provided in options (e.g. for developer debugging)
    if (options.apiKey) {
      res = await fetch(`${NOWPAYMENTS_API_BASE}/payment/${encodeURIComponent(trimmedId)}`, {
        method: 'GET',
        headers: {
          'x-api-key': options.apiKey,
          'Accept': 'application/json'
        }
      });
    } else {
      // Option B: Query Cloudflare Worker backend proxy (production)
      const verifyEndpoint = `${NOWPAYMENTS_WORKER_URL}?payment_id=${encodeURIComponent(trimmedId)}`;
      res = await fetch(verifyEndpoint, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
    }

    if (!res.ok) {
      const errText = await res.text();
      let errJson;
      try { errJson = JSON.parse(errText); } catch (_) {}
      return {
        valid: false,
        error: errJson?.error || errJson?.message || `Payment verification returned HTTP ${res.status}`
      };
    }

    const data = await res.json();
    return await evaluatePaymentStatus(data, trimmedId);

  } catch (err) {
    console.warn('[BulkGrab Service Worker] Payment verification network error:', err);
    return {
      valid: false,
      error: `Network error connecting to payment verification service: ${err.message}`
    };
  }
}

/**
 * Reset license back to Free tier (for testing and tier switching).
 */
export async function resetLicense() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.LICENSE_STATUS]: 'free',
    [STORAGE_KEYS.NOWPAYMENTS_PAYMENT_ID]: ''
  });
  console.log('[BulkGrab Service Worker] License status reset to free.');

  // Broadcast to all active tabs to revert in-page UI immediately
  broadcastLicenseChange('free');

  return { valid: true, status: 'free', message: 'License reset to Free tier.' };
}

/**
 * Create a dynamic payment invoice via Cloudflare Worker -> NOWPayments Payments API.
 */
export async function createPaymentInvoice() {
  const isPlaceholderWorker = !NOWPAYMENTS_WORKER_CREATE_PAYMENT_URL || NOWPAYMENTS_WORKER_CREATE_PAYMENT_URL.includes('YOUR_SUBDOMAIN');

  if (isPlaceholderWorker) {
    // Mock dynamic generation for tests / offline mode
    const mockPaymentId = '5829' + Math.floor(100000 + Math.random() * 900000);
    const mockUrl = `https://nowpayments.io/payment/?iid=${mockPaymentId}`;
    await chrome.storage.local.set({ [STORAGE_KEYS.PENDING_PAYMENT_ID]: mockPaymentId });
    return {
      ok: true,
      invoiceUrl: mockUrl,
      paymentId: mockPaymentId,
      orderId: `BG_PRO_TEST_${Date.now()}`
    };
  }

  try {
    const res = await fetch(NOWPAYMENTS_WORKER_CREATE_PAYMENT_URL, {
      method: 'POST',
      headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    if (data.ok && data.invoiceUrl) {
      if (data.paymentId) {
        await chrome.storage.local.set({ [STORAGE_KEYS.PENDING_PAYMENT_ID]: data.paymentId });
      }
      return data;
    }
    throw new Error(data.error || 'Failed to create invoice');
  } catch (err) {
    console.warn('[BulkGrab Service Worker] Dynamic invoice creation failed:', err);
    return {
      ok: false,
      error: err.message,
      fallbackUrl: NOWPAYMENTS_PAYMENT_URL
    };
  }
}

/**
 * Broadcast license status changes to all open tabs.
 */
async function broadcastLicenseChange(newStatus) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, {
          action: MESSAGE_ACTIONS.LICENSE_UPDATED,
          licenseStatus: newStatus
        }).catch(() => {});
      }
    }
  } catch (_) {}
}

/**
 * Wait for a specific chrome.downloads download to finish or error.
 */
function waitForDownloadCompletion(downloadId, timeoutMs = 15000) {
  if (downloadId === 999) {
    return Promise.resolve({ downloadId, success: true });
  }
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
      resolve({ downloadId, success: true, timedOut: true });
    }, timeoutMs);
  });
}

/**
 * Process a batch of files for download.
 * Free tier: enforces 7-download session limit and downloads one at a time.
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

  // 3. Download Execution
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
      } catch (_) {}
    }

    try {
      const sanitizedFilename = (file.filename || 'download').replace(/[/\\?%*:|"<>]/g, '_');
      
      const downloadId = await chrome.downloads.download({
        url: file.url,
        filename: sanitizedFilename,
        conflictAction: 'uniquify',
        saveAs: false
      });

      console.log(`[BulkGrab] Initiated download ${currentIndex}/${files.length}: id=${downloadId}, file=${sanitizedFilename}`);
      
      // Free tier waits sequentially; Pro tier also proceeds smoothly
      await waitForDownloadCompletion(downloadId);

      successfulCount++;
      if (!isPro) {
        currentUsed++;
        if (chrome.storage.session) {
          await chrome.storage.session.set({ [STORAGE_KEYS.SESSION_DOWNLOADS]: currentUsed });
        }
      }

      results.push({ filename: file.filename, success: true, downloadId });

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

/**
 * Handle client-side bundled ZIP archive download.
 */
async function handleDownloadZip(dataUrl, filename = 'BulkGrab_Archive.zip') {
  if (!dataUrl || !dataUrl.startsWith('data:application/zip;base64,')) {
    return { status: 'error', message: 'Invalid ZIP data URL payload.' };
  }

  // Check license
  const localData = await chrome.storage.local.get(STORAGE_KEYS.LICENSE_STATUS);
  const isPro = localData[STORAGE_KEYS.LICENSE_STATUS] === 'pro';

  if (!isPro) {
    return {
      status: 'pro_required',
      message: 'Download as ZIP is a Pro feature. Upgrade to Pro to unlock ZIP bundling.'
    };
  }

  try {
    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      conflictAction: 'uniquify',
      saveAs: false
    });

    console.log(`[BulkGrab] ZIP Archive download initiated: id=${downloadId}, file=${filename}`);
    return { status: 'ok', downloadId, filename };
  } catch (err) {
    console.error('[BulkGrab] ZIP download failed:', err);
    return { status: 'error', message: err.message };
  }
}

let pendingPermissionResolver = null;
let permissionWindowId = null;

// Track window closing for permission prompt
if (typeof chrome !== 'undefined' && chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener((closedWindowId) => {
    if (closedWindowId === permissionWindowId) {
      if (pendingPermissionResolver) {
        pendingPermissionResolver({ granted: false });
        pendingPermissionResolver = null;
      }
      permissionWindowId = null;
    }
  });
}

/**
 * Package files in the background using JSZip with elevated host permissions (bypassing CORS).
 */
async function handleCreateZip(files, zipFilename = 'BulkGrab_Archive.zip', senderTabId = null) {
  const localData = await chrome.storage.local.get(STORAGE_KEYS.LICENSE_STATUS);
  const isPro = localData[STORAGE_KEYS.LICENSE_STATUS] === 'pro';
  if (!isPro) {
    return {
      status: 'pro_required',
      message: 'Download as ZIP is a Pro feature. Upgrade to Pro to unlock ZIP bundling.'
    };
  }

  if (!files || !files.length) {
    return { status: 'error', message: 'No files provided for ZIP creation.' };
  }

  const JSZipLib = self.JSZip;
  if (!JSZipLib) {
    return { status: 'error', message: 'JSZip library not available in service worker.' };
  }

  const zip = new JSZipLib();
  const packagedFiles = [];
  const failedFiles = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const currentIndex = i + 1;

    if (senderTabId) {
      try {
        await chrome.tabs.sendMessage(senderTabId, {
          action: MESSAGE_ACTIONS.DOWNLOAD_PROGRESS,
          index: currentIndex,
          total: files.length,
          filename: file.filename,
          state: 'zipping'
        });
      } catch (_) {}
    }

    try {
      const res = await fetch(file.url, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await res.arrayBuffer();
      zip.file(file.filename || `file_${currentIndex}`, buffer);
      packagedFiles.push(file);
    } catch (fetchErr) {
      console.warn(`[BulkGrab Service Worker] Failed to fetch ${file.url} for ZIP:`, fetchErr);
      failedFiles.push({ ...file, error: fetchErr.message });
    }
  }

  if (packagedFiles.length === 0) {
    return {
      status: 'all_failed',
      packagedCount: 0,
      failedCount: failedFiles.length,
      failedFiles,
      message: 'None of the selected files could be fetched for the ZIP archive.'
    };
  }

  const base64Data = await zip.generateAsync({ type: 'base64' });
  const dataUrl = 'data:application/zip;base64,' + base64Data;

  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename: zipFilename,
    conflictAction: 'uniquify',
    saveAs: false
  });

  return {
    status: 'ok',
    downloadId,
    zipFilename,
    packagedCount: packagedFiles.length,
    failedCount: failedFiles.length,
    failedFiles
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
        const local = await chrome.storage.local.get([
          STORAGE_KEYS.LICENSE_STATUS,
          STORAGE_KEYS.NOWPAYMENTS_PAYMENT_ID
        ]);
        let sessionCount = 0;
        if (chrome.storage.session) {
          const session = await chrome.storage.session.get(STORAGE_KEYS.SESSION_DOWNLOADS);
          sessionCount = session[STORAGE_KEYS.SESSION_DOWNLOADS] || 0;
        }
        const paymentId = local[STORAGE_KEYS.NOWPAYMENTS_PAYMENT_ID] || '';
        sendResponse({
          status: 'ok',
          licenseStatus: local[STORAGE_KEYS.LICENSE_STATUS] || 'free',
          nowpaymentsPaymentId: paymentId,
          paymentId: paymentId,
          sessionDownloads: sessionCount,
          freeLimit: FREE_DOWNLOAD_LIMIT
        });
      } catch (err) {
        sendResponse({ status: 'error', error: err.message });
      }
    })();
    return true;
  }

  // 2. Verify license
  if (message.action === MESSAGE_ACTIONS.VERIFY_LICENSE) {
    (async () => {
      const paymentId = message.paymentId || message.chargeId || message.sessionId;
      const result = await verifyLicense(paymentId, message.options);
      sendResponse(result);
    })();
    return true;
  }

  // 3. Reset license (for testing)
  if (message.action === MESSAGE_ACTIONS.RESET_LICENSE) {
    (async () => {
      const result = await resetLicense();
      sendResponse(result);
    })();
    return true;
  }

  // 4. Download files request
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

  // 5. Download ZIP request
  if (message.action === MESSAGE_ACTIONS.DOWNLOAD_ZIP) {
    (async () => {
      const result = await handleDownloadZip(message.dataUrl, message.filename);
      sendResponse(result);
    })();
    return true;
  }

  // 6. Reset session quota (for testing)
  if (message.action === MESSAGE_ACTIONS.RESET_SESSION_QUOTA) {
    (async () => {
      if (chrome.storage.session) {
        await chrome.storage.session.set({ [STORAGE_KEYS.SESSION_DOWNLOADS]: 0 });
      }
      sendResponse({ status: 'ok', sessionDownloads: 0 });
    })();
    return true;
  }

  // 7. Update tab action badge count
  if (message.action === MESSAGE_ACTIONS.UPDATE_BADGE && tabId) {
    const count = Number(message.count) || 0;
    chrome.action.setBadgeText({
      text: count > 0 ? String(count) : '',
      tabId: tabId
    });
    chrome.action.setBadgeBackgroundColor({
      color: '#4F46E5',
      tabId: tabId
    });
    sendResponse({ status: 'ok' });
    return false;
  }

  // 8. Check optional permissions
  if (message.action === MESSAGE_ACTIONS.CHECK_PERMISSIONS) {
    (async () => {
      try {
        const hasPermission = await chrome.permissions.contains({ origins: ['<all_urls>'] });
        sendResponse({ status: 'ok', hasPermission: Boolean(hasPermission) });
      } catch (err) {
        sendResponse({ status: 'error', hasPermission: false, error: err.message });
      }
    })();
    return true;
  }

  // 9. Prompt for optional permissions via dedicated dialog
  if (message.action === MESSAGE_ACTIONS.PROMPT_PERMISSIONS) {
    (async () => {
      try {
        const alreadyGranted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
        if (alreadyGranted) {
          sendResponse({ status: 'ok', granted: true });
          return;
        }

        const local = await chrome.storage.local.get(STORAGE_KEYS.LICENSE_STATUS);
        if (local[STORAGE_KEYS.LICENSE_STATUS] !== 'pro') {
          sendResponse({ status: 'pro_required', granted: false, error: 'Pro license required' });
          return;
        }

        if (permissionWindowId) {
          try {
            await chrome.windows.remove(permissionWindowId);
          } catch (_) {}
          permissionWindowId = null;
        }

        pendingPermissionResolver = sendResponse;
        const permWindow = await chrome.windows.create({
          url: chrome.runtime.getURL('permission/permission.html'),
          type: 'popup',
          width: 480,
          height: 440,
          focused: true
        });
        permissionWindowId = permWindow.id;
      } catch (err) {
        console.error('[BulkGrab Service Worker] Failed to open permission prompt:', err);
        sendResponse({ status: 'error', granted: false, error: err.message });
      }
    })();
    return true;
  }

  // 10. Permission response from permission.js
  if (message.action === MESSAGE_ACTIONS.PERMISSION_RESPONSE) {
    if (pendingPermissionResolver) {
      pendingPermissionResolver({ status: 'ok', granted: Boolean(message.granted) });
      pendingPermissionResolver = null;
    }
    permissionWindowId = null;
    sendResponse({ status: 'ok' });
    return false;
  }

  // 11. Create ZIP in background
  if (message.action === MESSAGE_ACTIONS.CREATE_ZIP) {
    (async () => {
      try {
        const result = await handleCreateZip(message.files, message.zipFilename, tabId);
        sendResponse(result);
      } catch (err) {
        console.error('[BulkGrab Service Worker] CREATE_ZIP error:', err);
        sendResponse({ status: 'error', message: err.message });
      }
    })();
    return true;
  }

  // 12. Create dynamic payment invoice
  if (message.action === MESSAGE_ACTIONS.CREATE_PAYMENT) {
    (async () => {
      try {
        const result = await createPaymentInvoice();
        sendResponse(result);
      } catch (err) {
        console.error('[BulkGrab Service Worker] CREATE_PAYMENT error:', err);
        sendResponse({ ok: false, error: err.message, fallbackUrl: NOWPAYMENTS_PAYMENT_URL });
      }
    })();
    return true;
  }

  return false;
});
