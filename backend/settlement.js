// ==========================================
// KMFBINARY SETTLEMENT ENGINE
// ==========================================
//
// Supports:
//
// DIGITS
// - Matches
// - Differs
// - Over
// - Under
// - Even
// - Odd
//
// DIRECTIONAL
// - Rise / Fall
// - Higher / Lower
// - Touch / No Touch
//
// GROWTH
// - Accumulator
//
// Duration modes:
// - seconds
// - ticks
//
// ==========================================

const supabase = require("./supabase");
const syntheticMarket = require("./synthetic-market");


// ==========================================
// CONFIGURATION
// ==========================================

const ACCUMULATOR_MAX_PAYOUT =
    Number(
        process.env.ACCUMULATOR_MAX_PAYOUT || 10000
    );

const ACCUMULATOR_KNOCKOUT_PERCENT =
    Number(
        process.env.ACCUMULATOR_KNOCKOUT_PERCENT || 0.02
    );

const ACCUMULATOR_MAX_MULTIPLIER =
    Number(
        process.env.ACCUMULATOR_MAX_MULTIPLIER || 100
    );

const TOUCH_BARRIER_DISTANCE =
    Number(
        process.env.TOUCH_BARRIER_DISTANCE || 2
    );


// ==========================================
// ACCUMULATOR GROWTH
// ==========================================

const ACCUMULATOR_GROWTH_OPTIONS = [
    0.01,
    0.02,
    0.03,
    0.04,
    0.05
];


console.log(
    "KMFBinary settlement module loaded."
);


// ==========================================
// SYNTHETIC MARKET MAPPING
// ==========================================

function getSyntheticSymbol(trade) {

    const map = {

        "KMF-RF": "KMF-15",
        "KMF-HL": "KMF-25",
        "KMF-OE": "KMF-50",
        "KMF-OU": "KMF-100",

        "KMF-15": "KMF-15",
        "KMF-25": "KMF-25",
        "KMF-50": "KMF-50",
        "KMF-100": "KMF-100",

        "VOL-10": "VOL-10",
        "VOL-25": "VOL-25",
        "VOL-50": "VOL-50",
        "VOL-75": "VOL-75",
        "VOL-100": "VOL-100",

        "VOL-10-1S": "VOL-10-1S",
        "VOL-25-1S": "VOL-25-1S",
        "VOL-50-1S": "VOL-50-1S",
        "VOL-75-1S": "VOL-75-1S",
        "VOL-100-1S": "VOL-100-1S",

        "Volatility 10": "VOL-10",
        "Volatility 25": "VOL-25",
        "Volatility 50": "VOL-50",
        "Volatility 75": "VOL-75",
        "Volatility 100": "VOL-100"

    };

    return (
        map[
            String(
                trade.symbol || ""
            ).trim()
        ] ||
        "KMF-15"
    );

}


// ==========================================
// LAST DIGIT
// ==========================================

function getLastDigit(price) {

    const number =
        Number(price);

    if (
        !Number.isFinite(number)
    ) {

        return null;

    }

    return Math.abs(
        Math.floor(
            number * 100
        )
    ) % 10;

}


// ==========================================
// VALID DIGIT
// ==========================================

function isValidDigit(digit) {

    return (
        Number.isInteger(
            Number(digit)
        ) &&
        Number(digit) >= 0 &&
        Number(digit) <= 9
    );

}


// ==========================================
// BOOLEAN NORMALIZER
// ==========================================

function isTrue(value) {

    return (
        value === true ||
        value === "true" ||
        value === 1 ||
        value === "1"
    );

}


// ==========================================
// NORMALIZE CONTRACT TYPE
// ==========================================

function normalizeContractType(trade) {

    return String(
        trade.contract_type ||
        ""
    )
    .trim()
    .toLowerCase();

}


// ==========================================
// NORMALIZE ACTION
// ==========================================

function normalizeAction(trade) {

    return String(
        trade.action ||
        ""
    )
    .trim()
    .toLowerCase();

}


// ==========================================
// NORMALIZE DURATION UNIT
// ==========================================

function getDurationUnit(trade) {

    const unit =
        String(
            trade.duration_unit ||
            ""
        )
        .trim()
        .toLowerCase();

    if (
        unit === "t" ||
        unit === "tick" ||
        unit === "ticks"
    ) {

        return "t";

    }

    return "s";

}


// ==========================================
// GET TRADE DURATION
// ==========================================

function getTradeDuration(trade) {

    const duration =
        Number(
            trade.duration
        );

    if (
        Number.isInteger(duration) &&
        duration > 0
    ) {

        return duration;

    }

    const expirySeconds =
        Number(
            trade.expiry_seconds
        );

    if (
        Number.isInteger(
            expirySeconds
        ) &&
        expirySeconds > 0
    ) {

        return expirySeconds;

    }

    return null;

}


