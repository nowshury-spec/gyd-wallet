// Passkeys (WebAuthn): what "Sign in with Face ID" runs on. No npm packages,
// same as everything else here (see README's "Why no npm packages") — just
// Node's built-in crypto.
//
// How it works, in short: when someone turns on Face ID sign-in, their phone
// creates a new key pair and keeps the private half locked behind Face ID
// (or fingerprint / Windows Hello). We store only the public half. To sign
// in, the server sends a random one-time challenge; the phone asks for Face
// ID, then signs the challenge with the private key; we check that
// signature against the stored public key. The face itself never leaves
// the phone and is never seen by this server.
//
// The browser hands us the public key in the standard SPKI format (from
// AuthenticatorAttestationResponse.getPublicKey()), so there's no CBOR to
// decode here. Attestation is "none": we don't ask which brand of device
// made the key — the same choice most consumer sites make.
const crypto = require('crypto');

// COSE algorithm numbers we accept. ES256 is what iPhones, Android and most
// security keys use; RS256 covers Windows Hello on older machines.
const ES256 = -7;
const RS256 = -257;
const SUPPORTED_ALGORITHMS = [ES256, RS256];

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04; // Face ID / fingerprint / device PIN actually checked
const FLAG_ATTESTED_DATA = 0x40;

class PasskeyError extends Error {}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

function fromB64url(value, what) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 16384) {
    throw new PasskeyError(`bad ${what}`);
  }
  return Buffer.from(value, 'base64url');
}

function checkClientData(b64, { type, challenge, origin }) {
  const raw = fromB64url(b64, 'clientDataJSON');
  let data;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new PasskeyError('clientDataJSON is not JSON');
  }
  if (!data || data.type !== type) throw new PasskeyError('wrong ceremony type');
  if (data.challenge !== challenge) throw new PasskeyError('wrong challenge');
  if (data.origin !== origin) throw new PasskeyError('wrong origin');
  if (data.crossOrigin === true) throw new PasskeyError('cross-origin request');
  return raw;
}

function parseAuthenticatorData(b64, rpId, { attested }) {
  const buf = fromB64url(b64, 'authenticatorData');
  if (buf.length < 37) throw new PasskeyError('authenticatorData too short');
  // The first 32 bytes are a hash of the site the key belongs to — a key
  // made for another website can never pass this check.
  if (!buf.subarray(0, 32).equals(sha256(rpId))) throw new PasskeyError('key belongs to another site');
  const flags = buf[32];
  if (!(flags & FLAG_USER_PRESENT)) throw new PasskeyError('user not present');
  if (!(flags & FLAG_USER_VERIFIED)) throw new PasskeyError('user not verified');
  const signCount = buf.readUInt32BE(33);
  let credentialId = null;
  if (attested) {
    if (!(flags & FLAG_ATTESTED_DATA) || buf.length < 55) throw new PasskeyError('no credential data');
    const idLength = buf.readUInt16BE(53);
    if (idLength < 16 || idLength > 1023 || buf.length < 55 + idLength) throw new PasskeyError('bad credential id');
    credentialId = buf.subarray(55, 55 + idLength);
  }
  return { raw: buf, signCount, credentialId };
}

function importPublicKey(spkiB64, algorithm) {
  let key;
  try {
    key = crypto.createPublicKey({ key: fromB64url(spkiB64, 'public key'), format: 'der', type: 'spki' });
  } catch (err) {
    if (err instanceof PasskeyError) throw err;
    throw new PasskeyError('unreadable public key');
  }
  const details = key.asymmetricKeyDetails || {};
  if (algorithm === ES256 && key.asymmetricKeyType === 'ec' && details.namedCurve === 'prime256v1') return key;
  if (algorithm === RS256 && key.asymmetricKeyType === 'rsa' && details.modulusLength >= 2048) return key;
  throw new PasskeyError('public key does not match its algorithm');
}

// Turning Face ID on: checks what the browser returned from
// navigator.credentials.create(). Returns what to store.
function verifyRegistration({ credential, challenge, origin, rpId }) {
  const response = (credential && credential.response) || {};
  checkClientData(response.clientDataJSON, { type: 'webauthn.create', challenge, origin });
  const authData = parseAuthenticatorData(response.authenticatorData, rpId, { attested: true });
  const rawId = fromB64url(credential.rawId, 'credential id');
  if (!authData.credentialId.equals(rawId) || credential.id !== credential.rawId) {
    throw new PasskeyError('credential id mismatch');
  }
  const algorithm = Number(response.publicKeyAlgorithm);
  if (!SUPPORTED_ALGORITHMS.includes(algorithm)) throw new PasskeyError('unsupported algorithm');
  importPublicKey(response.publicKey, algorithm);
  return {
    credentialId: credential.rawId,
    publicKey: response.publicKey,
    algorithm,
    signCount: authData.signCount,
  };
}

// Signing in: checks what the browser returned from
// navigator.credentials.get() against the stored public key. Returns the
// authenticator's new signature counter.
function verifyAuthentication({ credential, challenge, origin, rpId, publicKey, algorithm, storedSignCount }) {
  const response = (credential && credential.response) || {};
  const clientData = checkClientData(response.clientDataJSON, { type: 'webauthn.get', challenge, origin });
  const authData = parseAuthenticatorData(response.authenticatorData, rpId, { attested: false });
  const key = importPublicKey(publicKey, algorithm);
  const signedData = Buffer.concat([authData.raw, sha256(clientData)]);
  const signature = fromB64url(response.signature, 'signature');
  let ok = false;
  try {
    ok = crypto.verify('sha256', signedData, key, signature);
  } catch {
    ok = false;
  }
  if (!ok) throw new PasskeyError('bad signature');
  // Keys that keep a use counter must count upwards; a repeat or a step back
  // means the key was copied. (iPhone/iCloud passkeys always report 0.)
  const stored = Number(storedSignCount) || 0;
  if ((authData.signCount !== 0 || stored !== 0) && authData.signCount <= stored) {
    throw new PasskeyError('signature counter went backwards');
  }
  return { signCount: authData.signCount };
}

module.exports = { verifyRegistration, verifyAuthentication, PasskeyError, SUPPORTED_ALGORITHMS, ES256, RS256 };
