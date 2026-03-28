import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  AutocompleteInteraction, ChannelType, EmbedBuilder
} from 'discord.js';
import { DraftManager } from '../draft/DraftManager';
import { TEAMS } from '../data/teams';
import { isAdmin } from '../utils/permissions';
import { buildAssignmentsEmbed } from '../utils/embeds';

export const data = new SlashCommandBuilder()
  .setName('draft')
  .setDescription('2026 NFL Mock Draft management')
  .addSubcommand(sub => sub
    .setName('setup')
    .setDescription('Configure the draft (admin only)')
    .addChannelOption(opt => opt
      .setName('channel')
      .setDescription('Channel for draft announcements')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true)
    )
    .addIntegerOption(opt => opt
      .setName('timer')
      .setDescription('Seconds per pick (0 = no timer)')
      .setMinValue(0)
      .setMaxValue(600)
      .setRequired(false)
    )
    .addBooleanOption(opt => opt
      .setName('autopick')
      .setDescription('Auto-pick for unassigned teams (default: true)')
      .setRequired(false)
    )
    .addIntegerOption(opt => opt
      .setName('rounds')
      .setDescription('Number of rounds to simulate (default: 7)')
      .setMinValue(1)
      .setMaxValue(7)
      .setRequired(false)
    )
  )
  .addSubcommand(sub => sub
    .setName('register')
    .setDescription('Claim an NFL team')
    .addStringOption(opt => opt
      .setName('team')
      .setDescription('Team abbreviation (e.g. LV, NYJ, KC)')
      .setRequired(true)
      .setAutocomplete(true)
    )
  )
  .addSubcommand(sub => sub
    .setName('unregister')
    .setDescription('Release your team')
  )
  .addSubcommand(sub => sub
    .setName('assignments')
    .setDescription('Show all team → user assignments')
  )
  .addSubcommand(sub => sub
    .setName('start')
    .setDescription('Begin the draft (admin only)')
  )
  .addSubcommand(sub => sub
    .setName('pause')
    .setDescription('Pause the draft (admin only)')
  )
  .addSubcommand(sub => sub
    .setName('resume')
    .setDescription('Resume the draft (admin only)')
  )
  .addSubcommand(sub => sub
    .setName('reset')
    .setDescription('Wipe all draft state and start over (admin only)')
  )
  .addSubcommand(sub => sub
    .setName('rewind')
    .setDescription('Rewind the draft to a specific pick (admin only)')
    .addIntegerOption(opt => opt
      .setName('round')
      .setDescription('Round number (1–7)')
      .setMinValue(1).setMaxValue(7)
      .setRequired(true)
    )
    .addIntegerOption(opt => opt
      .setName('pick')
      .setDescription('Pick number within the round (1–32)')
      .setMinValue(1).setMaxValue(32)
      .setRequired(true)
    )
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  manager: DraftManager
): Promise<void> {
  const sub = interaction.options.getSubcommand();

  // Admin-only commands
  const adminCmds = ['setup', 'start', 'pause', 'resume', 'reset', 'rewind'];
  if (adminCmds.includes(sub) && !isAdmin(interaction)) {
    await interaction.reply({ content: '❌ You need Administrator permission to use this command.', ephemeral: true });
    return;
  }

  if (sub === 'setup') {
    const channel = interaction.options.getChannel('channel', true);
    const timer = interaction.options.getInteger('timer') ?? null;
    const autopick = interaction.options.getBoolean('autopick') ?? true;
    const rounds = interaction.options.getInteger('rounds') ?? 7;

    await manager.setup({
      channelId: channel.id,
      timerSeconds: timer === 0 ? null : timer,
      autoPick: autopick,
      rounds,
    });

    const timerStr = timer ? `${timer}s per pick` : 'No timer';
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle('✅ Draft Configured')
          .addFields(
            { name: 'Channel',   value: `<#${channel.id}>`, inline: true },
            { name: 'Timer',     value: timerStr,            inline: true },
            { name: 'Auto-Pick', value: autopick ? 'On' : 'Off', inline: true },
            { name: 'Rounds',    value: String(rounds),      inline: true },
          )
          .setDescription('Now have GMs register their teams with `/draft register`, then use `/draft start` when ready.')
      ]
    });

  } else if (sub === 'register') {
    const teamAbbr = interaction.options.getString('team', true).toUpperCase();
    const result = await manager.registerTeam(teamAbbr, interaction.user.id);
    if (!result.success) {
      await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
      return;
    }
    const team = TEAMS[teamAbbr];
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(team.color)
          .setTitle('🏈 Team Registered!')
          .setDescription(`<@${interaction.user.id}> is now the GM of the **${team.name}**!`)
      ]
    });

  } else if (sub === 'unregister') {
    const result = await manager.unregisterTeam(interaction.user.id);
    if (!result.success) {
      await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
      return;
    }
    await interaction.reply({ content: '✅ You have released your team.', ephemeral: true });

  } else if (sub === 'assignments') {
    const state = manager.getState();
    const embed = buildAssignmentsEmbed(state.assignments, TEAMS);
    await interaction.reply({ embeds: [embed] });

  } else if (sub === 'start') {
    await interaction.deferReply();
    const result = await manager.start();
    if (!result.success) {
      await interaction.editReply(`❌ ${result.error}`);
      return;
    }
    await interaction.editReply({ content: '🏈 **The 2026 NFL Mock Draft has begun!**' });

  } else if (sub === 'pause') {
    await manager.pause();
    await interaction.reply({ content: '⏸️ Draft paused.', ephemeral: true });

  } else if (sub === 'resume') {
    await interaction.deferReply({ ephemeral: true });
    await manager.resume();
    await interaction.editReply('▶️ Draft resumed.');

  } else if (sub === 'reset') {
    await manager.reset();
    await interaction.reply({ content: '🗑️ Draft has been reset. All state cleared.', ephemeral: true });

  } else if (sub === 'rewind') {
    const round = interaction.options.getInteger('round', true);
    const pick = interaction.options.getInteger('pick', true);
    await interaction.deferReply({ ephemeral: true });
    const result = await manager.rewind(round, pick);
    if (!result.success) {
      await interaction.editReply(`❌ ${result.error}`);
      return;
    }
    await interaction.editReply(`⏪ Draft rewound to Round ${round}, Pick ${pick}.`);
  }
}

export async function autocomplete(
  interaction: AutocompleteInteraction,
  manager: DraftManager
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub !== 'register') return;

  const focused = interaction.options.getFocused().toUpperCase();
  const unassigned = manager.getUnassignedTeams();

  const choices = unassigned
    .filter(abbr => abbr.includes(focused) || TEAMS[abbr].name.toUpperCase().includes(focused))
    .slice(0, 25)
    .map(abbr => ({ name: `${TEAMS[abbr].name} (${abbr})`, value: abbr }));

  await interaction.respond(choices);
}
