// Page controller: portfolio picker, transaction form and list, and wiring
// everything to the API. Charts and calculations live in script.js.

const LAST_PORTFOLIO_STORE = 'stockmaster.lastPortfolio';
const MARKET_LABEL = 'Dow 30';
const SAMPLE_NAME = 'Sample';

const state = {
  portfolios: [],
  current: null,        // {id, name, ...} or null for the market view
  transactions: [],     // current portfolio, in the client shape used by script.js
  editingId: null,      // transaction being edited, if any
  renderToken: 0,       // guards against out-of-order renders when switching quickly
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function esc(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

const money = n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shares = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });

function storeGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function storeSet(key, value) { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch (e) { /* ignore */ } }

const showAlert = async (title, msg, iconType, showCancelButton, confirmButtonText = 'OK') => {
  const result = await Swal.fire({
    title: title, text: msg, icon: iconType,
    showCancelButton: showCancelButton, confirmButtonText: confirmButtonText,
  });
  return result.isConfirmed;
};

function toast(message) {
  Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: message,
              showConfirmButton: false, timer: 2200, timerProgressBar: true });
}

async function handleError(err) {
  console.error(err);
  if (err instanceof AuthError) {
    setAccessKey('');
    showLocked();
    await showAlert('Locked', 'Your access key was not accepted. Unlock again to continue.', 'warning', false);
  } else {
    await showAlert('Something went wrong', err.message, 'error', false);
  }
}

