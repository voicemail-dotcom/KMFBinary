// ==========================================
// KMFBINARY SYNTHETIC MARKET ENGINE
// ==========================================
//
// Features:
// - Independent price stream for every market
// - KMF markets preserved
// - VOL-10/25/50/75/100 preserved
// - 1-second VOL markets preserved
// - Faster controlled random movement
// - Tick history
// - Price-path access
// - Suitable for AI analysis
// - Suitable for Touch / No Touch
// - Suitable for Accumulator tracking
//
// NOTE:
// This is a KMFBinary synthetic generator.
// It does NOT reproduce Deriv's proprietary RNG.
// ==========================================


// ==========================================
// MARKET DEFINITIONS
// ==========================================

const markets = {

    // ======================================
    // KMF MARKETS
    // ======================================

    "KMF-15": {
        symbol: "KMF-15",
        name: "KMF Volatility 15",
        volatility: 15,
        startPrice: 10000,
        interval: 1000
    },

    "KMF-25": {
        symbol: "KMF-25",
        name: "KMF Volatility 25",
        volatility: 25,
        startPrice: 10000,
        interval: 1000
    },

    "KMF-50": {
        symbol: "KMF-50",
        name: "KMF Volatility 50",
        volatility: 50,
        startPrice: 10000,
        interval: 1000
    },

    "KMF-100": {
        symbol: "KMF-100",
        name: "KMF Volatility 100",
        volatility: 100,
        startPrice: 10000,
        interval: 1000
    },


    // ======================================
    // NORMAL VOLATILITY
    // 1 TICK EVERY 1 SECOND
    // ======================================

    "VOL-10": {
        symbol: "VOL-10",
        name: "Volatility 10",
        volatility: 10,
        startPrice: 4600,
        interval: 1000
    },

    "VOL-25": {
        symbol: "VOL-25",
        name: "Volatility 25",
        volatility: 25,
        startPrice: 6500,
        interval: 1000
    },

    "VOL-50": {
        symbol: "VOL-50",
        name: "Volatility 50",
        volatility: 50,
        startPrice: 8500,
        interval: 1000
    },

    "VOL-75": {
        symbol: "VOL-75",
        name: "Volatility 75",
        volatility: 75,
        startPrice: 11500,
        interval: 1000
    },

    "VOL-100": {
        symbol: "VOL-100",
        name: "Volatility 100",
        volatility: 100,
        startPrice: 15000,
        interval: 1000
    },


    // ======================================
    // VOLATILITY 1S
    // 2 TICKS EVERY SECOND
    // ======================================

    "VOL-10-1S": {
        symbol: "VOL-10-1S",
        name: "Volatility 10 (1s)",
        volatility: 10,
        startPrice: 4700,
        interval: 500
    },

    "VOL-25-1S": {
        symbol: "VOL-25-1S",
        name: "Volatility 25 (1s)",
        volatility: 25,
        startPrice: 6600,
        interval: 500
    },

    "VOL-50-1S": {
        symbol: "VOL-50-1S",
        name: "Volatility 50 (1s)",
        volatility: 50,
        startPrice: 8700,
        interval: 500
    },

    "VOL-75-1S": {
        symbol: "VOL-75-1S",
        name: "Volatility 75 (1s)",
        volatility: 75,
        startPrice: 11700,
        interval: 500
    },

    "VOL-100-1S": {
        symbol: "VOL-100-1S",
        name: "Volatility 100 (1s)",
        volatility: 100,
        startPrice: 14800,
        interval: 500
    }
};


// ==========================================
// HISTORY
// ==========================================

const MAX_HISTORY = 2000;

const state = {};


// ==========================================
// GAUSSIAN RANDOM
// ==========================================

function gaussianRandom() {

    let u = 0;
    let v = 0;

    while (u === 0) {
        u = Math.random();
    }

    while (v === 0) {
        v = Math.random();
    }

    return Math.sqrt(
        -2 * Math.log(u)
    ) * Math.cos(
        2 * Math.PI * v
    );
}


// ==========================================
// INITIALIZE MARKETS
// ==========================================

for (const symbol of Object.keys(markets)) {

    const config = markets[symbol];

    const startingPrice =
        Number(
            config.startPrice.toFixed(2)
        );

    const now = Date.now();

    state[symbol] = {

        price: startingPrice,

        previousPrice: startingPrice,

        updatedAt: now,

        tick: 0,

        history: [

            {
                price: startingPrice,

                previousPrice: startingPrice,

                tick: 0,

                timestamp: now
            }

        ]
    };
}


// ==========================================
// MOVEMENT CALCULATION
// ==========================================

function calculateMovement(config) {

    const volatilityFactor =
        config.volatility / 100;

    let tickFactor;


    // --------------------------------------
    // 500ms markets
    // 2 ticks per second
    // --------------------------------------

    if (config.interval === 500) {

        tickFactor = 0.11;

    }


    // --------------------------------------
    // 1000ms markets
    // 1 tick per second
    // --------------------------------------

    else if (config.interval === 1000) {

        tickFactor = 0.18;

    }


    // --------------------------------------
    // Fallback
    // --------------------------------------

    else {

        tickFactor = 0.25;

    }


    const random =
        gaussianRandom();


    // Prevent extreme single-tick jumps

    const limitedRandom =
        Math.max(
            -3,
            Math.min(
                3,
                random
            )
        );


    const percentageMove =
        volatilityFactor *
        tickFactor *
        limitedRandom /
        100;


    return percentageMove;
}


// ==========================================
// RECORD TICK
// ==========================================

