import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { successEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { botHasPermission } from '../../utils/permissionGuard.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { getGuildMusicData, clearUpdateInterval } from './playerStore.js';
import { canControlMusic, requireVoiceChannel, VOICE_CHANNEL_DENIAL } from './permissions.js';
import {
    buildNowPlayingEmbed,
    buildQueueEmbed,
    buildQueuePaginationRow,
    getQueuePageSize,
} from './musicEmbeds.js';
import { refreshPlayerMessage } from './playerHandler.js';
import { setVoiceChannelMusicStatus } from './voiceChannelStatus.js';
import {
    createMusicPlayer,
    getBotVoiceChannelId,
    isPlayerStale,
    markNodeBad,
    safeDestroyPlayer,
    sendVoiceLeave,
    voiceLooksBroken,
    waitForBotLeave,
    waitForTrackStart,
} from './voiceRecovery.js';

const YOUTUBE_URL_PATTERN = /(?:youtube\.com|youtu\.be)/i;

// How long to wait for Lavalink to confirm a track actually started.
const PLAYBACK_START_TIMEOUT_MS = 10 * 1000;
// After a track starts, check that the voice connection to Discord really works.
const VOICE_HEALTH_CHECK_MS = 8 * 1000;
const VOICE_HEALTH_MAX_RETRIES = 2;

function getConnectedLavalinkNodes(client) {
    if (!client.riffy?.nodeMap) {
        return [];
    }

    return [...client.riffy.nodeMap.values()].filter((node) => node.connected);
}

export function assertLavalinkNodeAvailable(client) {
    if (!getConnectedLavalinkNodes(client).length) {
        throw new TitanBotError(
            'Lavalink unavailable',
            ErrorTypes.CONFIGURATION,
            'Music is temporarily unavailable — no Lavalink nodes are connected. Try again shortly or configure your own Lavalink server.',
        );
    }
}

function assertBotVoicePermissions(channel) {
    if (!channel) {
        throw new TitanBotError(
            'Voice channel unavailable',
            ErrorTypes.CONFIGURATION,
            'Could not access that voice channel.',
        );
    }

    if (!botHasPermission(channel, [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
        throw new TitanBotError(
            'Missing voice permissions',
            ErrorTypes.PERMISSION,
            'I need **Connect** and **Speak** permissions in your voice channel.',
        );
    }
}

// True when the player has nothing active and a freshly queued track must be started.
// (A player flagged "playing" without a loaded track is inconsistent, so start it too.)
function needsPlaybackStart(player) {
    if (player.paused) {
        return false;
    }
    return !player.playing || !player.current;
}

// Starts playback and waits until Lavalink confirms the track really began.
// Returns false when it failed (no voice connection, dead node, timeout, ...).
async function tryStartPlayback(client, player) {
    const started = waitForTrackStart(client, player.guildId, PLAYBACK_START_TIMEOUT_MS);

    try {
        await player.play();
    } catch (error) {
        started.cancel();
        logger.warn('Lavalink playback start failed:', {
            guildId: player.guildId,
            node: player.node?.name,
            error: error?.message || error,
        });
        player.playing = false;
        return false;
    }

    const ok = await started.promise;
    if (!ok) {
        logger.warn('Lavalink did not confirm track start in time:', {
            guildId: player.guildId,
            node: player.node?.name,
        });
        player.playing = false;
    }
    return ok;
}

// Tear the player down, leave voice, and open a brand-new connection (on a different
// node when possible), carrying over the tracks that were waiting to play. Leaving
// first is what forces Discord to hand out fresh voice credentials - the same thing
// the "End Session" button used to do by hand.
async function rebuildPlayer(client, { guildId, voiceChannelId, textChannelId, oldPlayer, keepTracks = true }) {
    const guildData = getGuildMusicData(guildId);
    const carry = [];

    if (keepTracks && oldPlayer) {
        if (oldPlayer.playing && oldPlayer.current) {
            carry.push(oldPlayer.current);
        }
        carry.push(...oldPlayer.queue);
    }

    const avoidNode = oldPlayer?.node || null;

    if (oldPlayer) {
        await destroyPlayerSession(client, guildId, oldPlayer, guildData, { forceDisconnect: true });
    }

    sendVoiceLeave(client, guildId);
    await waitForBotLeave(client, guildId);

    const fresh = createMusicPlayer(
        client,
        { guildId, voiceChannel: voiceChannelId, textChannel: textChannelId, deaf: true },
        { avoidNode },
    );
    guildData.playerChannelId = textChannelId;
    fresh.setVolume(guildData.volume);

    for (const track of carry) {
        fresh.queue.add(track);
    }
    return fresh;
}

// Start playback; if it does not come up, rebuild the connection once and retry.
// Never leaves a half-dead player behind (that is what made songs "only queue").
async function startPlaybackWithRecovery(client, interaction, player) {
    if (await tryStartPlayback(client, player)) {
        scheduleVoiceHealthCheck(client, player);
        return player;
    }

    const guildId = player.guildId;
    logger.warn('Playback did not start; rebuilding the voice connection and retrying once.', { guildId });

    const rebuilt = await rebuildPlayer(client, {
        guildId,
        voiceChannelId: interaction.member.voice.channel.id,
        textChannelId: interaction.channel.id,
        oldPlayer: player,
    });

    if (await tryStartPlayback(client, rebuilt)) {
        scheduleVoiceHealthCheck(client, rebuilt);
        return rebuilt;
    }

    await destroyPlayerSession(
        client,
        guildId,
        getPlayer(client, guildId),
        getGuildMusicData(guildId),
        { forceDisconnect: true },
    );
    throw new TitanBotError(
        'Playback failed',
        ErrorTypes.CONFIGURATION,
        'Could not start playback. The music server may be busy - please try again in a moment.',
    );
}

function notifyMusicChannel(client, guildData, text) {
    const channel = guildData.playerChannelId && client.channels.cache.get(guildData.playerChannelId);
    channel?.send?.(text).catch?.(() => null);
}

// "Now Playing" with no sound: Lavalink started the track, but its voice connection to
// Discord is broken (node without DAVE support, voice region problem, ...). A few seconds
// after playback starts, verify the connection; if it is broken, move the session to a
// different node automatically - no manual "End Session" needed.
function scheduleVoiceHealthCheck(client, player, attempt = 0) {
    const timer = setTimeout(async () => {
        const guildId = player.guildId;
        try {
            if (getPlayer(client, guildId) !== player || !voiceLooksBroken(player)) {
                return;
            }

            const guildData = getGuildMusicData(guildId);
            markNodeBad(player.node);
            logger.warn('Voice connection is not working; moving to another node.', {
                guildId,
                node: player.node?.name,
                attempt: attempt + 1,
            });

            if (attempt >= VOICE_HEALTH_MAX_RETRIES) {
                notifyMusicChannel(client, guildData, 'I joined the voice channel but audio could not be delivered. Please try again in a moment.');
                await destroyPlayerSession(client, guildId, player, guildData, { forceDisconnect: true });
                return;
            }

            const rebuilt = await rebuildPlayer(client, {
                guildId,
                voiceChannelId: player.voiceChannel,
                textChannelId: guildData.playerChannelId || player.textChannel,
                oldPlayer: player,
            });

            if (await tryStartPlayback(client, rebuilt)) {
                scheduleVoiceHealthCheck(client, rebuilt, attempt + 1);
            } else {
                notifyMusicChannel(client, guildData, 'Could not restore audio. Please use the play command again.');
                await destroyPlayerSession(client, guildId, rebuilt, guildData, { forceDisconnect: true });
            }
        } catch (error) {
            logger.warn('Voice health check failed:', { guildId: player.guildId, error: error?.message || error });
        }
    }, VOICE_HEALTH_CHECK_MS);
    timer.unref?.();
}

// Someone is adding music while the bot is auto-paused (voice channel had been empty).
async function resumeIfAutoPaused(client, guildId) {
    const guildData = getGuildMusicData(guildId);
    if (guildData.autoPaused) {
        guildData.autoPaused = false;
        await applyResume(client, guildId);
    }
}

export function getPlayer(client, guildId) {
    return client.riffy?.players?.get(guildId) || null;
}

export function assertRiffyAvailable(client) {
    if (!client.riffy) {
        throw new TitanBotError(
            'Lavalink not configured',
            ErrorTypes.CONFIGURATION,
            'Music is unavailable — Lavalink is not configured.',
        );
    }
}

export function assertInVoice(member) {
    if (!requireVoiceChannel(member)) {
        throw new TitanBotError(
            'Not in voice channel',
            ErrorTypes.USER_INPUT,
            'You need to be in a voice channel.',
        );
    }
}

export function assertCanControl(member, player) {
    if (!canControlMusic(member, player)) {
        throw new TitanBotError(
            'Wrong voice channel',
            ErrorTypes.PERMISSION,
            VOICE_CHANNEL_DENIAL,
        );
    }
}

export async function ensurePlayer(client, interaction) {
    assertRiffyAvailable(client);
    assertLavalinkNodeAvailable(client);
    assertInVoice(interaction.member);

    const guildId = interaction.guild.id;
    const guildData = getGuildMusicData(guildId);
    const userChannel = interaction.member.voice.channel;
    assertBotVoicePermissions(userChannel);

    let player = getPlayer(client, guildId);

    if (player) {
        const idle = !player.playing && !player.paused && !player.queue.length;
        const inOtherChannel = player.voiceChannel !== userChannel.id;

        // A leftover/dead player (kicked, restarted, node dropped, never connected)
        // must not be reused, otherwise songs only get queued and never play.
        if (isPlayerStale(client, player) || (idle && inOtherChannel)) {
            logger.warn('Replacing stale music player.', { guildId, node: player.node?.name });
            player = await rebuildPlayer(client, {
                guildId,
                voiceChannelId: userChannel.id,
                textChannelId: interaction.channel.id,
                oldPlayer: player,
                keepTracks: !inOtherChannel,
            });
        }
    }

    if (!player) {
        player = await openFreshPlayer(client, interaction, userChannel);
    }

    player.setVolume(guildData.volume);
    return { player, guildData };
}

// Discord can still list the bot in a voice channel with no player behind it (after a
// restart or kick). Leave first so the next join receives fresh voice credentials.
async function openFreshPlayer(client, interaction, channel) {
    const guildId = interaction.guild.id;
    const guildData = getGuildMusicData(guildId);

    if (getBotVoiceChannelId(client, guildId)) {
        sendVoiceLeave(client, guildId);
        await waitForBotLeave(client, guildId);
    }

    const player = createMusicPlayer(client, {
        guildId,
        voiceChannel: channel.id,
        textChannel: interaction.channel.id,
        deaf: true,
    });
    guildData.playerChannelId = interaction.channel.id;
    return player;
}

function isDuplicateTrack(player, track) {
    const uri = track?.info?.uri;
    if (!uri) {
        return false;
    }
    if (player.current?.info?.uri === uri) {
        return true;
    }
    return player.queue.some((existing) => existing.info?.uri === uri);
}

export async function joinVoiceChannel(client, interaction) {
    assertRiffyAvailable(client);
    assertInVoice(interaction.member);

    const guildId = interaction.guild.id;
    const guildData = getGuildMusicData(guildId);
    const channel = interaction.member.voice.channel;
    assertBotVoicePermissions(channel);
    let player = getPlayer(client, guildId);

    if (player && (player.voiceChannel !== channel.id || isPlayerStale(client, player))) {
        safeDestroyPlayer(client, player);
        player = null;
    }

    if (!player) {
        assertLavalinkNodeAvailable(client);
        player = await openFreshPlayer(client, interaction, channel);
    }

    player.setVolume(guildData.volume);

    return successEmbed(
        'Joined Voice Channel',
        `Connected to **${channel.name}**. Use /play to start music, or /music for playback controls.`,
    );
}

export async function playQuery(client, interaction, query) {
    if (YOUTUBE_URL_PATTERN.test(query)) {
        throw new TitanBotError(
            'YouTube URL blocked',
            ErrorTypes.USER_INPUT,
            'YouTube links are not supported. Try a song name instead.',
        );
    }

    const { player: initialPlayer } = await ensurePlayer(client, interaction);
    let player = initialPlayer;
    const guildId = interaction.guild.id;

    const result = await client.riffy.resolve({
        query,
        requester: interaction.user,
    });

    const { loadType, tracks, playlistInfo } = result;

    if (loadType === 'playlist' || loadType === 'PLAYLIST_LOADED') {
        let added = 0;
        let skipped = 0;
        const shouldStart = needsPlaybackStart(player);

        for (const track of tracks) {
            track.info.requester = interaction.user;
            if (isDuplicateTrack(player, track)) {
                skipped += 1;
                continue;
            }
            player.queue.add(track);
            added += 1;
        }

        if (added > 0 && shouldStart) {
            player = await startPlaybackWithRecovery(client, interaction, player);
        } else if (added > 0) {
            await resumeIfAutoPaused(client, guildId);
        }

        return {
            embed: successEmbed(
                'Playlist Added',
                `**${playlistInfo?.name || 'Playlist'}**\nAdded ${added} of ${tracks.length} track(s).${skipped ? ` Skipped ${skipped} duplicate(s).` : ''}`,
            ),
        };
    }

    if (
        loadType === 'search'
        || loadType === 'track'
        || loadType === 'SEARCH_RESULT'
        || loadType === 'TRACK_LOADED'
    ) {
        const track = tracks?.[0];
        if (!track) {
            throw new TitanBotError('No results', ErrorTypes.USER_INPUT, 'No results found for that query.');
        }

        if (isDuplicateTrack(player, track)) {
            throw new TitanBotError(
                'Duplicate track',
                ErrorTypes.USER_INPUT,
                `**${track.info.title}** is already in the queue or playing.`,
            );
        }

        track.info.requester = interaction.user;

        const willPlayNow = needsPlaybackStart(player);
        player.queue.add(track);
        const queuePosition = player.queue.length;

        if (willPlayNow) {
            player = await startPlaybackWithRecovery(client, interaction, player);
        } else {
            await resumeIfAutoPaused(client, guildId);
        }

        return {
            embed: successEmbed(
                willPlayNow ? 'Now Playing' : 'Track Added',
                willPlayNow
                    ? `**${track.info.title}**\n${track.info.author}`
                    : `**${track.info.title}**\n${track.info.author}\nPosition: #${queuePosition} in queue`,
            ),
        };
    }

    throw new TitanBotError('No results', ErrorTypes.USER_INPUT, `No results found. (loadType: ${loadType})`);
}

export async function skipTrack(client, interaction) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player?.current) {
        throw new TitanBotError('No player', ErrorTypes.USER_INPUT, 'Nothing is playing right now.');
    }
    assertCanControl(interaction.member, player);
    const title = player.current.info?.title || 'Unknown';
    // Under track-loop, stop() would replay the same track. Clear it so the skip
    // advances; trackStart re-applies the stored loop mode to the next track.
    if (player.loop === 'track') {
        player.setLoop('none');
    }
    player.stop();
    return successEmbed('Skipped', `Skipped **${title}**.`);
}

export async function stopPlayback(client, interaction) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player) {
        throw new TitanBotError('No player', ErrorTypes.USER_INPUT, 'No active music player.');
    }
    assertCanControl(interaction.member, player);

    const guildData = getGuildMusicData(interaction.guild.id);
    const queueLength = player.queue?.length || 0;

    if (queueLength >= 5 && guildData.stopConfirmPending !== interaction.user.id) {
        guildData.stopConfirmPending = interaction.user.id;
        setTimeout(() => {
            if (guildData.stopConfirmPending === interaction.user.id) {
                guildData.stopConfirmPending = null;
            }
        }, 15000);
        return successEmbed(
            'Confirm Stop',
            `There are **${queueLength}** tracks in the queue. Run **/music stop** again within 15 seconds to confirm.`,
        );
    }

    guildData.stopConfirmPending = null;
    await destroyPlayerSession(client, interaction.guild.id, player, guildData);
    return successEmbed('Stopped', 'Playback stopped and the queue was cleared.');
}

