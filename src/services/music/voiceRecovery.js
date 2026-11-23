// Self-healing helpers for the music player.
//
// Problems these solve:
//  - A "zombie" player (voice never connected, node died, bot kicked / restarted)
//    stays in memory, so new songs are only queued and never played until the
//    user presses "End Session".
//  - Riffy picks the node with the fewest REST calls (not the healthiest one),
//    which on free public Lavalink nodes often means a choppy / overloaded node.

import { logger } from '../../utils/logger.js';

// A player created less than this long ago is still joining the voice channel.
const JOIN_GRACE_MS = 15 * 1000;
// Lavalink sends a playerUpdate every ~5s while a player is alive.
const STALL_MS = 30 * 1000;

// Audio quality watchdog.
const AUDIO_CHECK_INTERVAL_MS = 15 * 1000;
// Node-wide missing frames per minute (50 frames = 1s of audio). 300 = ~6s lost.
const AUDIO_DEFICIT_THRESHOLD = 300;
const AUDIO_BAD_SAMPLES_BEFORE_MOVE = 2;
const AUDIO_MOVE_COOLDOWN_MS = 90 * 1000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The voice channel Discord says the bot is currently in (or null). */
export function getBotVoiceChannelId(client, guildId) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild || !client.user) {
        return null;
    }
    return guild.members.me?.voice?.channelId
        ?? guild.voiceStates.cache.get(client.user.id)?.channelId
        ?? null;
}

/** Ask Discord to disconnect the bot from voice (gateway op 4, channel_id: null). */
export function sendVoiceLeave(client, guildId) {
    try {
        client.riffy?.send({
            op: 4,
            d: { guild_id: guildId, channel_id: null, self_mute: false, self_deaf: false },
        });
    } catch (error) {
        logger.debug(`Could not send voice leave for guild ${guildId}: ${error?.message || error}`);
    }
}

/** Wait until Discord confirms the bot has left voice, so the next join gets fresh credentials. */
export async function waitForBotLeave(client, guildId, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (getBotVoiceChannelId(client, guildId) && Date.now() < deadline) {
        await sleep(100);
    }
    await sleep(250);
}

/** Destroy a player without ever throwing, even if its Lavalink node is dead. */
export function safeDestroyPlayer(client, player) {
    if (!player) {
        return;
    }

    const guildId = player.guildId;
    try {
        player.destroy();
    } catch (error) {
        logger.debug(`Error destroying player for guild ${guildId}: ${error?.message || error}`);
    }

    if (client.riffy?.players?.get(guildId) === player) {
        client.riffy.players.delete(guildId);
    }
    sendVoiceLeave(client, guildId);
}

// Discord requires DAVE (E2EE) voice since March 2026. Lavalink only supports it from
// v4.2.0; on older nodes the track "plays" but no audio ever reaches Discord.
// Unknown versions (info not fetched, NodeLink) are given the benefit of the doubt.
export function supportsDave(node) {
    const info = node?.info;
    if (!info || info.isNodelink) {
        return true;
    }

    const major = Number(info.version?.major ?? String(info.version?.semver ?? '').split('.')[0]);
    const minor = Number(info.version?.minor ?? String(info.version?.semver ?? '').split('.')[1]);
    if (!Number.isFinite(major) || !Number.isFinite(minor)) {
        return true;
    }
    return major > 4 || (major === 4 && minor >= 2);
}

// Nodes whose voice connection failed are skipped for a while, then given another chance.
const BAD_NODE_COOLDOWN_MS = 30 * 60 * 1000;

export function markNodeBad(node, ms = BAD_NODE_COOLDOWN_MS) {
    if (node) {
        node._badUntil = Date.now() + ms;
    }
}

export function isNodeUsable(node) {
    return !(node._badUntil > Date.now()) && supportsDave(node);
}

function connectedNodesByHealth(client) {
    const healthy = [...(client.riffy?.nodeMap?.values() ?? [])]
        .filter((node) => node.connected)
        .sort((a, b) => a.penalties - b.penalties);

    // Prefer nodes that can really deliver audio; fall back to anything connected
    // so music never becomes completely unavailable.
    const usable = healthy.filter(isNodeUsable);
    return usable.length ? usable : healthy;
}

/**
 * Remember why a node's voice connection was closed. Code 4017 means Discord rejected
 * the connection (no DAVE support), so that node is skipped for a while.
 */
export function trackVoiceSocketClose(client) {
    client.riffy.on('socketClosed', (player, payload) => {
        if (!player) {
            return;
        }
        player._lastSocketClose = { code: payload?.code, at: Date.now() };
        logger.warn(`Voice socket closed in guild ${player.guildId} on node "${player.node?.name}": code ${payload?.code} ${payload?.reason || ''}`.trim());

        if (payload?.code === 4017) {
            markNodeBad(player.node);
        }
    });
}

// Close codes that are normal (kicked / Riffy re-joins by itself) and not a node fault.
const BENIGN_CLOSE_CODES = new Set([4014, 4015, 4009]);

/** True when the track is "playing" but the voice connection to Discord is not working. */
export function voiceLooksBroken(player) {
    if (!player || !player.playing || player.paused) {
        return false;
    }

    const closed = player._lastSocketClose;
    const recentFault = Boolean(
        closed
        && Date.now() - closed.at < 20000
        && !BENIGN_CLOSE_CODES.has(closed.code),
    );

    return player.connected !== true || recentFault;
}

