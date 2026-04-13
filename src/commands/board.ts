import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
} from 'discord.js';
import { DraftManager } from '../discord/DraftManager';
import { TEAMS } from '../data/teams';
import { isAdmin } from '../utils/permissions';
import { buildBoardEmbed, buildMyBoardEmbed } from '../utils/embeds';
import { isAvailable as isBeastAvailable, getBeastRanking } from '../data/beastScouting';

export const data = new SlashCommandBuilder()
  .setName('board')
  .setDescription('Draft board tools')
  .addSubcommand(sub => sub
    .setName('view')
    .setDescription('View available draft prospects')
    .addStringOption(opt => opt
      .setName('position')
      .setDescription('Filter by position')
      .setRequired(false)
      .addChoices(
        { name: 'QB',   value: 'QB'   },
        { name: 'RB',   value: 'RB'   },
        { name: 'WR',   value: 'WR'   },
        { name: 'TE',   value: 'TE'   },
        { name: 'OT',   value: 'OT'   },
        { name: 'OG',   value: 'OG'   },
        { name: 'C',    value: 'C'    },
        { name: 'EDGE', value: 'EDGE' },
        { name: 'DE',   value: 'DE'   },
        { name: 'DT',   value: 'DT'   },
        { name: 'LB',   value: 'LB'   },
        { name: 'CB',   value: 'CB'   },
        { name: 'S',    value: 'S'    },
        { name: 'K',    value: 'K'    },
        { name: 'P',    value: 'P'    },
      )
    )
    .addIntegerOption(opt => opt
      .setName('page')
      .setDescription('Page number (default: 1)')
      .setMinValue(1)
      .setRequired(false)
    )
  )
  .addSubcommand(sub => sub
    .setName('submit')
    .setDescription('Upload your custom draft board (one player name per line)')
    .addAttachmentOption(opt => opt
      .setName('file')
      .setDescription('.txt or .csv file with player names in your preferred order')
      .setRequired(true)
    )
    .addStringOption(opt => opt
      .setName('team')
      .setDescription('Override board for a specific team (admin only)')
      .setRequired(false)
      .setAutocomplete(true)
    )
  )
  .addSubcommand(sub => sub
    .setName('myboard')
    .setDescription('View your submitted custom board')
    .addIntegerOption(opt => opt
      .setName('page')
      .setDescription('Page number (default: 1)')
      .setMinValue(1)
      .setRequired(false)
    )
    .addBooleanOption(opt => opt
      .setName('all')
      .setDescription('Show all pages at once')
      .setRequired(false)
    )
  )
  .addSubcommand(sub => sub
    .setName('clear')
    .setDescription('Clear your submitted board and/or strategy')
    .addStringOption(opt => opt
      .setName('what')
      .setDescription('What to clear (default: all)')
      .setRequired(false)
      .addChoices(
        { name: 'Custom board only', value: 'board'    },
        { name: 'Strategy only',     value: 'strategy' },
        { name: 'Everything',        value: 'all'      },
      )
    )
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  manager: DraftManager
): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === 'view') {
    const pos = interaction.options.getString('position') ?? undefined;
    const page = interaction.options.getInteger('page') ?? 1;
    const { prospects, totalPages, total } = manager.getAvailableProspects(pos, page);
    const embed = buildBoardEmbed(prospects, page, totalPages, total, pos);
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (sub === 'submit') {
    const overrideTeam = interaction.options.getString('team')?.toUpperCase() ?? null;

    if (overrideTeam && !isAdmin(interaction)) {
      await interaction.reply({ content: '❌ Only admins can submit a board for another team.', ephemeral: true });
      return;
    }

    const teamAbbr = overrideTeam ?? manager.getUserTeam(interaction.user.id);
    if (!teamAbbr) {
      await interaction.reply({ content: '❌ You need a registered team to submit a board. Use `/draft register` to claim one.', ephemeral: true });
      return;
    }
    if (!TEAMS[teamAbbr]) {
      await interaction.reply({ content: `❌ Unknown team: ${teamAbbr}`, ephemeral: true });
      return;
    }

    const attachment = interaction.options.getAttachment('file', true);
    if (!attachment.contentType?.startsWith('text') && !attachment.name?.match(/\.(txt|csv)$/i)) {
      await interaction.reply({ content: '❌ Please upload a `.txt` or `.csv` file.', ephemeral: true });
      return;
    }
    if (attachment.size > 200_000) {
      await interaction.reply({ content: '❌ File too large (max 200 KB).', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    let text: string;
    try {
      const res = await fetch(attachment.url);
      text = await res.text();
    } catch {
      await interaction.editReply('❌ Failed to download the file. Please try again.');
      return;
    }

    // Parse lines: strip leading rank numbers, position tags, extra whitespace
    const names = text
      .split(/\r?\n/)
      .map(line => line
        .replace(/^[\d]+[.):\-,\s]+/, '') // strip leading "1." / "1," / "1) "
        .replace(/\s*\([^)]*\)\s*$/, '')  // strip trailing "(QB)" / "(Ohio State)"
        .replace(/[\u2018\u2019\u02BC]/g, "'") // normalize curly/modifier apostrophes
        .trim()
      )
      .filter(Boolean);

    const { matched, unmatched } = manager.submitBoard(teamAbbr, names);

    let reply = `✅ Board submitted for the **${teamAbbr}**! Matched **${matched}** prospect${matched !== 1 ? 's' : ''}.`;
    if (unmatched.length > 0) {
      const shown = unmatched.slice(0, 10).map(n => `• ${n}`).join('\n');
      const extra = unmatched.length > 10 ? `\n_…and ${unmatched.length - 10} more_` : '';
      reply += `\n\n**${unmatched.length} unrecognized name${unmatched.length !== 1 ? 's' : ''} (skipped):**\n${shown}${extra}`;
    }
    reply += `\nWhen it's your pick and you're away, autopick will follow your board order.`;

    await interaction.editReply(reply);
    return;
  }

  if (sub === 'myboard') {
    const teamAbbr = manager.getUserTeam(interaction.user.id);
    if (!teamAbbr) {
      await interaction.reply({ content: '❌ You need a registered team to view your board. Use `/draft register` to claim one.', ephemeral: true });
      return;
    }
    const showAll = interaction.options.getBoolean('all') ?? false;
    const page = interaction.options.getInteger('page') ?? 1;
    const { entries, total, totalPages, page: safePage } = manager.getMyBoardPage(teamAbbr, page);
    if (total === 0) {
      await interaction.reply({ content: 'You have no custom board submitted yet. Use `/board submit` to upload one.', ephemeral: true });
      return;
    }
    const strategy = manager.getStrategyPrompt(teamAbbr);
    const teamName = TEAMS[teamAbbr]?.name ?? teamAbbr;
    const beastLookup = isBeastAvailable() ? getBeastRanking : undefined;

    if (showAll) {
      // Send each page as its own message (6000 char embed limit per message)
      const firstPage = manager.getMyBoardPage(teamAbbr, 1);
      const firstEmbed = buildMyBoardEmbed(teamName, firstPage.entries, 1, totalPages, total, strategy, beastLookup);
      await interaction.reply({ embeds: [firstEmbed], ephemeral: true });
      for (let p = 2; p <= totalPages; p++) {
        const pageData = manager.getMyBoardPage(teamAbbr, p);
        const embed = buildMyBoardEmbed(teamName, pageData.entries, p, totalPages, total, strategy, beastLookup);
        await interaction.followUp({ embeds: [embed], ephemeral: true });
      }
    } else {
      const embed = buildMyBoardEmbed(teamName, entries, safePage, totalPages, total, strategy, beastLookup);
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
    return;
  }

  if (sub === 'clear') {
    const teamAbbr = manager.getUserTeam(interaction.user.id);
    if (!teamAbbr) {
      await interaction.reply({ content: '❌ You need a registered team. Use `/draft register` to claim one.', ephemeral: true });
      return;
    }

    const what = (interaction.options.getString('what') ?? 'all') as 'board' | 'strategy' | 'all';
    manager.clearBoard(teamAbbr, what);

    const label = what === 'board' ? 'custom board' : what === 'strategy' ? 'strategy prompt' : 'custom board and strategy';
    await interaction.reply({ content: `✅ Cleared your ${label}. Autopick will use default rank order.`, ephemeral: true });
    return;
  }
}

export async function autocomplete(
  interaction: AutocompleteInteraction,
  manager: DraftManager
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const focused = interaction.options.getFocused();

  if (sub === 'submit') {
    await interaction.respond(manager.getTeamChoices(focused));
    return;
  }

  await interaction.respond([]);
}
