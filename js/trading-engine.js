
"use strict";

// ==========================================
// ACTIVE TRADE STATE
// ==========================================

const activeTradeState = {
    trade: null
};


// ==========================================
// MONEY FORMAT
// ==========================================

function formatMoney(value) {

    const amount =
        Number(value);

    if (!Number.isFinite(amount)) {
        return "$0.00";
    }

    return "$" + amount.toFixed(2);
}


// ==========================================
// GET SELECTED ACCOUNT
// ==========================================

function getSelectedTradingMode() {

    const storedMode =
        String(
            localStorage.getItem(
                "kmf_account_mode"
            ) || "demo"
        )
        .trim()
        .toLowerCase();


    if (
        storedMode !== "demo" &&
        storedMode !== "real"
    ) {

        console.warn(
            "Invalid saved account mode. Resetting to demo."
        );

        localStorage.setItem(
            "kmf_account_mode",
            "demo"
        );

        return "demo";
    }


    return storedMode;
}


// ==========================================
// SUBMIT KMF TRADE
// ==========================================

async function submitKMFTrade({

    market,

    contractType,

    action,

    stake,

    duration,

    durationUnit,

    targetDigit,

    barrierPrice,

    barrierDirection,

    accumulatorGrowth,

    accumulatorBarrier,

    accumulatorDirection

}) {

    console.log(
        "========== KMF TRADE =========="
    );


    // ==========================================
    // MARKET VALIDATION
    // ==========================================

    if (!market) {

        throw new Error(
            "Please select a market."
        );

    }


    if (!market.id) {

        throw new Error(
            "Selected market has no valid ID."
        );

    }


    // ==========================================
    // CONTRACT TYPE
    // ==========================================

    const selectedContract =
        String(
            contractType ||
            market.contract_type ||
            ""
        )
        .trim()
        .toLowerCase();


    if (!selectedContract) {

        throw new Error(
            "Please select a contract type."
        );

    }


    // ==========================================
    // ACTION
    // ==========================================

    const selectedAction =
        String(
            action || ""
        )
        .trim()
        .toLowerCase();


    if (!selectedAction) {

        throw new Error(
            "Please select a trading action."
        );

    }


    // ==========================================
    // STAKE
    // ==========================================

    const amount =
        Number(stake);


    if (
        !Number.isFinite(amount) ||
        amount < 0.35
    ) {

        throw new Error(
            "Minimum stake is $0.35."
        );

    }


    // ==========================================
    // DURATION
    // ==========================================

    const contractDuration =
        Number(duration);


    const contractDurationUnit =
        String(
            durationUnit || "s"
        )
        .trim()
        .toLowerCase();


    if (
        !Number.isInteger(
            contractDuration
        ) ||
        contractDuration <= 0
    ) {

        throw new Error(
            "Please enter a valid duration."
        );

    }


    if (
        contractDurationUnit !== "s" &&
        contractDurationUnit !== "t"
    ) {

        throw new Error(
            "Duration must be seconds or ticks."
        );

    }


    // ==========================================
    // VALID CONTRACT ACTIONS
    // ==========================================

    const validActions = {

        rise_fall: [
            "rise",
            "fall"
        ],

        higher_lower: [
            "higher",
            "lower"
        ],

        odd_even: [
            "odd",
            "even"
        ],

        over_under: [
            "over",
            "under"
        ],

        matches: [
            "matches"
        ],

        differs: [
            "differs"
        ],

        touch_no_touch: [
            "touch",
            "no_touch"
        ],

        accumulator: [
            "accumulate"
        ]

    };


    if (
        !Object.prototype.hasOwnProperty.call(
            validActions,
            selectedContract
        )
    ) {

        throw new Error(
            "Unsupported contract type."
        );

    }


    if (
        !validActions[
            selectedContract
        ].includes(
            selectedAction
        )
    ) {

        throw new Error(
            "Invalid trading action."
        );

    }


    // ==========================================
    // ACCOUNT MODE
    // ==========================================

    /*
     * The selected account comes from the
     * Dashboard / Wallet account selector.
     *
     * demo = Demo Account
     * real = Live Account
     *
     * We deliberately do NOT use a mode supplied
     * by the calling page/function.
     */

    const selectedMode =
        getSelectedTradingMode();


    console.log(
        "SELECTED ACCOUNT:",
        selectedMode === "real"
            ? "LIVE ACCOUNT"
            : "DEMO ACCOUNT"
    );


    // ==========================================
    // TRADE PAYLOAD
    // ==========================================

    const payload = {

        marketId:
            market.id,

        contractType:
            selectedContract,

        action:
            selectedAction,

        stake:
            Number(
                amount.toFixed(2)
            ),

        duration:
            contractDuration,

        durationUnit:
            contractDurationUnit,

        mode:
            selectedMode

    };


    // ==========================================
    // MATCHES
    // ==========================================

    if (
        selectedContract === "matches"
    ) {

        if (
            contractDurationUnit !== "t"
        ) {

            throw new Error(
                "Matches uses tick duration."
            );

        }


        const digit =
            Number(targetDigit);


        if (
            !Number.isInteger(digit) ||
            digit < 0 ||
            digit > 9
        ) {

            throw new Error(
                "Please select a target digit from 0 to 9."
            );

        }


        payload.targetDigit =
            digit;

    }


    // ==========================================
    // DIFFERS
    // ==========================================

    if (
        selectedContract === "differs"
    ) {

        if (
            contractDurationUnit !== "t"
        ) {

            throw new Error(
                "Differs uses tick duration."
            );

        }


        const digit =
            Number(targetDigit);


        if (
            !Number.isInteger(digit) ||
            digit < 0 ||
            digit > 9
        ) {

            throw new Error(
                "Please select a target digit from 0 to 9."
            );

        }


        payload.targetDigit =
            digit;

    }


    // ==========================================
    // OVER / UNDER
    // ==========================================

    if (
        selectedContract === "over_under"
    ) {

        if (
            contractDurationUnit !== "t"
        ) {

            throw new Error(
                "Over/Under uses tick duration."
            );

        }


        const digit =
            Number(targetDigit);


        if (
            !Number.isInteger(digit) ||
            digit < 1 ||
            digit > 8
        ) {

            throw new Error(
                "Please select a digit from 1 to 8 for Over/Under."
            );

        }


        payload.targetDigit =
            digit;

    }


    // ==========================================
    // ODD / EVEN
    // ==========================================

    if (
        selectedContract === "odd_even"
    ) {

        if (
            contractDurationUnit !== "t"
        ) {

            throw new Error(
                "Odd/Even uses tick duration."
            );

        }


        payload.targetDigit =
            null;

    }


    // ==========================================
    // RISE / FALL
    // ==========================================

    if (
        selectedContract === "rise_fall"
    ) {

        payload.targetDigit =
            null;

    }


    // ==========================================
    // HIGHER / LOWER
    // ==========================================

    if (
        selectedContract === "higher_lower"
    ) {

        const barrier =
            Number(barrierPrice);


        if (
            !Number.isFinite(barrier) ||
            barrier <= 0
        ) {

            throw new Error(
                "Please enter a valid price barrier."
            );

        }


        payload.barrierPrice =
            Number(
                barrier.toFixed(2)
            );


        payload.targetDigit =
            null;

    }


    // ==========================================
    // TOUCH / NO TOUCH
    // ==========================================

    if (
        selectedContract === "touch_no_touch"
    ) {

        const barrier =
            Number(barrierPrice);


        if (
            !Number.isFinite(barrier) ||
            barrier <= 0
        ) {

            throw new Error(
                "Please enter a valid barrier price."
            );

        }


        const direction =
            String(
                barrierDirection || ""
            )
            .trim()
            .toLowerCase();


        if (
            direction !== "above" &&
            direction !== "below"
        ) {

            throw new Error(
                "Please select Above or Below."
            );

        }


        payload.barrierPrice =
            Number(
                barrier.toFixed(2)
            );


        payload.barrierDirection =
            direction;

    }


    // ==========================================
    // ACCUMULATOR
    // ==========================================

    if (
        selectedContract === "accumulator"
    ) {

        const growth =
            Number(
                accumulatorGrowth
            );


        const direction =
            String(
                accumulatorDirection || ""
            )
            .trim()
            .toLowerCase();


        // ------------------------------------------
        // GROWTH
        // ------------------------------------------

        if (
            !Number.isFinite(growth) ||
            growth <= 0
        ) {

            throw new Error(
                "Please select a valid accumulator growth."
            );

        }


        // ------------------------------------------
        // DIRECTION
        // ------------------------------------------

        if (
            direction !== "above" &&
            direction !== "below"
        ) {

            throw new Error(
                "Please select accumulator direction."
            );

        }


        // ------------------------------------------
        // ACCUMULATOR BOUNDARIES
        // ------------------------------------------
        //
        // The backend calculates the fixed
        // upper and lower boundaries from the
        // actual entry price.
        //
        // No manual knockout barrier is required.
        // ------------------------------------------

        payload.accumulatorGrowth =
            growth;


        payload.accumulatorBarrier =
            null;


        payload.accumulatorDirection =
            direction;

    }


    // ==========================================
    // FINAL DEBUG
    // ==========================================

    console.log(
        "FINAL TRADE ACCOUNT:",
        payload.mode
    );


    console.log(
        "FINAL PAYLOAD:",
        JSON.stringify(
            payload,
            null,
            2
        )
    );


    // ==========================================
    // API CHECK
    // ==========================================

    if (
        typeof placeTrade !== "function"
    ) {

        throw new Error(
            "placeTrade() was not found. Check api.js."
        );

    }


    // ==========================================
    // PLACE TRADE
    // ==========================================

    const result =
        await placeTrade(
            payload
        );


    if (!result) {

        throw new Error(
            "Backend returned an empty response."
        );

    }


    if (!result.trade) {

        console.error(
            "Backend response:",
            result
        );

        throw new Error(
            "Backend did not return a trade."
        );

    }


    // ==========================================
    // SAVE ACTIVE TRADE
    // ==========================================

    activeTradeState.trade =
        result.trade;


    console.log(
        "TRADE CREATED:",
        result.trade.id
    );


    console.log(
        "TRADE ACCOUNT:",
        result.trade.mode
    );


    return activeTradeState.trade;

}


// ==========================================
// STARTUP
// ==========================================

console.log(
    "KMFBinary trading-engine.js loaded successfully."
);

console.log(
    "submitKMFTrade:",
    typeof submitKMFTrade
);

console.log(
    "Selected account:",
    getSelectedTradingMode()
);

