// =====================================================
// KMFBINARY KMF MARKET ENGINE
// BACKEND CONNECTED VERSION
// =====================================================


// =====================================================
// API
// =====================================================

const KMF_API_URL =
    "http://localhost:3000/api/prices";


// =====================================================
// MARKET CONFIGURATION
// =====================================================

const KMF_MARKETS = {

    KMF15: {
        symbol: "KMF-15",
        name: "KMF Volatility 15"
    },

    KMF25: {
        symbol: "KMF-25",
        name: "KMF Volatility 25"
    },

    KMF50: {
        symbol: "KMF-50",
        name: "KMF Volatility 50"
    },

    KMF100: {
        symbol: "KMF-100",
        name: "KMF Volatility 100"
    }

};


// =====================================================
// MARKET STATE
// =====================================================

let currentMarket = "KMF100";

let currentPrice = 10000;

let previousPrice = 10000;

let tickNumber = 0;

let marketRunning = false;

let marketTimer = null;

let marketTicks = [];

const MAX_TICKS = 500;


// =====================================================
// BACKEND MARKET DATA
// =====================================================

let backendPrices = {};


// =====================================================
// HELPER
// =====================================================

function formatPrice(price) {

    return Number(price).toLocaleString(
        "en-US",
        {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }
    );

}


// =====================================================
// LAST DIGIT
// =====================================================

function getLastDigit(price) {

    const formatted =
        Number(price).toFixed(2);

    const numbers =
        formatted.replace(".", "");

    return Number(
        numbers.charAt(
            numbers.length - 1
        )
    );

}


// =====================================================
// GET CURRENT BACKEND PRICE
// =====================================================

function getBackendPrice(market) {

    const config =
        KMF_MARKETS[market];

    if (!config) {

        return null;

    }

    const data =
        backendPrices[
            config.symbol
        ];

    if (!data) {

        return null;

    }

    const price =
        Number(data.price);

    if (!Number.isFinite(price)) {

        return null;

    }

    return price;

}


// =====================================================
// CREATE TICK FROM BACKEND PRICE
// =====================================================

function createTick(price) {

    previousPrice =
        currentPrice;

    currentPrice =
        price;

    tickNumber++;


    const tick = {

        number:
            tickNumber,

        price:
            currentPrice,

        digit:
            getLastDigit(
                currentPrice
            ),

        time:
            new Date()

    };


    marketTicks.push(tick);


    if (
        marketTicks.length >
        MAX_TICKS
    ) {

        marketTicks.shift();

    }


    updateDashboard();

    updateMarketsPage();

    updateStatistics();

    drawChart();

}


// =====================================================
// FETCH LIVE PRICES
// =====================================================

async function fetchKMFPrices() {

    try {

        const response =
            await fetch(
                KMF_API_URL,
                {
                    cache: "no-store"
                }
            );


        if (!response.ok) {

            throw new Error(
                "Price server returned " +
                response.status
            );

        }


        const data =
            await response.json();


        if (
            !data ||
            !data.success ||
            !data.prices
        ) {

            throw new Error(
                "Invalid price response"
            );

        }


        backendPrices =
            data.prices;


        const price =
            getBackendPrice(
                currentMarket
            );


        if (
            price !== null
        ) {

            createTick(price);

        }


        updateAllMarketCards();


        console.log(
            "Live KMF prices:",
            backendPrices
        );

    }

    catch (error) {

        console.error(
            "KMF price update failed:",
            error
        );

    }

}


// =====================================================
// UPDATE DASHBOARD
// =====================================================

