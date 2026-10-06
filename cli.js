require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function formatLKR(amount) {
  return `LKR ${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function printHelp() {
  console.log(`Free Fire Top-Up Database - CLI
Usage:
  node cli.js add <Product> <PlayerID> <Price> <Rate> [-d YYYY-MM-DD] [-t HH:MM]
  node cli.js sales
  node cli.js profit
  node cli.js verify <UserID>
  node cli.js unverify <UserID>
  node cli.js verified
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
  const { data, error } = await supabase.from('orders').insert([{ product, player_id: playerId, price, rate, created_at: createdAt.toISOString() }]).select().single();
  if (error) {
    console.error('Database Error:', error.message);
    process.exitCode = 1;
    return;
  }
  console.log(`Order added | ID: ${data.id} | ${product} | Player: ${playerId} | Price: ${formatLKR(price)} | Rate: ${formatLKR(rate)} | Profit: ${formatLKR(price - rate)} | Date: ${createdAt.toLocaleString()}`);
}

async function cmdSales() {
  const { data, error } = await supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(5);
  if (error) {
    console.error('Database Error:', error.message);
    process.exitCode = 1;
    return;
  }
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
}

async function cmdProfit() {
  const { data, error } = await supabase.from('orders').select('price, rate');
  if (error) {
    console.error('Database Error:', error.message);
    process.exitCode = 1;
    return;
  }
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
}

async function cmdVerify(args) {
  const userId = args[0];
  if (!userId) {
    console.error('Usage: node cli.js verify <UserID>');
    process.exitCode = 1;
    return;
  }
  const { error } = await supabase.from('verified_users').upsert({ user_id: userId, verified_by: 'cli' }, { onConflict: 'user_id' });
  if (error) {
    console.error('Database Error:', error.message);
    process.exitCode = 1;
    return;
  }
  console.log(`Verified: ${userId}`);
}

async function cmdUnverify(args) {
  const userId = args[0];
  if (!userId) {
    console.error('Usage: node cli.js unverify <UserID>');
    process.exitCode = 1;
    return;
  }
  const { error } = await supabase.from('verified_users').delete().eq('user_id', userId);
  if (error) {
    console.error('Database Error:', error.message);
    process.exitCode = 1;
    return;
  }
  console.log(`Unverified: ${userId}`);
}

async function cmdVerified() {
  const { data, error } = await supabase.from('verified_users').select('user_id, verified_by, created_at').order('created_at', { ascending: false });
  if (error) {
    console.error('Database Error:', error.message);
    process.exitCode = 1;
    return;
  }
  if (!data || data.length === 0) {
    console.log('No verified users.');
    return;
  }
  console.table(data.map(u => ({ UserID: u.user_id, VerifiedBy: u.verified_by, Date: new Date(u.created_at).toLocaleString() })));
}

async function main() {
  const args = process.argv.slice(2);
  const command = (args.shift() || 'help').toLowerCase();
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_KEY in .env');
    process.exitCode = 1;
    return;
  }
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
