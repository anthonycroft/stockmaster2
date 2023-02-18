var apiKey = "7p8pLHEtbHWAcDB5wPeMpcoNiHTQw4Am";
const proxyPortfolio = "DJ30"

// var stocks;

function getURL(ticker) {

  // get stock prices for user's portfolio for the last 30 days for thumbnail image charts
  var dateEnd = moment().subtract(1, 'days').format('YYYY-MM-DD')
  var dateStart = moment(dateEnd).subtract(30, 'days').format('YYYY-MM-DD')

  var queryURL = "https://api.polygon.io/v2/aggs/ticker/" + `${ticker}/range/1/day/${dateStart}/${dateEnd}?apiKey=${apiKey}`;

  return queryURL;
}

async function sendRequest (ticker, timeSeriesData) {
  // Build the query URL for the ajax request to the polygon.io site

  var stockURL = getURL(ticker);

  var response = await fetch(stockURL)
    var data = await response.json()

  const prices = data.results.map(result => ({
    timestamp: result.t,
    closingPrice: result.c
  }));
  
  // add the current stock prices to timeSeriesData 
  // this is in a more convenient format for valuation and other purposes

  data.results.forEach(result => {
    let dataPoint = {
      stock: data.ticker,
      date: new Date(result.t),
      price: result.c
    };
    // console.log("Stock is " + dataPoint.stock + " date is " + dataPoint.date + " and price is " + dataPoint.price)

    timeSeriesData.push(dataPoint);
  });

  const timestamps = prices.map(price => price.timestamp);
  const closingPrices = prices.map(price => price.closingPrice);

  // call function to create the thumbnails
  createImage(timestamps, closingPrices, ticker);

  return timeSeriesData;
}

function createImage(timestamps,closingPrices, ticker) {

  // convert unix style dates to standard display format
  const formattedTimestamps = timestamps.map(timestamp => moment(timestamp).format('DD/MM/YYYY'));

  objJSON = JSON.stringify({
    type:'line',
    data:{
      labels: formattedTimestamps,
      datasets:[
        {
          backgroundColor:'rgba(255,150,150,0.5)',
          borderColor:'rgb(255,150,150)',
          data: closingPrices,
          label:'Dataset',
          fill:'origin'
        }
      ]
    },
    options: {
      indexAxis: 'y',
      scales: {
        x: {
          beginAtZero: false
        }
      }
    }
  });

  // send the API request to image-charts.com for the thumbnail image
  imgURL = "https://image-charts.com/chart.js/2.8.0?bkg=white&c=" + objJSON;

  $("<img>", {
    src: imgURL,
    width: "200",
    height: "100",
    id: "chtThumb_" + ticker,
    class: "image",
    // title: stocks[index]
    title: ticker
 }).appendTo(".thumbnail");

}

function drawEquityCurve (valuations) {
  // draws a D3.js chart representing investor's equity curve

  const data = Object.entries(valuations).map(([date, value]) => {
    return {date: new Date(date), equity: value};
  });

  let dim = {
    "width": 1250,
    "height": 450,
    "margin": 50
  }

  let svg = d3.select('#viz')
    .append('svg')
      .attr("width", dim.width)
      .attr("height", dim.height)
      .attr("margin", dim.margin)

  draw(data);

  function draw(data) {
      
    let scaleX = d3.scaleTime()
    .domain(d3.extent(data, function(d) {
      return d.date;
    }))
    // .nice()
    .range([dim.margin, dim.width-dim.margin]);

    let axisX = d3.axisBottom(scaleX);

    svg.append("g")
      .attr("transform", `translate(0,${dim.height-dim.margin})`)
      .call(axisX);
    
    let minVal = d3.min(data, d => d.equity);

    let scaleY = d3.scaleLinear()
    
    .domain([minVal, d3.max(data, function(d) {
      return d.equity;
    })])
    // .nice()
    .range([dim.height - dim.margin, dim.margin]);

    let axisY = d3.axisLeft(scaleY);

    svg.append("g")
      .attr("transform", `translate(${dim.margin},0)`)
      .call(axisY);

    let area = d3.area()
      .x(d => scaleX(d.date))
      .y0(d => scaleY(minVal))
      .y1(d => scaleY(d.equity));;

    svg.append("path")
    .attr("fill", 'rgba(255,150,150,0.5)')
    .attr("stroke", 'none')
    .attr("stroke-width", '1px')
    .attr("d", area(data));

  }
}

