require('dotenv').config();
const http = require('http');
const { Client, GatewayIntentBits, EmbedBuilder, Colors, AttachmentBuilder } = require('discord.js');
const db = require('./db');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const PREFIX = '!';
const OWNER_ID = process.env.OWNER_ID;

function formatLKR(amount) {
  return `LKR ${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function createErrorEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle(`❌ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

function createSuccessEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle(`✅ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

function createInfoEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`ℹ️ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

function logLine(...parts) {
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

function logCommand(message, command, args) {
  const where = message.guild ? `${message.guild.name} #${message.channel.name}` : 'DM';
  logLine(`CMD !${command} by ${message.author.tag} (${message.author.id}) in ${where} args: ${args.join(' ') || '(none)'}`);
}

function cmdOf(message) {
  const t = message.content.startsWith(PREFIX) ? message.content.slice(PREFIX.length).trim() : message.content.trim();
  return (t.split(/ +/)[0] || '').toLowerCase();
}

async function reject(message, title, description) {
  logLine(`INVALID !${cmdOf(message)} by ${message.author.tag}: ${title}`);
  await message.reply({
    embeds: [createErrorEmbed(title, description)],
  });
  throw { rejected: true };
}

async function isVerified(userId) {
  if (OWNER_ID && userId === OWNER_ID) return true;
  try {
    return await db.isVerifiedUser(userId);
  } catch {
    return false;
  }
}

async function verificationEnabled() {
  try {
    const s = await db.getSetting('verification');
    if (!s) return true;
    return String(s.value).toLowerCase() !== 'off';
  } catch {
    return true;
  }
}

async function requireVerification(message) {
  if (OWNER_ID && message.author.id === OWNER_ID) return true;
  if (await verificationEnabled()) {
    if (await isVerified(message.author.id)) return true;
    return reject(message, 'Not Verified', 'You are not verified to use this bot. Contact an admin to get verified.');
  }
  return true;
}

async function requireAdmin(message) {
  if (OWNER_ID && message.author.id === OWNER_ID) return true;
  if (message.member && message.member.permissions && message.member.permissions.has('ManageGuild')) return true;
  if (await isVerified(message.author.id)) return true;
  return reject(message, 'Not Allowed', 'Only the owner, server managers, or verified users can use this command.');
}

async function handleAddOrder(message, args) {
  if (!(await requireVerification(message))) return;
  
  if (args.length < 3) {
    return reject(message, 'Invalid Usage', 'Usage: `!add <Product> <PlayerID> <Price> [Rate] [-d YYYY-MM-DD] [-t HH:MM]`\nExample: `!add 100DB 123456789 350 290`\nAuto-rate: `!add WEEKLY 123456789 600` (rate from saved rates)');
  }

  let product = args[0];
  let playerId = args[1];
  let priceStr = args[2];
  let rateStr = args[3] && !args[3].startsWith('-') ? args[3] : null;
  const flagStart = rateStr === null ? 3 : 4;
  
  let customDate = null;
  let customTime = null;
  
  for (let i = flagStart; i < args.length; i++) {
    if (args[i] === '-d' || args[i] === '--date') {
      customDate = args[i + 1];
      i++;
    } else if (args[i] === '-t' || args[i] === '--time') {
      customTime = args[i + 1];
      i++;
    }
  }

  const price = Number(priceStr);
  if (isNaN(price) || price <= 0) {
    return reject(message, 'Invalid Input', 'Price must be a valid number greater than 0.');
  }

  let rate;
  if (rateStr !== null) {
    rate = Number(rateStr);
    if (isNaN(rate) || rate <= 0) {
      return reject(message, 'Invalid Input', 'Rate must be a valid number greater than 0.');
    }
  } else {
    try {
      const saved = await db.getRate(product);
      if (!saved) {
        return reject(message, 'Rate Not Found', `No saved rate for "${product}".\nGive rate manually: \`!add ${product} ${playerId} ${priceStr} <Rate>\` or run \`!updaterates\` first.`);
      }
      rate = Number(saved.rate);
    } catch (err) {
      if (err && err.rejected) throw err;
      console.error('Rate lookup error:', err);
      return message.reply({
        embeds: [createErrorEmbed('Database Error', 'Failed to look up rate. Please try again later.')],
      });
    }
  }

  let createdAt = new Date();
  if (customDate) {
    const dateParts = customDate.split('-');
    if (dateParts.length !== 3) {
      return reject(message, 'Invalid Date', 'Date format must be YYYY-MM-DD (e.g., 2026-10-05)');
    }
    createdAt = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
    if (isNaN(createdAt.getTime())) {
      return reject(message, 'Invalid Date', 'Invalid date. Use format: YYYY-MM-DD');
    }
  }
  
  if (customTime) {
    const timeParts = customTime.split(':');
    if (timeParts.length !== 2) {
      return reject(message, 'Invalid Time', 'Time format must be HH:MM (24-hour, e.g., 14:30)');
    }
    const hours = parseInt(timeParts[0], 10);
    const minutes = parseInt(timeParts[1], 10);
    if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return reject(message, 'Invalid Time', 'Invalid time. Use 24-hour format: HH:MM (00:00-23:59)');
    }
    createdAt.setHours(hours, minutes, 0, 0);
  }

  const profit = price - rate;

  try {
    const data = await db.addOrder({
      product,
      player_id: playerId,
      price,
      rate,
      created_at: createdAt.toISOString(),
    });

    const embed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle('📦 New Order Added')
      .addFields(
        { name: 'Product', value: product, inline: true },
        { name: 'Player ID', value: playerId, inline: true },
        { name: 'Price', value: formatLKR(price), inline: true },
        { name: 'Rate', value: formatLKR(rate), inline: true },
        { name: 'Profit', value: formatLKR(profit), inline: true },
        { name: 'Order ID', value: String(data.id), inline: true }
      )
      .setTimestamp(createdAt)
      .setFooter({ text: `Added by ${message.author.tag}` });

    await message.reply({ embeds: [embed] });
  } catch (err) {
    console.error('Add order error:', err);
    await message.reply({
      embeds: [createErrorEmbed('Database Error', 'Failed to add order. Please try again later.')],
    });
  }
}

async function handleSales(message) {
  if (!(await requireVerification(message))) return;
  
  try {
    const data = await db.getRecentOrders(5);

    if (!data || data.length === 0) {
      return message.reply({
        embeds: [createInfoEmbed('No Sales', 'No orders found in the database.')],
      });
    }

    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle('📊 Recent Sales (Last 5)')
      .setTimestamp();

    data.forEach((order, index) => {
      const profit = order.price - order.rate;
      embed.addFields({
        name: `#${index + 1} - ${order.product} (ID: ${order.id})`,
        value: `Player: ${order.player_id}\nPrice: ${formatLKR(order.price)} | Rate: ${formatLKR(order.rate)} | Profit: ${formatLKR(profit)}\nDate: ${new Date(order.created_at).toLocaleString()}`,
        inline: false,
      });
    });

    await message.reply({ embeds: [embed] });
  } catch (err) {
    console.error('Sales error:', err);
    await message.reply({
      embeds: [createErrorEmbed('Database Error', 'Failed to fetch sales. Please try again later.')],
    });
  }
}

async function handleProfit(message) {
  if (!(await requireVerification(message))) return;
  
  try {
    const data = await db.getAllOrderPrices();

    if (!data || data.length === 0) {
      return message.reply({
        embeds: [createInfoEmbed('No Data', 'No orders found to calculate profit.')],
      });
    }

    const totalRevenue = data.reduce((sum, o) => sum + Number(o.price), 0);
    const totalCost = data.reduce((sum, o) => sum + Number(o.rate), 0);
    const totalProfit = totalRevenue - totalCost;
    const totalOrders = data.length;

    const embed = new EmbedBuilder()
      .setColor(totalProfit >= 0 ? Colors.Green : Colors.Red)
      .setTitle('💰 Total Profit Summary')
      .addFields(
        { name: 'Total Orders', value: String(totalOrders), inline: true },
        { name: 'Total Revenue', value: formatLKR(totalRevenue), inline: true },
        { name: 'Total Cost', value: formatLKR(totalCost), inline: true },
        { name: 'Net Profit', value: formatLKR(totalProfit), inline: false }
      )
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  } catch (err) {
    console.error('Profit error:', err);
    await message.reply({
      embeds: [createErrorEmbed('Database Error', 'Failed to calculate profit. Please try again later.')],
    });
  }
}

async function handleVerify(message, args) {
  if (!(await requireVerification(message))) return;
  
  if (!message.mentions.users.size) {
    return reject(message, 'Invalid Usage', 'Usage: `!verify @user`');
  }

  const target = message.mentions.users.first();
  
  try {
    await db.verifyUser(target.id, message.author.id);

    await message.reply({
      embeds: [createSuccessEmbed('User Verified', `<@${target.id}> has been verified and can now use the bot.`)],
    });
  } catch (err) {
    console.error('Verify error:', err);
    await message.reply({
      embeds: [createErrorEmbed('Database Error', 'Failed to verify user.')],
    });
  }
}

async function handleUnverify(message, args) {
  if (!(await requireVerification(message))) return;
  
  if (!message.mentions.users.size) {
    return reject(message, 'Invalid Usage', 'Usage: `!unverify @user`');
  }

  const target = message.mentions.users.first();
  
  if (OWNER_ID && target.id === OWNER_ID) {
    return reject(message, 'Cannot Unverify', 'You cannot unverify the bot owner.');
  }
  
  try {
    await db.unverifyUser(target.id);

    await message.reply({
      embeds: [createSuccessEmbed('User Unverified', `<@${target.id}> has been unverified and can no longer use the bot.`)],
    });
  } catch (err) {
    console.error('Unverify error:', err);
    await message.reply({
      embeds: [createErrorEmbed('Database Error', 'Failed to unverify user.')],
    });
  }
}

async function handleVerifiedList(message) {
  if (!(await requireVerification(message))) return;
  
  try {
    const data = await db.listVerifiedUsers();

    if (!data || data.length === 0) {
      return message.reply({
        embeds: [createInfoEmbed('No Verified Users', 'No users are currently verified.')],
      });
    }

    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle('✅ Verified Users')
      .setTimestamp();

    for (const user of data) {
      const verifiedBy = await client.users.fetch(user.verified_by).catch(() => null);
      embed.addFields({
        name: `<@${user.user_id}>`,
        value: `Verified by: ${verifiedBy ? verifiedBy.tag : 'Unknown'}\nDate: ${new Date(user.created_at).toLocaleString()}`,
        inline: true,
      });
    }

    await message.reply({ embeds: [embed] });
  } catch (err) {
    console.error('Verified list error:', err);
    await message.reply({
      embeds: [createErrorEmbed('Database Error', 'Failed to fetch verified users.')],
    });
  }
}

function summarizeOrders(rows) {
  const revenue = rows.reduce((s, o) => s + Number(o.price), 0);
  const cost = rows.reduce((s, o) => s + Number(o.rate), 0);
  return { count: rows.length, revenue, cost, profit: revenue - cost };
}

function summaryEmbed(title, rows) {
  const s = summarizeOrders(rows);
  return new EmbedBuilder()
    .setColor(s.profit >= 0 ? Colors.Green : Colors.Red)
    .setTitle(title)
    .addFields(
      { name: 'Orders', value: String(s.count), inline: true },
      { name: 'Revenue', value: formatLKR(s.revenue), inline: true },
      { name: 'Cost', value: formatLKR(s.cost), inline: true },
      { name: 'Net Profit', value: formatLKR(s.profit), inline: false }
    )
    .setTimestamp();
}

async function handleDeleteOrder(message, args) {
  if (!(await requireVerification(message))) return;

  if (!args[0]) {
    return reject(message, 'Invalid Usage', 'Usage: `!delete <OrderID>`\nExample: `!delete 5`');
  }

  try {
    const existing = await db.getOrderById(args[0]);
    if (!existing) {
      return reject(message, 'Not Found', `No order found with ID: ${args[0]}`);
    }
    await db.deleteOrder(args[0]);
    await message.reply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle('🗑️ Order Deleted')
        .addFields(
          { name: 'Order ID', value: String(existing.id), inline: true },
          { name: 'Product', value: String(existing.product), inline: true },
          { name: 'Player ID', value: String(existing.player_id), inline: true }
        )
        .setTimestamp()],
    });
  } catch (err) {
    console.error('Delete error:', err);
    await message.reply({
      embeds: [createErrorEmbed('Database Error', err.message || 'Failed to delete order.')],
    });
  }
}

