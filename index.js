require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Colors } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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

async function isVerified(userId) {
  if (OWNER_ID && userId === OWNER_ID) return true;
  
  const { data } = await supabase
    .from('verified_users')
    .select('user_id')
    .eq('user_id', userId)
    .single();
  
  return !!data;
}

async function requireVerification(message) {
  const verified = await isVerified(message.author.id);
  if (!verified) {
    await message.reply({
      embeds: [createErrorEmbed('Not Verified', 'You are not verified to use this bot. Contact an admin to get verified.')],
    });
    return false;
  }
  return true;
}

async function handleAddOrder(message, args) {
  if (!(await requireVerification(message))) return;
  
  if (args.length < 4) {
    return message.reply({
      embeds: [createErrorEmbed('Invalid Usage', 'Usage: `!add <Product> <PlayerID> <Price> <Rate> [-d YYYY-MM-DD] [-t HH:MM]`\nExample: `!add 100DB 123456789 350 290`\nWith date: `!add 100DB 123456789 350 290 -d 2026-10-05 -t 14:30`')],
    });
  }

  let product = args[0];
  let playerId = args[1];
  let priceStr = args[2];
  let rateStr = args[3];
  
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

  const price = Number(priceStr);
  const rate = Number(rateStr);

  if (isNaN(price) || isNaN(rate)) {
    return message.reply({
      embeds: [createErrorEmbed('Invalid Input', 'Price and Rate must be valid numbers.')],
    });
  }

  if (price <= 0 || rate <= 0) {
    return message.reply({
      embeds: [createErrorEmbed('Invalid Input', 'Price and Rate must be greater than 0.')],
    });
  }

  let createdAt = new Date();
  if (customDate) {
    const dateParts = customDate.split('-');
    if (dateParts.length !== 3) {
      return message.reply({
        embeds: [createErrorEmbed('Invalid Date', 'Date format must be YYYY-MM-DD (e.g., 2026-10-05)')],
      });
    }
    createdAt = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
    if (isNaN(createdAt.getTime())) {
      return message.reply({
        embeds: [createErrorEmbed('Invalid Date', 'Invalid date. Use format: YYYY-MM-DD')],
      });
    }
  }
  
  if (customTime) {
    const timeParts = customTime.split(':');
    if (timeParts.length !== 2) {
      return message.reply({
        embeds: [createErrorEmbed('Invalid Time', 'Time format must be HH:MM (24-hour, e.g., 14:30)')],
      });
    }
    const hours = parseInt(timeParts[0], 10);
    const minutes = parseInt(timeParts[1], 10);
    if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return message.reply({
        embeds: [createErrorEmbed('Invalid Time', 'Invalid time. Use 24-hour format: HH:MM (00:00-23:59)')],
      });
    }
    createdAt.setHours(hours, minutes, 0, 0);
  }

  const profit = price - rate;

  try {
    const { data, error } = await supabase
      .from('orders')
      .insert([
        {
          product,
          player_id: playerId,
          price,
          rate,
          created_at: createdAt.toISOString(),
        },
      ])
      .select()
      .single();

    if (error) throw error;

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
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) throw error;

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
    const { data, error } = await supabase.from('orders').select('price, rate');

    if (error) throw error;

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
    return message.reply({
      embeds: [createErrorEmbed('Invalid Usage', 'Usage: `!verify @user`')],
    });
  }

  const target = message.mentions.users.first();
  
  try {
    const { error } = await supabase
      .from('verified_users')
      .upsert({ user_id: target.id, verified_by: message.author.id }, { onConflict: 'user_id' });

    if (error) throw error;

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
    return message.reply({
      embeds: [createErrorEmbed('Invalid Usage', 'Usage: `!unverify @user`')],
    });
  }

  const target = message.mentions.users.first();
  
  if (OWNER_ID && target.id === OWNER_ID) {
    return message.reply({
      embeds: [createErrorEmbed('Cannot Unverify', 'You cannot unverify the bot owner.')],
    });
  }
  
  try {
    const { error } = await supabase
      .from('verified_users')
      .delete()
      .eq('user_id', target.id);

    if (error) throw error;

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
    const { data, error } = await supabase
      .from('verified_users')
      .select('user_id, verified_by, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;

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

function handleHelp(message) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle('🤖 Free Fire Top-Up Database - Commands')
    .setDescription('Here are all available commands:')
    .addFields(
      { name: '`!add <Product> <PlayerID> <Price> <Rate> [-d YYYY-MM-DD] [-t HH:MM]`', value: 'Add a new order\nExample: `!add 100DB 123456789 350 290`\nWith custom date/time: `!add 100DB 123456789 350 290 -d 2026-10-05 -t 14:30`', inline: false },
      { name: '`!sales`', value: 'View last 5 recent sales', inline: false },
      { name: '`!profit`', value: 'View total profit summary (all time)', inline: false },
      { name: '`!verify @user`', value: 'Verify a user to use the bot (admin only)', inline: false },
      { name: '`!unverify @user`', value: 'Remove verification from a user (admin only)', inline: false },
      { name: '`!verified`', value: 'List all verified users', inline: false },
      { name: '`!help`', value: 'Show this help message', inline: false }
    )
    .setTimestamp()
    .setFooter({ text: 'Free Fire Top-Up Database' });

  message.reply({ embeds: [embed] });
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

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
    case 'verify':
      await handleVerify(message, args);
      break;
    case 'unverify':
      await handleUnverify(message, args);
      break;
    case 'verified':
      await handleVerifiedList(message);
      break;
    case 'help':
      handleHelp(message);
      break;
    default:
      message.reply({
        embeds: [createErrorEmbed('Unknown Command', `Unknown command: \`${command}\`\nType \`!help\` for available commands.`)],
      });
  }
});

client.on('error', (error) => {
  console.error('Discord client error:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

client.login(process.env.DISCORD_TOKEN);