export async function applyPause(client, guildId) {
    const player = getPlayer(client, guildId);
    if (!player?.current || player.paused) {
        return false;
    }

    player.pause(true);
    await refreshPlayerMessage(client, guildId);
    return true;
}

export async function applyResume(client, guildId) {
    const player = getPlayer(client, guildId);
    if (!player?.current || !player.paused) {
        return false;
    }

    player.pause(false);
    await refreshPlayerMessage(client, guildId);
    return true;
}

export async function pausePlayback(client, interaction) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player?.current) {
        throw new TitanBotError('No player', ErrorTypes.USER_INPUT, 'Nothing is playing right now.');
    }
    assertCanControl(interaction.member, player);

    if (player.paused) {
        throw new TitanBotError('Already paused', ErrorTypes.USER_INPUT, 'Playback is already paused.');
    }

    await applyPause(client, interaction.guild.id);
    return successEmbed('Paused', 'Playback paused.');
}

export async function resumePlayback(client, interaction) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player?.current) {
        throw new TitanBotError('No player', ErrorTypes.USER_INPUT, 'Nothing is playing right now.');
    }
    assertCanControl(interaction.member, player);

    if (!player.paused) {
        throw new TitanBotError('Not paused', ErrorTypes.USER_INPUT, 'Playback is not paused.');
    }

    await applyResume(client, interaction.guild.id);
    return successEmbed('Resumed', 'Playback resumed.');
}

