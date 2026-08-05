'use strict';

const { google } = require('googleapis');
const config = require('../config');

const HEADERS = [
  'Timestamp',
  'Name',
  'Phone',
  'Email',
  'Service Needed',
  'Lead Score',
  'Tier',
  'Urgency',
  'Est Job Value',
  'Call Made',
  'Owner Alerted',
  'Key Signals',
  'Follow Up Note',
  'Problem Description',
  'Inspection Booked',
  'Call Transcript',
];

let sheetsClient = null;

/**
 * A PEM key pasted into a .env file arrives with literal backslash-n instead of
 * real newlines, which makes the JWT signer throw. Restore them. Safe to run on
 * a key that already has real newlines.
 */
function normalizePrivateKey(key) {
  return String(key || '').replace(/\\n/g, '\n');
}

function getSheets() {
  if (!sheetsClient) {
    const auth = new google.auth.JWT({
      email: config.googleSheets.clientEmail,
      key: normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheetsClient = google.sheets({ version: 'v4', auth: auth });
  }
  return sheetsClient;
}

/** Row number out of a range like "Leads!A7:O7". */
function rowNumberFrom(rowRange) {
  const match = /![A-Z]+(\d+)/.exec(String(rowRange || ''));
  return match ? match[1] : null;
}

/** Write a single cell in an already-appended row. */
async function updateCell(rowRange, column, value) {
  if (!isConfigured() || !rowRange) {
    return { success: false, error: 'No row to update' };
  }
  const rowNumber = rowNumberFrom(rowRange);
  if (!rowNumber) {
    return { success: false, error: 'Unrecognized row range: ' + rowRange };
  }

  try {
    await getSheets().spreadsheets.values.update({
      spreadsheetId: config.googleSheets.spreadsheetId,
      range: config.googleSheets.sheetName + '!' + column + rowNumber,
      valueInputOption: 'RAW',
      requestBody: { values: [[value]] },
    });
    return { success: true };
  } catch (err) {
    console.error('[googleSheets] cell update failed (' + column + rowNumber + '):', err.message);
    return { success: false, error: err.message };
  }
}

function isConfigured() {
  return Boolean(
    config.googleSheets.spreadsheetId &&
    config.googleSheets.clientEmail &&
    config.googleSheets.privateKey
  );
}

async function ensureHeaderRow() {
  const sheets = getSheets();
  const range = config.googleSheets.sheetName + '!A1:P1';
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.googleSheets.spreadsheetId,
    range: range,
  });

  const existing = (res.data.values && res.data.values[0]) || [];
  // Also upgrades a sheet that was created before a column was added.
  if (existing.length < HEADERS.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.googleSheets.spreadsheetId,
      range: range,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    });
  }
}

/**
 * Append one lead row (15 columns). Best effort — logging must never break the
 * webhook or the live call.
 * @returns {Promise<{success:boolean, rowRange?:string, error?:string}>}
 */
async function logLead(entry) {
  if (!isConfigured()) {
    console.warn('[googleSheets] not configured, skipping log');
    return { success: false, error: 'Google Sheets not configured' };
  }

  const row = [
    entry.timestamp || new Date().toISOString(),
    entry.name || '',
    entry.phone || '',
    entry.email || '',
    entry.serviceNeeded || '',
    entry.score == null ? '' : entry.score,
    entry.tier || '',
    entry.urgency || '',
    entry.estJobValue == null ? '' : entry.estJobValue,
    entry.callMade ? 'Yes' : 'No',
    entry.ownerAlerted ? 'Yes' : 'No',
    entry.keySignals || '',
    entry.followUpNote || '',
    entry.problem || '',
    entry.inspectionBooked ? 'Yes' : 'No',
    entry.transcript || '',
  ];

  try {
    await ensureHeaderRow();
    const res = await getSheets().spreadsheets.values.append({
      spreadsheetId: config.googleSheets.spreadsheetId,
      range: config.googleSheets.sheetName + '!A:P',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });

    const rowRange = res.data.updates && res.data.updates.updatedRange;
    console.log('[googleSheets] logged lead at', rowRange);
    return { success: true, rowRange: rowRange };
  } catch (err) {
    console.error('[googleSheets] append failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Flip the "Inspection Booked" cell (column O) once a call books.
 * @param {string} rowRange the range returned by logLead, e.g. "Leads!A7:O7"
 */
async function markInspectionBooked(rowRange, booked) {
  return updateCell(rowRange, 'O', booked ? 'Yes' : 'No');
}

/**
 * Record how a call ended on an existing row by appending to the Follow Up Note
 * (column M) — otherwise "logged but never booked" rows all look identical.
 */
async function appendFollowUpNote(rowRange, note) {
  if (!isConfigured() || !rowRange || !note) {
    return { success: false, error: 'Nothing to append' };
  }
  const rowNumber = rowNumberFrom(rowRange);
  if (!rowNumber) {
    return { success: false, error: 'Unrecognized row range: ' + rowRange };
  }

  try {
    const cell = config.googleSheets.sheetName + '!M' + rowNumber;
    const res = await getSheets().spreadsheets.values.get({
      spreadsheetId: config.googleSheets.spreadsheetId,
      range: cell,
    });
    const existing = (res.data.values && res.data.values[0] && res.data.values[0][0]) || '';
    const merged = existing ? existing + ' | ' + note : note;
    return updateCell(rowRange, 'M', merged);
  } catch (err) {
    console.error('[googleSheets] note append failed:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  logLead: logLead,
  markInspectionBooked: markInspectionBooked,
  appendFollowUpNote: appendFollowUpNote,
  updateCell: updateCell,
  normalizePrivateKey: normalizePrivateKey,
  HEADERS: HEADERS,
};
