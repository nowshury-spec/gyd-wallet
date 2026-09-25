-- GYD Wallet — Postgres schema for Supabase.
--
-- Run this once against a fresh Supabase project (SQL Editor → paste this
-- whole file → Run) before pointing the app at it. It creates every table
-- the app needs (a straight port of the old SQLite schema — see db.js's
-- git history for that version) plus one function, exec_query, that's the
-- ONLY way the app ever talks to this database — see "How the database
-- works" in README.md for why, and db.js for the client side of it.
--
-- Safe to re-run: every statement is idempotent (CREATE ... IF NOT EXISTS,
-- CREATE OR REPLACE FUNCTION).

-- business_gyd_balance is a SECOND, separate GYD balance that only a
-- business account has any use for: money customers pay the business
-- (transfers/QR pay, checkout, charge-request approvals, and money requests
-- where the business is the one requesting payment) lands here instead of
-- gyd_balance, so it never gets mixed into the owner's own personal spending
-- money. The owner moves earnings into their personal balance on purpose via
-- POST /api/business/wallet/move-to-personal — see server.js for exactly
-- which flows credit which balance.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  -- Deprecated, unused by the app — kept only because renaming a column
  -- outright would have broken the already-deployed app the moment this
  -- migration ran (see the add_paytag_column_rebrand migration). `paytag`
  -- below is the real, current column; this one is safe to drop in a later
  -- migration once the app has been running on `paytag` for a while.
  cashtag TEXT UNIQUE,
  -- A short, unique, user-changeable public payment handle, separate from
  -- the login username — e.g. so people can pay you without knowing your
  -- username. Auto-generated at signup, editable any time from the Wallet
  -- tab. Called "paytag" (not "cashtag") on purpose: this app's own name,
  -- not a competitor's trademarked term — see the add_paytag_column_rebrand
  -- migration for why this exists as its own column instead of a rename.
  paytag TEXT UNIQUE,
  -- Required for every new signup (enforced in server.js's /api/register,
  -- not by a NOT NULL here) so a sender always has a way to reach the
  -- account a payment landed in, and so a lost-password recovery flow has
  -- somewhere to go later. Nullable at the column level on purpose: a
  -- handful of accounts were created before this requirement existed, and
  -- making it NOT NULL would have broken that pre-existing data on
  -- migration. UNIQUE still allows any number of NULLs in Postgres, so it
  -- doesn't weaken the one-email-per-account rule for everyone after.
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  is_business INTEGER NOT NULL DEFAULT 0,
  business_name TEXT,
  gyd_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  business_gyd_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  -- Session-revocation control: every login token embeds the moment it was
  -- issued (see auth.js's `iat`). "Log out of all other devices"
  -- (POST /api/security/logout-all-sessions) just sets this to right now —
  -- getAuthedUser in server.js then rejects any token issued before this
  -- timestamp, which is every token that existed a moment ago, without the
  -- app needing to track or list individual sessions anywhere. NULL means
  -- "never logged out everywhere," so every existing token stays valid.
  sessions_invalidated_at TEXT
);

-- A courier is a third role any existing account can apply for (same idea
-- as is_business/business_gyd_balance above, just for delivering
-- dropshipping orders instead of running a storefront). Unlike becoming a
-- business, this ISN'T a self-serve flip — is_courier only ever gets set
-- true by a staff member approving a courier_applications row below (see
-- POST /api/staff/courier-applications/:id/approve); applying
-- (POST /api/account/apply-courier) only ever creates that pending row.
-- courier_gyd_balance holds delivery fees earned from confirmed deliveries
-- (see delivery_code on dropshipping_orders below) until the courier moves
-- them into their personal balance via POST /api/courier/wallet/move-to-personal,
-- same one-directional "owner's draw" pattern as the business wallet.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_courier BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS courier_gyd_balance NUMERIC(14,2) NOT NULL DEFAULT 0;

-- Whether this account has PROVEN it controls its email address: set when
-- the account was created from a provider-verified Google/Facebook email,
-- or when a password-reset code that was actually emailed to it gets
-- redeemed (see password_resets.sent_via_email). A plain password signup
-- doesn't verify its email, so it starts false. "Continue with Google" only
-- links into an existing account whose email is verified — otherwise anyone
-- could sign up with someone else's email first and then inherit that
-- person's Google sign-in (see findOrCreateOAuthUser in server.js).
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;