export async function shuffleQueue(client, interaction) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player?.queue?.length) {
        throw new TitanBotError('Empty queue', ErrorTypes.USER_INPUT, 'The queue is empty.');
    }
    assertCanControl(interaction.member, player);
    player.queue.shuffle();
    getGuildMusicData(interaction.guild.id).shuffle = true;
    await refreshPlayerMessage(client, interaction.guild.id);
    return successEmbed('Shuffled', 'The queue has been shuffled.');
}

export async function setLoopMode(client, interaction, mode) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player) {
        throw new TitanBotError('No player', ErrorTypes.USER_INPUT, 'No active music player.');
    }
    assertCanControl(interaction.member, player);

    const guildData = getGuildMusicData(interaction.guild.id);
    guildData.loop = mode;
    player.setLoop(mode);

    const labels = { none: 'Off', track: 'Track', queue: 'Queue' };
    await refreshPlayerMessage(client, interaction.guild.id);
    return successEmbed('Loop Updated', `Loop mode set to **${labels[mode] || mode}**.`);
}

export async function toggleLoop(client, interaction) {
    const guildData = getGuildMusicData(interaction.guild.id);
    const next = guildData.loop === 'none' ? 'track' : guildData.loop === 'track' ? 'queue' : 'none';
    return setLoopMode(client, interaction, next);
}

