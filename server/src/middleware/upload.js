'use strict';

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');
const { ApiError } = require('../http');

fs.mkdirSync(config.storage.uploadTmpDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.storage.uploadTmpDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

function fileFilter(allowedExts) {
  return (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExts.includes(ext)) cb(null, true);
    else cb(new ApiError(400, `Unsupported file type "${ext}". Allowed: ${allowedExts.join(', ')}`));
  };
}

// Recordings.
const audioUpload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: fileFilter(['.mp3', '.wav', '.m4a', '.ogg', '.aac', '.flac']),
});

// Contact lists.
const dataUpload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: fileFilter(['.csv', '.txt', '.xlsx', '.xls']),
});

// Safely turn a client-supplied uploadId back into a path inside the tmp dir.
function resolveTmpUpload(uploadId) {
  if (!uploadId || typeof uploadId !== 'string') throw new ApiError(400, 'Missing uploadId');
  const base = path.basename(uploadId); // strip any directory component
  const full = path.join(config.storage.uploadTmpDir, base);
  if (!full.startsWith(path.resolve(config.storage.uploadTmpDir))) {
    throw new ApiError(400, 'Invalid uploadId');
  }
  if (!fs.existsSync(full)) throw new ApiError(400, 'Upload not found or expired. Re-upload the file.');
  return full;
}

module.exports = { audioUpload, dataUpload, resolveTmpUpload };
