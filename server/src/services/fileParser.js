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

// Cap on how much of each spreadsheet cell we keep as a template variable, and
// how many distinct columns we retain — a guard against a pathological upload
// blowing up the per-recipient JSON.
const FIELD_VALUE_MAX = 256;
const FIELD_KEYS_MAX = 40;

// Step 2: pull the chosen name + number (+ optional amount) columns, normalize,
// drop invalids, AND capture every other column so any header can be used as a
// dynamic {variable} in an SMS. `amountColumn` feeds the legacy {amount} variable
// (ignored for voice). Returns
//   { contacts: [{ name, phone, amount, fields }], total, valid, invalid }
// where `fields` is { header: value } for every column (the phone column aside).
function extractContacts(filePath, nameColumn, numberColumn, amountColumn) {
  const { columns, rows } = readTable(filePath);
  if (!columns.includes(numberColumn)) {
    throw new Error(`Number column "${numberColumn}" not found in file`);
  }
  const hasName = nameColumn && columns.includes(nameColumn);
  const hasAmount = amountColumn && columns.includes(amountColumn);
  // Which columns become template variables: everything except the phone column.
  const fieldColumns = columns.filter((c) => c !== numberColumn).slice(0, FIELD_KEYS_MAX);

  const contacts = [];
  let invalid = 0;
  for (const row of rows) {
    const phone = normalizePhone(row[numberColumn]);
    if (!isValidPhone(phone)) {
      invalid += 1;
      continue;
    }
    const name = hasName ? String(row[nameColumn] ?? '').trim().slice(0, 128) : null;
    const amount = hasAmount ? String(row[amountColumn] ?? '').trim().slice(0, 64) : null;
    const fields = {};
    for (const col of fieldColumns) {
      fields[col] = String(row[col] ?? '').trim().slice(0, FIELD_VALUE_MAX);
    }
    contacts.push({ name: name || null, phone, amount: amount || null, fields });
  }
  return { contacts, total: rows.length, valid: contacts.length, invalid };
}

// Parse a typed/pasted contact list (no file). One entry per line; each line is
// either just a number, or "number, name, amount" (comma/tab/semicolon
// separated) so SMS {name}/{amount} still work from manual input. Normalizes +
// drops invalid numbers. Returns the same shape as extractContacts.
function parseManual(text) {
  const lines = String(text || '').split(/\r?\n/);
  const contacts = [];
  let total = 0;
  let invalid = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue; // ignore blank lines entirely (not counted)
    total += 1;
    const parts = line.split(/[,\t;]/).map((s) => s.trim());
    const phone = normalizePhone(parts[0]);
    if (!isValidPhone(phone)) {
      invalid += 1;
      continue;
    }
    const name = parts[1] ? parts[1].slice(0, 128) : null;
    // Everything after the name is the amount, rejoined so a value that itself
    // contains a comma (e.g. "1,000") isn't truncated.
    const amount = parts.length > 2 ? parts.slice(2).join(',').slice(0, 64) : null;
    // Typed lists only carry name/amount — expose them as fields too so the same
    // dynamic-variable rendering path works for manual entries.
    const fields = {};
    if (name) fields.name = name;
    if (amount) fields.amount = amount;
    contacts.push({ name: name || null, phone, amount: amount || null, fields });
  }
  return { contacts, total, valid: contacts.length, invalid };
}

module.exports = { readTable, preview, extractContacts, parseManual };