export async function setVolume(client, interaction, volume) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player) {
        throw new TitanBotError('No player', ErrorTypes.USER_INPUT, 'No active music player.');
    }
    assertCanControl(interaction.member, player);

    const guildData = getGuildMusicData(interaction.guild.id);
    guildData.volume = Math.max(0, Math.min(100, volume));
    player.setVolume(guildData.volume);
    await refreshPlayerMessage(client, interaction.guild.id);
    return successEmbed('Volume Updated', `Volume set to **${guildData.volume}%**.`);
}

export async function adjustVolume(client, interaction, delta) {
    const guildData = getGuildMusicData(interaction.guild.id);
    return setVolume(client, interaction, guildData.volume + delta);
}

export async function seekTrack(client, interaction, seconds) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player?.current) {
        throw new TitanBotError('No player', ErrorTypes.USER_INPUT, 'Nothing is playing right now.');
    }
    assertCanControl(interaction.member, player);

    const info = player.current.info || {};
    if (info.isStream || info.isSeekable === false) {
        throw new TitanBotError(
            'Not seekable',
            ErrorTypes.USER_INPUT,
            'This track cannot be seeked (it may be a live stream).',
        );
    }

    const position = Math.max(0, seconds * 1000);
    if (info.length && position > info.length) {
        throw new TitanBotError(
            'Seek out of range',
            ErrorTypes.USER_INPUT,
            `You can only seek up to ${Math.floor(info.length / 1000)}s for this track.`,
        );
    }

    player.seek(position);
    await refreshPlayerMessage(client, interaction.guild.id);
    return successEmbed('Seeked', `Seeked to **${seconds}s**.`);
}

