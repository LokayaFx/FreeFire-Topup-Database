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
| `!add <Product> <PlayerID> <Price> <Rate> [-d YYYY-MM-DD] [-t HH:MM]` | Add new order |
| `!sales` | View last 5 recent sales |
| `!profit` | View total profit summary |
| `!verify @user` | Verify a user (admin only) |
| `!unverify @user` | Remove verification (admin only) |
| `!verified` | List all verified users |
| `!help` | Show help message |

### Examples
```bash
# Basic order (uses current date/time)
!add 100DB 123456789 350 290

# Custom date
!add 100DB 123456789 350 290 -d 2026-10-05

# Custom date and time
!add 100DB 123456789 350 290 -d 2026-10-05 -t 14:30
```

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

### Database Setup
Run these SQL commands in Supabase SQL Editor:
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
npm start        # Production
npm run dev      # Development with auto-reload
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