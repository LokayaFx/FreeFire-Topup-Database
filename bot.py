import asyncio
import csv
import io
import logging
import logging.handlers
import os
import re
from datetime import datetime, timedelta

import aiohttp
import discord
from discord.ext import commands
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

LOG_DIR = os.environ.get("LOG_DIR", os.path.join(os.path.dirname(__file__), "..", "logs"))
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
FF_API_URL = (os.environ.get("FF_API_URL", "https://freefire-idinfo.vercel.app")).rstrip("/")

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

intents = discord.Intents.default()
intents.message_content = True
bot = commands.Bot(command_prefix="!", intents=intents, help_command=None)

GREEN, RED, BLUE, GOLD = 0x2ECC71, 0xE74C3C, 0x3498DB, 0xF1C40F


def fmt_lkr(amount):
    return f"LKR {float(amount):,.2f}"


def err_embed(title, description):
    return discord.Embed(title=f"❌ {title}", description=description, color=RED, timestamp=datetime.utcnow())


def ok_embed(title, description):
    return discord.Embed(title=f"✅ {title}", description=description, color=GREEN, timestamp=datetime.utcnow())


def info_embed(title, description):
    return discord.Embed(title=f"ℹ️ {title}", description=description, color=BLUE, timestamp=datetime.utcnow())


def is_verified(user_id):
    if OWNER_ID and str(user_id) == str(OWNER_ID):
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


async def require_verification(ctx):
    if OWNER_ID and str(ctx.author.id) == str(OWNER_ID):
        return True
    if not verification_enabled():
        return True
    if is_verified(ctx.author.id):
        return True
    await ctx.reply(embed=err_embed("Not Verified", "You are not verified to use this bot. Contact an admin to get verified."))
    return False


async def require_admin(ctx):
    if OWNER_ID and str(ctx.author.id) == str(OWNER_ID):
        return True
    perms = getattr(ctx.author, "guild_permissions", None)
    if perms and perms.manage_guild:
        return True
    if is_verified(ctx.author.id):
        return True
    await ctx.reply(embed=err_embed("Not Allowed", "Only the owner, server managers, or verified users can use this command."))
    return False


def log_cmd(ctx):
    where = f"{ctx.guild.name} #{ctx.channel.name}" if ctx.guild else "DM"
    logger.info(f"CMD !{ctx.command} by {ctx.author} ({ctx.author.id}) in {where} args: {ctx.message.content}")


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
            except (ValueError, asyncio.TimeoutError) as e:
                if isinstance(e, ValueError) and (str(e) == "Player not found." or str(e).startswith("Lookup failed (HTTP")):
                    raise
                last_error = Exception("Lookup timed out. Try again.") if isinstance(e, asyncio.TimeoutError) else e
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


def parse_flags(args, start=0):
    date, time = None, None
    i = start
    while i < len(args):
        if args[i] in ("-d", "--date"):
            date = args[i + 1] if i + 1 < len(args) else None
            i += 2
        elif args[i] in ("-t", "--time"):
            time = args[i + 1] if i + 1 < len(args) else None
            i += 2
        else:
            i += 1
    return date, time


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


@bot.event
async def on_ready():
    logger.info(f"Logged in as {bot.user}")


@bot.event
async def on_command_error(ctx, error):
    if isinstance(error, commands.CommandNotFound):
        await ctx.reply(embed=err_embed("Unknown Command", f"Unknown command: `{ctx.invoked_with}`\nType `!help` for available commands."))
    elif isinstance(error, commands.MissingRequiredArgument):
        await ctx.reply(embed=err_embed("Invalid Usage", f"Missing argument: `{error.param.name}`\nType `!help {ctx.invoked_with}` for usage."))
    else:
        logger.error(f"Command error !{ctx.invoked_with}: {error}")
        await ctx.reply(embed=err_embed("Error", "Something went wrong. Please try again."))