export async function removeFromQueue(client, interaction, index) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player?.queue?.length) {
        throw new TitanBotError('Empty queue', ErrorTypes.USER_INPUT, 'The queue is empty.');
    }
    assertCanControl(interaction.member, player);

    const queueIndex = index - 1;
    if (queueIndex < 0 || queueIndex >= player.queue.length) {
        throw new TitanBotError('Invalid index', ErrorTypes.USER_INPUT, `Invalid queue position. Queue has ${player.queue.length} track(s).`);
    }

    const removed = player.queue[queueIndex];
    player.queue.remove(queueIndex);
    await refreshPlayerMessage(client, interaction.guild.id);
    return successEmbed('Removed', `Removed **${removed.info?.title || 'track'}** from the queue.`);
}

export async function moveInQueue(client, interaction, from, to) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player?.queue?.length) {
        throw new TitanBotError('Empty queue', ErrorTypes.USER_INPUT, 'The queue is empty.');
    }
    assertCanControl(interaction.member, player);

    const fromIndex = from - 1;
    const toIndex = to - 1;
    if (fromIndex < 0 || fromIndex >= player.queue.length || toIndex < 0 || toIndex >= player.queue.length) {
        throw new TitanBotError('Invalid index', ErrorTypes.USER_INPUT, 'Invalid queue positions.');
    }

    const track = player.queue[fromIndex];
    player.queue.remove(fromIndex);
    player.queue.splice(toIndex, 0, track);
    await refreshPlayerMessage(client, interaction.guild.id);
    return successEmbed('Moved', `Moved **${track.info?.title || 'track'}** to position #${to}.`);
}

