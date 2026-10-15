import asyncio
import csv
import io
import logging
import logging.handlers
import os
import re
from datetime import datetime, timedelta, timezone

import aiohttp
import discord
from discord import app_commands
from discord.ext import commands
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

LOG_DIR = os.environ.get("LOG_DIR", os.path.join(os.path.dirname(__file__), "logs"))
os.makedirs(LOG_DIR, exist_ok=True)
logger = logging.getLogger("topup")
logger.setLevel(logging.INFO)
_file_handler = logging.handlers.TimedRotatingFileHandler(
    os.path.join(LOG_DIR, "bot-py"), when="midnight", backupCount=30, encoding="utf-8"
)
_file_handler.suffix = "%Y-%m-%d.log"
_file_handler.setFormatter(logging.Formatter("[%(levelname)s] %(asctime)s %(message)s"))
_console_handler = logging.StreamHandler()
_console_handler.setFormatter(logging.Formatter("[%(asctime)s] %(message)s", datefmt="%Y-%m-%dT%H:%M:%S"))
logger.addHandler(_file_handler)
logger.addHandler(_console_handler)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
OWNER_ID = os.environ.get("OWNER_ID", "")
GUILD_ID = os.environ.get("GUILD_ID", "")
FF_API_URL = (os.environ.get("FF_API_URL", "https://freefire-idinfo.vercel.app")).rstrip("/")

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

intents = discord.Intents.default()
intents.message_content = True
bot = commands.Bot(command_prefix="!", intents=intents, help_command=None)

GREEN, RED, BLUE, GOLD = 0x2ECC71, 0xE74C3C, 0x3498DB, 0xF1C40F
PAGE_SIZE = 5


def now():
    return datetime.now(timezone.utc)


def fmt_lkr(amount):
    return f"LKR {float(amount):,.2f}"


def err_embed(title, description):
    return discord.Embed(title=f"❌ {title}", description=description, color=RED, timestamp=now())


def ok_embed(title, description):
    return discord.Embed(title=f"✅ {title}", description=description, color=GREEN, timestamp=now())


def info_embed(title, description):
    return discord.Embed(title=f"ℹ️ {title}", description=description, color=BLUE, timestamp=now())


class Denied(Exception):
    def __init__(self, embed):
        super().__init__("denied")
        self.embed = embed


def is_owner(user_id):
    return bool(OWNER_ID) and str(user_id) == str(OWNER_ID)


def is_verified(user_id):
    if is_owner(user_id):
        return True
    try:
        res = sb.table("verified_users").select("user_id").eq("user_id", str(user_id)).execute()
        return bool(res.data)
    except Exception:
        return False


def verification_enabled():
    try:
        res = sb.table("settings").select("*").eq("key", "verification").execute()
        if not res.data:
            return True
        return str(res.data[0].get("value", "on")).lower() != "off"
    except Exception:
        return True


def check_verified(user_id):
    if is_owner(user_id):
        return
    if verification_enabled() and not is_verified(user_id):
        raise Denied(err_embed("Not Verified", "You are not verified to use this bot. Contact an admin to get verified."))


def check_admin(user_id, can_manage):
    if is_owner(user_id) or can_manage or is_verified(user_id):
        return
    raise Denied(err_embed("Not Allowed", "Only the owner, server managers, or verified users can use this command."))


async def lookup_player(uid, region=None, timeout=15, retries=2):
    uid = str(uid or "").strip()
    if not re.fullmatch(r"\d{5,15}", uid):
        raise ValueError("Player UID must be 5-15 digits.")
    url = f"{FF_API_URL}/player-info?uid={uid}"
    if region:
        url += f"&region={str(region).upper()}"
    last_error = Exception("Lookup failed. Try again.")
    async with aiohttp.ClientSession() as session:
        for attempt in range(retries + 1):
            try:
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=timeout)) as res:
                    if res.status in (502, 503, 504):
                        last_error = Exception("API busy (warming up). Try again in a few seconds.")
                    elif res.status == 404:
                        raise ValueError("Player not found.")
                    elif res.status != 200:
                        raise ValueError(f"Lookup failed (HTTP {res.status}).")
                    else:
                        data = await res.json()
                        b = data.get("basicInfo") or {}
                        if not b.get("nickname"):
                            raise ValueError("Player not found.")
                        clan = data.get("clanBasicInfo") or {}
                        social = data.get("socialInfo") or {}
                        media = data.get("mediaInfo") or {}

                        def abs_url(p):
                            return FF_API_URL + p if p else None

                        return {
                            "uid": b.get("accountId", uid),
                            "nickname": b.get("nickname"),
                            "level": b.get("level"),
                            "likes": b.get("liked"),
                            "region": b.get("region"),
                            "br_points": b.get("rankingPoints"),
                            "cs_points": b.get("csRankingPoints"),
                            "guild": clan.get("clanName"),
                            "guild_level": clan.get("clanLevel"),
                            "guild_members": clan.get("memberNum"),
                            "bio": (social.get("signature") or None),
                            "avatar": abs_url(media.get("avatarUrl")),
                        }
            except ValueError as e:
                if str(e) == "Player not found." or str(e).startswith("Lookup failed (HTTP"):
                    raise
                last_error = e
            except asyncio.TimeoutError:
                last_error = Exception("Lookup timed out. Try again.")
            except Exception as e:
                last_error = e
            if attempt < retries:
                await asyncio.sleep(2)
    raise last_error


