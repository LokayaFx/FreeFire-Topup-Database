require('dotenv').config();
const db = require('./db');

function formatLKR(amount) {
  return `LKR ${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function printHelp() {
  console.log(`Free Fire Top-Up Database - CLI (provider: ${db.getProviderName()})
Usage:
  node cli.js add <Product> <PlayerID> <Price> <Rate> [-d YYYY-MM-DD] [-t HH:MM]
  node cli.js sales
  node cli.js profit
  node cli.js verify <UserID>
  node cli.js unverify <UserID>
  node cli.js verified
  node cli.js delete <OrderID>
  node cli.js edit <OrderID> <field> <value>
  node cli.js daily [YYYY-MM-DD]
  node cli.js monthly [YYYY-MM]
  node cli.js search <PlayerID>
  node cli.js export [filepath]
  node cli.js help
Examples:
  node cli.js add 100DB 123456789 350 290
  node cli.js add 100DB 123456789 350 290 -d 2026-10-05 -t 14:30`);
}

function parseDateTime(args) {
  let customDate = null;
  let customTime = null;
  for (let i = 4; i < args.length; i++) {
    if (args[i] === '-d' || args[i] === '--date') {
      customDate = args[i + 1];
      i++;
    } else if (args[i] === '-t' || args[i] === '--time') {
      customTime = args[i + 1];
      i++;
    }
  }
  let createdAt = new Date();
  if (customDate) {
    const parts = customDate.split('-');
    if (parts.length !== 3) throw new Error('Date format must be YYYY-MM-DD');
    createdAt = new Date(parts[0], parts[1] - 1, parts[2]);
    if (isNaN(createdAt.getTime())) throw new Error('Invalid date');
  }
  if (customTime) {
    const parts = customTime.split(':');
    if (parts.length !== 2) throw new Error('Time format must be HH:MM');
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) throw new Error('Invalid time');
    createdAt.setHours(h, m, 0, 0);
  }
  return createdAt;
}

async function cmdAdd(args) {
  if (args.length < 4) {
    console.error('Usage: node cli.js add <Product> <PlayerID> <Price> <Rate> [-d YYYY-MM-DD] [-t HH:MM]');
    process.exitCode = 1;
    return;
  }
  const product = args[0];
  const playerId = args[1];
  const price = Number(args[2]);
  const rate = Number(args[3]);
  if (isNaN(price) || isNaN(rate) || price <= 0 || rate <= 0) {
    console.error('Price and Rate must be valid numbers greater than 0.');
    process.exitCode = 1;
    return;
  }
  let createdAt;
  try {
    createdAt = parseDateTime(args);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
    return;
  }
  try {
    const data = await db.addOrder({ product, player_id: playerId, price, rate, created_at: createdAt.toISOString() });
    console.log(`Order added | ID: ${data.id} | ${product} | Player: ${playerId} | Price: ${formatLKR(price)} | Rate: ${formatLKR(rate)} | Profit: ${formatLKR(price - rate)} | Date: ${createdAt.toLocaleString()}`);
  } catch (e) {
    console.error('Database Error:', e.message);
    process.exitCode = 1;
  }
}

async function cmdSales() {
  try {
    const data = await db.getRecentOrders(5);
    if (!data || data.length === 0) {
      console.log('No orders found.');
      return;
    }
    console.table(data.map((o, i) => ({
      '#': i + 1,
      ID: o.id,
      Product: o.product,
      Player: o.player_id,
      Price: Number(o.price),
      Rate: Number(o.rate),
      Profit: Number(o.price) - Number(o.rate),
      Date: new Date(o.created_at).toLocaleString()
    })));
  } catch (e) {
    console.error('Database Error:', e.message);
    process.exitCode = 1;
  }
}

async function cmdProfit() {
  try {
    const data = await db.getAllOrderPrices();
    if (!data || data.length === 0) {
      console.log('No orders found.');
      return;
    }
    const revenue = data.reduce((s, o) => s + Number(o.price), 0);
    const cost = data.reduce((s, o) => s + Number(o.rate), 0);
    console.log(`Total Orders: ${data.length}`);
    console.log(`Total Revenue: ${formatLKR(revenue)}`);
    console.log(`Total Cost: ${formatLKR(cost)}`);
    console.log(`Net Profit: ${formatLKR(revenue - cost)}`);
  } catch (e) {
    console.error('Database Error:', e.message);
    process.exitCode = 1;
  }
}

async function cmdVerify(args) {
  const userId = args[0];
  if (!userId) {
    console.error('Usage: node cli.js verify <UserID>');
    process.exitCode = 1;
    return;
  }
  try {
    await db.verifyUser(userId, 'cli');
    console.log(`Verified: ${userId}`);
  } catch (e) {
    console.error('Database Error:', e.message);
    process.exitCode = 1;
  }
}

async function cmdUnverify(args) {
  const userId = args[0];
  if (!userId) {
    console.error('Usage: node cli.js unverify <UserID>');
    process.exitCode = 1;
    return;
  }
  try {
    await db.unverifyUser(userId);
    console.log(`Unverified: ${userId}`);
  } catch (e) {
    console.error('Database Error:', e.message);
    process.exitCode = 1;
  }
}

async function cmdVerified() {
  try {
    const data = await db.listVerifiedUsers();
    if (!data || data.length === 0) {
      console.log('No verified users.');
      return;
    }
    console.table(data.map(u => ({ UserID: u.user_id, VerifiedBy: u.verified_by, Date: new Date(u.created_at).toLocaleString() })));
  } catch (e) {
    console.error('Database Error:', e.message);
    process.exitCode = 1;
  }
}

function summarize(rows) {
  const revenue = rows.reduce((s, o) => s + Number(o.price), 0);
  const cost = rows.reduce((s, o) => s + Number(o.rate), 0);
  return { count: rows.length, revenue, cost, profit: revenue - cost };
}

function printSummary(label, rows) {
  const s = summarize(rows);
  console.log(`${label}`);
  console.log(`Orders: ${s.count} | Revenue: ${formatLKR(s.revenue)} | Cost: ${formatLKR(s.cost)} | Net Profit: ${formatLKR(s.profit)}`);
}

async function cmdDelete(args) {
  if (!args[0]) {
    console.error('Usage: node cli.js delete <OrderID>');
    process.exitCode = 1;
    return;
  }
  try {
    const existing = await db.getOrderById(args[0]);
    if (!existing) {
      console.error(`No order found with ID: ${args[0]}`);
      process.exitCode = 1;
      return;
    }
    await db.deleteOrder(args[0]);
    console.log(`Deleted order ${existing.id} (${existing.product}, player ${existing.player_id}).`);
  } catch (e) {
    console.error('Database Error:', e.message);
    process.exitCode = 1;
  }
}

async function cmdEdit(args) {
  if (args.length < 3) {
    console.error('Usage: node cli.js edit <OrderID> <field> <value>  (fields: product, player_id, price, rate)');
    process.exitCode = 1;
    return;
  }
  const allowed = ['product', 'player_id', 'price', 'rate'];
  if (!allowed.includes(args[1])) {
    console.error(`Field must be one of: ${allowed.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const patch = {};
  if (args[1] === 'price' || args[1] === 'rate') {
    const num = Number(args.slice(2).join(' '));
    if (isNaN(num) || num <= 0) {
      console.error(`${args[1]} must be a number greater than 0.`);
      process.exitCode = 1;
      return;
    }
    patch[args[1]] = num;
  } else {
    patch[args[1]] = args.slice(2).join(' ');
  }
  try {
    const updated = await db.updateOrder(args[0], patch);
    console.log(`Updated order ${updated.id}: ${updated.product} | Player: ${updated.player_id} | Price: ${formatLKR(updated.price)} | Rate: ${formatLKR(updated.rate)}`);
  } catch (e) {
    console.error('Database Error:', e.message);
    process.exitCode = 1;
  }
}

async function cmdDaily(args) {
  let day = new Date();
  if (args[0]) {
    const p = args[0].split('-');
    if (p.length !== 3) { console.error('Use format: node cli.js daily YYYY-MM-DD'); process.exitCode = 1; return; }
    day = new Date(p[0], p[1] - 1, p[2]);
  }
  const start = new Date(day); start.setHours(0, 0, 0, 0);
  const end = new Date(day); end.setHours(23, 59, 59, 999);
  try {
    const rows = await db.getOrdersInRange(start.toISOString(), end.toISOString());
    if (!rows.length) { console.log(`No orders for ${start.toLocaleDateString()}.`); return; }
    printSummary(`Daily ${start.toLocaleDateString()}`, rows);
  } catch (e) {
    console.error('Database Error:', e.message);
    process.exitCode = 1;
  }
}

async function cmdMonthly(args) {
  const now = new Date();
  let year = now.getFullYear(), month = now.getMonth();
  if (args[0]) {
    const p = args[0].split('-');
    if (p.length !== 2) { console.error('Use format: node cli.js monthly YYYY-MM'); process.exitCode = 1; return; }
    year = Number(p[0]); month = Number(p[1]) - 1;
  }
  const start = new Date(year, month, 1); start.setHours(0, 0, 0, 0);
  const end = new Date(year, month + 1, 0); end.setHours(23, 59, 59, 999);
  try {
    const rows = await db.getOrdersInRange(start.toISOString(), end.toISOString());
    if (!rows.length) { console.log(`No orders for ${year}-${String(month + 1).padStart(2, '0')}.`); return; }
    printSummary(`Monthly ${year}-${String(month + 1).padStart(2, '0')}`, rows);
  } catch (e) {
    console.error('Database Error:', e.message);
    process.exitCode = 1;
  }
}

async function cmdSearch(args) {
  if (!args[0]) {
    console.error('Usage: node cli.js search <PlayerID>');
    process.exitCode = 1;
    return;
  }
  try {
    const rows = await db.searchOrdersByPlayer(args[0]);
    if (!rows.length) { console.log(`No orders for player: ${args[0]}`); return; }
    console.table(rows.map((o, i) => ({ '#': i + 1, ID: o.id, Product: o.product, Price: Number(o.price), Rate: Number(o.rate), Profit: Number(o.price) - Number(o.rate), Date: new Date(o.created_at).toLocaleString() })));
    const s = summarize(rows);
    console.log(`Total: ${rows.length} orders | Spent: ${formatLKR(s.revenue)} | Profit: ${formatLKR(s.profit)}`);
  } catch (e) {
    console.error('Database Error:', e.message);
    process.exitCode = 1;
  }
}

async function cmdExport(args) {
  const fs = require('fs');
  try {
    const rows = await db.getAllOrders();
    if (!rows.length) { console.log('No orders to export.'); return; }
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['id,product,player_id,price,rate,profit,created_at'];
    for (const o of rows) lines.push([o.id, esc(o.product), esc(o.player_id), o.price, o.rate, Number(o.price) - Number(o.rate), esc(o.created_at)].join(','));
    const out = args[0] || `orders-${new Date().toISOString().slice(0, 10)}.csv`;
    fs.writeFileSync(out, lines.join('\n'), 'utf8');
    console.log(`Exported ${rows.length} orders to ${out}`);
  } catch (e) {
    console.error('Database Error:', e.message);
    process.exitCode = 1;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = (args.shift() || 'help').toLowerCase();
  switch (command) {
    case 'add':
      await cmdAdd(args);
      break;
    case 'sales':
      await cmdSales();
      break;
    case 'profit':
      await cmdProfit();
      break;
    case 'verify':
      await cmdVerify(args);
      break;
    case 'unverify':
      await cmdUnverify(args);
      break;
    case 'verified':
      await cmdVerified();
      break;
    case 'delete':
      await cmdDelete(args);
      break;
    case 'edit':
      await cmdEdit(args);
      break;
    case 'daily':
      await cmdDaily(args);
      break;
    case 'monthly':
      await cmdMonthly(args);
      break;
    case 'search':
      await cmdSearch(args);
      break;
    case 'export':
      await cmdExport(args);
      break;
    case 'help':
    default:
      printHelp();
      break;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