async function handleEditOrder(message, args) {
  if (!(await requireVerification(message))) return;

  if (args.length < 3) {
    return reject(message, 'Invalid Usage', 'Usage: `!edit <OrderID> <field> <value>`\nFields: product, player_id, price, rate\nExample: `!edit 5 price 400`');
  }

  const [id, field, ...rest] = args;
  const value = rest.join(' ');
  const allowed = ['product', 'player_id', 'price', 'rate'];
  if (!allowed.includes(field)) {
    return reject(message, 'Invalid Field', `Field must be one of: ${allowed.join(', ')}`);
  }

  const patch = {};
  if (field === 'price' || field === 'rate') {
    const num = Number(value);
    if (isNaN(num) || num <= 0) {
      return reject(message, 'Invalid Input', `${field} must be a number greater than 0.`);
    }
    patch[field] = num;
  } else {
    patch[field] = value;
  }

  try {
    const updated = await db.updateOrder(id, patch);
    await message.reply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle('✏️ Order Updated')
        .addFields(
          { name: 'Order ID', value: String(updated.id), inline: true },
          { name: 'Product', value: String(updated.product), inline: true },
          { name: 'Player ID', value: String(updated.player_id), inline: true },
          { name: 'Price', value: formatLKR(updated.price), inline: true },
          { name: 'Rate', value: formatLKR(updated.rate), inline: true },
          { name: 'Profit', value: formatLKR(Number(updated.price) - Number(updated.rate)), inline: true }
        )
        .setTimestamp()],
    });
  } catch (err) {
    console.error('Edit error:', err);
    await message.reply({
      embeds: [createErrorEmbed('Database Error', err.message || 'Failed to update order.')],
    });
  }
}