-- One row per courier application. A user can apply more than once over
-- time (e.g. after a rejection), so this is its own table rather than a
-- single status column on users — same reasoning as cashout_requests and
-- support_tickets being their own queues rather than columns bolted onto
-- users. 'pending' rows are what shows up in the staff portal's Couriers
-- tab; 'approved' is what actually flips users.is_courier to true (see the
-- comment above); 'rejected' just leaves a record — the user can apply
-- again, which inserts a new row rather than reusing the rejected one, so
-- the full history of attempts is kept.
CREATE TABLE IF NOT EXISTS courier_applications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected' | 'revoked'
  note TEXT, -- optional message from the applicant, shown to staff
  staff_note TEXT, -- optional reason, set by staff on reject
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT -- staff_accounts.id of whoever approved/rejected it (plain text, same as cashout_requests.resolved_by — no FK, staff accounts aren't part of this migration's scope)
);
ALTER TABLE courier_applications ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_courier_applications_user ON courier_applications(user_id);
CREATE INDEX IF NOT EXISTS idx_courier_applications_status ON courier_applications(status);
-- At most ONE pending application per user, enforced by the database: two
-- quick taps on "Apply" used to race past the app's own "already pending?"
-- check and queue duplicates. Any duplicates that already exist are closed
-- first (keeping each user's earliest), so this index can be created.
UPDATE courier_applications a
SET status = 'rejected', staff_note = COALESCE(a.staff_note, 'Duplicate application (closed automatically)'),
    resolved_at = COALESCE(a.resolved_at, a.created_at)
WHERE a.status = 'pending' AND EXISTS (
  SELECT 1 FROM courier_applications b
  WHERE b.user_id = a.user_id AND b.status = 'pending' AND (b.created_at, b.id) < (a.created_at, a.id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_courier_applications_one_pending
  ON courier_applications(user_id) WHERE status = 'pending';

-- Links a users row to a "Continue with Google/Facebook" identity — see
-- oauth.js and the /api/auth/google/* + /api/auth/facebook/* routes in
-- server.js. Kept as its own table (rather than google_id/facebook_id
-- columns on users) so an account can have one, both, or neither, and so
-- adding a third provider later is another row shape, not another column.
-- provider_user_id is that provider's own permanent account id (Google's
-- `sub`, Facebook's `id`) — never the email, since a person can change
-- their email with the provider but that id never changes.
CREATE TABLE IF NOT EXISTS oauth_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, -- 'google' | 'facebook'
  provider_user_id TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_user_id)
);

-- Backfill users.email_verified (see above): accounts whose email came from
-- (and matches) a linked Google/Facebook identity were verified by it.
UPDATE users u SET email_verified = true
WHERE email_verified = false AND u.email IS NOT NULL AND EXISTS (
  SELECT 1 FROM oauth_identities o WHERE o.user_id = u.id AND LOWER(o.email) = LOWER(u.email)
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  from_user TEXT,
  to_user TEXT,
  amount NUMERIC(14,2) NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cashout_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount_gyd NUMERIC(14,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | rejected
  created_at TEXT NOT NULL,
  -- Who on staff (staff_accounts.id) resolved this, and when — see the
  -- staff portal's cash-out queue in server.js. A 'completed' request means
  -- a staff member actually paid the customer outside the app (still no
  -- licensed payout integration — see README's "Why no npm packages" scope
  -- note); a 'rejected' one refunds the escrowed GYD back to the customer's
  -- balance instead.
  resolved_at TEXT,
  resolved_by TEXT
);

-- The games are free to play — no coins, no wager, nothing of value paid
-- out — so a round is just a record of what happened (which symbol/face
-- came up, and whether that counted as a win), not a financial transaction.
-- There is deliberately no "coins" balance or currency anywhere in this
-- schema anymore; see server.js's games section for why.
CREATE TABLE IF NOT EXISTS game_rounds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  game TEXT NOT NULL,
  choice TEXT,
  outcome TEXT NOT NULL,
  won INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS charge_requests (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  memo TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_user TEXT NOT NULL,
  to_user TEXT NOT NULL,
  body TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- A GYD Direct transfer (our own send-to-anyone feature): the sender pays
-- an amount plus a fee up front (escrowed out of their balance
-- immediately), gets back a private reference code, and hands that code to
-- the recipient out of band (text, call, in person). The recipient — who
-- does not need to already have an account — claims the transfer by
-- entering the reference code and the recipient name the sender typed in.
CREATE TABLE IF NOT EXISTS remittances (
  id TEXT PRIMARY KEY,
  reference_code TEXT UNIQUE NOT NULL,
  from_user TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  recipient_phone TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  fee NUMERIC(14,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | cancelled
  claimed_by_user_id TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT
);
-- How many pickup attempts have been made against this transfer's code
-- (right or wrong name). After MAX_REMIT_CLAIM_ATTEMPTS in server.js the
-- transfer can no longer be picked up — the sender cancels it (full refund)
-- and resends — so someone who learns or guesses a reference code can't
-- just keep trying names until one matches.
ALTER TABLE remittances ADD COLUMN IF NOT EXISTS claim_attempts INTEGER NOT NULL DEFAULT 0;

-- A business's public "storefront" page: category + free-text keywords make
-- it findable in the directory search below, and the tagline/description/
-- theme color/logo let the business make the page feel like their own, even
-- in this simple prototype. A business account with no row here yet just
-- hasn't set up their page, and won't show up in the directory until they
-- do — having a business account and having a page are separate steps.
-- offers_delivery/delivery_fee let a business flag delivery as an option a
-- customer can pick at checkout, with the fee going to the business (they're
-- the one arranging the delivery) — unlike GYD Direct's fee above, which the
-- platform itself keeps.
CREATE TABLE IF NOT EXISTS business_profiles (
  user_id TEXT PRIMARY KEY,
  category TEXT,
  tagline TEXT,
  description TEXT,
  keywords TEXT,
  theme_color TEXT,
  logo_emoji TEXT,
  phone TEXT,
  location TEXT,
  offers_delivery INTEGER NOT NULL DEFAULT 0,
  delivery_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  -- Used to be a staff review gate (pending | approved | rejected) that held
  -- a brand new business page out of the directory until staff approved it.
  -- That gate has been removed — every page publishes immediately on
  -- creation — but the column stays (always 'approved' now) so existing
  -- rows and the /api/business/directory query below don't need touching.
  review_status TEXT NOT NULL DEFAULT 'approved'
);

-- A line item on a business's page — a specific product or service and its
-- price, shown on their public page under "Products & prices" and matched
-- by directory search (a customer searching a product name should find the
-- business that lists it, same as matching the free-text keywords field).
-- image_data is an optional photo, stored as a data: URL (base64) since
-- there's no file storage or upload endpoint in this zero-dependency
-- prototype — the browser resizes/compresses the photo before sending it,
-- so this stays a reasonably small text blob rather than a raw file.
CREATE TABLE IF NOT EXISTS business_products (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  name TEXT NOT NULL,
  price NUMERIC(14,2) NOT NULL,
  description TEXT,
  image_data TEXT,
  created_at TEXT NOT NULL
);

-- Cash-App-style "Request Money": from_user is the person asking to be
-- paid (the requester), to_user is the person being asked to pay. Only
-- ever moves money between two existing accounts (unlike the remittance
-- table above, which can target someone with no account yet) — this is
-- the peer-to-peer "request" half of send/request, same as Cash App.
CREATE TABLE IF NOT EXISTS money_requests (
  id TEXT PRIMARY KEY,
  from_user TEXT NOT NULL,
  to_user TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | declined | cancelled
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

-- A 2- or 4-player Ludo match: free to play, like every other game in this
-- app — no coins, no GYD, nothing of value staked on the outcome (see
-- server.js's games section and README.md's "Why the games are free to
-- play"). The whole match — which colors are seated, each seat's 4 piece
-- positions, whose turn it is, and any roll still waiting on a piece choice
-- — lives in the state column as a JSON blob rather than its own columns, since it's
-- really one small nested document per match rather than relational data;
-- see ludo.js for the actual game rules that operate on it.
CREATE TABLE IF NOT EXISTS ludo_tables (
  id TEXT PRIMARY KEY,
  host_user_id TEXT NOT NULL,
  max_players INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting', -- waiting | in_progress | finished | cancelled
  state TEXT NOT NULL,
  winner_user_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

-- An event a business posts on its own page — a concert, a sale, a class,
-- anything with a date and a ticket price. capacity is optional (NULL means
-- unlimited); status lets a business cancel an event without deleting it
-- out from under anyone who already bought a ticket.
CREATE TABLE IF NOT EXISTS business_events (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  event_date TEXT NOT NULL,
  ticket_price NUMERIC(14,2) NOT NULL,
  capacity INTEGER,
  status TEXT NOT NULL DEFAULT 'active', -- active | cancelled
  created_at TEXT NOT NULL
);

-- One purchased ticket. ticket_code is the short, unique string encoded
-- into the ticket's QR image (see server.js) — the event's own coordinator
-- scans or types it in at the door to check someone in, which just flips
-- status from 'valid' to 'checked_in' (and records when). platform_fee is
-- the 3.5%-of-ticket-price cut the platform keeps out of price_paid before
-- the rest reaches the business's wallet — see server.js's events section
-- for the exact math and README.md for why the fee isn't credited to any
-- account (same "the platform just keeps it" treatment as GYD Direct's fee).
CREATE TABLE IF NOT EXISTS event_tickets (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  buyer_user_id TEXT NOT NULL,
  ticket_code TEXT UNIQUE NOT NULL,
  price_paid NUMERIC(14,2) NOT NULL,
  platform_fee NUMERIC(14,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'valid', -- valid | checked_in | refunded (event cancelled)
  purchased_at TEXT NOT NULL,
  checked_in_at TEXT
);

-- A job a business posts looking for hires. Shows on the business's own
-- page (like events do) AND in the site-wide jobs board (GET /api/jobs) so
-- someone doesn't have to already know about a business to find its
-- openings. There's no in-app application system beyond that — "Apply"
-- just starts a message thread with the business through the existing
-- messaging feature (see server.js) rather than a separate applicant
-- tracker. status lets a business close a listing without losing the
-- record of having posted it.
CREATE TABLE IF NOT EXISTS job_postings (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  pay_info TEXT,
  job_type TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active | closed
  created_at TEXT NOT NULL,
  -- Same removed staff-approval gate as business_profiles.review_status
  -- above — kept as a column (always 'approved') so nothing else needs to
  -- change; every posting is visible on the public /api/jobs board the
  -- moment it's created.
  review_status TEXT NOT NULL DEFAULT 'approved'
);

-- Which of Guyana's 10 administrative regions a job is in, for filtering on
-- the jobs board — restricted to a fixed allow-list in server.js
-- (GUYANA_REGIONS), same pattern as business_profiles.dietary_tags.
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS region TEXT;

-- A user bookmarking a job posting on the jobs board — the "☆ save" button.
-- Purely a personal list; doesn't notify the business or affect the
-- posting itself.
CREATE TABLE IF NOT EXISTS saved_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, job_id)
);
ALTER TABLE saved_jobs ENABLE ROW LEVEL SECURITY;

-- A "forgot password" reset code. Since this Phase 1 prototype has no real
-- email sending set up (see "Why no npm packages" in README.md), the code
-- generated here is handed straight back to the browser and shown on
-- screen instead of actually being emailed — the same "simulated" spirit
-- as deposits. Only one active code per user at a time: requesting a new
-- one deletes any earlier unused code for that user first (see server.js),
-- so there's never more than one row per user_id to check against.
CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  -- Wrong guesses against this code, so an automated script can't just try
  -- all 1,000,000 possible 6-digit codes within the 15-minute window —
  -- server.js locks the code out after MAX_RESET_CODE_ATTEMPTS misses.
  attempts INTEGER NOT NULL DEFAULT 0
);
-- True when this code was emailed (rather than shown on screen in
-- SHOW_CODES_ON_SCREEN demo mode) — so redeeming it proves inbox control
-- and marks users.email_verified.
ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS sent_via_email BOOLEAN NOT NULL DEFAULT false;

-- Employee/staff logins for the internal staff portal (public/staff.html) —
-- completely separate from the `users` table above (customers and
-- businesses), so a staff login can never be confused with a customer login
-- even though they share the same password-hashing code.
--
-- role is 'owner' or 'employee' — this is the actual fraud/theft control
-- for the staff portal: only an 'owner' can create another staff account
-- (see requireStaffOwner in server.js) or view the audit log below, so one
-- compromised or dishonest employee can't quietly grant an accomplice
-- access. There's no self-signup for the very first account either way —
-- see README.md's "How the staff portal works" for how that one gets
-- seeded (as 'owner').
CREATE TABLE IF NOT EXISTS staff_accounts (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee', -- 'owner' | 'employee'
  created_at TEXT NOT NULL,
  -- Same session-revocation mechanism as users.sessions_invalidated_at
  -- above. Set by a staff member logging themselves out everywhere
  -- (POST /api/staff/logout-all-sessions), OR by an owner forcibly cutting
  -- off a specific employee's access (POST
  -- /api/staff/accounts/:id/revoke-sessions) — e.g. right after they're let
  -- go, or the moment their account is suspected compromised, without
  -- needing to know or reset their password first.
  sessions_invalidated_at TEXT,
  -- Optional — set by the account itself (PATCH /api/staff/me/email) or by
  -- an owner when creating the account. With this set AND real email
  -- delivery configured (see email.js), the login verification code and
  -- fraud-alert emails below go here instead of only showing on screen.
  -- NULL just means "no real delivery for this account yet" — everything
  -- still falls back to on-screen the same as before.
  email TEXT,
  -- Same idea as email above, but for SMS delivery of the login
  -- verification code (see sms.js and PATCH /api/staff/me/phone) — tried
  -- as a fallback when email isn't on file, isn't configured, or fails to
  -- send. Added via the add_staff_phone_column migration.
  phone TEXT
);

-- A one-time 6-digit code required after username+password to finish a
-- staff login — see POST /api/staff/login and /api/staff/login/verify-code
-- in server.js. Same "simulated" pattern as password_resets below when
-- nothing is configured (the code comes straight back in the API response
-- and is shown on screen). Real delivery (email.js and/or sms.js) is
-- optional and per-account — without an email or phone on file for this
-- staff account, or without RESEND_API_KEY/the Twilio env vars set at all
-- (see README's "Setting up real email delivery" and "Setting up real SMS
-- delivery"), this stays a structural second step rather than a true
-- second factor, since anyone who already has the password can see the
-- code too. It becomes a real second factor the moment the code is
-- actually sent somewhere only the real staff member can see.
CREATE TABLE IF NOT EXISTS staff_login_codes (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);

-- A permanent record of every sensitive staff action — cash-out payouts and
-- rejections, and new staff accounts being created. This is the other half
-- of the fraud/theft control: nothing here
-- is ever updated or deleted by the app (see server.js's logStaffAction —
-- it only ever INSERTs), so an owner reviewing GET /api/staff/audit-log
-- gets a trustworthy trail of who did what and when, including anything an
-- employee might prefer wasn't easily checked on.
CREATE TABLE IF NOT EXISTS staff_audit_log (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  staff_username TEXT NOT NULL, -- denormalized so the log stays readable even if the staff row is ever removed
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);

-- A support request a customer submits from the app. user_id is nullable
-- because someone might need help before they can log in (e.g. they can't
-- get into their account at all) — name/email are captured directly on the
-- ticket in that case instead of being looked up from a user row.
-- staff_reply is a single text field rather than a full message thread —
-- enough for a Phase 1 "someone on staff read this and responded" loop; a
-- real back-and-forth thread is a natural upgrade later; see the messages
-- table above for the pattern this app already uses for actual message
-- threads, which a future version of this could switch to.
CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  name TEXT,
  email TEXT,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | resolved
  staff_reply TEXT,
  replied_by TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

-- A customer's star rating (and optional comment) on a business's page.
-- One row per (business, reviewer) pair — UNIQUE below — so leaving a new
-- review when you've already reviewed that business updates your existing
-- one instead of piling up duplicates; server.js does this as an upsert.
-- business_id/reviewer_id both point at users.id (a business's "id" is the
-- same id business_profiles.user_id uses everywhere else in this file).
-- Comments are shown publicly on the business's page — there's no staff
-- moderation queue for these in this Phase 1 version.
CREATE TABLE IF NOT EXISTS business_reviews (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (business_id, reviewer_id)
);

-- A short, quick, Foursquare-style tip a customer leaves on a business's
-- page ("ask for the corner table", "cash only") — separate from a star
-- review, and deliberately kept to one per (business, customer) pair
-- (submitting again edits the existing tip, same upsert pattern as
-- business_reviews above) so it stays a single running note rather than a
-- feed. FKs (unlike business_reviews.business_id/reviewer_id, which predate
-- this convention) so a deleted business or user doesn't leave orphaned
-- tips behind. Public on the business's page — no staff moderation queue
-- for these yet, same as business_reviews.
CREATE TABLE IF NOT EXISTS business_tips (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (length(trim(text)) > 0 AND length(text) <= 300),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (business_id, user_id)
);
ALTER TABLE business_tips ENABLE ROW LEVEL SECURITY;

-- Comma-separated dietary options a business selects for their page (e.g.
-- "vegan,halal,gluten-free"), matching the existing free-text `keywords`
-- column's storage style. Values are restricted to a fixed allow-list in
-- server.js (ALLOWED_DIETARY_TAGS) so it stays a meaningful filter facet
-- rather than freeform text.
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS dietary_tags TEXT;

-- Optional freeform website URL and hours text for a business's page —
-- kept as plain strings (no live "open now" computation, which would need
-- real timezone handling) matching the simple style of the other optional
-- profile fields like phone/location above.
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS hours TEXT;

-- A business's photo gallery (see server.js's /api/business/photos and
-- db.js's storageUpload/storageDelete). Unlike a product photo — a base64
-- data: URL stored right in business_products.image_data — these go into a
-- real Supabase Storage bucket, since a business can have up to 20 of
-- them: storing that many as base64 text would bloat every profile/
-- directory query that touches this business's row.
CREATE TABLE IF NOT EXISTS business_photos (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
ALTER TABLE business_photos ENABLE ROW LEVEL SECURITY;

-- The bucket backing business_photos above, made public for reads (so a
-- photo's URL just works in an <img> tag with no auth), with write access
-- scoped to it via storage.objects RLS policies. Writes and deletes are
-- granted ONLY to service_role — the role behind the secret key db.js uses
-- (see exec_query below). They used to be granted to anon, but Supabase's
-- anon/publishable key is designed to be public, so anyone holding it could
-- upload to or wipe this bucket directly. Reads stay open to anon: the
-- bucket is public so photo URLs work in a plain <img> tag anyway.
INSERT INTO storage.buckets (id, name, public)
VALUES ('business-photos', 'business-photos', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "gyd_wallet_business_photos_read" ON storage.objects;
CREATE POLICY "gyd_wallet_business_photos_read"
  ON storage.objects FOR SELECT
  TO anon
  USING (bucket_id = 'business-photos');

DROP POLICY IF EXISTS "gyd_wallet_business_photos_write" ON storage.objects;
CREATE POLICY "gyd_wallet_business_photos_write"
  ON storage.objects FOR INSERT
  TO service_role
  WITH CHECK (bucket_id = 'business-photos');

DROP POLICY IF EXISTS "gyd_wallet_business_photos_delete" ON storage.objects;
CREATE POLICY "gyd_wallet_business_photos_delete"
  ON storage.objects FOR DELETE
  TO service_role
  USING (bucket_id = 'business-photos');

-- A pickup order's hold-until-pickup escrow (see server.js's "pickup orders"
-- section for the full lifecycle: checkout debits the customer and inserts
-- a 'pending' row here rather than paying the business right away; it's
-- released to the business — status 'completed' — either by the business
-- redeeming the customer's pickup_code in person, or automatically once
-- expires_at passes unredeemed; either side can also cancel a still-pending
-- order for a full refund — status 'cancelled'). release_reason records
-- which of those four things actually happened: redeemed, auto_released,
-- cancelled_by_business, or cancelled_by_customer.
CREATE TABLE IF NOT EXISTS business_orders (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(14,2) NOT NULL,
  pickup_code TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | cancelled
  release_reason TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  -- Set once by the business (POST /api/business/orders/:id/lock) when it
  -- starts fulfilling a still-pending order — closes the gap where a store
  -- preps an order and the customer cancels for a refund before the pickup
  -- code is ever redeemed. Once true, only the business can still cancel
  -- it; the customer's own cancel endpoint refuses. One-way, no unlock.
  locked_by_business BOOLEAN NOT NULL DEFAULT false
);
ALTER TABLE business_orders ENABLE ROW LEVEL SECURITY;

-- What was actually in the cart at checkout — [{productId, name, price,
-- quantity}] as a JSON string, same "structured data as plain TEXT"
-- storage style as keywords/dietary_tags above (no JSONB column type
-- needed just to round-trip this through JSON.stringify/parse in
-- server.js). Null for a generic "pay this amount" checkout with no
-- cart (the amount field predates the cart and still works standalone).
ALTER TABLE business_orders ADD COLUMN IF NOT EXISTS items TEXT;

-- ---------------------------------------------------------------------
-- CJdropshipping-sourced products, alongside the local business directory
-- above. Deliberately NOT a server-side cart/order model of its own —
-- see dropshipping_orders below for why. See dropshipping.js and
-- server.js's "dropshipping" section for how these are used; this feature
-- is off (no products ever get synced, checkout always refuses) until
-- CJ_API_KEY and CJ_ACCOUNT_ID are set as real environment variables —
-- never stored in a database column, unlike an earlier draft of this
-- integration, so a compromised database row can't leak the credential.

CREATE TABLE IF NOT EXISTS dropshipping_products (
  id TEXT PRIMARY KEY,
  cj_product_id TEXT UNIQUE NOT NULL,     -- CJdropshipping's own product id
  name TEXT NOT NULL,
  description TEXT,
  price_usd NUMERIC(14,2) NOT NULL,    -- CJ's price, in USD
  image_url TEXT,
  category TEXT,
  in_stock BOOLEAN NOT NULL DEFAULT true,
  last_synced_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
ALTER TABLE dropshipping_products ENABLE ROW LEVEL SECURITY;

-- Pins each product's Guyanese-dollar price the moment it's synced from CJ,
-- rather than recomputing it from price_usd on every request — so the
-- price a customer sees while browsing is exactly what checkout charges,
-- never a second, possibly-different conversion done at pay time. Only
-- moves the next time this product is re-synced. See USD_TO_GYD_RATE in
-- server.js.
ALTER TABLE dropshipping_products ADD COLUMN IF NOT EXISTS price_gyd NUMERIC(14,2) NOT NULL DEFAULT 0;
-- CJ's package weight for this product, in kilograms — the cart's total
-- weight at checkout decides whether standard or oversized-cargo delivery
-- pricing applies (see DROPSHIP_OVERSIZE_WEIGHT_THRESHOLD_KG in server.js).
-- Unverified against a real CJ account, same caveat as the rest of this
-- integration — see dropshipping.js's file-level comment.
ALTER TABLE dropshipping_products ADD COLUMN IF NOT EXISTS weight_kg DOUBLE PRECISION NOT NULL DEFAULT 0;

-- One row per completed (or attempted) dropshipping checkout. There's
-- deliberately no shopping_carts/cart_items table here — the cart itself
-- stays client-side, in memory, exactly like the local-business product
-- cart in app.js (see the `carts` object there), and only becomes a
-- database row once someone actually pays. `items` holds what was in the
-- cart at checkout, same "JSON as plain TEXT" convention as
-- business_orders.items right above, so both features read the same way.
CREATE TABLE IF NOT EXISTS dropshipping_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cj_order_id TEXT,                       -- set once actually placed with CJ
  -- pending: charged, not yet sent to CJ. placed_with_cj: sent successfully.
  -- shipped / delivered: updated later as tracking info comes in (no
  -- webhook receiver exists yet — see server.js's dropshipping section).
  -- cancelled: checkout failed after charging, and was refunded.
  status TEXT NOT NULL DEFAULT 'pending',
  items TEXT NOT NULL,                    -- [{cjProductId, name, priceUsd, quantity}] as JSON
  total_usd NUMERIC(14,2) NOT NULL,
  total_gyd NUMERIC(14,2) NOT NULL,    -- items only, before the platform fee
  platform_fee_gyd NUMERIC(14,2) NOT NULL DEFAULT 0,
  usd_to_gyd_rate DOUBLE PRECISION NOT NULL, -- rate used at checkout time
  amount_charged_gyd NUMERIC(14,2) NOT NULL, -- total_gyd + platform_fee_gyd + delivery_fee_gyd — what left the buyer's balance
  shipping_address TEXT NOT NULL,         -- {name, phone, address, city, country} as JSON
  tracking_number TEXT,
  created_at TEXT NOT NULL,
  placed_at TEXT,
  resolved_at TEXT
);
ALTER TABLE dropshipping_orders ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_dropshipping_orders_user ON dropshipping_orders(user_id);

-- The flat local-delivery charge for getting an order from the Guyana
-- warehouse to the customer once it's landed — separate from CJ's own
-- international shipping and from platform_fee_gyd. One of two flat
-- amounts (DROPSHIP_STANDARD_DELIVERY_GYD or
-- DROPSHIP_OVERSIZE_DELIVERY_GYD in server.js), by the order's weight, not
-- item count. Stays 0 until the customer actually chooses delivery (see
-- `fulfillment` below) — it's never charged at checkout, since nobody
-- knows yet whether they'll want delivery or to pick the order up
-- themselves; that choice only happens once the order has actually landed.
ALTER TABLE dropshipping_orders ADD COLUMN IF NOT EXISTS delivery_fee_gyd NUMERIC(14,2) NOT NULL DEFAULT 0;

-- Frozen at checkout time (summed from each item's weight × quantity) so
-- the pickup-vs-delivery choice made later — possibly weeks later, once
-- the order has actually arrived — always uses the same weight number the
-- order was bought with, never a re-lookup against products that may have
-- since changed or been removed from the catalog.
ALTER TABLE dropshipping_orders ADD COLUMN IF NOT EXISTS total_weight_kg DOUBLE PRECISION NOT NULL DEFAULT 0;

-- The customer's choice once their order has arrived at the warehouse —
-- 'pickup' or 'delivery', NULL until they've picked one (see
-- POST /api/dropshipping/orders/:id/choose-fulfillment in server.js). This
-- is also what the two codes below and the courier hand-off exist for.
ALTER TABLE dropshipping_orders ADD COLUMN IF NOT EXISTS fulfillment TEXT;

-- Shown to the customer once they choose pickup; shown at the warehouse
-- counter to whoever's collecting the order. A staff member enters it to
-- confirm the handoff (POST /api/staff/dropshipping-orders/:id/redeem-pickup)
-- — same idea as business_orders.pickup_code above, just for the platform's
-- own warehouse instead of a business's counter.
ALTER TABLE dropshipping_orders ADD COLUMN IF NOT EXISTS warehouse_pickup_code TEXT UNIQUE;

-- Shown to the customer once they choose delivery; the customer reads it
-- out to whichever courier shows up at their door. The courier enters it
-- to confirm the handoff (POST /api/courier/deliveries/:id/confirm), which
-- is what actually releases delivery_fee_gyd into that courier's balance —
-- so nobody can claim a delivery, or get paid for one, without the
-- customer's own code confirming it really happened.
ALTER TABLE dropshipping_orders ADD COLUMN IF NOT EXISTS delivery_code TEXT UNIQUE;

-- Set the moment a courier claims this delivery off the open board (see
-- POST /api/courier/deliveries/:id/claim) — first to claim it gets it,
-- nobody is assigned by staff. NULL until claimed.
ALTER TABLE dropshipping_orders ADD COLUMN IF NOT EXISTS courier_id TEXT REFERENCES users(id) ON DELETE SET NULL;

-- Set by staff once the order is physically confirmed to have landed at
-- the warehouse (see POST /api/staff/dropshipping-orders/:id/mark-arrived)
-- — there's no real CJ tracking webhook wired up yet (see dropshipping.js's
-- file comment), so for now this is a manual step, same as sync-products.
-- This is also the moment the customer gets notified their order's ready.
ALTER TABLE dropshipping_orders ADD COLUMN IF NOT EXISTS arrived_at TEXT;

-- Set when a courier claims this delivery (see courier_id above).
ALTER TABLE dropshipping_orders ADD COLUMN IF NOT EXISTS claimed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_dropshipping_orders_courier ON dropshipping_orders(courier_id);

-- ---------------------------------------------------------------------
-- Money is stored as exact decimals (NUMERIC(14,2), i.e. to the cent), not
-- floating point. It used to be DOUBLE PRECISION, where amounts like 0.1 +
-- 0.2 don't add up exactly and balances slowly accumulate rounding error;
-- server.js also rejects amounts with fractions of a cent (positiveAmount).
-- These ALTERs convert an existing project in place, rounding any stored
-- value to the nearest cent; on a fresh project they're no-ops. (Weights and
-- the USD→GYD exchange rate aren't money and stay floating point.)
-- ---------------------------------------------------------------------
ALTER TABLE users ALTER COLUMN gyd_balance TYPE NUMERIC(14,2) USING round(gyd_balance::numeric, 2);
ALTER TABLE users ALTER COLUMN business_gyd_balance TYPE NUMERIC(14,2) USING round(business_gyd_balance::numeric, 2);
ALTER TABLE users ALTER COLUMN courier_gyd_balance TYPE NUMERIC(14,2) USING round(courier_gyd_balance::numeric, 2);
ALTER TABLE transactions ALTER COLUMN amount TYPE NUMERIC(14,2) USING round(amount::numeric, 2);
ALTER TABLE cashout_requests ALTER COLUMN amount_gyd TYPE NUMERIC(14,2) USING round(amount_gyd::numeric, 2);
ALTER TABLE charge_requests ALTER COLUMN amount TYPE NUMERIC(14,2) USING round(amount::numeric, 2);
ALTER TABLE remittances ALTER COLUMN amount TYPE NUMERIC(14,2) USING round(amount::numeric, 2);
ALTER TABLE remittances ALTER COLUMN fee TYPE NUMERIC(14,2) USING round(fee::numeric, 2);
ALTER TABLE business_profiles ALTER COLUMN delivery_fee TYPE NUMERIC(14,2) USING round(delivery_fee::numeric, 2);
ALTER TABLE business_products ALTER COLUMN price TYPE NUMERIC(14,2) USING round(price::numeric, 2);
ALTER TABLE money_requests ALTER COLUMN amount TYPE NUMERIC(14,2) USING round(amount::numeric, 2);
ALTER TABLE business_events ALTER COLUMN ticket_price TYPE NUMERIC(14,2) USING round(ticket_price::numeric, 2);
ALTER TABLE event_tickets ALTER COLUMN price_paid TYPE NUMERIC(14,2) USING round(price_paid::numeric, 2);
ALTER TABLE event_tickets ALTER COLUMN platform_fee TYPE NUMERIC(14,2) USING round(platform_fee::numeric, 2);
ALTER TABLE business_orders ALTER COLUMN amount TYPE NUMERIC(14,2) USING round(amount::numeric, 2);
ALTER TABLE dropshipping_products ALTER COLUMN price_usd TYPE NUMERIC(14,2) USING round(price_usd::numeric, 2);
ALTER TABLE dropshipping_products ALTER COLUMN price_gyd TYPE NUMERIC(14,2) USING round(price_gyd::numeric, 2);
ALTER TABLE dropshipping_orders ALTER COLUMN total_usd TYPE NUMERIC(14,2) USING round(total_usd::numeric, 2);
ALTER TABLE dropshipping_orders ALTER COLUMN total_gyd TYPE NUMERIC(14,2) USING round(total_gyd::numeric, 2);
ALTER TABLE dropshipping_orders ALTER COLUMN platform_fee_gyd TYPE NUMERIC(14,2) USING round(platform_fee_gyd::numeric, 2);
ALTER TABLE dropshipping_orders ALTER COLUMN amount_charged_gyd TYPE NUMERIC(14,2) USING round(amount_charged_gyd::numeric, 2);
ALTER TABLE dropshipping_orders ALTER COLUMN delivery_fee_gyd TYPE NUMERIC(14,2) USING round(delivery_fee_gyd::numeric, 2);

-- Rate-limit counters (see rateLimitPeek/rateLimitRecord in server.js).
-- Kept in the database rather than server memory so limits survive deploys
-- and restarts and are shared by every running instance. reset_at is a Unix
-- time in milliseconds; expired rows are ignored and periodically deleted.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at BIGINT NOT NULL
);
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- purchase_event_tickets: buy tickets as ONE transaction. Locks the event
-- row first (FOR UPDATE), so concurrent purchases of the same event run one
-- at a time; the count of tickets already sold is then read AFTER the lock,
-- so it includes tickets a just-finished purchase inserted. The previous
-- version checked capacity and inserted the tickets in separate statements,
-- so two buyers could both be sold the last seat. Nothing is written until
-- every check has passed, and the tickets are inserted in the same
-- transaction as the payment — an error anywhere (e.g. a ticket-code
-- collision) rolls the whole purchase back.
-- Returns {ok: true, balance, total, fee} or {error: <reason>, ...}.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purchase_event_tickets(
  p_event_id text, p_buyer_id text, p_quantity int, p_codes jsonb, p_fee_rate numeric, p_now text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  ev business_events%ROWTYPE;
  sold int;
  fee_each numeric;
  total numeric;
  total_fee numeric;
  new_balance numeric;
BEGIN
  IF p_quantity < 1 OR jsonb_array_length(p_codes) <> p_quantity THEN
    RETURN jsonb_build_object('error', 'bad_request');
  END IF;
  SELECT * INTO ev FROM business_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF ev.status <> 'active' THEN RETURN jsonb_build_object('error', 'not_active'); END IF;
  IF ev.business_id = p_buyer_id THEN RETURN jsonb_build_object('error', 'own_event'); END IF;

  SELECT count(*) INTO sold FROM event_tickets WHERE event_id = p_event_id AND status <> 'refunded';
  IF ev.capacity IS NOT NULL AND sold + p_quantity > ev.capacity THEN
    RETURN jsonb_build_object('error', 'sold_out', 'remaining', GREATEST(0, ev.capacity - sold));
  END IF;

  fee_each := round(ev.ticket_price * p_fee_rate, 2);
  total := round(ev.ticket_price * p_quantity, 2);
  total_fee := round(fee_each * p_quantity, 2);

  UPDATE users SET gyd_balance = gyd_balance - total
  WHERE id = p_buyer_id AND gyd_balance >= total
  RETURNING gyd_balance INTO new_balance;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'insufficient_funds', 'total', total); END IF;

  UPDATE users SET business_gyd_balance = business_gyd_balance + (total - total_fee) WHERE id = ev.business_id;

  INSERT INTO event_tickets (id, event_id, buyer_user_id, ticket_code, price_paid, platform_fee, status, purchased_at)
  SELECT gen_random_uuid()::text, p_event_id, p_buyer_id, c, ev.ticket_price, fee_each, 'valid', p_now
  FROM jsonb_array_elements_text(p_codes) AS c;

  RETURN jsonb_build_object('ok', true, 'balance', new_balance, 'total', total, 'fee', total_fee);
END;
$$;
REVOKE ALL ON FUNCTION public.purchase_event_tickets(text, text, int, jsonb, numeric, text) FROM PUBLIC;

-- ---------------------------------------------------------------------
-- cancel_event_with_refunds: cancelling an event now refunds every ticket
-- holder in full, as ONE transaction. (Before, cancelling just flipped the
-- event's status: buyers kept worthless tickets and the business kept the
-- money.) Each buyer gets back exactly what they paid; the business wallet
-- gives back what it received for those tickets (price minus the platform
-- fee), and the platform absorbs its own fee. If the business wallet
-- doesn't hold enough to cover that, nothing happens and the event stays
-- active — the business has to contact support rather than leave buyers
-- unpaid. Shares the event-row lock with purchase_event_tickets, so a sale
-- can't slip in between the refunds and the status change.
-- Returns {ok: true, refunded_tickets, refunded_total} or {error: <reason>, ...}.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_event_with_refunds(p_event_id text, p_business_id text, p_now text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  ev business_events%ROWTYPE;
  n_tickets int;
  gross numeric;
  net numeric;
BEGIN
  SELECT * INTO ev FROM business_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF ev.business_id <> p_business_id THEN RETURN jsonb_build_object('error', 'forbidden'); END IF;
  IF ev.status = 'cancelled' THEN RETURN jsonb_build_object('error', 'already_cancelled'); END IF;

  SELECT count(*), COALESCE(sum(price_paid), 0), COALESCE(sum(price_paid - platform_fee), 0)
  INTO n_tickets, gross, net
  FROM event_tickets WHERE event_id = p_event_id AND status <> 'refunded';

  IF net > 0 THEN
    UPDATE users SET business_gyd_balance = business_gyd_balance - net
    WHERE id = ev.business_id AND business_gyd_balance >= net;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', 'insufficient_business_funds', 'needed', net);
    END IF;
  END IF;

  WITH per_buyer AS (
    SELECT buyer_user_id, sum(price_paid) AS refund
    FROM event_tickets WHERE event_id = p_event_id AND status <> 'refunded'
    GROUP BY buyer_user_id
  ), credited AS (
    UPDATE users u SET gyd_balance = u.gyd_balance + pb.refund
    FROM per_buyer pb WHERE u.id = pb.buyer_user_id
    RETURNING u.id
  )
  INSERT INTO transactions (id, type, from_user, to_user, amount, currency, status, note, created_at)
  SELECT gen_random_uuid()::text, 'event_ticket_refund', ev.business_id, pb.buyer_user_id, pb.refund, 'GYD', 'completed',
         'Refund — "' || ev.title || '" was cancelled', p_now
  FROM per_buyer pb;

  UPDATE event_tickets SET status = 'refunded' WHERE event_id = p_event_id AND status <> 'refunded';
  UPDATE business_events SET status = 'cancelled' WHERE id = p_event_id;

  RETURN jsonb_build_object('ok', true, 'refunded_tickets', n_tickets, 'refunded_total', gross);
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_event_with_refunds(text, text, text) FROM PUBLIC;

-- ---------------------------------------------------------------------
-- revoke_courier: take courier access away again (there was previously no
-- way to undo an approval). As ONE transaction it
--   * hands any delivery the courier had claimed but not delivered back to
--     the open board, so the customer's order isn't stuck with them;
--   * moves whatever is in their courier wallet into their personal
--     balance — those are fees they already earned, and once is_courier is
--     false they could no longer reach that wallet themselves;
--   * turns is_courier off and marks their approved application 'revoked'.
-- Returns {ok: true, swept, released} or {error: 'not_a_courier'}.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_courier(p_user_id text, p_staff_id text, p_reason text, p_now text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  swept numeric;
  released int;
BEGIN
  SELECT courier_gyd_balance INTO swept FROM users WHERE id = p_user_id AND is_courier FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_a_courier'); END IF;

  UPDATE dropshipping_orders SET courier_id = NULL, status = 'awaiting_courier', claimed_at = NULL
  WHERE courier_id = p_user_id AND status = 'out_for_delivery';
  GET DIAGNOSTICS released = ROW_COUNT;

  UPDATE users SET is_courier = false, gyd_balance = gyd_balance + courier_gyd_balance, courier_gyd_balance = 0
  WHERE id = p_user_id;

  IF swept > 0 THEN
    INSERT INTO transactions (id, type, from_user, to_user, amount, currency, status, note, created_at)
    VALUES (gen_random_uuid()::text, 'courier_wallet_transfer', NULL, p_user_id, swept, 'GYD', 'completed',
            'Courier access ended — courier wallet moved to personal wallet', p_now);
  END IF;

  UPDATE courier_applications SET status = 'revoked', resolved_at = p_now, resolved_by = p_staff_id,
         staff_note = NULLIF(p_reason, '')
  WHERE user_id = p_user_id AND status = 'approved';

  RETURN jsonb_build_object('ok', true, 'swept', swept, 'released', released);
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_courier(text, text, text, text) FROM PUBLIC;

-- ---------------------------------------------------------------------
-- exec_query: the one function db.js calls for every single query the app
-- makes. It takes a SQL string using Postgres-style $1, $2, ... parameter
-- placeholders (db.js converts server.js's SQLite-style `?` placeholders
-- for you) plus a JSON array of the parameter values, substitutes them in
-- safely using Postgres's own quote_literal() (never string concatenation,
-- so this isn't vulnerable to SQL injection from a parameter value), and
-- returns whatever rows the query produces as a JSON array.
--
-- It's SECURITY DEFINER — it always runs with the privileges of whoever
-- owns it (the account this file is run as, typically the project's
-- built-in postgres role), regardless of which API key called it. That's
-- what lets the app's key both read AND write every table below even
-- though that key's own database role has no direct grants on them.
--
-- Because it runs arbitrary SQL with the owner's privileges, it is granted
-- ONLY to service_role — the role behind the project's SECRET key
-- (sb_secret_... / the legacy service_role key), which must be what
-- SUPABASE_KEY is set to. It used to be granted to anon too, and the README
-- said to use the anon/publishable key; but Supabase designs that key to
-- be public, so anyone who got hold of it could call exec_query directly
-- and read or rewrite the entire database. See the REVOKE at the bottom,
-- which also strips that old grant from an already-deployed project.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exec_query(query text, params jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n int;
  elem jsonb;
  tok text;
  pidx int;
  cursor_pos int := 1;
  start_pos int;
  end_pos int;
  final_query text := '';
  rec RECORD;
  rows_arr jsonb := '[]'::jsonb;
  produces_rows boolean;
BEGIN
  n := jsonb_array_length(params);

  -- Replace $1, $2, ... with their literal values in a SINGLE left-to-right
  -- pass. This is deliberately NOT a regexp_replace over the whole string,
  -- which the earlier version did and which was injectable:
  --   * A global regexp_replace re-scans the ENTIRE (growing) result on each
  --     placeholder, so a value that itself contained the text "$2" would be
  --     re-expanded on the $2 pass. Every value was quoted, but an
  --     attacker-controlled value (a username, memo, business name, ...)
  --     could smuggle another placeholder's expansion into an UNquoted spot,
  --     concatenating one column's contents into another and exfiltrating or
  --     overwriting arbitrary rows.
  --   * regexp_replace's replacement string also interprets \1..\9 / \& as
  --     backreferences, so a value containing a backslash-digit could inject.
  -- Here we only ever read from the ORIGINAL `query`: copy the text between
  -- placeholders verbatim, then append a safely-built literal token. The
  -- output buffer is never re-parsed for placeholders, so no value can ever
  -- introduce a new one. Numbers/booleans are emitted unquoted (their jsonb
  -- lexical form is already safe); everything else goes through quote_literal
  -- (NULL handled explicitly), preserving the exact quoting and type
  -- coercion the rest of the app already relies on.
  LOOP
    start_pos := regexp_instr(query, '\$\d+', cursor_pos);
    EXIT WHEN start_pos = 0;
    end_pos := regexp_instr(query, '\$\d+', cursor_pos, 1, 1); -- position just past the match
    pidx := substring(query FROM start_pos + 1 FOR end_pos - start_pos - 1)::int;
    IF pidx < 1 OR pidx > n THEN
      RAISE EXCEPTION 'parameter $% is out of range (got % params)', pidx, n;
    END IF;
    elem := params -> (pidx - 1);
    IF elem IS NULL OR jsonb_typeof(elem) = 'null' THEN
      tok := 'NULL';
    ELSIF jsonb_typeof(elem) = 'number' THEN
      tok := elem::text;
    ELSIF jsonb_typeof(elem) = 'boolean' THEN
      tok := elem::text;
    ELSE
      tok := quote_literal(elem #>> '{}');
    END IF;
    final_query := final_query || substring(query FROM cursor_pos FOR start_pos - cursor_pos) || tok;
    cursor_pos := end_pos;
  END LOOP;
  final_query := final_query || substring(query FROM cursor_pos);

  -- A plain write with no RETURNING (e.g. a bare UPDATE) produces no result
  -- set at all — trying to iterate it would error — so it's just executed
  -- directly. Everything else (a SELECT, or a write with RETURNING —
  -- including a whole WITH ... chain of writable CTEs, which is how
  -- server.js does an atomic "debit + credit + status update" in one
  -- statement) is iterated row by row into a jsonb array. Looping a cursor
  -- like this (rather than wrapping the query in another SELECT) is what
  -- lets a query that already starts with its own WITH work here too —
  -- Postgres doesn't allow nesting a writable CTE inside another CTE.
  produces_rows := final_query ~* '^\s*(with|select)\y' OR final_query ~* '\yreturning\y';

  IF produces_rows THEN
    FOR rec IN EXECUTE final_query LOOP
      rows_arr := rows_arr || to_jsonb(rec);
    END LOOP;
  ELSE
    EXECUTE final_query;
  END IF;

  RETURN jsonb_build_object('rows', rows_arr);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('error', SQLERRM, 'code', SQLSTATE);
END;
$$;

-- IMPORTANT when upgrading an existing deployment: switch SUPABASE_KEY to
-- the secret key BEFORE re-running this file, or the running app loses
-- database access the moment the REVOKE below executes. See the upgrade
-- order in README.md ("Deployment settings added in the security update").
REVOKE ALL ON FUNCTION public.exec_query(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.exec_query(text, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.exec_query(text, jsonb) TO service_role;
