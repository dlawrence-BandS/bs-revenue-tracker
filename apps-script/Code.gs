/**
 * bs-revenue-tracker :: manual entry backend
 *
 * Same pattern as the Web & Marketing Calendar tool: a bound Google Sheet
 * acts as the database, this script is deployed as a Web App, and the
 * dashboard talks to it with plain fetch() calls.
 *
 * Two tabs expected in the bound Spreadsheet:
 *   "BusinessRevenue"  columns: financial_year | week_number | actual | target | updated_at | updated_by
 *   "ChannelCost"      columns: financial_year | week_number | channel_slot | cost | updated_at | updated_by
 *
 * Deploy: Extensions > Apps Script > paste this in > Deploy > New deployment
 *   > type "Web app" > Execute as "Me" > Who has access "Anyone within
 *   Barker & Stonehouse" (or "Anyone" if the dashboard needs to work for
 *   external logins too - your call). Copy the /exec URL into config.js.
 */

const REVENUE_SHEET = 'BusinessRevenue';
const COST_SHEET = 'ChannelCost';

function doGet(e) {
  const action = (e.parameter.action || 'all');
  if (action === 'revenue') return respond_(getRevenueRows_());
  if (action === 'cost') return respond_(getCostRows_());
  return respond_({ revenue: getRevenueRows_(), cost: getCostRows_() });
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents);

  if (body.type === 'revenue') {
    upsertRevenue_(body.financial_year, body.week_number, body.actual, body.target, body.updated_by);
    return respond_({ status: 'ok' });
  }
  if (body.type === 'cost') {
    upsertCost_(body.financial_year, body.week_number, body.channel_slot, body.cost, body.updated_by);
    return respond_({ status: 'ok' });
  }
  return respond_({ status: 'error', message: 'Unknown type: ' + body.type });
}

function getRevenueRows_() {
  const sheet = getSheet_(REVENUE_SHEET, ['financial_year', 'week_number', 'actual', 'target', 'updated_at', 'updated_by']);
  const rows = sheet.getDataRange().getValues();
  const header = rows.shift();
  return rows
    .filter(r => r[0] !== '' && r[0] !== null)
    .map(r => ({
      financial_year: r[0],
      week_number: r[1],
      actual: r[2] === '' ? null : r[2],
      target: r[3] === '' ? null : r[3],
      updated_at: r[4],
      updated_by: r[5]
    }));
}

function getCostRows_() {
  const sheet = getSheet_(COST_SHEET, ['financial_year', 'week_number', 'channel_slot', 'cost', 'updated_at', 'updated_by']);
  const rows = sheet.getDataRange().getValues();
  const header = rows.shift();
  return rows
    .filter(r => r[0] !== '' && r[0] !== null)
    .map(r => ({
      financial_year: r[0],
      week_number: r[1],
      channel_slot: r[2],
      cost: r[3] === '' ? null : r[3],
      updated_at: r[4],
      updated_by: r[5]
    }));
}

function upsertRevenue_(fy, week, actual, target, updatedBy) {
  const sheet = getSheet_(REVENUE_SHEET, ['financial_year', 'week_number', 'actual', 'target', 'updated_at', 'updated_by']);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] == fy && data[i][1] == week) {
      if (actual !== undefined && actual !== null) sheet.getRange(i + 1, 3).setValue(actual);
      if (target !== undefined && target !== null) sheet.getRange(i + 1, 4).setValue(target);
      sheet.getRange(i + 1, 5).setValue(new Date());
      sheet.getRange(i + 1, 6).setValue(updatedBy || '');
      return;
    }
  }
  sheet.appendRow([fy, week, actual ?? '', target ?? '', new Date(), updatedBy || '']);
}

function upsertCost_(fy, week, channelSlot, cost, updatedBy) {
  const sheet = getSheet_(COST_SHEET, ['financial_year', 'week_number', 'channel_slot', 'cost', 'updated_at', 'updated_by']);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] == fy && data[i][1] == week && data[i][2] == channelSlot) {
      sheet.getRange(i + 1, 4).setValue(cost);
      sheet.getRange(i + 1, 5).setValue(new Date());
      sheet.getRange(i + 1, 6).setValue(updatedBy || '');
      return;
    }
  }
  sheet.appendRow([fy, week, channelSlot, cost, new Date(), updatedBy || '']);
}

function getSheet_(name, headerRow) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headerRow);
  }
  return sheet;
}

function respond_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
