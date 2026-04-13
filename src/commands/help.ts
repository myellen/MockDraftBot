import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { DraftManager } from '../discord/DraftManager';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('How to use the Mock Draft bot');

export async function execute(
  interaction: ChatInputCommandInteraction,
  _manager: DraftManager
): Promise<void> {
  const color = 0xFFB612;

  const quickStart = new EmbedBuilder()
    .setColor(color)
    .setTitle('🚀 Quick Start')
    .setDescription(
      '**1.** `/draft register` — claim your NFL team\n' +
      '**2.** `/pick` — when you\'re on the clock, search and draft a player\n' +
      '**3.** `/board view` — browse available prospects\n' +
      '**4.** `/autopick` — let the bot pick for you\n\n' +
      'That\'s all you need! Read below for trading, custom boards, and more.'
    );

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
          'If you run out of time (if a timer is set), the bot will auto-pick using your custom board, position priority, or best available — in that order.',
        inline: false,
      },
      {
        name: '3️⃣ Skip Your Turn — `/autopick`',
        value:
          'If you want the bot to pick for you right now:\n' +
          '> `/autopick`\n' +
          'Uses your custom board if you\'ve submitted one, otherwise position priority, otherwise best available. Only works when it\'s your team\'s pick.',
        inline: false,
      },
      {
        name: '4️⃣ Browse Available Players — `/board view`',
        value:
          'See who\'s still on the board.\n' +
          '> `/board view` — shows top available players (paginated)\n' +
          'Optional filters: position (QB, WR, CB, etc.) and page number.',
        inline: false,
      },
      {
        name: '5️⃣ Check Draft Progress — `/status`',
        value:
          'See who\'s on the clock, the current pick number, and the last few picks made.\n' +
          '> `/status`\n' +
          '> `/upcoming` — see the next upcoming picks with team names and GMs',
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
          '> `/inventory team:` — any other team (autocomplete shows team names with GMs)',
        inline: false,
      },
      {
        name: '8️⃣ Custom Draft Board — `/board submit` · `/board priority`',
        value:
          'Control what the bot picks for you when you\'re away or skip your turn.\n' +
          '> `/board submit file:` — upload a `.txt` file with player names in your preferred order (one per line). Partial boards are fine — any number of players.\n' +
          '> `/board priority positions:` — set position priority for autopick (e.g. `QB,OT,EDGE`). Use the dropdown to build the list.\n' +
          '> `/board myboard` — view your submitted board and see which players are still available\n' +
          '> `/board clear` — remove your board, priority, or both\n\n' +
          '**Fallback order:** your board → position priority → default rank order.',
        inline: false,
      },
      {
        name: '9️⃣ AI Draft Board — `/board-ai`',
        value:
          'Ask questions about prospects or describe board changes in plain English.\n' +
          '> `/board-ai description:` — ask a question like "who are the best EDGE rushers?" or "compare the top QBs"\n' +
          '> `/board-ai description:` — give an instruction like "prioritize edge rushers and corners" or "draft for need"\n' +
          '> `/board-ai description: file:` — upload a `.txt` or `.csv` file with player names\n' +
          'The AI knows your roster, drafted players, and available prospects. It remembers your conversation — ask about prospects first, then follow up with "put those on my board."',
        inline: false,
      },
      {
        name: '🔟 Co-Managers — `/draft add-comanager` · `/draft remove-comanager`',
        value:
          'Add a trusted person to help manage your team. Co-managers can make picks and propose/accept trades.\n' +
          '> `/draft add-comanager user:@user` — add a co-manager to your team\n' +
          '> `/draft remove-comanager user:@user` — remove a co-manager',
        inline: false,
      },
      {
        name: '1️⃣1️⃣ Draft Recap — `/recap`',
        value:
          'Get the link to the live draft recap spreadsheet.\n' +
          '> `/recap`',
        inline: false,
      },
    );

  const trading = new EmbedBuilder()
    .setColor(color)
    .setTitle('🔄 Trading Guide')
    .setDescription(
      'Teams can trade **draft picks**, **future year picks (2027–2028)**, and **NFL players**.\n' +
      'Trades require the other GM to accept before they take effect.'
    )
    .addFields(
      {
        name: 'Propose a Trade — `/trade propose`',
        value:
          '**Required:** `to` — the team you want to trade with (autocomplete shows team names with GMs)\n' +
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
          'Shows all your pending trades, your remaining picks in this draft, and your future year pick rights (2027–2028).',
        inline: false,
      },
      {
        name: 'Trade History — `/trade-history`',
        value:
          'View all completed trades in chronological order.',
        inline: false,
      },
      {
        name: 'AI Trade — `/trade-ai`',
        value:
          'Describe a trade in plain English and let the AI build and submit the proposal.\n' +
          '> `/trade-ai description:` — e.g. "trade my 2nd rounder to the Cowboys for their 3rd and 5th"\n' +
          'The AI knows every team\'s picks, rosters, and future pick rights. It will propose the trade and notify the other GM.',
        inline: false,
      },
      {
        name: '💡 Trade Tips',
        value:
          '• You can trade the pick you\'re **currently on the clock for** — the new owner will immediately be put on the clock.\n' +
          '• Picks can be entered as overall # (`5`), round.pick (`1.5`), or chosen from the dropdown.\n' +
          '• Players can be entered by name or jersey number.\n' +
          '• Future picks use the format `YYYYRn` — e.g. `2027R1` for a 2027 first-round pick. If a team has multiple picks in the same round, add `-TEAM` to specify which (e.g. `2027R5-CAR` for the pick originally from Carolina). Without `-TEAM`, defaults to the team\'s own pick.\n' +
          '• Trades expire after **24 hours** if not accepted.\n' +
          '• A pick can appear in multiple proposals — when one is accepted, overlapping trades are automatically cancelled.',
        inline: false,
      },
    );

  const admin = new EmbedBuilder()
    .setColor(color)
    .setTitle('🔧 Admin Commands')
    .setDescription('These commands require **Administrator** permission.')
    .addFields(
      {
        name: 'Draft Setup — `/draft setup`',
        value:
          'Configure the draft before it starts.\n' +
          '• `channel` — where pick announcements are posted\n' +
          '• `timer` — minutes per pick (0 = no timer)\n' +
          '• `autopick` — whether the bot auto-picks for unregistered teams\n' +
          '• `rounds` — how many rounds to run (1–7, default 7)\n' +
          '• `allow-player-trades` — toggle whether players can be included in trades (default: on)\n' +
          '• `trade-announcement` — **private** (no notification), **public** (full details), or **intrigue** (ping without details, default)',
        inline: false,
      },
      {
        name: 'Draft Control — `/draft start` · `pause` · `resume` · `reset` · `wipe` · `rewind`',
        value:
          '• `/draft start` — begin the draft\n' +
          '• `/draft pause` / `resume` — freeze and unfreeze\n' +
          '• `/draft reset` — clear picks, trades, and schedule; keeps assignments, boards, and config\n' +
          '• `/draft wipe` — erase everything including assignments and boards\n' +
          '• `/draft rewind round: pick:` — roll back to any pick',
        inline: false,
      },
      {
        name: 'Override Commands — `/draft admin`',
        value:
          '• `/draft admin assign team: user:` — assign any team to any user\n' +
          '• `/draft admin co-manager team: user:` — add a co-manager to any team\n' +
          '• `/draft admin undo-trade id:` — reverse a completed trade (autocomplete shows history)\n' +
          '• `/draft admin pick` — make a pick for the team currently on the clock\n' +
          '• `/draft admin forceautopick` — force an auto-pick using the team\'s board/priority',
        inline: false,
      },
      {
        name: 'Force Trade — `/trade force`',
        value:
          'Execute a trade immediately between any two teams without a proposal/acceptance flow.\n' +
          '> `/trade force offer-team: receive-team:` plus the same pick/player/future fields as `/trade propose`',
        inline: false,
      },
    );

  await interaction.reply({ embeds: [quickStart, overview, trading], ephemeral: true });
  await interaction.followUp({ embeds: [admin], ephemeral: true });
}