function recordTick(symbol) {

    const current =
        state[symbol];

    if (!current) {
        return;
    }


    current.history.push({

        price:
            current.price,

        previousPrice:
            current.previousPrice,

        tick:
            current.tick,

        timestamp:
            current.updatedAt
    });


    if (
        current.history.length >
        MAX_HISTORY
    ) {

        current.history.shift();

    }
}


// ==========================================
// UPDATE MARKET
// ==========================================

function updateMarket(symbol) {

    const config =
        markets[symbol];

    const current =
        state[symbol];


    if (
        !config ||
        !current
    ) {

        return;
    }


    current.previousPrice =
        current.price;


    const percentageMove =
        calculateMovement(config);


    const movement =
        current.price *
        percentageMove;


    current.price =
        Number(
            (
                current.price +
                movement
            ).toFixed(2)
        );


    // Safety check

    if (
        !Number.isFinite(
            current.price
        )
    ) {

        current.price =
            current.previousPrice;
    }


    // Prevent negative prices

    if (
        current.price <= 0
    ) {

        current.price = 0.01;
    }


    current.tick += 1;

    current.updatedAt =
        Date.now();


    recordTick(symbol);
}


// ==========================================
// START MARKET ENGINES
// ==========================================

for (
    const symbol of Object.keys(markets)
) {

    const config =
        markets[symbol];


    setInterval(
        () => {

            updateMarket(symbol);

        },
        config.interval
    );
}


// ==========================================
// GET PRICE
// ==========================================

function getPrice(symbol) {

    if (!state[symbol]) {
        return null;
    }

    return state[symbol].price;
}


// ==========================================
// GET PREVIOUS PRICE
// ==========================================

function getPreviousPrice(symbol) {

    if (!state[symbol]) {
        return null;
    }

    return state[symbol].previousPrice;
}


// ==========================================
// GET MARKET
// ==========================================

function getMarket(symbol) {

    if (!state[symbol]) {
        return null;
    }


    const config =
        markets[symbol];

    const current =
        state[symbol];


    let tickSpeed;


    if (
        config.interval === 500
    ) {

        tickSpeed = "500ms";

    }

    else if (
        config.interval === 1000
    ) {

        tickSpeed = "1s";

    }

    else {

        tickSpeed =
            `${config.interval / 1000}s`;
    }


    return {

        symbol:
            config.symbol,

        name:
            config.name,

        volatility:
            config.volatility,

        interval:
            config.interval,

        tickSpeed:
            tickSpeed,

        price:
            current.price,

        previousPrice:
            current.previousPrice,

        updatedAt:
            current.updatedAt,

        tick:
            current.tick
    };
}


// ==========================================
// GET HISTORY
// ==========================================

function getHistory(
    symbol,
    limit = 100
) {

    if (!state[symbol]) {
        return [];
    }


    const safeLimit =
        Math.max(
            1,
            Math.min(
                Number(limit) || 100,
                MAX_HISTORY
            )
        );


    const history =
        state[symbol].history;


    return history.slice(
        -safeLimit
    );
}


// ==========================================
// GET RECENT PRICES
// ==========================================

function getRecentPrices(
    symbol,
    limit = 50
) {

    return getHistory(
        symbol,
        limit
    ).map(
        item => item.price
    );
}


// ==========================================
// GET PRICE PATH
// ==========================================

function getPricePath(
    symbol,
    startTime,
    endTime
) {

    if (!state[symbol]) {
        return [];
    }


    const start =
        Number(startTime) || 0;


    const end =
        Number(endTime) ||
        Date.now();


    return state[symbol].history.filter(

        item =>
            item.timestamp >= start &&
            item.timestamp <= end

    );
}


// ==========================================
// CHECK BARRIER
// ==========================================

function checkBarrier(
    symbol,
    barrier,
    direction,
    startTime
) {

    if (!state[symbol]) {
        return false;
    }


    const target =
        Number(barrier);


    if (
        !Number.isFinite(target)
    ) {

        return false;
    }


    const prices =
        getPricePath(
            symbol,
            startTime || 0,
            Date.now()
        );


    for (
        const item of prices
    ) {

        const price =
            Number(item.price);


        if (
            direction === "above" &&
            price >= target
        ) {

            return true;
        }


        if (
            direction === "below" &&
            price <= target
        ) {

            return true;
        }
    }


    return false;
}


// ==========================================
// GET ALL PRICES
// ==========================================

function getAllPrices() {

    const prices = {};


    for (
        const symbol of Object.keys(state)
    ) {

        const config =
            markets[symbol];

        const current =
            state[symbol];


        let tickSpeed;


        if (
            config.interval === 500
        ) {

            tickSpeed = "500ms";

        }

        else if (
            config.interval === 1000
        ) {

            tickSpeed = "1s";

        }

        else {

            tickSpeed =
                `${config.interval / 1000}s`;
        }


        prices[symbol] = {

            symbol:
                symbol,

            name:
                config.name,

            volatility:
                config.volatility,

            interval:
                config.interval,

            tickSpeed:
                tickSpeed,

            price:
                current.price,

            previousPrice:
                current.previousPrice,

            updatedAt:
                current.updatedAt,

            tick:
                current.tick
        };
    }


    return prices;
}


// ==========================================
// GET SYMBOLS
// ==========================================

function getSymbols() {

    return Object.keys(markets);
}


// ==========================================
// EXPORTS
// ==========================================

module.exports = {

    markets,

    getPrice,

    getPreviousPrice,

    getMarket,

    getAllPrices,

    getHistory,

    getRecentPrices,

    getPricePath,

    checkBarrier,

    getSymbols
};