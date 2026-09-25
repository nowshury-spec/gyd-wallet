# GYD Wallet — Phase 1 Prototype

A working prototype of the app concept: a wallet denominated directly in
Guyana dollars (GYD) funded by (simulated) real money, free-to-play games,
a cash-out flow, fast peer-to-peer payments (unique $Paytag handles, instant
pay-a-username transfers, and a Request Money flow), GYD Direct — our own
send-to-anyone feature with a private reference code — a business payment
portal, and person-to-person messaging.

An earlier version of this prototype used an abstract "token" as the
real-money-equivalent unit instead of GYD directly. That's been removed —
there is now exactly one real-money balance (GYD), and it's never touched
by either game. An even earlier version of the games ran on a separate
"coins" currency bought with GYD; that's been removed too — see **Why the
games are free to play** below for why there's no in-game currency at all
anymore.

This is **Phase 1** from the business plan: it proves out the full product
experience without touching real money or requiring any license. Nothing
here is connected to a real bank, card processor, or payment rail.

The look is deliberately built to feel like something you'd want to open and
play with — a dark, indigo-accented, phone-shaped app shell with a bottom
icon bar (complete with an elevated "Play" button), a big animated coin
flip, and a confetti burst on a win — rather than a business dashboard.

## Running it

Requires **Node.js 18 or later** (uses the built-in `fetch()` — no `npm
install` needed, no external dependencies at all) and a free
[Supabase](https://supabase.com) Postgres project for storage (see
**Deploying this** below) — set two environment variables before starting
it:

```
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_KEY=<your project's SECRET key (sb_secret_... or the legacy service_role key)>
node server.js
```

Then open **http://localhost:3000** in a browser. Create a couple of
accounts (one as a business, to try the payment portal) and try the
features against each other.

## Deploying this (Render + Supabase)

