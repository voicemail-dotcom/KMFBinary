
"use strict";

// ==========================================
// KMFBINARY SETTLEMENT ENGINE
// Neon database + existing synthetic markets
// ==========================================

const db = require("./db");
const syntheticMarket = require("./synthetic-market");

// ==========================================
// CONFIGURATION
// ==========================================

const ACCUMULATOR_MAX_PAYOUT =
    Number(process.env.ACCUMULATOR_MAX_PAYOUT || 10000);

const ACCUMULATOR_KNOCKOUT_PERCENT =
    Number(process.env.ACCUMULATOR_KNOCKOUT_PERCENT || 0.02);

const ACCUMULATOR_MAX_MULTIPLIER =
    Number(process.env.ACCUMULATOR_MAX_MULTIPLIER || 100);

const TOUCH_BARRIER_DISTANCE =
    Number(process.env.TOUCH_BARRIER_DISTANCE || 2);

const ACCUMULATOR_GROWTH_OPTIONS = [
    0.01, 0.02, 0.03, 0.04, 0.05
];

console.log("KMFBINARY settlement module loaded.");

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
        map[String(trade.symbol || "").trim()] ||
        "KMF-15"
    );
}

// ==========================================
// LAST DIGIT
// ==========================================

function getLastDigit(price) {
    const number = Number(price);

    if (!Number.isFinite(number)) {
        return null;
    }

    return Math.abs(Math.floor(number * 100)) % 10;
}

function isValidDigit(digit) {
    return (
        Number.isInteger(Number(digit)) &&
        Number(digit) >= 0 &&
        Number(digit) <= 9
    );
}

function isTrue(value) {
    return (
        value === true ||
        value === "true" ||
        value === 1 ||
        value === "1"
    );
}

// ==========================================
// NORMALIZERS
// ==========================================

function normalizeContractType(trade) {
    return String(trade.contract_type || "")
        .trim()
        .toLowerCase();
}

function normalizeAction(trade) {
    return String(trade.action || "")
        .trim()
        .toLowerCase();
}