// ==========================================
// GET COMPARISON PAYOUT RATE
// ==========================================

function getComparisonPayoutRate(
    action,
    targetDigit
) {

    const target =
        Number(targetDigit);

    if (
        !isValidDigit(target)
    ) {

        return 0;

    }

    const normalizedAction =
        String(action || "")
            .trim()
            .toLowerCase();

    let winningDigits = 0;

    if (
        normalizedAction === "higher" ||
        normalizedAction === "over"
    ) {

        winningDigits =
            9 - target;

    }

    else if (
        normalizedAction === "lower" ||
        normalizedAction === "under"
    ) {

        winningDigits =
            target;

    }

    if (
        winningDigits <= 0
    ) {

        return 0;

    }

    return (
        10 /
        winningDigits
    ) - 1;

}


// ==========================================
// DIGIT PAYOUT
// ==========================================

function getDigitPayoutRate(
    action
) {

    const normalizedAction =
        String(action || "")
            .trim()
            .toLowerCase();

    if (
        normalizedAction === "matches"
    ) {

        return 9;

    }

    if (
        normalizedAction === "differs"
    ) {

        return (
            10 / 9
        ) - 1;

    }

    return 0;

}


// ==========================================
// ODD / EVEN PAYOUT
// ==========================================

function getOddEvenPayoutRate() {

    return 0.95;

}


// ==========================================
// RISE / FALL PAYOUT
// ==========================================

function getRiseFallPayoutRate() {

    return 0.90;

}


// ==========================================
// TOUCH PAYOUT
// ==========================================

function getTouchPayoutRate() {

    return 0.80;

}


// ==========================================
// ACCUMULATOR GROWTH
// ==========================================

function getAccumulatorGrowth(
    trade
) {

    const growth =
        Number(
            trade.accumulator_growth
        );

    if (
        ACCUMULATOR_GROWTH_OPTIONS.includes(
            growth
        )
    ) {

        return growth;

    }

    if (
        growth === 0.10 ||
        growth === 0.20 ||
        growth === 0.30
    ) {

        return growth;

    }

    return 0.01;

}


// ==========================================
// ACCUMULATOR BOUNDARIES
// ==========================================
//
// The accumulator has TWO effective
// knockout boundaries.
//
// Example:
//
// Entry = 100
// Knockout = 2%
//
// Lower = 98
// Upper = 102
//
// Touching either boundary = LOST.
//
// ==========================================

function calculateAccumulatorBoundaries(
    entryPrice
) {

    const price =
        Number(entryPrice);

    if (
        !Number.isFinite(price) ||
        price <= 0
    ) {

        throw new Error(
            "Invalid accumulator entry price"
        );

    }

    const distance =
        price *
        ACCUMULATOR_KNOCKOUT_PERCENT;

    const lowerBoundary =
        Number(
            (
                price -
                distance
            ).toFixed(2)
        );

    const upperBoundary =
        Number(
            (
                price +
                distance
            ).toFixed(2)
        );

    return {

        entryPrice:
            Number(
                price.toFixed(2)
            ),

        lowerBoundary,

        upperBoundary

    };

}


// ==========================================
// ACCUMULATOR BARRIER CHECK
// ==========================================
//
// Kept compatible with the existing
// accumulator_barrier + direction fields.
//
// This function checks the configured single
// legacy barrier.
//
// The active accumulator monitor below uses
// BOTH boundaries.
//
// ==========================================

function accumulatorBarrierHit(
    price,
    barrier,
    direction
) {

    const currentPrice =
        Number(price);

    const knockout =
        Number(barrier);

    const normalizedDirection =
        String(
            direction || ""
        )
        .trim()
        .toLowerCase();

    if (
        !Number.isFinite(
            currentPrice
        ) ||
        !Number.isFinite(
            knockout
        )
    ) {

        return false;

    }

    if (
        normalizedDirection === "above"
    ) {

        return (
            currentPrice <=
            knockout
        );

    }

    if (
        normalizedDirection === "below"
    ) {

        return (
            currentPrice >=
            knockout
        );

    }

    return false;

}


// ==========================================
// CHECK BOTH ACCUMULATOR BOUNDARIES
// ==========================================