export async function clearQueue(client, interaction) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player?.queue?.length) {
        throw new TitanBotError('Empty queue', ErrorTypes.USER_INPUT, 'The queue is already empty.');
    }
    assertCanControl(interaction.member, player);
    player.queue.clear();
    await refreshPlayerMessage(client, interaction.guild.id);
    return successEmbed('Queue Cleared', 'All queued tracks were removed.');
}

export async function setTwentyFourSeven(client, interaction, enabled) {
    const guildData = getGuildMusicData(interaction.guild.id);
    guildData.twentyFourSeven = enabled;
    return successEmbed(
        '24/7 Mode',
        enabled
            ? '24/7 mode enabled. The bot will stay in the voice channel when the queue ends.'
            : '24/7 mode disabled. The bot will leave after 30 seconds of idle time.',
    );
}

export function buildNowPlayingReply(client, guildId) {
    const player = getPlayer(client, guildId);
    if (!player?.current) {
        throw new TitanBotError('No player', ErrorTypes.USER_INPUT, 'Nothing is playing right now.');
    }
    const guildData = getGuildMusicData(guildId);
    const guildName = client.guilds.cache.get(guildId)?.name;
    return {
        embeds: [buildNowPlayingEmbed(player.current, player, guildData, guildName)],
    };
}

export function buildQueueReply(client, guildId, page = 0) {
    const player = getPlayer(client, guildId);
    if (!player) {
        throw new TitanBotError('No player', ErrorTypes.USER_INPUT, 'No active music player.');
    }

    const totalPages = Math.max(1, Math.ceil((player.queue?.length || 0) / getQueuePageSize()));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);

    return {
        embeds: [buildQueueEmbed(player.queue, player.current, safePage)],
        components: totalPages > 1 ? [buildQueuePaginationRow(safePage, totalPages)] : [],
        page: safePage,
        totalPages,
    };
}

export async function destroyPlayerSession(client, guildId, player, guildData, { forceDisconnect = false } = {}) {
    clearUpdateInterval(guildData);
    setVoiceChannelMusicStatus(client, player?.voiceChannel).catch(() => {});
    if (guildData.idleTimeout) {
        clearTimeout(guildData.idleTimeout);
        guildData.idleTimeout = null;
    }

    guildData.previousTracks = [];
    guildData.stopConfirmPending = null;
    guildData.autoPaused = false;
    guildData.queuePages?.clear();

    if (guildData.playerMessageId && guildData.playerChannelId) {
        try {
            const channel = client.channels.cache.get(guildData.playerChannelId);
            if (channel) {
                const msg = await channel.messages.fetch(guildData.playerMessageId);
                await msg.delete();
            }
        } catch {
            // message already deleted
        }
    }

    guildData.playerMessageId = null;
    guildData.playerChannelId = null;

    if (player) {
        player.queue.clear();
        try {
            player.stop();
        } catch (error) {
            // node may already be down; destroying the player below still cleans up
            logger.debug(`Error stopping player for guild ${guildId}: ${error?.message || error}`);
        }
        if (forceDisconnect || !guildData.twentyFourSeven) {
            safeDestroyPlayer(client, player);
        }
    }
}

export async function leaveVoiceChannel(client, interaction) {
    assertRiffyAvailable(client);

    const guildId = interaction.guild.id;
    const player = getPlayer(client, guildId);
    if (!player) {
        throw new TitanBotError('No player', ErrorTypes.USER_INPUT, 'I am not in a voice channel.');
    }
    assertCanControl(interaction.member, player);

    const channel = interaction.guild.channels.cache.get(player.voiceChannel);
    const channelName = channel?.name || 'voice channel';
    const guildData = getGuildMusicData(guildId);

    await destroyPlayerSession(client, guildId, player, guildData, { forceDisconnect: true });

    return successEmbed('Left Voice Channel', `Disconnected from **${channelName}**.`);
}

export async function replyMusicSuccess(interaction, embed) {
    const options = { embeds: [embed] };
    if (!interaction._isPrefixCommand) {
        options.flags = MessageFlags.Ephemeral;
    }
    await InteractionHelper.safeReply(interaction, options);
}
