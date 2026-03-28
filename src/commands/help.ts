import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { DraftManager } from '../draft/DraftManager';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('How to use the Mock Draft bot');

export async function execute(
  interaction: ChatInputCommandInteraction,
  _manager: DraftManager
): Promise<void> {
  const color = 0xFFB612;

  const overview = new EmbedBuilder()
    .setColor(color)
    .setTitle('🏈 2026 NFL Mock Draft — How to Play')
    .setDescription(
      'Welcome! Each person controls one NFL team and makes their picks when it\'s their turn. ' +
      'Use the commands below to participate.\n\n' +
      '**All commands are slash commands** — type `/` in chat to see them.'
    )
    .addFields(
      {
        name: '1️⃣ Claim Your Team — `/draft register`',
        value:
          'Before the draft starts, pick the NFL team you want to control.\n' +
          '> `/draft register` → choose your team from the list\n' +
          'You can only have one team. Use `/draft unregister` to switch.',
        inline: false,
      },
      {
        name: '2️⃣ When It\'s Your Turn — `/pick`',
        value:
          'The bot will @mention you when your team is on the clock.\n' +
          '> `/pick` → choose a position filter (or **All**), then search for a player by name\n' +
          'You\'ll see autocomplete suggestions as you type the player\'s name. Select one and submit.\n' +
          'If you run out of time (if a timer is set), the bot will auto-pick the top available player for you.',
        inline: false,
      },
      {
        name: '3️⃣ Skip Your Turn — `/autopick`',
        value:
          'If you want the bot to pick the best available player for you right now:\n' +
          '> `/autopick`\n' +
          'Only works when it\'s your team\'s pick.',
        inline: false,
      },
      {
        name: '4️⃣ Browse Available Players — `/board`',
        value:
          'See who\'s still on the board.\n' +
          '> `/board` — shows top available players (paginated)\n' +
          'Optional filters: position (QB, WR, CB, etc.) and page number.',
        inline: false,
      },
      {
        name: '5️⃣ Check Draft Progress — `/status`',
        value:
          'See who\'s on the clock, the current pick number, and the last few picks made.\n' +
          '> `/status`',
        inline: false,
      },
      {
        name: '6️⃣ View a Team\'s Picks — `/roster`',
        value:
          'See every pick a team has made so far.\n' +
          '> `/roster` → choose any team from the list',
        inline: false,
      },
      {
        name: '7️⃣ View Your Draft Picks & Roster — `/inventory`',
        value:
          'See a full snapshot of a team\'s remaining draft picks, future pick rights, and current roster.\n' +
          '> `/inventory` — your own team\n' +
          '> `/inventory gm:@user` — any other GM\'s team',
        inline: false,
      },
    );

  const trading = new EmbedBuilder()
    .setColor(color)
    .setTitle('🔄 Trading Guide')
    .setDescription(
      'Teams can trade **draft picks**, **future year picks (2027–2029)**, and **NFL players**.\n' +
      'Trades require the other GM to accept before they take effect.'
    )
    .addFields(
      {
        name: 'Propose a Trade — `/trade propose`',
        value:
          '**Required:** `to` — the other GM (@ them)\n' +
          '**Optional fields** (use at least one on each side):\n' +
          '• `offer` — picks you\'re giving — use the dropdown, or type overall # (`5`) or round.pick (`1.5`). Add more by typing a comma after each selection.\n' +
          '• `receive` — their picks you want — same format\n' +
          '• `offer-players` — players you\'re giving — type a name or jersey # (`15`). Add more with commas.\n' +
          '• `receive-players` — players you want — same format\n' +
          '• `offer-future` — your future picks to give *(e.g. `2027R1,2028R3`)*\n' +
          '• `receive-future` — their future picks you want *(e.g. `2027R1`)*',
        inline: false,
      },
      {
        name: 'Accept / Decline — `/trade accept` · `/trade decline`',
        value:
          'When someone sends you a trade, use `/trade accept` or `/trade decline`.\n' +
          'Both have autocomplete — just type the command and pick the trade from the list.\n' +
          'The proposer can also use `/trade decline` to cancel a trade they sent.',
        inline: false,
      },
      {
        name: 'View Your Trades & Picks — `/trade list`',
        value:
          'Shows all your pending trades, your remaining picks in this draft, and your future year pick rights (2027–2029).',
        inline: false,
      },
      {
        name: '💡 Trade Tips',
        value:
          '• You can trade the pick you\'re **currently on the clock for** — the new owner will immediately be put on the clock.\n' +
          '• Picks can be entered as overall # (`5`), round.pick (`1.5`), or chosen from the dropdown.\n' +
          '• Players can be entered by name or jersey number.\n' +
          '• Future picks use the format `YYYYRn` — e.g. `2027R1` for a 2027 first-round pick.\n' +
          '• Trades expire after **24 hours** if not accepted.\n' +
          '• A pick can only be in one pending trade at a time.',
        inline: false,
      },
    );

  await interaction.reply({ embeds: [overview, trading], ephemeral: true });
}