function getValuation(timeSeriesData, portfolioName) {
  // here we want to create a valuation of the portfolio over the last 30 days for each day
  var portfolio = {};

  // issue: for each stock in the portfolio, was it owned at the valuation date ?
  // for this we need to retrieve all the transactions for the particular portfolio
  // and include only those in the valuation that fall on or after the valuation
  // date.

  let transactions = getPortfolioTransactions(portfolioName)

  if (transactions === 'none' ) {
    return 
  }

  // Get the current date and the date 1 month ago
  var now = new Date();
  var oneMonthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());

  // Set the start date to the date 12 months ago
  var startDate = oneMonthAgo;

  // Loop through each day and update the portfolio value
  var yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  while (startDate < yesterday) {

    if (isWeekend(startDate)) { 
      startDate.setDate(startDate.getDate() + 1);
      continue
    }
    
    // Loop through the transactions and update the portfolio value for the current date
    for (var i = 0; i < transactions.length; i++) {
      var transaction = transactions[i];
      var transactionDate = new Date(transaction.date);

      // Only consider transactions that were made on or before the current date
      if (transactionDate <= startDate) {

        // Get the current value of the stock for the transaction date
        var stockValue = getPrice(startDate, transaction.stock);
        // if price is null assume exchange was closed, so dont add a vluation for this date.
        if (stockValue !== null) {
          // Update the portfolio value for the current date
          if (portfolio[startDate.toISOString().substring(0, 10)] === undefined) {
            // Initialize the portfolio value for the current date
            portfolio[startDate.toISOString().substring(0, 10)] = 0;
          }
          portfolio[startDate.toISOString().substring(0, 10)] += transaction.quantity * stockValue;
        }
      }
    }

    // Increment the start date by one day
    startDate.setDate(startDate.getDate() + 1);
  }

  function getPrice(date, ticker) {

    var valuationDate = moment(date).format("YYYY-MM-DD")

    let filteredData = timeSeriesData.filter(dataPoint => {
      return moment(dataPoint.date).format("YYYY-MM-DD") === valuationDate &&
             dataPoint.stock === ticker;
    });

    if (filteredData.length > 0) {
      return filteredData[0].price;
    } else {
      return null;
    }
  }

  // Log the portfolio value for each date
  for (var date in portfolio) {
    console.log(date + ": $" + portfolio[date]);
  }

  return portfolio;
}