function accumulatorBoundariesHit(
    price,
    entryPrice
) {

    const currentPrice =
        Number(price);

    const boundaries =
        calculateAccumulatorBoundaries(
            entryPrice
        );

    if (
        !Number.isFinite(
            currentPrice
        ) ||
        !boundaries
    ) {

        return {
            hit: false,
            side: null,
            lower: null,
            upper: null
        };

    }

    const lowerHit =
        currentPrice <=
        boundaries.lowerBoundary;

    const upperHit =
        currentPrice >=
        boundaries.upperBoundary;

    if (
        lowerHit &&
        upperHit
    ) {

        return {
            hit: true,
            side: "both",
            lower: boundaries.lowerBoundary,
            upper: boundaries.upperBoundary
        };

    }

    if (
        lowerHit
    ) {

        return {
            hit: true,
            side: "lower",
            lower: boundaries.lowerBoundary,
            upper: boundaries.upperBoundary
        };

    }

    if (
        upperHit
    ) {

        return {
            hit: true,
            side: "upper",
            lower: boundaries.lowerBoundary,
            upper: boundaries.upperBoundary
        };

    }

    return {
        hit: false,
        side: null,
        lower: boundaries.lowerBoundary,
        upper: boundaries.upperBoundary
    };

}


// ==========================================
// CALCULATE ACCUMULATOR BARRIER
// ==========================================
//
// Kept for compatibility with the existing
// server.js.
//
// "above" returns the LOWER knockout.
// "below" returns the UPPER knockout.
//
// The monitor itself now uses BOTH boundaries.
//
// ==========================================

function calculateAccumulatorBarrier(
    entryPrice,
    direction
) {

    const price =
        Number(entryPrice);

    if (
        !Number.isFinite(price)
    ) {

        return null;

    }

    const normalizedDirection =
        String(
            direction || ""
        )
        .trim()
        .toLowerCase();

    const boundaries =
        calculateAccumulatorBoundaries(
            price
        );

    if (
        !boundaries
    ) {

        return null;

    }

    if (
        normalizedDirection === "above"
    ) {

        return boundaries.lowerBoundary;

    }

    if (
        normalizedDirection === "below"
    ) {

        return boundaries.upperBoundary;

    }

    return null;

}


// ==========================================
// DETERMINE RESULT
// ==========================================

function determineResult(
    trade,
    exitPrice
) {

    const contractType =
        normalizeContractType(
            trade
        );

    const action =
        normalizeAction(
            trade
        );

    const entryPrice =
        Number(
            trade.entry_price
        );

    const finalPrice =
        Number(exitPrice);

    if (
        !Number.isFinite(
            finalPrice
        )
    ) {

        return false;

    }


    // ==========================================
    // RISE / FALL
    // ==========================================

    if (
        contractType === "rise_fall"
    ) {

        if (
            !Number.isFinite(
                entryPrice
            )
        ) {

            return false;

        }

        if (
            action === "rise"
        ) {

            return (
                finalPrice >
                entryPrice
            );

        }

        if (
            action === "fall"
        ) {

            return (
                finalPrice <
                entryPrice
            );

        }

        return false;

    }


    // ==========================================
    // HIGHER / LOWER
    // ==========================================

    if (
        contractType === "higher_lower"
    ) {

        const barrier =
            Number(
                trade.target_price
            );

        if (
            !Number.isFinite(
                barrier
            ) ||
            barrier <= 0
        ) {

            return false;

        }

        if (
            action === "higher"
        ) {

            return (
                finalPrice >
                barrier
            );

        }

        if (
            action === "lower"
        ) {

            return (
                finalPrice <
                barrier
            );

        }

        return false;

    }


    // ==========================================
    // OVER / UNDER
    // ==========================================

    if (
        contractType === "over_under"
    ) {

        const digit =
            getLastDigit(
                finalPrice
            );

        const target =
            Number(
                trade.target_digit
            );

        if (
            digit === null ||
            !isValidDigit(target)
        ) {

            return false;

        }

        if (
            action === "over"
        ) {

            return (
                digit >
                target
            );

        }

        if (
            action === "under"
        ) {

            return (
                digit <
                target
            );

        }

        return false;

    }


    // ==========================================
    // EVEN / ODD
    // ==========================================

    if (
        contractType === "odd_even"
    ) {

        const digit =
            getLastDigit(
                finalPrice
            );

        if (
            digit === null
        ) {

            return false;

        }

        if (
            action === "even"
        ) {

            return (
                digit % 2 === 0
            );

        }

        if (
            action === "odd"
        ) {

            return (
                digit % 2 !== 0
            );

        }

        return false;

    }


    // ==========================================
    // MATCHES / DIFFERS
    // ==========================================

    if (
        contractType === "matches" ||
        contractType === "differs"
    ) {

        const digit =
            getLastDigit(
                finalPrice
            );

        const target =
            Number(
                trade.target_digit
            );

        if (
            digit === null ||
            !isValidDigit(target)
        ) {

            return false;

        }

        if (
            contractType === "matches"
        ) {

            return (
                digit ===
                target
            );

        }

        if (
            contractType === "differs"
        ) {

            return (
                digit !==
                target
            );

        }

    }


    // ==========================================
    // TOUCH / NO TOUCH
    // ==========================================

    if (
        contractType === "touch_no_touch"
    ) {

        const touched =
            isTrue(
                trade.barrier_touched
            );

        if (
            action === "touch"
        ) {

            return touched;

        }

        if (
            action === "no_touch"
        ) {

            return !touched;

        }

        return false;

    }


    // ==========================================
    // ACCUMULATOR
    // ==========================================

    if (
        contractType === "accumulator"
    ) {

        return !isTrue(
            trade.accumulator_broken
        );

    }


    return false;

}


