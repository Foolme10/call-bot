'use strict';

const express = require('express');
const fs = require('fs');
const db = require('../db');
const { ApiError, asyncHandler } = require('../http');
const { requireAuth } = require('../middleware/auth');
const { audioUpload } = require('../middleware/upload');
const { convertToAsterisk, removeAudio } = require('../services/audioConvert');
const logger = require('../logger');

const router = express.Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await db.query(
      `SELECT id, name, original_filename, format, duration_sec, status, created_at
         FROM audio_files WHERE user_id = :uid ORDER BY created_at DESC`,
      { uid: req.user.id }
    );
    res.json({ audio: rows });
  })
);

// Upload + convert in one request. Field name: "file"; body: "name".
router.post(
  '/',
  audioUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(400, 'No audio file uploaded (field "file")');
    const name = (req.body.name || req.file.originalname).toString().slice(0, 128);
    const tmpPath = req.file.path;

    try {
      const { storedFilename, format, durationSec } = await convertToAsterisk(tmpPath);
      const result = await db.execute(
        `INSERT INTO audio_files
           (user_id, name, original_filename, stored_filename, format, duration_sec, status)
         VALUES (:uid, :name, :orig, :stored, :format, :dur, 'ready')`,
        {
          uid: req.user.id,
          name,
          orig: req.file.originalname,
          stored: storedFilename,
          format,
          dur: durationSec,
        }
      );
      res.status(201).json({
        id: result.insertId,
        name,
        duration_sec: durationSec,
        status: 'ready',
      });
    } catch (err) {
      logger.error('Audio conversion failed:', err.message);
      throw new ApiError(422, `Could not process audio: ${err.message}`);
    } finally {
      fs.promises.unlink(tmpPath).catch(() => {});
    }
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const rows = await db.query(
      'SELECT stored_filename FROM audio_files WHERE id = :id AND user_id = :uid',
      { id: req.params.id, uid: req.user.id }
    );
    if (!rows[0]) throw new ApiError(404, 'Audio not found');
    await db.execute('DELETE FROM audio_files WHERE id = :id AND user_id = :uid', {
      id: req.params.id,
      uid: req.user.id,
    });
    removeAudio(rows[0].stored_filename);
    res.json({ ok: true });
  })
);

module.exports = router;
