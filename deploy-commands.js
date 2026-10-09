require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder().setName('add').setDescription('Add a new order')
    .addStringOption((o) => o.setName('product').setDescription('Product (e.g. WEEKLY, 100DB)').setRequired(true))
    .addStringOption((o) => o.setName('playerid').setDescription('Customer Free Fire UID').setRequired(true))
    .addNumberOption((o) => o.setName('price').setDescription('Selling price in LKR').setRequired(true))
    .addNumberOption((o) => o.setName('rate').setDescription('Cost rate in LKR (auto-fills from saved rates if omitted)'))
    .addStringOption((o) => o.setName('date').setDescription('Custom date YYYY-MM-DD'))
    .addStringOption((o) => o.setName('time').setDescription('Custom time HH:MM (24h)')),
  new SlashCommandBuilder().setName('sales').setDescription('Browse sales, 5 per page')
    .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),
  new SlashCommandBuilder().setName('profit').setDescription('Total profit summary'),
  new SlashCommandBuilder().setName('delete').setDescription('Delete an order')
    .addIntegerOption((o) => o.setName('order_id').setDescription('Order ID').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('edit').setDescription('Edit an order field')
    .addIntegerOption((o) => o.setName('order_id').setDescription('Order ID').setRequired(true).setMinValue(1))
    .addStringOption((o) => o.setName('field').setDescription('Field to edit').setRequired(true)
      .addChoices(
        { name: 'product', value: 'product' },
        { name: 'player_id', value: 'player_id' },
        { name: 'price', value: 'price' },
        { name: 'rate', value: 'rate' }
      ))
    .addStringOption((o) => o.setName('value').setDescription('New value').setRequired(true)),
  new SlashCommandBuilder().setName('daily').setDescription('Daily profit report')
    .addStringOption((o) => o.setName('date').setDescription('YYYY-MM-DD (default today)')),
  new SlashCommandBuilder().setName('monthly').setDescription('Monthly profit report')
    .addStringOption((o) => o.setName('month').setDescription('YYYY-MM (default this month)')),
  new SlashCommandBuilder().setName('search').setDescription('Find all orders for a player')
    .addStringOption((o) => o.setName('player_id').setDescription('Customer Free Fire UID').setRequired(true)),
  new SlashCommandBuilder().setName('export').setDescription('Download all orders as CSV'),
  new SlashCommandBuilder().setName('updaterates').setDescription('Scrape supplier rate list')
    .addStringOption((o) => o.setName('text').setDescription('Paste supplier rate list text')),
  new SlashCommandBuilder().setName('rates').setDescription('View saved supplier rates'),
  new SlashCommandBuilder().setName('player').setDescription('Look up Free Fire player info')
    .addStringOption((o) => o.setName('uid').setDescription('Player UID').setRequired(true))
    .addStringOption((o) => o.setName('region').setDescription('Region (auto-detect if omitted)')),
  new SlashCommandBuilder().setName('verify').setDescription('Verify a user')
    .addUserOption((o) => o.setName('user').setDescription('User to verify').setRequired(true)),
  new SlashCommandBuilder().setName('unverify').setDescription('Remove verification')
    .addUserOption((o) => o.setName('user').setDescription('User to unverify').setRequired(true)),
  new SlashCommandBuilder().setName('verified').setDescription('List verified users'),
  new SlashCommandBuilder().setName('verifytoggle').setDescription('Toggle verified-only mode')
    .addStringOption((o) => o.setName('mode').setDescription('on or off')
      .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
  new SlashCommandBuilder().setName('help').setDescription('Show all commands'),
].map((c) => c.toJSON());

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;
  if (!token || !clientId) {
    console.error('Set DISCORD_TOKEN and CLIENT_ID in .env first. (GUILD_ID optional: instant guild registration.)');
    process.exitCode = 1;
    return;
  }
  const rest = new REST({ version: '10' }).setToken(token);
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`Registered ${commands.length} guild slash commands.`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log(`Registered ${commands.length} global slash commands (may take up to 1 hour to appear).`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