def parse_rate_list(text):
    items = []
    category = None
    for raw in str(text or "").split("\n"):
        line = raw.strip()
        if not line:
            continue
        m = re.match(r"^[-•*]\s*(.+?)\s*(?:⇒|→|=>|>|=|:)\s*([\d,]+(?:\.\d+)?)\s*LKR", line, re.I)
        if m:
            try:
                rate = float(m.group(2).replace(",", ""))
            except ValueError:
                continue
            if m.group(1).strip() and rate > 0:
                items.append({"product": m.group(1).strip().upper(), "rate": rate, "category": category})
            continue
        if "LKR" not in line.upper():
            c = re.sub(r"[^A-Za-z0-9 ]", "", line).strip()
            if c:
                category = c
    return items


def parse_flags(tokens):
    date, time, rest = None, None, []
    i = 0
    while i < len(tokens):
        if tokens[i] in ("-d", "--date") and i + 1 < len(tokens):
            date = tokens[i + 1]
            i += 2
        elif tokens[i] in ("-t", "--time") and i + 1 < len(tokens):
            time = tokens[i + 1]
            i += 2
        else:
            rest.append(tokens[i])
            i += 1
    return date, time, rest


def build_datetime(custom_date, custom_time):
    dt = datetime.now()
    if custom_date:
        parts = custom_date.split("-")
        if len(parts) != 3:
            raise ValueError("Date format must be YYYY-MM-DD (e.g., 2026-10-05)")
        dt = datetime(int(parts[0]), int(parts[1]), int(parts[2]))
    if custom_time:
        parts = custom_time.split(":")
        if len(parts) != 2:
            raise ValueError("Time format must be HH:MM (24-hour, e.g., 14:30)")
        h, mnt = int(parts[0]), int(parts[1])
        if not (0 <= h <= 23 and 0 <= mnt <= 59):
            raise ValueError("Invalid time. Use 24-hour format: HH:MM (00:00-23:59)")
        dt = dt.replace(hour=h, minute=mnt, second=0, microsecond=0)
    return dt


def summarize(rows):
    revenue = sum(float(o["price"]) for o in rows)
    cost = sum(float(o["rate"]) for o in rows)
    return len(rows), revenue, cost, revenue - cost


def core_add(product, player_id, price_s, tokens, author_tag):
    if not product or not player_id or not price_s:
        return err_embed("Invalid Usage", "Usage: `!add <Product> <PlayerID> <Price> [Rate] [-d YYYY-MM-DD] [-t HH:MM]`")
    rate_arg = None
    if tokens and not tokens[0].startswith("-"):
        rate_arg = tokens[0]
        tokens = tokens[1:]
    custom_date, custom_time = parse_flags(tokens)[:2]
    try:
        price = float(price_s)
        if price <= 0:
            raise ValueError()
    except ValueError:
        return err_embed("Invalid Input", "Price must be a valid number greater than 0.")
    if rate_arg is not None:
        try:
            rate = float(rate_arg)
            if rate <= 0:
                raise ValueError()
        except ValueError:
            return err_embed("Invalid Input", "Rate must be a valid number greater than 0.")
    else:
        saved = sb.table("rates").select("*").eq("product", product.strip().upper()).execute().data
        if not saved:
            return err_embed("Rate Not Found", f'No saved rate for "{product}".\nGive rate manually or run `!updaterates` first.')
        rate = float(saved[0]["rate"])
    try:
        created_at = build_datetime(custom_date, custom_time)
    except ValueError as e:
        return err_embed("Invalid Date/Time", str(e))
    profit = price - rate
    data = sb.table("orders").insert({
        "product": product, "player_id": player_id, "price": price,
        "rate": rate, "created_at": created_at.isoformat(),
    }).execute().data[0]
    return data, price, rate, profit, created_at


def add_embed(data, product, player_id, price, rate, profit, created_at, player_name, author_tag):
    em = discord.Embed(title="📦 New Order Added", color=GREEN, timestamp=now())
    em.add_field(name="Product", value=product, inline=True)
    em.add_field(name="Player ID", value=player_id, inline=True)
    if player_name:
        em.add_field(name="Player Name", value=player_name, inline=True)
    em.add_field(name="Price", value=fmt_lkr(price), inline=True)
    em.add_field(name="Rate", value=fmt_lkr(rate), inline=True)
    em.add_field(name="Profit", value=fmt_lkr(profit), inline=True)
    em.add_field(name="Order ID", value=str(data["id"]), inline=True)
    em.set_footer(text=f"Added by {author_tag}")
    return em


def core_sales(page):
    if page < 1:
        return err_embed("Invalid Page", "Usage: `!sales [page]`")
    rows = sb.table("orders").select("*").order("created_at", desc=True).limit(1000).execute().data or []
    if not rows:
        return info_embed("No Sales", "No orders found in the database.")
    pages = (len(rows) + PAGE_SIZE - 1) // PAGE_SIZE
    if page > pages:
        return err_embed("Invalid Page", f"Only {pages} page(s) available ({len(rows)} orders).")
    chunk = rows[(page - 1) * PAGE_SIZE:page * PAGE_SIZE]
    em = discord.Embed(title=f"📊 Sales - Page {page}/{pages}", color=BLUE, timestamp=now())
    em.set_footer(text=f"Total {len(rows)} orders • Use !sales {page + 1} for next page")
    for i, o in enumerate(chunk):
        profit = float(o["price"]) - float(o["rate"])
        em.add_field(
            name=f'#{(page - 1) * PAGE_SIZE + i + 1} - {o["product"]} (ID: {o["id"]})',
            value=f'Player: {o["player_id"]}\nPrice: {fmt_lkr(o["price"])} | Rate: {fmt_lkr(o["rate"])} | Profit: {fmt_lkr(profit)}',
            inline=False,
        )
    return em


