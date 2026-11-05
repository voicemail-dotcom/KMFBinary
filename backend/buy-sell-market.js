
"use strict";

/*
==========================================================
KMF BUY / SELL SYNTHETIC MARKET
==========================================================

Symbol:
KMF-BS

Features:
- Controlled, gradual price movement
- Smaller random price changes
- Reduced sudden jumps
- Smooth market drift and reversals
- 1-minute OHLC candles
- BUY / SELL compatible
- Shared price source for P/L and candles

NOTE:
The settlement and wallet rules remain unchanged.
==========================================================
*/

const markets = {};

const SYMBOL = "KMF-BS";

const START_PRICE = 4100;

// Four updates per second.
const TICK_INTERVAL_MS = 250;

const CANDLE_DURATION_MS = 60 * 1000;

const MAX_CANDLES = 120;


/*
==========================================================
MARKET STATE
==========================================================
*/

markets[SYMBOL] = {

    symbol: SYMBOL,

    price: START_PRICE,

    previousPrice: START_PRICE,

    tick: 0,

    candles: [],

    currentCandle: null,

    subscribers: new Set(),

    lastTickTime: Date.now(),

    drift: 0

};


/*
==========================================================
RANDOM HELPERS
==========================================================
*/

function randomNormal() {

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


/*
==========================================================
CREATE CANDLE
==========================================================
*/

function createCandle(
    market,
    price,
    timestamp
) {

    const candleStart =
        Math.floor(
            timestamp / CANDLE_DURATION_MS
        ) * CANDLE_DURATION_MS;

    return {

        time: candleStart,

        open: price,

        high: price,

        low: price,

        close: price

    };

}


/*
==========================================================
INITIAL CANDLE HISTORY
==========================================================
*/

function initializeCandles(market) {

    const now = Date.now();

    let price = START_PRICE;

    for (let i = 119; i >= 0; i--) {

        const time =
            now - i * CANDLE_DURATION_MS;

        const open = price;

        // Smaller historical price changes.
        const movement =
            randomNormal() * 0.6;

        const close =
            Math.max(
                1,
                open + movement
            );

        const high =
            Math.max(open, close) +
            Math.random() * 0.4;

        const low =
            Math.max(
                1,
                Math.min(open, close) -
                Math.random() * 0.4
            );

        price = close;

        market.candles.push({

            time:
                Math.floor(
                    time / CANDLE_DURATION_MS
                ) * CANDLE_DURATION_MS,

            open,

            high,

            low,

            close

        });

    }

    market.price = Number(price.toFixed(2));

    market.previousPrice = market.price;

    market.currentCandle =
        createCandle(
            market,
            market.price,
            now
        );

}


/*
==========================================================
INITIALIZE MARKET
==========================================================
*/

initializeCandles(markets[SYMBOL]);


/*
==========================================================
GENERATE TICK
==========================================================
*/

function generateTick() {

    const market = markets[SYMBOL];

    const now = Date.now();


    /*
    ------------------------------------------
    GENTLE MARKET DRIFT
    ------------------------------------------
    */

    market.drift +=
        randomNormal() * 0.024;

    market.drift *= 0.94;


    /*
    ------------------------------------------
    SMALLER RANDOM MOVEMENT
    ------------------------------------------
    */

    let movement =
        randomNormal() * 0.39;


    /*
    ------------------------------------------
    OCCASIONAL SMALLER MOVEMENT
    ------------------------------------------
    */

    if (Math.random() < 0.015) {

        movement +=
            randomNormal() * 1.5;

    }


    /*
    ------------------------------------------
    COMBINE MOVEMENT
    ------------------------------------------
    */

    movement += market.drift;


    /*
    ------------------------------------------
    LIMIT EXTREME SINGLE-TICK JUMPS
    ------------------------------------------

    Prevents one random tick from creating
    an unusually large price jump.

    This does not cap total movement over
    the full duration of a trade.
    ------------------------------------------
    */

    movement = Math.max(
        -0.40,
        Math.min(0.40, movement)
    );


    /*
    ------------------------------------------
    UPDATE PRICE
    ------------------------------------------
    */

    const newPrice =
        Math.max(
            1,
            market.price + movement
        );

    market.previousPrice = market.price;

    market.price =
        Number(newPrice.toFixed(2));

    market.tick++;

    market.lastTickTime = now;


    /*
    ------------------------------------------
    UPDATE CANDLE
    ------------------------------------------
    */

    const candleStart =
        Math.floor(
            now / CANDLE_DURATION_MS
        ) * CANDLE_DURATION_MS;

    if (
        !market.currentCandle ||
        market.currentCandle.time !== candleStart
    ) {

        if (market.currentCandle) {

            market.candles.push(
                market.currentCandle
            );

        }

        market.currentCandle =
            createCandle(
                market,
                market.price,
                now
            );

        if (
            market.candles.length > MAX_CANDLES
        ) {

            market.candles.shift();

        }

    } else {

        market.currentCandle.high =
            Math.max(
                market.currentCandle.high,
                market.price
            );

        market.currentCandle.low =
            Math.min(
                market.currentCandle.low,
                market.price
            );

        market.currentCandle.close =
            market.price;

    }


    /*
    ------------------------------------------
    NOTIFY SUBSCRIBERS
    ------------------------------------------
    */

    for (const callback of market.subscribers) {

        try {

            callback({

                symbol: market.symbol,

                price: market.price,

                previousPrice: market.previousPrice,

                tick: market.tick,

                timestamp: now

            });

        } catch (error) {

            console.error(
                "Buy/Sell subscriber error:",
                error
            );

        }

    }

    return market.price;

}


/*
==========================================================
MARKET LOOP
==========================================================
*/

setInterval(
    generateTick,
    TICK_INTERVAL_MS
);


/*
==========================================================
GET PRICE
==========================================================
*/

function getPrice(symbol = SYMBOL) {

    const market = markets[symbol];

    if (!market) {
        return null;
    }

    return market.price;

}


/*
==========================================================
GET MARKET
==========================================================
*/

function getMarket(symbol = SYMBOL) {

    return markets[symbol] || null;

}


/*
==========================================================
GET CANDLES
==========================================================
*/

function getCandles(symbol = SYMBOL) {

    const market = markets[symbol];

    if (!market) {
        return [];
    }

    const candles = [
        ...market.candles
    ];

    if (market.currentCandle) {

        candles.push(
            market.currentCandle
        );

    }

    return candles.slice(-MAX_CANDLES);

}


/*
==========================================================
SUBSCRIBE
==========================================================
*/

function subscribe(symbol, callback) {

    const market = markets[symbol];

    if (
        !market ||
        typeof callback !== "function"
    ) {

        return () => {};

    }

    market.subscribers.add(callback);

    return () => {

        market.subscribers.delete(callback);

    };

}


/*
==========================================================
EXPORT
==========================================================
*/

module.exports = {

    SYMBOL,

    markets,

    getPrice,

    getMarket,

    getCandles,

    generateTick,

    subscribe

};
