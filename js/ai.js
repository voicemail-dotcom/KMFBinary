const AI_STATE = {
    prices: [],
    maxHistory: 60,
    timer: null,
    running: false
};


// ===============================
// MARKET → SYNTHETIC SYMBOL
// ===============================

function getSyntheticSymbol(symbol) {

    const mapping = {
        "KMF-RF": "KMF-15",
        "KMF-HL": "KMF-25",
        "KMF-OE": "KMF-50",
        "KMF-OU": "KMF-100"
    };

    return mapping[symbol] || null;
}


// ===============================
// ADD PRICE
// ===============================

function addPrice(price) {

    if (!Number.isFinite(price)) {
        return;
    }

    AI_STATE.prices.push({
        price: price,
        time: Date.now()
    });

    if (
        AI_STATE.prices.length >
        AI_STATE.maxHistory
    ) {
        AI_STATE.prices.shift();
    }
}


// ===============================
// MOMENTUM
// ===============================

function calculateMomentum(prices) {

    if (prices.length < 5) {
        return 0;
    }

    const recent =
        prices.slice(-5);

    const first =
        recent[0].price;

    const last =
        recent[recent.length - 1].price;

    if (first === 0) {
        return 0;
    }

    return (
        (last - first) /
        first
    ) * 100;
}


// ===============================
// TREND
// ===============================

function calculateTrend(prices) {

    if (prices.length < 10) {
        return "INSUFFICIENT DATA";
    }

    const recent =
        prices.slice(-10);

    let upward = 0;
    let downward = 0;

    for (
        let i = 1;
        i < recent.length;
        i++
    ) {

        if (
            recent[i].price >
            recent[i - 1].price
        ) {

            upward++;

        } else if (
            recent[i].price <
            recent[i - 1].price
        ) {

            downward++;

        }

    }

    if (upward >= 7) {
        return "STRONG UP";
    }

    if (downward >= 7) {
        return "STRONG DOWN";
    }

    if (upward > downward) {
        return "UP";
    }

    if (downward > upward) {
        return "DOWN";
    }

    return "SIDEWAYS";
}


// ===============================
// VOLATILITY
// ===============================

function calculateVolatility(prices) {

    if (prices.length < 5) {
        return 0;
    }

    const movements = [];

    for (
        let i = 1;
        i < prices.length;
        i++
    ) {

        movements.push(
            Math.abs(
                prices[i].price -
                prices[i - 1].price
            )
        );

    }

    const total =
        movements.reduce(
            function(sum, value) {
                return sum + value;
            },
            0
        );

    return (
        total /
        movements.length
    );
}


// ===============================
// DIRECTION STRENGTH
// ===============================

function calculateDirectionStrength(
    prices
) {

    if (prices.length < 10) {
        return 0;
    }

    const recent =
        prices.slice(-10);

    let up = 0;
    let down = 0;

    for (
        let i = 1;
        i < recent.length;
        i++
    ) {

        if (
            recent[i].price >
            recent[i - 1].price
        ) {

            up++;

        } else if (
            recent[i].price <
            recent[i - 1].price
        ) {

            down++;

        }

    }

    const total =
        up + down;

    if (total === 0) {
        return 0;
    }

    return Math.round(
        Math.abs(up - down) /
        total *
        100
    );
}


// ===============================
// AI ANALYSIS
// ===============================

function generateAIAnalysis(
    prices,
    symbol
) {

    if (prices.length < 10) {

        return {

            signal: "WAIT",

            confidence: 0,

            trend: "INSUFFICIENT DATA",

            momentum: 0,

            volatility: 0,

            strength: 0,

            reasons: [
                "Collecting market data...",
                "More price history is required."
            ]

        };

    }

    const trend =
        calculateTrend(prices);

    const momentum =
        calculateMomentum(prices);

    const volatility =
        calculateVolatility(prices);

    const strength =
        calculateDirectionStrength(prices);

    let signal = "WAIT";

    let confidence = 50;

    const reasons = [];


    // TREND

    if (
        trend === "STRONG UP"
    ) {

        signal = "RISE";

        confidence += 15;

        reasons.push(
            "Strong upward trend detected."
        );

    } else if (
        trend === "STRONG DOWN"
    ) {

        signal = "FALL";

        confidence += 15;

        reasons.push(
            "Strong downward trend detected."
        );

    } else if (
        trend === "UP"
    ) {

        signal = "RISE";

        confidence += 8;

        reasons.push(
            "Market has a positive short-term trend."
        );

    } else if (
        trend === "DOWN"
    ) {

        signal = "FALL";

        confidence += 8;

        reasons.push(
            "Market has a negative short-term trend."
        );

    } else {

        reasons.push(
            "Market is moving sideways."
        );

    }


    // MOMENTUM

    if (
        momentum > 0.01
    ) {

        confidence += 8;

        reasons.push(
            "Momentum is positive."
        );

    } else if (
        momentum < -0.01
    ) {

        confidence += 8;

        reasons.push(
            "Momentum is negative."
        );

    } else {

        confidence -= 5;

        reasons.push(
            "Momentum is weak."
        );

    }


    // STRENGTH

    if (
        strength >= 70
    ) {

        confidence += 8;

        reasons.push(
            "Recent price movements strongly favor one direction."
        );

    } else if (
        strength >= 50
    ) {

        confidence += 4;

        reasons.push(
            "Directional pressure is moderate."
        );

    } else {

        confidence -= 5;

        reasons.push(
            "Directional pressure is weak."
        );

    }


    // VOLATILITY

    reasons.push(
        "Average recent movement: " +
        volatility.toFixed(2)
    );


    // SIDEWAYS FILTER

    if (
        trend === "SIDEWAYS" &&
        strength < 30
    ) {

        signal = "WAIT";

        confidence = 45;

        reasons.push(
            "No strong directional advantage detected."
        );

    }


    // CONTRACT NOTES

    if (
        symbol === "KMF-OE"
    ) {

        reasons.push(
            "Odd/Even requires final-digit probability analysis."
        );

    }

    if (
        symbol === "KMF-OU"
    ) {

        reasons.push(
            "Over/Under requires target-price analysis."
        );

    }

    if (
        symbol === "KMF-HL"
    ) {

        reasons.push(
            "Higher/Lower requires target-price analysis."
        );

    }


    confidence =
        Math.max(
            0,
            Math.min(
                95,
                Math.round(confidence)
            )
        );


    return {

        signal: signal,

        confidence: confidence,

        trend: trend,

        momentum: momentum,

        volatility: volatility,

        strength: strength,

        reasons: reasons

    };
}