This repo includes a `render.yaml` blueprint for [Render](https://render.com), since it's a good fit for a plain, persistent Node.js server like this one (no build step, and Render will run `node server.js` directly):

1. Push this repo to GitHub (or GitLab).
2. In Render, create a new **Blueprint** and point it at the repo — it reads `render.yaml` and sets up the web service automatically, starting on the free plan.
3. Create a free project at [supabase.com](https://supabase.com), run `supabase/schema.sql` against it (SQL Editor → paste → Run) to create the tables and the `exec_query` function the app talks to, then set `SUPABASE_URL` and `SUPABASE_KEY` (its Project URL and its **secret** key — `sb_secret_...`, or the legacy `service_role` key — from Project Settings → API; never the anon/publishable key, see **How the database works**) as environment variables on the Render service.
4. Render gives you a live `https://<something>.onrender.com` URL once the first deploy finishes.

**Why Supabase instead of a Render disk**: Render's free web services don't get a persistent disk, so anything written to the container's own filesystem resets on every redeploy or the free plan's auto-sleep-and-wake cycle. Rather than paying for a Render disk, the database lives in a separate free Supabase Postgres project instead — see **How the database works** below for how the app talks to it without adding any npm dependency.

## How the database works

The app used to store everything in a local SQLite file (via Node's
built-in `node:sqlite` module) — simple, but Render's free plan has nowhere
persistent to put that file (see above). It now stores everything in a
Supabase Postgres project instead, reached with Node's built-in `fetch()`
rather than a database driver package, so the project still has zero npm
dependencies. `supabase/schema.sql` creates the tables plus one Postgres
function, `exec_query(query, params)`, that takes a SQL string and a JSON
array of parameters and returns the matching rows as JSON; `db.js` calls
that function over Supabase's REST API for every query the app makes,
converting the `?` placeholders used throughout `server.js` into Postgres's
`$1, $2, ...` automatically.

`exec_query` can read and write every table regardless of row-level
permissions, so it is granted **only** to Supabase's `service_role` — the
role behind the project's **secret** key. `SUPABASE_KEY` must be that
secret key (`sb_secret_...`, or the legacy `service_role` key), kept
server-side only. It must never be the anon/publishable key: Supabase
designs that key to be public, and an earlier version of this schema
granted `exec_query` to it, which meant anyone holding it could run any SQL
against the whole database.

**Upgrading an existing deployment:** set `SUPABASE_KEY` to the secret key
on Render (and redeploy) *first*, and only then re-run
`supabase/schema.sql` — it revokes the old anon grant, so doing it the
other way round cuts the running app off from its database.

Because every query is now a real network call instead of a synchronous
local read, a few money-moving actions (send money, pay a request, buy an
event ticket, and so on) that used to be safe by virtue of Node running
everything for one request synchronously are now written as single
Postgres statements that check-and-update balances atomically (see the
comments around `db.atomicTransfer` in `db.js` and the `WITH ... RETURNING`
queries in `server.js`) — this closes the same double-spend race a real
payments backend has to worry about once more than one request can be in
flight against the same account at once.

## What's actually implemented

- **Accounts** — register/log in, personal or business account type, sessions via a signed token (stored in the browser's local storage).
- **Wallet** — "deposit" GYD (simulated — no payment processor is wired up), and a cash-out flow that escrows GYD and files a pending request.
- **Games** — a coin-flip game, a 3-reel slot machine, and a head-to-head Ludo board game, all completely free to play: no wager, no cost, no balance requirement, open to any logged-in user (see **Why the games are free to play** below).
- **Ludo** — a real 2- or 4-player board game played turn-by-turn against other people (not the house), reached from the Games tab: create a table (choosing 2 or 4 seats) or join someone else's open one from the lobby, and the match starts the moment the last seat fills. Roll the dice, tap a highlighted piece to move it, race all 4 of your pieces around the board and home before anyone else — landing on an opponent outside a safe square sends their piece back to base, and rolling a 6, capturing, or getting a piece home all earn another roll. See **How Ludo works** below for the exact rules and why it has no wager either.
- **$Paytag handles** — every account gets a unique, auto-generated `$paytag` at signup (edit it any time from the Wallet tab), separate from the login username. Anywhere you'd type a username — sending, requesting, searching, QR pay — a `$paytag` (with or without the leading `$`) works too, so a sender can use whichever one they actually know.
- **Pay or request in a tap** — one screen does both: a big amount display driven by a numeric keypad (cents-first entry — typing 2-5-0-0 builds "$25.00"), a single "To" field for a username or $paytag, and a Pay/Request button pair that only enable once both an amount and a recipient are set. Pay sends an instant, no-fee transfer to another user who already has an account here; Request asks them to pay you that amount, with an optional note — they see it as a pending request they can pay (debiting their balance, crediting yours) or decline, and you can cancel a request you sent as long as it's still pending.
- **GYD Direct** — our own send-to-anyone transfer feature: send GYD to anyone by name and phone number, no account required on their end, for a transfer fee (see **How GYD Direct pricing works** below). You get back a private reference code; the recipient enters that code plus the recipient name you typed to claim it into their own balance, registering for an account first if they don't have one. With real SMS delivery configured (see **Setting up real SMS delivery**), the code is also texted straight to the recipient's phone instead of relying on the sender to share it themselves. A pending transfer can be cancelled by the sender for a full refund (amount + fee) any time before it's claimed.
- **QR code pay ("Scan & Pay" tab)** — every account has a personal QR code encoding `gydpay:pay?to=$paytag` (optionally with a fixed amount/memo baked in, so a business can generate a "charge code" for a specific bill). Scanning someone's code — via the device camera, by uploading a photo of it, or by pasting the code manually — opens a confirm screen (editable amount/memo) and pays them through the same transfer endpoint used elsewhere. See **How QR pay actually works** below before relying on this for a real demo.
- **Business directory ("Find a business")** — a business account can set up a public page (category, tagline, description, freeform keywords for what they sell, a logo emoji, a page color, phone/location) from the Business tab. Once saved, that page is searchable by anyone: free-text search matches the business name, tagline, description, category, keywords, AND their listed products — so searching "cake" finds every business that listed "cake" as a keyword or a product name, even if their category is just "Bakery & Desserts" and their name doesn't mention cake — plus a category dropdown to browse by type. Opening a result shows the full page with a **Products & prices** list and **Message** (opens a conversation with that business) and **Pay** (opens the inline checkout described below) buttons. A business account with no page saved yet simply doesn't appear in the directory — having a business account and having a page are separate steps.
- **Products & prices** — from the same "Your business page" area, a business can list individual products or services with a name, a price in GYD, and an optional description — shown on their public page as a simple menu/catalog, and folded into directory search the same way keywords are (searching a product name finds the business even if that exact phrase never made it into the keywords field). This is purely informational — it doesn't create a way to buy a specific line item; the amount is still typed in at checkout, same as reading a menu before telling the cashier what you owe.
- **Ratings & reviews** — any customer viewing a business's page can leave a 1–5 star rating with an optional comment; the directory listing and the business's own page both show the average rating and how many reviews it's based on. Rating again just updates your existing review instead of adding a second one (one rating per customer per business), and you can remove your own rating at any time. A business can't rate its own page. A "Report" button on each review lets a viewer flag one for staff — see **How the staff portal works** for what happens after that.
- **Checkout with pickup or delivery** — a business can flag "I offer delivery" on their business page and set a delivery fee (0 means free delivery). When a customer pays that business through the directory's Pay button, they get an inline checkout — no tab-jump — where they type an amount and, if the business offers delivery, choose **Pickup** (no fee, no address) or **Delivery** (their delivery fee is added to the total and a delivery address is required). See **How checkout and delivery pricing work** below for how the fee is handled.
- **Product photos** — a business can attach a photo to any product/price listing (from the "Products & prices" area), shown as a small thumbnail next to it — on their own editor and on the public business page. Photos are resized and compressed in the browser before upload (there's no real file-storage backend in this prototype — see **How product photos are stored** below), so no camera/photo library integration is needed beyond the browser's own file picker.
- **Two separate wallets for a business account** — a business account has its own GYD balance for personal spending (deposits, cashing out, sending money — same as anyone) **plus** a second, separate business balance that only fills up from customers paying the business. See **How the business wallet works** below for exactly which payments go where and how a business gets its earnings into its personal balance.
- **Business payment portal** — a business account can send a customer a charge request; the customer approves or declines it from their own account, and approved charges move GYD to the business balance. (Paying a business by scanning their QR code, or through the directory's Pay button, are the other customer-initiated ways to pay them — no approval step needed there, same as tapping to pay in person.)
- **Messaging** — direct text conversations between any two users.
- **Events & ticket sales** — from the "Events & tickets" area of the Business tab, a business can post an event (title, description, location, date, ticket price, and an optional capacity) that shows up right on their public business page. Anyone can buy one or more tickets there and pay through the app; each ticket gets its own unique code and QR image (found under the "My tickets" button on the Business tab), and the business scans or types that code in at the door to check someone in. See **How events & tickets work** below for the fee math and how check-in behaves on a repeat scan.
- **Job board** — from the "Jobs" area of the Business tab, a business can post an opening (title, description, and optionally a location, pay, and job type — Full-time, Part-time, Contract, or Temporary). It shows up both on the business's own page and in the site-wide **Jobs** board (the 💼 button next to "My tickets" on the Business tab), which anyone can search or filter by job type. There's no separate application system — an "Apply" button just opens a message thread with the business through the existing messaging feature, pre-filled with a short interest note the applicant can edit before sending. A business can close a listing (comes down from both places, but the posting itself isn't lost) or delete it outright.
- **Help & Support (customer-facing)** — the 🛟 button in the app header opens a "Contact support" form. A customer's request becomes a support ticket a staff member answers from the staff portal below; the reply shows up back in the customer's own "Your requests" list on the same screen. No live back-and-forth thread yet — one message in, one staff reply out.
- **Log out of all devices** — under "Account security" in the same Help & Support panel, in case a phone is lost or a shared device is a worry. See **Session revocation** under **How the staff portal works** for how this works without the app tracking individual sessions.
- **Staff portal** — a completely separate employee sign-in at `/staff.html`, for staff to handle two queues: open support tickets and stuck cash-out requests (see **How the staff portal works** below for why these needed a human). See that section for how to create the first staff login.

## How QR pay actually works (read this before demoing it)

Two separate browser features are doing the work, and each has a real limitation worth knowing about:

**Generating the QR image** — the "Your code" panel doesn't draw the QR code itself; it asks a free public image service (`api.qrserver.com`) to render one, from the *user's own browser*, not from this server. That means: (1) it needs a normal internet connection to display, (2) the payload — a username and, if you set one, an amount/memo — is sent to that third-party service, which is fine for a demo but worth replacing with a self-hosted QR library (e.g. vendor a small library like `qrcode-generator`) before this goes anywhere near real users or real amounts, and (3) if you ever see a broken image icon where the QR should be, it's almost always that connection, not a bug — the raw payload text is always shown underneath as a fallback, and the "Copy code" button copies it.

**Scanning** — this uses the browser's native `BarcodeDetector` API (no library needed), which is well supported in Chrome/Edge/Android but not in Safari/iOS as of this writing. Two fallbacks are built in for that: uploading a photo of a QR code (still uses `BarcodeDetector`, just against an image instead of live video), and pasting the raw code — or just typing a username — into the manual field. The manual field is also the easiest way to test the whole flow yourself without any camera at all: open one browser tab as user A, copy their code from "Your code", switch to a second tab logged in as user B, and paste it into "Or paste a code" on the Scan tab.

**One real gotcha for camera scanning specifically**: browsers only allow camera access (`getUserMedia`) on `localhost` or over HTTPS — never over plain HTTP, even on your local network. So two phones both hitting `http://<your-laptop's-IP>:3000` over Wi-Fi will NOT be able to open the camera, even though the rest of the app works fine that way. To actually test camera-to-camera scanning between two devices, put this behind HTTPS (a reverse proxy, a tunnel like ngrok, or a real deployment) — testing on one machine with two browser tabs and the manual-paste fallback is the quickest way to verify the payment logic itself works without dealing with that.

## How the slot machine's odds work

The slot machine spins three reels, each drawn independently from the same
weighted table of four symbols, and only counts as a win on an exact
three-of-a-kind — the rarer the symbol, the bigger the on-screen "Nice! /
Great! / Awesome! / JACKPOT!" label:

| Symbol | Weight | Label (3 of a kind) | Chance of that symbol landing all 3 reels |
| --- | --- | --- | --- |
| 🍒 | 55 | Nice! | ~16.6% |
| 🍋 | 28 | Great! | ~2.2% |
| 🔔 | 12 | Awesome! | ~0.17% |
| 💎 (jackpot) | 5 | JACKPOT! | ~0.01% |

That works out to roughly a **1-in-5 spin landing a win** (~19% hit rate).
Nothing is wagered and nothing is paid out — a win is purely a label and a
line in your game history, kept rare on purpose (the 💎💎💎 jackpot is about
1 in 10,000 spins) so it still feels special even though nothing of value
changes hands. These odds were checked two ways: worked out analytically
from the weights above, and confirmed against a 15,000-spin live simulation
against the running server (actual hit rate 19.38%, in line with the ~19%
target).

Like the coin flip, this game never touches GYD or any other balance — see
**Why the games are free to play** below.

## How Ludo works

Unlike the coin flip and the slot machine, Ludo isn't a house game — it's a
real-time match between actual people, so it needs matchmaking on top of
the game itself:

- **Tables** — from the Games tab, "Play Ludo" opens a small lobby: create
  a table (2 or 4 seats) or join one of the open tables other people have
  started. A table starts the instant its last seat fills — there's no
  separate "ready up" step. The host can cancel a table while it's still
  waiting for players; once it's full and playing, it runs to a finish.
- **The board** — a standard-shape Ludo board: four 6×6 colored corners
  (red, green, gold, blue) for each seat's 4 pieces to start in, connected
  by a shared 52-square outer track, with each color's own private 6-square
  "home stretch" leading into the center. A 2-player table seats red and
  blue, in opposite corners; a 4-player table seats all four colors.
- **Turns** — roll the dice, then tap whichever highlighted piece you want
  to move with that roll (the app only highlights pieces that can legally
  move — a piece sitting at base needs a 6 to come out, and a piece can't
  move past the finish line, it has to land on it exactly). Landing on an
  opponent's piece sends it back to base, unless it's sitting on one of the
  8 marked safe squares (each color's own entry square, plus one "star"
  square further around the board). Rolling a 6, capturing an opponent, or
  getting a piece all the way home each earn another roll — but three 6s in
  a row forfeits the turn immediately, the classic anti-stalling rule, so
  one lucky streak can't hog the board forever. First player to get all 4
  pieces home wins the match.
- **No wager** — same as the other two games, nothing of value is staked.
  An earlier version of this feature let players wager GYD/coins into a
  pot the winner took, which is exactly the kind of peer-to-peer betting
  that makes a game like this a much bigger legal question than a house
  game with a one-way currency ever was (see **Why the games are free to
  play** below) — so wagering was removed entirely rather than carried
  forward. Winning a match here is genuinely just bragging rights.
- **Live updates** — while a table is open, the app polls it every couple
  of seconds so you see your opponent's rolls and moves without refreshing.
  There's no reconnect/resume story beyond that in this prototype — if
  everyone just closes the tab mid-match, the table simply sits unfinished.

## How GYD Direct pricing works

A GYD Direct transfer charges a fee on top of the amount sent, using
a flat-minimum-plus-percentage formula: **the greater of GYD 200 or 2.5% of
the amount**, deducted from the sender's balance immediately along with the
amount itself (so sending GYD 10,000 actually holds GYD 10,250 — the sender
sees both numbers, and the total, before confirming). That mirrors how real
remittance pricing tends to work: a flat minimum keeps small transfers from
being effectively free, while the percentage keeps large transfers roughly
proportional. These exact numbers are illustrative for a demo, not a
researched real-world rate — a real build would price this per corridor and
payout method, the same way actual remittance services do. The fee is kept
back rather than paid to anyone, the same "house keeps it" idea as the slot
machine's edge or Guyana Gaming Authority's casino rake, just applied to a
payments product instead of a game.

## How checkout and delivery pricing work

Checkout is the same underlying GYD transfer used everywhere else — it just
asks one extra question when the business supports delivery. Pickup charges
exactly the amount typed in, no fee, no address. Delivery adds the
business's own delivery fee to that amount and requires a delivery address
before it will submit. The important difference from GYD Direct's fee: the
delivery fee is credited **to the business**, not kept by the platform —
because the business is the one who has to arrange getting the order there,
the same way a restaurant (not the app) keeps a delivery charge on a food
order. That means a GYD 3,000 order with a GYD 500 delivery fee charges the
customer GYD 3,500 and credits the business the full GYD 3,500, not GYD
3,000. A business that hasn't turned delivery on simply doesn't offer the
option — checkout only shows Pickup, and trying to force delivery through
the API is rejected the same as any other invalid request.

## How events & tickets work

A business's page can list events the same way it lists products — but
instead of describing something to ask the cashier about, an event is
something a customer buys straight through the app:

- **Posting an event** — from the "Events & tickets" area of the Business
  tab, a business fills in a title, an optional description and location, a
  date, a ticket price, and an optional capacity (leave it blank for
  unlimited tickets). It shows up immediately in the "Events" section of
  their public page, right below their product list, as long as it's
  active — cancelling an event (see below) or selling out hides it from new
  buyers without touching anyone who already has a ticket.
- **Buying tickets** — a customer picks a quantity (1 to 10 per purchase)
  and taps "Buy ticket(s)". This charges their GYD balance exactly
  `ticket price × quantity` — there's no separate "add to cart" step, and a
  customer can't buy a ticket to their own event. If a capacity is set,
  a purchase that would oversell the event is rejected with however many
  tickets are actually left, and once every ticket is sold the event shows
  as "sold out" and stops accepting new purchases entirely.
- **The platform's 3.5% cut** — of every ticket sold, the platform keeps
  3.5% of the *ticket price*, taken out of what the business receives
  rather than added on top of what the customer pays. A GYD 4,000 ticket
  always costs the buyer exactly GYD 4,000; the business's wallet is
  credited GYD 3,860 (4,000 minus the GYD 140 fee), and the fee itself
  isn't credited to any account — the same "the platform just keeps it"
  treatment as GYD Direct's transfer fee, just at a different rate. Buying
  multiple tickets in one purchase multiplies straight through: 3 tickets
  at GYD 4,000 each charges GYD 12,000 and credits the business GYD
  11,580. Ticket revenue lands in the business's **business** wallet, the
  same balance customer payments always land in — see **How the business
  wallet works** below.
- **The ticket QR code** — every purchased ticket gets its own short,
  unique code, found (along with a scannable QR image of it) under the
  "My tickets" button on the Business tab. That QR image is generated the
  same third-party-service way as the existing "Scan & Pay" QR codes — see
  **How QR pay actually works** above for what that means and its one real
  limitation (it needs the buyer's own device to have a normal internet
  connection to render; the raw code is always shown as text underneath as
  a fallback either way).
- **Checking a ticket in** — a business coordinator checks tickets in from
  the "Check a ticket in" panel right below their event list: type the code
  in by hand, or tap "Scan" to use the device camera (the same
  `BarcodeDetector`-based scanning already used for Scan & Pay, with the
  same browser-support caveat — see **How QR pay actually works** above).
  A valid, not-yet-used ticket flips to "checked in" and shows the buyer's
  username; scanning the *same* ticket again isn't treated as an error —
  it's reported as "Already Checked In" along with when it was first
  checked in, so a coordinator re-scanning by accident (or someone trying
  to reuse a ticket) gets a clear, calm answer either way rather than a
  confusing failure message.
- **Cancelling vs. deleting** — cancelling an event stops new ticket sales
  but leaves every already-sold ticket exactly as valid as it was (someone
  who already paid keeps their ticket even if the event can't sell any
  more). Deleting an event removes it outright, but only while it has zero
  tickets sold — once even one ticket has been bought, cancel is the only
  option, so a paying customer's ticket can never simply disappear.

## How the business wallet works

A business account actually has two GYD balances under the hood, even though the app only ever calls the everyday one "your balance": a personal one (used for deposits, cashing out, and sending money — exactly like a personal account) and a separate business balance that only a business account has any use for. The business balance is what fills up when a customer pays the business — a plain transfer or QR-code pay to their $paytag, business checkout, an approved charge request from the payment portal, or a money request the business itself sent out to be paid. None of those touch the owner's personal balance at all.

That split is deliberate: it keeps the business's takings visibly separate from the owner's own spending money, the same reason a shop keeps a till separate from the owner's wallet. To actually spend or cash out what the business has earned, the owner uses **Move to personal wallet** on their business wallet panel — an instant, no-fee internal transfer from the business balance into their personal one. There's no path the other direction (personal money funding the business wallet) since nothing here needs it — the business wallet only ever fills from customer payments. One deliberate exception: a GYD Direct claim always lands in the personal wallet, even for a business account, since claiming a transfer sent to you by name and phone isn't "a customer buying something" — it's just picking up money addressed to you personally.

One simplification worth knowing: the "Recent activity" list on the Wallet tab is a single combined ledger of everything that ever happened to the account, personal and business alike — it doesn't split into two separate activity feeds per wallet. A real build might want that split; this prototype keeps one list for simplicity.

## How the staff portal works

The staff portal lives at `/staff.html` (e.g. `https://gyd-wallet.onrender.com/staff.html`) and is completely separate from the customer app — a customer account, even a business one, has no access there, and a staff login has no access to the customer app either (see auth.js's `makeStaffSessionToken` and server.js's `requireStaffAuth`). There's no self-signup: the very first staff account has to be created directly against the database (see below), after which an **owner**-level staff member can create more from the portal's **Employees** tab.

Logging in takes two steps: username + password, then a 6-digit verification code (`POST /api/staff/login` then `/api/staff/login/verify-code`, backed by the `staff_login_codes` table), delivered to the staff member's email or phone on file — email first if both are on file, SMS as the fallback (see **Setting up real email delivery** and **Setting up real SMS delivery** below). With no way to deliver the code — no email/phone on file, or delivery not configured — login is refused rather than falling back to showing it on screen, unless `SHOW_CODES_ON_SCREEN=true` is set (demo/dev only; see **Setting up real email delivery**). Add your own email and/or phone from the portal's **Employees** tab ("My email" / "My phone") before that's turned off, or you'll lock yourself out.

It has two working queues, each closing a real gap that existed before it:

- **Support** — every ticket a customer submits through the app's "Contact support" form (see the Help & Support bullet above), open ones first. Replying can also mark a ticket resolved in the same action; the reply shows up back in the customer's own "Your requests" list.
- **Cash-outs** — before this existed, a cash-out request (see **What's actually implemented**) had no way to ever move past "pending": the GYD was escrowed out of the customer's balance the moment they asked, but nothing could ever mark the request handled. "Mark paid" is for after a staff member has actually paid the customer outside the app (there's still no licensed payout integration — see **Why no npm packages**); "Reject & refund" puts the escrowed GYD back into the customer's balance instead, for a request that can't be honored.

A business page or job posting used to start out `pending` and need a staff approval here before it went public; that gate has been removed — every page and posting is visible immediately on creation. The `review_status` column is still there on both tables (always `'approved'` now) so nothing else needed to change.

**Fraud/theft controls.** These keep an employee from quietly abusing the access above, or limit the damage if a staff (or customer) login is ever stolen — all enforced server-side, not just hidden in the UI:

- **Owner vs. employee roles** (`staff_accounts.role`) — only an owner-level account can create another staff login (`requireStaffOwner` in server.js) or view the audit log below. A regular employee can work every queue above but can't grant anyone else access, including themselves a second account.
- **A permanent audit log** (`staff_audit_log`, visible under the portal's **Audit log** tab, owner-only) — every cash-out marked paid or rejected, every new staff account created, and every forced sign-out (see below) is recorded with exactly who did it and when. Nothing in the app ever updates or deletes a log entry, so it's a trustworthy record an owner can check, not something an employee could tidy up after themselves.
- **A real password requirement for staff accounts** (`validateStaffPassword` in server.js) — at least 10 characters with a mix of letters and numbers, and never the same as the account's own username. This exists because the very first account created here originally used its username as its password; new accounts can't do that anymore.
- **Session revocation.** Login tokens are normally valid for 7 days with no way to invalidate one early — a real gap if a device is lost or an account is compromised. Every account (customer and staff) can sign itself out of every device at once (**Account security** in the customer app; the **Log out everywhere** button in the staff header), and an owner can additionally force any specific employee's sessions to end immediately — no password reset required — with a **Sign out everywhere** button next to their name on the **Employees** tab. See `sessions_invalidated_at` in `supabase/schema.sql` for how this works without the app needing to track individual sessions.
- **Real-time fraud alerts.** There's no scheduled job anywhere in this app (Render's free tier can spin down, which would make a `setInterval`-based digest unreliable), so this check runs inline instead: every time a staff member marks a cash-out paid or rejected, the app counts how many of those two actions that same staff member has logged in the last 15 minutes (`staff_audit_log`), and if that hits 5, it emails every owner who has an email on file (see **Setting up real email delivery**) — throttled to once per hour per staff member so it can't spam an owner's inbox. This is a heads-up, not an accusation — a busy shift or a backlog getting cleared can trigger it too — but it means unusual activity gets surfaced immediately instead of only being discoverable by someone thinking to check the audit log. See `maybeSendFraudAlert` in `server.js`.
- **Review reporting & moderation.** The "Report" button on a business review (see **Ratings & reviews** above) doesn't take the review down itself — it creates a normal support ticket (reusing the existing **Support** queue, so no separate moderation UI was needed) with the reviewer, rating, comment, and the reporter's optional reason, plus a hidden `Review ID` the portal recognizes. A ticket created this way shows a **Remove this review** button; clicking it permanently deletes the review and logs a `review_removed` entry to the audit log. Reporting never hides a review by itself — a staff member always looks at it first — so this can't be used to unilaterally silence an honest bad review.

**Creating the first staff account.** Since there's no self-signup, insert one directly against the Supabase project (SQL Editor, or the equivalent `exec_query` call) as `role = 'owner'` — hash the password the same way `auth.js`'s `hashPassword` does, or just run this from a Node shell that has this project's `auth.js` on its path. This bypasses `validateStaffPassword` (it only runs on the `POST /api/staff/accounts` route), so pick a real password by hand — at least 10 characters, a mix of letters and numbers, and not the same as the username:

```js
const { hashPassword } = require('./auth');
const crypto = require('crypto');
const { salt, hash } = hashPassword('choose-a-real-password-here');
console.log(crypto.randomUUID(), hash, salt); // paste these into the INSERT below
```

```sql
INSERT INTO staff_accounts (id, username, password_hash, password_salt, role, created_at)
VALUES ('<uuid from above>', 'yourusername', '<hash from above>', '<salt from above>', 'owner', now()::text);
```

After that, sign in at `/staff.html` and use the **Employees** tab to add anyone else who needs access (leave "owner access" unchecked for a regular employee) — no more manual SQL required.

## Setting up real email delivery

Password-reset codes, forgotten usernames and staff login verification codes are delivered by email (or, for staff, SMS). `email.js` sends them using [Resend](https://resend.com)'s HTTP API reached with Node's built-in `fetch()`, the same zero-npm-dependency approach as everything else in this app.

**Without email configured, those features are switched off** — "Forgot your password/username?" answer with a "not set up yet" error, and staff can't log in — rather than showing the codes on screen. Showing them on screen means anyone who knows an account's email can reset its password, and staff 2FA stops being a second factor. For a demo or local development you can bring the old on-screen behaviour back with:

```
SHOW_CODES_ON_SCREEN=true
```

**Never set that on a real deployment.** If you're upgrading a deployment that has been relying on on-screen codes (for example, staff with no email on file), either configure email first and have every staff member add their email under **Employees → My email**, or set `SHOW_CODES_ON_SCREEN=true` temporarily while you do — otherwise staff will be locked out of the portal.

To turn it on:

1. Sign up for a free Resend account and create an API key (their free tier is enough for this app's volume).
2. In **Render's dashboard** (not here — see why below) → your service → **Environment**, add:
   - `RESEND_API_KEY` — the API key from Resend.
   - `RESEND_FROM_EMAIL` (optional) — defaults to Resend's own test sender, which only delivers to your own verified email until you verify a domain in Resend. Once you've verified a domain there, set this to something like `GYD Wallet <no-reply@yourdomain.com>`.
3. Redeploy (Render does this automatically after an environment variable change).

That's the whole setup — nothing in the code needs to change. Once `RESEND_API_KEY` is set: password-reset codes and forgotten usernames get emailed to the address on the account, and any staff member with an email under the **Employees** tab's "My email" field gets their login verification code emailed (and, if they're an owner, fraud alerts — see **How the staff portal works**). A staff member with no email or phone on file can't log in unless `SHOW_CODES_ON_SCREEN=true`.

The forgot-password and forgot-username endpoints give the same answer ("if an account uses this email, we've emailed it") whether or not the email is registered, so they can't be used to find out who has an account. A send that fails is logged on the server, not turned into an on-screen code.

**Why you have to do this part yourself:** entering an API key is entering a credential, and Claude won't do that on your behalf even if you paste the key into chat — it has to go into Render's environment variables through Render's own dashboard, by you.

## Setting up real SMS delivery

Two things in this app are texted instead of shown on screen once this is configured: a **GYD Direct** transfer's reference code (sent straight to the recipient's phone number instead of the sender having to relay it by hand — see `POST /api/remit` in server.js), and a **staff login verification code**, as a fallback for any staff member who's added a phone number under the Employees tab's "My phone" field but doesn't have an email on file (or whose email failed to send). `sms.js` adds this using [Twilio](https://www.twilio.com)'s REST API reached with Node's built-in `fetch()` — same zero-npm-dependency approach as `email.js` — and, like email, it only turns on once it's configured; everything keeps working exactly as before if it isn't (the sender still sees the reference code to share themselves, and the staff code still falls back to on-screen or email).

To turn it on:

1. Sign up for a Twilio account, buy or use a trial phone number, and find your Account SID and Auth Token (Twilio's console dashboard).
2. In **Render's dashboard** → your service → **Environment**, add:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_FROM_NUMBER` — the Twilio phone number to send from, in E.164 format (e.g. `+15555550123`).
3. Redeploy (Render does this automatically after an environment variable change).

That's the whole setup — nothing in the code needs to change. A Twilio trial account can only send to phone numbers you've verified in the Twilio console; texting arbitrary numbers needs a paid Twilio account with the trial restriction lifted.

**Why you have to do this part yourself:** same reason as the Resend API key above — these are credentials, and they go into Render's environment variables through Render's own dashboard, by you.

## Setting up CJdropshipping

The Business tab's "🛍️ Shop" button opens a second, separate storefront — products sourced from [CJdropshipping](https://cjdropshipping.com) rather than a Guyanese business on this app's own directory, paid for out of a buyer's GYD balance. `dropshipping.js` adds this, reached with Node's built-in `fetch()` — same zero-npm-dependency approach as `email.js`/`sms.js` — and, like those, it's off by default: with no credentials configured, the Shop tab shows an empty product list and a "not set up yet" banner, and checkout refuses outright rather than charging someone's GYD for an order that could never actually be placed with CJ.

**Important — this has not been tested against a real CJdropshipping account.** The request/response shapes `dropshipping.js` sends and expects (product fields, the `/v1/products` and `/v1/orders` paths, the auth header) are this codebase's best reading of [CJdropshipping's public API docs](https://developers.cjdropshipping.com/en/api/start/), not verified working code — there was no real CJ account available while building this. Treat it as a starting point: once you have real credentials, try a sync and a test order, check the actual responses CJ sends back against what `dropshipping.js` expects (`fetchProductsFromCJ` and `placeOrderWithCJ`), and adjust the field names there if CJ's real API differs.

To turn it on:

1. Sign up at [cjdropshipping.com](https://cjdropshipping.com) and request API access (see their developer portal) — note your Account ID and API Key.
2. In **Render's dashboard** → your service → **Environment**, add:
   - `CJ_ACCOUNT_ID`
   - `CJ_API_KEY` — never put this in a database column or commit it to GitHub; it only ever lives here.
   - `USD_TO_GYD_RATE` (optional) — the app has no real exchange-rate API wired up yet, so this defaults to a static `210`. This only matters at sync time (see below) — changing it later never moves the price on a product that's already been synced.
3. Redeploy, then have an owner-level staff account call `POST /api/admin/dropshipping/sync-products` once to pull in the first batch of products (there's no scheduled job wired up yet — see the Implementation checklist this feature started from — so this needs to be triggered by hand, or by wiring up Render's own cron feature to hit that endpoint on a schedule).

Once products are synced, anyone can browse them from the Shop tab. Each product's GYD price is converted from CJ's USD price and pinned (stored) the moment it's synced — see `price_gyd` in `supabase/schema.sql` — rather than recalculated on the fly every time it's shown or paid for, so the price a customer sees while browsing is guaranteed to be exactly what checkout charges; it only moves the next time that product is re-synced.

Checkout (`POST /api/dropshipping/checkout`) debits the buyer's GYD balance for the item cost plus a 3% platform fee only — **no delivery fee is charged at checkout.** It then attempts to place the order with CJ, and automatically refunds the buyer in full if that placement fails — since there's no local business on the other end of a dropshipped order, none of this amount is ever credited to any wallet the way a regular business checkout credits the business (see the comment above the dropshipping section in `server.js`). Per-product weight (synced from CJ the same way price is — see the "not tested against a real account" note above, since that field's name is also a guess) is frozen onto the order as `total_weight_kg` at checkout time, for use later when the delivery fee is actually decided.

### The warehouse → pickup/delivery lifecycle

Real orders don't go straight from "paid for" to "in the customer's hands" — CJ's own international shipping takes days to weeks, and only once an order has actually landed at this business's own Guyana warehouse does anyone know whether the customer wants to pick it up in person or have it delivered. That's why the delivery fee isn't charged at checkout: nobody — not even the customer — knows yet which path this order will take. The full lifecycle, end to end:

1. **Checkout** → `pending`, then (if CJ accepts the order) `placed_with_cj` — the buyer has paid the item cost + 3% platform fee, and the order is somewhere between here and the warehouse.
2. **A staff member marks it arrived** (Staff portal → Dropshipping tab → "Mark arrived at warehouse", or `POST /api/staff/dropshipping-orders/:id/mark-arrived`) once the shipment has actually landed → `arrived_at_warehouse`. **This is a manual step** — there is no real CJdropshipping tracking webhook wired up yet (same "not tested against a real account" caveat as above), so a real deployment needs someone physically checking incoming shipments and clicking this. If email is configured (see "Setting up real email delivery"), the customer gets an email here telling them to open the app and choose pickup or delivery. **There is no phone-call integration in this codebase** — the `users` table doesn't even collect a phone number at signup — so despite this business process originally describing "we call and email the customer," only the email half is actually buildable today; if calling customers matters, that has to happen outside the app (e.g. staff calling from the phone number on the shipping address) until a real telephony integration is added.
3. **The customer chooses**, from their order in "My orders" (`POST /api/dropshipping/orders/:id/choose-fulfillment`, body `{fulfillment: 'pickup'|'delivery'}`):
   - **Pickup** → `awaiting_pickup`, free, generates a warehouse pickup code (same short human-readable code pattern as a local business's pickup orders) shown to the customer as text + QR. A staff member redeems it in person (Staff portal → Dropshipping tab → "Redeem a warehouse pickup", or `POST /api/staff/dropshipping-orders/redeem-pickup`) → `picked_up`. No money moves here — nothing was ever charged for pickup.
   - **Delivery** → **this is the moment the delivery fee is actually charged** — GYD 500 normally, or GYD 1,500 if the order's frozen `total_weight_kg` passes 5kg ("oversized cargo", since one bulky item costs more to actually deliver than a normal parcel; see `DROPSHIP_STANDARD_DELIVERY_GYD`/`DROPSHIP_OVERSIZE_DELIVERY_GYD`/`DROPSHIP_OVERSIZE_WEIGHT_THRESHOLD_KG` in `server.js` if those numbers ever need to change). The order moves to `awaiting_courier`, a delivery code is generated, and the order appears on the open courier board.
4. **A courier claims it** (Business tab → "🚚 Deliver" → "Available deliveries" → "Claim this delivery", or `POST /api/courier/deliveries/:id/claim`) → `out_for_delivery`, assigned to that courier.
5. **The courier delivers it and enters the customer's delivery code** (`POST /api/courier/deliveries/:id/confirm`) → `delivered`, and the delivery fee is credited to the courier's own courier wallet. The delivery code is never exposed to the courier through any API response — the customer has to read it out to them in person at handoff, the same "blind code entry" pattern as every other code-based release in this app, so a delivery can't be marked complete without the customer's own confirmation.

**Courier is a third account role, but no longer self-serve** — becoming one now requires staff approval. From the Business tab's "🚚 Deliver" button, an account holder submits an application (`POST /api/account/apply-courier`, with an optional free-text note) into its own `courier_applications` queue table, and sees a "waiting on our team" screen until it's resolved (`GET /api/account/courier-application` is what the client polls to know which of the apply/pending/approved screens to show). A staff member reviews it from the Staff portal's new Couriers tab (`GET /api/staff/courier-applications`, filterable by pending/approved/rejected) and either approves it (`POST /api/staff/courier-applications/:id/approve` — atomically flips the application to `approved` and flips `is_courier` to `true` on the account in the same statement, so the two can never disagree) or rejects it with an optional reason the applicant will see (`POST /api/staff/courier-applications/:id/reject`, stored as `staff_note`) — a rejected applicant can submit a new application at any time. Any staff member can review these, the same `requireStaffAuth` tier as support tickets and cash-outs, not an owner-only action. Once approved, it's `is_courier` / `courier_gyd_balance` on `users` (mirroring `is_business`/`business_gyd_balance`) — same login and personal balance, plus a separate delivery wallet that only ever fills up from confirmed deliveries. `POST /api/courier/wallet/move-to-personal` moves earnings from there into personal spending money, same one-way "owner's draw" pattern as the business wallet.

**Why you have to do this part yourself:** same reason as the Resend/Twilio credentials above — these are credentials, and they go into Render's environment variables through Render's own dashboard, by you.

## Setting up social sign-in (Google / Facebook)

The auth screen can show "Continue with Google" and "Continue with Facebook" buttons alongside the regular username/password login and signup forms. `oauth.js` adds this using each provider's own OAuth 2.0 HTTP endpoints, reached with Node's built-in `fetch()` — same zero-npm-dependency approach as `email.js` and `sms.js` — and, like those, each provider only turns on once it's configured. Both are optional and independent of each other: with neither set up, the auth screen just shows the password form the way it always has; with one set up but not the other, only that one button appears.

Signing in with either provider either logs into an existing account (if that Google/Facebook account has signed in before, or its verified email matches an existing password account) or creates a brand-new one automatically — no password is set on a new account created this way, though its owner can still add one later through the normal "Forgot your password?" flow once they've added an email.

**Setting up Google (free):**

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a project (or use an existing one) — no cost, no credit card required for this.
2. Go to **APIs & Services → OAuth consent screen**, choose **External**, and fill in the minimal required fields (app name, your email). You can leave it in "Testing" mode while trying this out, or publish it once you're ready for anyone to use it.
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**, choose **Web application**.
4. Under **Authorized redirect URIs**, add exactly: `https://gyd-wallet.onrender.com/api/auth/google/callback`
5. Click Create — Google shows you a **Client ID** and **Client secret**.
6. In **Render's dashboard** → your service → **Environment**, add:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`

**Setting up Facebook (free):**

1. Go to [Meta for Developers](https://developers.facebook.com/) and create an app (choose "Consumer" or "Other" as the type) — also free, no payment info needed.
2. Add the **Facebook Login** product to the app.
3. Under Facebook Login's **Settings**, add exactly this to **Valid OAuth Redirect URIs**: `https://gyd-wallet.onrender.com/api/auth/facebook/callback`
4. Under the app's **Settings → Basic**, copy the **App ID** and **App Secret**.
5. While the app is in "Development" mode, only people you've added as testers/developers on the Facebook app itself can sign in with it — switch the app to "Live" (Meta may ask for a privacy policy URL and basic app review first) once you want it open to anyone.
6. In **Render's dashboard** → your service → **Environment**, add:
   - `FACEBOOK_APP_ID`
   - `FACEBOOK_APP_SECRET`

Either way, redeploy after saving (Render does this automatically after an environment variable change), then refresh the auth screen — the corresponding button appears once its two env vars are set.

If this app is ever deployed somewhere other than `gyd-wallet.onrender.com` (a custom domain, a staging copy), also set `APP_BASE_URL` to that URL and update both providers' redirect URI settings to match — the redirect URI sent to Google/Facebook has to exactly match what's registered in their console, or sign-in fails.

**Why you have to do this part yourself:** same reason as the Resend and Twilio credentials above — a client ID and secret are credentials, and they go into Render's environment variables through Render's own dashboard, by you. Claude also can't click through Google's or Facebook's own developer console on your behalf to create the OAuth app itself, since that means signing into your Google/Facebook account.

## Terms & Conditions

The Help & Support screen ("customer service" in the app) has a "Legal" section with a "📜 Terms & Conditions" button, and signup requires checking an "I have read and agree to the Terms & Conditions" box before an account can be created — the Create account button is a no-op (with its own error message, same as every other validation in the signup form) until that box is checked. The Terms text itself lives in exactly one place, `#panel-terms` in `public/index.html`; the signup screen's collapsible preview is populated from that same markup at page load (see `initTerms()` in `public/app.js`) rather than duplicating the text, so the two can never drift out of sync.

**This is drafted, placeholder legal text, not lawyer-reviewed language you should treat as a final, enforceable contract.** It was written to be a strong starting point that actually matches this app's real features (wallet transfers, business accounts, the dropshipping/courier delivery flow, the free-to-play games, etc.), including a warranty disclaimer, a liability cap, an indemnification clause, and a binding-arbitration/class-action-waiver section — but before relying on it for a real launch, have it reviewed by counsel licensed in Guyana (and anywhere else you operate). That's especially true for anything touching money movement: as the document itself says, this app isn't currently licensed as a bank, money transmitter, or payment service provider anywhere, and real fund movement typically needs that licensing sorted out first regardless of what any Terms document says.

To update the Terms later, edit the content inside `#panel-terms .panel` in `index.html` and bump the `TERMS_LAST_UPDATED` constant in `initTerms()` in `app.js` — both the in-app page and the signup preview pick up the change automatically.

## How product photos are stored

There's no file-upload endpoint or file storage in this zero-dependency prototype, so a product photo never becomes a file on the server at all. Instead, the browser reads the chosen photo, draws it onto an off-screen canvas resized to a maximum of 500px on its longest side, re-encodes that as a compressed JPEG, and sends the whole thing as a `data:image/...;base64,...` string in the same JSON request that creates the product — the server just validates it looks like an image and isn't unreasonably large (capped at roughly 1.5MB of raw image data), then stores that string as a normal text column. That keeps the feature genuinely working without adding an image-processing library or a place to store uploaded files, at the cost of every photo living inline in the SQLite database rather than as a separate optimized asset — fine for a demo, not how you'd want to do it at real scale (a real build would upload to object storage and store a URL instead).

## Why the games are free to play

The coin flip, the slot machine, and Ludo all cost nothing to play, pay out
nothing of value, and don't touch GYD or any other balance at all — there
is no in-game currency anywhere in this app. Play as many rounds (or
matches) as you like with a brand-new account that has never deposited a
cent; nothing is spent, nothing is won, and your GYD balance never moves
because a game was played. A coin-flip/slots round is just a record of what
happened (win or lose) for your own game history, and a Ludo match is just
a record of who won — nothing more, for either kind of game.

An earlier version of this prototype ran the coin flip and slot machine on
a "coins" currency: GYD bought coins, coins were wagered on the games, and
wins paid out more coins, with coins kept deliberately one-way (no
converting back to GYD) so that no full loop existed from real money,
through a game of chance, and back out again. That one-way design was a
real mitigation, but it still left a currency, a wager, and a payout
sitting in the games — the kind of structure that at least raises the
gambling-law question, even if the one-way rule was meant to answer it. An
even earlier version of Ludo had its own version of the same problem, and
arguably a bigger one: tables wagered GYD or coins directly, with the
winner taking the whole pot — real peer-to-peer betting between players,
rather than a house-edge game, which is generally treated as a more
straightforward case of gambling, not a less complicated one.

Removing all of that settles the question a different way: rather than
design carefully around the edge of what counts as gambling, there's simply
nothing wagered and nothing paid out, for anyone, ever, in any game in this
app. That's a stronger and simpler position than either the one-way-coins
design or the wagered-Ludo-pot design was — it doesn't depend on a rule
staying enforced (there's no coins-to-GYD conversion path, and no
table-wager path, to accidentally reopen, because there's no currency
staked in a game anywhere), and it doesn't require distinguishing "coins"
from "real value" in the first place. You'd still need the Bank of Guyana
money-transmission licensing to handle real deposits, cash-outs,
peer-to-peer transfers, requests, GYD Direct, business checkout, and the
business payment portal (those move real money regardless of whether any
game exists at all), but none of the games need a gaming license from
Guyana's Gaming Authority — there's nothing wagered for that framework
(built entirely around physical casinos, per the business plan's research)
to have any claim over. Worth having a Guyanese lawyer confirm this
reasoning before it matters for real, but it's a much easier position to
defend than either earlier design, precisely because there's nothing left
to argue about.

## Why this isn't styled like Cash App anymore

Earlier drafts of this prototype leaned explicitly on Cash App as a design reference — a "$Cashtag" handle feature (Cash App's own trademarked term for exactly this), marketing copy that said "Cash App-style," and a near-identical vivid green as the brand color. That combination is the kind of thing a company actually polices — usually starting with a cease-and-desist rather than a lawsuit out of nowhere, but cheaper to avoid than to deal with either way. None of this is legal advice (talk to an actual trademark attorney before a real public launch), but as a matter of reducing obvious risk:

- The payment-handle feature is now called **$Paytag**, this app's own name for it. The database column behind it is `paytag` (see `add_paytag_column_rebrand` in the Supabase migration history) — the old `cashtag` column still exists but is unused, kept only so the still-deployed old code didn't break the moment this migration ran; it's safe to drop once the new code has been live a while.
- The primary brand color is now a distinct indigo-blue (`--accent: #4954e6` in `styles.css`), not the old vivid green.
- Marketing copy and code comments that named Cash App directly have been reworded to describe what the feature does instead of what it resembles.

## What's deliberately NOT implemented (see the business plan)

- **No real money in or out.** Deposits just add GYD to your balance directly; cash-out just records a request. Wiring in real payments needs a licensed money-transmission partner — this is Phase 2 in the plan, and shouldn't happen before that legal/licensing work is done. That licensing requirement covers deposits, cash-out, peer-to-peer transfers, requests, GYD Direct, and the business portal alike — it's about holding and moving other people's money at all, not about any single feature.
- **No real-money gambling exposure.** The games are free to play (see **Why the games are free to play** above) — there is no in-game currency at all, so nothing is ever wagered or paid out. GYD, the one balance meant to represent real money, only moves via deposits, cash-out, peer-to-peer transfers, requests, GYD Direct, and the business payment portal — never through a game.
- **No real cash pickup network for GYD Direct.** A real money-transfer service has physical agent locations where a recipient without a bank account can walk in and collect cash. This prototype's "pickup" is digital only — the recipient needs to register an account here to receive the funds into a balance, not walk away with cash. Building an actual cash-pickup network is a much bigger undertaking (agent partnerships, cash management, physical security) well beyond this prototype's scope.
- **No KYC/AML or fraud controls.** Needed before this could handle real funds, not needed to demo the product. (Basic abuse-resistance — rate limiting on login/reset/lookup endpoints — does exist; see **Deployment settings added in the security update**.)
- **No mobile app** — this is a responsive web app; wrapping it for iOS/Android (or rebuilding natively) is a separate step.
- **No self-hosted QR generation** — see "How QR pay actually works" above; it currently calls out to a public image API instead of generating codes locally.
- **No ticket refunds.** A buyer can't cancel a purchased ticket for a refund from the app — a business can cancel the *event* (which stops new sales but leaves existing tickets alone), but there's no built-in way to reverse a specific ticket sale. A real build would need a refund policy and flow before this went live.

## Project layout

```
server.js         HTTP server + all API routes (plain Node http module, no framework)
db.js             Talks to the Supabase Postgres database over fetch() — see "How the database works"
auth.js           Password hashing + signed session tokens (node:crypto)
ludo.js           Pure Ludo game rules (movement, capture, win detection) — no HTTP or DB in here
public/           Frontend: index.html, styles.css, app.js (vanilla JS, no build step)
supabase/schema.sql   The Postgres tables + the exec_query function db.js calls — run it against a new project, and re-run it after upgrading (it's idempotent)
test/             Integration tests: real schema + real server.js against a throwaway local Postgres (see "Running the tests")
```

## Running the tests

```
npm test          # same as: node --test test/*.test.js
```

No `npm install` is needed — the suite uses Node's built-in test runner. It does need **PostgreSQL 15+ server binaries** installed locally (`initdb`, `pg_ctl`, `psql`; e.g. `apt install postgresql` or `brew install postgresql`). Set `PG_BIN` to their directory if they aren't found automatically.

Each test file starts its own throwaway Postgres, loads `supabase/schema.sql` into it (twice, to prove it can be re-run), and runs the real `server.js` against it. The modules `server.js` requires (`db.js`, `auth.js`, `email.js`, …) are replaced by simple stand-ins in `test/shims/`; the database stand-in still sends every query through the real `exec_query` function, as the `service_role` role, so the actual SQL, placeholder substitution and grants are what get tested. The suite covers the money flows (transfers, ticket sales and refunds, pickup orders, delivery fees, courier payouts), the auth code flows, account-identity rules, GYD Direct pickup limits, rate limiting, and the database grants — including concurrent-request races for the flows where double-spending or overselling would be possible.

## Deployment settings added in the security update

| Variable | Default | What it's for |
| --- | --- | --- |
| `SUPABASE_KEY` | — | Must now be the project's **secret** key (see **How the database works**). |
| `SHOW_CODES_ON_SCREEN` | off | Demo/dev only: show reset/username/staff codes on screen when email isn't configured (see **Setting up real email delivery**). |
| `CLIENT_IP_HEADER` | `true-client-ip` on Render, otherwise unset | A header your edge proxy sets to the real client IP, overwriting whatever the client sent (Render/Cloudflare: `true-client-ip`). Used for per-IP rate limiting. No change is needed on Render. |
| `TRUSTED_PROXY_HOPS` | `1` | Only used when there's no `CLIENT_IP_HEADER`: how many reverse proxies append to `X-Forwarded-For` in front of the app. The real client IP is read that many entries from the right, so a client-supplied `X-Forwarded-For` can't be used to dodge rate limits. Set `0` if nothing sits in front of the app. |

**Upgrade order for an existing deployment** (the order matters):

1. Switch `SUPABASE_KEY` on Render to the project's secret key and let it redeploy (still the old code).
2. Re-run `supabase/schema.sql` in the Supabase SQL Editor. It adds the new columns, tables and functions, converts money columns to exact decimals, and revokes the old public access to `exec_query`. The old code keeps working against the new schema. Doing this before step 1 cuts the running app off from its database.
3. Configure email (and have staff add their email under **Employees → My email**), or set `SHOW_CODES_ON_SCREEN=true` temporarily, so staff can still log in once the new code is live.
4. Deploy the new code. Deploying it before step 2 breaks logins, because the new code expects the new tables.

## Why no npm packages

Everything here runs on Node's built-in modules (`http`, `crypto`, and
`fetch()`) on purpose, so there's nothing to install and nothing to audit
for supply-chain risk in this early prototype — including the database:
see **How the database works** above for how it reaches Postgres without a
driver package. If you continue this build, reaching for Express, a real
ORM, and a proper frontend framework (React/Vue) once the team and
requirements grow is entirely reasonable — this version optimizes for
"runs anywhere with zero setup" over production architecture.
