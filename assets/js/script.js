const proxyPortfolio = "DJ30";

// ---------------------------------------------------------------------------
// 30-day sparklines (drawn locally with D3 - no third-party image service)
// ---------------------------------------------------------------------------

function drawSparklines(history, tickers) {
  const container = d3.select("#sparklines");
  container.selectAll("*").remove();

  tickers.forEach(ticker => {
    const rows = (history[ticker] || []).slice(-22); // ~1 month of trading days
    const card = container.append("a")
      .attr("class", "spark-card")
      .attr("href", `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}`)
      .attr("target", "_blank")
      .attr("rel", "noopener")
      .attr("title", ticker);

    const head = card.append("div").attr("class", "spark-head");
    head.append("span").attr("class", "spark-ticker").text(ticker);

    if (rows.length < 2) {
      head.append("span").attr("class", "spark-change muted").text("n/a");
      card.append("div").attr("class", "spark-empty").text("No data");
      return;
    }

    const first = rows[0].close;
    const last = rows[rows.length - 1].close;
    const change = (last - first) / first;
    const up = change >= 0;

    head.append("span")
      .attr("class", "spark-change " + (up ? "up" : "down"))
      .text(`${up ? "+" : ""}${(change * 100).toFixed(1)}%`);
    card.append("div").attr("class", "spark-price").text(last.toFixed(2));

    const w = 120, h = 36;
    const x = d3.scaleLinear().domain([0, rows.length - 1]).range([1, w - 1]);
    const y = d3.scaleLinear().domain(d3.extent(rows, r => r.close)).range([h - 2, 2]);

    const svg = card.append("svg")
      .attr("viewBox", `0 0 ${w} ${h}`)
      .attr("preserveAspectRatio", "none")
      .attr("class", "spark-svg");

    svg.append("path")
      .attr("class", up ? "spark-area up" : "spark-area down")
      .attr("d", d3.area().x((d, i) => x(i)).y0(h).y1(d => y(d.close))(rows));
    svg.append("path")
      .attr("class", up ? "spark-line up" : "spark-line down")
      .attr("d", d3.line().x((d, i) => x(i)).y(d => y(d.close))(rows));
  });
}

// ---------------------------------------------------------------------------
// Equity curve - responsive SVG (scales with its container via viewBox)
// ---------------------------------------------------------------------------

function drawEquityCurve(valuations) {
  d3.select("#viz").selectAll("*").remove();

  const data = Object.entries(valuations || {})
    .map(([date, value]) => ({ date: moment(date, "YYYY-MM-DD").toDate(), equity: value }))
    .sort((a, b) => a.date - b.date);

  if (data.length < 2) {
    d3.select("#viz").append("p").attr("class", "text-muted")
      .text("Not enough price history in the last month to draw an equity curve yet.");
    return;
  }

  const dim = { width: 800, height: 320, top: 16, right: 16, bottom: 32, left: 84 };

  const svg = d3.select("#viz").append("svg")
    .attr("viewBox", `0 0 ${dim.width} ${dim.height}`)
    .attr("class", "equity-svg");

  const x = d3.scaleTime()
    .domain(d3.extent(data, d => d.date))
    .range([dim.left, dim.width - dim.right]);

  const minVal = d3.min(data, d => d.equity);
  const maxVal = d3.max(data, d => d.equity);
  const pad = (maxVal - minVal) * 0.05 || maxVal * 0.01 || 1;
  const y = d3.scaleLinear()
    .domain([minVal - pad, maxVal + pad])
    .range([dim.height - dim.bottom, dim.top]);

  svg.append("g")
    .attr("transform", `translate(0,${dim.height - dim.bottom})`)
    .call(d3.axisBottom(x).ticks(6).tickFormat(d3.timeFormat("%d %b")));

  svg.append("g")
    .attr("transform", `translate(${dim.left},0)`)
    .call(d3.axisLeft(y).ticks(5).tickFormat(d3.format(",.0f")));

  svg.append("path")
    .attr("class", "equity-area")
    .attr("d", d3.area().x(d => x(d.date)).y0(y(minVal - pad)).y1(d => y(d.equity))(data));

  svg.append("path")
    .attr("class", "equity-line")
    .attr("d", d3.line().x(d => x(d.date)).y(d => y(d.equity))(data));
}

