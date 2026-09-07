// SQLite persistence using Node's built-in node:sqlite module (Node 22.5+).
// No external database or npm dependency required.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// DATA_DIR can be overridden by an env var so a host with a persistent disk
// (e.g. Render, mounted at /var/data) can point the database somewhere that
// survives restarts/deploys — see render.yaml. Left unset, it defaults to a
// local ./data folder next to the code, same as always.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'app.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
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
  cashtag TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  is_business INTEGER NOT NULL DEFAULT 0,
  business_name TEXT,
  gyd_balance REAL NOT NULL DEFAULT 0,
  business_gyd_balance REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  from_user TEXT,
  to_user TEXT,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cashout_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount_gyd REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
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
  amount REAL NOT NULL,
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

-- A MoneyGram-style remittance: the sender pays an amount plus a fee up
-- front (escrowed out of their balance immediately), gets back a reference
-- code, and hands that code to the recipient out of band (text, call, in
-- person). The recipient — who does not need to already have an account —
-- "picks up" the transfer by entering the reference code and the recipient
-- name the sender typed in, the same two pieces of information a real
-- money-transfer pickup asks for.
CREATE TABLE IF NOT EXISTS remittances (
  id TEXT PRIMARY KEY,
  reference_code TEXT UNIQUE NOT NULL,
  from_user TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  recipient_phone TEXT NOT NULL,
  amount REAL NOT NULL,
  fee REAL NOT NULL,
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
-- the one arranging the delivery) — unlike Send Money's fee above, which the
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
  delivery_fee REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
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
  price REAL NOT NULL,
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
  amount REAL NOT NULL,
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
  ticket_price REAL NOT NULL,
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
-- account (same "the platform just keeps it" treatment as Send Money's fee).
CREATE TABLE IF NOT EXISTS event_tickets (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  buyer_user_id TEXT NOT NULL,
  ticket_code TEXT UNIQUE NOT NULL,
  price_paid REAL NOT NULL,
  platform_fee REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'valid', -- valid | checked_in
  purchased_at TEXT NOT NULL,
  checked_in_at TEXT
);

`);

module.exports = db;
