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

  const dim = { width: 800, height: 320, top: 16, right: 16, bottom: 32, left: 64 };

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

function getValuation(timeSeriesData, portfolioName) {
  // Value the portfolio on each trading day of the last month, counting only
  // transactions made on or before that day.
  const portfolio = {};
  const transactions = getPortfolioTransactions(portfolioName);
  if (!transactions || transactions === 'none') {
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

function getHoldings(portfolioName, timeSeriesData) {
  // Units held, average cost and latest close for each stock in the portfolio
  const stocks = {};
  const transactions = getPortfolioTransactions(portfolioName);
  if (!transactions || transactions === 'none') {
    return stocks;
  }

  transactions.forEach(t => addStock(t.stock, t.price, t.quantity));

  function addStock(symbol, cost, quantity) {
    if (stocks[symbol]) {
      const s = stocks[symbol];
      const newQty = s.quantity + quantity;
      if (newQty !== 0) {
        s.avgCost = ((s.avgCost * s.quantity) + (cost * quantity)) / newQty;
      }
      s.quantity = newQty;
    } else {
      stocks[symbol] = { name: symbol, avgCost: cost, quantity: quantity };
    }
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

function createHoldingsTable (holdings) {
  // Loop over the stocks object and generate HTML code for each row
  const options = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
    
  // accumulate totals as we loop over the transactions
  var formattedValueTotal = 0;
  var formattedAvgCostTotal = 0;
  var formattedGainLossTotal = 0;
  var formattedGainLossPercentOverall = 0;

  clearHoldings();

  $.each(holdings, function (symbol, stock) {

    var formattedValue = (stock.price * stock.quantity)
    formattedValue = formattedValue.toLocaleString('en-US', options);
    formattedValueTotal += (stock.price * stock.quantity);
    
    var formattedAvgCost = stock.avgCost * stock.quantity;
    formattedAvgCost = formattedAvgCost.toLocaleString('en-US', options);
    formattedAvgCostTotal += (stock.avgCost * stock.quantity)

    var gainLossRaw = (stock.price * stock.quantity) -  (stock.avgCost * stock.quantity);
    var formattedGainLoss = gainLossRaw;
    formattedGainLoss = formattedGainLoss.toLocaleString('en-US', options);
    formattedGainLossTotal += ((stock.price * stock.quantity) -  (stock.avgCost * stock.quantity));

    var formattedGainLossPercent = (((stock.price * stock.quantity) - (stock.avgCost * stock.quantity)) / (stock.avgCost * stock.quantity)) * 100
    formattedGainLossPercent = formattedGainLossPercent.toLocaleString('en-US', options);

    // create the HTML elements - rows of the Holdings table
    const html = '<div class="row-stocks">' +
      '<div class="col-stocks ticker">' + stock.name + '</div>' +
      '<div class="col-stocks">' + stock.quantity + '</div>' +
      '<div class="col-stocks">' + (stock.price === null ? 'n/a' : stock.price.toLocaleString('en-US', options)) + '</div>' +
      '<div class="col-stocks">' + formattedValue + '</div>' +   // value
      '<div class="col-stocks">' + formattedAvgCost + '</div>' +
      '<div class="col-stocks gainloss"><span class="' + (gainLossRaw < 0 ? 'negative' : '') + '">' + formattedGainLoss + '</span></div>' +
      '<div class="col-stocks gainlossperc"><span class="' + (gainLossRaw < 0 ? 'negative' : '') + '">' + formattedGainLossPercent + '</span></div>' +
      '</div>';

    // Add the HTML code to the stocks table
    $('#stocks-table').append(html);
  
  });

  // update the table totals
  $('#total-value').text(formattedValueTotal.toLocaleString('en-US', options));
  $('#total-cost').text(formattedAvgCostTotal.toLocaleString('en-US', options));
  $('#total-gain-loss').text(formattedGainLossTotal.toLocaleString('en-US', options));

  formattedGainLossPercentOverall = (formattedGainLossTotal / formattedAvgCostTotal) * 100
  formattedGainLossPercentOverall = formattedGainLossPercentOverall.toLocaleString('en-US', options)
  $('#total-gain-loss-percentage').text(formattedGainLossPercentOverall);

  $('#total-gain-loss, #total-gain-loss-percentage').toggleClass('negative', formattedGainLossTotal < 0);

  function colorNegativesRed() {
    // changes negative values in holdings table to red
  
    // get all the value, gainloss, and gainlossperc cells
    let gainlossCells = document.querySelectorAll('.col-stocks.gainloss span');
    let gainlosspercCells = document.querySelectorAll('.col-stocks.gainlossperc span');
  
    // loop through each gainloss cell and add the .negative class if the value is negative
    gainlossCells.forEach(function(cell) {
      if (cell.textContent < 0) {
        cell.classList.add('negative');
      }
    });
  
    // loop through each gainlossperc cell and add the .negative class if the value is negative
    gainlosspercCells.forEach(function(cell) {
      if (cell.textContent < 0) {
        cell.classList.add('negative');
      }
    });
  }
}

function clearHoldings() {
  // clears the Holdings table before it is rebuilt
  $('#stocks-table').empty();
}

function isWeekend(date) {
  let day = date.getDay();
  return day === 0 || day === 6;
}

function getPortfolioStocks(portfolioName) {
  // returns the stocks owned in a particular portfolio as a unique list

  let uniqueStockList = 'none'

  let portfolio = JSON.parse(localStorage.getItem(portfolioName));

  if (portfolio) {
    // return stocks if the portfolio is not empty
    const stockList = portfolio.map(stock => `${stock.stock}`);
    uniqueStockList = [...new Set(stockList)];
    console.log(uniqueStockList);
  } else {
    // set up the portfolio
    portfolio = [];
    localStorage.setItem(portfolioName, JSON.stringify(portfolio));
  }

  // console.log("Unique Stock list is " + uniqueStockList);

  return uniqueStockList;
}

function getPortfolioTransactions(portfolioName) {
  // returns the transactions (stock purchases/sales) held against a paritcular
  // portfolio name

  let transactions = 'none'

  transactions = JSON.parse(localStorage.getItem(portfolioName));

  return transactions;
}

async function init() {
  // If the investor has not loaded a portfolio yet, show the Dow 30
  hideElements();
  displayData(DJ30, proxyPortfolio);
  drawHeatmap(DJ30);
}

function hideElements() {
  document.querySelectorAll('.portfolio').forEach(el => { el.style.display = 'none'; });
}

function showElements() {
  document.querySelectorAll('.portfolio').forEach(el => { el.style.display = 'block'; });
}

function setStatus(message) {
  const el = document.getElementById('data-status');
  if (!el) return;
  el.textContent = message || '';
  el.style.display = message ? 'block' : 'none';
}

async function displayData(stocks, portfolioName) {
  // Redraws everything that depends on the selected portfolio
  addTitle(portfolioName);
  setStatus('Loading prices…');

  let history;
  try {
    history = await getHistory(stocks);
  } catch (err) {
    console.error(err);
    setStatus('Could not load prices right now (' + err.message + '). Try again in a minute.');
    return;
  }

  const missing = stocks.filter(s => !history[s]);
  setStatus(missing.length ? 'No price data for: ' + missing.join(', ') : '');

  drawSparklines(history, stocks);

  if (portfolioName !== proxyPortfolio) {
    const timeSeriesData = toTimeSeries(history);
    drawEquityCurve(getValuation(timeSeriesData, portfolioName));
    createHoldingsTable(getHoldings(portfolioName, timeSeriesData));
  }
}

function addTitle(portfolioName) {
 // Adds a title to the page representing the currently displayed portfolio

 $("span.portfolio_header").text(portfolioName);

}

$(document).ready(function() {

  $('#datepicker').datepicker({
    format: 'yyyy-mm-dd'
  });

  $("#submit-transaction").click(function() {
    // check that all inputs are complete
    // did user enter portfolio name ?

    let errorsFound = false;

    if ($.trim($("#portfolio").val()) === "") {
      showAlert("Required Input","You must enter a portfolio name!", 'warning', false)
      errorsFound = true;
    } else if ($.trim($("#stock").val()) === "") {
      showAlert("Required Input","You must enter a value in the stock field!", 'warning', false)
      errorsFound = true;
    } else if ($.trim($("#stock-amount").val()) === "" || isNaN($("#stock-amount").val())) {
      showAlert("Required Input","You must enter a value in the stock amount field!", 'warning', false)
      errorsFound = true;
    } else if ($("#price").val() === "" || isNaN($("#price").val())) {
      showAlert("Required Input","You must enter a value in the price field!", 'warning', false)
      errorsFound = true;
    }

    if (errorsFound) {
      return;
    }

    const portfolioName = $.trim($("#portfolio").val()).toLowerCase();
    const stock = $.trim($("#stock").val()).toUpperCase();
    const quantity = Math.ceil(parseFloat($.trim($("#stock-amount").val())));
    const price = parseFloat($("#price").val());
    const roundedPrice = Number(price.toFixed(4));
    const date = $('#datepicker').datepicker('getDate');
    const dateString = moment(date).format('YYYY-MM-DD');

      // If all  checks complete we need to store the data
      // See if portfolio exists in local storage

    // let transactions = JSON.parse($.jStorage.get(portfolioName));
    let transactions = JSON.parse(localStorage.getItem(portfolioName));
    
    if (!transactions) {
      transactions = [];
    }

    // call function to add new transaction to 
    addTransaction(stock, quantity, dateString, roundedPrice)

    clearInputFields();

    showAlert("Transaction added.","This stock transaction has been added to the portfolio: " + portfolioName, 'success', false)

    // refresh the display to update charts / valuation
    const stocks = getPortfolioStocks(portfolioName);
    displayData(stocks, portfolioName);
    showElements();

    function addTransaction(stockName, qty, date, cost) {

      transactions.push({
        stock: stockName,
        quantity: qty,
        date: date,
        price: cost
      });

      localStorage.setItem(portfolioName, JSON.stringify(transactions)); 
    }

    function clearInputFields () {
      // clears the portfolio input fields
      
      // $("#portfolio").val('');   
      $("#stock").val('');
      $("#stock-amount").val('');
      $("#price").val('');
      $("#datepicker").val('');
    }
  })

  $("#submit-portfolio").click(function() {
    // check that all inputs are complete
    // did user enter portfolio name ?

    let errorsFound = false;

    if ($.trim($("#get-portfolio").val()) === "") {
      showAlert("Required Input","You must enter a portfolio name!", 'warning', false)
      errorsFound = true;
    } 

    if (errorsFound) {
      return;
    }

    const portfolioName = $.trim($("#get-portfolio").val()).toLowerCase();
    // If valid portfolio name entered, retrieve it if it exists,
    // else create it

    let stocks = getPortfolioStocks(portfolioName);
    
    if (stocks === 'none') {

      // the portfolio does not exist
      showAlert("No transactions","Portfolio has been set up for you.", 'info', false);

    } else if (stocks.length === 0) {
      // portfolio found but has no stocks in it.
      showAlert("No Transactions","The portfolio was found but there are no transactions to display.", 'info', false)

      } else {
        // we found portfolio name and it has stocks in it
        displayData(stocks, portfolioName);
        showElements();
      }

    // clear the portfolio name field
    $("#get-portfolio").val('');
    
  })
});

const showAlert = async (title, msg, iconType, showCancelButton, confirmButtonText = 'OK') => {
  // Displays alerts to screen

  const result = await Swal.fire({
    title: title,
    text: msg,
    icon: iconType,
    showCancelButton: showCancelButton,
    confirmButtonText: confirmButtonText,
  });
  return result.isConfirmed;
}

// Run once every script on the page (incl. heatmap.js) has loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
