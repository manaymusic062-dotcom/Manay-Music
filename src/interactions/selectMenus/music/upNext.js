import { MessageFlags } from 'discord.js';
import { getPlayer } from '../../../services/music/musicActions.js';
import { getGuildMusicData } from '../../../services/music/playerStore.js';
import { canControlMusic, VOICE_CHANNEL_DENIAL } from '../../../services/music/permissions.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { MUSIC_BUTTON_IDS } from '../../../services/music/musicEmbeds.js';

export default {
    name: MUSIC_BUTTON_IDS.UP_NEXT,
    async execute(interaction, client) {
        const player = getPlayer(client, interaction.guild.id);
        if (!player?.current) {
            return replyUserError(interaction, {
                type: ErrorTypes.USER_INPUT,
                message: 'Nothing is playing right now.',
            });
        }

        if (!canControlMusic(interaction.member, player)) {
            return replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: VOICE_CHANNEL_DENIAL,
            });
        }

        const queueIndex = Number(interaction.values?.[0]);
        if (!Number.isInteger(queueIndex) || queueIndex < 0 || queueIndex >= player.queue.length) {
            return replyUserError(interaction, {
                type: ErrorTypes.USER_INPUT,
                message: 'That track is no longer in the queue. Try again.',
            });
        }

        const selectedTrack = player.queue[queueIndex];
        const guildData = getGuildMusicData(interaction.guild.id);

        await interaction.deferUpdate();

        if (queueIndex > 0) {
            player.queue.splice(0, queueIndex);
        }
        if (player.loop === 'track') {
            player.setLoop('none');
        }
        player.stop();

        await interaction.followUp({
            content: `Skipping to **${selectedTrack.info?.title || 'selected track'}**.`,
            flags: MessageFlags.Ephemeral,
        }).catch(() => {});

        guildData.queuePages.clear();
    },
};