@bot.command(name="add")
async def cmd_add(ctx, product: str = None, player_id: str = None, price: str = None, *, rest: str = ""):
    log_cmd(ctx)
    if not product or not player_id or not price:
        await ctx.reply(embed=err_embed("Invalid Usage", "Usage: `!add <Product> <PlayerID> <Price> [Rate] [-d YYYY-MM-DD] [-t HH:MM]`\nExample: `!add 100DB 123456789 350 290`"))
        return
    if not await require_verification(ctx):
        return
    tokens = rest.split() if rest else []
    rate_arg = None
    if tokens and not tokens[0].startswith("-"):
        rate_arg = tokens[0]
        tokens = tokens[1:]
    custom_date, custom_time = parse_flags(tokens, 0)
    try:
        price_f = float(price)
        if price_f <= 0:
            raise ValueError()
    except ValueError:
        await ctx.reply(embed=err_embed("Invalid Input", "Price must be a valid number greater than 0."))
        return
    if rate_arg is not None:
        try:
            rate_f = float(rate_arg)
            if rate_f <= 0:
                raise ValueError()
        except ValueError:
            await ctx.reply(embed=err_embed("Invalid Input", "Rate must be a valid number greater than 0."))
            return
    else:
        res = sb.table("rates").select("*").eq("product", product.strip().upper()).execute()
        if not res.data:
            await ctx.reply(embed=err_embed("Rate Not Found", f'No saved rate for "{product}".\nGive rate manually or run `!updaterates` first.'))
            return
        rate_f = float(res.data[0]["rate"])
    try:
        created_at = build_datetime(custom_date, custom_time)
    except ValueError as e:
        await ctx.reply(embed=err_embed("Invalid Date/Time", str(e)))
        return
    profit = price_f - rate_f
    try:
        data = sb.table("orders").insert({
            "product": product, "player_id": player_id,
            "price": price_f, "rate": rate_f,
            "created_at": created_at.isoformat(),
        }).execute().data[0]
    except Exception as e:
        logger.error(f"Add order error: {e}")
        await ctx.reply(embed=err_embed("Database Error", "Failed to add order. Please try again later."))
        return
    try:
        info = await lookup_player(player_id, timeout=8, retries=0)
        name = info["nickname"]
    except Exception:
        name = None
    em = discord.Embed(title="📦 New Order Added", color=GREEN, timestamp=datetime.utcnow())
    em.add_field(name="Product", value=product, inline=True)
    em.add_field(name="Player ID", value=player_id, inline=True)
    if name:
        em.add_field(name="Player Name", value=name, inline=True)
    em.add_field(name="Price", value=fmt_lkr(price_f), inline=True)
    em.add_field(name="Rate", value=fmt_lkr(rate_f), inline=True)
    em.add_field(name="Profit", value=fmt_lkr(profit), inline=True)
    em.add_field(name="Order ID", value=str(data["id"]), inline=True)
    em.set_footer(text=f"Added by {ctx.author}")
    await ctx.reply(embed=em)
    logger.info(f"DONE !add by {ctx.author}")


@bot.command(name="sales")
async def cmd_sales(ctx, page: int = 1):
    log_cmd(ctx)
    if not await require_verification(ctx):
        return
    if page < 1:
        await ctx.reply(embed=err_embed("Invalid Page", "Usage: `!sales [page]`"))
        return
    try:
        rows = sb.table("orders").select("*").order("created_at", desc=True).limit(1000).execute().data or []
    except Exception as e:
        logger.error(f"Sales error: {e}")
        await ctx.reply(embed=err_embed("Database Error", "Failed to fetch sales."))
        return
    if not rows:
        await ctx.reply(embed=info_embed("No Sales", "No orders found in the database."))
        return
    size, total = 5, len(rows)
    pages = (total + size - 1) // size
    if page > pages:
        await ctx.reply(embed=err_embed("Invalid Page", f"Only {pages} page(s) available ({total} orders)."))
        return
    chunk = rows[(page - 1) * size:page * size]
    em = discord.Embed(title=f"📊 Sales - Page {page}/{pages}", color=BLUE, timestamp=datetime.utcnow())
    em.set_footer(text=f"Total {total} orders • Use !sales {page + 1} for next page")
    for i, o in enumerate(chunk):
        profit = float(o["price"]) - float(o["rate"])
        em.add_field(
            name=f'#{(page - 1) * size + i + 1} - {o["product"]} (ID: {o["id"]})',
            value=f'Player: {o["player_id"]}\nPrice: {fmt_lkr(o["price"])} | Rate: {fmt_lkr(o["rate"])} | Profit: {fmt_lkr(profit)}',
            inline=False,
        )
    await ctx.reply(embed=em)
    logger.info(f"DONE !sales by {ctx.author}")


def _summarize(rows):
    revenue = sum(float(o["price"]) for o in rows)
    cost = sum(float(o["rate"]) for o in rows)
    return len(rows), revenue, cost, revenue - cost