// ---------------------------------------------------------------------------
// Valuation
// ---------------------------------------------------------------------------

// Build {ticker: {dateKey: price}} for fast lookups.
function indexPrices(timeSeriesData) {
  const idx = {};
  timeSeriesData.forEach(p => {
    (idx[p.stock] = idx[p.stock] || {})[p.dateKey] = p.price;
  });
  return idx;
}

function getValuation(timeSeriesData, transactions) {
  // Value the portfolio on each trading day of the last month, counting only
  // transactions made on or before that day.
  const portfolio = {};
  if (!transactions || !transactions.length) {
    return portfolio;
  }

  const prices = indexPrices(timeSeriesData);
  const oneMonthAgo = moment().subtract(1, 'months').format('YYYY-MM-DD');

  // Trading days = dates for which we actually have prices
  const tradingDays = [...new Set(timeSeriesData.map(p => p.dateKey))]
    .filter(d => d >= oneMonthAgo)
    .sort();

  tradingDays.forEach(day => {
    let total = 0;
    let priced = false;
    transactions.forEach(t => {
      if (t.date <= day) {
        const price = (prices[t.stock] || {})[day];
        if (price !== undefined) {
          total += t.quantity * price;
          priced = true;
        }
      }
    });
    if (priced) {
      portfolio[day] = total;
    }
  });

  return portfolio;
}

// Positions from a list of transactions, optionally only those on/before a date.
// Buys have a positive quantity, sales a negative one; price is always positive.
// Uses the average-cost method: a buy re-averages the cost, a sale reduces the
// units held but leaves the average cost of the remaining units unchanged.
function computePositions(transactions, upToDate) {
  const positions = {};
  transactions
    .filter(t => !upToDate || t.date <= upToDate)
    .forEach(t => {
      const p = positions[t.stock] ||
        (positions[t.stock] = { name: t.stock, quantity: 0, avgCost: 0, realised: 0, invested: 0 });
      const fees = Number(t.fees) || 0;
      if (t.quantity > 0) {
        // Purchase fees are part of the cost of the shares
        const cost = t.price * t.quantity + fees;
        p.avgCost = (p.avgCost * p.quantity + cost) / (p.quantity + t.quantity);
        p.quantity += t.quantity;
        p.invested += cost;
      } else {
        // Realised gain/loss on a sale = proceeds, less sale fees, less average cost of the shares sold
        p.realised += -t.quantity * (t.price - p.avgCost) - fees;
        p.quantity += t.quantity;
        if (p.quantity <= 1e-9) { p.quantity = 0; p.avgCost = 0; }
      }
    });
  return positions;
}

// Portfolio-level P&L: unrealised (open positions at latest price vs average
// cost), realised (closed out by sales), and total return on money invested.
function portfolioPnL(transactions, holdings) {
  const positions = computePositions(transactions || []);
  let realised = 0, invested = 0;
  Object.values(positions).forEach(p => { realised += p.realised; invested += p.invested; });
  let value = 0, cost = 0, priced = false;
  Object.values(holdings || {}).forEach(h => {
    if (h.price == null) return;
    value += h.price * h.quantity;
    cost += h.avgCost * h.quantity;
    priced = true;
  });
  const unrealised = value - cost;
  const total = unrealised + realised;
  return { value, cost, unrealised, realised, total, invested, priced,
           totalPct: invested ? (total / invested) * 100 : 0 };
}

