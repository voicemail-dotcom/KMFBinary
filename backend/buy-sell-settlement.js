"use strict";

const supabase =
    require("./supabase");

const buySellMarket =
    require("./buy-sell-market");


/*
==========================================================
KMF BUY / SELL SETTLEMENT
==========================================================

Features:

- BUY / SELL P&L
- Maximum loss = 100% of stake
- Take Profit = 1.5x / 2x / 3x profit
- Duration:
    5 seconds
    10 seconds
    30 seconds
    1 minute
    2 minutes
    5 minutes
    10 minutes
    15 minutes
    30 minutes
    1 hour
- TP closes trade immediately
- Max loss closes trade immediately
- Expiry closes trade using current P/L
- Manual Cash Out closes trade immediately
- Stake is deducted when trade opens
- Settlement returns stake + profit
- Losing trades return only the remaining amount
- Maximum loss returns 0
- Separate wallet transaction references
- Prevents double settlement
==========================================================
*/


/*
==========================================================
SUPPORTED BUY / SELL DURATIONS
==========================================================
*/

const VALID_BUY_SELL_DURATIONS = [
    1,
    2,
    3,
    4,
    5,
    10,
    15,
    30,
    45,
    60,
    120,
    300,
    600,
    900,
    1800,
    2700,
    3600
];


/*
==========================================================
GET KES / USD EXCHANGE RATE
==========================================================

IMPORTANT:

The opening Buy/Sell endpoint uses
KMF_KES_PER_USD.

Settlement MUST use the same rate.

This prevents the stake from being converted using
one rate when opening and another rate when settling.
==========================================================
*/

function getKesPerUsd() {

    const rate =
        Number(
            process.env.KMF_KES_PER_USD ||
            135
        );


    if (
        !Number.isFinite(rate) ||
        rate <= 0
    ) {

        return 135;

    }


    return rate;

}


/*
==========================================================
BUY / SELL P&L
==========================================================

For every 1 price point:

KSh100 stake = KSh10 P/L

Therefore:

P/L =
price movement × stake × 0.10

Maximum loss:
-stake

==========================================================
*/

function calculatePnlKes({

    side,

    entryPrice,

    currentPrice,

    stakeKes

}) {

    const entry =
        Number(entryPrice);

    const current =
        Number(currentPrice);

    const stake =
        Number(stakeKes);


    if (
        !Number.isFinite(entry) ||
        !Number.isFinite(current) ||
        !Number.isFinite(stake)
    ) {

        return 0;

    }


    let movement;


    if (
        side === "buy"
    ) {

        movement =
            current -
            entry;

    }

    else {

        movement =
            entry -
            current;

    }


    let pnl =
        movement *
        stake *
        0.10;


    /*
    ------------------------------------------
    MAXIMUM LOSS
    ------------------------------------------
    */

    pnl =
        Math.max(
            -stake,
            pnl
        );


    return Number(
        pnl.toFixed(2)
    );

}


/*
==========================================================
GET TAKE PROFIT MULTIPLIER
==========================================================
*/