def core_profit():
    rows = sb.table("orders").select("price,rate").execute().data or []
    if not rows:
        return info_embed("No Data", "No orders found to calculate profit.")
    n, revenue, cost, profit = summarize(rows)
    em = discord.Embed(title="💰 Total Profit Summary", color=GREEN if profit >= 0 else RED, timestamp=now())
    em.add_field(name="Total Orders", value=str(n), inline=True)
    em.add_field(name="Total Revenue", value=fmt_lkr(revenue), inline=True)
    em.add_field(name="Total Cost", value=fmt_lkr(cost), inline=True)
    em.add_field(name="Net Profit", value=fmt_lkr(profit), inline=False)
    return em


def report_embed(title, rows):
    n, revenue, cost, profit = summarize(rows)
    em = discord.Embed(title=title, color=GREEN if profit >= 0 else RED, timestamp=now())
    em.add_field(name="Orders", value=str(n), inline=True)
    em.add_field(name="Revenue", value=fmt_lkr(revenue), inline=True)
    em.add_field(name="Cost", value=fmt_lkr(cost), inline=True)
    em.add_field(name="Net Profit", value=fmt_lkr(profit), inline=False)
    return em


def _in_range(rows, start, end):
    s, e = start.timestamp(), end.timestamp()
    out = []
    for r in rows:
        try:
            t = datetime.fromisoformat(r["created_at"]).timestamp()
        except (ValueError, TypeError):
            continue
        if s <= t <= e:
            out.append(r)
    return out


def core_daily(day_s):
    d = datetime.now()
    if day_s:
        try:
            d = datetime(int(day_s[0:4]), int(day_s[5:7]), int(day_s[8:10]))
        except (ValueError, IndexError):
            return err_embed("Invalid Date", "Use format: `!daily YYYY-MM-DD`")
    start = d.replace(hour=0, minute=0, second=0, microsecond=0)
    end = d.replace(hour=23, minute=59, second=59, microsecond=0)
    rows = _in_range(sb.table("orders").select("*").execute().data or [], start, end)
    if not rows:
        return info_embed("No Orders", f"No orders found for {start.date()}.")
    return report_embed(f"📅 Daily Report - {start.date()}", rows)


def core_monthly(month_s):
    now_dt = datetime.now()
    try:
        y, m = (now_dt.year, now_dt.month) if not month_s else (int(month_s[0:4]), int(month_s[5:7]))
        if not 1 <= m <= 12:
            raise ValueError()
    except ValueError:
        return err_embed("Invalid Month", "Use format: `!monthly YYYY-MM`")
    start = datetime(y, m, 1)
    end = datetime(y + (m == 12), (m % 12) + 1, 1) - timedelta(seconds=1)
    rows = _in_range(sb.table("orders").select("*").execute().data or [], start, end)
    label = f"{y}-{m:02d}"
    if not rows:
        return info_embed("No Orders", f"No orders found for {label}.")
    return report_embed(f"🗓️ Monthly Report - {label}", rows)


def core_search(player_id):
    if not player_id:
        return err_embed("Invalid Usage", "Usage: `!search <PlayerID>`")
    rows = [r for r in (sb.table("orders").select("*").execute().data or []) if str(r["player_id"]) == str(player_id)]
    if not rows:
        return info_embed("No Orders", f"No orders found for player: {player_id}")
    n, revenue, cost, profit = summarize(rows)
    lines = [f'#{r["id"]} {r["product"]} | {fmt_lkr(r["price"])} | Profit: {fmt_lkr(float(r["price"]) - float(r["rate"]))}' for r in rows[:10]]
    em = discord.Embed(title=f"🔍 Orders for {player_id} ({n})", description="\n".join(lines), color=BLUE, timestamp=now())
    em.add_field(name="Total Spent", value=fmt_lkr(revenue), inline=True)
    em.add_field(name="Total Profit", value=fmt_lkr(profit), inline=True)
    return em


def core_history(tokens):
    limit, product, player = 20, None, None
    i = 0
    while i < len(tokens):
        if tokens[i] in ("-p", "--product") and i + 1 < len(tokens):
            product = tokens[i + 1].upper()
            i += 2
        elif tokens[i] in ("-u", "--player") and i + 1 < len(tokens):
            player = tokens[i + 1]
            i += 2
        elif tokens[i].isdigit():
            limit = min(max(int(tokens[i]), 1), 50)
            i += 1
        else:
            return err_embed("Invalid Usage", "Usage: `!history [limit] [-p Product] [-u PlayerID]`")
    rows = sb.table("orders").select("*").order("created_at", desc=True).limit(1000).execute().data or []
    if product:
        rows = [r for r in rows if str(r["product"]).upper() == product]
    if player:
        rows = [r for r in rows if str(r["player_id"]) == str(player)]
    if not rows:
        return info_embed("No History", "No orders match the filters.")
    shown = rows[:limit]
    n, revenue, cost, profit = summarize(shown)
    lines = [f'{j + 1}. #{r["id"]} {r["product"]} | {r["player_id"]} | {fmt_lkr(r["price"])}' for j, r in enumerate(shown)]
    em = discord.Embed(title=f"📜 Order History ({len(shown)}/{len(rows)})", description="\n".join(lines)[:4000], color=BLUE, timestamp=now())
    em.add_field(name="Revenue", value=fmt_lkr(revenue), inline=True)
    em.add_field(name="Net Profit", value=fmt_lkr(profit), inline=True)
    return em


