'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');

const AUDIO_DIR = path.join(__dirname, '..', 'audio');

function ensureAudioDir() {
  if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
  }
}

/**
 * Render text to an mp3 in src/audio and return the public URL to <Play>.
 * Returns null on any failure or timeout so the caller can fall back to <Say>.
 * @param {string} text
 * @returns {Promise<string|null>}
 */
async function synthesize(text) {
  if (!config.elevenLabs.apiKey || !config.elevenLabs.voiceId) {
    console.warn('[elevenLabs] not configured, falling back to <Say>');
    return null;
  }
  if (!config.serverUrl) {
    console.warn('[elevenLabs] SERVER_URL not set, falling back to <Say>');
    return null;
  }

  // Cache by content hash: the same prompt is spoken on every call.
  const hash = crypto.createHash('sha1')
    .update(config.elevenLabs.voiceId + '|' + text)
    .digest('hex')
    .slice(0, 16);
  const fileName = hash + '.mp3';
  const filePath = path.join(AUDIO_DIR, fileName);
  const publicUrl = config.serverUrl + '/audio/' + fileName;

  try {
    ensureAudioDir();

    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
      return publicUrl;
    }

    const response = await axios.post(
      'https://api.elevenlabs.io/v1/text-to-speech/' + config.elevenLabs.voiceId,
      {
        text: text,
        model_id: config.elevenLabs.modelId,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      },
      {
        headers: {
          'xi-api-key': config.elevenLabs.apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        responseType: 'arraybuffer',
        timeout: config.elevenLabs.timeoutMs,
      }
    );

    const buffer = Buffer.from(response.data);
    if (!buffer.length) {
      throw new Error('Empty audio response');
    }

    // Write to a temp name first so a concurrent request never <Play>s a
    // half-written file.
    const tmpPath = filePath + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, filePath);

    return publicUrl;
  } catch (err) {
    const detail = err.response && err.response.data
      ? Buffer.from(err.response.data).toString('utf8').slice(0, 300)
      : err.message;
    console.error('[elevenLabs] synthesis failed, falling back to <Say>:', detail);
    return null;
  }
}

module.exports = { synthesize: synthesize, AUDIO_DIR: AUDIO_DIR };
