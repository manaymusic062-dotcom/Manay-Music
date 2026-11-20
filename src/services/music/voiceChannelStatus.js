import { logger } from '../../utils/logger.js';

const MAX_STATUS_LENGTH = 500;

function formatTrackStatus(track) {
    const title = String(track?.info?.title || 'Unknown track').replace(/\s+/g, ' ').trim();
    const artist = String(track?.info?.author || 'Unknown artist').replace(/\s+/g, ' ').trim().toLowerCase();
    return `<a:cd1:1573219932575899738>  **${title}** — ${artist}`.slice(0, MAX_STATUS_LENGTH);
}

export async function setVoiceChannelMusicStatus(client, channelId, track = null) {
    if (!channelId || !client?.rest?.put) {
        return false;
    }

    const status = track ? formatTrackStatus(track) : '';

    try {
        await client.rest.put(`/channels/${channelId}/voice-status`, {
            body: { status },
        });
        return true;
    } catch (error) {
        logger.debug('Could not update voice channel music status. Check the Set Voice Channel Status permission.', {
            channelId,
            error: error.message,
        });
        return false;
    }
}