@bot.command(name="profit")
async def cmd_profit(ctx):
    log_cmd(ctx)
    if not await require_verification(ctx):
        return
    try:
        rows = sb.table("orders").select("price,rate").execute().data or []
    except Exception as e:
        logger.error(f"Profit error: {e}")
        await ctx.reply(embed=err_embed("Database Error", "Failed to calculate profit."))
        return
    if not rows:
        await ctx.reply(embed=info_embed("No Data", "No orders found to calculate profit."))
        return
    n, revenue, cost, profit = _summarize(rows)
    em = discord.Embed(title="💰 Total Profit Summary", color=GREEN if profit >= 0 else RED, timestamp=datetime.utcnow())
    em.add_field(name="Total Orders", value=str(n), inline=True)
    em.add_field(name="Total Revenue", value=fmt_lkr(revenue), inline=True)
    em.add_field(name="Total Cost", value=fmt_lkr(cost), inline=True)
    em.add_field(name="Net Profit", value=fmt_lkr(profit), inline=False)
    await ctx.reply(embed=em)
    logger.info(f"DONE !profit by {ctx.author}")


@bot.command(name="delete")
async def cmd_delete(ctx, order_id: int = None):
    log_cmd(ctx)
    if not await require_verification(ctx):
        return
    if order_id is None:
        await ctx.reply(embed=err_embed("Invalid Usage", "Usage: `!delete <OrderID>`"))
        return
    try:
        existing = sb.table("orders").select("*").eq("id", order_id).execute().data
        if not existing:
            await ctx.reply(embed=err_embed("Not Found", f"No order found with ID: {order_id}"))
            return
        sb.table("orders").delete().eq("id", order_id).execute()
        o = existing[0]
        await ctx.reply(embed=ok_embed("Order Deleted", f"ID: {o['id']} | {o['product']} | Player: {o['player_id']}"))
    except Exception as e:
        logger.error(f"Delete error: {e}")
        await ctx.reply(embed=err_embed("Database Error", "Failed to delete order."))
        return
    logger.info(f"DONE !delete by {ctx.author}")


@bot.command(name="edit")
async def cmd_edit(ctx, order_id: int = None, field: str = None, *, value: str = None):
    log_cmd(ctx)
    if not await require_verification(ctx):
        return
    allowed = ["product", "player_id", "price", "rate"]
    if order_id is None or not field or value is None:
        await ctx.reply(embed=err_embed("Invalid Usage", "Usage: `!edit <OrderID> <field> <value>`\nFields: product, player_id, price, rate"))
        return
    if field not in allowed:
        await ctx.reply(embed=err_embed("Invalid Field", f"Field must be one of: {', '.join(allowed)}"))
        return
    patch = {}
    if field in ("price", "rate"):
        try:
            num = float(value)
            if num <= 0:
                raise ValueError()
            patch[field] = num
        except ValueError:
            await ctx.reply(embed=err_embed("Invalid Input", f"{field} must be a number greater than 0."))
            return
    else:
        patch[field] = value
    try:
        updated = sb.table("orders").update(patch).eq("id", order_id).execute().data
        if not updated:
            await ctx.reply(embed=err_embed("Not Found", f"No order found with ID: {order_id}"))
            return
        o = updated[0]
        await ctx.reply(embed=ok_embed("Order Updated", f'ID: {o["id"]} | {o["product"]} | Player: {o["player_id"]} | Price: {fmt_lkr(o["price"])} | Rate: {fmt_lkr(o["rate"])}'))
    except Exception as e:
        logger.error(f"Edit error: {e}")
        await ctx.reply(embed=err_embed("Database Error", "Failed to update order."))
        return
    logger.info(f"DONE !edit by {ctx.author}")


def _range_report(title, start, end):
    rows = sb.table("orders").select("*").execute().data or []
    s, e = start.timestamp(), end.timestamp()
    return [r for r in rows if s <= datetime.fromisoformat(r["created_at"]).timestamp() <= e]