def core_delete(order_id):
    if order_id is None:
        return err_embed("Invalid Usage", "Usage: `!delete <OrderID>`")
    existing = sb.table("orders").select("*").eq("id", order_id).execute().data
    if not existing:
        return err_embed("Not Found", f"No order found with ID: {order_id}")
    sb.table("orders").delete().eq("id", order_id).execute()
    o = existing[0]
    return ok_embed("Order Deleted", f"ID: {o['id']} | {o['product']} | Player: {o['player_id']}")


def core_edit(order_id, field, value):
    allowed = ["product", "player_id", "price", "rate"]
    if order_id is None or not field or value is None:
        return err_embed("Invalid Usage", "Usage: `!edit <OrderID> <field> <value>`\nFields: product, player_id, price, rate")
    if field not in allowed:
        return err_embed("Invalid Field", f"Field must be one of: {', '.join(allowed)}")
    patch = {}
    if field in ("price", "rate"):
        try:
            num = float(value)
            if num <= 0:
                raise ValueError()
            patch[field] = num
        except ValueError:
            return err_embed("Invalid Input", f"{field} must be a number greater than 0.")
    else:
        patch[field] = value
    updated = sb.table("orders").update(patch).eq("id", order_id).execute().data
    if not updated:
        return err_embed("Not Found", f"No order found with ID: {order_id}")
    o = updated[0]
    return ok_embed("Order Updated", f'ID: {o["id"]} | {o["product"]} | Player: {o["player_id"]} | Price: {fmt_lkr(o["price"])} | Rate: {fmt_lkr(o["rate"])}')


def core_export():
    rows = sb.table("orders").select("*").order("created_at", desc=True).limit(1000).execute().data or []
    if not rows:
        return info_embed("No Data", "No orders to export."), None
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "product", "player_id", "price", "rate", "profit", "created_at"])
    for o in rows:
        w.writerow([o["id"], o["product"], o["player_id"], o["price"], o["rate"], float(o["price"]) - float(o["rate"]), o["created_at"]])
    buf.seek(0)
    file = discord.File(io.BytesIO(buf.getvalue().encode()), filename=f'orders-{datetime.now().date()}.csv')
    return f"📤 Exported {len(rows)} orders.", file


def core_updaterates(source_text):
    items = parse_rate_list(source_text)
    if not items:
        return err_embed("No Rates Found", "Reply to the supplier rate message with `!updaterates`, or paste the list after the command.")
    for it in items:
        sb.table("rates").upsert({
            "product": it["product"], "rate": it["rate"],
            "category": it["category"], "updated_at": datetime.now(timezone.utc).isoformat(),
        }, on_conflict="product").execute()
    by_cat = {}
    for it in items:
        by_cat.setdefault(it["category"] or "Rates", []).append(f'{it["product"]}: {fmt_lkr(it["rate"])}')
    em = discord.Embed(title=f"✅ Rates Updated ({len(items)})", color=GREEN, timestamp=now())
    for cat, lines in list(by_cat.items())[:20]:
        em.add_field(name=cat, value="\n".join(lines)[:1000], inline=False)
    return em


def core_rates():
    rows = sb.table("rates").select("*").order("product").execute().data or []
    if not rows:
        return info_embed("No Rates", "No saved rates. Run `!updaterates` first.")
    by_cat = {}
    for r in rows:
        by_cat.setdefault(r.get("category") or "Rates", []).append(f'{r["product"]}: {fmt_lkr(r["rate"])}')
    em = discord.Embed(title=f"💲 Saved Rates ({len(rows)})", color=BLUE, timestamp=now())
    for cat, lines in list(by_cat.items())[:20]:
        em.add_field(name=cat, value="\n".join(lines)[:1000], inline=False)
    return em


def player_embed(p):
    em = discord.Embed(title=f'🎮 {p["nickname"]}', color=BLUE, timestamp=now())
    em.add_field(name="UID", value=str(p["uid"]), inline=True)
    em.add_field(name="Level", value=str(p.get("level") or "-"), inline=True)
    em.add_field(name="Likes", value=f'{int(p.get("likes") or 0):,}', inline=True)
    em.add_field(name="Region", value=str(p.get("region") or "-"), inline=True)
    em.add_field(name="BR Points", value=f'{int(p.get("br_points") or 0):,}', inline=True)
    em.add_field(name="CS Points", value=f'{int(p.get("cs_points") or 0):,}', inline=True)
    if p.get("guild"):
        em.add_field(name="Guild", value=f'{p["guild"]} (Lv {p.get("guild_level") or "-"} • {p.get("guild_members") or "-"} members)', inline=False)
    if p.get("bio"):
        em.add_field(name="Bio", value=str(p["bio"])[:500], inline=False)
    if p.get("avatar"):
        em.set_thumbnail(url=p["avatar"])
    return em


def help_embed():
    em = discord.Embed(title="🤖 Free Fire Top-Up Database - Commands", description="Works with `!` prefix and `/` slash commands.", color=GOLD, timestamp=now())
    em.add_field(name="`!add <Product> <PlayerID> <Price> [Rate] [-d YYYY-MM-DD] [-t HH:MM]`", value="Add order (rate auto-fills)", inline=False)
    em.add_field(name="`!sales [page]` / `!history [limit] [-p Product] [-u PlayerID]`", value="Browse orders", inline=False)
    em.add_field(name="`!profit` / `!daily [date]` / `!monthly [YYYY-MM]`", value="Profit reports", inline=False)
    em.add_field(name="`!search <PlayerID>` / `!player <UID>`", value="Player orders / live lookup", inline=False)
    em.add_field(name="`!updaterates` / `!rates`", value="Supplier rates", inline=False)
    em.add_field(name="`!verify @user` / `!unverify @user` / `!verified` / `!verifytoggle [on|off]`", value="Access control", inline=False)
    em.add_field(name="`!delete <ID>` / `!edit <ID> <field> <value>` / `!export`", value="Manage orders", inline=False)
    em.set_footer(text="Free Fire Top-Up Database")
    return em