// ===============================
// UPDATE AI
// ===============================

async function updateAI() {

    try {

        const select =
            document.getElementById(
                "marketSelect"
            );

        if (!select) {
            return;
        }

        const symbol =
            select.value;

        if (!symbol) {
            return;
        }


        const data =
            await getPrices();


        if (
            !data ||
            !data.prices
        ) {

            throw new Error(
                "Invalid price data received."
            );

        }


        const syntheticSymbol =
            getSyntheticSymbol(symbol);


        if (!syntheticSymbol) {

            throw new Error(
                "No synthetic market mapped to " +
                symbol
            );

        }


        const market =
            data.prices[
                syntheticSymbol
            ];


        if (!market) {

            throw new Error(
                "Price unavailable for " +
                syntheticSymbol
            );

        }


        const price =
            Number(
                market.price
            );


        if (
            !Number.isFinite(price)
        ) {

            return;

        }


        addPrice(price);


        const analysis =
            generateAIAnalysis(
                AI_STATE.prices,
                symbol
            );


        updateAIInterface(
            price,
            market.previousPrice,
            analysis
        );

    }

    catch (error) {

        console.error(
            "AI update error:",
            error
        );

    }

}


// ===============================
// UPDATE INTERFACE
// ===============================

function updateAIInterface(
    price,
    previousPrice,
    analysis
) {

    const currentPrice =
        document.getElementById(
            "currentPrice"
        );

    const priceElement =
        document.getElementById(
            "price"
        );

    const previousElement =
        document.getElementById(
            "previousPrice"
        );

    const signalElement =
        document.getElementById(
            "signalDirection"
        );

    const confidenceElement =
        document.getElementById(
            "confidence"
        );

    const volatilityElement =
        document.getElementById(
            "volatility"
        );

    const movementElement =
        document.getElementById(
            "movement"
        );

    const reasonsElement =
        document.getElementById(
            "reasons"
        );

    const statusElement =
        document.getElementById(
            "status"
        );


    if (currentPrice) {

        currentPrice.textContent =
            price.toFixed(2);

    }


    if (priceElement) {

        priceElement.textContent =
            price.toFixed(2);

    }


    if (
        previousElement &&
        Number.isFinite(
            Number(previousPrice)
        )
    ) {

        previousElement.textContent =
            Number(
                previousPrice
            ).toFixed(2);

    }


    if (signalElement) {

        signalElement.textContent =
            analysis.signal;

    }


    if (confidenceElement) {

        confidenceElement.textContent =
            "Confidence: " +
            analysis.confidence +
            "%";

    }


    if (volatilityElement) {

        volatilityElement.textContent =
            analysis.volatility.toFixed(2);

    }


    if (movementElement) {

        movementElement.textContent =
            analysis.momentum.toFixed(4) +
            "%";

    }


    if (reasonsElement) {

        reasonsElement.innerHTML = "";

        analysis.reasons.forEach(
            function(reason) {

                const div =
                    document.createElement(
                        "div"
                    );

                div.className =
                    "reason";

                div.textContent =
                    "• " + reason;

                reasonsElement.appendChild(
                    div
                );

            }
        );

    }


    if (statusElement) {

        statusElement.textContent =
            "AI monitoring " +
            AI_STATE.prices.length +
            " price points.";

    }

}


// ===============================
// START AI ENGINE
// ===============================

function startAIEngine() {

    if (
        AI_STATE.running
    ) {

        return;

    }


    AI_STATE.running =
        true;


    console.log(
        "KMFBinary AI Engine Started"
    );


    updateAI();


    AI_STATE.timer =
        setInterval(
            updateAI,
            1000
        );

}


// ===============================
// STOP AI ENGINE
// ===============================

function stopAIEngine() {

    if (
        AI_STATE.timer
    ) {

        clearInterval(
            AI_STATE.timer
        );

        AI_STATE.timer =
            null;

    }


    AI_STATE.running =
        false;

}


// ===============================
// MARKET CHANGE
// ===============================

document.addEventListener(
    "DOMContentLoaded",
    function() {

        const select =
            document.getElementById(
                "marketSelect"
            );


        if (select) {

            select.addEventListener(
                "change",
                function() {

                    AI_STATE.prices = [];

                    console.log(
                        "AI switched to:",
                        select.value
                    );

                    updateAI();

                }
            );

        }

    }
);