async function handleDaily(message, args) {
  if (!(await requireVerification(message))) return;

  let day = new Date();
  if (args[0]) {
    const parts = args[0].split('-');
    if (parts.length !== 3) {
      return reject(message, 'Invalid Date', 'Use format: `!daily YYYY-MM-DD`');
    }
    day = new Date(parts[0], parts[1] - 1, parts[2]);
    if (isNaN(day.getTime())) {
      return reject(message, 'Invalid Date', 'Invalid date. Use format YYYY-MM-DD');
    }
  }

  const start = new Date(day); start.setHours(0, 0, 0, 0);
  const end = new Date(day); end.setHours(23, 59, 59, 999);

  try {
    const rows = await db.getOrdersInRange(start.toISOString(), end.toISOString());
    const label = start.toLocaleDateString();
    if (!rows.length) {
      return message.reply({
        embeds: [createInfoEmbed('No Orders', `No orders found for ${label}.`)],
      });
    }
    await message.reply({ embeds: [summaryEmbed(`📅 Daily Report - ${label}`, rows)] });
  } catch (err) {
    console.error('Daily error:', err);
    await message.reply({
      embeds: [createErrorEmbed('Database Error', 'Failed to fetch daily report.')],
    });
  }
}

async function handleMonthly(message, args) {
  if (!(await requireVerification(message))) return;

  let year, month;
  if (args[0]) {
    const parts = args[0].split('-');
    if (parts.length !== 2) {
      return reject(message, 'Invalid Month', 'Use format: `!monthly YYYY-MM`');
    }
    year = Number(parts[0]); month = Number(parts[1]) - 1;
  } else {
    const now = new Date();
    year = now.getFullYear(); month = now.getMonth();
  }
  if (isNaN(year) || isNaN(month) || month < 0 || month > 11) {
    return reject(message, 'Invalid Month', 'Use format: `!monthly YYYY-MM` (e.g. 2026-10)');
  }

  const start = new Date(year, month, 1); start.setHours(0, 0, 0, 0);
  const end = new Date(year, month + 1, 0); end.setHours(23, 59, 59, 999);

  try {
    const rows = await db.getOrdersInRange(start.toISOString(), end.toISOString());
    const label = `${year}-${String(month + 1).padStart(2, '0')}`;
    if (!rows.length) {
      return message.reply({
        embeds: [createInfoEmbed('No Orders', `No orders found for ${label}.`)],
      });
    }
    await message.reply({ embeds: [summaryEmbed(`🗓️ Monthly Report - ${label}`, rows)] });
  } catch (err) {
    console.error('Monthly error:', err);
    await message.reply({
      embeds: [createErrorEmbed('Database Error', 'Failed to fetch monthly report.')],
    });
  }
}

