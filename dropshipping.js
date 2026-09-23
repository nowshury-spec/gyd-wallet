// CJdropshipping API integration — reached with Node's built-in fetch(),
// same zero-npm-dependency approach as db.js's exec_query calls and
// email.js's Resend calls (see README's "Why no npm packages").
//
// Fully optional and OFF by default: with no CJ_API_KEY/CJ_ACCOUNT_ID set,
// dropshippingEnabled() returns false and every caller in server.js refuses
// to take a real order rather than charging someone's GYD balance for a
// purchase that can never actually be placed with CJ. See README's
// "Setting up CJdropshipping" for how to turn it on.
//
// IMPORTANT: the request/response shapes below (fields like productTitle,
// salePrice, mainImage.url, the /v1/products and /v1/orders paths) are
// this module's best guess at CJdropshipping's real API, based on their
// public docs (https://developers.cjdropshipping.com/en/api/start/) —
// they have NOT been exercised against a real CJ account, since none was
// available while building this. Treat this file as a starting point to
// verify/adjust against real API responses once real credentials exist,
// not as tested, working code.

const CJ_API_BASE = 'https://api.cjdropshipping.com';
const CJ_ACCOUNT_ID = process.env.CJ_ACCOUNT_ID;
const CJ_API_KEY = process.env.CJ_API_KEY;

function dropshippingEnabled() {
  return !!(CJ_API_KEY && CJ_ACCOUNT_ID);
}

function cjHeaders() {
  return {
    'Content-Type': 'application/json',
    'CJ-Access-Token': CJ_API_KEY,
  };
}

// Fetches a page of products from CJ's catalog. Never throws — a failure
// (bad key, CJ outage, no network, an unexpected response shape) comes back
// as { ok: false, reason } so the sync endpoint can report it cleanly
// instead of crashing. Returns { ok: true, products: [...] } on success,
// with each product normalized to the shape server.js's sync code expects.
async function fetchProductsFromCJ({ limit = 100, offset = 0 } = {}) {
  if (!dropshippingEnabled()) return { ok: false, reason: 'not_configured' };
  try {
    const response = await fetch(`${CJ_API_BASE}/v1/products?limit=${limit}&offset=${offset}`, {
      method: 'GET',
      headers: cjHeaders(),
    });
    if (!response.ok) return { ok: false, reason: `cj_http_${response.status}` };
    const data = await response.json();
    const rawProducts = Array.isArray(data.data) ? data.data : [];
    const products = rawProducts.map((p) => ({
      cjProductId: String(p.id),
      name: p.productTitle || p.name || 'Untitled product',
      description: p.productDescription || p.description || null,
      priceUsd: Number(p.salePrice || p.price || 0),
      imageUrl: (p.mainImage && p.mainImage.url) || p.imageUrl || null,
      category: p.category || null,
      inStock: Number(p.stock || 0) > 0,
      // CJ's package weight — commonly given in grams for shipping-cost
      // calculation; converted to kilograms here since that's the unit
      // server.js's oversized-cargo threshold uses. Field name is a best
      // guess like everything else in this file — verify against a real
      // account (see the file-level comment above).
      weightKg: Number(p.weight || p.productWeight || p.packWeight || 0) / 1000,
    }));
    return { ok: true, products };
  } catch (networkErr) {
    return { ok: false, reason: 'network_error' };
  }
}

// Places an order with CJ for the dropshipped items in a checkout. Never
// throws — a failure comes back as { ok: false, reason } so the checkout
// endpoint can refund the buyer instead of leaving them charged with
// nothing placed.
async function placeOrderWithCJ({ items, shipping }) {
  if (!dropshippingEnabled()) return { ok: false, reason: 'not_configured' };
  try {
    const payload = {
      products: items.map((item) => ({
        productId: item.cjProductId,
        quantity: item.quantity,
        price: item.priceUsd,
      })),
      shippingAddress: {
        name: shipping.name,
        phone: shipping.phone,
        address: shipping.address,
        city: shipping.city,
        country: shipping.country || 'GY',
      },
    };
    const response = await fetch(`${CJ_API_BASE}/v1/orders`, {
      method: 'POST',
      headers: cjHeaders(),
      body: JSON.stringify(payload),
    });
    if (!response.ok) return { ok: false, reason: `cj_http_${response.status}` };
    const result = await response.json();
    const cjOrderId = (result.data && (result.data.orderId || result.data.id)) || null;
    if (!cjOrderId) return { ok: false, reason: 'cj_no_order_id' };
    return { ok: true, cjOrderId, tracking: (result.data && result.data.trackingNumber) || null };
  } catch (networkErr) {
    return { ok: false, reason: 'network_error' };
  }
}

module.exports = { dropshippingEnabled, fetchProductsFromCJ, placeOrderWithCJ, CJ_API_BASE };
