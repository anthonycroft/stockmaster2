// Market movers panel: your holdings' moves today (when a portfolio is
// selected), then the Dow 30's breadth and biggest gains and falls. Uses the
// same delayed quotes as the ticker tape.

const MOVERS_COUNT = 5;

// "today" if the latest trade was today in New York, otherwise name the session
function sessionLabel(times) {
  const valid = (times || []).filter(Boolean);
  if (!valid.length) return { today: true, text: '' };
  const last = new Date(Math.max(...valid) * 1000);
  const ny = d => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (ny(last) === ny(new Date())) return { today: true, text: '' };
  return { today: false,
           text: last.toLocaleDateString('en-GB', { timeZone: 'America/New_York', weekday: 'short', day: 'numeric', month: 'short' }) };
}
const moversState = { holdings: null, token: 0 };

function moverRow(symbol, q, extra) {
  const pct = q.change_pct;
  const dir = pct >= 0 ? 'up' : 'down';
  const sign = pct >= 0 ? '+' : '−';
  return `<a class="mv-row" href="https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}" target="_blank" rel="noopener">
    <span class="mv-sym">${esc(symbol)}</span>
    <span class="mv-price">${extra || money(q.price)}</span>
    <span class="mv-chg ${dir}">${sign}${Math.abs(pct).toFixed(2)}%</span>
  </a>`;
}

function holdingsSection(holdings, quotes) {
  let dayChange = 0, value = 0;
  const rows = [];
  Object.values(holdings).forEach(h => {
    const q = quotes[h.name];
    if (!q || q.change == null || q.change_pct == null) return;
    const move = q.change * h.quantity;
    dayChange += move;
    value += q.price * h.quantity;
    rows.push({ symbol: h.name, q, move });
  });
  if (!rows.length) return '';
  rows.sort((a, b) => b.q.change_pct - a.q.change_pct);

  const session = sessionLabel(rows.map(r => r.q.time));
  const title = session.today ? 'Your holdings today' : `Your holdings, last session (${session.text})`;
  const base = value - dayChange;
  const pct = base ? (dayChange / base) * 100 : 0;
  const dir = dayChange >= 0 ? 'up' : 'down';
  const sign = dayChange >= 0 ? '+' : '−';
  return `<section class="mv-section">
    <h5 class="mv-title">${esc(title)}</h5>
    <p class="mv-total ${dir}">${sign}$${money(Math.abs(dayChange))} <span>(${sign}${Math.abs(pct).toFixed(2)}%)</span></p>
    ${rows.map(r => moverRow(r.symbol, r.q,
      `${r.move >= 0 ? '+' : '−'}$${money(Math.abs(r.move))}`)).join('')}
  </section>`;
}

function dowSection(quotes) {
  const moves = DJ30
    .filter(s => quotes[s] && quotes[s].change_pct != null)
    .map(s => ({ symbol: s, q: quotes[s] }));
  if (!moves.length) return '<p class="text-muted small">Market data is unavailable right now.</p>';

  const up = moves.filter(m => m.q.change_pct > 0).length;
  const down = moves.filter(m => m.q.change_pct < 0).length;
  const flat = moves.length - up - down;
  const sorted = [...moves].sort((a, b) => b.q.change_pct - a.q.change_pct);
  const gains = sorted.slice(0, MOVERS_COUNT).filter(m => m.q.change_pct > 0);
  const falls = sorted.slice(-MOVERS_COUNT).reverse().filter(m => m.q.change_pct < 0);

  const times = moves.map(m => m.q.time).filter(Boolean);
  const asOf = times.length
    ? new Date(Math.max(...times) * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
    : '';

  const session = sessionLabel(times);
  const dowTitle = session.today ? 'Dow 30 today' : `Dow 30, last session (${session.text})`;
  return `<section class="mv-section">
    <h5 class="mv-title">${esc(dowTitle)}</h5>
    <div class="mv-breadth" title="${up} up, ${down} down${flat ? ', ' + flat + ' unchanged' : ''}">
      <div class="mv-bar">
        <span class="up" style="width:${(up / moves.length) * 100}%"></span>
        <span class="down" style="width:${(down / moves.length) * 100}%"></span>
      </div>
      <p class="mv-breadth-text"><span class="up">${up} up</span>, <span class="down">${down} down</span>${flat ? `, ${flat} unchanged` : ''}</p>
    </div>
    ${gains.length ? `<h6 class="mv-sub">Biggest gains</h6>${gains.map(m => moverRow(m.symbol, m.q)).join('')}` : ''}
    ${falls.length ? `<h6 class="mv-sub">Biggest falls</h6>${falls.map(m => moverRow(m.symbol, m.q)).join('')}` : ''}
    <p class="mv-note">Prices delayed about 15 minutes${asOf ? ', last trade ' + esc(asOf) : ''}.</p>
  </section>`;
}

async function refreshMovers() {
  const token = ++moversState.token;
  const holdings = moversState.holdings;
  const panel = document.getElementById('movers');
  if (!panel) return;
  try {
    const [dow, own] = await Promise.all([
      getQuotes(DJ30),
      holdings ? getQuotes(Object.keys(holdings)) : Promise.resolve({}),
    ]);
    if (token !== moversState.token) return;
    panel.innerHTML = (holdings ? holdingsSection(holdings, own) : '') + dowSection(dow);
  } catch (err) {
    if (token !== moversState.token) return;
    console.warn('Market movers unavailable', err);
    panel.innerHTML = '<p class="text-muted small">Market data is unavailable right now. It will retry in a few minutes.</p>';
  }
}

// Called by app.js when the view changes; holdings = {TICKER: {name, quantity, ...}} or null
function setMoversHoldings(holdings) {
  moversState.holdings = holdings && Object.keys(holdings).length ? holdings : null;
  refreshMovers();
}