async function handleSearch(message, args) {
  if (!(await requireVerification(message))) return;

  if (!args[0]) {
    return reject(message, 'Invalid Usage', 'Usage: `!search <PlayerID>`\nExample: `!search 123456789`');
  }

  try {
    const rows = await db.searchOrdersByPlayer(args[0]);
    if (!rows.length) {
      return message.reply({
        embeds: [createInfoEmbed('No Orders', `No orders found for player: ${args[0]}`)],
      });
    }
    const s = summarizeOrders(rows);
    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle(`🔍 Orders for ${args[0]} (${rows.length})`)
      .setDescription(rows.slice(0, 10).map((o) => `#${o.id} ${o.product} | ${formatLKR(o.price)} | Profit: ${formatLKR(Number(o.price) - Number(o.rate))} | ${new Date(o.created_at).toLocaleDateString()}`).join('\n'))
      .addFields(
        { name: 'Total Spent', value: formatLKR(s.revenue), inline: true },
        { name: 'Total Profit', value: formatLKR(s.profit), inline: true }
      )
      .setTimestamp();
    await message.reply({ embeds: [embed] });
  } catch (err) {
    console.error('Search error:', err);
    await message.reply({
      embeds: [createErrorEmbed('Database Error', 'Failed to search orders.')],
    });
  }
}