def run_db(label, fn, *args):
    try:
        return fn(*args)
    except Denied:
        raise
    except Exception as e:
        logger.error(f"{label} error: {e}")
        return err_embed("Database Error", "Failed. Please try again later.")


@bot.event
async def on_ready():
    logger.info(f"Logged in as {bot.user}")
    try:
        if GUILD_ID:
            guild = discord.Object(id=int(GUILD_ID))
            bot.tree.copy_global_to(guild=guild)
            await bot.tree.sync(guild=guild)
            logger.info(f"Slash commands synced to guild {GUILD_ID}")
        else:
            await bot.tree.sync()
            logger.info("Slash commands synced globally")
    except Exception as e:
        logger.error(f"Slash sync failed: {e}")


@bot.event
async def on_command_error(ctx, error):
    if isinstance(error, commands.CommandNotFound):
        await ctx.reply(embed=err_embed("Unknown Command", f"Unknown command: `{ctx.invoked_with}`\nType `!help` for available commands."))
    elif isinstance(error, commands.MissingRequiredArgument):
        await ctx.reply(embed=err_embed("Invalid Usage", f"Missing argument: `{error.param.name}`"))
    else:
        logger.error(f"Command error !{ctx.invoked_with}: {error}")
        await ctx.reply(embed=err_embed("Error", "Something went wrong. Please try again."))


def _log_prefix(ctx):
    where = f"{ctx.guild.name} #{ctx.channel.name}" if ctx.guild else "DM"
    logger.info(f"CMD !{ctx.command} by {ctx.author} ({ctx.author.id}) in {where}")


@bot.command(name="add")
async def cmd_add(ctx, product: str = None, player_id: str = None, price: str = None, *, rest: str = ""):
    _log_prefix(ctx)
    try:
        check_verified(ctx.author.id)
    except Denied as d:
        await ctx.reply(embed=d.embed)
        return
    tokens = rest.split() if rest else []
    try:
        result = run_db("Add order", core_add, product, player_id, price, tokens, str(ctx.author))
    except Denied as d:
        await ctx.reply(embed=d.embed)
        return
    if isinstance(result, discord.Embed):
        await ctx.reply(embed=result)
        return
    data, price_f, rate_f, profit, created_at = result
    try:
        info = await lookup_player(player_id, timeout=8, retries=0)
        name = info["nickname"]
    except Exception:
        name = None
    await ctx.reply(embed=add_embed(data, product, player_id, price_f, rate_f, profit, created_at, name, str(ctx.author)))
    logger.info(f"DONE !add by {ctx.author}")


@bot.command(name="sales")
async def cmd_sales(ctx, page: int = 1):
    _log_prefix(ctx)
    try:
        check_verified(ctx.author.id)
        await ctx.reply(embed=run_db("Sales", core_sales, page))
    except Denied as d:
        await ctx.reply(embed=d.embed)
        return
    logger.info(f"DONE !sales by {ctx.author}")


@bot.command(name="profit")
async def cmd_profit(ctx):
    _log_prefix(ctx)
    try:
        check_verified(ctx.author.id)
        await ctx.reply(embed=run_db("Profit", core_profit))
    except Denied as d:
        await ctx.reply(embed=d.embed)
        return
    logger.info(f"DONE !profit by {ctx.author}")


@bot.command(name="delete")
async def cmd_delete(ctx, order_id: int = None):
    _log_prefix(ctx)
    try:
        check_verified(ctx.author.id)
        await ctx.reply(embed=run_db("Delete", core_delete, order_id))
    except Denied as d:
        await ctx.reply(embed=d.embed)
        return
    logger.info(f"DONE !delete by {ctx.author}")


@bot.command(name="edit")
async def cmd_edit(ctx, order_id: int = None, field: str = None, *, value: str = None):
    _log_prefix(ctx)
    try:
        check_verified(ctx.author.id)
        await ctx.reply(embed=run_db("Edit", core_edit, order_id, field, value))
    except Denied as d:
        await ctx.reply(embed=d.embed)
        return
    logger.info(f"DONE !edit by {ctx.author}")


@bot.command(name="daily")
async def cmd_daily(ctx, day: str = None):
    _log_prefix(ctx)
    try:
        check_verified(ctx.author.id)
        await ctx.reply(embed=run_db("Daily", core_daily, day))
    except Denied as d:
        await ctx.reply(embed=d.embed)
        return
    logger.info(f"DONE !daily by {ctx.author}")


@bot.command(name="monthly")
async def cmd_monthly(ctx, month: str = None):
    _log_prefix(ctx)
    try:
        check_verified(ctx.author.id)
        await ctx.reply(embed=run_db("Monthly", core_monthly, month))
    except Denied as d:
        await ctx.reply(embed=d.embed)
        return
    logger.info(f"DONE !monthly by {ctx.author}")


@bot.command(name="search")
async def cmd_search(ctx, player_id: str = None):
    _log_prefix(ctx)
    try:
        check_verified(ctx.author.id)
        await ctx.reply(embed=run_db("Search", core_search, player_id))
    except Denied as d:
        await ctx.reply(embed=d.embed)
        return
    logger.info(f"DONE !search by {ctx.author}")