@bot.command(name="daily")
async def cmd_daily(ctx, day: str = None):
    log_cmd(ctx)
    if not await require_verification(ctx):
        return
    try:
        d = datetime.now() if not day else datetime(int(day[0:4]), int(day[5:7]), int(day[8:10]))
    except (ValueError, IndexError):
        await ctx.reply(embed=err_embed("Invalid Date", "Use format: `!daily YYYY-MM-DD`"))
        return
    start = d.replace(hour=0, minute=0, second=0, microsecond=0)
    end = d.replace(hour=23, minute=59, second=59, microsecond=0)
    try:
        rows = _range_report("", start, end)
    except Exception as e:
        logger.error(f"Daily error: {e}")
        await ctx.reply(embed=err_embed("Database Error", "Failed to fetch daily report."))
        return
    if not rows:
        await ctx.reply(embed=info_embed("No Orders", f"No orders found for {start.date()}."))
        return
    n, revenue, cost, profit = _summarize(rows)
    em = discord.Embed(title=f"📅 Daily Report - {start.date()}", color=GREEN if profit >= 0 else RED, timestamp=datetime.utcnow())
    em.add_field(name="Orders", value=str(n), inline=True)
    em.add_field(name="Revenue", value=fmt_lkr(revenue), inline=True)
    em.add_field(name="Cost", value=fmt_lkr(cost), inline=True)
    em.add_field(name="Net Profit", value=fmt_lkr(profit), inline=False)
    await ctx.reply(embed=em)
    logger.info(f"DONE !daily by {ctx.author}")


@bot.command(name="monthly")
async def cmd_monthly(ctx, month: str = None):
    log_cmd(ctx)
    if not await require_verification(ctx):
        return
    now = datetime.now()
    try:
        y, m = (now.year, now.month) if not month else (int(month[0:4]), int(month[5:7]))
        if not 1 <= m <= 12:
            raise ValueError()
    except ValueError:
        await ctx.reply(embed=err_embed("Invalid Month", "Use format: `!monthly YYYY-MM`"))
        return
    start = datetime(y, m, 1)
    end = (datetime(y + (m == 12), (m % 12) + 1, 1) - timedelta(seconds=1))
    try:
        rows = _range_report("", start, end)
    except Exception as e:
        logger.error(f"Monthly error: {e}")
        await ctx.reply(embed=err_embed("Database Error", "Failed to fetch monthly report."))
        return
    label = f"{y}-{m:02d}"
    if not rows:
        await ctx.reply(embed=info_embed("No Orders", f"No orders found for {label}."))
        return
    n, revenue, cost, profit = _summarize(rows)
    em = discord.Embed(title=f"🗓️ Monthly Report - {label}", color=GREEN if profit >= 0 else RED, timestamp=datetime.utcnow())
    em.add_field(name="Orders", value=str(n), inline=True)
    em.add_field(name="Revenue", value=fmt_lkr(revenue), inline=True)
    em.add_field(name="Cost", value=fmt_lkr(cost), inline=True)
    em.add_field(name="Net Profit", value=fmt_lkr(profit), inline=False)
    await ctx.reply(embed=em)
    logger.info(f"DONE !monthly by {ctx.author}")


@bot.command(name="search")
async def cmd_search(ctx, player_id: str = None):
    log_cmd(ctx)
    if not await require_verification(ctx):
        return
    if not player_id:
        await ctx.reply(embed=err_embed("Invalid Usage", "Usage: `!search <PlayerID>`"))
        return
    try:
        rows = [r for r in (sb.table("orders").select("*").execute().data or []) if str(r["player_id"]) == str(player_id)]
    except Exception as e:
        logger.error(f"Search error: {e}")
        await ctx.reply(embed=err_embed("Database Error", "Failed to search orders."))
        return
    if not rows:
        await ctx.reply(embed=info_embed("No Orders", f"No orders found for player: {player_id}"))
        return
    n, revenue, cost, profit = _summarize(rows)
    lines = [f'#{r["id"]} {r["product"]} | {fmt_lkr(r["price"])} | Profit: {fmt_lkr(float(r["price"]) - float(r["rate"]))}' for r in rows[:10]]
    em = discord.Embed(title=f"🔍 Orders for {player_id} ({n})", description="\n".join(lines), color=BLUE, timestamp=datetime.utcnow())
    em.add_field(name="Total Spent", value=fmt_lkr(revenue), inline=True)
    em.add_field(name="Total Profit", value=fmt_lkr(profit), inline=True)
    await ctx.reply(embed=em)
    logger.info(f"DONE !search by {ctx.author}")


