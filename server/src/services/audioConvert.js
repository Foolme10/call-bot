'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../logger');

// Converts an uploaded recording to the format Asterisk plays most reliably:
// 8 kHz, mono, 16-bit signed PCM WAV. Writes <AUDIO_DIR>/<base>.wav and returns
// the base name (no extension) for use as `sound:callbot/<base>`.

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`${path.basename(cmd)} exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

// Parse "Duration: 00:00:12.34" from ffmpeg stderr.
function parseDuration(stderr) {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!m) return null;
  return Math.round(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
}

async function convertToAsterisk(inputPath) {
  ensureDir(config.storage.audioDir);
  const base = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const outPath = path.join(config.storage.audioDir, `${base}.wav`);

  const stderr = await run(config.storage.ffmpegPath, [
    '-y',
    '-i',
    inputPath,
    '-ar',
    '8000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    outPath,
  ]);

  // Make sure the Asterisk user (different from the app user) can read it.
  try {
    fs.chmodSync(outPath, 0o644);
  } catch (_e) {
    /* best effort */
  }

  logger.info(`Converted audio -> ${outPath}`);
  return { storedFilename: base, format: 'wav', durationSec: parseDuration(stderr) };
}

function removeAudio(storedFilename) {
  if (!storedFilename) return;
  const p = path.join(config.storage.audioDir, `${storedFilename}.wav`);
  fs.promises.unlink(p).catch(() => {});
}

module.exports = { convertToAsterisk, removeAudio };
