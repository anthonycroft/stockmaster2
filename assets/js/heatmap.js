// 30-day performance heatmap. Shows the Dow 30 in market view, and the stocks
// currently held when a portfolio is selected (with each one's share of the
// portfolio). Uses the same cached getHistory() call as the sparklines.

let _heatmapToken = 0;

function heatColour(change) {
  if (change <= -0.05) return "#e5534b";
  if (change <= -0.01) return "#f4a3a0";
  if (change < 0.01) return "#F3F5F0";
  if (change < 0.05) return "#9fdc9f";
  return "#3fa63f";
}

// options: { title, note, weights: {TICKER: fraction of portfolio value} }
async function drawHeatmap(tickers, options = {}) {
  const token = ++_heatmapToken;
  const grid = document.querySelector(".heat-map");
  if (!grid) return;

  $("#heatmap-title").text(options.title || "Dow 30 Heatmap");
  $("#heatmap-note").text(options.note || "Price change over roughly the last month. Tap a stock for details.");
  grid.innerHTML = "";

  if (!tickers.length) {
    grid.innerHTML = '<p class="text-muted mb-0">No stocks currently held.</p>';
    return;
  }

  let history;
  try {
    history = await getHistory(tickers);
  } catch (err) {
    if (token !== _heatmapToken) return;
    console.error(err);
    grid.innerHTML = '<p class="text-muted">Heatmap unavailable: prices could not be loaded.</p>';
    return;
  }
  if (token !== _heatmapToken) return; // a newer view has taken over

  const weights = options.weights || null;
  // Largest positions first in a portfolio; Dow 30 stays alphabetical
  const ordered = weights
    ? [...tickers].sort((a, b) => (weights[b] || 0) - (weights[a] || 0))
    : tickers;

  ordered.forEach(ticker => {
    const rows = (history[ticker] || []).slice(-22);
    const cell = document.createElement("a");
    cell.className = "heat-cell";
    cell.href = `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}`;
    cell.target = "_blank";
    cell.rel = "noopener";

    let label = "n/a";
    if (rows.length >= 2) {
      const change = (rows[rows.length - 1].close - rows[0].close) / rows[0].close;
      cell.style.backgroundColor = heatColour(change);
      if (Math.abs(change) >= 0.05) cell.classList.add("strong");
      label = `${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;
    }

    const weight = weights && weights[ticker] != null
      ? `<span class="heat-weight">${(weights[ticker] * 100).toFixed(1)}% of portfolio</span>` : "";
    cell.title = `${ticker}: ${label} over about a month`;
    cell.innerHTML = `<span class="heat-ticker">${ticker}</span><span class="heat-change">${label}</span>${weight}`;
    grid.appendChild(cell);
  });
}