function updateDashboard() {

    const priceElement =
        document.getElementById(
            "dashboardPrice"
        );

    const marketElement =
        document.getElementById(
            "dashboardMarket"
        );

    const changeElement =
        document.getElementById(
            "dashboardChange"
        );

    const ticksElement =
        document.getElementById(
            "dashboardTicks"
        );

    const volatilityElement =
        document.getElementById(
            "dashboardVolatility"
        );


    // PRICE

    if (priceElement) {

        priceElement.textContent =
            formatPrice(
                currentPrice
            );

    }


    // MARKET

    if (marketElement) {

        const config =
            KMF_MARKETS[
                currentMarket
            ];

        marketElement.textContent =
            config
                ? config.name
                : currentMarket;

    }


    // CHANGE

    const change =
        currentPrice -
        previousPrice;


    if (changeElement) {

        changeElement.textContent =
            (change >= 0 ? "+" : "") +
            change.toFixed(2);


        changeElement.classList.remove(
            "green",
            "red"
        );


        if (change > 0) {

            changeElement.classList.add(
                "green"
            );

        }

        else if (change < 0) {

            changeElement.classList.add(
                "red"
            );

        }

    }


    // TICKS

    if (ticksElement) {

        ticksElement.textContent =
            tickNumber;

    }


    // VOLATILITY

    if (volatilityElement) {

        const config =
            KMF_MARKETS[
                currentMarket
            ];


        if (config) {

            const backendSymbol =
                config.symbol;


            const volatility =
                getBackendVolatility(
                    backendSymbol
                );


            volatilityElement.textContent =
                volatility;

        }

    }


    updateMarketCards();

}


// =====================================================
// GET BACKEND VOLATILITY
// =====================================================

function getBackendVolatility(symbol) {

    const volatilityMap = {

        "KMF-15": "0.20",

        "KMF-25": "0.35",

        "KMF-50": "0.65",

        "KMF-100": "1.20"

    };


    return (
        volatilityMap[symbol] ||
        "0.00"
    );

}


// =====================================================
// UPDATE CURRENT MARKET CARD
// =====================================================

function updateMarketCards() {

    const cards =
        document.querySelectorAll(
            ".market-card"
        );


    cards.forEach(card => {

        let market =
            card.dataset.market;


        if (!market) {

            return;

        }


        // Support possible legacy
        // card names.

        if (market === "KMF10") {
            market = "KMF15";
        }

        if (market === "KMF75") {
            market = "KMF100";
        }


        const config =
            KMF_MARKETS[market];


        if (!config) {

            return;

        }


        const price =
            getBackendPrice(
                market
            );


        const priceElement =
            card.querySelector(
                ".market-price"
            );


        if (
            priceElement &&
            price !== null
        ) {

            priceElement.textContent =
                formatPrice(price);

        }


        if (
            market === currentMarket
        ) {

            card.classList.add(
                "selected"
            );

        }

        else {

            card.classList.remove(
                "selected"
            );

        }

    });

}


// =====================================================
// UPDATE ALL MARKET CARDS
// =====================================================

function updateAllMarketCards() {

    updateMarketCards();

    updateMarketsPage();

}


// =====================================================
// UPDATE MARKETS PAGE
// =====================================================

function updateMarketsPage() {

    Object.keys(
        KMF_MARKETS
    ).forEach(market => {

        const priceElement =
            document.getElementById(
                "price-" + market
            );


        const changeElement =
            document.getElementById(
                "change-" + market
            );


        const price =
            getBackendPrice(
                market
            );


        if (
            !priceElement ||
            price === null
        ) {

            return;

        }


        priceElement.textContent =
            formatPrice(price);


        if (changeElement) {

            const backendSymbol =
                KMF_MARKETS[
                    market
                ].symbol;


            const marketData =
                backendPrices[
                    backendSymbol
                ];


            if (marketData) {

                const change =
                    Number(
                        marketData.price
                    ) -
                    Number(
                        marketData.previousPrice
                    );


                changeElement.textContent =
                    (change >= 0
                        ? "+"
                        : "") +
                    change.toFixed(2);


                changeElement.classList.remove(
                    "green",
                    "red"
                );


                if (change > 0) {

                    changeElement.classList.add(
                        "green"
                    );

                }

                else if (
                    change < 0
                ) {

                    changeElement.classList.add(
                        "red"
                    );

                }

            }

        }

    });

}


// =====================================================
// STATISTICS
// =====================================================