/** Riffy migration strategy: best node that is not the current one and can deliver audio. */
export function pickMigrationNode(player, availableNodes) {
    const candidates = availableNodes
        .filter((node) => node.connected && node !== player.node)
        .sort((a, b) => a.penalties - b.penalties);
    return candidates.find(isNodeUsable) || candidates[0];
}

/**
 * Create a player on the healthiest connected node (lowest load / frame deficit),
 * instead of Riffy's default "least REST calls" pick. `avoidNode` is used on retry
 * so we do not land on the node that just failed.
 */
export function createMusicPlayer(client, options, { avoidNode = null } = {}) {
    const riffy = client.riffy;
    const existing = riffy.players.get(options.guildId);
    if (existing) {
        return existing;
    }

    const nodes = connectedNodesByHealth(client);
    const node = nodes.find((candidate) => candidate !== avoidNode) || nodes[0];
    if (!node) {
        throw new Error('No Lavalink nodes are available.');
    }

    const player = riffy.createPlayer(node, options);
    player._createdAt = Date.now();
    player._lastUpdateAt = Date.now();
    player.on('playerUpdate', () => {
        player._lastUpdateAt = Date.now();
    });
    return player;
}

/**
 * True when a stored player can no longer be trusted: its node is gone, the bot is
 * not actually in the voice channel any more, or it claims to be playing but its
 * node has stopped sending updates.
 */
export function isPlayerStale(client, player) {
    if (!player) {
        return false;
    }

    if (!player.connection || !player.voiceChannel) {
        return true;
    }

    if (player.node && player.node.connected === false) {
        return true;
    }

    const age = Date.now() - (player._createdAt ?? 0);

    if (age > JOIN_GRACE_MS && player.connected !== true) {
        const botChannel = getBotVoiceChannelId(client, player.guildId);
        if (botChannel !== player.voiceChannel) {
            return true;
        }
    }

    if (player.playing && !player.paused && player._lastUpdateAt) {
        if (Date.now() - player._lastUpdateAt > STALL_MS) {
            return true;
        }
    }

    return false;
}

/**
 * Resolves true once Riffy reports `trackStart` for the guild, false on timeout.
 * Attach it BEFORE calling player.play() so the event cannot be missed.
 */
export function waitForTrackStart(client, guildId, timeoutMs = 10000) {
    let finish = () => {};

    const promise = new Promise((resolve) => {
        const onStart = (player) => {
            if (player?.guildId === guildId) {
                finish(true);
            }
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        finish = (result) => {
            clearTimeout(timer);
            client.riffy.off('trackStart', onStart);
            resolve(result);
        };
        client.riffy.on('trackStart', onStart);
    });

    return { promise, cancel: () => finish(false) };
}

/**
 * After a restart Discord can still list the bot in a voice channel. Joining again
 * then never yields fresh voice credentials, so playback silently never starts.
 * Clear every leftover voice session once at startup.
 */
export function cleanupStaleVoiceSessions(client) {
    if (!client.riffy) {
        return;
    }

    let cleaned = 0;
    for (const guild of client.guilds.cache.values()) {
        if (client.riffy.players.has(guild.id)) {
            continue;
        }
        if (getBotVoiceChannelId(client, guild.id)) {
            sendVoiceLeave(client, guild.id);
            cleaned += 1;
        }
    }

    if (cleaned) {
        logger.info(`Cleared ${cleaned} leftover voice session(s) from before the restart.`);
    }
}

/**
 * Moves a playing player to a healthier node when its current node keeps dropping
 * audio frames (the cause of choppy / stuttering sound on overloaded public nodes).
 */
export function startAudioQualityWatchdog(client) {
    const badSamples = new Map();
    const lastMove = new Map();

    const timer = setInterval(async () => {
        const riffy = client.riffy;
        if (!riffy) {
            return;
        }

        for (const player of [...riffy.players.values()]) {
            const guildId = player.guildId;

            try {
                if (!player.playing || player.paused || player.migrating || !player.node?.connected) {
                    badSamples.delete(guildId);
                    continue;
                }

                const frames = player.node.stats?.frameStats;
                const missing = Math.max(frames?.deficit || 0, 0) + Math.max(frames?.nulled || 0, 0);

                if (missing < AUDIO_DEFICIT_THRESHOLD) {
                    badSamples.delete(guildId);
                    continue;
                }

                const count = (badSamples.get(guildId) || 0) + 1;
                badSamples.set(guildId, count);
                if (count < AUDIO_BAD_SAMPLES_BEFORE_MOVE) {
                    continue;
                }

                if (Date.now() - (lastMove.get(guildId) || 0) < AUDIO_MOVE_COOLDOWN_MS) {
                    continue;
                }

                const better = connectedNodesByHealth(client)
                    .find((node) => node !== player.node && node.penalties < player.node.penalties);
                if (!better) {
                    continue;
                }

                const from = player.node.name;
                lastMove.set(guildId, Date.now());
                badSamples.delete(guildId);
                await riffy.migrate(player, better);
                logger.info(`Moved player ${guildId} from node "${from}" to "${better.name}" (audio frames were being dropped).`);
            } catch (error) {
                logger.debug(`Audio quality check failed for guild ${guildId}: ${error?.message || error}`);
            }
        }
    }, AUDIO_CHECK_INTERVAL_MS);

    timer.unref?.();
    return timer;
}
