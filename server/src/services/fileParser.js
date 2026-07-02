'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { parse: parseCsvSync } = require('csv-parse/sync');
const { normalizePhone, isValidPhone } = require('./phone');

// Reads a CSV or XLSX file into { columns, rows } where rows are objects keyed
// by the header names. Blank/duplicate headers are given stable fallback names.
function readTable(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let matrix; // array of arrays, first row = header

  if (ext === '.csv' || ext === '.txt') {
    const text = fs.readFileSync(filePath, 'utf8');
    matrix = parseCsvSync(text, {
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      bom: true,
    });
  } else if (ext === '.xlsx' || ext === '.xls') {
    const wb = XLSX.readFile(filePath, { cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
  } else {
    throw new Error('Unsupported file type. Upload a .csv or .xlsx file.');
  }

  if (!matrix || matrix.length === 0) return { columns: [], rows: [] };

  const headerRow = matrix[0].map((h, i) => {
    const name = String(h ?? '').trim();
    return name || `Column ${i + 1}`;
  });
  // De-duplicate identical headers so mapping stays unambiguous.
  const seen = new Map();
  const columns = headerRow.map((h) => {
    const count = seen.get(h) || 0;
    seen.set(h, count + 1);
    return count === 0 ? h : `${h} (${count + 1})`;
  });

  const rows = matrix.slice(1).map((arr) => {
    const obj = {};
    columns.forEach((col, i) => {
      obj[col] = arr[i] ?? '';
    });
    return obj;
  });

  return { columns, rows };
}

// Step 1: cheap preview for the column-mapping UI.
function preview(filePath, sampleSize = 5) {
  const { columns, rows } = readTable(filePath);
  return { columns, sample: rows.slice(0, sampleSize), totalRows: rows.length };
}

// Step 2: pull just the chosen name + number columns, normalize, drop invalids.
// Returns { contacts: [{name, phone}], total, valid, invalid }.
function extractContacts(filePath, nameColumn, numberColumn) {
  const { columns, rows } = readTable(filePath);
  if (!columns.includes(numberColumn)) {
    throw new Error(`Number column "${numberColumn}" not found in file`);
  }
  const hasName = nameColumn && columns.includes(nameColumn);

  const contacts = [];
  let invalid = 0;
  for (const row of rows) {
    const phone = normalizePhone(row[numberColumn]);
    if (!isValidPhone(phone)) {
      invalid += 1;
      continue;
    }
    const name = hasName ? String(row[nameColumn] ?? '').trim().slice(0, 128) : null;
    contacts.push({ name: name || null, phone });
  }
  return { contacts, total: rows.length, valid: contacts.length, invalid };
}

module.exports = { readTable, preview, extractContacts };
