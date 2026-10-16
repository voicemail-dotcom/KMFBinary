"use strict";

/*
==========================================================
KMF BUY / SELL SYNTHETIC MARKET
==========================================================

Symbol:
KMF-BS

Features:
- Fast-moving synthetic price
- Tick updates every 150ms
- 1-minute OHLC candles
- Natural movement and reversals
- BUY / SELL compatible
==========================================================
*/

const markets = {};

const SYMBOL = "KMF-BS";

const START_PRICE = 4100;

const TICK_INTERVAL_MS = 150;

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
        -2 *
        Math.log(u)
    ) *
    Math.cos(
        2 *
        Math.PI *
        v
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
            timestamp /
            CANDLE_DURATION_MS
        ) *
        CANDLE_DURATION_MS;


    return {

        time:
            candleStart,

        open:
            price,

        high:
            price,

        low:
            price,

        close:
            price

    };

}


/*
==========================================================
INITIAL CANDLE HISTORY
==========================================================
*/

function initializeCandles(
    market
) {

    const now =
        Date.now();


    let price =
        START_PRICE;


    for (
        let i = 119;
        i >= 0;
        i--
    ) {

        const time =
            now -
            i *
            CANDLE_DURATION_MS;


        const open =
            price;


        let high =
            open;


        let low =
            open;


        const movement =
            randomNormal() *
            3;


        const close =
            Math.max(
                1,
                open + movement
            );


        high =
            Math.max(
                open,
                close
            ) +
            Math.random() * 2;


        low =
            Math.min(
                open,
                close
            ) -
            Math.random() * 2;


        price =
            close;


        market.candles.push({

            time:
                Math.floor(
                    time /
                    CANDLE_DURATION_MS
                ) *
                CANDLE_DURATION_MS,

            open,

            high,

            low,

            close

        });

    }


    market.price =
        price;


    market.previousPrice =
        price;


    market.currentCandle =
        createCandle(
            market,
            price,
            now
        );

}


/*
==========================================================
INITIALIZE
==========================================================
*/

initializeCandles(
    markets[SYMBOL]
);


/*
==========================================================
GENERATE TICK
==========================================================
*/

function generateTick() {

    const market =
        markets[SYMBOL];


    const now =
        Date.now();


    /*
    ------------------------------------------
    SMALL MARKET DRIFT
    ------------------------------------------
    */

    market.drift +=
        randomNormal() *
        0.04;


    market.drift *=
        0.96;


    /*
    ------------------------------------------
    RANDOM MOVEMENT
    ------------------------------------------
    */

    let movement =
        randomNormal() *
        0.65;


    /*
    ------------------------------------------
    OCCASIONAL STRONGER MOVE
    ------------------------------------------
    */

    if (
        Math.random() <
        0.035
    ) {

        movement +=
            randomNormal() *
            2.5;

    }


    /*
    ------------------------------------------
    DRIFT
    ------------------------------------------
    */

    movement +=
        market.drift;


    /*
    ------------------------------------------
    PRICE
    ------------------------------------------
    */

    const newPrice =
        Math.max(
            1,
            market.price +
            movement
        );


    market.previousPrice =
        market.price;


    market.price =
        Number(
            newPrice.toFixed(2)
        );


    market.tick++;


    market.lastTickTime =
        now;


    /*
    ------------------------------------------
    CANDLE
    ------------------------------------------
    */

    const candleStart =
        Math.floor(
            now /
            CANDLE_DURATION_MS
        ) *
        CANDLE_DURATION_MS;


    if (
        !market.currentCandle ||
        market.currentCandle.time !==
        candleStart
    ) {

        if (
            market.currentCandle
        ) {

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
            market.candles.length >
            MAX_CANDLES
        ) {

            market.candles.shift();

        }

    }

    else {

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

    for (
        const callback of
        market.subscribers
    ) {

        try {

            callback({

                symbol:
                    market.symbol,

                price:
                    market.price,

                previousPrice:
                    market.previousPrice,

                tick:
                    market.tick,

                timestamp:
                    now

            });

        }

        catch (error) {

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

function getPrice(
    symbol = SYMBOL
) {

    const market =
        markets[symbol];


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

function getMarket(
    symbol = SYMBOL
) {

    return markets[symbol] || null;

}


/*
==========================================================
GET CANDLES
==========================================================
*/

function getCandles(
    symbol = SYMBOL
) {

    const market =
        markets[symbol];


    if (!market) {

        return [];

    }


    const candles =
        [
            ...market.candles
        ];


    if (
        market.currentCandle
    ) {

        candles.push(
            market.currentCandle
        );

    }


    return candles.slice(
        -MAX_CANDLES
    );

}


/*
==========================================================
SUBSCRIBE
==========================================================
*/

function subscribe(
    symbol,
    callback
) {

    const market =
        markets[symbol];


    if (
        !market ||
        typeof callback !==
        "function"
    ) {

        return () => {};

    }


    market.subscribers.add(
        callback
    );


    return () => {

        market.subscribers.delete(
            callback
        );

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