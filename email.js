// Real email delivery, using Resend's HTTP API — reached with Node's
// built-in fetch(), same zero-npm-dependency approach as db.js's
// exec_query calls (see README's "Why no npm packages"). This is what
// upgrades password-reset codes, forgotten usernames, and the staff login
// verification code from "shown on screen" (this app's simulated fallback
// everywhere, since there was never a real email integration) into
// something only the actual account holder can see.
//
// Fully optional: with no RESEND_API_KEY set, emailEnabled() returns false
// and every caller in server.js falls back to the old on-screen behavior,
// so the app keeps working exactly as before for anyone who hasn't set
// this up yet. See README's "Setting up real email delivery" for how to
// turn it on.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'GYD Wallet <onboarding@resend.dev>';

function emailEnabled() {
  return !!RESEND_API_KEY;
}

// Sends one email. Never throws — a send failure (bad key, Resend outage,
// no network) comes back as { sent: false, reason } instead, so a caller
// can fall back to showing the code on screen rather than locking someone
// out entirely over an email provider hiccup.
async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) return { sent: false, reason: 'not_configured' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: RESEND_FROM_EMAIL, to, subject, html }),
    });
    if (!res.ok) {
      return { sent: false, reason: `resend_http_${res.status}` };
    }
    return { sent: true };
  } catch (networkErr) {
    return { sent: false, reason: 'network_error' };
  }
}

// Small shared wrapper so every code email in the app looks the same.
function codeEmailHtml(introLine, code, expiresInMinutes) {
  return `
    <div style="font-family: -apple-system, sans-serif; max-width: 420px; margin: 0 auto;">
      <p>${introLine}</p>
      <p style="font-size: 32px; font-weight: 800; letter-spacing: 6px; text-align: center; margin: 24px 0;">${code}</p>
      <p style="color: #666; font-size: 13px;">This code expires in ${expiresInMinutes} minutes. If you didn't request this, you can safely ignore this email.</p>
    </div>
  `;
}

module.exports = { emailEnabled, sendEmail, codeEmailHtml };