@bot.command(name="history")
async def cmd_history(ctx, *args):
    _log_prefix(ctx)
    try:
        check_verified(ctx.author.id)
        await ctx.reply(embed=run_db("History", core_history, list(args)))
    except Denied as d:
        await ctx.reply(embed=d.embed)
        return
    logger.info(f"DONE !history by {ctx.author}")


@bot.command(name="export")
async def cmd_export(ctx):
    _log_prefix(ctx)
    try:
        check_verified(ctx.author.id)
        text, file = run_db("Export", core_export)
    except Denied as d:
        await ctx.reply(embed=d.embed)
        return
    if file is None:
        await ctx.reply(embed=text)
        return
    await ctx.reply(content=text, file=file)
    logger.info(f"DONE !export by {ctx.author}")


@bot.command(name="updaterates")
async def cmd_updaterates(ctx):
    _log_prefix(ctx)
    try:
        check_verified(ctx.author.id)
    except Denied as d:
        await ctx.reply(embed=d.embed)
        return
    try:
        if ctx.message.reference and ctx.message.reference.message_id:
            ref = await ctx.channel.fetch_message(ctx.message.reference.message_id)
            source = ref.content
        else:
            parts = ctx.message.content.split("\n", 1)
            source = parts[1] if len(parts) > 1 else ""
    except Exception:
        await ctx.reply(embed=err_embed("Fetch Failed", "Reply to the supplier rate message with `!updaterates`."))
        return
    await ctx.reply(embed=run_db("UpdateRates", core_updaterates, source))
    logger.info(f"DONE !updaterates by {ctx.author}")


@bot.command(name="rates")
async def cmd_rates(ctx):
    _log_prefix(ctx)
    try:
        check_verified(ctx.author.id)
        await ctx.reply(embed=run_db("Rates", core_rates))
    except Denied as d:
        await ctx.reply(embed=d.embed)
        return
    logger.info(f"DONE !rates by {ctx.author}")


@bot.command(name="player")
async def cmd_player(ctx, uid: str = None, region: str = None):
    _log_prefix(ctx)
    try:
        check_verified(ctx.author.id)
    except Denied as d:
        await ctx.reply(embed=d.embed)
        return
    if not uid:
        await ctx.reply(embed=err_embed("Invalid Usage", "Usage: `!player <UID> [region]`"))
        return
    try:
        p = await lookup_player(uid, region)
    except Exception as e:
        await ctx.reply(embed=err_embed("Lookup Failed", str(e)))
        return
    await ctx.reply(embed=player_embed(p))
    logger.info(f"DONE !player by {ctx.author}")


@bot.command(name="verify")
async def cmd_verify(ctx, member: discord.Member = None):
    _log_prefix(ctx)
    try:
        check_verified(ctx.author.id)
    except Denied as d:
        await ctx.reply(embed=d.embed)
        return
    if member is None:
        await ctx.reply(embed=err_embed("Invalid Usage", "Usage: `!verify @user`"))
        return
    try:
        sb.table("verified_users").upsert(
            {"user_id": str(member.id), "verified_by": str(ctx.author.id)}, on_conflict="user_id"
        ).execute()
        await ctx.reply(embed=ok_embed("User Verified", f"{member.mention} has been verified and can now use the bot."))
    except Exception as e:
        logger.error(f"Verify error: {e}")
        await ctx.reply(embed=err_embed("Database Error", "Failed to verify user."))
        return
    logger.info(f"DONE !verify by {ctx.author}")


@bot.command(name="unverify")
async def cmd_unverify(ctx, member: discord.Member = None):
    _log_prefix(ctx)
    try:
        check_verified(ctx.author.id)
    except Denied as d:
        await ctx.reply(embed=d.embed)
        return
    if member is None:
        await ctx.reply(embed=err_embed("Invalid Usage", "Usage: `!unverify @user`"))
        return
    if is_owner(member.id):
        await ctx.reply(embed=err_embed("Cannot Unverify", "You cannot unverify the bot owner."))
        return
    try:
        sb.table("verified_users").delete().eq("user_id", str(member.id)).execute()
        await ctx.reply(embed=ok_embed("User Unverified", f"{member.mention} has been unverified."))
    except Exception as e:
        logger.error(f"Unverify error: {e}")
        await ctx.reply(embed=err_embed("Database Error", "Failed to unverify user."))
        return
    logger.info(f"DONE !unverify by {ctx.author}")


@bot.command(name="verified")
async def cmd_verified(ctx):
    _log_prefix(ctx)
    try:
        check_verified(ctx.author.id)
    except Denied as d:
        await ctx.reply(embed=d.embed)
        return
    try:
        rows = sb.table("verified_users").select("user_id,verified_by,created_at").order("created_at", desc=True).execute().data or []
    except Exception as e:
        logger.error(f"Verified list error: {e}")
        await ctx.reply(embed=err_embed("Database Error", "Failed to fetch verified users."))
        return
    if not rows:
        await ctx.reply(embed=info_embed("No Verified Users", "No users are currently verified."))
        return
    em = discord.Embed(title="✅ Verified Users", color=BLUE, timestamp=now())
    for u in rows[:20]:
        em.add_field(name=f'<@{u["user_id"]}>', value=str(u.get("created_at", ""))[:19], inline=True)
    await ctx.reply(embed=em)
    logger.info(f"DONE !verified by {ctx.author}")


