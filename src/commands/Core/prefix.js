import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed, infoEmbed } from '../../utils/embeds.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import ConfigService from '../../services/config/configService.js';
import { getCommandPrefix } from '../../config/bot.js';
import { logger } from '../../utils/logger.js';

const MAX_PREFIX_LENGTH = 10;

function isValidPrefix(value) {
    return typeof value === 'string'
        && value.length >= 1
        && value.length <= MAX_PREFIX_LENGTH
        && !/\s/.test(value);
}

export default {
    category: 'Core',
    data: new SlashCommandBuilder()
        .setName('prefix')
        .setDescription('View or change the bot command prefix for this server')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false)
        .addSubcommand((sub) =>
            sub
                .setName('set')
                .setDescription('Set a custom command prefix for this server')
                .addStringOption((opt) =>
                    opt
                        .setName('value')
                        .setDescription(`New prefix (1-${MAX_PREFIX_LENGTH} characters, no spaces)`)
                        .setRequired(true)
                        .setMinLength(1)
                        .setMaxLength(MAX_PREFIX_LENGTH),
                ),
        )
        .addSubcommand((sub) =>
            sub.setName('show').setDescription('Show the current command prefix'),
        )
        .addSubcommand((sub) =>
            sub.setName('reset').setDescription('Reset the prefix back to the bot default'),
        ),

    async execute(interaction, config, client) {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: 'You need the **Manage Server** permission to change the prefix.',
            });
        }

        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;

        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) {
            return;
        }

        try {
            if (subcommand === 'show') {
                const guildConfig = await getGuildConfig(client, guildId);
                const current = guildConfig?.prefix || getCommandPrefix();
                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        infoEmbed(
                            'Server Prefix',
                            `The current command prefix is \`${current}\`.\nExample: \`${current}play never gonna give you up\``,
                        ),
                    ],
                });
            }

            const fallback = getCommandPrefix();

            if (subcommand === 'reset') {
                await ConfigService.updateSetting(client, guildId, 'prefix', fallback, interaction.user.id);
                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        successEmbed('Prefix Reset', `The command prefix is back to the default \`${fallback}\`.`),
                    ],
                });
            }

            const value = interaction.options.getString('value', true).trim();
            if (!isValidPrefix(value)) {
                return replyUserError(interaction, {
                    type: ErrorTypes.VALIDATION,
                    message: `Prefix must be 1-${MAX_PREFIX_LENGTH} characters with no spaces.`,
                });
            }

            await ConfigService.updateSetting(client, guildId, 'prefix', value, interaction.user.id);
            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [
                    successEmbed(
                        'Prefix Updated',
                        `The command prefix is now \`${value}\`.\nTry \`${value}play\`, \`${value}skip\`, or \`${value}help\`.`,
                    ),
                ],
            });
        } catch (error) {
            logger.error('Prefix command error:', error);
            await replyUserError(interaction, {
                type: ErrorTypes.CONFIGURATION,
                message: error?.details?.message || error?.message || 'Failed to update the prefix. Please try again.',
            });
        }
    },
};
