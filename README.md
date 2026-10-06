# Free Fire Top-Up Database

A production-ready Discord bot for managing Free Fire diamond top-up orders with Supabase database integration.

## Features

- **Order Management** - Add orders with product, player ID, price, and rate
- **Custom Date/Time** - Set custom order dates with `-d YYYY-MM-DD -t HH:MM` flags
- **Sales Tracking** - View last 5 recent sales with profit calculations
- **Profit Summary** - Total revenue, cost, and net profit across all orders
- **User Verification** - Role-based access control (verify/unverify users)
- **Discord Embeds** - Clean, formatted responses with timestamps

## Commands

| Command | Description |
|---------|-------------|
| `!add <Product> <PlayerID> <Price> [Rate] [-d YYYY-MM-DD] [-t HH:MM]` | Add new order (rate auto-fills from saved rates) |
| `!sales` | View last 5 recent sales |
| `!profit` | View total profit summary |
| `!delete <OrderID>` | Delete an order |
| `!edit <OrderID> <field> <value>` | Edit product, player_id, price or rate |
| `!daily [YYYY-MM-DD]` | Daily profit report (default today) |
| `!monthly [YYYY-MM]` | Monthly profit report (default this month) |
| `!search <PlayerID>` | Find all orders for a player |
| `!export` | Download all orders as CSV |
| `!updaterates` | Scrape supplier rate list (reply to supplier msg or paste list after command) |
| `!rates` | View saved supplier rates |
| `!verify @user` | Verify a user (admin only) |
| `!unverify @user` | Remove verification (admin only) |
| `!verified` | List all verified users |
| `!verifytoggle [on|off]` | Toggle verified-only mode (owner/managers/verified) |
| `!help` | Show help message |

### Examples
```bash
# Basic order (uses current date/time)
!add 100DB 123456789 350 290

# Custom date
!add 100DB 123456789 350 290 -d 2026-10-05

# Custom date and time
!add 100DB 123456789 350 290 -d 2026-10-05 -t 14:30

# Auto-rate from saved supplier rates (run !updaterates first)
!add WEEKLY 123456789 650

# Scrape supplier rate list: reply to supplier message with !updaterates,
# or paste the list after the command
```

### Supplier Rates
Reply to the supplier bot's rate message with `!updaterates` — products, rates, and categories are scraped and saved. `!rates` shows them. `!add` without a rate auto-fills from saved rates.

## Setup

### Prerequisites
- Node.js 18+
- Discord Bot Token
- Supabase Project

### Installation
```bash
git clone <repo-url>
cd freefire-topup-bot
npm install
```

### Configuration
Copy `.env.example` to `.env` and fill in:
```env
DISCORD_TOKEN=your_discord_bot_token
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your_supabase_anon_key
OWNER_ID=your_discord_user_id
```

### Database Providers
Set `DB_PROVIDER` in `.env` to switch storage. Default is `supabase`.

| Provider | Value | Needs |
|----------|-------|-------|
| Supabase | `supabase` | SUPABASE_URL, SUPABASE_KEY |
| JSON file | `json` | JSON_DATA_DIR (default ./data) |
| SQLite | `sqlite` | SQLITE_PATH + `npm i better-sqlite3` |
| MySQL | `mysql` | DATABASE_URL/MYSQL_URL + `npm i mysql2` |
| Postgres | `postgres` | DATABASE_URL/POSTGRES_URL + `npm i pg` |
| MongoDB | `mongo` | MONGO_URI (+MONGO_DB) + `npm i mongodb` |
| Firebase | `firebase` | FIREBASE_SERVICE_ACCOUNT_JSON/PATH + `npm i firebase-admin` |
| Google Sheets | `sheets` | GOOGLE_SHEETS_ID + service account + `npm i googleapis` |

Multi-write mirror (primary + extra copies):
```env
DB_PROVIDER=supabase
DB_MIRROR=json,sheets
```

### Database Setup
Supabase selected SQL run:
```sql
-- Orders table
CREATE TABLE orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product TEXT NOT NULL,
  player_id TEXT NOT NULL,
  price NUMERIC NOT NULL,
  rate NUMERIC NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Verified users table
CREATE TABLE verified_users (
  user_id TEXT PRIMARY KEY,
  verified_by TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Supplier rates table
CREATE TABLE rates (
  product TEXT PRIMARY KEY,
  rate NUMERIC NOT NULL,
  category TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Bot settings table (e.g. verification on/off)
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Discord Bot Setup
1. Create bot at [Discord Developer Portal](https://discord.com/developers/applications)
2. Enable **Message Content Intent** in Bot settings
3. Generate OAuth2 URL with `bot` scope and permissions:
   - Send Messages
   - Embed Links
   - Read Messages/View Channels
   - Read Message History
4. Invite bot to your server

### Run
```bash
npm start        # Production (Discord bot)
npm run dev      # Development with auto-reload
npm run cli -- help   # CLI mode (no Discord needed)
```

### CLI Mode (Terminal)
```bash
node cli.js add 100DB 123456789 350 290
node cli.js add 100DB 123456789 350 290 -d 2026-10-05 -t 14:30
node cli.js sales
node cli.js profit
node cli.js verify <UserID>
node cli.js verified
node cli.js delete <OrderID>
node cli.js edit <OrderID> <field> <value>
node cli.js daily [YYYY-MM-DD]
node cli.js monthly [YYYY-MM]
node cli.js search <PlayerID>
node cli.js export [filepath]
```

## Tech Stack
- **Node.js 18+**
- **discord.js v14**
- **@supabase/supabase-js v2**
- **dotenv**

## Security
- Never commit `.env` file
- Bot owner (`OWNER_ID`) has automatic admin access
- Verified users stored in database with audit trail

## Deploy to Render (Free)
1. Push repo to GitHub (includes `render.yaml` blueprint)
2. Go to https://dashboard.render.com → **New +** → **Web Service** → connect repo
3. Settings (auto-filled from `render.yaml`):
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Health Check Path: `/health`
4. **Environment** tab → add keys:
   - `DISCORD_TOKEN`, `OWNER_ID`
   - `DB_PROVIDER=supabase`, `SUPABASE_URL`, `SUPABASE_KEY`
5. **Create Web Service** → wait for `Logged in as ...` in Logs
6. Free tier sleeps after ~15 min idle — keep alive with a free monitor (e.g. UptimeRobot) pinging `https://YOUR-APP.onrender.com/health` every 5–10 min
