
"use strict";

const db = require("./db");
const buySellMarket = require("./buy-sell-market");

/*
==========================================================
KMF BUY / SELL SETTLEMENT — NEON
==========================================================

Preserves:
- BUY / SELL P&L
- Maximum loss = 100% of stake
- Take Profit multipliers
- Supported trade durations
- Automatic expiry settlement
- Manual cash-out
- Demo / Live wallets
- KES / USD conversion
- Conditional trade closure
- Atomic trade + wallet + transaction updates

Database: Neon PostgreSQL
==========================================================
*/

const VALID_BUY_SELL_DURATIONS = [
    1, 2, 3, 4, 5, 10, 15, 30, 45,
    60, 120, 300, 600, 900, 1800, 2700, 3600
];

/*
==========================================================
GET KES / USD EXCHANGE RATE
==========================================================
*/

function getKesPerUsd() {
    const rate = Number(process.env.KMF_KES_PER_USD || 135);

    if (!Number.isFinite(rate) || rate <= 0) {
        return 135;
    }

    return rate;
}

/*
==========================================================
BUY / SELL P&L
==========================================================
*/

function calculatePnlKes({
    side,
    entryPrice,
    currentPrice,
    stakeKes
}) {
    const entry = Number(entryPrice);
    const current = Number(currentPrice);
    const stake = Number(stakeKes);

    if (
        !Number.isFinite(entry) ||
        !Number.isFinite(current) ||
        !Number.isFinite(stake)
    ) {
        return 0;
    }

    let movement;

    if (side === "buy") {
        movement = current - entry;
    } else {
        movement = entry - current;
    }

    let pnl = movement * stake * 0.10;

    pnl = Math.max(-stake, pnl);

    return Number(pnl.toFixed(2));
}

/*
==========================================================
GET TAKE PROFIT MULTIPLIER
==========================================================
*/

function getTakeProfitMultiplier(trade) {
    const value = Number(trade.take_profit_multiplier);

    if (
        [
            1.5, 2, 3, 4, 5,
            6, 7, 8, 9, 10
        ].includes(value)
    ) {
        return value;
    }

    return 1.5;
}

/*
==========================================================
VALIDATE DURATION
==========================================================
*/

function isValidDuration(durationSeconds) {
    return VALID_BUY_SELL_DURATIONS.includes(
        Number(durationSeconds)
    );
}

/*
==========================================================
UPDATE OPEN TRADE PRICE AND P&L
==========================================================
*/

async function updateOpenTradePrice(tradeId, currentPrice, pnlKes) {
    try {
        await db.query(
            `UPDATE buy_sell_trades
             SET current_price = $1,
                 pnl_kes = $2
             WHERE id = $3
               AND status = 'open'`,
            [
                currentPrice,
                pnlKes,
                tradeId
            ]
        );
    } catch (error) {
        console.error(
            "BUY/SELL PRICE UPDATE ERROR:",
            error
        );
    }
}

/*
==========================================================
SETTLE ONE TRADE
==========================================================

forceClose:
    Used for manual cash-out.

Trade closure, wallet credit, and transaction logging
are committed together in one Neon transaction.

If the wallet update or transaction insert fails,
the trade closure is rolled back too.
==========================================================
*/