@bot.command(name="verifytoggle")
async def cmd_verifytoggle(ctx, mode: str = None):
    _log_prefix(ctx)
    perms = getattr(ctx.author, "guild_permissions", None)
    if not (is_owner(ctx.author.id) or (perms and perms.manage_guild) or is_verified(ctx.author.id)):
        await ctx.reply(embed=err_embed("Not Allowed", "Only the owner, server managers, or verified users can use this command."))
        return
    if not mode:
        on = verification_enabled()
        await ctx.reply(embed=info_embed("Verification Mode", "ON — only verified users can use commands." if on else "OFF — everyone can use commands."))
        return
    if mode.lower() not in ("on", "off"):
        await ctx.reply(embed=err_embed("Invalid Usage", "Usage: `!verifytoggle [on|off]`"))
        return
    try:
        sb.table("settings").upsert(
            {"key": "verification", "value": mode.lower(), "updated_at": datetime.now(timezone.utc).isoformat()}, on_conflict="key"
        ).execute()
        m = mode.lower()
        await ctx.reply(embed=discord.Embed(
            title="🔒 Verification ON" if m == "on" else "🔓 Verification OFF",
            description="Only verified users can use commands." if m == "on" else "Everyone can use commands.",
            color=GREEN if m == "on" else BLUE, timestamp=now()))
    except Exception as e:
        logger.error(f"VerifyToggle error: {e}")
        await ctx.reply(embed=err_embed("Database Error", "Failed to update setting."))
        return
    logger.info(f"DONE !verifytoggle by {ctx.author}")


@bot.command(name="help")
async def cmd_help(ctx):
    _log_prefix(ctx)
    await ctx.reply(embed=help_embed())


async def _slash_check(interaction):
    try:
        check_verified(interaction.user.id)
        return True
    except Denied as d:
        await interaction.response.send_message(embed=d.embed, ephemeral=True)
        return False


@bot.tree.command(name="add", description="Add a new order")
@app_commands.describe(product="Product (e.g. WEEKLY, 100DB)", playerid="Customer Free Fire UID", price="Selling price in LKR", rate="Cost rate (auto-fills if omitted)", date="Custom date YYYY-MM-DD", time="Custom time HH:MM")
async def slash_add(interaction: discord.Interaction, product: str, playerid: str, price: float, rate: float = None, date: str = None, time: str = None):
    if not await _slash_check(interaction):
        return
    await interaction.response.defer()
    tokens = ([str(rate)] if rate is not None else []) + ([x for x in (["-d", date] if date else []) + (["-t", time] if time else [])])
    try:
        result = core_add(product, playerid, str(price), tokens, str(interaction.user))
    except Exception as e:
        logger.error(f"Add order error: {e}")
        await interaction.followup.send(embed=err_embed("Database Error", "Failed to add order."))
        return
    if isinstance(result, discord.Embed):
        await interaction.followup.send(embed=result)
        return
    data, price_f, rate_f, profit, created_at = result
    try:
        info = await lookup_player(playerid, timeout=8, retries=0)
        name = info["nickname"]
    except Exception:
        name = None
    await interaction.followup.send(embed=add_embed(data, product, playerid, price_f, rate_f, profit, created_at, name, str(interaction.user)))


@bot.tree.command(name="sales", description="Browse sales, 5 per page")
async def slash_sales(interaction: discord.Interaction, page: int = 1):
    if not await _slash_check(interaction):
        return
    await interaction.response.defer()
    await interaction.followup.send(embed=run_db("Sales", core_sales, page))


@bot.tree.command(name="profit", description="Total profit summary")
async def slash_profit(interaction: discord.Interaction):
    if not await _slash_check(interaction):
        return
    await interaction.response.defer()
    await interaction.followup.send(embed=run_db("Profit", core_profit))


@bot.tree.command(name="delete", description="Delete an order")
async def slash_delete(interaction: discord.Interaction, order_id: int):
    if not await _slash_check(interaction):
        return
    await interaction.response.defer()
    await interaction.followup.send(embed=run_db("Delete", core_delete, order_id))


@bot.tree.command(name="edit", description="Edit an order field")
@app_commands.describe(order_id="Order ID", field="Field to edit", value="New value")
@app_commands.choices(field=[app_commands.Choice(name=f, value=f) for f in ("product", "player_id", "price", "rate")])
async def slash_edit(interaction: discord.Interaction, order_id: int, field: str, value: str):
    if not await _slash_check(interaction):
        return
    await interaction.response.defer()
    await interaction.followup.send(embed=run_db("Edit", core_edit, order_id, field, value))


@bot.tree.command(name="daily", description="Daily profit report")
async def slash_daily(interaction: discord.Interaction, date: str = None):
    if not await _slash_check(interaction):
        return
    await interaction.response.defer()
    await interaction.followup.send(embed=run_db("Daily", core_daily, date))


@bot.tree.command(name="monthly", description="Monthly profit report")
async def slash_monthly(interaction: discord.Interaction, month: str = None):
    if not await _slash_check(interaction):
        return
    await interaction.response.defer()
    await interaction.followup.send(embed=run_db("Monthly", core_monthly, month))


@bot.tree.command(name="search", description="Find all orders for a player")
async def slash_search(interaction: discord.Interaction, player_id: str):
    if not await _slash_check(interaction):
        return
    await interaction.response.defer()
    await interaction.followup.send(embed=run_db("Search", core_search, player_id))


@bot.tree.command(name="history", description="Full order history with filters")
async def slash_history(interaction: discord.Interaction, limit: int = 20, product: str = None, player_id: str = None):
    if not await _slash_check(interaction):
        return
    await interaction.response.defer()
    tokens = []
    if limit:
        tokens.append(str(limit))
    if product:
        tokens += ["-p", product]
    if player_id:
        tokens += ["-u", player_id]
    await interaction.followup.send(embed=run_db("History", core_history, tokens))