// ==========================================
// GET PAYOUT RATE
// ==========================================

function getPayoutRate(
    trade
) {

    const contractType =
        normalizeContractType(
            trade
        );

    const action =
        normalizeAction(
            trade
        );


    if (
        contractType === "matches" ||
        contractType === "differs"
    ) {

        return getDigitPayoutRate(
            contractType
        );

    }


    if (
        contractType === "rise_fall"
    ) {

        return getRiseFallPayoutRate();

    }


    if (
        contractType === "higher_lower"
    ) {

        return (
            Number(
                trade.payout_rate
            ) > 0
        )
            ? Number(
                trade.payout_rate
            )
            : 0.90;

    }


    if (
        contractType === "over_under"
    ) {

        return getComparisonPayoutRate(
            action,
            trade.target_digit
        );

    }


    if (
        contractType === "odd_even"
    ) {

        return getOddEvenPayoutRate();

    }


    if (
        contractType === "touch_no_touch"
    ) {

        return getTouchPayoutRate();

    }


    if (
        contractType === "accumulator"
    ) {

        return getAccumulatorGrowth(
            trade
        );

    }


    return 0;

}


// ==========================================
// GET CURRENT TICK
// ==========================================

function getCurrentTick(
    symbol
) {

    const market =
        syntheticMarket.getMarket(
            symbol
        );

    if (
        !market
    ) {

        return null;

    }

    const tick =
        Number(
            market.tick
        );

    if (
        !Number.isInteger(
            tick
        )
    ) {

        return null;

    }

    return tick;

}


// ==========================================
// SHOULD SETTLE TICK TRADE
// ==========================================

function shouldSettleTickTrade(
    trade,
    symbol
) {

    const duration =
        getTradeDuration(
            trade
        );

    const entryTick =
        Number(
            trade.entry_tick
        );

    const currentTick =
        getCurrentTick(
            symbol
        );

    if (
        !Number.isInteger(duration) ||
        duration <= 0
    ) {

        return false;

    }

    if (
        !Number.isInteger(entryTick)
    ) {

        return false;

    }

    if (
        !Number.isInteger(currentTick)
    ) {

        return false;

    }

    return (
        currentTick >=
        entryTick + duration
    );

}


// ==========================================
// GET EXIT TICK
// ==========================================

function getExitTick(
    symbol
) {

    return getCurrentTick(
        symbol
    );

}


// ==========================================
// CREDIT LIVE WINNING PAYOUT
// ==========================================
//
// IMPORTANT BONUS ACCOUNTING RULE:
//
// wallet.balance       = real/withdrawable capital
// wallet.bonus_balance = protected promotional credit
//
// A winning trade payout is credited to the
// real wallet balance.
//
// The bonus balance is NEVER transferred into
// wallet.balance by settlement.
//
// This prevents the settlement engine from
// accidentally converting promotional credit
// into withdrawable funds.
//
// The actual ability to OPEN a live trade
// using the combined balance + bonus balance
// must be handled by the trade-opening route.
//
// ==========================================

