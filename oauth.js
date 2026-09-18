// "Continue with Google" / "Continue with Facebook" — OAuth 2.0
// authorization-code flow reached with Node's built-in fetch() only, no
// npm dependency (see README's "Why no npm packages"). Each provider is
// entirely optional and independently gated behind its own pair of env
// vars — see README's "Setting up social sign-in" section for how to get
// them. Neither being set doesn't break anything: server.js checks
// googleEnabled()/facebookEnabled() before ever showing the buttons or
// accepting a callback, the same pattern email.js and sms.js use for their
// own optional delivery methods.
//
// This file only knows how to talk to Google/Facebook and turn their
// response into a plain { providerUserId, email, name } — it has no idea
// what a "user" is in this app's own database. Finding or creating the
// actual GYD Wallet account from that profile lives in server.js, right
// alongside the rest of the account logic (registration, login, etc.).

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID;
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET;

// Must exactly match the "Authorized redirect URI" / "Valid OAuth Redirect
// URI" registered in each provider's own developer console — see README.
// Defaults to this app's own Render URL; override with APP_BASE_URL if
// this is ever deployed somewhere else (a custom domain, a staging copy).
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://gyd-wallet.onrender.com').replace(/\/$/, '');

function googleEnabled() {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

function facebookEnabled() {
  return !!(FACEBOOK_APP_ID && FACEBOOK_APP_SECRET);
}

function googleRedirectUri() {
  return `${APP_BASE_URL}/api/auth/google/callback`;
}

function facebookRedirectUri() {
  return `${APP_BASE_URL}/api/auth/facebook/callback`;
}

function googleAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function facebookAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: FACEBOOK_APP_ID,
    redirect_uri: facebookRedirectUri(),
    state,
    scope: 'email,public_profile',
  });
  return `https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`;
}

// Exchanges the ?code=... Google sent our callback for the signed-in
// person's Google account id, email, and name. Throws on any failure —
// server.js catches it and redirects back to the login screen with the
// message, the same pattern used everywhere else in this app.
async function googleProfileFromCode(code) {
  let tokenRes, tokenData;
  try {
    tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(),
        grant_type: 'authorization_code',
      }).toString(),
    });
    tokenData = await tokenRes.json().catch(() => ({}));
  } catch (networkErr) {
    throw new Error('Could not reach Google. Please try again.');
  }
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(tokenData.error_description || 'Google did not complete sign-in.');
  }

  const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const profile = await profileRes.json().catch(() => ({}));
  if (!profileRes.ok || !profile.sub) {
    throw new Error('Could not read your Google profile.');
  }

  return {
    providerUserId: profile.sub,
    // Only trust the email if Google itself verified it — otherwise we'd
    // risk silently linking to (or creating) an account under an email
    // whoever's signing in doesn't actually own.
    email: profile.email_verified ? (profile.email || '').toLowerCase() : null,
    name: profile.name || profile.given_name || null,
  };
}

async function facebookProfileFromCode(code) {
  const tokenParams = new URLSearchParams({
    client_id: FACEBOOK_APP_ID,
    client_secret: FACEBOOK_APP_SECRET,
    redirect_uri: facebookRedirectUri(),
    code,
  });
  let tokenRes, tokenData;
  try {
    tokenRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?${tokenParams.toString()}`);
    tokenData = await tokenRes.json().catch(() => ({}));
  } catch (networkErr) {
    throw new Error('Could not reach Facebook. Please try again.');
  }
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error((tokenData.error && tokenData.error.message) || 'Facebook did not complete sign-in.');
  }

  const profileParams = new URLSearchParams({ fields: 'id,name,email', access_token: tokenData.access_token });
  const profileRes = await fetch(`https://graph.facebook.com/me?${profileParams.toString()}`);
  const profile = await profileRes.json().catch(() => ({}));
  if (!profileRes.ok || !profile.id) {
    throw new Error('Could not read your Facebook profile.');
  }

  return {
    providerUserId: profile.id,
    // Facebook only includes an email if the person has one on file with
    // Facebook AND grants the permission — neither is guaranteed, so this
    // can legitimately come back empty. server.js handles that the same
    // way it already handles any account created without an email.
    email: profile.email ? profile.email.toLowerCase() : null,
    name: profile.name || null,
  };
}

module.exports = {
  googleEnabled,
  facebookEnabled,
  googleAuthUrl,
  facebookAuthUrl,
  googleProfileFromCode,
  facebookProfileFromCode,
};