async function settleTrade(trade, options = {}) {
    let client;

    try {
        if (!trade || !trade.id || !trade.user_id) {
            return null;
        }

        const forceClose = options.forceClose === true;

        const manualCloseReason =
            options.closeReason || "Cash Out";

        /*
        ------------------------------------------
        CURRENT MARKET PRICE
        ------------------------------------------
        */

        const currentPrice = Number(
            buySellMarket.getPrice(trade.symbol)
        );

        if (!Number.isFinite(currentPrice)) {
            return null;
        }

        /*
        ------------------------------------------
        VALIDATE STAKE
        ------------------------------------------
        */

        const stakeKes = Number(trade.stake_kes);
        const stakeUsd = Number(trade.stake_usd);

        if (!Number.isFinite(stakeKes) || stakeKes <= 0) {
            console.error(
                "BUY/SELL INVALID STAKE:",
                trade.id
            );

            return null;
        }

        if (!Number.isFinite(stakeUsd) || stakeUsd <= 0) {
            console.error(
                "BUY/SELL INVALID USD STAKE:",
                trade.id
            );

            return null;
        }

        /*
        ------------------------------------------
        CURRENT P&L
        ------------------------------------------
        */

        const pnlKes = calculatePnlKes({
            side: trade.side,
            entryPrice: trade.entry_price,
            currentPrice,
            stakeKes
        });

        /*
        ------------------------------------------
        TAKE PROFIT
        ------------------------------------------
        */

        const tpMultiplier = getTakeProfitMultiplier(trade);

        const tpTargetKes = Number(
            (stakeKes * tpMultiplier).toFixed(2)
        );

        /*
        ------------------------------------------
        TIME EXPIRY
        ------------------------------------------
        */

        const expiresAt = new Date(
            trade.expires_at
        ).getTime();

        const expired =
            Number.isFinite(expiresAt) &&
            Date.now() >= expiresAt;

        /*
        ------------------------------------------
        MAX LOSS
        ------------------------------------------
        */

        const maxLoss = pnlKes <= -stakeKes;

        /*
        ------------------------------------------
        TAKE PROFIT REACHED
        ------------------------------------------
        */

        const takeProfitReached = pnlKes >= tpTargetKes;

        /*
        ------------------------------------------
        TRADE STILL OPEN
        ------------------------------------------
        */

        if (
            !forceClose &&
            !expired &&
            !maxLoss &&
            !takeProfitReached
        ) {
            await updateOpenTradePrice(
                trade.id,
                currentPrice,
                pnlKes
            );

            return null;
        }

        /*
        ==================================================
        DETERMINE FINAL RESULT
        ==================================================
        */

        let finalPnl;
        let status;
        let closeReason;

        /*
        MANUAL CASH OUT
        */

        if (forceClose) {
            finalPnl = Math.max(-stakeKes, pnlKes);

            if (finalPnl > 0) {
                status = "won";
            } else if (finalPnl < 0) {
                status = "loss";
            } else {
                status = "expired";
            }

            closeReason = manualCloseReason;
        }

        /*
        MAXIMUM LOSS
        */

        else if (maxLoss) {
            finalPnl = -stakeKes;
            status = "loss";
            closeReason = "Maximum loss reached";
        }

        /*
        TAKE PROFIT
        */

        else if (takeProfitReached) {
            finalPnl = tpTargetKes;
            status = "won";
            closeReason = `Take Profit ${tpMultiplier}x reached`;
        }

        /*
        DURATION EXPIRY
        */

        else {
            finalPnl = pnlKes;

            if (finalPnl > 0) {
                status = "won";
            } else if (finalPnl < 0) {
                status = "loss";
            } else {
                status = "expired";
            }

            closeReason = "Duration expired";
        }

        finalPnl = Number(finalPnl.toFixed(2));

        /*
        ==================================================
        CALCULATE WALLET CREDIT
        ==================================================
        */

        const kesPerUsd = getKesPerUsd();

        const pnlUsd = Number(
            (finalPnl / kesPerUsd).toFixed(6)
        );

        /*
        The stake was deducted when the trade opened.
        Settlement returns the remaining stake plus/minus P&L.
        */

        const walletCredit = Math.max(
            0,
            Number((stakeUsd + pnlUsd).toFixed(6))
        );

        /*
        ==================================================
        VALIDATE ACCOUNT MODE
        ==================================================
        */

        const balanceField =
            trade.mode === "real"
                ? "balance"
                : "demo_balance";

        /*
        ==================================================
        ATOMIC NEON SETTLEMENT
        ==================================================

        1. Claim the open trade.
        2. Lock the wallet row.
        3. Credit the correct balance.
        4. Insert the wallet transaction.
        5. Commit all changes together.

        Any database failure rolls back the transaction.
        ==================================================
        */

        client = await db.pool.connect();

        await client.query("BEGIN");

        /*
        ------------------------------------------
        CLAIM TRADE
        ------------------------------------------
        */

        const closeResult = await client.query(
            `UPDATE buy_sell_trades
             SET current_price = $1,
                 pnl_kes = $2,
                 result_kes = $2,
                 exit_price = $1,
                 status = $3,
                 closed_at = NOW(),
                 close_reason = $4
             WHERE id = $5
               AND status = 'open'
             RETURNING *`,
            [
                currentPrice,
                finalPnl,
                status,
                closeReason,
                trade.id
            ]
        );

        const closedTrade =
            closeResult.rows[0] || null;

        /*
        Another worker already closed this trade.
        */

        if (!closedTrade) {
            await client.query("ROLLBACK");
            return null;
        }

        /*
        ------------------------------------------
        LOCK WALLET
        ------------------------------------------
        */

        const walletResult = await client.query(
            `SELECT *
             FROM wallets
             WHERE user_id = $1
             FOR UPDATE`,
            [trade.user_id]
        );

        const wallet = walletResult.rows[0] || null;

        if (!wallet) {
            throw new Error(
                `Wallet not found for user ${trade.user_id}`
            );
        }

        const currentBalance = Number(
            wallet[balanceField]
        );

        if (!Number.isFinite(currentBalance)) {
            throw new Error(
                `Invalid ${balanceField} for trade ${trade.id}`
            );
        }

        /*
        ------------------------------------------
        CALCULATE NEW BALANCE
        ------------------------------------------
        */

        const newBalance = Number(
            (currentBalance + walletCredit).toFixed(6)
        );

        /*
        ------------------------------------------
        CREDIT LIVE OR DEMO WALLET
        ------------------------------------------
        */

        const walletUpdateResult = await client.query(
            `UPDATE wallets
             SET ${balanceField} = $1,
                 updated_at = NOW()
             WHERE id = $2
               AND user_id = $3
             RETURNING *`,
            [
                newBalance,
                wallet.id,
                trade.user_id
            ]
        );

        if (walletUpdateResult.rowCount !== 1) {
            throw new Error(
                `Wallet credit failed for trade ${trade.id}`
            );
        }

        /*
        ------------------------------------------
        INSERT WALLET TRANSACTION
        ------------------------------------------
        */

        const transactionDescription = forceClose
            ? `Buy/Sell ${String(trade.side).toUpperCase()} Cash Out`
            : `Buy/Sell ${String(trade.side).toUpperCase()} settlement`;

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
             VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, $8, $9, $10, $11, $12
             )`,
            [
                trade.user_id,
                wallet.id,
                "buy_sell_settlement",
                "buy_sell_settlement",
                walletCredit,
                "completed",
                "wallet",
                `BS-SETTLE-${trade.id}`,
                trade.id,
                transactionDescription,
                currentBalance,
                newBalance
            ]
        );

        /*
        ------------------------------------------
        COMMIT
        ------------------------------------------
        */

        await client.query("COMMIT");

        /*
        ==================================================
        LOG SETTLEMENT
        ==================================================
        */

        console.log(
            "=========================================="
        );

        console.log(
            forceClose
                ? "BUY/SELL CASH OUT"
                : "BUY/SELL TRADE SETTLED"
        );

        console.log("TRADE:", trade.id);
        console.log("SIDE:", trade.side);
        console.log("ENTRY:", trade.entry_price);
        console.log("EXIT:", currentPrice);
        console.log("STAKE KES:", stakeKes);
        console.log("STAKE USD:", stakeUsd);
        console.log("KES/USD RATE:", kesPerUsd);
        console.log("TP:", `${tpMultiplier}x`);
        console.log("TP TARGET KES:", tpTargetKes);
        console.log("P/L KES:", finalPnl);
        console.log("P/L USD:", pnlUsd);
        console.log("CREDIT USD:", walletCredit);
        console.log("BALANCE BEFORE USD:", currentBalance);
        console.log("BALANCE AFTER USD:", newBalance);
        console.log("MODE:", trade.mode);
        console.log("STATUS:", status);
        console.log("REASON:", closeReason);

        console.log(
            "=========================================="
        );

        return closedTrade;

    } catch (error) {
        if (client) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                console.error(
                    "BUY/SELL ROLLBACK ERROR:",
                    rollbackError.message
                );
            }
        }

        console.error(
            "BUY/SELL SETTLEMENT ERROR:",
            error
        );

        return null;

    } finally {
        if (client) {
            client.release();
        }
    }
}

/*
==========================================================
MANUAL BUY / SELL CASH OUT
==========================================================
*/

async function cashOutBuySellTrade(tradeId, userId) {
    try {
        if (!tradeId || !userId) {
            return {
                success: false,
                statusCode: 400,
                message: "Trade ID and user ID are required"
            };
        }

        const result = await db.query(
            `SELECT *
             FROM buy_sell_trades
             WHERE id = $1
               AND user_id = $2
               AND status = 'open'
             LIMIT 1`,
            [
                tradeId,
                userId
            ]
        );

        const trade = result.rows[0] || null;

        if (!trade) {
            return {
                success: false,
                statusCode: 409,
                message: "Buy/Sell position is no longer open"
            };
        }

        if (!isValidDuration(trade.duration_seconds)) {
            console.warn(
                "BUY/SELL CASH OUT UNKNOWN DURATION:",
                trade.duration_seconds
            );
        }

        const closedTrade = await settleTrade(
            trade,
            {
                forceClose: true,
                closeReason: "Manual Cash Out"
            }
        );

        if (!closedTrade) {
            return {
                success: false,
                statusCode: 409,
                message:
                    "Trade was already closed or could not be cashed out"
            };
        }

        return {
            success: true,
            statusCode: 200,
            message: "Buy/Sell position cashed out successfully",
            trade: closedTrade
        };

    } catch (error) {
        console.error(
            "BUY/SELL CASH OUT ERROR:",
            error
        );

        return {
            success: false,
            statusCode: 500,
            message: "Unable to cash out Buy/Sell position"
        };
    }
}

/*
==========================================================
SETTLE ALL OPEN TRADES
==========================================================
*/

async function settleBuySellTrades() {
    try {
        const result = await db.query(
            `SELECT *
             FROM buy_sell_trades
             WHERE status = 'open'
             ORDER BY expires_at ASC
             LIMIT 100`
        );

        const trades = result.rows;

        if (!Array.isArray(trades) || trades.length === 0) {
            return;
        }

        for (const trade of trades) {
            await settleTrade(trade);
        }

    } catch (error) {
        console.error(
            "BUY/SELL SETTLEMENT WORKER ERROR:",
            error
        );
    }
}

/*
==========================================================
EXPORT
==========================================================
*/

module.exports = {
    calculatePnlKes,
    settleBuySellTrades,
    cashOutBuySellTrade,
    VALID_BUY_SELL_DURATIONS
};
