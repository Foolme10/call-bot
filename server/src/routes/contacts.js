'use strict';

const express = require('express');
const path = require('path');
const { asyncHandler, ApiError } = require('../http');
const { requireAuth } = require('../middleware/auth');
const { dataUpload } = require('../middleware/upload');
const { preview } = require('../services/fileParser');

const router = express.Router();
router.use(requireAuth);

// Step 1 of contact upload: store the file in tmp and return detected columns
// + a small sample so the UI can ask which column is the name and which is the
// number. The returned uploadId is passed to POST /campaigns to ingest.
router.post(
  '/preview',
  dataUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(400, 'No file uploaded (field "file")');
    const result = preview(req.file.path);
    res.json({
      uploadId: path.basename(req.file.path),
      originalName: req.file.originalname,
      columns: result.columns,
      sample: result.sample,
      totalRows: result.totalRows,
    });
  })
);

module.exports = router;
