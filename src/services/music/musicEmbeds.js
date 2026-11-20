import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
} from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { getPaginationRow } from '../../utils/components.js';

const QUEUE_PAGE_SIZE = 10;

export const MUSIC_BUTTON_IDS = {
    PAUSE: 'music_pause',
    RESUME: 'music_resume',
    SKIP: 'music_skip',
    PREVIOUS: 'music_previous',
    STOP: 'music_stop',
    SHUFFLE: 'music_shuffle',
    LOOP: 'music_loop',
    VOL_DOWN: 'music_vol_down',
    VOL_UP: 'music_vol_up',
    QUEUE: 'music_queue',
    QUEUE_FIRST: 'music_queue_first',
    QUEUE_PREV: 'music_queue_prev',
    QUEUE_NEXT: 'music_queue_next',
    QUEUE_LAST: 'music_queue_last',
    AUTOPLAY: 'music_autoplay',
    UP_NEXT: 'music_up_next',
};

export function formatDuration(ms) {
    if (ms === null || ms === undefined || Number.isNaN(ms)) {
        return 'Live';
    }
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function getTrackArtwork(track) {
    return track?.info?.artworkUrl || track?.info?.thumbnail || null;
}

function getLoopLabel(loop) {
    switch (loop) {
        case 'track':
            return 'Track';
        case 'queue':
            return 'Queue';
        default:
            return 'Off';
    }
}

export function buildNowPlayingEmbed(track, player, guildData, guildName = null) {
    const requester = track?.info?.requester;
    const requesterLabel = requester
        ? (requester.username || requester.tag || 'Unknown')
        : 'Unknown';

    const position = formatDuration(player?.position || 0);
    const duration = formatDuration(track?.info?.length || 0);

    const title = track?.info?.title || 'Unknown track';
    const uri = track?.info?.uri;
    const linkedTitle = uri ? `[${title}](${uri})` : title;
    const source = track?.info?.sourceName
        ? `${track.info.sourceName.charAt(0).toUpperCase()}${track.info.sourceName.slice(1)}`
        : 'Music';

    return createEmbed({
        title: `Now Playing${guildName ? ` - ${guildName}` : ''}`,
        description: [
            `**${linkedTitle}**`,
            '',
            `👤 **${track?.info?.author || 'Unknown artist'}** · ⏱️ ${position} / ${duration}`,
            `💿 ${source} · Requested by **${requesterLabel}**`,
        ].join('\n'),
        color: 'primary',
        fields: [
            {
                name: 'Playback',
                value: `${player?.queue?.length || 0} queued · Loop ${getLoopLabel(guildData?.loop)} · Autoplay ${guildData?.autoplay ? 'On' : 'Off'}`,
                inline: false,
            },
        ],
        thumbnail: getTrackArtwork(track),
        footer: player?.paused ? 'Paused' : 'Playing',
    });
}

export function buildQueueEmbed(queue, currentTrack, page = 0) {
    const totalTracks = queue?.length || 0;
    const totalPages = Math.max(1, Math.ceil(totalTracks / QUEUE_PAGE_SIZE));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);
    const start = safePage * QUEUE_PAGE_SIZE;
    const slice = queue?.slice(start, start + QUEUE_PAGE_SIZE) || [];

    let description = '';
    if (currentTrack) {
        description += `**Now Playing**\n${currentTrack.info?.title || 'Unknown'} — ${currentTrack.info?.author || 'Unknown'}\n\n`;
    }

    if (slice.length === 0) {
        description += 'The queue is empty.';
    } else {
        description += slice
            .map((track, index) => {
                const num = start + index + 1;
                return `${num}. ${track.info?.title || 'Unknown'} — ${track.info?.author || 'Unknown'}`;
            })
            .join('\n');
    }

    return createEmbed({
        title: 'Music Queue',
        description: description.substring(0, 4096),
        color: 'info',
        footer: `Page ${safePage + 1} of ${totalPages} • ${totalTracks} queued`,
    });
}

export function buildPlayerButtonRows(player, guildData) {
    const paused = player?.paused;
    const queuedTracks = player?.queue?.slice(0, 25) || [];
    const upNextMenu = new StringSelectMenuBuilder()
        .setCustomId(MUSIC_BUTTON_IDS.UP_NEXT)
        .setPlaceholder(queuedTracks.length ? 'Up Next · choose a track' : 'Queue is empty')
        .setDisabled(queuedTracks.length === 0)
        .addOptions(
            queuedTracks.length
                ? queuedTracks.map((track, index) => ({
                    label: `${index + 1}. ${track.info?.title || 'Unknown track'}`.slice(0, 100),
                    description: (track.info?.author || 'Unknown artist').slice(0, 100),
                    value: String(index),
                }))
                : [{ label: 'Queue is empty', value: 'none' }],
        );

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(paused ? MUSIC_BUTTON_IDS.RESUME : MUSIC_BUTTON_IDS.PAUSE)
            .setLabel(paused ? 'Resume' : 'Pause')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(paused ? '▶️' : '⏸️'),
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.SKIP)
            .setLabel('Skip')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('⏭️'),
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.PREVIOUS)
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('⏮️')
            .setDisabled(!player?.previous),
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.QUEUE)
            .setLabel('Queue')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('➕'),
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.LOOP)
            .setLabel('Loop')
            .setStyle(guildData?.loop !== 'none' ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setEmoji('🔁'),
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.AUTOPLAY)
            .setLabel(`Autoplay ${guildData?.autoplay ? 'On' : 'Off'}`)
            .setStyle(guildData?.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setEmoji('🔀'),
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.STOP)
            .setLabel('End Session')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('⏹️'),
    );

    const selectRow = new ActionRowBuilder().addComponents(upNextMenu);
    return [selectRow, row1, row2];
}

export function buildQueuePaginationRow(page, totalPages) {
    return getPaginationRow('music_queue', page + 1, totalPages);
}

export function getQueuePageSize() {
    return QUEUE_PAGE_SIZE;
}