function ordersToCSV(rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['id,product,player_id,price,rate,profit,created_at'];
  for (const o of rows) {
    lines.push([o.id, esc(o.product), esc(o.player_id), o.price, o.rate, Number(o.price) - Number(o.rate), esc(o.created_at)].join(','));
  }
  return lines.join('\n');
}

async function handleExport(message) {
  if (!(await requireVerification(message))) return;

  try {
    const rows = await db.getAllOrders();
    if (!rows.length) {
      return message.reply({
        embeds: [createInfoEmbed('No Data', 'No orders to export.')],
      });
    }
    const csv = ordersToCSV(rows);
    const file = new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: `orders-${new Date().toISOString().slice(0, 10)}.csv` });
    await message.reply({ content: `📤 Exported ${rows.length} orders.`, files: [file] });
  } catch (err) {
    console.error('Export error:', err);
    await message.reply({
      embeds: [createErrorEmbed('Database Error', 'Failed to export orders.')],
    });
  }
}

async function handleUpdateRates(message) {
  if (!(await requireVerification(message))) return;

  let sourceText = null;
  try {
    if (message.reference && message.reference.messageId) {
      const ref = await message.channel.messages.fetch(message.reference.messageId);
      sourceText = ref.content;
    } else {
      const idx = message.content.indexOf('\n');
      sourceText = idx === -1 ? '' : message.content.slice(idx + 1);
    }
  } catch (err) {
    return reject(message, 'Fetch Failed', 'Could not read the replied message. Reply to the supplier rate message with `!updaterates`.');
  }

  const items = db.parseRateList(sourceText);
  if (!items.length) {
    return reject(message, 'No Rates Found', 'No rates found. Reply to the supplier rate message with `!updaterates`, or paste the list after the command:\n`!updaterates`\n`- WEEKLY ⇒ 540.0 LKR`\n`- 100 ⇒ 315.0 LKR`');
  }

  try {
    for (const it of items) {
      await db.setRate(it.product, it.rate, it.category);
    }
    const byCat = {};
    for (const it of items) {
      const c = it.category || 'Rates';
      if (!byCat[c]) byCat[c] = [];
      byCat[c].push(`${it.product}: ${formatLKR(it.rate)}`);
    }
    const embed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle(`✅ Rates Updated (${items.length})`)
      .setTimestamp();
    for (const [cat, lines] of Object.entries(byCat).slice(0, 20)) {
      embed.addFields({ name: cat, value: lines.join('\n').slice(0, 1000), inline: false });
    }
    await message.reply({ embeds: [embed] });
  } catch (err) {
    if (err && err.rejected) throw err;
    console.error('UpdateRates error:', err);
    await message.reply({
      embeds: [createErrorEmbed('Database Error', err.message || 'Failed to save rates.')],
    });
  }
}