async function creditWinningPayout(
    userId,
    payout,
    tradeId
) {

    const amount =
        Number(payout);

    if (
        !Number.isFinite(amount) ||
        amount <= 0
    ) {

        return null;

    }

    const {
        data: wallet,
        error: walletError
    } =
        await supabase
            .from("wallets")
            .select(
                "id,balance,bonus_balance,demo_balance"
            )
            .eq(
                "user_id",
                userId
            )
            .single();


    if (
        walletError ||
        !wallet
    ) {

        console.error(
            "SETTLEMENT WALLET ERROR:",
            walletError
        );

        return null;

    }


    const currentRealBalance =
        Number(
            wallet.balance || 0
        );

    const currentBonusBalance =
        Number(
            wallet.bonus_balance || 0
        );


    if (
        !Number.isFinite(
            currentRealBalance
        )
    ) {

        console.error(
            "SETTLEMENT INVALID REAL BALANCE:",
            {
                userId,
                balance: wallet.balance
            }
        );

        return null;

    }


    const newRealBalance =
        Number(
            (
                currentRealBalance +
                amount
            ).toFixed(6)
        );


    // ==========================================
    // CREDIT ONLY REAL BALANCE
    // ==========================================

    const {
        data: updatedWallet,
        error: walletUpdateError
    } =
        await supabase
            .from("wallets")
            .update({

                balance:
                    newRealBalance,

                updated_at:
                    new Date().toISOString()

            })
            .eq(
                "id",
                wallet.id
            )
            .select(
                "id,balance,bonus_balance,demo_balance"
            )
            .single();


    if (
        walletUpdateError
    ) {

        console.error(
            "SETTLEMENT WALLET CREDIT ERROR:",
            walletUpdateError
        );

        return null;

    }


    // ==========================================
    // WALLET TRANSACTION
    // ==========================================

    const {
        error:
            transactionError
    } =
        await supabase
            .from(
                "wallet_transactions"
            )
            .insert({

                user_id:
                    userId,

                wallet_id:
                    wallet.id,

                transaction_type:
                    "trade_payout",

                type:
                    "trade_payout",

                amount:
                    amount,

                status:
                    "completed",

                payment_method:
                    "wallet",

                reference:
                    "PAYOUT-" +
                    tradeId,

                reference_id:
                    tradeId,

                description:
                    "Trade payout",

                balance_before:
                    currentRealBalance,

                balance_after:
                    newRealBalance

            });


    if (
        transactionError
    ) {

        console.error(
            "SETTLEMENT TRANSACTION ERROR:",
            transactionError
        );

    }


    console.log(
        "WINNING PAYOUT CREDITED:",
        {
            userId,
            tradeId,
            payout: amount,
            realBalanceBefore:
                currentRealBalance,
            realBalanceAfter:
                newRealBalance,
            protectedBonusBalance:
                currentBonusBalance
        }
    );


    return {

        wallet:
            updatedWallet,

        realBalanceBefore:
            currentRealBalance,

        realBalanceAfter:
            newRealBalance,

        bonusBalance:
            Number(
                updatedWallet.bonus_balance || 0
            )

    };

}


// ==========================================
// CREDIT DEMO WINNING PAYOUT
// ==========================================

async function creditDemoWinningPayout(
    userId,
    payout,
    tradeId
) {

    const amount =
        Number(payout);

    if (
        !Number.isFinite(amount) ||
        amount <= 0
    ) {

        return null;

    }


    const {
        data: wallet,
        error: walletError
    } =
        await supabase
            .from("wallets")
            .select(
                "id,demo_balance"
            )
            .eq(
                "user_id",
                userId
            )
            .single();


    if (
        walletError ||
        !wallet
    ) {

        console.error(
            "DEMO SETTLEMENT WALLET ERROR:",
            walletError
        );

        return null;

    }


    const currentDemoBalance =
        Number(
            wallet.demo_balance || 0
        );


    if (
        !Number.isFinite(
            currentDemoBalance
        )
    ) {

        console.error(
            "INVALID DEMO BALANCE:",
            {
                userId,
                demoBalance:
                    wallet.demo_balance
            }
        );

        return null;

    }


    const newDemoBalance =
        Number(
            (
                currentDemoBalance +
                amount
            ).toFixed(6)
        );


    const {
        data: updatedWallet,
        error: walletUpdateError
    } =
        await supabase
            .from("wallets")
            .update({

                demo_balance:
                    newDemoBalance,

                updated_at:
                    new Date().toISOString()

            })
            .eq(
                "id",
                wallet.id
            )
            .select(
                "id,demo_balance"
            )
            .single();


    if (
        walletUpdateError
    ) {

        console.error(
            "DEMO WALLET CREDIT ERROR:",
            walletUpdateError
        );

        return null;

    }


    const {
        error:
            transactionError
    } =
        await supabase
            .from(
                "wallet_transactions"
            )
            .insert({

                user_id:
                    userId,

                wallet_id:
                    wallet.id,

                transaction_type:
                    "trade_payout",

                type:
                    "trade_payout",

                amount:
                    amount,

                status:
                    "completed",

                payment_method:
                    "wallet",

                reference:
                    "PAYOUT-" +
                    tradeId,

                reference_id:
                    tradeId,

                description:
                    "Demo trade payout",

                balance_before:
                    currentDemoBalance,

                balance_after:
                    newDemoBalance

            });


    if (
        transactionError
    ) {

        console.error(
            "DEMO SETTLEMENT TRANSACTION ERROR:",
            transactionError
        );

    }


    return {

        wallet:
            updatedWallet,

        demoBalanceBefore:
            currentDemoBalance,

        demoBalanceAfter:
            newDemoBalance

    };

}


// ==========================================
// SETTLE ONE TRADE
// ==========================================