function getDurationUnit(trade) {
    const unit = String(trade.duration_unit || "")
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

function getTradeDuration(trade) {
    const duration = Number(trade.duration);

    if (
        Number.isInteger(duration) &&
        duration > 0
    ) {
        return duration;
    }

    const expirySeconds = Number(trade.expiry_seconds);

    if (
        Number.isInteger(expirySeconds) &&
        expirySeconds > 0
    ) {
        return expirySeconds;
    }

    return null;
}

// ==========================================
// PAYOUT CALCULATIONS
// ==========================================

function getComparisonPayoutRate(action, targetDigit) {
    const target = Number(targetDigit);

    if (!isValidDigit(target)) {
        return 0;
    }

    const normalizedAction = String(action || "")
        .trim()
        .toLowerCase();

    let winningDigits = 0;

    if (
        normalizedAction === "higher" ||
        normalizedAction === "over"
    ) {
        winningDigits = 9 - target;
    } else if (
        normalizedAction === "lower" ||
        normalizedAction === "under"
    ) {
        winningDigits = target;
    }

    if (winningDigits <= 0) {
        return 0;
    }

    return (10 / winningDigits) - 1;
}

function getDigitPayoutRate(action) {
    const normalizedAction = String(action || "")
        .trim()
        .toLowerCase();

    if (normalizedAction === "matches") {
        return 9;
    }

    if (normalizedAction === "differs") {
        return (10 / 9) - 1;
    }

    return 0;
}

function getOddEvenPayoutRate() {
    return 0.95;
}

function getRiseFallPayoutRate() {
    return 0.90;
}

function getTouchPayoutRate() {
    return 0.80;
}

// ==========================================
// ACCUMULATOR GROWTH AND BOUNDARIES
// ==========================================

function getAccumulatorGrowth(trade) {
    const growth = Number(trade.accumulator_growth);

    if (ACCUMULATOR_GROWTH_OPTIONS.includes(growth)) {
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

function calculateAccumulatorBoundaries(entryPrice) {
    const price = Number(entryPrice);

    if (!Number.isFinite(price) || price <= 0) {
        throw new Error("Invalid accumulator entry price");
    }

    const distance = price * ACCUMULATOR_KNOCKOUT_PERCENT;

    return {
        entryPrice: Number(price.toFixed(2)),
        lowerBoundary: Number((price - distance).toFixed(2)),
        upperBoundary: Number((price + distance).toFixed(2))
    };
}

function accumulatorBarrierHit(price, barrier, direction) {
    const currentPrice = Number(price);
    const knockout = Number(barrier);

    const normalizedDirection = String(direction || "")
        .trim()
        .toLowerCase();

    if (
        !Number.isFinite(currentPrice) ||
        !Number.isFinite(knockout)
    ) {
        return false;
    }

    if (normalizedDirection === "above") {
        return currentPrice <= knockout;
    }

    if (normalizedDirection === "below") {
        return currentPrice >= knockout;
    }

    return false;
}

function accumulatorBoundariesHit(price, entryPrice) {
    const currentPrice = Number(price);
    const boundaries = calculateAccumulatorBoundaries(entryPrice);

    if (!Number.isFinite(currentPrice) || !boundaries) {
        return {
            hit: false,
            side: null,
            lower: null,
            upper: null
        };
    }

    const lowerHit = currentPrice <= boundaries.lowerBoundary;
    const upperHit = currentPrice >= boundaries.upperBoundary;

    if (lowerHit && upperHit) {
        return {
            hit: true,
            side: "both",
            lower: boundaries.lowerBoundary,
            upper: boundaries.upperBoundary
        };
    }

    if (lowerHit) {
        return {
            hit: true,
            side: "lower",
            lower: boundaries.lowerBoundary,
            upper: boundaries.upperBoundary
        };
    }

    if (upperHit) {
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

function calculateAccumulatorBarrier(entryPrice, direction) {
    const price = Number(entryPrice);

    if (!Number.isFinite(price)) {
        return null;
    }

    const normalizedDirection = String(direction || "")
        .trim()
        .toLowerCase();

    const boundaries = calculateAccumulatorBoundaries(price);

    if (normalizedDirection === "above") {
        return boundaries.lowerBoundary;
    }

    if (normalizedDirection === "below") {
        return boundaries.upperBoundary;
    }

    return null;
}

// ==========================================
// DETERMINE TRADE RESULT
// ==========================================

function determineResult(trade, exitPrice) {
    const contractType = normalizeContractType(trade);
    const action = normalizeAction(trade);
    const entryPrice = Number(trade.entry_price);
    const finalPrice = Number(exitPrice);

    if (!Number.isFinite(finalPrice)) {
        return false;
    }

    if (contractType === "rise_fall") {
        if (!Number.isFinite(entryPrice)) {
            return false;
        }

        if (action === "rise") {
            return finalPrice > entryPrice;
        }

        if (action === "fall") {
            return finalPrice < entryPrice;
        }

        return false;
    }

    if (contractType === "higher_lower") {
        const barrier = Number(trade.target_price);

        if (!Number.isFinite(barrier) || barrier <= 0) {
            return false;
        }

        if (action === "higher") {
            return finalPrice > barrier;
        }

        if (action === "lower") {
            return finalPrice < barrier;
        }

        return false;
    }

    if (contractType === "over_under") {
        const digit = getLastDigit(finalPrice);
        const target = Number(trade.target_digit);

        if (digit === null || !isValidDigit(target)) {
            return false;
        }

        if (action === "over") {
            return digit > target;
        }

        if (action === "under") {
            return digit < target;
        }

        return false;
    }

    if (contractType === "odd_even") {
        const digit = getLastDigit(finalPrice);

        if (digit === null) {
            return false;
        }

        if (action === "even") {
            return digit % 2 === 0;
        }

        if (action === "odd") {
            return digit % 2 !== 0;
        }

        return false;
    }

    if (
        contractType === "matches" ||
        contractType === "differs"
    ) {
        const digit = getLastDigit(finalPrice);
        const target = Number(trade.target_digit);

        if (digit === null || !isValidDigit(target)) {
            return false;
        }

        if (contractType === "matches") {
            return digit === target;
        }

        return digit !== target;
    }

    if (contractType === "touch_no_touch") {
        const touched = isTrue(trade.barrier_touched);

        if (action === "touch") {
            return touched;
        }

        if (action === "no_touch") {
            return !touched;
        }

        return false;
    }

    if (contractType === "accumulator") {
        return !isTrue(trade.accumulator_broken);
    }

    return false;
}

// ==========================================
// GET PAYOUT RATE
// ==========================================

function getPayoutRate(trade) {
    const contractType = normalizeContractType(trade);
    const action = normalizeAction(trade);

    if (
        contractType === "matches" ||
        contractType === "differs"
    ) {
        return getDigitPayoutRate(contractType);
    }

    if (contractType === "rise_fall") {
        return getRiseFallPayoutRate();
    }

    if (contractType === "higher_lower") {
        return Number(trade.payout_rate) > 0
            ? Number(trade.payout_rate)
            : 0.90;
    }

    if (contractType === "over_under") {
        return getComparisonPayoutRate(action, trade.target_digit);
    }

    if (contractType === "odd_even") {
        return getOddEvenPayoutRate();
    }

    if (contractType === "touch_no_touch") {
        return getTouchPayoutRate();
    }

    if (contractType === "accumulator") {
        return getAccumulatorGrowth(trade);
    }

    return 0;
}

// ==========================================
// TICK HELPERS
// ==========================================

function getCurrentTick(symbol) {
    const market = syntheticMarket.getMarket(symbol);

    if (!market) {
        return null;
    }

    const tick = Number(market.tick);

    if (!Number.isInteger(tick)) {
        return null;
    }

    return tick;
}

function shouldSettleTickTrade(trade, symbol) {
    const duration = getTradeDuration(trade);
    const entryTick = Number(trade.entry_tick);
    const currentTick = getCurrentTick(symbol);

    if (
        !Number.isInteger(duration) ||
        duration <= 0 ||
        !Number.isInteger(entryTick) ||
        !Number.isInteger(currentTick)
    ) {
        return false;
    }

    return currentTick >= entryTick + duration;
}

function getExitTick(symbol) {
    return getCurrentTick(symbol);
}

// ==========================================
// CREDIT LIVE WINNING PAYOUT
// ==========================================
//
// balance       = real/withdrawable capital
// bonus_balance = protected promotional credit
//
// Only real balance is credited here.
// ==========================================

async function creditWinningPayout(userId, payout, tradeId) {
    const amount = Number(payout);

    if (!Number.isFinite(amount) || amount <= 0) {
        return null;
    }

    const client = await db.pool.connect();

    try {
        await client.query("BEGIN");

        const walletResult = await client.query(
            `SELECT id, balance, bonus_balance, demo_balance
             FROM wallets
             WHERE user_id = $1
             FOR UPDATE`,
            [userId]
        );

        const wallet = walletResult.rows[0];

        if (!wallet) {
            await client.query("ROLLBACK");
            console.error("SETTLEMENT WALLET NOT FOUND:", userId);
            return null;
        }

        const currentRealBalance = Number(wallet.balance || 0);
        const currentBonusBalance = Number(wallet.bonus_balance || 0);

        if (!Number.isFinite(currentRealBalance)) {
            await client.query("ROLLBACK");

            console.error("SETTLEMENT INVALID REAL BALANCE:", {
                userId,
                balance: wallet.balance
            });

            return null;
        }

        const newRealBalance = Number(
            (currentRealBalance + amount).toFixed(6)
        );

        const updatedResult = await client.query(
            `UPDATE wallets
             SET balance = $1,
                 updated_at = NOW()
             WHERE id = $2
             RETURNING id, balance, bonus_balance, demo_balance`,
            [newRealBalance, wallet.id]
        );

        const updatedWallet = updatedResult.rows[0];

        await client.query(
            `INSERT INTO wallet_transactions (
                user_id,
                wallet_id,
                transaction_type,
                type,
                amount,
                status,
                payment_method,
                reference,
                reference_id,
                description,
                balance_before,
                balance_after
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
                userId,
                wallet.id,
                "trade_payout",
                "trade_payout",
                amount,
                "completed",
                "wallet",
                "PAYOUT-" + tradeId,
                tradeId,
                "Trade payout",
                currentRealBalance,
                newRealBalance
            ]
        );

        await client.query("COMMIT");

        console.log("WINNING PAYOUT CREDITED:", {
            userId,
            tradeId,
            payout: amount,
            realBalanceBefore: currentRealBalance,
            realBalanceAfter: newRealBalance,
            protectedBonusBalance: currentBonusBalance
        });

        return {
            wallet: updatedWallet,
            realBalanceBefore: currentRealBalance,
            realBalanceAfter: newRealBalance,
            bonusBalance: Number(updatedWallet.bonus_balance || 0)
        };
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("SETTLEMENT WALLET CREDIT ERROR:", error);
        return null;
    } finally {
        client.release();
    }
}

// ==========================================
// CREDIT DEMO WINNING PAYOUT
// ==========================================

async function creditDemoWinningPayout(userId, payout, tradeId) {
    const amount = Number(payout);

    if (!Number.isFinite(amount) || amount <= 0) {
        return null;
    }

    const client = await db.pool.connect();

    try {
        await client.query("BEGIN");

        const walletResult = await client.query(
            `SELECT id, demo_balance
             FROM wallets
             WHERE user_id = $1
             FOR UPDATE`,
            [userId]
        );

        const wallet = walletResult.rows[0];

        if (!wallet) {
            await client.query("ROLLBACK");
            console.error("DEMO SETTLEMENT WALLET NOT FOUND:", userId);
            return null;
        }

        const currentDemoBalance = Number(wallet.demo_balance || 0);

        if (!Number.isFinite(currentDemoBalance)) {
            await client.query("ROLLBACK");

            console.error("INVALID DEMO BALANCE:", {
                userId,
                demoBalance: wallet.demo_balance
            });

            return null;
        }

        const newDemoBalance = Number(
            (currentDemoBalance + amount).toFixed(6)
        );

        const updatedResult = await client.query(
            `UPDATE wallets
             SET demo_balance = $1,
                 updated_at = NOW()
             WHERE id = $2
             RETURNING id, demo_balance`,
            [newDemoBalance, wallet.id]
        );

        const updatedWallet = updatedResult.rows[0];

        await client.query(
            `INSERT INTO wallet_transactions (
                user_id,
                wallet_id,
                transaction_type,
                type,
                amount,
                status,
                payment_method,
                reference,
                reference_id,
                description,
                balance_before,
                balance_after
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
                userId,
                wallet.id,
                "trade_payout",
                "trade_payout",
                amount,
                "completed",
                "wallet",
                "PAYOUT-" + tradeId,
                tradeId,
                "Demo trade payout",
                currentDemoBalance,
                newDemoBalance
            ]
        );

        await client.query("COMMIT");

        return {
            wallet: updatedWallet,
            demoBalanceBefore: currentDemoBalance,
            demoBalanceAfter: newDemoBalance
        };
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("DEMO WALLET CREDIT ERROR:", error);
        return null;
    } finally {
        client.release();
    }
}

// ==========================================
// SETTLE ONE TRADE
// ==========================================

async function settleTrade(trade) {
    try {
        if (!trade || trade.status !== "pending") {
            return null;
        }

        const symbol = getSyntheticSymbol(trade);
        const durationUnit = getDurationUnit(trade);

        if (
            durationUnit === "t" &&
            !shouldSettleTickTrade(trade, symbol)
        ) {
            return null;
        }

        const exitPrice = syntheticMarket.getPrice(symbol);

        if (!Number.isFinite(Number(exitPrice))) {
            console.error("SETTLEMENT ERROR: Invalid exit price", symbol);
            return null;
        }

        // Verify touch/no-touch barrier.
        if (
            normalizeContractType(trade) === "touch_no_touch" &&
            !isTrue(trade.barrier_touched)
        ) {
            const barrier = Number(trade.target_price);

            const direction = String(trade.barrier_direction || "")
                .trim()
                .toLowerCase();

            const entryTime = new Date(trade.created_at).getTime();
            const expiryTime = new Date(trade.expires_at).getTime();

            if (
                !Number.isFinite(barrier) ||
                barrier <= 0 ||
                !Number.isFinite(entryTime) ||
                !Number.isFinite(expiryTime) ||
                expiryTime < entryTime ||
                (direction !== "above" && direction !== "below")
            ) {
                console.error("TOUCH VERIFICATION ERROR:", trade.id, {
                    target_price: trade.target_price,
                    barrier_direction: trade.barrier_direction,
                    created_at: trade.created_at,
                    expires_at: trade.expires_at,
                    barrier,
                    entryTime,
                    expiryTime
                });

                return null;
            }

            const touched = syntheticMarket.checkBarrier(
                symbol,
                barrier,
                direction,
                entryTime,
                expiryTime
            );

            if (touched) {
                let updatedTouch;

                try {
                    const result = await db.query(
                        `UPDATE trades
                         SET barrier_touched = TRUE,
                             barrier_touched_at = NOW()
                         WHERE id = $1
                           AND status = 'pending'
                         RETURNING id`,
                        [trade.id]
                    );

                    updatedTouch = result.rows[0] || null;
                } catch (touchError) {
                    console.error(
                        "TOUCH VERIFICATION ERROR:",
                        trade.id,
                        touchError
                    );

                    return null;
                }

                if (!updatedTouch) {
                    return null;
                }

                trade.barrier_touched = true;

                console.log(
                    "TOUCH EXPIRY VERIFIED:",
                    trade.id,
                    direction,
                    barrier
                );
            }
        }

        const won = determineResult(trade, exitPrice);
        const stake = Number(trade.stake);

        if (!Number.isFinite(stake) || stake <= 0) {
            console.error("SETTLEMENT ERROR: Invalid stake", trade.id);
            return null;
        }

        let payoutRate = getPayoutRate(trade);

        if (!Number.isFinite(payoutRate) || payoutRate < 0) {
            payoutRate = 0;
        }

        let payout = 0;

        if (normalizeContractType(trade) === "accumulator") {
            if (won) {
                const growth = getAccumulatorGrowth(trade);
                let periods = 0;

                if (durationUnit === "t") {
                    const entryTick = Number(trade.entry_tick);
                    const exitTick = Number(getExitTick(symbol));

                    if (
                        Number.isInteger(entryTick) &&
                        Number.isInteger(exitTick)
                    ) {
                        periods = Math.max(0, exitTick - entryTick);
                    }
                } else {
                    const createdAt = new Date(trade.created_at).getTime();

                    periods = Math.max(
                        0,
                        Math.floor((Date.now() - createdAt) / 1000)
                    );
                }

                periods = Math.max(0, Math.min(periods, 1000));

                const multiplier = Math.min(
                    ACCUMULATOR_MAX_MULTIPLIER,
                    Math.pow(1 + growth, periods)
                );

                payout = Math.min(
                    ACCUMULATOR_MAX_PAYOUT,
                    stake * multiplier
                );
            }
        } else if (won) {
            payout = stake * (1 + payoutRate);
        }

        payout = Number(payout.toFixed(6));

        const profit = Number((payout - stake).toFixed(6));

        let exitTick = null;

        if (durationUnit === "t") {
            exitTick = getExitTick(symbol);
        }

        // Conditional update prevents settling a pending trade twice.
        let updatedTrade;

        try {
            const result = await db.query(
                `UPDATE trades
                 SET status = $1,
                     exit_price = $2,
                     payout = $3,
                     profit = $4,
                     settled_at = NOW(),
                     exit_tick = COALESCE($5, exit_tick)
                 WHERE id = $6
                   AND status = 'pending'
                 RETURNING *`,
                [
                    won ? "won" : "lost",
                    Number(exitPrice),
                    payout,
                    profit,
                    exitTick,
                    trade.id
                ]
            );

            updatedTrade = result.rows[0] || null;
        } catch (error) {
            console.error("TRADE SETTLEMENT UPDATE ERROR:", error);
            return null;
        }

        if (!updatedTrade) {
            console.log("TRADE ALREADY SETTLED:", trade.id);
            return null;
        }

        // Preserve live/demo accounting rules.
        if (won && payout > 0) {
            const userId = trade.user_id;

            const mode = String(trade.mode || "demo")
                .trim()
                .toLowerCase();

            if (mode === "real" || mode === "live") {
                await creditWinningPayout(userId, payout, trade.id);
            } else {
                await creditDemoWinningPayout(userId, payout, trade.id);
            }
        }

        console.log("TRADE SETTLED:", {
            id: trade.id,
            symbol,
            contract: normalizeContractType(trade),
            action: normalizeAction(trade),
            mode: trade.mode,
            duration: getTradeDuration(trade),
            durationUnit,
            entryTick: trade.entry_tick,
            exitTick,
            entryPrice: trade.entry_price,
            exitPrice,
            result: won ? "WON" : "LOST",
            stake,
            payout,
            profit
        });

        return updatedTrade;
    } catch (error) {
        console.error("SETTLE TRADE EXCEPTION:", error);
        return null;
    }
}

// ==========================================
// MONITOR TOUCH TRADES
// ==========================================

async function monitorTouchTrades() {
    try {
        let trades;

        try {
            const result = await db.query(
                `SELECT
                    id, symbol, target_price, barrier_direction,
                    barrier_touched, created_at, expires_at
                 FROM trades
                 WHERE status = $1
                   AND contract_type = $2
                   AND barrier_touched = FALSE`,
                ["pending", "touch_no_touch"]
            );

            trades = result.rows;
        } catch (error) {
            console.error("TOUCH MONITOR ERROR:", error);
            return;
        }

        if (!trades || trades.length === 0) {
            return;
        }

        for (const trade of trades) {
            const barrier = Number(trade.target_price);

            if (
                trade.target_price === null ||
                trade.target_price === undefined ||
                String(trade.target_price).trim() === "" ||
                !Number.isFinite(barrier) ||
                barrier <= 0
            ) {
                console.error("TOUCH MONITOR: Invalid barrier", trade.id);
                continue;
            }

            const direction = String(trade.barrier_direction || "")
                .trim()
                .toLowerCase();

            if (direction !== "above" && direction !== "below") {
                console.error(
                    "TOUCH MONITOR: Invalid direction",
                    trade.id,
                    direction
                );

                continue;
            }

            const entryTime = new Date(trade.created_at).getTime();
            const expiryTime = new Date(trade.expires_at).getTime();

            if (
                !Number.isFinite(entryTime) ||
                !Number.isFinite(expiryTime) ||
                expiryTime < entryTime
            ) {
                console.error(
                    "TOUCH MONITOR: Invalid trade timing",
                    trade.id
                );

                continue;
            }

            const symbol = getSyntheticSymbol(trade);

            const touched = syntheticMarket.checkBarrier(
                symbol,
                barrier,
                direction,
                entryTime,
                expiryTime
            );

            if (!touched) {
                continue;
            }

            let updatedTrade;

            try {
                const result = await db.query(
                    `UPDATE trades
                     SET barrier_touched = TRUE,
                         barrier_touched_at = NOW()
                     WHERE id = $1
                       AND status = $2
                       AND barrier_touched = FALSE
                     RETURNING id`,
                    [trade.id, "pending"]
                );

                updatedTrade = result.rows[0] || null;
            } catch (updateError) {
                console.error(
                    "TOUCH UPDATE ERROR:",
                    trade.id,
                    updateError
                );

                continue;
            }

            if (updatedTrade) {
                console.log(
                    "TOUCH BARRIER HIT:",
                    trade.id,
                    symbol,
                    direction,
                    barrier
                );
            }
        }
    } catch (error) {
        console.error("TOUCH MONITOR EXCEPTION:", error);
    }
}

// ==========================================
// MONITOR ACTIVE ACCUMULATORS
// ==========================================

async function monitorActiveAccumulators() {
    try {
        let trades;

        try {
            const result = await db.query(
                `SELECT id, symbol, entry_price, stake
                 FROM trades
                 WHERE status = $1
                   AND contract_type = $2`,
                ["pending", "accumulator"]
            );

            trades = result.rows;
        } catch (error) {
            console.error("ACCUMULATOR MONITOR ERROR:", error);
            return;
        }

        if (!trades || trades.length === 0) {
            return;
        }

        for (const trade of trades) {
            const symbol = getSyntheticSymbol(trade);
            const currentPrice = syntheticMarket.getPrice(symbol);
            const entryPrice = Number(trade.entry_price);

            if (
                !Number.isFinite(currentPrice) ||
                !Number.isFinite(entryPrice) ||
                entryPrice <= 0
            ) {
                continue;
            }

            const boundaryResult = accumulatorBoundariesHit(
                currentPrice,
                entryPrice
            );

            if (!boundaryResult.hit) {
                continue;
            }

            let updatedTrade;

            try {
                const result = await db.query(
                    `UPDATE trades
                     SET status = $1,
                         exit_price = $2,
                         payout = 0,
                         profit = $3,
                         accumulator_broken = TRUE,
                         settled_at = NOW()
                     WHERE id = $4
                       AND status = $5
                     RETURNING id`,
                    [
                        "lost",
                        currentPrice,
                        Number((-Number(trade.stake)).toFixed(6)),
                        trade.id,
                        "pending"
                    ]
                );

                updatedTrade = result.rows[0] || null;
            } catch (updateError) {
                console.error("ACCUMULATOR KNOCKOUT ERROR:", updateError);
                continue;
            }

            if (updatedTrade) {
                console.log("ACCUMULATOR KNOCKOUT:", {
                    id: trade.id,
                    symbol,
                    entryPrice,
                    price: currentPrice,
                    lowerBoundary: boundaryResult.lower,
                    upperBoundary: boundaryResult.upper,
                    hitSide: boundaryResult.side
                });
            }
        }
    } catch (error) {
        console.error("ACCUMULATOR MONITOR EXCEPTION:", error);
    }
}

// ==========================================
// SETTLE EXPIRED SECOND-BASED TRADES
// ==========================================

async function settleExpiredTrades() {
    try {
        const now = new Date().toISOString();

        let trades;

        try {
            const result = await db.query(
                `SELECT
                    id, status, symbol, contract_type, action,
                    entry_price, target_price, target_digit,
                    barrier_touched, barrier_touched_at,
                    barrier_direction, accumulator_broken,
                    accumulator_growth, accumulator_barrier,
                    accumulator_direction, accumulator_current_rate,
                    accumulator_lower_boundary, accumulator_upper_boundary,
                    stake, duration, duration_unit, expiry_seconds,
                    entry_tick, expiry_tick, created_at, expires_at,
                    mode, user_id
                 FROM trades
                 WHERE status = $1
                   AND duration_unit = $2
                   AND expires_at <= $3`,
                ["pending", "s", now]
            );

            trades = result.rows;
        } catch (error) {
            console.error("EXPIRED TRADES ERROR:", error);
            return;
        }

        if (!trades || trades.length === 0) {
            return;
        }

        for (const trade of trades) {
            await settleTrade(trade);
        }
    } catch (error) {
        console.error("SETTLE EXPIRED EXCEPTION:", error);
    }
}

// ==========================================
// SETTLE TICK-BASED TRADES â€” NEON
// ==========================================

async function settleTickTrades() {
    try {
        let trades;

        try {
            const result = await db.query(
                `SELECT
                    id, status, symbol, contract_type, action,
                    entry_price, target_price, target_digit,
                    barrier_touched, barrier_touched_at,
                    barrier_direction, accumulator_broken,
                    accumulator_growth, accumulator_barrier,
                    accumulator_direction, accumulator_current_rate,
                    accumulator_lower_boundary, accumulator_upper_boundary,
                    stake, duration, duration_unit, expiry_seconds,
                    entry_tick, expiry_tick, created_at, expires_at,
                    mode, user_id
                 FROM trades
                 WHERE status = $1
                   AND duration_unit = $2`,
                ["pending", "t"]
            );

            trades = result.rows;
                } catch (error) {
            console.error("TICK TRADES QUERY ERROR:", {
                message: error.message,
                code: error.code,
                cause: error.cause
                    ? error.cause.message
                    : null,
                pool: {
                    totalConnections: db.pool.totalCount,
                    idleConnections: db.pool.idleCount,
                    waitingRequests: db.pool.waitingCount
                },
                timestamp: new Date().toISOString()
            });

            return;
        }

        if (!trades || trades.length === 0) {
            return;
        }

        for (const trade of trades) {
            const symbol = getSyntheticSymbol(trade);

            if (shouldSettleTickTrade(trade, symbol)) {
                await settleTrade(trade);
            }
        }
    } catch (error) {
        console.error("SETTLE TICK TRADES EXCEPTION:", error);
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

