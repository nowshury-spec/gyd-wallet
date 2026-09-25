// Test-only stand-in for email.js: "sends" by appending to a mailbox file
// the tests read from. Enabled when TEST_EMAIL_ENABLED=1; TEST_EMAIL_FAIL=1
// simulates a provider outage.
const fs = require('fs');

function emailEnabled() {
  return process.env.TEST_EMAIL_ENABLED === '1';
}
async function sendEmail(to, subject, html) {
  if (process.env.TEST_EMAIL_FAIL === '1') return { sent: false };
  fs.appendFileSync(process.env.TEST_MAILBOX, JSON.stringify({ to, subject, html }) + '\n');
  return { sent: true };
}
function codeEmailHtml(intro, code) {
  return `<p>${intro}</p><p class="code">${code}</p>`;
}

module.exports = { emailEnabled, sendEmail, codeEmailHtml };