// API rows -> the shape the valuation code uses
function toClientTx(row) {
  return { id: row.id, stock: row.ticker, date: row.trade_date,
           quantity: row.quantity, price: row.price, notes: row.notes };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function hideElements() {
  document.querySelectorAll('.portfolio').forEach(el => { el.style.display = 'none'; });
}

function showElements() {
  document.querySelectorAll('.portfolio').forEach(el => { el.style.display = 'block'; });
}

function setStatus(message) {
  const el = document.getElementById('data-status');
  el.textContent = message || '';
  el.style.display = message ? 'block' : 'none';
}

function addTitle(label) {
  $('span.portfolio_header').text(label);
}

// Header summary: what's being viewed, and for a portfolio its value and gain against cost
function updateSummary(name, holdings) {
  $('#vs-name').text(name);
  const detail = $('#vs-detail').empty();
  if (!holdings) {
    detail.text('Market view');
    return;
  }
  let value = 0, cost = 0, priced = 0;
  Object.values(holdings).forEach(h => {
    if (h.price == null) return;
    value += h.price * h.quantity;
    cost += h.avgCost * h.quantity;
    priced++;
  });
  if (!priced) {
    detail.text(Object.keys(holdings).length ? 'Prices unavailable' : 'No holdings yet');
    return;
  }
  const gain = value - cost;
  const pct = cost ? (gain / cost) * 100 : 0;
  const sign = gain >= 0 ? '+' : '\u2212';
  detail.append($('<span class="vs-value">').text('$' + money(value)));
  detail.append(document.createTextNode('  '));
  detail.append($('<span>').addClass(gain >= 0 ? 'gain' : 'loss')
    .text(`${sign}$${money(Math.abs(gain))} (${sign}${Math.abs(pct).toFixed(2)}%)`));
  detail.append(document.createTextNode(' against cost'));
}

// Weight of each held stock in the portfolio's current value
function holdingWeights(holdings) {
  const values = {};
  let total = 0;
  Object.values(holdings).forEach(h => {
    if (h.price == null) return;
    values[h.name] = h.price * h.quantity;
    total += values[h.name];
  });
  const weights = {};
  Object.keys(values).forEach(t => { weights[t] = total ? values[t] / total : 0; });
  return weights;
}

async function displayData(stocks, label, transactions) {
  const token = ++state.renderToken;
  addTitle(label);

  if (!stocks.length) {
    d3.select('#sparklines').selectAll('*').remove();
    setStatus('No transactions yet. Add one using the form.');
    if (transactions) {
      drawEquityCurve({});
      createHoldingsTable({});
      renderTransactions([]);
      drawHeatmap([], { title: `${label} Heatmap` });
      updateSummary(label, {});
      setTapeHoldings([]);
      setMoversHoldings(null);
    }
    return;
  }

  setStatus('Loading prices…');
  let history;
  try {
    history = await getHistory(stocks);
  } catch (err) {
    if (token !== state.renderToken) return;
    console.error(err);
    setStatus('Could not load prices right now (' + err.message + '). Try again in a minute.');
    if (transactions) {
      renderTransactions(transactions);
      updateSummary(label, getHoldings(transactions, []));
    }
    return;
  }
  if (token !== state.renderToken) return; // a newer selection has taken over

  const missing = stocks.filter(s => !history[s]);
  setStatus(missing.length ? 'No price data for: ' + missing.join(', ') : '');
  drawSparklines(history, stocks);

  if (transactions) {
    const timeSeriesData = toTimeSeries(history);
    const holdings = getHoldings(transactions, timeSeriesData);
    drawEquityCurve(getValuation(timeSeriesData, transactions));
    createHoldingsTable(holdings);
    renderTransactions(transactions);
    drawHeatmap(Object.keys(holdings), {
      title: `${label} Heatmap`,
      note: 'Price change over roughly the last month for the stocks you hold, largest positions first.',
      weights: holdingWeights(holdings),
    });
    updateSummary(label, holdings);
    setTapeHoldings(Object.keys(holdings));
    setMoversHoldings(holdings);
  }
}

function renderTransactions(transactions) {
  const rows = [...transactions].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  if (!rows.length) {
    $('#tx-rows').html('<tr><td colspan="8" class="text-muted">No transactions yet.</td></tr>');
    return;
  }
  $('#tx-rows').html(rows.map(t => {
    const sell = t.quantity < 0;
    return `<tr data-id="${t.id}">
      <td class="text-nowrap">${esc(moment(t.date).format('DD MMM YYYY'))}</td>
      <td><span class="badge ${sell ? 'badge-danger' : 'badge-success'}">${sell ? 'Sell' : 'Buy'}</span></td>
      <td class="font-weight-bold">${esc(t.stock)}</td>
      <td class="text-right">${shares(Math.abs(t.quantity))}</td>
      <td class="text-right">${money(t.price)}</td>
      <td class="text-right">${money(Math.abs(t.quantity) * t.price)}</td>
      <td class="tx-notes">${esc(t.notes || '')}</td>
      <td class="text-right text-nowrap">
        <button type="button" class="btn btn-sm btn-link p-1 tx-edit" title="Edit" aria-label="Edit"><i class="fa fa-pencil"></i></button>
        <button type="button" class="btn btn-sm btn-link text-danger p-1 tx-delete" title="Delete" aria-label="Delete"><i class="fa fa-trash"></i></button>
      </td>
    </tr>`;
  }).join(''));
}

function showMarketView() {
  state.current = null;
  state.transactions = [];
  hideElements();
  displayData(DJ30, MARKET_LABEL);
  drawHeatmap(DJ30);
  updateSummary(MARKET_LABEL, null);
  setTapeHoldings([]);
  setMoversHoldings(null);
  updateFormState();
}

// ---------------------------------------------------------------------------
// Locked / unlocked
// ---------------------------------------------------------------------------

function showLocked() {
  $('#locked-panel').show();
  $('#portfolio-panel').hide();
  showMarketView();
}

async function startUnlocked() {
  $('#locked-panel').hide();
  $('#portfolio-panel').show();
  try {
    await refreshPortfolioList();
    const last = Number(storeGet(LAST_PORTFOLIO_STORE));
    if (last && state.portfolios.some(p => p.id === last)) {
      await selectPortfolio(last);
    } else {
      updateFormState();
    }
    offerLegacyImport();
  } catch (err) {
    handleError(err);
  }
}

// ---------------------------------------------------------------------------
// Portfolios
// ---------------------------------------------------------------------------

async function refreshPortfolioList() {
  const data = await Api.listPortfolios();
  state.portfolios = data.portfolios;
  const selected = state.current ? state.current.id : '';
  const options = [`<option value="">${MARKET_LABEL} (market view)</option>`].concat(
    state.portfolios.map(p =>
      `<option value="${p.id}">${esc(p.name)} (${p.transaction_count} trade${p.transaction_count === 1 ? '' : 's'})</option>`));
  $('#portfolio-select').html(options.join('')).val(String(selected));
}

async function selectPortfolio(id) {
  cancelEdit();
  if (!id) {
    storeSet(LAST_PORTFOLIO_STORE, null);
    $('#portfolio-select').val('');
    showMarketView();
    return;
  }
  const data = await Api.listTransactions(id);
  state.current = data.portfolio;
  state.transactions = data.transactions.map(toClientTx);
  storeSet(LAST_PORTFOLIO_STORE, String(id));
  $('#portfolio-select').val(String(id));
  updateFormState();
  showElements();
  const stocks = [...new Set(state.transactions.map(t => t.stock))];
  await displayData(stocks, state.current.name, state.transactions);
}

async function reloadCurrent() {
  const id = state.current && state.current.id;
  await refreshPortfolioList();
  if (id) await selectPortfolio(id);
}

async function askForName(title, value) {
  const result = await Swal.fire({
    title, input: 'text', inputValue: value || '', showCancelButton: true, confirmButtonText: 'Save',
    inputValidator: v => (!v || !v.trim()) ? 'Enter a name' : undefined,
  });
  return result.isConfirmed ? result.value.trim() : null;
}

async function newPortfolio() {
  const name = await askForName('New portfolio');
  if (!name) return;
  try {
    const data = await Api.createPortfolio(name);
    await refreshPortfolioList();
    await selectPortfolio(data.portfolio.id);
    toast(`Created "${data.portfolio.name}"`);
  } catch (err) { handleError(err); }
}

async function renamePortfolio() {
  if (!state.current) return showAlert('No portfolio selected', 'Choose a portfolio to rename.', 'info', false);
  const name = await askForName('Rename portfolio', state.current.name);
  if (!name || name === state.current.name) return;
  try {
    await Api.renamePortfolio(state.current.id, name);
    await reloadCurrent();
    toast('Portfolio renamed');
  } catch (err) { handleError(err); }
}

async function deletePortfolio() {
  if (!state.current) return showAlert('No portfolio selected', 'Choose a portfolio to delete.', 'info', false);
  const n = state.transactions.length;
  const ok = await showAlert('Delete portfolio?',
    `"${state.current.name}" and its ${n} transaction${n === 1 ? '' : 's'} will be permanently deleted.`,
    'warning', true, 'Delete');
  if (!ok) return;
  try {
    await Api.deletePortfolio(state.current.id);
    await selectPortfolio(null);
    await refreshPortfolioList();
    toast('Portfolio deleted');
  } catch (err) { handleError(err); }
}

// ---------------------------------------------------------------------------
// Transaction form (add and edit)
// ---------------------------------------------------------------------------

function updateFormState() {
  const has = !!state.current;
  $('#tx-form').prop('disabled', !has);
  $('#rename-portfolio, #delete-portfolio').prop('disabled', !has);
  if (!has) {
    $('#tx-form-title').text('Select or create a portfolio to add transactions');
  } else if (state.editingId) {
    $('#tx-form-title').text('Edit transaction');
  } else {
    $('#tx-form-title').text(`Add a transaction to "${state.current.name}"`);
  }
}

function setSide(side) {
  $(`input[name='side'][value='${side}']`).prop('checked', true).trigger('change');
}

function clearForm() {
  $('#stock, #stock-amount, #price, #datepicker, #notes').val('');
  setSide('buy');
}

function startEdit(id) {
  const t = state.transactions.find(x => x.id === id);
  if (!t) return;
  state.editingId = id;
  setSide(t.quantity < 0 ? 'sell' : 'buy');
  $('#stock').val(t.stock);
  $('#stock-amount').val(Math.abs(t.quantity));
  $('#price').val(t.price);
  $('#datepicker').datepicker('setDate', moment(t.date).toDate());
  $('#notes').val(t.notes || '');
  $('#submit-transaction').text('Save changes');
  $('#cancel-edit').show();
  updateFormState();
  document.getElementById('tx-form-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEdit() {
  if (state.editingId == null) return;
  state.editingId = null;
  clearForm();
  $('#submit-transaction').text('Add transaction');
  $('#cancel-edit').hide();
  updateFormState();
}

async function submitTransaction() {
  if (!state.current) return;
  const ticker = $.trim($('#stock').val()).toUpperCase();
  const amount = parseFloat($('#stock-amount').val());
  const price = parseFloat($('#price').val());
  const side = $("input[name='side']:checked").val();
  const date = $('#datepicker').datepicker('getDate');

  let problem = null;
  if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) problem = 'Enter a valid ticker, e.g. AAPL.';
  else if (!(amount > 0)) problem = 'Enter the number of shares as a positive number.';
  else if (!(price > 0)) problem = 'Enter the price per share as a positive number.';
  else if (!date) problem = 'Choose the date of the trade.';
  if (problem) return showAlert('Check the transaction', problem, 'warning', false);

  const tx = {
    ticker,
    trade_date: moment(date).format('YYYY-MM-DD'),
    quantity: side === 'sell' ? -amount : amount,
    price,
    notes: $.trim($('#notes').val()),
  };

  const btn = $('#submit-transaction').prop('disabled', true);
  try {
    if (state.editingId) {
      await Api.updateTransaction(state.editingId, tx);
      cancelEdit();
      toast('Transaction updated');
    } else {
      await Api.addTransaction(state.current.id, tx);
      clearForm();
      toast(`${side === 'sell' ? 'Sale' : 'Purchase'} of ${amount} ${ticker} added`);
    }
    await reloadCurrent();
  } catch (err) {
    // Server-side checks (e.g. selling more than you held) come back as messages
    if (err instanceof AuthError) handleError(err);
    else showAlert("Couldn't save", err.message, 'warning', false);
  } finally {
    btn.prop('disabled', false);
  }
}

async function deleteTransaction(id) {
  const t = state.transactions.find(x => x.id === id);
  if (!t) return;
  const ok = await showAlert('Delete transaction?',
    `${t.quantity < 0 ? 'Sale' : 'Purchase'} of ${shares(Math.abs(t.quantity))} ${t.stock} on ${t.date}`,
    'warning', true, 'Delete');
  if (!ok) return;
  try {
    await Api.deleteTransaction(id);
    if (state.editingId === id) cancelEdit();
    await reloadCurrent();
    toast('Transaction deleted');
  } catch (err) {
    if (err instanceof AuthError) handleError(err);
    else showAlert("Couldn't delete", err.message, 'warning', false);
  }
}

// ---------------------------------------------------------------------------
// Sample portfolio - real closing prices from the last few weeks
// ---------------------------------------------------------------------------

async function loadSamplePortfolio() {
  const plan = [
    // [ticker, shares, trading day index from the start of the window, side]
    ['AAPL', 20, 0, 'buy'],
    ['MSFT', 10, 0, 'buy'],
    ['KO',   60, 0, 'buy'],
    ['NVDA', 30, 2, 'buy'],
    ['JPM',  15, 8, 'buy'],
    ['NVDA', 10, 14, 'sell'],
  ];
  const history = await getHistory([...new Set(plan.map(p => p[0]))]);
  const transactions = [];
  plan.forEach(([ticker, n, dayIdx, side]) => {
    const rows = (history[ticker] || []).slice(-22);
    const row = rows[Math.min(dayIdx, rows.length - 1)];
    if (!row) return;
    transactions.push({ ticker, trade_date: row.date, quantity: side === 'sell' ? -n : n,
                        price: row.close, notes: 'Sample data' });
  });
  if (!transactions.length) throw new Error('No prices available for the sample.');

  await Api.importPortfolios({ [SAMPLE_NAME]: transactions }, true);
  await refreshPortfolioList();
  const sample = state.portfolios.find(p => p.name.toLowerCase() === SAMPLE_NAME.toLowerCase());
  await selectPortfolio(sample.id);
  document.getElementById('30day').scrollIntoView({ behavior: 'smooth' });
}

// ---------------------------------------------------------------------------
// One-off import of portfolios saved in this browser by the old version
// ---------------------------------------------------------------------------

function findLegacyPortfolios() {
  const found = {};
  let keys = [];
  try { keys = Object.keys(localStorage); } catch (e) { return found; }
  keys.forEach(key => {
    if (key.startsWith('stockmaster.') || key === 'sample') return; // ours, or old demo data
    let items;
    try { items = JSON.parse(localStorage.getItem(key)); } catch (e) { return; }
    if (!Array.isArray(items) || !items.length) return;
    const valid = items.every(t => t && typeof t.stock === 'string' && t.date && t.quantity != null && t.price != null);
    if (!valid) return;
    found[key] = items.map(t => {
      // the old form recorded sales as a negative price
      const legacySale = t.price < 0 && t.quantity > 0;
      return { ticker: t.stock, trade_date: t.date,
               quantity: legacySale ? -t.quantity : t.quantity,
               price: Math.abs(t.price) };
    });
  });
  return found;
}

function offerLegacyImport() {
  const legacy = findLegacyPortfolios();
  const names = Object.keys(legacy);
  if (!names.length) { $('#import-local').hide(); return; }
  $('#import-local-text').text(
    `Found ${names.length} portfolio${names.length === 1 ? '' : 's'} saved in this browser by the old version ` +
    `(${names.join(', ')}). Import ${names.length === 1 ? 'it' : 'them'} into your account?`);
  $('#import-local').show();
}

async function importLegacy() {
  const legacy = findLegacyPortfolios();
  try {
    const result = await Api.importPortfolios(legacy, false);
    Object.keys(legacy).forEach(k => {
      if (result.imported.some(p => p.name.toLowerCase() === k.toLowerCase())) storeSet(k, null);
    });
    let msg = `Imported ${result.imported.length} portfolio${result.imported.length === 1 ? '' : 's'}.`;
    if (result.skipped.length) msg += ` Skipped ${result.skipped.join(', ')}: you already have a portfolio with that name.`;
    await refreshPortfolioList();
    offerLegacyImport();
    showAlert('Import complete', msg, 'success', false);
  } catch (err) {
    if (err instanceof AuthError) handleError(err);
    else showAlert("Couldn't import", err.message, 'warning', false);
  }
}

// ---------------------------------------------------------------------------
// Start-up and event wiring
// ---------------------------------------------------------------------------

function wireEvents() {
  $('#datepicker').datepicker({ format: 'yyyy-mm-dd', endDate: new Date(), autoclose: true });

  // Buy/Sell toggle styling (Bootstrap's own JS isn't loaded)
  $("input[name='side']").on('change', function() {
    $("input[name='side']").each(function() { $(this).parent().toggleClass('active', this.checked); });
  });

  $('#unlock').on('click', async () => {
    if (await promptForAccessKey()) startUnlocked();
  });
  $('#lock').on('click', () => {
    setAccessKey('');
    storeSet(LAST_PORTFOLIO_STORE, null);
    showLocked();
  });

  $('#portfolio-select').on('change', function() {
    selectPortfolio(Number(this.value) || null).catch(handleError);
  });
  $('#new-portfolio').on('click', newPortfolio);
  $('#rename-portfolio').on('click', renamePortfolio);
  $('#delete-portfolio').on('click', deletePortfolio);

  $('#load-sample').on('click', async function() {
    const btn = $(this).prop('disabled', true).text('Building sample…');
    try { await loadSamplePortfolio(); toast('Sample portfolio ready'); }
    catch (err) { handleError(err); }
    finally { btn.prop('disabled', false).text('Load sample portfolio'); }
  });

  $('#import-local-btn').on('click', importLegacy);
  $('#submit-transaction').on('click', submitTransaction);
  $('#cancel-edit').on('click', cancelEdit);

  $('#tx-rows').on('click', '.tx-edit', function() {
    startEdit(Number($(this).closest('tr').data('id')));
  });
  $('#tx-rows').on('click', '.tx-delete', function() {
    deleteTransaction(Number($(this).closest('tr').data('id')));
  });
}

function init() {
  wireEvents();
  showMarketView();
  if (getAccessKey()) {
    startUnlocked();
  } else {
    $('#locked-panel').show();
    $('#portfolio-panel').hide();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
