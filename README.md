# BulkGrab — Bulk File Downloader Chrome Extension (Manifest V3)

BulkGrab is a lightweight, privacy-focused Chrome Extension (Manifest V3) that detects, filters, and bulk-downloads downloadable files from webpages with a freemium model.

---

## Architecture & Features

- **DOM File Scanner (`content/content-script.js`)**:
  - Scans `<a>`, `<area>`, `<img>`, `<video>`, `<audio>`, and `<source>` tags for downloadable files.
  - Recognizes documents (`pdf`, `docx`, `xlsx`, `txt`), images (`jpg`, `png`, `svg`), archives (`zip`, `tar`, `gz`), and media (`mp3`, `mp4`).
  - Configurable file extensions in [`utils/constants.js`](utils/constants.js).
- **Isolated In-Page UI (`content/content-style.css`)**:
  - Encapsulated within a native **Shadow DOM** (`#bulkgrab-root`) so host page CSS cannot break extension styles.
  - Floating, draggable header with collapse/minimize (`−`) and close (`×`) controls.
  - Extension filter tabs (`All`, `Docs`, `Images`, `Archives`, `Media`) with live counts.
  - Search filter and "Select All" toggle checkbox.
  - Download buttons: "⬇ Download Selected" and "📦 ZIP" (Pro).
- **Service Worker (`background/service-worker.js`)**:
  - Coordinates `chrome.downloads.download` API calls.
  - Free tier: allows up to 7 downloads per browser session, executed sequentially one at a time.
  - Pro tier: unlimited batch downloads and client-side ZIP archiving.
  - Listens to `chrome.tabs.onUpdated` to clear toolbar badges on page navigation.
- **Action Popup (`popup/popup.html`, `popup.js`, `popup.css`)**:
  - Displays the active page's domain and total downloadable file count.
  - Category breakdown pills (`📄 Docs`, `🖼️ Images`, `📦 Archives`, `🎵 Media`).
  - Session quota progress bar (`X / 7 used`).
  - Direct "Open Grabber Panel", "Rescan Page", and "Upgrade to Pro" triggers.
- **Settings & Licensing (`options/options.html`, `options.js`)**:
  - Manage license tier (`Free` vs `Pro`).
  - Paste Stripe Checkout session ID to activate Pro.
  - Reset controls to easily toggle back to Free tier or clear session quota during testing.

---

## Loading the Extension in Chrome

1. Clone or open this repository directory:
   ```
   /home/sid/projects/bulkgrab
   ```
2. Open Google Chrome and navigate to:
   ```
   chrome://extensions
   ```
3. Enable **Developer mode** using the toggle switch in the top-right corner.
4. Click **Load unpacked** in the top-left corner.
5. Select the `/home/sid/projects/bulkgrab` folder.
6. Confirm **"BulkGrab - Bulk File Downloader"** appears with zero manifest errors.

---

## How the License Stub Works

The extension includes a swappable verification stub in [`background/service-worker.js`](background/service-worker.js):

```javascript
export async function verifyLicense(sessionId) {
  if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
    return { valid: false, error: 'Please enter a valid Stripe Checkout session ID.' };
  }

  const trimmed = sessionId.trim();
  // Stub logic: accepts any non-empty string as valid
  await chrome.storage.local.set({
    [STORAGE_KEYS.LICENSE_STATUS]: 'pro',
    [STORAGE_KEYS.STRIPE_SESSION_ID]: trimmed
  });

  return { valid: true, status: 'pro', sessionId: trimmed, message: 'Pro license activated!' };
}
```

### Testing License Activation:
1. Open the Options page by clicking the gear icon (⚙️) in the popup or right-clicking the extension icon -> **Options**.
2. In the **Stripe Checkout Session ID** input, enter any test string (e.g. `cs_test_123456789`).
3. Click **Activate Pro**.
4. The badge will immediately change to **PRO Active**, unlocking unlimited downloads and the "📦 ZIP" feature.
5. Click **Reset to Free Tier (For Testing)** anytime to revert back to the Free plan.

---

## Transitioning to a Real Cloudflare Worker Backend

To point licensing at a production Cloudflare Worker:

### 1. Cloudflare Worker Implementation (`worker.js`)
```javascript
import Stripe from 'stripe';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/verify-license') {
      const sessionId = url.searchParams.get('session_id');
      if (!sessionId) {
        return new Response(JSON.stringify({ valid: false, error: 'Missing session_id' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        const isPaid = session.payment_status === 'paid';
        return new Response(JSON.stringify({
          valid: isPaid,
          customerEmail: session.customer_details?.email,
          paymentStatus: session.payment_status
        }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ valid: false, error: err.message }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};
```

### 2. Update `verifyLicense()` in `background/service-worker.js`
Replace the stub in `verifyLicense()` with the fetch call:
```javascript
export async function verifyLicense(sessionId) {
  try {
    const response = await fetch(
      `https://your-worker.workers.dev/api/verify-license?session_id=${encodeURIComponent(sessionId)}`
    );
    const data = await response.json();
    if (!data.valid) {
      return { valid: false, error: data.error || 'Invalid or unpaid session.' };
    }

    await chrome.storage.local.set({
      [STORAGE_KEYS.LICENSE_STATUS]: 'pro',
      [STORAGE_KEYS.STRIPE_SESSION_ID]: sessionId.trim()
    });

    return { valid: true, status: 'pro', message: 'Pro license verified successfully!' };
  } catch (err) {
    return { valid: false, error: `Verification request failed: ${err.message}` };
  }
}
```

---

## Running Automated Tests

Run the full Puppeteer test suite:
```bash
npm test
```

This runs 11 automated end-to-end tests validating:
- DOM scanning & Shadow DOM file listing.
- Tab-scoped badge count updates.
- Popup hero numbers & category breakdown pills.
- Free-tier 7-download session limit enforcement and rejection.
- Badge clearing on tab navigation.
- Options page license verification stub.
- Pro-tier batch downloading & JSZip archive creation.
- Resetting back to Free plan.
- CORS partial-failure ZIP bundling & fallback download delegation.
- Grabber panel rendering without stack overflow.
- Dynamic license tier update via storage events without page reload.

---

## Manual Test Checklist

1. **Unpacked Load**: Load extension in `chrome://extensions` — verify no error badges.
2. **Detection**: Open `http://localhost:8080/test-page.html`, click extension icon -> **Open Grabber Panel** — verify 11 files detected across tabs (`Docs`, `Images`, `Archives`, `Media`).
3. **Selection**: Toggle **Select All**, filter by category tab, deselect individual files.
4. **Free Quota Cap**: Select 8 files on Free tier and click download — verify quota warning appears.
5. **Sequential Download**: Select 2 files on Free tier — verify files download one after another and session quota updates to `2 / 7 used`.
6. **Navigation Badge Clear**: Navigate tab to a new URL — verify toolbar badge clears immediately.
7. **License Upgrade**: Open Options, enter `cs_test_sample`, click **Activate Pro** — verify Pro Active badge appears and open tabs immediately unlock without reload.
8. **Pro ZIP Bundling**: In the floating panel, select files and click **📦 ZIP** — verify JSZip bundles files client-side into a `.zip` archive.
9. **Reset**: In Options, click **Reset to Free Tier** — verify status downgrades back to Free across all open tabs.