function getHoldings(portfolioName, timeSeriesData) {
  // here we want to create a valuation of each stock
  var stocks = {};

  // issue: for each stock in the portfolio, was it owned at the valuation date ?
  // for this we need to retrieve all the transactions for the particular portfolio
  // and include only those in the valuation that fall on or after the valuation
  // date.

  let transactions = getPortfolioTransactions(portfolioName)

  if (transactions === 'none' ) {
    return 
  }

  // Loop through the transactions and update the portfolio value for the current date
  for (var i = 0; i < transactions.length; i++) {
    var transaction = transactions[i];

    var stockName = transaction.stock;

    // User Story: I want to go through my stock transactions and work out the average purchase price 
    // of those stocks, and record that information alongside the ticker, current units held and
    // current price (yesterday's closing price). I want to store all this infcormation in a single
    // object for each ticker for easy retrieval later

    // add the stock quantity bought or sold to running total
    addStock(stockName, transaction.price, transaction.quantity)

  }

  function addStock(symbol, avgCost, quantity) {
    // check if the stock already exists in the stocks object
    if (stocks[symbol]) {
      // if it does, update its properties
      stocks[symbol].avgCost = ((stocks[symbol].avgCost * stocks[symbol].quantity) + (avgCost * quantity)) / (stocks[symbol].quantity + quantity);
      stocks[symbol].quantity += quantity;
    } else {
      // if it doesn't, create a new stock object and add it to the stocks object
      stocks[symbol] = { name: symbol, avgCost: avgCost, quantity: quantity };
    }
  }

  // get yesterday's closing price and add to object
  for (var symbol in stocks) {
    var stock = stocks[symbol];
    // console.log(stock.name + ": " + stock.avgCost + " (" + stock.quantity + ")");

    // get yesterday's closing price
    var yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const stockPrice = getPrice(yesterday, stock.name);
  
    // add the price to our array of stock objs for calculating performance
    stocks[symbol].price = stockPrice;
    // console.log("Stock: " + stocks[symbol].name + " Latest Price is " + stockPrice);
  
  }

  return stocks

  function getPrice(date, ticker) {
    // fetches the price for a particular stock and date from timeSeriesData

    var valuationDate = moment(date).format("YYYY-MM-DD")
  
    let filteredData = timeSeriesData.filter(dataPoint => {
      return moment(dataPoint.date).format("YYYY-MM-DD") === valuationDate &&
             dataPoint.stock === ticker;
    });
  
    if (filteredData.length > 0) {
      return filteredData[0].price;
    } else {
      return null;
    }
  }

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

    var formattedGainLoss = (stock.price * stock.quantity) -  (stock.avgCost * stock.quantity);
    formattedGainLoss = formattedGainLoss.toLocaleString('en-US', options);
    formattedGainLossTotal += ((stock.price * stock.quantity) -  (stock.avgCost * stock.quantity));

    var formattedGainLossPercent = (((stock.price * stock.quantity) - (stock.avgCost * stock.quantity)) / (stock.avgCost * stock.quantity)) * 100
    formattedGainLossPercent = formattedGainLossPercent.toLocaleString('en-US', options);

    // create the HTML elements - rows of the Holdings table
    const html = '<div class="row-stocks">' +
      '<div class="col-stocks ticker">' + stock.name + '</div>' +
      '<div class="col-stocks">' + stock.quantity + '</div>' +
      '<div class="col-stocks">' + stock.price + '</div>' +
      '<div class="col-stocks">' + formattedValue + '</div>' +   // value
      '<div class="col-stocks">' + formattedAvgCost + '</div>' +
      '<div class="col-stocks gainloss"><span class="">' + formattedGainLoss + '</span></div>' +
      '<div class="col-stocks gainlossperc"><span class="">' + formattedGainLossPercent + '</span></div>' +
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

  colorNegativesRed();

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
  //////////////////////////////////////////////////////////
  // main program - all key functions are called from here /
  //////////////////////////////////////////////////////////

  // TODO: Get the last portfolio loaded by the user - and load that 

  // if investor has not set up any portfolio yet then display the DJ30 stocks
  stocks = ["AAPL", "AXP", "BA", "CAT", "CRM", "CSCO", "CVX", "DIS", "DOW", "GS", 
    "HD", "HON", "IBM", "INTC", "JNJ", "JPM", "KO", "MCD", "MMM", "MRK", "MSFT", 
    "NKE", "PG", "TRV", "UNH", "V", "VZ", "WBA", "WMT", "XOM"
  ]

  // NB we are passing and empty string as the portfolio name as no portfolio loaded - we are simply displaying
  // DJ30 stocks
  displayData(stocks, proxyPortfolio);

  hideElements();

}

function hideElements() {
  const elementsToHide = document.querySelectorAll('.portfolio');

  elementsToHide.forEach(element => {
    element.style.display = 'none';
  });
}

function showElements() {
  const elementsToShow = document.querySelectorAll('.portfolio');

  elementsToShow.forEach(element => {
    element.style.display = 'block';
  });
}


async function displayData(stocks, portfolioName) {
  // Displays data to the screen whenever the portfolio changes, including charts
  // and portfolio holdings (if an investor portfolio is currently loaded)

  var answer;
  var timeSeriesData = [];
  var portfolio = {};

  // Remove the current thumbnail images as they need to be defined for the selected portfolio
  $("#thumbnail img").remove();

  // Remove the current Equity Curve, this needs to be redrawn for the current portfolio
  $("#viz svg").remove();

  await Promise.all(stocks.map(async function(value, index) {
    answer = await sendRequest(value, timeSeriesData);
    }));
    
    // dont call these functions if the page has just loaded as the investor has not yet selected a portfolio to analyse/value
    if (portfolioName !== proxyPortfolio) {

      portfolio = await getValuation(timeSeriesData, portfolioName); // this is the investors portfolio they wish to show, this call will retrieve the daily closing prices so we can build an equity curve
      const labels = Object.keys(portfolio);
      const values = Object.values(portfolio);

      // function call to draw equity curve
      drawEquityCurve(portfolio);

      var holdings = getHoldings(portfolioName, timeSeriesData);

      createHoldingsTable(holdings)

    }
      // Adds title to page
      addTitle(portfolioName);
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

init();
