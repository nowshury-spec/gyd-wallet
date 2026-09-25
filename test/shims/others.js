// Test-only stand-ins for sms.js, dropshipping.js, oauth.js and ludo.js.
// harness.js writes each one out as its own module file.

exports.sms = `
module.exports = {
  smsEnabled: () => false,
  sendSms: async () => ({ sent: false }),
};`;

exports.dropshipping = `
module.exports = {
  dropshippingEnabled: () => process.env.TEST_DROPSHIP_ENABLED === '1',
  fetchProductsFromCJ: async () => ({ ok: true, products: [] }),
  placeOrderWithCJ: async () => ({ ok: true, cjOrderId: 'cj-test', tracking: null }),
};`;

// The OAuth "code" in tests is just the profile JSON, base64url-encoded, so a
// test can sign in as any Google identity it likes.
exports.oauth = `
const decode = (code) => JSON.parse(Buffer.from(String(code), 'base64url').toString());
module.exports = {
  googleEnabled: () => true,
  facebookEnabled: () => false,
  googleAuthUrl: (state) => '/fake-google?state=' + encodeURIComponent(state),
  facebookAuthUrl: () => '',
  googleProfileFromCode: async (code) => decode(code),
  facebookProfileFromCode: async (code) => decode(code),
};`;

exports.ludo = `
module.exports = {
  LUDO_COLOR_SETS: { 2: ['red', 'yellow'], 4: ['red', 'green', 'yellow', 'blue'] },
  ludoLegalMoves: () => [],
  ludoApplyMove: () => ({ captured: false, finished: false }),
  ludoHasWon: () => false,
};`;
