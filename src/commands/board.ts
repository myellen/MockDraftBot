import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
} from 'discord.js';
import { DraftManager } from '../draft/DraftManager';
import { getTopPicks, ScorerContext } from '../draft/DraftScorer';
import { ALL_POSITIONS } from '../data/prospects';
import { Prospect, TeamNeeds } from '../draft/types';
import { TEAMS } from '../data/teams';
import { isAdmin } from '../utils/permissions';
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
    .addStringOption(opt => opt
      .setName('team')
      .setDescription('Override board for a specific team (admin only)')
      .setRequired(false)
      .setAutocomplete(true)
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
    .setName('needs')
    .setDescription('Set team position needs for smarter autopick')
    .addStringOption(opt => opt
      .setName('primary')
      .setDescription('Critical needs — comma-separated positions (e.g. EDGE,CB,LB)')
      .setRequired(false)
      .setAutocomplete(true)
    )
    .addStringOption(opt => opt
      .setName('secondary')
      .setDescription('Secondary needs — comma-separated positions (e.g. WR,S,DT)')
      .setRequired(false)
      .setAutocomplete(true)
    )
    .addStringOption(opt => opt
      .setName('depth')
      .setDescription('Depth positions — comma-separated positions (e.g. OG,RB)')
      .setRequired(false)
      .setAutocomplete(true)
    )
  )
  .addSubcommand(sub => sub
    .setName('explain')
    .setDescription('Show how the scoring engine ranks your top picks')
    .addIntegerOption(opt => opt
      .setName('count')
      .setDescription('Number of picks to show (default: 5)')
      .setMinValue(1)
      .setMaxValue(15)
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
        { name: 'Position needs only',   value: 'needs'    },
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
    const overrideTeam = interaction.options.getString('team')?.toUpperCase() ?? null;

    if (overrideTeam && !isAdmin(interaction)) {
      await interaction.reply({ content: '❌ Only admins can submit a board for another team.', ephemeral: true });
      return;
    }

    const teamAbbr = overrideTeam ?? manager.getUserTeam(interaction.user.id);
    if (!teamAbbr) {
      await interaction.reply({ content: '❌ You need a registered team to submit a board.', ephemeral: true });
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

  if (sub === 'needs') {
    const teamAbbr = manager.getUserTeam(interaction.user.id);
    if (!teamAbbr) {
      await interaction.reply({ content: '❌ You need a registered team to set needs.', ephemeral: true });
      return;
    }

    const primaryStr = interaction.options.getString('primary');
    const secondaryStr = interaction.options.getString('secondary');
    const depthStr = interaction.options.getString('depth');

    // If no arguments, display current needs
    if (!primaryStr && !secondaryStr && !depthStr) {
      const current = manager.getTeamNeeds(teamAbbr);
      if (!current) {
        await interaction.reply({
          content: `No needs set for **${teamAbbr}**. Autopick will auto-detect from roster depth.\nUse \`/board needs primary:EDGE,CB secondary:WR,S\` to set them manually.`,
          ephemeral: true,
        });
        return;
      }
      const lines: string[] = [`**${teamAbbr} Position Needs:**`];
      if (current.primary.length > 0) lines.push(`🔴 **Primary:** ${current.primary.join(', ')}`);
      if (current.secondary.length > 0) lines.push(`🟡 **Secondary:** ${current.secondary.join(', ')}`);
      if (current.depth.length > 0) lines.push(`🟢 **Depth:** ${current.depth.join(', ')}`);
      await interaction.reply({ content: lines.join('\n'), ephemeral: true });
      return;
    }

    // Parse and validate positions
    const parse = (str: string | null): string[] =>
      str ? str.split(',').map(p => p.trim().toUpperCase()).filter(Boolean) : [];

    const primary = parse(primaryStr);
    const secondary = parse(secondaryStr);
    const depth = parse(depthStr);

    const allPositions = [...primary, ...secondary, ...depth];
    const invalid = allPositions.filter(p => !ALL_POSITIONS.includes(p));
    if (invalid.length > 0) {
      await interaction.reply({
        content: `❌ Unknown position${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}\nValid: ${ALL_POSITIONS.join(', ')}`,
        ephemeral: true,
      });
      return;
    }

    const needs: TeamNeeds = { primary, secondary, depth };
    manager.setTeamNeeds(teamAbbr, needs);

    const lines: string[] = [`✅ Needs set for **${teamAbbr}**:`];
    if (primary.length > 0) lines.push(`🔴 **Primary:** ${primary.join(', ')}`);
    if (secondary.length > 0) lines.push(`🟡 **Secondary:** ${secondary.join(', ')}`);
    if (depth.length > 0) lines.push(`🟢 **Depth:** ${depth.join(', ')}`);
    lines.push('\nAutopick will prioritize these positions when scoring prospects.');
    await interaction.reply({ content: lines.join('\n'), ephemeral: true });
    return;
  }

  if (sub === 'explain') {
    const teamAbbr = manager.getUserTeam(interaction.user.id);
    if (!teamAbbr) {
      await interaction.reply({ content: '❌ You need a registered team to view scoring.', ephemeral: true });
      return;
    }

    const state = manager.getState();
    if (state.availableRanks.length === 0) {
      await interaction.reply({ content: '❌ The draft hasn\'t started yet — no prospects to score.', ephemeral: true });
      return;
    }

    const count = interaction.options.getInteger('count') ?? 5;
    const ctx = manager.buildScorerContext(teamAbbr);
    const top = getTopPicks(ctx, count);

    if (top.length === 0) {
      await interaction.reply({ content: '❌ No available prospects to score.', ephemeral: true });
      return;
    }

    const medals = ['🥇', '🥈', '🥉'];
    const lines = top.map((sp, i) => {
      const medal = medals[i] ?? `**${i + 1}.**`;
      const p = sp.prospect;
      return `${medal} **${p.name}** (${p.pos}, #${p.rank})\n` +
        `   Board: \`${sp.boardScore.toFixed(3)}\` × PosVal: \`${sp.positionalValue.toFixed(3)}\` × ` +
        `Need: \`${sp.needUrgency.toFixed(3)}\` × Scarcity: \`${sp.scarcityPremium.toFixed(3)}\` = **${sp.compositeScore.toFixed(4)}**`;
    });

    // Show current needs config at bottom
    const needs = manager.getTeamNeeds(teamAbbr);
    const needsLine = needs
      ? [
          needs.primary.length > 0 ? `🔴 ${needs.primary.join(', ')}` : null,
          needs.secondary.length > 0 ? `🟡 ${needs.secondary.join(', ')}` : null,
          needs.depth.length > 0 ? `🟢 ${needs.depth.join(', ')}` : null,
        ].filter(Boolean).join('  ')
      : '_Auto-detected from roster_';

    const embed = new EmbedBuilder()
      .setTitle(`Scoring Breakdown — ${TEAMS[teamAbbr]?.name ?? teamAbbr}`)
      .setDescription(lines.join('\n\n'))
      .setFooter({ text: `Needs: ${needsLine}` })
      .setColor(TEAMS[teamAbbr]?.color ?? 0x888888);

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (sub === 'clear') {
    const teamAbbr = manager.getUserTeam(interaction.user.id);
    if (!teamAbbr) {
      await interaction.reply({ content: '❌ You need a registered team.', ephemeral: true });
      return;
    }

    const what = (interaction.options.getString('what') ?? 'all') as 'board' | 'priority' | 'needs' | 'all';
    manager.clearBoard(teamAbbr, what);

    const labels: Record<string, string> = {
      board: 'custom board',
      priority: 'position priority',
      needs: 'position needs',
      all: 'custom board, position priority, and needs',
    };
    await interaction.reply({ content: `✅ Cleared your ${labels[what]}. Autopick will use default rank order.`, ephemeral: true });
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

  if (sub === 'priority' || sub === 'needs') {
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
