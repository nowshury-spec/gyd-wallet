// Real SMS delivery, using Twilio's REST API reached with Node's built-in
// fetch() — same zero-npm-dependency approach as email.js and db.js's
// exec_query calls (see README's "Why no npm packages"). This is what
// upgrades two things from "the sender/staff member has to handle it
// themselves" into an actual text message:
//
//   1. GYD Direct transfer reference codes — texted straight to the
//      recipient's phone instead of the sender having to relay it by hand.
//   2. Staff login verification codes — as an alternative to email, for a
//      staff member who has added a phone number but no email (or prefers
//      SMS) under the Employees tab.
//
// Optional: with the Twilio env vars unset, smsEnabled() returns false —
// GYD Direct senders share the reference code themselves, and staff need an
// email on file to receive login codes. See README's "Setting up real SMS
// delivery" for how to turn it on. Once enabled, restrict Twilio's
// Geographic Permissions to the countries you actually text (e.g. Guyana)
// so the account can't be used to text premium-rate numbers abroad.

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

function smsEnabled() {
  return !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER);
}

// Sends one text message. Never throws — a send failure (bad credentials,
// an undeliverable number, a Twilio outage, a 10-second timeout) comes back
// as { sent: false, reason } for the caller to report.
async function sendSms(to, body) {
  if (!smsEnabled()) return { sent: false, reason: 'not_configured' };
  try {
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const params = new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Body: body });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return { sent: false, reason: `twilio_http_${res.status}` };
    }
    return { sent: true };
  } catch (networkErr) {
    return { sent: false, reason: 'network_error' };
  }
}

module.exports = { smsEnabled, sendSms };
