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
  gyd_balance DOUBLE PRECISION NOT NULL DEFAULT 0,
  business_gyd_balance DOUBLE PRECISION NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  from_user TEXT,
  to_user TEXT,
  amount DOUBLE PRECISION NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cashout_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount_gyd DOUBLE PRECISION NOT NULL,
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
  amount DOUBLE PRECISION NOT NULL,
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
  amount DOUBLE PRECISION NOT NULL,
  fee DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | cancelled
  claimed_by_user_id TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT
);

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
  delivery_fee DOUBLE PRECISION NOT NULL DEFAULT 0,
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
  price DOUBLE PRECISION NOT NULL,
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
  amount DOUBLE PRECISION NOT NULL,
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
  ticket_price DOUBLE PRECISION NOT NULL,
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
  price_paid DOUBLE PRECISION NOT NULL,
  platform_fee DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'valid', -- valid | checked_in
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
-- what lets the app's anon/publishable key both read AND write every
-- table below even though that key's own database role has no direct
-- grants on them — see the GRANT at the bottom, and README.md's "How the
-- database works" for why that's an intentional, contained trade-off
-- (the anon key here is used only server-side, from db.js, and must never
-- be sent to a browser).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exec_query(query text, params jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  i int;
  n int;
  elem jsonb;
  lit text;
  final_query text := query;
  rec RECORD;
  rows_arr jsonb := '[]'::jsonb;
  produces_rows boolean;
BEGIN
  n := jsonb_array_length(params);
  -- Substitute highest-numbered placeholder first so replacing $1 doesn't
  -- also clobber the "$1" inside "$10", "$11", etc.
  FOR i IN REVERSE n..1 LOOP
    elem := params -> (i-1);
    IF elem IS NULL OR jsonb_typeof(elem) = 'null' THEN
      lit := 'NULL';
    ELSIF jsonb_typeof(elem) = 'number' THEN
      lit := elem::text;
    ELSIF jsonb_typeof(elem) = 'boolean' THEN
      lit := elem::text;
    ELSE
      lit := quote_literal(elem #>> '{}');
    END IF;
    final_query := regexp_replace(final_query, '\$' || i::text || '(?!\d)', lit, 'g');
  END LOOP;

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

REVOKE ALL ON FUNCTION public.exec_query(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exec_query(text, jsonb) TO anon, authenticated, service_role;