function calculateStatistics() {

    const windowSize = 100;

    const recentTicks =
        marketTicks.slice(
            -windowSize
        );


    let odd = 0;

    let even = 0;


    const digits = {

        0: 0,
        1: 0,
        2: 0,
        3: 0,
        4: 0,
        5: 0,
        6: 0,
        7: 0,
        8: 0,
        9: 0

    };


    recentTicks.forEach(
        tick => {

            const digit =
                tick.digit;


            digits[digit]++;


            if (
                digit % 2 === 0
            ) {

                even++;

            }

            else {

                odd++;

            }

        }
    );


    return {

        total:
            recentTicks.length,

        odd:
            odd,

        even:
            even,

        digits:
            digits

    };

}


// =====================================================
// UPDATE STATISTICS
// =====================================================

function updateStatistics() {

    const stats =
        calculateStatistics();


    let oddPercentage = 0;

    let evenPercentage = 0;


    if (
        stats.total > 0
    ) {

        oddPercentage =
            (
                stats.odd /
                stats.total
            ) *
            100;


        evenPercentage =
            (
                stats.even /
                stats.total
            ) *
            100;

    }


    const oddElement =
        document.getElementById(
            "oddPercentage"
        );


    const evenElement =
        document.getElementById(
            "evenPercentage"
        );


    if (oddElement) {

        oddElement.textContent =
            oddPercentage.toFixed(0) +
            "%";

    }


    if (evenElement) {

        evenElement.textContent =
            evenPercentage.toFixed(0) +
            "%";

    }


    // DIGITS 0 - 9

    for (
        let i = 0;
        i <= 9;
        i++
    ) {

        const element =
            document.getElementById(
                "digit" + i
            );


        if (!element) {

            continue;

        }


        let percentage = 0;


        if (
            stats.total > 0
        ) {

            percentage =
                (
                    stats.digits[i] /
                    stats.total
                ) *
                100;

        }


        element.textContent =
            percentage.toFixed(0) +
            "%";

    }

}


// =====================================================
// CHANGE MARKET
// =====================================================

function changeKMFMarket(market) {

    // Support legacy names.

    if (market === "KMF10") {
        market = "KMF15";
    }

    if (market === "KMF75") {
        market = "KMF100";
    }


    if (
        !KMF_MARKETS[market]
    ) {

        console.warn(
            "Unknown KMF market:",
            market
        );

        return;

    }


    currentMarket =
        market;


    const price =
        getBackendPrice(
            market
        );


    if (price !== null) {

        currentPrice =
            price;

        previousPrice =
            price;

    }


    tickNumber = 0;

    marketTicks = [];


    updateDashboard();

    updateMarketsPage();

    updateStatistics();

    drawChart();


    console.log(
        "KMF market changed to:",
        currentMarket
    );

}


// =====================================================
// START MARKET
// =====================================================

function startKMFMarket() {

    if (
        marketRunning
    ) {

        return;

    }


    marketRunning = true;


    // Get prices immediately.

    fetchKMFPrices();


    // Then update every second.

    marketTimer =
        setInterval(
            fetchKMFPrices,
            1000
        );


    console.log(
        "KMF live market started"
    );

}


// =====================================================
// STOP MARKET
// =====================================================

function stopKMFMarket() {

    if (
        !marketRunning
    ) {

        return;

    }


    clearInterval(
        marketTimer
    );


    marketTimer = null;

    marketRunning = false;


    console.log(
        "KMF live market stopped"
    );

}


// =====================================================
// DRAW DASHBOARD CHART
// =====================================================

