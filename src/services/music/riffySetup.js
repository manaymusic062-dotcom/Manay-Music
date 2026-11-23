import { createRequire } from 'module';
import { GatewayDispatchEvents } from 'discord.js';
import { logger } from '../../utils/logger.js';
import lavalinkConfig from '../../config/music/lavalink.js';
import { setupPlayerHandler } from './playerHandler.js';
import {
    cleanupStaleVoiceSessions,
    pickMigrationNode,
    startAudioQualityWatchdog,
    trackVoiceSocketClose,
} from './voiceRecovery.js';

const require = createRequire(import.meta.url);
const { Riffy } = require('riffy');

export function initializeMusic(client) {
    if (!lavalinkConfig.nodes?.length) {
        logger.error('No Lavalink nodes configured. Add lavalink/nodes.json, set LAVALINK_NODES, or set LAVALINK_HOST in your environment.');
        return;
    }

    client.riffy = new Riffy(client, lavalinkConfig.nodes, {
        send: (payload) => {
            const guildId = payload.d?.guild_id;
            if (!guildId) {
                return;
            }

            const guild = client.guilds.cache.get(guildId);
            if (guild?.shard) {
                guild.shard.send(payload);
                return;
            }

            const shardCount = client.ws.shards.size || 1;
            const shardId = Number((BigInt(guildId) >> 22n) % BigInt(shardCount));
            client.ws.shards.get(shardId)?.send(payload);
        },
        defaultSearchPlatform: lavalinkConfig.defaultSearchPlatform,
        restVersion: lavalinkConfig.restVersion,
        bypassChecks: {
            nodeFetchInfo: true,
        },
        // Public Lavalink nodes drop out often. By default Riffy removes a node for good
        // after 3 failed reconnects and leaves its players stuck on the dead node.
        // Keep retrying forever and move players to a healthy node instead.
        reconnectTries: Number.MAX_SAFE_INTEGER,
        reconnectTimeout: 10_000,
        migrateOnDisconnect: true,
        migrateOnFailure: true,
        migrationStrategyFn: pickMigrationNode,
    });

    setupPlayerHandler(client);
    trackVoiceSocketClose(client);

    client.on('raw', (packet) => {
        if (
            ![
                GatewayDispatchEvents.VoiceStateUpdate,
                GatewayDispatchEvents.VoiceServerUpdate,
            ].includes(packet.t)
        ) {
            return;
        }
        // updateVoiceState is async and can reject (e.g. Discord sends a voice server
        // update without an endpoint while it reallocates the voice server).
        Promise.resolve(client.riffy.updateVoiceState(packet)).catch((error) => {
            logger.warn(`Voice update failed for guild ${packet.d?.guild_id}: ${error?.message || error}`);
        });
    });

    client.riffy.on('playerError', (player, error) => {
        logger.error(`Music player error in guild ${player.guildId}:`, error);
    });

    logger.info(`Music initialized with ${lavalinkConfig.nodes.length} Lavalink node(s).`);
}

export function initRiffyAfterReady(client) {
    if (client.riffy && client.user?.id) {
        client.riffy.init(client.user.id);
        logger.info('Riffy voice connection manager initialized.');

        // After a restart Discord may still show the bot in a voice channel; clear it so
        // the next /play gets fresh voice credentials instead of silently not playing.
        cleanupStaleVoiceSessions(client);
        startAudioQualityWatchdog(client);
    }
}
