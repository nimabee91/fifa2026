# Helix World Cup 2026 Pool ⚽

A simple betting-pool web app for Helix employees to bet on the 2026 World Cup.
Built on Cloudflare Workers + D1 (SQLite). The app **tracks** money — people pay
each other (Venmo/cash) and the admin marks who's paid.

## The game

- **$5 to enter**, pick any of the 48 teams (duplicate picks allowed at this stage).
- Team knocked out → you're out, unless you buy back in.
- **Round of 32 buy-back: $10** — claim any alive team no surviving player holds.
- **Round of 16 buy-back: $15** — last chance to buy back in.
- After R16, bets are closed. **Winner takes all**: whoever holds the champion takes the pot (split evenly if more than one).
- **If nobody holds the champion**, the pot goes to whoever's team made it the farthest in the tournament (split on a tie).

## Pages

- `/` — player page: join, pick, buy back, standings.
- `/admin.html` — run the tournament (password-protected).

## Local development

```bash
npm install
npm run db:migrate:local          # create + seed the local database
npm run dev                        # http://localhost:8787
```

Local admin password is in `.dev.vars` (default: `helix-admin`).

## Deploy to Cloudflare

```bash
# 1. Log in (opens a browser)
npx wrangler login

# 2. Create the database, then paste the printed database_id into wrangler.jsonc
npx wrangler d1 create fifa2026-db

# 3. Apply the schema + seed to the live database
npm run db:migrate:remote

# 4. Set the real admin password (you'll be prompted to type it)
npx wrangler secret put ADMIN_PASSWORD

# 5. Ship it
npm run deploy
```

Wrangler prints your live URL (e.g. `https://fifa2026.<your-subdomain>.workers.dev`).
Share that with the team; keep `/admin.html` + the password to yourself.