function getTakeProfitMultiplier(
    trade
) {

    const value =
        Number(
            trade.take_profit_multiplier
        );


    if (
        [
            1.5,
            2,
            3,
            4,
            5,
            6,
            7,
            8,
            9,
            10
        ].includes(
            value
        )
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

function isValidDuration(
    durationSeconds
) {

    return VALID_BUY_SELL_DURATIONS.includes(
        Number(durationSeconds)
    );

}


/*
==========================================================
SETTLE ONE TRADE
==========================================================

options:

forceClose:
    Used by manual Cash Out.

When forceClose is true:
- TP does not have to be reached.
- Expiry does not have to be reached.
- Trade closes immediately using current P/L.

==========================================================
*/

async function settleTrade(
    trade,
    options = {}
) {

    try {

        const forceClose =
            options.forceClose === true;


        const manualCloseReason =
            options.closeReason ||
            "Cash Out";


        /*
        ------------------------------------------
        CURRENT MARKET PRICE
        ------------------------------------------
        */

        const currentPrice =
            Number(
                buySellMarket.getPrice(
                    trade.symbol
                )
            );


        if (
            !Number.isFinite(
                currentPrice
            )
        ) {

            return null;

        }


        /*
        ------------------------------------------
        CURRENT P/L
        ------------------------------------------
        */

        const pnlKes =
            calculatePnlKes({

                side:
                    trade.side,

                entryPrice:
                    trade.entry_price,

                currentPrice,

                stakeKes:
                    trade.stake_kes

            });


        const stakeKes =
            Number(
                trade.stake_kes
            );


        if (
            !Number.isFinite(
                stakeKes
            ) ||
            stakeKes <= 0
        ) {

            console.error(
                "BUY/SELL INVALID STAKE:",
                trade.id
            );

            return null;

        }


        /*
        ------------------------------------------
        TAKE PROFIT
        ------------------------------------------
        */

        const tpMultiplier =
            getTakeProfitMultiplier(
                trade
            );


        const tpTargetKes =
            Number(
                (
                    stakeKes *
                    tpMultiplier
                ).toFixed(2)
            );


        /*
        ------------------------------------------
        TIME EXPIRY
        ------------------------------------------
        */

        const expiresAt =
            new Date(
                trade.expires_at
            ).getTime();


        const expired =
            Number.isFinite(
                expiresAt
            ) &&
            Date.now() >=
            expiresAt;


        /*
        ------------------------------------------
        MAX LOSS
        ------------------------------------------
        */

        const maxLoss =
            pnlKes <=
            -stakeKes;


        /*
        ------------------------------------------
        TAKE PROFIT REACHED
        ------------------------------------------
        */

        const takeProfitReached =
            pnlKes >=
            tpTargetKes;


        /*
        ==================================================
        LIVE TRADE
        ==================================================
        */

        if (
            !forceClose &&
            !expired &&
            !maxLoss &&
            !takeProfitReached
        ) {

            await supabase
                .from("buy_sell_trades")
                .update({

                    current_price:
                        currentPrice,

                    pnl_kes:
                        pnlKes

                })
                .eq(
                    "id",
                    trade.id
                )
                .eq(
                    "status",
                    "open"
                );


            return null;

        }


        /*
        ==================================================
        FINAL RESULT
        ==================================================
        */

        let finalPnl;

        let status;

        let closeReason;


        /*
        ------------------------------------------
        MANUAL CASH OUT
        ------------------------------------------
        */

        if (
            forceClose
        ) {

            finalPnl =
                Math.max(
                    -stakeKes,
                    pnlKes
                );


            if (
                finalPnl > 0
            ) {

                status =
                    "won";

            }

            else if (
                finalPnl < 0
            ) {

                status =
                    "loss";

            }

            else {

                status =
                    "expired";

            }


            closeReason =
                manualCloseReason;

        }


        /*
        ------------------------------------------
        MAX LOSS
        ------------------------------------------
        */

        else if (
            maxLoss
        ) {

            finalPnl =
                -stakeKes;

            status =
                "loss";

            closeReason =
                "Maximum loss reached";

        }


        /*
        ------------------------------------------
        TAKE PROFIT
        ------------------------------------------
        */

        else if (
            takeProfitReached
        ) {

            finalPnl =
                tpTargetKes;

            status =
                "won";

            closeReason =
                `Take Profit ${tpMultiplier}x reached`;

        }


        /*
        ------------------------------------------
        DURATION EXPIRY
        ------------------------------------------
        */

        else {

            finalPnl =
                pnlKes;


            if (
                finalPnl > 0
            ) {

                status =
                    "won";

            }

            else if (
                finalPnl < 0
            ) {

                status =
                    "loss";

            }

            else {

                status =
                    "expired";

            }


            closeReason =
                "Duration expired";

        }


        /*
        ==================================================
        CLAIM TRADE
        ==================================================

        The status check prevents
        double settlement.

        Only one worker/request can
        change OPEN → closed status.
        ==================================================
        */

        const {

            data: closedTrade,

            error: closeError

        } = await supabase
            .from("buy_sell_trades")
            .update({

                current_price:
                    currentPrice,

                pnl_kes:
                    finalPnl,

                result_kes:
                    finalPnl,

                exit_price:
                    currentPrice,

                status,

                closed_at:
                    new Date().toISOString(),

                close_reason:
                    closeReason

            })
            .eq(
                "id",
                trade.id
            )
            .eq(
                "status",
                "open"
            )
            .select()
            .maybeSingle();


        if (closeError) {

            console.error(
                "BUY/SELL CLOSE ERROR:",
                closeError
            );

            return null;

        }


        /*
        Another worker/request
        already closed it.
        */

        if (!closedTrade) {

            return null;

        }


        /*
        ==================================================
        GET WALLET
        ==================================================
        */

        const {

            data: wallet,

            error: walletError

        } = await supabase
            .from("wallets")
            .select("*")
            .eq(
                "user_id",
                trade.user_id
            )
            .maybeSingle();


        if (
            walletError ||
            !wallet
        ) {

            console.error(
                "BUY/SELL WALLET ERROR:",
                walletError
            );

            return closedTrade;

        }


        /*
        ==================================================
        SELECT ACCOUNT BALANCE
        ==================================================
        */

        const balanceField =
            trade.mode === "real"
                ? "balance"
                : "demo_balance";


        const currentBalance =
            Number(
                wallet[
                    balanceField
                ]
            );


        if (
            !Number.isFinite(
                currentBalance
            )
        ) {

            console.error(
                "BUY/SELL INVALID WALLET BALANCE:",
                trade.id
            );

            return closedTrade;

        }


        /*
        ==================================================
        KES → USD
        ==================================================

        IMPORTANT:

        Use the SAME KMF_KES_PER_USD rate that is used
        when the trade opens.

        Example:

        KSh100 stake
        Rate = 135

        Stake USD =
        100 / 135

        ==================================================
        */

        const kesPerUsd =
            getKesPerUsd();


        const stakeUsd =
            Number(
                trade.stake_usd
            );


        if (
            !Number.isFinite(
                stakeUsd
            ) ||
            stakeUsd <= 0
        ) {

            console.error(
                "BUY/SELL INVALID USD STAKE:",
                trade.id
            );

            return closedTrade;

        }


        const pnlUsd =
            Number(
                (
                    finalPnl /
                    kesPerUsd
                ).toFixed(6)
            );


        /*
        ==================================================
        WALLET CREDIT
        ==================================================

        The stake was already removed when the trade
        opened.

        Therefore settlement returns:

        STAKE + PROFIT

        or:

        STAKE - LOSS

        Examples:

        ------------------------------------------

        Stake = KSh100
        Profit = KSh80

        Credit =
        KSh100 + KSh80
        = KSh180

        ------------------------------------------

        Stake = KSh100
        Loss = KSh40

        Credit =
        KSh100 - KSh40
        = KSh60

        ------------------------------------------

        Stake = KSh100
        Maximum loss = KSh100

        Credit =
        KSh100 - KSh100
        = KSh0

        ==================================================
        */

        const walletCredit =
            Math.max(
                0,
                Number(
                    (
                        stakeUsd +
                        pnlUsd
                    ).toFixed(6)
                )
            );


        const newBalance =
            Number(
                (
                    currentBalance +
                    walletCredit
                ).toFixed(6)
            );


        /*
        ==================================================
        CREDIT WALLET
        ==================================================
        */

        const {

            data: updatedWallet,

            error: walletUpdateError

        } = await supabase
            .from("wallets")
            .update({

                [balanceField]:
                    newBalance,

                updated_at:
                    new Date().toISOString()

            })
            .eq(
                "id",
                wallet.id
            )
            .eq(
                balanceField,
                currentBalance
            )
            .select()
            .maybeSingle();


        if (
            walletUpdateError ||
            !updatedWallet
        ) {

            console.error(
                "BUY/SELL WALLET CREDIT ERROR:",
                walletUpdateError
            );

            return closedTrade;

        }


        /*
        ==================================================
        WALLET TRANSACTION
        ==================================================
        */

        const transactionAmount =
            walletCredit;


        const transactionDescription =
            forceClose
                ? `Buy/Sell ${trade.side.toUpperCase()} Cash Out`
                : `Buy/Sell ${trade.side.toUpperCase()} settlement`;


        const {

            error: transactionError

        } = await supabase
            .from("wallet_transactions")
            .insert({

                user_id:
                    trade.user_id,

                wallet_id:
                    wallet.id,

                transaction_type:
                    "buy_sell_settlement",

                type:
                    "buy_sell_settlement",

                amount:
                    transactionAmount,

                status:
                    "completed",

                payment_method:
                    "wallet",

                reference:
                    "BS-SETTLE-" +
                    trade.id,

                reference_id:
                    trade.id,

                description:
                    transactionDescription,

                balance_before:
                    currentBalance,

                balance_after:
                    newBalance

            });


        if (transactionError) {

            console.error(
                "BUY/SELL TRANSACTION LOG ERROR:",
                transactionError
            );

        }


        /*
        ==================================================
        LOG
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

        console.log(
            "TRADE:",
            trade.id
        );

        console.log(
            "SIDE:",
            trade.side
        );

        console.log(
            "ENTRY:",
            trade.entry_price
        );

        console.log(
            "EXIT:",
            currentPrice
        );

        console.log(
            "STAKE KES:",
            stakeKes
        );

        console.log(
            "STAKE USD:",
            stakeUsd
        );

        console.log(
            "KES/USD RATE:",
            kesPerUsd
        );

        console.log(
            "TP:",
            tpMultiplier + "x"
        );

        console.log(
            "TP TARGET KES:",
            tpTargetKes
        );

        console.log(
            "P/L KES:",
            finalPnl
        );

        console.log(
            "P/L USD:",
            pnlUsd
        );

        console.log(
            "CREDIT USD:",
            walletCredit
        );

        console.log(
            "BALANCE BEFORE USD:",
            currentBalance
        );

        console.log(
            "BALANCE AFTER USD:",
            newBalance
        );

        console.log(
            "MODE:",
            trade.mode
        );

        console.log(
            "STATUS:",
            status
        );

        console.log(
            "REASON:",
            closeReason
        );

        console.log(
            "=========================================="
        );


        return closedTrade;

    }

    catch (error) {

        console.error(
            "BUY/SELL SETTLEMENT ERROR:",
            error
        );

        return null;

    }

}


/*
==========================================================
MANUAL BUY / SELL CASH OUT
==========================================================

This is called by the API endpoint.

It:

1. Finds the user's open trade.
2. Gets the current market price.
3. Calculates current P/L.
4. Immediately closes the trade.
5. Returns stake + current P/L.
6. Credits the correct Demo/Live wallet.
7. Prevents double cash-out.

==========================================================
*/

async function cashOutBuySellTrade(
    tradeId,
    userId
) {

    try {

        if (
            !tradeId ||
            !userId
        ) {

            return {

                success: false,

                statusCode: 400,

                message:
                    "Trade ID and user ID are required"

            };

        }


        const {

            data: trade,

            error

        } = await supabase
            .from("buy_sell_trades")
            .select("*")
            .eq(
                "id",
                tradeId
            )
            .eq(
                "user_id",
                userId
            )
            .eq(
                "status",
                "open"
            )
            .maybeSingle();


        if (error) {

            console.error(
                "BUY/SELL CASH OUT LOOKUP ERROR:",
                error
            );

            return {

                success: false,

                statusCode: 500,

                message:
                    "Unable to load Buy/Sell position"

            };

        }


        if (!trade) {

            return {

                success: false,

                statusCode: 409,

                message:
                    "Buy/Sell position is no longer open"

            };

        }


        /*
        Validate stored duration
        for safety.
        */

        if (
            !isValidDuration(
                trade.duration_seconds
            )
        ) {

            console.warn(
                "BUY/SELL CASH OUT UNKNOWN DURATION:",
                trade.duration_seconds
            );

        }


        const closedTrade =
            await settleTrade(
                trade,
                {

                    forceClose:
                        true,

                    closeReason:
                        "Manual Cash Out"

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

            message:
                "Buy/Sell position cashed out successfully",

            trade:
                closedTrade

        };

    }

    catch (error) {

        console.error(
            "BUY/SELL CASH OUT ERROR:",
            error
        );

        return {

            success: false,

            statusCode: 500,

            message:
                "Unable to cash out Buy/Sell position"

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

        const {

            data: trades,

            error

        } = await supabase
            .from("buy_sell_trades")
            .select("*")
            .eq(
                "status",
                "open"
            )
            .order(
                "expires_at",
                {
                    ascending: true
                }
            )
            .limit(100);


        if (error) {

            console.error(
                "BUY/SELL OPEN TRADES ERROR:",
                error
            );

            return;

        }


        if (
            !Array.isArray(trades) ||
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