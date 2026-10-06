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

function formatLKR(amount) {
  return `LKR ${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function createErrorEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle(`âŒ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

function createSuccessEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle(`âœ… ${title}`)
    .setDescription(description)
    .setTimestamp();
}

function createInfoEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`â„¹ï¸ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

async function handleAddOrder(message, args) {
  if (args.length < 4) {
    return message.reply({
      embeds: [createErrorEmbed('Invalid Usage', 'Usage: `!add <Product> <PlayerID> <Price> <Rate>`\nExample: `!add 100DB 123456789 350 290`')],
    });
  }

  const [product, playerId, priceStr, rateStr] = args;
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
        },
      ])
      .select()
      .single();

    if (error) throw error;

    const embed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle('ðŸ“¦ New Order Added')
      .addFields(
        { name: 'Product', value: product, inline: true },
        { name: 'Player ID', value: playerId, inline: true },
        { name: 'Price', value: formatLKR(price), inline: true },
        { name: 'Rate', value: formatLKR(rate), inline: true },
        { name: 'Profit', value: formatLKR(profit), inline: true },
        { name: 'Order ID', value: String(data.id), inline: true }
      )
      .setTimestamp()
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
      .setTitle('ðŸ“Š Recent Sales (Last 5)')
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
      .setTitle('ðŸ’° Total Profit Summary')
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

function handleHelp(message) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle('ðŸ¤– Free Fire Top-Up Bot - Commands')
    .setDescription('Here are all available commands:')
    .addFields(
      { name: '`!add <Product> <PlayerID> <Price> <Rate>`', value: 'Add a new order\nExample: `!add 100DB 123456789 350 290`', inline: false },
      { name: '`!sales`', value: 'View last 5 recent sales', inline: false },
      { name: '`!profit`', value: 'View total profit summary (all time)', inline: false },
      { name: '`!help`', value: 'Show this help message', inline: false }
    )
    .setTimestamp()
    .setFooter({ text: 'Free Fire Diamond Top-Up Bot' });

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
    case 'help':
      handleHelp(message);
      break;
    default:
      message.reply({
        embeds: [createErrorEmbed('Unknown Command', `Unknown command: \`${command}\`\nType \`!help\` for available commands.')],
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
