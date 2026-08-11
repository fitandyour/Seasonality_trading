const ExcelJS = require('exceljs');
const { spreadType } = require('./trades');

// Build a trade-journal workbook: all fills, closed round trips (with P&L),
// and open positions. Pure — the route streams it to the download response.
async function buildTradesWorkbook({ fills, openLots, closed, status }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Trading Seasonals';
  wb.created = new Date();

  const fillsSheet = wb.addWorksheet('All fills');
  fillsSheet.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Side', key: 'side', width: 6 },
    { header: 'Qty', key: 'qty', width: 6 },
    { header: 'Symbol', key: 'symbol', width: 8 },
    { header: 'Contract', key: 'contract', width: 28 },
    { header: 'Level', key: 'price', width: 10 },
    { header: 'Type', key: 'type', width: 12 },
    { header: 'Status', key: 'status', width: 10 },
    { header: 'Account', key: 'account', width: 12 },
    { header: 'Source', key: 'source', width: 10 },
  ];
  for (const f of fills) {
    fillsSheet.addRow({
      date: f.trade_date, side: f.side, qty: f.qty, symbol: f.symbol,
      contract: f.contract, price: f.price, type: spreadType(f.contract),
      status: status[f.id] || 'open', account: f.account || '', source: f.source || '',
    });
  }

  const closedSheet = wb.addWorksheet('Closed trades');
  closedSheet.columns = [
    { header: 'Entry date', key: 'entryDate', width: 12 },
    { header: 'Exit date', key: 'exitDate', width: 12 },
    { header: 'Symbol', key: 'symbol', width: 8 },
    { header: 'Contract', key: 'contract', width: 28 },
    { header: 'Type', key: 'type', width: 12 },
    { header: 'Side', key: 'side', width: 8 },
    { header: 'Qty', key: 'qty', width: 6 },
    { header: 'Entry level', key: 'entryPrice', width: 11 },
    { header: 'Exit level', key: 'exitPrice', width: 11 },
    { header: 'Points', key: 'points', width: 10 },
    { header: 'P&L ($)', key: 'pnl', width: 12 },
    { header: 'Hold days', key: 'holdDays', width: 10 },
  ];
  for (const t of closed) closedSheet.addRow(t);
  closedSheet.getColumn('pnl').numFmt = '#,##0.00;[Red]-#,##0.00';

  const openSheet = wb.addWorksheet('Open positions');
  openSheet.columns = [
    { header: 'Since', key: 'since', width: 12 },
    { header: 'Symbol', key: 'symbol', width: 8 },
    { header: 'Contract', key: 'contract', width: 28 },
    { header: 'Type', key: 'type', width: 12 },
    { header: 'Side', key: 'side', width: 8 },
    { header: 'Qty', key: 'qty', width: 6 },
    { header: 'Entry level', key: 'price', width: 11 },
  ];
  for (const l of openLots) openSheet.addRow(l);

  for (const ws of [fillsSheet, closedSheet, openSheet]) {
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  return wb;
}

module.exports = { buildTradesWorkbook };