async function settleTrade(
    trade
) {

    try {

        if (
            !trade
        ) {

            return null;

        }

        if (
            trade.status !==
            "pending"
        ) {

            return null;

        }


        const symbol =
            getSyntheticSymbol(
                trade
            );

        const durationUnit =
            getDurationUnit(
                trade
            );


        // ==========================================
        // TICK CONTRACT
        // ==========================================

        if (
            durationUnit === "t"
        ) {

            const canSettle =
                shouldSettleTickTrade(
                    trade,
                    symbol
                );

            if (
                !canSettle
            ) {

                return null;

            }

        }


        // ==========================================
        // CURRENT PRICE
        // ==========================================

        const exitPrice =
            syntheticMarket.getPrice(
                symbol
            );

        if (
            !Number.isFinite(
                Number(exitPrice)
            )
        ) {

            console.error(
                "SETTLEMENT ERROR:",
                "Invalid exit price",
                symbol
            );

            return null;

        }


        // ==========================================
        // RESULT
        // ==========================================

        const won =
            determineResult(
                trade,
                exitPrice
            );


        // ==========================================
        // STAKE
        // ==========================================

        const stake =
            Number(
                trade.stake
            );

        if (
            !Number.isFinite(stake) ||
            stake <= 0
        ) {

            console.error(
                "SETTLEMENT ERROR:",
                "Invalid stake",
                trade.id
            );

            return null;

        }


        // ==========================================
        // PAYOUT
        // ==========================================

        let payoutRate =
            getPayoutRate(
                trade
            );

        if (
            !Number.isFinite(payoutRate) ||
            payoutRate < 0
        ) {

            payoutRate = 0;

        }

        let payout = 0;


        // ==========================================
        // ACCUMULATOR
        // ==========================================

        if (
            normalizeContractType(
                trade
            ) ===
            "accumulator"
        ) {

            if (
                won
            ) {

                const growth =
                    getAccumulatorGrowth(
                        trade
                    );

                let periods = 0;


                if (
                    durationUnit === "t"
                ) {

                    const entryTick =
                        Number(
                            trade.entry_tick
                        );

                    const exitTick =
                        Number(
                            getExitTick(
                                symbol
                            )
                        );

                    if (
                        Number.isInteger(entryTick) &&
                        Number.isInteger(exitTick)
                    ) {

                        periods =
                            Math.max(
                                0,
                                exitTick -
                                entryTick
                            );

                    }

                }

                else {

                    const createdAt =
                        new Date(
                            trade.created_at
                        ).getTime();

                    periods =
                        Math.max(
                            0,
                            Math.floor(
                                (
                                    Date.now() -
                                    createdAt
                                ) / 1000
                            )
                        );

                }

                periods =
                    Math.max(
                        0,
                        Math.min(
                            periods,
                            1000
                        )
                    );

                const multiplier =
                    Math.min(
                        ACCUMULATOR_MAX_MULTIPLIER,
                        Math.pow(
                            1 + growth,
                            periods
                        )
                    );

                const rawPayout =
                    stake *
                    multiplier;

                payout =
                    Math.min(
                        ACCUMULATOR_MAX_PAYOUT,
                        rawPayout
                    );

            }

            else {

                payout = 0;

            }

        }


        // ==========================================
        // NORMAL CONTRACT
        // ==========================================

        else {

            if (
                won
            ) {

                payout =
                    stake *
                    (
                        1 +
                        payoutRate
                    );

            }

            else {

                payout = 0;

            }

        }


        // ==========================================
        // ROUND VALUES
        // ==========================================

        payout =
            Number(
                payout.toFixed(6)
            );

        const profit =
            Number(
                (
                    payout -
                    stake
                ).toFixed(6)
            );


        // ==========================================
        // EXIT TICK
        // ==========================================

        let exitTick = null;

        if (
            durationUnit === "t"
        ) {

            exitTick =
                getExitTick(
                    symbol
                );

        }


        // ==========================================
        // UPDATE TRADE
        // ==========================================

        const updateData = {

            status:
                won
                    ? "won"
                    : "lost",

            exit_price:
                Number(
                    exitPrice
                ),

            payout:
                payout,

            profit:
                profit,

            settled_at:
                new Date().toISOString()

        };

        if (
            exitTick !== null
        ) {

            updateData.exit_tick =
                exitTick;

        }


        // ==========================================
        // ATOMIC SETTLEMENT UPDATE
        // ==========================================

        const {
            data: updatedTrade,
            error: tradeUpdateError
        } =
            await supabase
                .from("trades")
                .update(
                    updateData
                )
                .eq(
                    "id",
                    trade.id
                )
                .eq(
                    "status",
                    "pending"
                )
                .select()
                .maybeSingle();


        if (
            tradeUpdateError
        ) {

            console.error(
                "TRADE SETTLEMENT UPDATE ERROR:",
                tradeUpdateError
            );

            return null;

        }


        if (
            !updatedTrade
        ) {

            console.log(
                "TRADE ALREADY SETTLED:",
                trade.id
            );

            return null;

        }


        // ==========================================
        // CREDIT WINNING PAYOUT
        // ==========================================
        //
        // IMPORTANT:
        //
        // Demo:
        //     payout -> demo_balance
        //
        // Live:
        //     payout -> balance
        //
        // bonus_balance:
        //     remains protected
        //     is NOT credited as cash
        //     is NOT removed here
        //
        // This keeps promotional credit separate
        // from the normal cash balance.
        //
        // ==========================================

        if (
            won &&
            payout > 0
        ) {

            const userId =
                trade.user_id;

            const mode =
                String(
                    trade.mode ||
                    "demo"
                )
                .trim()
                .toLowerCase();


            if (
                mode === "real" ||
                mode === "live"
            ) {

                await creditWinningPayout(
                    userId,
                    payout,
                    trade.id
                );

            }

            else {

                await creditDemoWinningPayout(
                    userId,
                    payout,
                    trade.id
                );

            }

        }


        // ==========================================
        // LOG
        // ==========================================

        console.log(
            "TRADE SETTLED:",
            {

                id:
                    trade.id,

                symbol:
                    symbol,

                contract:
                    normalizeContractType(
                        trade
                    ),

                action:
                    normalizeAction(
                        trade
                    ),

                mode:
                    trade.mode,

                duration:
                    getTradeDuration(
                        trade
                    ),

                durationUnit:
                    durationUnit,

                entryTick:
                    trade.entry_tick,

                exitTick:
                    exitTick,

                entryPrice:
                    trade.entry_price,

                exitPrice:
                    exitPrice,

                result:
                    won
                        ? "WON"
                        : "LOST",

                stake:
                    stake,

                payout:
                    payout,

                profit:
                    profit

            }
        );


        return updatedTrade;

    }

    catch (error) {

        console.error(
            "SETTLE TRADE EXCEPTION:",
            error
        );

        return null;

    }

}


