# Asta Fantacalcio

A live Serie A fantasy auction for eight teams. Everyone opens the same URL on their
phone, picks a team, and bids in real time. One admin decides who goes up next.

**Rules baked in:** 500 credits per team · 3 portieri, 8 difensori, 8 centrocampisti,
6 attaccanti · positions are auctioned in that order and nobody moves on until every
roster is full · bidding closes 20 seconds after the last highest bid · no team can
bid so much that it couldn't afford 1 credit for each slot it still has to fill.

All of those rules are enforced in the database, not the browser. A friend poking at
the developer console can't overspend or bid on a position they've already filled.

---

## Setup

You need a free [Supabase](https://supabase.com) account, a
[GitHub](https://github.com) account, and a free [Vercel](https://vercel.com) account.
Budget about half an hour the first time.

### 1. Create the database

1. Create a new project at [supabase.com/dashboard](https://supabase.com/dashboard).
   Pick a region close to you. Save the database password somewhere.
2. Open **SQL Editor** in the left sidebar, click **New query**.
3. Paste the entire contents of `supabase/schema.sql` and hit **Run**.
   You should see "Success. No rows returned."
4. Change the admin code straight away. In the same SQL editor, run:

   ```sql
   update settings set admin_code = 'your-secret-here' where id = 1;
   ```

   Nobody can read this value from the browser — the `settings` table has no read
   policy — but the app checks against it whenever you use an admin action.

5. Go to **Project Settings → API** and copy two things:
   - **Project URL** (looks like `https://abcdefgh.supabase.co`)
   - the **anon public** key (a long `eyJ...` string)

### 2. Run it on your laptop

```bash
npm install
cp .env.example .env.local
```

Open `.env.local` and paste in the two values from step 1.5. Then:

```bash
npm run dev
```

Open the URL it prints. Load it in two browser windows, join as different teams, and
bid against yourself to confirm both sides update.

### 3. Push to GitHub

```bash
git init
git add .
git commit -m "Asta Fantacalcio"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/asta-fantacalcio.git
git push -u origin main
```

`.env.local` is gitignored, so your keys don't end up in the repo.

### 4. Deploy on Vercel

1. At [vercel.com/new](https://vercel.com/new), import the repository you just pushed.
2. Vercel detects Vite on its own — leave the build settings alone.
3. Before clicking Deploy, open **Environment Variables** and add both:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Deploy. You get a URL like `asta-fantacalcio.vercel.app` to send to the group chat.

If you add or change an environment variable later, redeploy — Vite bakes them in at
build time, so a running deployment won't pick them up on its own.

---

## Before draft night

- Join as admin, open **Nomi squadre**, and replace the eight placeholder names.
- Do a dry run with one friend on two devices. Bid, let the timer run out, check the
  player lands in the right roster with the right price.
- Try the **Annulla** button once so you know where it is when someone fat-fingers a bid.

## During the auction

Members type a name in the chat and press **Proponi**. You get an **All'asta** button
next to each proposal. Once a lot is open, anyone who still has a free slot in that
position can bid: three quick buttons (+1 / +5 / +10, each showing the resulting
total) or type any number and press Enter. Every new high bid resets the clock to 20
seconds. At zero the player is assigned automatically and credits are deducted.

When all eight rosters have that position filled, the **Passa ai...** button unlocks.

---

## A note on security

There are no accounts. Anyone with the link can join as any team, and there's nothing
stopping two people from picking the same one — the "già in uso" tag is a courtesy,
not a lock. The admin code is the only real gate, and it only protects admin actions.

That's the right trade-off for eight friends and one evening, but don't post the link
publicly, and pick an admin code your friends won't guess in three tries.

## Changing the rules

| What | Where |
|---|---|
| Seconds after the last bid | `settings.bid_window_seconds` in the DB **and** `BID_WINDOW` in `src/App.jsx` |
| Starting credits | `teams.credits` default in `schema.sql`, and `reset_auction()` |
| Slots per position | `slots_for()` and `total_slots()` in `schema.sql`, **and** `ROLES` in `src/lib/rules.js` |
| Number of teams | the `generate_series(1, 8)` insert in `schema.sql` |

The client copies exist only so buttons can grey themselves out. If the two ever
disagree, the database wins and the user gets an error message instead of a silent
wrong result — so change both, but change the SQL first.

## Layout

```
src/
  App.jsx          all UI, one file
  index.css        the stylesheet
  lib/db.js        Supabase client, data loading, realtime, RPC wrappers
  lib/rules.js     roster rules mirrored for the UI
supabase/
  schema.sql       tables, rules and every write path
```
