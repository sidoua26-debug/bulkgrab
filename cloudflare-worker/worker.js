/**
 * BulkGrab - Cloudflare Worker Licensing Backend
 * 
 * Securely proxies NOWPayments API license verification and handles
 * Instant Payment Notification (IPN) webhooks without exposing your
 * secret NOWPayments API key in the client-side Chrome extension.
 * 
 * Environment Secrets (set in Cloudflare Dashboard -> Settings -> Variables and Secrets):
 * - NOWPAYMENTS_API_KEY: Your private NOWPayments API key (from dashboard)
 * - NOWPAYMENTS_IPN_KEY: Your private NOWPayments IPN secret key (from dashboard)
 */

// Customer support contact email (defined locally so worker.js is a 100% self-contained file)
const SUPPORT_EMAIL = 'sidoua26@gmail.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, Authorization',
  'Content-Type': 'application/json'
};

/**
 * Sort object keys alphabetically for NOWPayments HMAC signature calculation
 */
function sortObject(obj) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return obj;
  }
  return Object.keys(obj).sort().reduce((result, key) => {
    result[key] = (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key]))
      ? sortObject(obj[key])
      : obj[key];
    return result;
  }, {});
}

/**
 * Verify HMAC-SHA512 signature for NOWPayments IPN webhooks
 */
async function verifyHmacSignature(rawBody, signature, secretKey) {
  try {
    if (!signature || !secretKey) return false;
    
    // Parse and sort JSON
    const parsed = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    const sorted = sortObject(parsed);
    const serialized = JSON.stringify(sorted);

    const encoder = new TextEncoder();
    const keyData = encoder.encode(secretKey);
    const msgData = encoder.encode(serialized);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-512' },
      false,
      ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
    const hashArray = Array.from(new Uint8Array(signatureBuffer));
    const computedHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    return computedHex.toLowerCase() === signature.toLowerCase();
  } catch (err) {
    console.error('[Worker IPN] HMAC verification error:', err);
    return false;
  }
}

/**
 * Returns simple, clean, mobile-friendly HTML for the Privacy Policy
 */
function getPrivacyHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BulkGrab Privacy Policy</title>
  <style>
    :root {
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --text-main: #1e293b;
      --text-muted: #64748b;
      --bg-page: #f8fafc;
      --bg-card: #ffffff;
      --accent: #4f46e5;
      --border: #e2e8f0;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font-sans);
      background-color: var(--bg-page);
      color: var(--text-main);
      line-height: 1.6;
      padding: 36px 16px;
    }
    .container {
      max-width: 680px;
      margin: 0 auto;
      background: var(--bg-card);
      padding: 36px 30px;
      border-radius: 12px;
      border: 1px solid var(--border);
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    h1 {
      font-size: 24px;
      font-weight: 700;
      color: #0f172a;
      margin-bottom: 6px;
    }
    .date {
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    ol {
      list-style-position: inside;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    li {
      font-size: 15px;
      color: var(--text-main);
    }
    li strong {
      color: #0f172a;
    }
    a {
      color: var(--accent);
      text-decoration: underline;
    }
    a:hover {
      color: #4338ca;
    }
    @media (max-width: 480px) {
      body { padding: 16px 10px; }
      .container { padding: 24px 18px; }
      h1 { font-size: 20px; }
      li { font-size: 14px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>BulkGrab Privacy Policy</h1>
    <p class="date">Last updated: September 20, 2026</p>
    <ol>
      <li>
        <strong>1. What stays on your device.</strong> BulkGrab scans the page you are on only when you use the extension. The list of files, your selections and ZIP bundling all happen locally in your browser. We do not collect, sell or share your browsing history or page contents. Your license status (Free or Pro), your session download count and a pending payment reference are stored in Chrome's extension storage on your device.
      </li>
      <li>
        <strong>2. What is sent to our server.</strong> (a) When you click &quot;Pay with Crypto&quot;, the extension asks our licensing server, hosted on Cloudflare Workers, to create a payment invoice with NOWPayments. No personal information is included in that request. (b) When you activate Pro, the Payment ID you enter is sent to our server, which asks NOWPayments for that payment's status, order reference and amount to decide whether to unlock Pro. (c) Our hosting provider, Cloudflare, may process standard technical request data such as IP address and timestamps to operate and secure the service.
      </li>
      <li>
        <strong>3. Payments.</strong> Payments are made in cryptocurrency through NOWPayments, a third party, under NOWPayments' own terms and privacy policy. We can see payment records in our NOWPayments account (payment ID, amount, status) and the public blockchain transaction. We do not receive or store your wallet keys or card details.
      </li>
      <li>
        <strong>4. Optional site access.</strong> BulkGrab asks for permission to read data on all websites only if a Pro user chooses &quot;Download as ZIP&quot; for files hosted on other domains. It is used only to fetch the files you selected. You can decline it (files then download individually) and revoke it any time on the Options page.
      </li>
      <li>
        <strong>5. No selling, no ads.</strong> We do not sell your data, use it for advertising, or use it for anything other than running BulkGrab and supporting your purchase.
      </li>
      <li>
        <strong>6. Changes and contact.</strong> We may update this policy and will change the date above. Questions or problems: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.
      </li>
    </ol>
  </div>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS, status: 204 });
    }

    // Health check endpoint
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'BulkGrab NOWPayments Licensing Backend',
        version: '1.0.0',
        timestamp: new Date().toISOString()
      }, null, 2), { headers: CORS_HEADERS });
    }

    // Privacy policy endpoint (mobile-friendly HTML)
    if ((url.pathname === '/privacy' || url.pathname === '/privacy/') && request.method === 'GET') {
      return new Response(getPrivacyHtml(), {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8'
        }
      });
    }

    // =========================================================================
    // ENDPOINT 1: Verify Payment Status (called by Chrome Extension)
    // GET /api/verify-payment?payment_id=<id>
    // =========================================================================
    if (url.pathname === '/api/verify-payment') {
      const paymentId = url.searchParams.get('payment_id')?.trim();

      if (!paymentId) {
        return new Response(JSON.stringify({
          valid: false,
          orderId: null,
          priceAmount: null,
          priceCurrency: null,
          error: 'Please provide a valid payment_id query parameter.',
          message: 'Please provide a valid payment_id query parameter.'
        }), { status: 400, headers: CORS_HEADERS });
      }

      if (!env.NOWPAYMENTS_API_KEY) {
        console.error('[Worker] NOWPAYMENTS_API_KEY secret is not configured!');
        return new Response(JSON.stringify({
          valid: false,
          orderId: null,
          priceAmount: null,
          priceCurrency: null,
          error: 'Worker configuration error: NOWPAYMENTS_API_KEY secret is not set.',
          message: 'Worker configuration error: NOWPAYMENTS_API_KEY secret is not set.'
        }), { status: 500, headers: CORS_HEADERS });
      }

      try {
        // Query NOWPayments API with secret key
        const nowpaymentsRes = await fetch(`https://api.nowpayments.io/v1/payment/${encodeURIComponent(paymentId)}`, {
          method: 'GET',
          headers: {
            'x-api-key': env.NOWPAYMENTS_API_KEY,
            'Accept': 'application/json'
          }
        });

        if (!nowpaymentsRes.ok) {
          const errText = await nowpaymentsRes.text();
          let errJson;
          try { errJson = JSON.parse(errText); } catch (_) {}
          
          if (nowpaymentsRes.status === 404) {
            return new Response(JSON.stringify({
              valid: false,
              notFound: true,
              orderId: null,
              priceAmount: null,
              priceCurrency: null,
              error: `Payment ID not found, please check you copied the Payment ID from the payment page. Support: ${SUPPORT_EMAIL}`
            }), { status: 404, headers: CORS_HEADERS });
          }

          return new Response(JSON.stringify({
            valid: false,
            orderId: null,
            priceAmount: null,
            priceCurrency: null,
            error: `${errJson?.message || `NOWPayments API returned HTTP ${nowpaymentsRes.status}`}. Support: ${SUPPORT_EMAIL}`
          }), { status: nowpaymentsRes.status, headers: CORS_HEADERS });
        }

        const data = await nowpaymentsRes.json();
        const status = (data.payment_status || '').toLowerCase();
        const orderId = data.order_id ? String(data.order_id) : null;
        const priceAmount = (data.price_amount !== undefined && data.price_amount !== null && !isNaN(Number(data.price_amount)))
          ? Number(data.price_amount)
          : null;
        const priceCurrency = data.price_currency ? String(data.price_currency).toLowerCase() : null;

        // Harden check: A payment only counts as a BulkGrab Pro purchase if ALL of these are true:
        // - payment_status is 'finished'
        // - order_id starts with "BG_PRO_" (created by our /api/create-payment)
        // - price_currency is 'usd' and price_amount is at least 9.99 (compare as numbers)
        //
        // Apply order_id check before pending statuses (waiting, confirming...)
        // so unrelated payments never look like pending purchases.
        const isBulkGrabOrder = Boolean(orderId && orderId.startsWith('BG_PRO_'));
        const isBulkGrabPrice = priceCurrency === 'usd' && priceAmount !== null && priceAmount >= 9.99;

        if (!isBulkGrabOrder || !isBulkGrabPrice) {
          return new Response(JSON.stringify({
            valid: false,
            message: `This payment is not a BulkGrab Pro purchase. Support: ${SUPPORT_EMAIL}`,
            error: `This payment is not a BulkGrab Pro purchase. Support: ${SUPPORT_EMAIL}`,
            orderId,
            priceAmount,
            priceCurrency,
            payment_status: status
          }), { status: 200, headers: CORS_HEADERS });
        }

        // 1. Finished: Payment successfully completed and confirmed
        if (status === 'finished') {
          return new Response(JSON.stringify({
            valid: true,
            status: 'pro',
            payment_status: 'finished',
            paymentId: data.payment_id,
            orderId,
            priceAmount,
            priceCurrency,
            payAddress: data.pay_address,
            actuallyPaid: data.actually_paid,
            payCurrency: data.pay_currency,
            message: 'NOWPayments crypto payment confirmed! Pro tier activated.'
          }), { status: 200, headers: CORS_HEADERS });
        }

        // 2. Waiting: Payment created, awaiting transaction broadcast
        if (status === 'waiting') {
          return new Response(JSON.stringify({
            valid: false,
            pending: true,
            payment_status: 'waiting',
            orderId,
            priceAmount,
            priceCurrency,
            error: `Payment is waiting for funds. If you just sent crypto, please allow a moment for the transaction to be detected on the network. Support: ${SUPPORT_EMAIL}`
          }), { status: 200, headers: CORS_HEADERS });
        }

        // 3. Confirming: Transaction detected on blockchain, awaiting required block confirmations
        if (status === 'confirming') {
          return new Response(JSON.stringify({
            valid: false,
            pending: true,
            payment_status: 'confirming',
            orderId,
            priceAmount,
            priceCurrency,
            error: `Transaction detected on the blockchain! Awaiting network block confirmations (usually 2–5 minutes). Please try again shortly. Support: ${SUPPORT_EMAIL}`
          }), { status: 200, headers: CORS_HEADERS });
        }

        // 4. Confirmed or Sending: Confirmed on chain, internal exchange / payout in progress
        if (status === 'confirmed' || status === 'sending') {
          return new Response(JSON.stringify({
            valid: false,
            pending: true,
            payment_status: status,
            orderId,
            priceAmount,
            priceCurrency,
            error: `Payment confirmed on blockchain and finalizing payout. Please re-verify in 1–2 minutes. Support: ${SUPPORT_EMAIL}`
          }), { status: 200, headers: CORS_HEADERS });
        }

        // 5. Partially Paid: Customer underpaid
        if (status === 'partially_paid') {
          return new Response(JSON.stringify({
            valid: false,
            payment_status: 'partially_paid',
            orderId,
            priceAmount,
            priceCurrency,
            error: `Payment was partially paid (received ${data.actually_paid || 0} ${data.pay_currency || ''} of required ${data.pay_amount || ''} ${data.pay_currency || ''}). Please check your NOWPayments invoice to complete payment. Support: ${SUPPORT_EMAIL}`
          }), { status: 200, headers: CORS_HEADERS });
        }

        // 6. Failed / Expired / Refunded
        if (status === 'failed' || status === 'expired') {
          return new Response(JSON.stringify({
            valid: false,
            payment_status: status,
            orderId,
            priceAmount,
            priceCurrency,
            error: `Payment has ${status}. Please initiate a new payment link. Support: ${SUPPORT_EMAIL}`
          }), { status: 200, headers: CORS_HEADERS });
        }

        if (status === 'refunded') {
          return new Response(JSON.stringify({
            valid: false,
            payment_status: 'refunded',
            orderId,
            priceAmount,
            priceCurrency,
            error: `This payment was refunded. Support: ${SUPPORT_EMAIL}`
          }), { status: 200, headers: CORS_HEADERS });
        }

        // Fallback for any unknown status
        return new Response(JSON.stringify({
          valid: false,
          message: `This payment is not a BulkGrab Pro purchase. Support: ${SUPPORT_EMAIL}`,
          error: `Current payment status: ${status}. Please try again later. Support: ${SUPPORT_EMAIL}`,
          orderId,
          priceAmount,
          priceCurrency,
          payment_status: status
        }), { status: 200, headers: CORS_HEADERS });

      } catch (err) {
        console.error('[Worker] Verification error:', err);
        return new Response(JSON.stringify({
          valid: false,
          orderId: null,
          priceAmount: null,
          priceCurrency: null,
          error: `Verification error: ${err.message}. Support: ${SUPPORT_EMAIL}`
        }), { status: 500, headers: CORS_HEADERS });
      }
    }

    // =========================================================================
    // ENDPOINT 2: NOWPayments Instant Payment Notification (IPN) Webhook
    // POST /api/webhook
    // =========================================================================
    if (url.pathname === '/api/webhook' && request.method === 'POST') {
      try {
        const signature = request.headers.get('x-nowpayments-sig');
        const rawBody = await request.text();

        if (env.NOWPAYMENTS_IPN_KEY) {
          const isValid = await verifyHmacSignature(rawBody, signature, env.NOWPAYMENTS_IPN_KEY);
          if (!isValid) {
            console.warn('[Worker Webhook] HMAC signature mismatch!');
            return new Response(JSON.stringify({ error: 'Invalid HMAC signature' }), {
              status: 401,
              headers: CORS_HEADERS
            });
          }
        }

        const payload = JSON.parse(rawBody);
        console.log(`[Worker Webhook] Received IPN for payment ${payload.payment_id}, status: ${payload.payment_status}`);

        // Optional: Cache finished payments in KV if namespace is bound
        if (env.BULKGRAB_KV && payload.payment_id) {
          await env.BULKGRAB_KV.put(
            `payment:${payload.payment_id}`,
            JSON.stringify({
              status: payload.payment_status,
              updatedAt: new Date().toISOString()
            }),
            { expirationTtl: 86400 * 365 } // Cache for 1 year
          );
        }

        return new Response(JSON.stringify({ ok: true, received: true }), {
          status: 200,
          headers: CORS_HEADERS
        });
      } catch (err) {
        console.error('[Worker Webhook] Error processing webhook:', err);
        return new Response(JSON.stringify({ error: err.message }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }
    }

    // =========================================================================
    // ENDPOINT 3: Create Dynamic Payment Invoice (called when clicking "Pay with Crypto")
    // POST /api/create-payment or GET /api/create-payment
    // =========================================================================
    if (url.pathname === '/api/create-payment') {
      if (!env.NOWPAYMENTS_API_KEY) {
        console.error('[Worker] NOWPAYMENTS_API_KEY secret is not configured!');
        return new Response(JSON.stringify({
          ok: false,
          error: 'Worker configuration error: NOWPAYMENTS_API_KEY secret is not set.'
        }), { status: 500, headers: CORS_HEADERS });
      }

      try {
        const orderId = `BG_PRO_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const webhookUrl = `${url.origin}/api/webhook`;

        // Create fresh invoice via NOWPayments Payments/Invoice API
        const invoiceRes = await fetch('https://api.nowpayments.io/v1/invoice', {
          method: 'POST',
          headers: {
            'x-api-key': env.NOWPAYMENTS_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            price_amount: 9.99,
            price_currency: 'usd',
            pay_currency: 'usdtbsc',
            ipn_callback_url: webhookUrl,
            order_id: orderId,
            order_description: 'BulkGrab Pro Lifetime License'
          })
        });

        if (!invoiceRes.ok) {
          const errText = await invoiceRes.text();
          let errJson;
          try { errJson = JSON.parse(errText); } catch (_) {}
          console.error('[Worker] Failed to create NOWPayments invoice:', errText);
          return new Response(JSON.stringify({
            ok: false,
            error: errJson?.message || `NOWPayments API returned HTTP ${invoiceRes.status}`
          }), { status: invoiceRes.status, headers: CORS_HEADERS });
        }

        const data = await invoiceRes.json();
        const invoiceUrl = data.invoice_url || `https://nowpayments.io/payment/?iid=${data.id}`;
        const invoiceId = String(data.id || '');
        const paymentId = invoiceId; // legacy alias for backward compatibility

        return new Response(JSON.stringify({
          ok: true,
          invoiceUrl,
          invoiceId,
          paymentId,
          orderId: data.order_id,
          priceAmount: data.price_amount,
          payCurrency: data.pay_currency
        }), { status: 200, headers: CORS_HEADERS });

      } catch (err) {
        console.error('[Worker] Create invoice error:', err);
        return new Response(JSON.stringify({
          ok: false,
          error: `Error creating payment invoice: ${err.message}`
        }), { status: 500, headers: CORS_HEADERS });
      }
    }

    return new Response(JSON.stringify({ error: 'Endpoint not found' }), {
      status: 404,
      headers: CORS_HEADERS
    });
  }
};
