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
// Fully optional: with the Twilio env vars unset, smsEnabled() returns
// false and every caller in server.js falls back to the existing behavior
// (share the code yourself / on-screen code), so the app keeps working
// exactly as before for anyone who hasn't set this up. See README's
// "Setting up real SMS delivery" for how to turn it on.

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

function smsEnabled() {
  return !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER);
}

// Sends one text message. Never throws — a send failure (bad credentials,
// an undeliverable number, a Twilio outage) comes back as
// { sent: false, reason } instead, so a caller can fall back to its
// existing "share this yourself" / on-screen behavior rather than blocking
// the whole action over an SMS provider hiccup.
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
