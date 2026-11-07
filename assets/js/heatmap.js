// 30-day performance heatmap. Uses the same cached getHistory() call as the
// sparklines, so it costs no extra API requests. Laid out with CSS grid so it
// reflows from 6 columns on desktop down to 3 on a phone.

function heatColour(change) {
  if (change <= -0.05) return "#e5534b";
  if (change <= -0.01) return "#f4a3a0";
  if (change < 0.01) return "#f2f2f2";
  if (change < 0.05) return "#9fdc9f";
  return "#3fa63f";
}

async function drawHeatmap(tickers) {
  const grid = document.querySelector(".heat-map");
  if (!grid) return;
  grid.innerHTML = "";

  let history;
  try {
    history = await getHistory(tickers);
  } catch (err) {
    console.error(err);
    grid.innerHTML = '<p class="text-muted">Heatmap unavailable - prices could not be loaded.</p>';
    return;
  }

  tickers.forEach(ticker => {
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

    cell.title = `${ticker}: ${label} over ~1 month`;
    cell.innerHTML = `<span class="heat-ticker">${ticker}</span><span class="heat-change">${label}</span>`;
    grid.appendChild(cell);
  });
}