@bot.tree.command(name="export", description="Download all orders as CSV")
async def slash_export(interaction: discord.Interaction):
    if not await _slash_check(interaction):
        return
    await interaction.response.defer()
    text, file = run_db("Export", core_export)
    if file is None:
        await interaction.followup.send(embed=text)
        return
    await interaction.followup.send(content=text, file=file)


@bot.tree.command(name="updaterates", description="Scrape supplier rate list")
async def slash_updaterates(interaction: discord.Interaction, text: str = None):
    if not await _slash_check(interaction):
        return
    await interaction.response.defer()
    await interaction.followup.send(embed=run_db("UpdateRates", core_updaterates, text or ""))


@bot.tree.command(name="rates", description="View saved supplier rates")
async def slash_rates(interaction: discord.Interaction):
    if not await _slash_check(interaction):
        return
    await interaction.response.defer()
    await interaction.followup.send(embed=run_db("Rates", core_rates))


@bot.tree.command(name="player", description="Look up Free Fire player info")
async def slash_player(interaction: discord.Interaction, uid: str, region: str = None):
    if not await _slash_check(interaction):
        return
    await interaction.response.defer()
    try:
        p = await lookup_player(uid, region)
    except Exception as e:
        await interaction.followup.send(embed=err_embed("Lookup Failed", str(e)))
        return
    await interaction.followup.send(embed=player_embed(p))


@bot.tree.command(name="verify", description="Verify a user")
async def slash_verify(interaction: discord.Interaction, user: discord.Member):
    perms = getattr(interaction.user, "guild_permissions", None)
    if not await _slash_check(interaction):
        return
    try:
        sb.table("verified_users").upsert(
            {"user_id": str(user.id), "verified_by": str(interaction.user.id)}, on_conflict="user_id"
        ).execute()
        await interaction.followup.send(embed=ok_embed("User Verified", f"{user.mention} has been verified and can now use the bot."))
    except Exception as e:
        logger.error(f"Verify error: {e}")
        await interaction.followup.send(embed=err_embed("Database Error", "Failed to verify user."))


@bot.tree.command(name="unverify", description="Remove verification")
async def slash_unverify(interaction: discord.Interaction, user: discord.Member):
    if not await _slash_check(interaction):
        return
    if is_owner(user.id):
        await interaction.followup.send(embed=err_embed("Cannot Unverify", "You cannot unverify the bot owner."))
        return
    try:
        sb.table("verified_users").delete().eq("user_id", str(user.id)).execute()
        await interaction.followup.send(embed=ok_embed("User Unverified", f"{user.mention} has been unverified."))
    except Exception as e:
        logger.error(f"Unverify error: {e}")
        await interaction.followup.send(embed=err_embed("Database Error", "Failed to unverify user."))


@bot.tree.command(name="verified", description="List verified users")
async def slash_verified(interaction: discord.Interaction):
    if not await _slash_check(interaction):
        return
    await interaction.response.defer()
    try:
        rows = sb.table("verified_users").select("user_id,verified_by,created_at").order("created_at", desc=True).execute().data or []
    except Exception as e:
        logger.error(f"Verified list error: {e}")
        await interaction.followup.send(embed=err_embed("Database Error", "Failed to fetch verified users."))
        return
    if not rows:
        await interaction.followup.send(embed=info_embed("No Verified Users", "No users are currently verified."))
        return
    em = discord.Embed(title="✅ Verified Users", color=BLUE, timestamp=now())
    for u in rows[:20]:
        em.add_field(name=f'<@{u["user_id"]}>', value=str(u.get("created_at", ""))[:19], inline=True)
    await interaction.followup.send(embed=em)


@bot.tree.command(name="verifytoggle", description="Toggle verified-only mode")
@app_commands.choices(mode=[app_commands.Choice(name="on", value="on"), app_commands.Choice(name="off", value="off")])
async def slash_verifytoggle(interaction: discord.Interaction, mode: str = None):
    member = interaction.user
    perms = getattr(member, "guild_permissions", None)
    if not (is_owner(member.id) or (perms and perms.manage_guild) or is_verified(member.id)):
        await interaction.response.send_message(embed=err_embed("Not Allowed", "Only the owner, server managers, or verified users can use this command."), ephemeral=True)
        return
    await interaction.response.defer()
    if not mode:
        on = verification_enabled()
        await interaction.followup.send(embed=info_embed("Verification Mode", "ON — only verified users can use commands." if on else "OFF — everyone can use commands."))
        return
    try:
        sb.table("settings").upsert(
            {"key": "verification", "value": mode, "updated_at": datetime.now(timezone.utc).isoformat()}, on_conflict="key"
        ).execute()
        await interaction.followup.send(embed=discord.Embed(
            title="🔒 Verification ON" if mode == "on" else "🔓 Verification OFF",
            description="Only verified users can use commands." if mode == "on" else "Everyone can use commands.",
            color=GREEN if mode == "on" else BLUE, timestamp=now()))
    except Exception as e:
        logger.error(f"VerifyToggle error: {e}")
        await interaction.followup.send(embed=err_embed("Database Error", "Failed to update setting."))


@bot.tree.command(name="help", description="Show all commands")
async def slash_help(interaction: discord.Interaction):
    await interaction.response.send_message(embed=help_embed())


if __name__ == "__main__":
    token = os.environ.get("DISCORD_TOKEN", "")
    if not token:
        raise SystemExit("Set DISCORD_TOKEN in .env")
    bot.run(token)