async function handleRates(message) {
  if (!(await requireVerification(message))) return;

  try {
    const rows = await db.getAllRates();
    if (!rows.length) {
      return message.reply({
        embeds: [createInfoEmbed('No Rates', 'No saved rates. Run `!updaterates` first.')],
      });
    }
    const byCat = {};
    for (const r of rows) {
      const c = r.category || 'Rates';
      if (!byCat[c]) byCat[c] = [];
      byCat[c].push(`${r.product}: ${formatLKR(r.rate)}`);
    }
    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle(`💲 Saved Rates (${rows.length})`)
      .setTimestamp();
    for (const [cat, lines] of Object.entries(byCat).slice(0, 20)) {
      embed.addFields({ name: cat, value: lines.join('\n').slice(0, 1000), inline: false });
    }
    await message.reply({ embeds: [embed] });
  } catch (err) {
    console.error('Rates error:', err);
    await message.reply({
      embeds: [createErrorEmbed('Database Error', 'Failed to fetch rates.')],
    });
  }
}

async function handleVerifyToggle(message, args) {
  if (!(await requireAdmin(message))) return;

  const mode = (args[0] || '').toLowerCase();
  if (!mode) {
    const on = await verificationEnabled();
    return message.reply({
      embeds: [createInfoEmbed('Verification Mode', on ? 'ON — only verified users can use commands.\nUse `!verifytoggle off` for public mode.' : 'OFF — everyone can use commands.\nUse `!verifytoggle on` for verified-only mode.')],
    });
  }
  if (mode !== 'on' && mode !== 'off') {
    return reject(message, 'Invalid Usage', 'Usage: `!verifytoggle [on|off]`');
  }

  try {
    await db.setSetting('verification', mode);
    await message.reply({
      embeds: [new EmbedBuilder()
        .setColor(mode === 'on' ? Colors.Green : Colors.Blue)
        .setTitle(mode === 'on' ? '🔒 Verification ON' : '🔓 Verification OFF')
        .setDescription(mode === 'on' ? 'Only verified users can use commands.' : 'Everyone can use commands.')
        .setTimestamp()],
    });
  } catch (err) {
    if (err && err.rejected) throw err;
    console.error('VerifyToggle error:', err);
    await message.reply({
      embeds: [createErrorEmbed('Database Error', 'Failed to update setting.')],
    });
  }
}

