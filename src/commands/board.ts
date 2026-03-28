import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
} from 'discord.js';
import { DraftManager } from '../draft/DraftManager';
import { ALL_POSITIONS } from '../data/prospects';
import { TEAMS } from '../data/teams';
import { buildBoardEmbed, buildMyBoardEmbed } from '../utils/embeds';

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
  )
  .addSubcommand(sub => sub
    .setName('priority')
    .setDescription('Set autopick position priority (e.g. QB,OT,EDGE,CB)')
    .addStringOption(opt => opt
      .setName('positions')
      .setDescription('Positions in priority order — pick one, then type comma + next to add more')
      .setRequired(true)
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
  )
  .addSubcommand(sub => sub
    .setName('clear')
    .setDescription('Clear your submitted board and/or position priority')
    .addStringOption(opt => opt
      .setName('what')
      .setDescription('What to clear (default: all)')
      .setRequired(false)
      .addChoices(
        { name: 'Custom board only',     value: 'board'    },
        { name: 'Position priority only', value: 'priority' },
        { name: 'Everything',            value: 'all'      },
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
    const teamAbbr = manager.getUserTeam(interaction.user.id);
    if (!teamAbbr) {
      await interaction.reply({ content: '❌ You need a registered team to submit a board.', ephemeral: true });
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

  if (sub === 'priority') {
    const teamAbbr = manager.getUserTeam(interaction.user.id);
    if (!teamAbbr) {
      await interaction.reply({ content: '❌ You need a registered team to set position priority.', ephemeral: true });
      return;
    }

    const posStr = interaction.options.getString('positions', true);
    const positions = posStr.split(',').map(p => p.trim().toUpperCase()).filter(Boolean);
    const invalid = positions.filter(p => !ALL_POSITIONS.includes(p));
    if (invalid.length > 0) {
      await interaction.reply({ content: `❌ Unknown position${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}`, ephemeral: true });
      return;
    }

    manager.setPositionPriority(teamAbbr, positions);
    await interaction.reply({
      content: `✅ Position priority set for **${teamAbbr}**: ${positions.join(' → ')}\nIf your custom board runs out, autopick will target these positions in order.`,
      ephemeral: true,
    });
    return;
  }

  if (sub === 'myboard') {
    const teamAbbr = manager.getUserTeam(interaction.user.id);
    if (!teamAbbr) {
      await interaction.reply({ content: '❌ You need a registered team to view your board.', ephemeral: true });
      return;
    }
    const page = interaction.options.getInteger('page') ?? 1;
    const { entries, total, totalPages, page: safePage } = manager.getMyBoardPage(teamAbbr, page);
    if (total === 0) {
      await interaction.reply({ content: 'You have no custom board submitted yet. Use `/board submit` to upload one.', ephemeral: true });
      return;
    }
    const priority = manager.getPositionPriority(teamAbbr);
    const teamName = TEAMS[teamAbbr]?.name ?? teamAbbr;
    const embed = buildMyBoardEmbed(teamName, entries, safePage, totalPages, total, priority);
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (sub === 'clear') {
    const teamAbbr = manager.getUserTeam(interaction.user.id);
    if (!teamAbbr) {
      await interaction.reply({ content: '❌ You need a registered team.', ephemeral: true });
      return;
    }

    const what = (interaction.options.getString('what') ?? 'all') as 'board' | 'priority' | 'all';
    manager.clearBoard(teamAbbr, what);

    const label = what === 'board' ? 'custom board' : what === 'priority' ? 'position priority' : 'custom board and position priority';
    await interaction.reply({ content: `✅ Cleared your ${label}. Autopick will use default rank order.`, ephemeral: true });
    return;
  }
}

export async function autocomplete(
  interaction: AutocompleteInteraction,
  manager: DraftManager
): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === 'priority') {
    const focused = interaction.options.getFocused();
    const parts = focused.split(',');
    const currentFragment = parts[parts.length - 1].trim().toUpperCase();
    const prefix = parts.slice(0, -1).map(p => p.trim().toUpperCase()).filter(Boolean);
    const alreadyPicked = new Set(prefix);

    const teamAbbr = manager.getUserTeam(interaction.user.id);
    const existingPriority = teamAbbr ? manager.getPositionPriority(teamAbbr) : [];

    const choices = ALL_POSITIONS
      .filter(pos => !alreadyPicked.has(pos) && pos.includes(currentFragment))
      .slice(0, 25)
      .map(pos => {
        const displayValue = prefix.length > 0 ? `${prefix.join(',')},${pos}` : pos;
        const isSet = existingPriority.includes(pos);
        const label = prefix.length > 0 ? `[${prefix.join(', ')}, ${pos}] ${pos}` : pos;
        return { name: (isSet ? `★ ${label}` : label).slice(0, 100), value: displayValue };
      });

    await interaction.respond(choices);
    return;
  }

  await interaction.respond([]);
}