// ==========================================
// MONITOR TOUCH BARRIERS
// ==========================================

async function monitorTouchTrades() {

    try {

        const {
            data: trades,
            error
        } =
            await supabase
                .from("trades")
                .select("*")
                .eq(
                    "status",
                    "pending"
                )
                .eq(
                    "contract_type",
                    "touch_no_touch"
                );


        if (
            error
        ) {

            console.error(
                "TOUCH MONITOR ERROR:",
                error
            );

            return;

        }


        if (
            !trades ||
            trades.length === 0
        ) {

            return;

        }


        for (
            const trade of trades
        ) {

            const symbol =
                getSyntheticSymbol(
                    trade
                );

            const barrier =
                Number(
                    trade.target_price ||
                    trade.barrier_price
                );

            const direction =
                String(
                    trade.barrier_direction ||
                    ""
                )
                .trim()
                .toLowerCase();


            if (
                !Number.isFinite(
                    barrier
                )
            ) {

                continue;

            }


            const entryTime =
                new Date(
                    trade.created_at
                ).getTime();


            const touched =
                syntheticMarket.checkBarrier(
                    symbol,
                    barrier,
                    direction,
                    entryTime
                );


            if (
                !touched
            ) {

                continue;

            }


            const {
                data: updatedTrade,
                error:
                    updateError
            } =
                await supabase
                    .from("trades")
                    .update({

                        barrier_touched:
                            true

                    })
                    .eq(
                        "id",
                        trade.id
                    )
                    .eq(
                        "status",
                        "pending"
                    )
                    .select()
                    .maybeSingle();


            if (
                updateError
            ) {

                console.error(
                    "TOUCH UPDATE ERROR:",
                    updateError
                );

                continue;

            }


            if (
                updatedTrade
            ) {

                console.log(
                    "TOUCH BARRIER HIT:",
                    trade.id,
                    symbol,
                    barrier
                );

            }

        }

    }

    catch (error) {

        console.error(
            "TOUCH MONITOR EXCEPTION:",
            error
        );

    }

}


// ==========================================
// MONITOR ACTIVE ACCUMULATORS
// ==========================================
//
// Accumulator behaviour:
//
// Entry price
//      |
//      |---- upper boundary
//      |
//   RUNNING
//      |
//      |---- lower boundary
//
// Touching either boundary immediately
// changes the trade to LOST.
//
// ==========================================