function getHoldings(transactions, timeSeriesData) {
  // Units held, average cost and latest close for each stock still held
  if (!transactions || !transactions.length) {
    return {};
  }

  const stocks = computePositions(transactions);
  for (const symbol in stocks) {
    if (stocks[symbol].quantity === 0) delete stocks[symbol]; // fully sold
  }

  // Latest available close (works on weekends and holidays too)
  const latest = {};
  timeSeriesData.forEach(p => {
    if (!latest[p.stock] || p.dateKey > latest[p.stock].dateKey) {
      latest[p.stock] = p;
    }
  });

  for (const symbol in stocks) {
    stocks[symbol].price = latest[symbol] ? latest[symbol].price : null;
  }

  return stocks;
}

function createHoldingsTable(holdings, positions) {
  // Open positions (largest first), then fully sold positions with their realised P&L
  const fmt = n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const units = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });
  const cls = n => (n < 0 ? 'negative' : '');
  const dash = '<span class="text-muted">&ndash;</span>';
  positions = positions || {};

  const open = Object.values(holdings).map(h => {
    const value = h.price == null ? null : h.price * h.quantity;
    const cost = h.avgCost * h.quantity;
    return { ...h, value, cost,
             unrealised: value == null ? null : value - cost,
             realised: (positions[h.name] || {}).realised || 0 };
  }).sort((a, b) => (b.value || 0) - (a.value || 0));
  const closed = Object.values(positions)
    .filter(p => p.quantity === 0 && !holdings[p.name])
    .sort((a, b) => a.name.localeCompare(b.name));

  const totalValue = open.reduce((t, h) => t + (h.value || 0), 0);
  const totalCost = open.reduce((t, h) => t + (h.value == null ? 0 : h.cost), 0);
  const totalUnreal = totalValue - totalCost;
  const totalReal = Object.values(positions).reduce((t, p) => t + p.realised, 0);

  const rows = open.map(h => `<tr>
      <td class="ticker">${h.name}</td>
      <td class="text-right">${units(h.quantity)}</td>
      <td class="text-right">${h.price == null ? 'n/a' : fmt(h.price)}</td>
      <td class="text-right">${h.value == null ? 'n/a' : fmt(h.value)}</td>
      <td class="text-right">${h.value == null || !totalValue ? dash : (h.value / totalValue * 100).toFixed(1) + '%'}</td>
      <td class="text-right">${fmt(h.cost)}</td>
      <td class="text-right ${cls(h.unrealised)}">${h.unrealised == null ? dash : fmt(h.unrealised)}</td>
      <td class="text-right ${cls(h.unrealised)}">${h.unrealised == null || !h.cost ? dash : (h.unrealised / h.cost * 100).toFixed(2)}</td>
      <td class="text-right ${cls(h.realised)}">${h.realised ? fmt(h.realised) : dash}</td>
    </tr>`).concat(closed.map(p => `<tr class="closed">
      <td class="ticker">${p.name} <span class="badge badge-light">Sold</span></td>
      <td class="text-right">0</td>
      <td class="text-right">${dash}</td><td class="text-right">${dash}</td><td class="text-right">${dash}</td>
      <td class="text-right">${dash}</td><td class="text-right">${dash}</td><td class="text-right">${dash}</td>
      <td class="text-right ${cls(p.realised)}">${fmt(p.realised)}</td>
    </tr>`));

  $('#stocks-table').html(rows.join('') ||
    '<tr><td colspan="9" class="text-muted">No holdings yet.</td></tr>');
  $('#holdings-total').html(open.length || closed.length ? `<tr>
      <td class="ticker">Total</td><td></td><td></td>
      <td class="text-right">${fmt(totalValue)}</td>
      <td class="text-right">${totalValue ? '100%' : ''}</td>
      <td class="text-right">${fmt(totalCost)}</td>
      <td class="text-right ${cls(totalUnreal)}">${fmt(totalUnreal)}</td>
      <td class="text-right ${cls(totalUnreal)}">${totalCost ? (totalUnreal / totalCost * 100).toFixed(2) : ''}</td>
      <td class="text-right ${cls(totalReal)}">${totalReal ? fmt(totalReal) : '<span class="text-muted">&ndash;</span>'}</td>
    </tr>` : '');
}

function clearHoldings() {
  $('#stocks-table, #holdings-total').empty();
}

