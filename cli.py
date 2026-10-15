import asyncio
import os
import sys

try:
    sys.stdout.reconfigure(errors="replace")
except Exception:
    pass

sys.path.insert(0, os.path.dirname(__file__))

from bot import build_datetime, fmt_lkr, lookup_player, parse_flags, sb  # noqa: E402


def cmd_add(args):
    if len(args) < 3:
        print("Usage: python cli.py add <Product> <PlayerID> <Price> [Rate] [-d YYYY-MM-DD] [-t HH:MM]")
        return 1
    product, player_id = args[0], args[1]
    try:
        price = float(args[2])
        if price <= 0:
            raise ValueError()
    except ValueError:
        print("Price must be a valid number greater than 0.")
        return 1
    rest = args[3:]
    rate_arg = None
    if rest and not rest[0].startswith("-"):
        rate_arg = rest[0]
        rest = rest[1:]
    if rate_arg is not None:
        try:
            rate = float(rate_arg)
            if rate <= 0:
                raise ValueError()
        except ValueError:
            print("Rate must be a valid number greater than 0.")
            return 1
    else:
        saved = sb.table("rates").select("*").eq("product", product.strip().upper()).execute().data
        if not saved:
            print(f'No saved rate for "{product}". Give rate manually.')
            return 1
        rate = float(saved[0]["rate"])
    custom_date, custom_time = parse_flags(rest, 0)
    try:
        created_at = build_datetime(custom_date, custom_time)
    except ValueError as e:
        print(e)
        return 1
    data = sb.table("orders").insert({
        "product": product, "player_id": player_id, "price": price,
        "rate": rate, "created_at": created_at.isoformat(),
    }).execute().data[0]
    print(f'Order added | ID: {data["id"]} | {product} | Player: {player_id} | Price: {fmt_lkr(price)} | Rate: {fmt_lkr(rate)} | Profit: {fmt_lkr(price - rate)}')
    return 0


def cmd_sales(args):
    page = 1
    if args:
        try:
            page = int(args[0])
            if page < 1:
                raise ValueError()
        except ValueError:
            print("Usage: python cli.py sales [page]")
            return 1
    rows = sb.table("orders").select("*").order("created_at", desc=True).limit(1000).execute().data or []
    if not rows:
        print("No orders found.")
        return 0
    size = 5
    pages = (len(rows) + size - 1) // size
    if page > pages:
        print(f"Only {pages} page(s) available ({len(rows)} orders).")
        return 1
    print(f"Sales - Page {page}/{pages} (Total {len(rows)} orders)")
    for i, o in enumerate(rows[(page - 1) * size:page * size], start=(page - 1) * size + 1):
        print(f'{i}. #{o["id"]} {o["product"]} | {o["player_id"]} | Price: {fmt_lkr(o["price"])} | Profit: {fmt_lkr(float(o["price"]) - float(o["rate"]))}')
    return 0


def cmd_profit(_args):
    rows = sb.table("orders").select("price,rate").execute().data or []
    if not rows:
        print("No orders found.")
        return 0
    revenue = sum(float(o["price"]) for o in rows)
    cost = sum(float(o["rate"]) for o in rows)
    print(f"Total Orders: {len(rows)}")
    print(f"Total Revenue: {fmt_lkr(revenue)}")
    print(f"Total Cost: {fmt_lkr(cost)}")
    print(f"Net Profit: {fmt_lkr(revenue - cost)}")
    return 0


def cmd_search(args):
    if not args:
        print("Usage: python cli.py search <PlayerID>")
        return 1
    rows = [r for r in (sb.table("orders").select("*").execute().data or []) if str(r["player_id"]) == str(args[0])]
    if not rows:
        print(f"No orders for player: {args[0]}")
        return 0
    for o in rows:
        print(f'#{o["id"]} {o["product"]} | Price: {fmt_lkr(o["price"])} | Profit: {fmt_lkr(float(o["price"]) - float(o["rate"]))}')
    return 0


def cmd_player(args):
    if not args:
        print("Usage: python cli.py player <UID> [region]")
        return 1
    try:
        p = asyncio.run(lookup_player(args[0], args[1] if len(args) > 1 else None))
    except Exception as e:
        print(f"Lookup Failed: {e}")
        return 1
    print(f'{p["nickname"]} | UID: {p["uid"]} | Lv {p["level"]} | Likes: {int(p["likes"] or 0):,} | Region: {p["region"] or "-"}')
    print(f'BR: {int(p["br_points"] or 0):,} pts | CS: {int(p["cs_points"] or 0):,} pts')
    if p.get("guild"):
        print(f'Guild: {p["guild"]}')
    return 0


def print_help():
    print("""Free Fire Top-Up Database - Python CLI
  python cli.py add <Product> <PlayerID> <Price> [Rate] [-d YYYY-MM-DD] [-t HH:MM]
  python cli.py sales [page]
  python cli.py profit
  python cli.py search <PlayerID>
  python cli.py player <UID> [region]
  (no args = interactive shell)""")


def dispatch(cmd, args):
    if cmd == "add":
        return cmd_add(args)
    if cmd == "sales":
        return cmd_sales(args)
    if cmd == "profit":
        return cmd_profit(args)
    if cmd == "search":
        return cmd_search(args)
    if cmd == "player":
        return cmd_player(args)
    print_help()
    return 0


def shell():
    print("Free Fire Top-Up Database shell. Type commands like !add, !sales. Type exit to quit.")
    while True:
        try:
            line = input("topup> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not line:
            continue
        if line.lower() in ("exit", "quit"):
            break
        content = line[1:] if line.startswith("!") else line
        parts = content.split()
        if parts:
            dispatch(parts[0].lower(), parts[1:])


def main():
    args = sys.argv[1:]
    if not args:
        shell()
        return 0
    return dispatch(args[0].lower(), args[1:])


if __name__ == "__main__":
    raise SystemExit(main())