function handleHelp(message) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle('🤖 Free Fire Top-Up Database - Commands')
    .setDescription('Here are all available commands:')
    .addFields(
      { name: '`!add <Product> <PlayerID> <Price> [Rate] [-d YYYY-MM-DD] [-t HH:MM]`', value: 'Add a new order (rate auto-fills from saved rates)\nExample: `!add 100DB 123456789 350 290` or `!add WEEKLY 123456789 600`', inline: false },
      { name: '`!sales`', value: 'View last 5 recent sales', inline: false },
      { name: '`!profit`', value: 'View total profit summary (all time)', inline: false },
      { name: '`!delete <OrderID>`', value: 'Delete an order\nExample: `!delete 5`', inline: false },
      { name: '`!edit <OrderID> <field> <value>`', value: 'Edit product, player_id, price or rate\nExample: `!edit 5 price 400`', inline: false },
      { name: '`!daily [YYYY-MM-DD]`', value: 'Daily profit report (default today)', inline: false },
      { name: '`!monthly [YYYY-MM]`', value: 'Monthly profit report (default this month)', inline: false },
      { name: '`!search <PlayerID>`', value: 'Find all orders for a player', inline: false },
      { name: '`!export`', value: 'Download all orders as CSV', inline: false },
      { name: '`!updaterates`', value: 'Scrape supplier rate list (reply to supplier msg or paste list after command)', inline: false },
      { name: '`!rates`', value: 'View saved supplier rates', inline: false },
      { name: '`!verify @user`', value: 'Verify a user to use the bot (admin only)', inline: false },
      { name: '`!unverify @user`', value: 'Remove verification from a user (admin only)', inline: false },
      { name: '`!verified`', value: 'List all verified users', inline: false },
      { name: '`!verifytoggle [on|off]`', value: 'Toggle verified-only mode (owner/managers/verified)', inline: false },
      { name: '`!help`', value: 'Show this help message', inline: false }
    )
    .setTimestamp()
    .setFooter({ text: 'Free Fire Top-Up Database' });

  message.reply({ embeds: [embed] });
}

client.once('ready', () => {
  logLine(`Logged in as ${client.user.tag} | provider: ${db.getProviderName()}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  logCommand(message, command, args);

  try {
    switch (command) {
    case 'add':
      await handleAddOrder(message, args);
      break;
    case 'sales':
      await handleSales(message);
      break;
    case 'profit':
      await handleProfit(message);
      break;
    case 'delete':
      await handleDeleteOrder(message, args);
      break;
    case 'edit':
      await handleEditOrder(message, args);
      break;
    case 'daily':
      await handleDaily(message, args);
      break;
    case 'monthly':
      await handleMonthly(message, args);
      break;
    case 'search':
      await handleSearch(message, args);
      break;
    case 'export':
      await handleExport(message);
      break;
    case 'updaterates':
      await handleUpdateRates(message);
      break;
    case 'rates':
      await handleRates(message);
      break;
    case 'verify':
      await handleVerify(message, args);
      break;
    case 'unverify':
      await handleUnverify(message, args);
      break;
    case 'verified':
      await handleVerifiedList(message);
      break;
    case 'verifytoggle':
      await handleVerifyToggle(message, args);
      break;
    case 'help':
      handleHelp(message);
      break;
    default:
      logLine(`Unknown command !${command} by ${message.author.tag}`);
      return message.reply({
        embeds: [createErrorEmbed('Unknown Command', `Unknown command: \`${command}\`\nType \`!help\` for available commands.`)],
      });
  }
  logLine(`DONE !${command} by ${message.author.tag}`);
  } catch (err) {
    if (err && err.rejected) return;
    logLine(`FAIL !${command} by ${message.author.tag}:`, err && err.message ? err.message : err);
  }
});

client.on('error', (error) => {
  console.error('Discord client error:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', bot: client.user ? client.user.tag : 'starting', provider: db.getProviderName(), uptime: process.uptime() }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Free Fire Top-Up Database bot is running.');
  }
}).listen(PORT, () => {
  console.log(`Health server listening on port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);