@bot.command(name="history")
async def cmd_history(ctx, *args):
    log_cmd(ctx)
    if not await require_verification(ctx):
        return
    limit, product, player = 20, None, None
    i = 0
    args = list(args)
    while i < len(args):
        if args[i] in ("-p", "--product") and i + 1 < len(args):
            product = args[i + 1].upper()
            i += 2
        elif args[i] in ("-u", "--player") and i + 1 < len(args):
            player = args[i + 1]
            i += 2
        elif args[i].isdigit():
            limit = min(max(int(args[i]), 1), 50)
            i += 1
        else:
            await ctx.reply(embed=err_embed("Invalid Usage", "Usage: `!history [limit] [-p Product] [-u PlayerID]`"))
            return
    try:
        rows = sb.table("orders").select("*").order("created_at", desc=True).limit(1000).execute().data or []
    except Exception as e:
        logger.error(f"History error: {e}")
        await ctx.reply(embed=err_embed("Database Error", "Failed to fetch history."))
        return
    if product:
        rows = [r for r in rows if str(r["product"]).upper() == product]
    if player:
        rows = [r for r in rows if str(r["player_id"]) == str(player)]
    if not rows:
        await ctx.reply(embed=info_embed("No History", "No orders match the filters."))
        return
    shown = rows[:limit]
    n, revenue, cost, profit = _summarize(shown)
    lines = [f'{j + 1}. #{r["id"]} {r["product"]} | {r["player_id"]} | {fmt_lkr(r["price"])}' for j, r in enumerate(shown)]
    em = discord.Embed(title=f"📜 Order History ({len(shown)}/{len(rows)})", description="\n".join(lines)[:4000], color=BLUE, timestamp=datetime.utcnow())
    em.add_field(name="Revenue", value=fmt_lkr(revenue), inline=True)
    em.add_field(name="Net Profit", value=fmt_lkr(profit), inline=True)
    await ctx.reply(embed=em)
    logger.info(f"DONE !history by {ctx.author}")


@bot.command(name="export")
async def cmd_export(ctx):
    log_cmd(ctx)
    if not await require_verification(ctx):
        return
    try:
        rows = sb.table("orders").select("*").order("created_at", desc=True).limit(1000).execute().data or []
    except Exception as e:
        logger.error(f"Export error: {e}")
        await ctx.reply(embed=err_embed("Database Error", "Failed to export orders."))
        return
    if not rows:
        await ctx.reply(embed=info_embed("No Data", "No orders to export."))
        return
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "product", "player_id", "price", "rate", "profit", "created_at"])
    for o in rows:
        w.writerow([o["id"], o["product"], o["player_id"], o["price"], o["rate"], float(o["price"]) - float(o["rate"]), o["created_at"]])
    buf.seek(0)
    file = discord.File(io.BytesIO(buf.getvalue().encode()), filename=f'orders-{datetime.now().date()}.csv')
    await ctx.reply(content=f"📤 Exported {len(rows)} orders.", file=file)
    logger.info(f"DONE !export by {ctx.author}")


@bot.command(name="updaterates")
async def cmd_updaterates(ctx):
    log_cmd(ctx)
    if not await require_verification(ctx):
        return
    source = ""
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
    items = parse_rate_list(source)
    if not items:
        await ctx.reply(embed=err_embed("No Rates Found", "Reply to the supplier rate message with `!updaterates`, or paste the list after the command."))
        return
    try:
        for it in items:
            sb.table("rates").upsert({
                "product": it["product"], "rate": it["rate"],
                "category": it["category"], "updated_at": datetime.utcnow().isoformat(),
            }, on_conflict="product").execute()
    except Exception as e:
        logger.error(f"UpdateRates error: {e}")
        await ctx.reply(embed=err_embed("Database Error", "Failed to save rates."))
        return
    by_cat = {}
    for it in items:
        by_cat.setdefault(it["category"] or "Rates", []).append(f'{it["product"]}: {fmt_lkr(it["rate"])}')
    em = discord.Embed(title=f"✅ Rates Updated ({len(items)})", color=GREEN, timestamp=datetime.utcnow())
    for cat, lines in list(by_cat.items())[:20]:
        em.add_field(name=cat, value="\n".join(lines)[:1000], inline=False)
    await ctx.reply(embed=em)
    logger.info(f"DONE !updaterates by {ctx.author}")


@bot.command(name="rates")
async def cmd_rates(ctx):
    log_cmd(ctx)
    if not await require_verification(ctx):
        return
    try:
        rows = sb.table("rates").select("*").order("product").execute().data or []
    except Exception as e:
        logger.error(f"Rates error: {e}")
        await ctx.reply(embed=err_embed("Database Error", "Failed to fetch rates."))
        return
    if not rows:
        await ctx.reply(embed=info_embed("No Rates", "No saved rates. Run `!updaterates` first."))
        return
    by_cat = {}
    for r in rows:
        by_cat.setdefault(r.get("category") or "Rates", []).append(f'{r["product"]}: {fmt_lkr(r["rate"])}')
    em = discord.Embed(title=f"💲 Saved Rates ({len(rows)})", color=BLUE, timestamp=datetime.utcnow())
    for cat, lines in list(by_cat.items())[:20]:
        em.add_field(name=cat, value="\n".join(lines)[:1000], inline=False)
    await ctx.reply(embed=em)
    logger.info(f"DONE !rates by {ctx.author}")