async function monitorActiveAccumulators() {

    try {

        const {
            data: trades,
            error
        } =
            await supabase
                .from("trades")
                .select("*")
                .eq(
                    "status",
                    "pending"
                )
                .eq(
                    "contract_type",
                    "accumulator"
                );


        if (
            error
        ) {

            console.error(
                "ACCUMULATOR MONITOR ERROR:",
                error
            );

            return;

        }


        if (
            !trades ||
            trades.length === 0
        ) {

            return;

        }


        for (
            const trade of trades
        ) {

            const symbol =
                getSyntheticSymbol(
                    trade
                );


            const currentPrice =
                syntheticMarket.getPrice(
                    symbol
                );


            const entryPrice =
                Number(
                    trade.entry_price
                );


            if (
                !Number.isFinite(
                    currentPrice
                ) ||
                !Number.isFinite(
                    entryPrice
                ) ||
                entryPrice <= 0
            ) {

                continue;

            }


            // ==========================================
            // BOTH ACCUMULATOR BOUNDARIES
            // ==========================================

            const boundaryResult =
                accumulatorBoundariesHit(
                    currentPrice,
                    entryPrice
                );


            if (
                !boundaryResult.hit
            ) {

                continue;

            }


            // ==========================================
            // KNOCKOUT
            // ==========================================

            const {
                data: updatedTrade,
                error:
                    updateError
            } =
                await supabase
                    .from("trades")
                    .update({

                        status:
                            "lost",

                        exit_price:
                            currentPrice,

                        payout:
                            0,

                        profit:
                            Number(
                                (
                                    -Number(
                                        trade.stake
                                    )
                                ).toFixed(6)
                            ),

                        accumulator_broken:
                            true,

                        settled_at:
                            new Date().toISOString()

                    })
                    .eq(
                        "id",
                        trade.id
                    )
                    .eq(
                        "status",
                        "pending"
                    )
                    .select()
                    .maybeSingle();


            if (
                updateError
            ) {

                console.error(
                    "ACCUMULATOR KNOCKOUT ERROR:",
                    updateError
                );

                continue;

            }


            if (
                updatedTrade
            ) {

                console.log(
                    "ACCUMULATOR KNOCKOUT:",
                    {

                        id:
                            trade.id,

                        symbol:
                            symbol,

                        entryPrice:
                            entryPrice,

                        price:
                            currentPrice,

                        lowerBoundary:
                            boundaryResult.lower,

                        upperBoundary:
                            boundaryResult.upper,

                        hitSide:
                            boundaryResult.side

                    }
                );

            }

        }

    }

    catch (error) {

        console.error(
            "ACCUMULATOR MONITOR EXCEPTION:",
            error
        );

    }

}


// ==========================================
// SETTLE EXPIRED SECOND TRADES
// ==========================================

async function settleExpiredTrades() {

    try {

        const now =
            new Date().toISOString();


        const {
            data: trades,
            error
        } =
            await supabase
                .from("trades")
                .select("*")
                .eq(
                    "status",
                    "pending"
                )
                .eq(
                    "duration_unit",
                    "s"
                )
                .lte(
                    "expires_at",
                    now
                );


        if (
            error
        ) {

            console.error(
                "EXPIRED TRADES ERROR:",
                error
            );

            return;

        }


        if (
            !trades ||
            trades.length === 0
        ) {

            return;

        }


        for (
            const trade of trades
        ) {

            await settleTrade(
                trade
            );

        }

    }

    catch (error) {

        console.error(
            "SETTLE EXPIRED EXCEPTION:",
            error
        );

    }

}


// ==========================================
// SETTLE EXPIRED TICK TRADES
// ==========================================

async function settleTickTrades() {

    try {

        const {
            data: trades,
            error
        } =
            await supabase
                .from("trades")
                .select("*")
                .eq(
                    "status",
                    "pending"
                )
                .eq(
                    "duration_unit",
                    "t"
                );


        if (
            error
        ) {

            console.error(
                "TICK TRADES QUERY ERROR:",
                error
            );

            return;

        }


        if (
            !trades ||
            trades.length === 0
        ) {

            return;

        }


        for (
            const trade of trades
        ) {

            const symbol =
                getSyntheticSymbol(
                    trade
                );


            if (
                shouldSettleTickTrade(
                    trade,
                    symbol
                )
            ) {

                await settleTrade(
                    trade
                );

            }

        }

    }

    catch (error) {

        console.error(
            "SETTLE TICK TRADES EXCEPTION:",
            error
        );

    }

}


// ==========================================
// MASTER SETTLEMENT LOOP
// ==========================================

async function runSettlementCycle() {

    await settleExpiredTrades();

    await settleTickTrades();

    await monitorTouchTrades();

    await monitorActiveAccumulators();

}


// ==========================================
// EXPORTS
// ==========================================

module.exports = {

    settleTrade,

    settleExpiredTrades,

    settleTickTrades,

    monitorTouchTrades,

    monitorActiveAccumulators,

    runSettlementCycle,

    getLastDigit,

    determineResult,

    getPayoutRate,

    getSyntheticSymbol,

    getComparisonPayoutRate,

    getDigitPayoutRate,

    getOddEvenPayoutRate,

    getRiseFallPayoutRate,

    getTouchPayoutRate,

    getAccumulatorGrowth,

    calculateAccumulatorBarrier,

    calculateAccumulatorBoundaries,

    accumulatorBarrierHit,

    accumulatorBoundariesHit

};