function drawChart() {

    const canvas =
        document.getElementById(
            "dashboardChart"
        );


    if (!canvas) {

        return;

    }


    const container =
        canvas.parentElement;


    if (!container) {

        return;

    }


    const width =
        container.clientWidth;


    const height =
        container.clientHeight;


    if (
        width <= 0 ||
        height <= 0
    ) {

        return;

    }


    const devicePixelRatio =
        window.devicePixelRatio ||
        1;


    canvas.width =
        width *
        devicePixelRatio;


    canvas.height =
        height *
        devicePixelRatio;


    canvas.style.width =
        width + "px";


    canvas.style.height =
        height + "px";


    const ctx =
        canvas.getContext(
            "2d"
        );


    ctx.setTransform(
        devicePixelRatio,
        0,
        0,
        devicePixelRatio,
        0,
        0
    );


    ctx.clearRect(
        0,
        0,
        width,
        height
    );


    drawChartGrid(
        ctx,
        width,
        height
    );


    if (
        marketTicks.length < 2
    ) {

        return;

    }


    const data =
        marketTicks.slice(
            -80
        );


    let min =
        Math.min(
            ...data.map(
                tick =>
                    tick.price
            )
        );


    let max =
        Math.max(
            ...data.map(
                tick =>
                    tick.price
            )
        );


    if (
        max === min
    ) {

        max += 1;

        min -= 1;

    }


    const padding = 20;


    const chartWidth =
        width -
        padding * 2;


    const chartHeight =
        height -
        padding * 2;


    ctx.beginPath();


    data.forEach(
        (tick, index) => {

            const x =
                padding +
                (
                    index /
                    (
                        data.length - 1
                    )
                ) *
                chartWidth;


            const y =
                padding +
                (
                    (
                        max -
                        tick.price
                    ) /
                    (
                        max -
                        min
                    )
                ) *
                chartHeight;


            if (
                index === 0
            ) {

                ctx.moveTo(
                    x,
                    y
                );

            }

            else {

                ctx.lineTo(
                    x,
                    y
                );

            }

        }
    );


    ctx.strokeStyle =
        "#55d69a";


    ctx.lineWidth = 2;


    ctx.stroke();

}


// =====================================================
// CHART GRID
// =====================================================

function drawChartGrid(
    ctx,
    width,
    height
) {

    ctx.strokeStyle =
        "#1d2a3a";


    ctx.lineWidth = 1;


    const rows = 5;


    for (
        let i = 1;
        i < rows;
        i++
    ) {

        const y =
            (
                height /
                rows
            ) *
            i;


        ctx.beginPath();

        ctx.moveTo(
            0,
            y
        );

        ctx.lineTo(
            width,
            y
        );

        ctx.stroke();

    }


    const columns = 6;


    for (
        let i = 1;
        i < columns;
        i++
    ) {

        const x =
            (
                width /
                columns
            ) *
            i;


        ctx.beginPath();

        ctx.moveTo(
            x,
            0
        );

        ctx.lineTo(
            x,
            height
        );

        ctx.stroke();

    }

}


// =====================================================
// MARKET CARD CLICK
// =====================================================

document.addEventListener(
    "click",
    function(event) {

        const card =
            event.target.closest(
                ".market-card"
            );


        if (!card) {

            return;

        }


        let market =
            card.dataset.market;


        if (!market) {

            return;

        }


        if (market === "KMF10") {
            market = "KMF15";
        }

        if (market === "KMF75") {
            market = "KMF100";
        }


        changeKMFMarket(
            market
        );

    }
);


// =====================================================
// CHART TYPE BUTTONS
// =====================================================

document.addEventListener(
    "click",
    function(event) {

        const button =
            event.target.closest(
                ".chart-tool"
            );


        if (!button) {

            return;

        }


        document
            .querySelectorAll(
                ".chart-tool"
            )
            .forEach(
                btn => {

                    btn.classList.remove(
                        "active"
                    );

                }
            );


        button.classList.add(
            "active"
        );


        console.log(
            "Chart selected:",
            button.textContent
        );

    }
);


// =====================================================
// INITIALIZE
// =====================================================

function initializeKMFMarket() {

    console.log(
        "Initializing KMFBinary live market..."
    );


    updateDashboard();

    updateMarketsPage();

    updateStatistics();

    drawChart();


    startKMFMarket();

}


// =====================================================
// START AFTER PAGE LOAD
// =====================================================

if (
    document.readyState ===
    "loading"
) {

    document.addEventListener(
        "DOMContentLoaded",
        initializeKMFMarket
    );

}

else {

    initializeKMFMarket();

}


// =====================================================
// REDRAW CHART ON RESIZE
// =====================================================

window.addEventListener(
    "resize",
    drawChart
);