@bot.command(name="player")
async def cmd_player(ctx, uid: str = None, region: str = None):
    log_cmd(ctx)
    if not await require_verification(ctx):
        return
    if not uid:
        await ctx.reply(embed=err_embed("Invalid Usage", "Usage: `!player <UID> [region]`"))
        return
    try:
        p = await lookup_player(uid, region)
    except Exception as e:
        await ctx.reply(embed=err_embed("Lookup Failed", str(e)))
        return
    em = discord.Embed(title=f'🎮 {p["nickname"]}', color=BLUE, timestamp=datetime.utcnow())
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
    await ctx.reply(embed=em)
    logger.info(f"DONE !player by {ctx.author}")


@bot.command(name="verify")
async def cmd_verify(ctx, member: discord.Member = None):
    log_cmd(ctx)
    if not await require_verification(ctx):
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
    log_cmd(ctx)
    if not await require_verification(ctx):
        return
    if member is None:
        await ctx.reply(embed=err_embed("Invalid Usage", "Usage: `!unverify @user`"))
        return
    if OWNER_ID and str(member.id) == str(OWNER_ID):
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
    log_cmd(ctx)
    if not await require_verification(ctx):
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
    em = discord.Embed(title="✅ Verified Users", color=BLUE, timestamp=datetime.utcnow())
    for u in rows[:20]:
        em.add_field(name=f'<@{u["user_id"]}>', value=str(u.get("created_at", ""))[:19], inline=True)
    await ctx.reply(embed=em)
    logger.info(f"DONE !verified by {ctx.author}")


@bot.command(name="verifytoggle")
async def cmd_verifytoggle(ctx, mode: str = None):
    log_cmd(ctx)
    perms = getattr(ctx.author, "guild_permissions", None)
    allowed = (OWNER_ID and str(ctx.author.id) == str(OWNER_ID)) or (perms and perms.manage_guild) or is_verified(ctx.author.id)
    if not allowed:
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
            {"key": "verification", "value": mode.lower(), "updated_at": datetime.utcnow().isoformat()}, on_conflict="key"
        ).execute()
        m = mode.lower()
        await ctx.reply(embed=discord.Embed(
            title="🔒 Verification ON" if m == "on" else "🔓 Verification OFF",
            description="Only verified users can use commands." if m == "on" else "Everyone can use commands.",
            color=GREEN if m == "on" else BLUE, timestamp=datetime.utcnow()))
    except Exception as e:
        logger.error(f"VerifyToggle error: {e}")
        await ctx.reply(embed=err_embed("Database Error", "Failed to update setting."))
        return
    logger.info(f"DONE !verifytoggle by {ctx.author}")


@bot.command(name="help")
async def cmd_help(ctx):
    log_cmd(ctx)
    em = discord.Embed(title="🤖 Free Fire Top-Up Database - Commands", description="Works with `!` prefix.", color=GOLD, timestamp=datetime.utcnow())
    em.add_field(name="`!add <Product> <PlayerID> <Price> [Rate] [-d YYYY-MM-DD] [-t HH:MM]`", value="Add order (rate auto-fills)", inline=False)
    em.add_field(name="`!sales [page]` / `!history [limit] [-p Product] [-u PlayerID]`", value="Browse orders", inline=False)
    em.add_field(name="`!profit` / `!daily [date]` / `!monthly [YYYY-MM]`", value="Profit reports", inline=False)
    em.add_field(name="`!search <PlayerID>` / `!player <UID>`", value="Player orders / live lookup", inline=False)
    em.add_field(name="`!updaterates` / `!rates`", value="Supplier rates", inline=False)
    em.add_field(name="`!verify @user` / `!unverify @user` / `!verified` / `!verifytoggle [on|off]`", value="Access control", inline=False)
    em.add_field(name="`!delete <ID>` / `!edit <ID> <field> <value>` / `!export`", value="Manage orders", inline=False)
    em.set_footer(text="Free Fire Top-Up Database")
    await ctx.reply(embed=em)


if __name__ == "__main__":
    token = os.environ.get("DISCORD_TOKEN", "")
    if not token:
        raise SystemExit("Set DISCORD_TOKEN in .env")
    bot.run(token)
