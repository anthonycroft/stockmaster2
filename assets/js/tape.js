// Ticker tape under the header. Shows key markets, and the stocks you hold
// (first) when a portfolio is selected. Prices come from /api/quotes - delayed,
// refreshed every 5 minutes. Scrolls slowly; pauses on hover; stays still for
// people who prefer reduced motion.

const MARKET_TAPE = [
  ['^GSPC', 'S&P 500'],
  ['^NDX', 'Nasdaq 100'],
  ['^DJI', 'Dow Jones'],
  ['^FTSE', 'FTSE 100'],
  ['^STOXX50E', 'Euro Stoxx 50'],
  ['GBPUSD=X', 'GBP/USD'],
  ['EURUSD=X', 'EUR/USD'],
  ['GC=F', 'Gold'],
  ['CL=F', 'Oil (WTI)'],
  ['BTC-USD', 'Bitcoin'],
];

const TAPE_REFRESH_MS = 5 * 60 * 1000;
const TAPE_SPEED_PX_PER_S = 38;

const tapeState = { holdings: [], timer: null, token: 0, lastQuotes: {} };

function formatTapePrice(symbol, price) {
  let dp = 2;
  if (symbol.endsWith('=X')) dp = 4;
  else if (symbol.endsWith('-USD') && price >= 1000) dp = 0;
  return Number(price).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function tapeItemHtml(symbol, label, q) {
  if (!q) {
    return `<span class="tape-item"><span class="tape-label">${esc(label)}</span><span class="tape-price muted">n/a</span></span>`;
  }
  const pct = q.change_pct;
  const dir = pct == null ? '' : (pct >= 0 ? 'up' : 'down');
  const chg = pct == null ? '' : `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%`;
  const when = q.time ? new Date(q.time * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  return `<span class="tape-item" title="${esc(label)}: ${esc(formatTapePrice(symbol, q.price))}${q.currency ? ' ' + esc(q.currency) : ''}${when ? ', as of ' + esc(when) : ''}">` +
    `<span class="tape-label">${esc(label)}</span>` +
    `<span class="tape-price">${formatTapePrice(symbol, q.price)}</span>` +
    `<span class="tape-chg ${dir}">${chg}</span></span>`;
}

function tapeGroups() {
  const markets = MARKET_TAPE.map(([s, l]) => ({ symbol: s, label: l }));
  if (!tapeState.holdings.length) return [{ items: markets }];
  return [
    { title: 'Holdings', items: tapeState.holdings.map(s => ({ symbol: s, label: s })) },
    { title: 'Markets', items: markets },
  ];
}

async function refreshTape() {
  const token = ++tapeState.token;
  const groups = tapeGroups();
  const symbols = groups.flatMap(g => g.items.map(i => i.symbol));
  let quotes = tapeState.lastQuotes;
  try {
    quotes = Object.assign({}, tapeState.lastQuotes, await getQuotes(symbols));
    tapeState.lastQuotes = quotes;
  } catch (err) {
    console.warn('Tape prices unavailable', err);
    if (!Object.keys(quotes).length) {
      $('#tape-track').html('<span class="tape-item"><span class="tape-label">Market prices are unavailable right now</span></span>');
      return;
    }
  }
  if (token !== tapeState.token) return; // a newer refresh has taken over

  const html = groups.map(g =>
    (g.title ? `<span class="tape-group">${g.title}</span>` : '') +
    g.items.map(i => tapeItemHtml(i.symbol, i.label, quotes[i.symbol])).join('')
  ).join('');
  renderTape(html);
}

function renderTape(html) {
  const tape = document.getElementById('tape');
  const track = document.getElementById('tape-track');
  track.classList.remove('scrolling');
  track.innerHTML = html;

  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const contentWidth = track.scrollWidth;
  if (!reduced && contentWidth > tape.clientWidth) {
    // Duplicate the content so the loop is seamless, then scroll by half
    track.innerHTML = html + '<span class="tape-loop" aria-hidden="true">' + html + '</span>';
    track.style.setProperty('--tape-duration', `${Math.round(contentWidth / TAPE_SPEED_PX_PER_S)}s`);
    track.classList.add('scrolling');
  }
}

// Called by app.js when the view changes
function setTapeHoldings(tickers) {
  const next = [...new Set(tickers || [])].sort();
  if (next.join(',') === tapeState.holdings.join(',') && tapeState.timer) return;
  tapeState.holdings = next;
  refreshTape();
  if (!tapeState.timer) {
    tapeState.timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        refreshTape();
        if (typeof refreshMovers === 'function') refreshMovers();
      }
    }, TAPE_REFRESH_MS);
  }
}

// Re-measure on resize (scrolling may start or stop)
let _tapeResize;
window.addEventListener('resize', () => {
  clearTimeout(_tapeResize);
  _tapeResize = setTimeout(() => {
    const track = document.getElementById('tape-track');
    if (!track) return;
    const loop = track.querySelector('.tape-loop');
    if (loop) loop.remove();
    renderTape(track.innerHTML);
  }, 250);
});
