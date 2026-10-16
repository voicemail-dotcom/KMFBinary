const express = require("express");

console.log("==========================================");
console.log("KMFinary SERVER FILE:", __filename);
console.log("SERVER VERSION TEST: VOL FIX 002");
console.log("==========================================");
const path = require("path");
const cors = require("cors");
const crypto = require("crypto");
const axios = require("axios");
const multer = require("multer");

const kycUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024
    }
});
require("dotenv").config();

const supabase = require("./supabase");
const settlement = require("./settlement");
const syntheticMarket = require("./synthetic-market");
const buySellMarket =
    require("./buy-sell-market");

const buySellSettlement =
    require("./buy-sell-settlement");
const registerAdminRoutes = require("./admin-routes");

const settleExpiredTrades =
    settlement.settleExpiredTrades;

const settleTickTrades =
    settlement.settleTickTrades;

const monitorTouchTrades =
    settlement.monitorTouchTrades;

const monitorActiveAccumulators =
    settlement.monitorActiveAccumulators;

const app = express();
// ==========================================
// SERVE FRONTEND
// ==========================================
// ==========================================
// SERVE FRONTEND FILES
// ==========================================

const frontendPath = path.join(
    __dirname,
    ".."
);

app.use(
    express.static(frontendPath)
);
const PORT =
    process.env.PORT || 3000;


// ==========================================
// ACCUMULATOR / TOUCH-NO-TOUCH CONFIG
// ==========================================

const ACCUMULATOR_GROWTH_OPTIONS = [
    0.01,
    0.02,
    0.03,
    0.04,
    0.05
];
const ACCUMULATOR_KNOCKOUT_PERCENT =
    Number(
        process.env.ACCUMULATOR_KNOCKOUT_PERCENT || 0.02
    );


// ==========================================
// CALCULATE ACCUMULATOR BOUNDARIES
// ==========================================
//
// Entry price is the CENTER.
//
// Example:
// Entry = 100
// Knockout = 2%
//
// Lower = 98
// Upper = 102
//
// These boundaries remain fixed for
// the lifetime of the trade.
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

        return null;

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
const ACCUMULATOR_MAX_MULTIPLIER =
    Number(
        process.env.ACCUMULATOR_MAX_MULTIPLIER || 100
    );

const TOUCH_BARRIER_DISTANCE =
    Number(
        process.env.TOUCH_BARRIER_DISTANCE || 2
    );

const TOUCH_EXPIRIES = [
    5,
    10,
    30,
    60
];

const ACCUMULATOR_EXPIRIES = [
    10,
    30,
    60,
    120,
    300
];


// ==========================================
// USD / KES EXCHANGE RATES
// ==========================================

const USD_KES_DEPOSIT_RATE =
    Number(
        process.env.USD_KES_DEPOSIT_RATE || 135
    );

const USD_KES_WITHDRAWAL_RATE =
    Number(
        process.env.USD_KES_WITHDRAWAL_RATE || 124
    );

console.log(
    "USD/KES Deposit Rate:",
    USD_KES_DEPOSIT_RATE
);

console.log(
    "USD/KES Withdrawal Rate:",
    USD_KES_WITHDRAWAL_RATE
);


// ==========================================
// MIDDLEWARE
// ==========================================

app.use(cors());

app.use(express.json());


// ==========================================
// INVALID JSON HANDLER
// ==========================================

app.use((err, req, res, next) => {

    if (
        err instanceof SyntaxError &&
        err.status === 400 &&
        "body" in err
    ) {

        console.log(
            "=========================================="
        );

        console.log(
            "❌ INVALID JSON REQUEST"
        );

        console.log(
            "Method:",
            req.method
        );

        console.log(
            "URL:",
            req.originalUrl
        );

        console.log(
            "Content-Type:",
            req.headers["content-type"]
        );

        console.log(
            "User-Agent:",
            req.headers["user-agent"]
        );

        console.log(
            "=========================================="
        );

        return res.status(400).json({
            success: false,
            message: "Invalid JSON"
        });
    }

    next(err);
});

// ==========================================
// AUTHENTICATION MIDDLEWARE
// ==========================================

async function authenticateUser(req, res, next) {

    try {

        const authHeader =
            req.headers.authorization;

        if (
            typeof authHeader !== "string" ||
            !authHeader.startsWith("Bearer ")
        ) {

            return res.status(401).json({
                success: false,
                message: "Authentication required"
            });

        }

        const token =
            authHeader.substring(7).trim();

        if (!token) {

            return res.status(401).json({
                success: false,
                message: "Authentication token missing"
            });

        }

        const {
            data: { user },
            error
        } = await supabase.auth.getUser(token);

        if (error || !user || !user.id) {

            return res.status(401).json({
                success: false,
                message: "Invalid or expired authentication token"
            });

        }

        // Only use the authenticated Supabase user ID.
        // Never trust a user_id supplied by the frontend.
        req.user = {
            id: user.id,
            email: user.email || null,
            role: user.role || "authenticated"
        };

        next();

    }

    catch (error) {

        console.error(
            "Authentication error:",
            error
        );

        return res.status(401).json({
            success: false,
            message: "Authentication failed"
        });

    }

}
// ==========================================
// ADMIN ROUTES
// ==========================================

registerAdminRoutes(
    app,
    authenticateUser
);
// ==========================================
// SYNTHETIC MARKET MAPPING
// ==========================================

function getSyntheticSymbol(market) {

    if (!market) {
        return null;
    }

    const symbol =
        typeof market === "string"
            ? market
            : String(
                market.symbol || ""
            )
                .trim()
                .toUpperCase();

    if (!symbol) {
        return null;
    }

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
        "VOL-100-1S": "VOL-100-1S"

    };

    return map[symbol] || null;
}


// ==========================================
// HELPER: LAST DIGIT
// ==========================================

function getLastDigit(price) {

    const number =
        Number(price);

    if (!Number.isFinite(number)) {
        return null;
    }

    return Math.abs(
        Math.floor(number * 100)
    ) % 10;
}


// ==========================================
// TOUCH / NO TOUCH FIXED BARRIER
// ==========================================

function calculateTouchBarrier(
    entryPrice,
    direction
) {

    const price =
        Number(entryPrice);

    const normalizedDirection =
        String(direction || "")
            .trim()
            .toLowerCase();

    if (
        !Number.isFinite(price) ||
        price <= 0
    ) {

        throw new Error(
            "Invalid touch barrier entry price"
        );

    }

   const distance =
    TOUCH_BARRIER_DISTANCE;
    if (
        normalizedDirection ===
        "above"
    ) {

        return Number(
            (price + distance).toFixed(2)
        );

    }

    if (
        normalizedDirection ===
        "below"
    ) {

        return Number(
            (price - distance).toFixed(2)
        );

    }

    throw new Error(
        "Touch barrier direction must be above or below"
    );
}


// ==========================================
// ACCUMULATOR FIXED KNOCKOUT BARRIER
// ==========================================

function calculateAccumulatorBarrier(
    entryPrice,
    direction
) {

    const price =
        Number(entryPrice);

    const normalizedDirection =
        String(direction || "")
            .trim()
            .toLowerCase();

    if (
        !Number.isFinite(price) ||
        price <= 0
    ) {

        throw new Error(
            "Invalid accumulator entry price"
        );

    }

    const distance =
        price * ACCUMULATOR_KNOCKOUT_PERCENT;

    if (
        normalizedDirection ===
        "above"
    ) {

        return Number(
            (price + distance).toFixed(2)
        );

    }

    if (
        normalizedDirection ===
        "below"
    ) {

        return Number(
            (price - distance).toFixed(2)
        );

    }

    throw new Error(
        "Accumulator direction must be above or below"
    );
}

// ==========================================
// WALLET HELPER
// ==========================================

async function getOrCreateWallet(userId) {

    const {
        data: wallet,
        error: walletError
    } = await supabase
        .from("wallets")
        .select("*")
        .eq(
            "user_id",
            userId
        )
        .maybeSingle();

    if (walletError) {
        throw walletError;
    }

    if (wallet) {
        return wallet;
    }

    const {
        data: newWallet,
        error: createError
    } = await supabase
        .from("wallets")
        .insert({

            user_id:
                userId,
balance: 0,
bonus_balance: 0,
demo_balance: 10000,
currency: "USD"
        })
        .select()
        .single();

    if (createError) {
        throw createError;
    }

    return newWallet;
}

// ============================================================
// KMFBINARY PROMOTIONS & REFERRALS
// ============================================================
async function getActivePromotion(type) {
    const now = new Date().toISOString();

    const { data, error } = await supabase
        .from("promotions")
        .select("*")
        .eq("type", type)
        .eq("active", true)
        .or(`start_at.is.null,start_at.lte.${now}`)
        .or(`expires_at.is.null,expires_at.gte.${now}`)
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) {
        console.error("getActivePromotion error:", error);
        return null;
    }

    return data || null;
}
async function calculateDepositBonus(userId, depositAmount, depositId) {
    const amount = Number(depositAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
        return {
            bonusAmount: 0,
            promotion: null,
            isReferred: false
        };
    }

    // Check whether the user has a referrer.
    const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("id, referred_by")
        .eq("id", userId)
        .maybeSingle();

    if (profileError) {
        console.error(
            "calculateDepositBonus profile error:",
            profileError
        );
    }

    const isReferred = !!(
        profile &&
        profile.referred_by
    );

    /*
     * Referred users:
     * 1. Try the 70% referral deposit promotion.
     * 2. If it is not active, fall back to the normal 50% promotion.
     *
     * Normal users:
     * Use the standard deposit promotion.
     */
    let promotion = null;

    if (isReferred) {
        promotion = await getActivePromotion(
            "referral_deposit"
        );
    }

    if (!promotion) {
        promotion = await getActivePromotion(
            "deposit"
        );
    }

    if (!promotion) {
        return {
            bonusAmount: 0,
            promotion: null,
            isReferred
        };
    }

    const minimumDeposit = Number(
        promotion.min_deposit || 0
    );

    if (amount < minimumDeposit) {
        return {
            bonusAmount: 0,
            promotion,
            isReferred
        };
    }

    let bonusAmount =
        amount *
        (Number(promotion.bonus_percent || 0) / 100);

    // Apply maximum bonus if configured.
    if (
        promotion.max_bonus !== null &&
        promotion.max_bonus !== undefined &&
        Number(promotion.max_bonus) >= 0
    ) {
        bonusAmount = Math.min(
            bonusAmount,
            Number(promotion.max_bonus)
        );
    }

    bonusAmount = Number(
        bonusAmount.toFixed(2)
    );

    if (bonusAmount <= 0) {
        return {
            bonusAmount: 0,
            promotion,
            isReferred
        };
    }

    return {
        bonusAmount,
        promotion,
        isReferred
    };
}

async function createUserBonus(
    userId,
    promotion,
    depositAmount,
    bonusAmount,
    depositId
) {
    if (!promotion || bonusAmount <= 0) {
        return null;
    }

    const { data, error } = await supabase
        .from('user_bonuses')
        .insert({
            user_id: userId,
            promotion_id: promotion.id,
            deposit_id: depositId || null,
            deposit_amount: depositAmount,
            bonus_amount: bonusAmount,
            remaining_bonus: bonusAmount,
            status: 'active'
        })
        .select()
        .single();

    if (error) {
        console.error('createUserBonus error:', error);
        return null;
    }

    return data;
}
// ============================================================
// KMFBINARY BONUS WALLET HELPERS
// ============================================================

async function getTradingBalance(userId) {
    const wallet = await getOrCreateWallet(userId);

    const realBalance = Number(
        wallet.balance || 0
    );

    const bonusBalance = Number(
        wallet.bonus_balance || 0
    );

    return {
        realBalance,
        bonusBalance,
        tradingBalance:
            realBalance + bonusBalance,
        withdrawableBalance:
            realBalance
    };
}

async function addBonusToWallet(
    userId,
    bonusAmount
) {
    const amount = Number(bonusAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
        return null;
    }

    const wallet = await getOrCreateWallet(userId);

    const currentBonus = Number(
        wallet.bonus_balance || 0
    );

    const newBonus = Number(
        (currentBonus + amount).toFixed(2)
    );

    const { data, error } = await supabase
        .from("wallets")
        .update({
            bonus_balance: newBonus
        })
        .eq("id", wallet.id)
        .select()
        .single();

    if (error) {
        console.error(
            "addBonusToWallet error:",
            error
        );
        throw error;
    }

    return data;
}

async function clearBonusBalance(userId, reason = "bonus_ended") {
    const wallet = await getOrCreateWallet(userId);

    const currentBonus = Number(
        wallet.bonus_balance || 0
    );

    if (currentBonus <= 0) {
        return wallet;
    }

    const { data, error } = await supabase
        .from("wallets")
        .update({
            bonus_balance: 0
        })
        .eq("id", wallet.id)
        .select()
        .single();

    if (error) {
        console.error(
            "clearBonusBalance error:",
            error
        );
        throw error;
    }

    console.log(
        `KMFBinary bonus cleared for user ${userId}. Reason: ${reason}`
    );

    // Mark active user bonuses as ended.
    const { error: bonusError } = await supabase
        .from("user_bonuses")
        .update({
            remaining_bonus: 0,
            status: "ended",
            ended_at: new Date().toISOString()
        })
        .eq("user_id", userId)
        .eq("status", "active");

    if (bonusError) {
        console.error(
            "clearBonusBalance user_bonuses error:",
            bonusError
        );
    }

    return data;
}
// ==========================================
// MPESA DARaja HELPERS
// ==========================================

async function getMpesaAccessToken() {

    const consumerKey =
        process.env.MPESA_CONSUMER_KEY;

    const consumerSecret =
        process.env.MPESA_CONSUMER_SECRET;

    if (
        !consumerKey ||
        !consumerSecret
    ) {

        throw new Error(
            "M-Pesa consumer credentials are missing"
        );

    }

    const auth =
        Buffer
            .from(
                `${consumerKey}:${consumerSecret}`
            )
            .toString("base64");

    const response =
        await axios.get(
            "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
            {
                headers: {
                    Authorization:
                        `Basic ${auth}`
                }
            }
        );

    return response.data.access_token;
}


// ==========================================
// MPESA STK PUSH
// ==========================================

async function initiateMpesaStkPush({
    phoneNumber,
    amount,
    accountReference,
    transactionDescription
}) {

    const accessToken =
        await getMpesaAccessToken();

    const shortcode =
        process.env.MPESA_SHORTCODE;

    const passkey =
        process.env.MPESA_PASSKEY;

    if (
        !shortcode ||
        !passkey
    ) {

        throw new Error(
            "M-Pesa STK configuration is incomplete"
        );

    }

    const now =
        new Date();

    const kenyaTime =
        new Date(
            now.toLocaleString(
                "en-US",
                {
                    timeZone:
                        "Africa/Nairobi"
                }
            )
        );

    const timestamp =
        kenyaTime
            .getFullYear()
            .toString() +

        String(
            kenyaTime.getMonth() + 1
        ).padStart(2, "0") +

        String(
            kenyaTime.getDate()
        ).padStart(2, "0") +

        String(
            kenyaTime.getHours()
        ).padStart(2, "0") +

        String(
            kenyaTime.getMinutes()
        ).padStart(2, "0") +

        String(
            kenyaTime.getSeconds()
        ).padStart(2, "0");

    const password =
        Buffer
            .from(
                shortcode +
                passkey +
                timestamp
            )
            .toString("base64");

    console.log(
        "STK TIMESTAMP:",
        timestamp
    );

    console.log(
        "STK PASSWORD LENGTH:",
        password.length
    );

    console.log(
        "SHORTCODE USED:",
        shortcode
    );

    console.log(
        "PASSKEY LENGTH:",
        passkey.length
    );

    console.log(
        "STK CALLBACK URL:",
        process.env.MPESA_CALLBACK_URL
    );

    const response =
        await axios.post(
            "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
            {

                BusinessShortCode:
                    shortcode,

                Password:
                    password,

                Timestamp:
                    timestamp,

                TransactionType:
                    "CustomerPayBillOnline",

                Amount:
                    amount,

                PartyA:
                    phoneNumber,

                PartyB:
                    shortcode,

                PhoneNumber:
                    phoneNumber,

                CallBackURL:
                    process.env.MPESA_CALLBACK_URL,

                AccountReference:
                    accountReference,

                TransactionDesc:
                    transactionDescription

            },
            {

                headers: {

                    Authorization:
                        `Bearer ${accessToken}`,

                    "Content-Type":
                        "application/json"

                }

            }
        );

    return response.data;
}


// ==========================================
// MPESA STK PUSH QUERY
// ==========================================
//
// Used when the STK callback does not arrive.
// This does NOT directly credit the wallet.
// The result must still be verified against the
// pending transaction before money is credited.
// ==========================================

async function queryMpesaStkPush(
    checkoutRequestId
) {

    const accessToken =
        await getMpesaAccessToken();

    const shortcode =
        process.env.MPESA_SHORTCODE;

    const passkey =
        process.env.MPESA_PASSKEY;

    if (
        !shortcode ||
        !passkey
    ) {

        throw new Error(
            "M-Pesa STK configuration is incomplete"
        );

    }

    if (!checkoutRequestId) {

        throw new Error(
            "CheckoutRequestID is required"
        );

    }

    const now =
        new Date();

    const kenyaTime =
        new Date(
            now.toLocaleString(
                "en-US",
                {
                    timeZone:
                        "Africa/Nairobi"
                }
            )
        );

    const timestamp =
        kenyaTime
            .getFullYear()
            .toString() +

        String(
            kenyaTime.getMonth() + 1
        ).padStart(2, "0") +

        String(
            kenyaTime.getDate()
        ).padStart(2, "0") +

        String(
            kenyaTime.getHours()
        ).padStart(2, "0") +

        String(
            kenyaTime.getMinutes()
        ).padStart(2, "0") +

        String(
            kenyaTime.getSeconds()
        ).padStart(2, "0");

    const password =
        Buffer
            .from(
                shortcode +
                passkey +
                timestamp
            )
            .toString("base64");

    console.log(
        "=========================================="
    );

    console.log(
        "🔎 MPESA STK QUERY"
    );

    console.log(
        "CheckoutRequestID:",
        checkoutRequestId
    );

    console.log(
        "=========================================="
    );

    const response =
        await axios.post(
            "https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query",
            {

                BusinessShortCode:
                    shortcode,

                Password:
                    password,

                Timestamp:
                    timestamp,

                CheckoutRequestID:
                    checkoutRequestId

            },
            {

                headers: {

                    Authorization:
                        `Bearer ${accessToken}`,

                    "Content-Type":
                        "application/json"

                }

            }
        );

    console.log(
        "🔥 STK QUERY RESPONSE:",
        response.data
    );

    return response.data;
}


// ==========================================
// M-PESA B2C WITHDRAWAL
// ==========================================

async function initiateMpesaB2C({
    phoneNumber,
    amount,
    originatorConversationID,
    remarks
}) {

    const accessToken =
        await getMpesaAccessToken();

    const shortcode =
        process.env.MPESA_B2C_SHORTCODE;

    const initiatorName =
        process.env.MPESA_B2C_INITIATOR_NAME;

    const securityCredential =
        process.env.MPESA_B2C_SECURITY_CREDENTIAL;

    const resultURL =
        process.env.MPESA_B2C_RESULT_URL;

    const timeoutURL =
        process.env.MPESA_B2C_TIMEOUT_URL;

    if (
        !shortcode ||
        !initiatorName ||
        !securityCredential ||
        !resultURL ||
        !timeoutURL
    ) {

        throw new Error(
            "B2C M-Pesa configuration is incomplete"
        );

    }

    console.log(
        "===================================="
    );

    console.log(
        "🔥 MPESA B2C REQUEST"
    );

    console.log(
        "Amount:",
        amount
    );

    console.log(
        "Phone:",
        phoneNumber
    );

    console.log(
        "OriginatorConversationID:",
        originatorConversationID
    );

    console.log(
        "🔥 B2C RESULT URL:",
        resultURL
    );

    console.log(
        "🔥 B2C TIMEOUT URL:",
        timeoutURL
    );

    console.log(
        "===================================="
    );

    const response =
        await axios.post(
            "https://sandbox.safaricom.co.ke/mpesa/b2c/v3/paymentrequest",
            {

                OriginatorConversationID:
                    originatorConversationID,

                InitiatorName:
                    initiatorName,

                SecurityCredential:
                    securityCredential,

                CommandID:
                    "BusinessPayment",

                Amount:
                    amount,

                PartyA:
                    shortcode,

                PartyB:
                    phoneNumber,

                Remarks:
                    remarks ||
                    "KMFBinary withdrawal",

                QueueTimeOutURL:
                    timeoutURL,

                ResultURL:
                    resultURL,

                Occassion:
                    "KMFBinary withdrawal"

            },
            {

                headers: {

                    Authorization:
                        `Bearer ${accessToken}`,

                    "Content-Type":
                        "application/json"

                }

            }
        );

    console.log(
        "🔥 MPESA B2C RESPONSE:",
        response.data
    );

    return response.data;
}


// ==========================================
// MPESA B2C TRANSACTION STATUS
// ==========================================

app.get(
    "/api/mpesa/b2c/status/:originatorConversationID",
    async (req, res) => {

        try {

            const originatorConversationID =
                req.params.originatorConversationID;

            console.log(
                "===================================="
            );

            console.log(
                "🔎 MPESA B2C STATUS QUERY"
            );

            console.log(
                "OriginatorConversationID:",
                originatorConversationID
            );

            console.log(
                "===================================="
            );

            const accessToken =
                await getMpesaAccessToken();

            const shortcode =
                process.env.MPESA_B2C_SHORTCODE;

            const initiatorName =
                process.env.MPESA_B2C_INITIATOR_NAME;

            const securityCredential =
                process.env.MPESA_B2C_SECURITY_CREDENTIAL;

            const resultURL =
                process.env.MPESA_B2C_STATUS_RESULT_URL;

            const timeoutURL =
                process.env.MPESA_B2C_STATUS_TIMEOUT_URL;

            if (
                !shortcode ||
                !initiatorName ||
                !securityCredential ||
                !resultURL ||
                !timeoutURL
            ) {

                throw new Error(
                    "B2C status configuration is incomplete"
                );

            }

            const response =
                await axios.post(
                    "https://sandbox.safaricom.co.ke/mpesa/transactionstatus/v1/query",
                    {

                        Initiator:
                            initiatorName,

                        SecurityCredential:
                            securityCredential,

                        CommandID:
                            "TransactionStatusQuery",

                        TransactionID:
                            "",

                        OriginalConversationID:
                            originatorConversationID,

                        PartyA:
                            shortcode,

                        IdentifierType:
                            "4",

                        ResultURL:
                            resultURL,

                        QueueTimeOutURL:
                            timeoutURL,

                        Remarks:
                            "KMFBinary transaction status",

                        Occasion:
                            "KMFBinary status query"

                    },
                    {

                        headers: {

                            Authorization:
                                `Bearer ${accessToken}`,

                            "Content-Type":
                                "application/json"

                        }

                    }
                );

            console.log(
                "🔥 MPESA STATUS RESPONSE:",
                response.data
            );

            return res.json({

                success:
                    true,

                data:
                    response.data

            });

        } catch (error) {

            console.error(
                "❌ MPESA STATUS ERROR:",
                error.response?.data ||
                error.message
            );

            return res.status(500).json({

                success:
                    false,

                error:
                    error.response?.data ||
                    error.message

            });

        }

    }
);


// ==========================================
// GET CURRENT SYNTHETIC PRICES
// ==========================================

app.get(
    "/api/prices",
    (req, res) => {

        try {

            const prices =
                syntheticMarket.getAllPrices();

            return res.json({

                success:
                    true,

                prices

            });

        } catch (error) {

            console.error(
                "Price API error:",
                error
            );

            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to load market prices"

            });

        }

    }
);


// ==========================================
// HOME
// ==========================================

app.get(
    "/",
    (req, res) => {

        return res.json({

            success:
                true,

            message:
                "KMFBinary backend is running",

            mode:
                "synthetic-development"

        });

    }
);

// ==========================================
// GET ACTIVE MARKETS
// ==========================================
//
// Returns all active database markets plus
// the 1-second volatility markets.
//
// The 1S markets are generated here because
// they are already supported by synthetic-market.js
// but are not yet stored in the markets table.
// ==========================================

app.get(
    "/api/markets",
    async (req, res) => {

        try {

            const {
                data,
                error
            } = await supabase
                .from("markets")
                .select("*")
                .eq(
                    "is_active",
                    true
                )
                .order(
                    "market_name",
                    {
                        ascending:
                            true
                    }
                );

            if (error) {

                console.error(
                    "Markets error:",
                    error
                );

                return res.status(500).json({

                    success:
                        false,

                    message:
                        "Unable to load markets"

                });

            }

            /*
             * =================================================
             * EXISTING DATABASE MARKETS
             * =================================================
             */

            const markets =
                Array.isArray(data)
                    ? [...data]
                    : [];


            /*
             * =================================================
             * 1-SECOND VOLATILITY MARKETS
             * =================================================
             *
             * These markets already exist in the
             * synthetic market engine.
             *
             * They are added to the API response so
             * the frontend can display and select them.
             */

            // Load 1-second markets using their real database UUIDs.
            const {
                data: oneSecondMarkets,
                error: oneSecondMarketsError
            } = await supabase
                .from("markets")
                .select("*")
                .in("symbol", [
                    "VOL-10-1S",
                    "VOL-25-1S",
                    "VOL-50-1S",
                    "VOL-75-1S",
                    "VOL-100-1S"
                ])
                .eq("is_active", true);

            if (oneSecondMarketsError) {
                throw oneSecondMarketsError;
            }

            const existingSymbols = new Set(
                markets.map(market =>
                    String(market.symbol || "")
                        .trim()
                        .toUpperCase()
                )
            );

            (oneSecondMarkets || []).forEach(market => {
                const symbol = String(market.symbol || "")
                    .trim()
                    .toUpperCase();

                if (!existingSymbols.has(symbol)) {
                    markets.push(market);
                    existingSymbols.add(symbol);
                } else {
                    // Replace any synthetic entry with the real database row.
                    const index = markets.findIndex(existing =>
                        String(existing.symbol || "")
                            .trim()
                            .toUpperCase() === symbol
                    );

                    if (index !== -1) {
                        markets[index] = market;
                    }
                }
            });


            /*
             * =================================================
             * SORT MARKETS
             * =================================================
             *
             * Keep the normal alphabetical order,
             * including the new 1S markets.
             */

            markets.sort(
                (a, b) => {

                    const nameA =
                        String(
                            a.market_name ||
                            a.symbol ||
                            ""
                        );

                    const nameB =
                        String(
                            b.market_name ||
                            b.symbol ||
                            ""
                        );

                    return nameA.localeCompare(
                        nameB
                    );

                }
            );


            /*
             * =================================================
             * RESPONSE
             * =================================================
             */

            return res.json({

                success:
                    true,

                markets:
                    markets

            });

        }

        catch (error) {

            console.error(
                "Markets API error:",
                error
            );

            return res.status(500).json({

                success:
                    false,

                message:
                    "Server error"

            });

        }

    }
);


// ==========================================
// TEST DATABASE
// ==========================================

app.get(
    "/api/test-db",
    async (req, res) => {

        try {

            const {
                data,
                error
            } = await supabase
                .from("markets")
                .select("*")
                .limit(10);

            if (error) {

                return res.status(500).json({

                    success:
                        false,

                    message:
                        "Supabase connection failed"

                });

            }

            return res.json({

                success:
                    true,

                message:
                    "Supabase connection successful",

                markets:
                    data || []

            });

        } catch (error) {

            console.error(
                "Database test error:",
                error
            );

            return res.status(500).json({

                success:
                    false,

                message:
                    "Server error"

            });

        }

    }
);


// ==========================================
// WALLET
// ==========================================


// ==========================================
// GET USER WALLET
// ==========================================

app.get(
    "/api/wallet",
    authenticateUser,
    async (req, res) => {

        try {

            const wallet =
                await getOrCreateWallet(
                    req.user.id
                );

            return res.json({

                success:
                    true,

                wallet

            });

        } catch (error) {

            console.error(
                "Get wallet error:",
                error
            );

            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to load wallet"

            });

        }

    }
);


// ==========================================
// GET WALLET TRANSACTIONS
// ==========================================

app.get(
    "/api/wallet/transactions",
    authenticateUser,
    async (req, res) => {

        try {

            const {
                data,
                error
            } = await supabase
                .from("wallet_transactions")
                .select(`
                    id,
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
                    balance_after,
                    checkout_request_id,
                    merchant_request_id,
                    mpesa_receipt,
                    result_code,
                    result_description,
                    created_at
                `)
                .eq(
                    "user_id",
                    req.user.id
                )
                .order(
                    "created_at",
                    {
                        ascending:
                            false
                    }
                )
                .limit(100);

            if (error) {

                console.error(
                    "Wallet transactions error:",
                    error
                );

                return res.status(500).json({

                    success:
                        false,

                    message:
                        "Unable to load wallet transactions"

                });

            }

            return res.json({

                success:
                    true,

                transactions:
                    data || []

            });

        } catch (error) {

            console.error(
                "Wallet transactions API error:",
                error
            );

            return res.status(500).json({

                success:
                    false,

                message:
                    "Server error"

            });

        }

    }
);


// ==========================================
// GENERIC DEPOSIT REQUEST
// ==========================================

app.post(
    "/api/wallet/deposit",
    authenticateUser,
    async (req, res) => {

        try {

            const amount =
                Number(
                    req.body.amount
                );

            const paymentMethod =
                String(
                    req.body.paymentMethod || ""
                )
                    .trim()
                    .toLowerCase();

            if (
                !Number.isFinite(amount) ||
                amount < 2
            ) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Minimum deposit is $2.00"

                });

            }

            if (!paymentMethod) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Payment method is required"

                });

            }

            await getOrCreateWallet(
                req.user.id
            );

            const depositAmount =
                Math.round(
                    amount * 1000000
                ) / 1000000;

            const reference =
                "DEP-" +
                Date.now() +
                "-" +
                crypto
                    .randomBytes(4)
                    .toString("hex")
                    .toUpperCase();

            const {
                data: transaction,
                error
            } = await supabase
                .from("wallet_transactions")
                .insert({

                    user_id:
                        req.user.id,

                    transaction_type:
                        "deposit",

                    amount:
                        depositAmount,

                    status:
                        "pending",

                    payment_method:
                        paymentMethod,

                    reference:
                        reference

                })
                .select()
                .single();

            if (error) {

                console.error(
                    "Deposit transaction error:",
                    error
                );

                return res.status(500).json({

                    success:
                        false,

                    message:
                        "Unable to create deposit request"

                });

            }

            return res.json({

                success:
                    true,

                message:
                    "Deposit request created. Payment is pending confirmation.",

                deposit:
                    transaction

            });

        } catch (error) {

            console.error(
                "Deposit API error:",
                error
            );

            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to process deposit"

            });

        }

    }
);


// ==========================================
// MPESA API DEBUG
// ==========================================

app.use(
    "/api/mpesa",
    (req, res, next) => {

        console.log(
            "🔥 MPESA API REQUEST:",
            req.method,
            req.originalUrl
        );

        next();

    }
);


// ==========================================
// MPESA STK PUSH
// ==========================================

app.post(
    "/api/mpesa/stkpush",
    authenticateUser,
    async (req, res) => {

        console.log(
            "🔥 MPESA STK REQUEST RECEIVED"
        );

        try {

            const amount =
                Number(
                    req.body.amount
                );

            let phoneNumber =
                String(
                    req.body.phoneNumber || ""
                )
                    .trim()
                    .replace(/\s+/g, "");


            // ==========================================
            // VALIDATE AMOUNT
            // ==========================================

            if (
                !Number.isFinite(amount) ||
                amount < 0.01
            ) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Amount must be at least $0.01"

                });

            }


            // ==========================================
            // NORMALIZE PHONE
            // ==========================================

            if (
                /^07\d{8}$/.test(
                    phoneNumber
                )
            ) {

                phoneNumber =
                    "254" +
                    phoneNumber.substring(1);

            }

            if (
                /^\+2547\d{8}$/.test(
                    phoneNumber
                )
            ) {

                phoneNumber =
                    phoneNumber.substring(1);

            }

            if (
                !/^2547\d{8}$/.test(
                    phoneNumber
                )
            ) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Use phone format 2547XXXXXXXX"

                });

            }


            // ==========================================
            // MAKE SURE WALLET EXISTS
            // ==========================================

            await getOrCreateWallet(
                req.user.id
            );


            // ==========================================
            // PRECISE USD AMOUNT
            // ==========================================

            const depositAmount =
                Math.round(
                    Number(amount) *
                    1000000
                ) / 1000000;

            if (
                !Number.isFinite(
                    depositAmount
                ) ||
                depositAmount <= 0
            ) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Invalid deposit amount"

                });

            }


            // ==========================================
            // KES AMOUNT
            // ==========================================

            const kesAmount =
                Math.round(
                    depositAmount *
                    USD_KES_DEPOSIT_RATE
                );

            if (
                !Number.isFinite(
                    kesAmount
                ) ||
                kesAmount < 1
            ) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Deposit amount is too small"

                });

            }


            // ==========================================
            // CREATE DEPOSIT TRANSACTION
            // ==========================================

            const reference =
                "DEP-" +
                Date.now() +
                "-" +
                crypto
                    .randomBytes(4)
                    .toString("hex")
                    .toUpperCase();

            const {
                data: transaction,
                error: transactionError
            } = await supabase
                .from("wallet_transactions")
                .insert({

                    user_id:
                        req.user.id,

                    transaction_type:
                        "deposit",

                    type:
                        "deposit",

                    amount:
                        depositAmount,

                    status:
                        "pending",

                    payment_method:
                        "mpesa",

                    reference:
                        reference,

                    description:
                        "M-Pesa deposit"

                })
                .select()
                .single();

            if (transactionError) {

                console.error(
                    "M-Pesa transaction insert error:",
                    transactionError
                );

                return res.status(500).json({

                    success:
                        false,

                    message:
                        "Unable to create payment transaction"

                });

            }


            // ==========================================
            // SEND STK PUSH
            // ==========================================

            let mpesaResponse;

            try {

                console.log(
                    "=========================================="
                );

                console.log(
                    "STK USD amount:",
                    depositAmount
                );

                console.log(
                    "KES amount sent:",
                    kesAmount
                );

                console.log(
                    "Reference:",
                    reference
                );

                console.log(
                    "=========================================="
                );

                mpesaResponse =
                    await initiateMpesaStkPush({

                        phoneNumber:
                            phoneNumber,

                        amount:
                            kesAmount,

                        accountReference:
                            reference,

                        transactionDescription:
                            "KMFBinary Deposit"

                    });

            } catch (mpesaError) {

                console.error(
                    "M-Pesa STK request failed:",
                    mpesaError.response?.data ||
                    mpesaError.message
                );

                await supabase
                    .from("wallet_transactions")
                    .update({

                        status:
                            "failed",

                        result_description:
                            mpesaError.response?.data
                                ?.errorMessage ||
                            mpesaError.message ||
                            "M-Pesa STK Push failed"

                    })
                    .eq(
                        "id",
                        transaction.id
                    )
                    .eq(
                        "status",
                        "pending"
                    );

                return res.status(502).json({

                    success:
                        false,

                    message:
                        "Unable to send M-Pesa payment prompt"

                });

            }


            console.log(
                "M-Pesa STK response:",
                mpesaResponse
            );


            // ==========================================
            // CHECK MPESA RESPONSE
            // ==========================================

            if (
                String(
                    mpesaResponse?.ResponseCode
                ) !== "0"
            ) {

                const failureMessage =
                    mpesaResponse?.ResponseDescription ||
                    mpesaResponse?.errorMessage ||
                    "M-Pesa STK Push failed";

                await supabase
                    .from("wallet_transactions")
                    .update({

                        status:
                            "failed",

                        result_code:
                            String(
                                mpesaResponse?.ResponseCode ||
                                ""
                            ),

                        result_description:
                            failureMessage

                    })
                    .eq(
                        "id",
                        transaction.id
                    )
                    .eq(
                        "status",
                        "pending"
                    );

                return res.status(400).json({

                    success:
                        false,

                    message:
                        failureMessage

                });

            }


            // ==========================================
            // SAVE MPESA REQUEST IDS
            // ==========================================

            const {
                error: updateError
            } = await supabase
                .from("wallet_transactions")
                .update({

                    checkout_request_id:
                        mpesaResponse.CheckoutRequestID,

                    merchant_request_id:
                        mpesaResponse.MerchantRequestID

                })
                .eq(
                    "id",
                    transaction.id
                );

            if (updateError) {

                console.error(
                    "Unable to save M-Pesa request IDs:",
                    updateError
                );

            }


            // ==========================================
            // RESPONSE
            // ==========================================

            return res.json({

                success:
                    true,

                message:
                    "M-Pesa payment prompt sent. Enter your PIN on your phone.",

                reference:
                    reference,

                checkoutRequestId:
                    mpesaResponse.CheckoutRequestID,

                merchantRequestId:
                    mpesaResponse.MerchantRequestID,

                transactionId:
                    transaction.id,

                amountUSD:
                    depositAmount,

                amountKES:
                    kesAmount

            });

        } catch (error) {

            console.error(
                "M-Pesa STK Push error:",
                error
            );

            return res.status(500).json({

                success:
                    false,

                message:
                    error.message ||
                    "Unable to initiate M-Pesa payment"

            });

        }

    }
);


// ==========================================
// MPESA STK QUERY ROUTE
// ==========================================
//
// This route only queries Safaricom.
// It does NOT blindly credit the wallet.
// ==========================================

app.get(
    "/api/mpesa/stkpush/query/:checkoutRequestId",
    authenticateUser,
    async (req, res) => {

        try {

            const checkoutRequestId =
                String(
                    req.params.checkoutRequestId || ""
                ).trim();

            if (!checkoutRequestId) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "CheckoutRequestID is required"

                });

            }


            // ==========================================
            // FIND USER'S TRANSACTION
            // ==========================================

            const {
                data: transaction,
                error: transactionError
            } = await supabase
                .from("wallet_transactions")
                .select("*")
                .eq(
                    "user_id",
                    req.user.id
                )
                .eq(
                    "checkout_request_id",
                    checkoutRequestId
                )
                .eq(
                    "transaction_type",
                    "deposit"
                )
                .maybeSingle();

            if (transactionError) {

                console.error(
                    "STK query transaction lookup error:",
                    transactionError
                );

                return res.status(500).json({

                    success:
                        false,

                    message:
                        "Unable to find deposit transaction"

                });

            }

            if (!transaction) {

                return res.status(404).json({

                    success:
                        false,

                    message:
                        "Deposit transaction not found"

                });

            }


            // ==========================================
            // ALREADY COMPLETED
            // ==========================================

            if (
                transaction.status ===
                "completed"
            ) {

                return res.json({

                    success:
                        true,

                    status:
                        "completed",

                    message:
                        "This deposit has already been completed.",

                    transaction

                });

            }


            // ==========================================
            // QUERY SAFARICOM
            // ==========================================

            const mpesaResponse =
                await queryMpesaStkPush(
                    checkoutRequestId
                );


            return res.json({

                success:
                    true,

                status:
                    transaction.status,

                transaction:

                    transaction,

                mpesa:
                    mpesaResponse

            });

        } catch (error) {

            console.error(
                "STK Push Query error:",
                error.response?.data ||
                error.message
            );

            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to query M-Pesa payment",

                error:
                    error.response?.data ||
                    error.message

            });

        }

    }
);


// ==========================================
// MPESA CALLBACK
// ==========================================

app.post(
    "/api/mpesa/callback",
    async (req, res) => {

        console.log(
            "=========================================="
        );

        console.log(
            "🔥 MPESA CALLBACK RECEIVED"
        );

        console.log(
            JSON.stringify(
                req.body,
                null,
                2
            )
        );

        console.log(
            "=========================================="
        );


        // ==========================================
        // ACKNOWLEDGE SAFARICOM IMMEDIATELY
        // ==========================================

        res.status(200).json({

            ResultCode:
                0,

            ResultDesc:
                "Callback received successfully"

        });


        try {

            const stkCallback =
                req.body?.Body?.stkCallback;

            if (!stkCallback) {

                console.error(
                    "Invalid M-Pesa callback structure"
                );

                return;
            }


            const checkoutRequestId =
                stkCallback.CheckoutRequestID;

            const merchantRequestId =
                stkCallback.MerchantRequestID;

            const resultCode =
                String(
                    stkCallback.ResultCode
                );

            const resultDescription =
                stkCallback.ResultDesc ||
                "";


            if (!checkoutRequestId) {

                console.error(
                    "Missing CheckoutRequestID"
                );

                return;
            }


            // ==========================================
            // FIND DEPOSIT
            // ==========================================

            const {
                data: transaction,
                error
            } = await supabase
                .from("wallet_transactions")
                .select("*")
                .eq(
                    "checkout_request_id",
                    checkoutRequestId
                )
                .eq(
                    "transaction_type",
                    "deposit"
                )
                .maybeSingle();

            if (error) {

                console.error(
                    "M-Pesa transaction lookup error:",
                    error
                );

                return;
            }

            if (!transaction) {

                console.error(
                    "Deposit transaction not found:",
                    checkoutRequestId
                );

                return;
            }


            // ==========================================
            // DUPLICATE PROTECTION
            // ==========================================

            if (
                transaction.status ===
                "completed"
            ) {

                console.log(
                    "Deposit already completed:",
                    transaction.reference
                );

                return;
            }


            // ==========================================
            // FAILED PAYMENT
            // ==========================================

            if (
                Number(
                    stkCallback.ResultCode
                ) !== 0
            ) {

                const {
                    error: failedUpdateError
                } = await supabase
                    .from("wallet_transactions")
                    .update({

                        status:
                            "failed",

                        result_code:
                            resultCode,

                        result_description:
                            resultDescription,

                        merchant_request_id:
                            merchantRequestId

                    })
                    .eq(
                        "id",
                        transaction.id
                    )
                    .eq(
                        "status",
                        "pending"
                    );

                if (failedUpdateError) {

                    console.error(
                        "Failed payment update error:",
                        failedUpdateError
                    );

                }

                console.log(
                    "M-Pesa payment failed:",
                    transaction.reference,
                    resultDescription
                );

                return;
            }


            // ==========================================
            // READ CALLBACK METADATA
            // ==========================================

            const items =
                stkCallback
                    .CallbackMetadata
                    ?.Item || [];

            function getMetadataValue(name) {

                const item =
                    items.find(
                        x =>
                            x.Name === name
                    );

                return item
                    ? item.Value
                    : null;
            }


            const mpesaReceipt =
                getMetadataValue(
                    "MpesaReceiptNumber"
                );

            const callbackAmountKES =
                Number(
                    getMetadataValue(
                        "Amount"
                    )
                );

            const phoneNumber =
                getMetadataValue(
                    "PhoneNumber"
                );


            // ==========================================
            // VALIDATE STORED USD
            // ==========================================

            const depositAmountUSD =
                Number(
                    transaction.amount
                );

            if (
                !Number.isFinite(
                    depositAmountUSD
                ) ||
                depositAmountUSD <= 0
            ) {

                console.error(
                    "Invalid stored deposit amount:",
                    transaction.amount
                );

                return;
            }


            // ==========================================
            // EXPECTED KES
            // ==========================================

            const expectedAmountKES =
                Math.max(
                    1,
                    Math.round(
                        depositAmountUSD *
                        USD_KES_DEPOSIT_RATE
                    )
                );


            console.log(
                "M-Pesa amount verification:",
                {

                    depositUSD:
                        depositAmountUSD,

                    expectedKES:
                        expectedAmountKES,

                    receivedKES:
                        callbackAmountKES,

                    rate:
                        USD_KES_DEPOSIT_RATE

                }
            );


            // ==========================================
            // VERIFY KES AMOUNT
            // ==========================================

            if (
                !Number.isFinite(
                    callbackAmountKES
                ) ||
                callbackAmountKES !==
                    expectedAmountKES
            ) {

                console.error(
                    "M-Pesa amount mismatch:",
                    {

                        expectedKES:
                            expectedAmountKES,

                        receivedKES:
                            callbackAmountKES,

                        depositUSD:
                            depositAmountUSD,

                        reference:
                            transaction.reference

                    }
                );

                await supabase
                    .from("wallet_transactions")
                    .update({

                        status:
                            "failed",

                        result_code:
                            "AMOUNT_MISMATCH",

                        result_description:
                            "M-Pesa KES amount does not match expected deposit amount",

                        merchant_request_id:
                            merchantRequestId

                    })
                    .eq(
                        "id",
                        transaction.id
                    )
                    .eq(
                        "status",
                        "pending"
                    );

                return;
            }


            // ==========================================
            // REQUIRE MPESA RECEIPT
            // ==========================================

            if (!mpesaReceipt) {

                console.error(
                    "M-Pesa receipt missing"
                );

                return;
            }


            // ==========================================
            // CONVERT KES → USD
            // ==========================================

            const creditedUSD =
                Math.round(
                    (
                        callbackAmountKES /
                        USD_KES_DEPOSIT_RATE
                    ) *
                    1000000
                ) / 1000000;


            // ==========================================
            // GET WALLET
            // ==========================================

            const wallet =
                await getOrCreateWallet(
                    transaction.user_id
                );

            const currentBalance =
                Number(
                    wallet.balance
                );

            if (
                !Number.isFinite(
                    currentBalance
                )
            ) {

                console.error(
                    "Invalid wallet balance:",
                    wallet.balance
                );

                return;
            }


            // ==========================================
            // IMPORTANT:
            // CLAIM TRANSACTION BEFORE CREDITING
            // ==========================================

            const {
                data: claimedTransaction,
                error: claimError
            } = await supabase
                .from("wallet_transactions")
                .update({

                    status:
                        "processing",

                    merchant_request_id:
                        merchantRequestId,

                    mpesa_receipt:
                        String(
                            mpesaReceipt
                        ),

                    result_code:
                        resultCode,

                    result_description:
                        resultDescription

                })
                .eq(
                    "id",
                    transaction.id
                )
                .eq(
                    "status",
                    "pending"
                )
                .select()
                .maybeSingle();

            if (claimError) {

                console.error(
                    "Deposit claim error:",
                    claimError
                );

                return;
            }

            if (!claimedTransaction) {

                console.log(
                    "Deposit was already claimed or processed:",
                    transaction.reference
                );

                return;
            }

            // ==========================================
            // CALCULATE NEW REAL BALANCE
            // ==========================================
            //
            // IMPORTANT:
            // The actual deposit always goes into
            // wallet.balance.
            //
            // wallet.balance = withdrawable money
            // wallet.bonus_balance = trading-only bonus
            //
            // The bonus is NEVER added to balance.
            // ==========================================

            const newBalance =
                Math.round(
                    (
                        currentBalance +
                        creditedUSD
                    ) *
                    1000000
                ) / 1000000;


            // ==========================================
            // CREDIT REAL WALLET BALANCE
            // ==========================================

            const {
                data: updatedWallet,
                error: walletError
            } = await supabase
                .from("wallets")
                .update({

                    balance:
                        newBalance,

                    updated_at:
                        new Date().toISOString()

                })
                .eq(
                    "id",
                    wallet.id
                )
                .eq(
                    "balance",
                    currentBalance
                )
                .select()
                .maybeSingle();


            if (walletError) {

                console.error(
                    "Wallet credit error:",
                    walletError
                );


                // Return transaction to pending
                // so it can be reconciled safely.
                await supabase
                    .from("wallet_transactions")
                    .update({

                        status:
                            "pending"

                    })
                    .eq(
                        "id",
                        transaction.id
                    )
                    .eq(
                        "status",
                        "processing"
                    );

                return;
            }


            if (!updatedWallet) {

                console.error(
                    "Wallet balance changed before deposit credit."
                );

                await supabase
                    .from("wallet_transactions")
                    .update({

                        status:
                            "pending",

                        result_description:
                            "Wallet changed before deposit credit; reconciliation required."

                    })
                    .eq(
                        "id",
                        transaction.id
                    )
                    .eq(
                        "status",
                        "processing"
                    );

                return;
            }


            // ==========================================
            // APPLY DEPOSIT PROMOTION
            // ==========================================
            //
            // The real deposit has already been credited.
            //
            // The promotional amount goes ONLY into:
            //
            // wallet.bonus_balance
            //
            // It does NOT increase wallet.balance.
            // ==========================================

            let depositBonus = 0;
            let appliedPromotion = null;
            let userBonusRecord = null;

            try {

                const bonusResult =
                    await calculateDepositBonus(
                        transaction.user_id,
                        creditedUSD,
                        transaction.id
                    );


                depositBonus =
                    Number(
                        bonusResult?.bonusAmount || 0
                    );


                appliedPromotion =
                    bonusResult?.promotion ||
                    null;


                if (
                    depositBonus > 0 &&
                    appliedPromotion
                ) {

                    // --------------------------------------
                    // CREDIT PROMOTIONAL BALANCE
                    // --------------------------------------

                    await addBonusToWallet(
                        transaction.user_id,
                        depositBonus
                    );


                    // --------------------------------------
                    // RECORD BONUS
                    // --------------------------------------

                    userBonusRecord =
                        await createUserBonus(
                            transaction.user_id,
                            appliedPromotion,
                            creditedUSD,
                            depositBonus,
                            transaction.id
                        );


                    console.log(
                        "=========================================="
                    );

                    console.log(
                        "🎁 KMFBINARY DEPOSIT BONUS APPLIED"
                    );

                    console.log(
                        "User:",
                        transaction.user_id
                    );

                    console.log(
                        "Deposit USD:",
                        creditedUSD
                    );

                    console.log(
                        "Promotion:",
                        appliedPromotion.name
                    );

                    console.log(
                        "Promotion Type:",
                        appliedPromotion.type
                    );

                    console.log(
                        "Bonus Percent:",
                        appliedPromotion.bonus_percent
                    );

                    console.log(
                        "Bonus Amount:",
                        depositBonus
                    );

                    console.log(
                        "=========================================="
                    );

                }
                else {

                    console.log(
                        "No eligible deposit promotion for:",
                        transaction.user_id
                    );

                }

            } catch (bonusError) {

                /*
                 * IMPORTANT:
                 *
                 * The customer's real deposit has already
                 * been credited safely.
                 *
                 * Therefore we do NOT reverse the customer's
                 * deposit merely because promotional processing
                 * failed.
                 *
                 * The error is logged for reconciliation.
                 */

                console.error(
                    "DEPOSIT PROMOTION PROCESSING ERROR:",
                    bonusError
                );

            }


            
            // ==========================================
            // RECORD REFERRAL COMMISSION
            // ==========================================
            //
            // Rules:
            // - Minimum qualifying deposit: $8 USD
            // - Admin-selected rate: 5% or 10%
            // - Find referrer through the referrals table
            // - Record earnings only; never credit a wallet
            // - Unique deposit_id prevents duplicate records
            // ==========================================

            let referralCommissionAmount = 0;
            let referralCommissionPercent = 0;

            try {

                if (creditedUSD >= 8) {

                    // --------------------------------------
                    // FIND THE REFERRAL RELATIONSHIP
                    // --------------------------------------

                    const {
                        data: referral,
                        error: referralLookupError
                    } = await supabase
                        .from("referrals")
                        .select("referrer_id, referred_user_id")
                        .eq(
                            "referred_user_id",
                            transaction.user_id
                        )
                        .maybeSingle();

                    if (referralLookupError) {
                        throw referralLookupError;
                    }

                    const referrerId =
                        referral?.referrer_id || null;

                    // --------------------------------------
                    // READ THE ADMIN COMMISSION SETTING
                    // --------------------------------------

                    if (
                        referrerId &&
                        referrerId !== transaction.user_id
                    ) {

                        const {
                            data: referralSettings,
                            error: settingsError
                        } = await supabase
                            .from("referral_settings")
                            .select(
                                "commission_percent, minimum_deposit"
                            )
                            .eq("id", 1)
                            .single();

                        if (settingsError) {
                            throw settingsError;
                        }

                        referralCommissionPercent =
                            Number(
                                referralSettings.commission_percent
                            );

                        const minimumDeposit =
                            Number(
                                referralSettings.minimum_deposit
                            );

                        // Accept only the two permitted rates.
                        if (
                            ![5, 10].includes(
                                referralCommissionPercent
                            )
                        ) {
                            throw new Error(
                                "Invalid referral commission rate."
                            );
                        }

                        // Recheck the minimum using the stored setting.
                        if (creditedUSD >= minimumDeposit) {

                            referralCommissionAmount =
                                Number(
                                    (
                                        creditedUSD *
                                        referralCommissionPercent /
                                        100
                                    ).toFixed(6)
                                );

                            if (
                                referralCommissionAmount > 0
                            ) {

                                // ----------------------------------
                                // RECORD COMMISSION ONLY
                                // NO WALLET CREDIT
                                // ----------------------------------

                                const {
                                    error: commissionRecordError
                                } = await supabase
                                    .from("referral_commissions")
                                    .insert({
                                        referrer_id:
                                            referrerId,

                                        referred_user_id:
                                            transaction.user_id,

                                        deposit_id:
                                            transaction.id,

                                        deposit_amount:
                                            creditedUSD,

                                        commission_percent:
                                            referralCommissionPercent,

                                        commission_amount:
                                            referralCommissionAmount,

                                        status:
                                            "earned"
                                    });

                                if (commissionRecordError) {

                                    // A duplicate deposit commission
                                    // must not be recorded twice.
                                    if (
                                        commissionRecordError.code ===
                                        "23505"
                                    ) {

                                        console.log(
                                            "Referral commission already recorded for deposit:",
                                            transaction.id
                                        );

                                        referralCommissionAmount = 0;

                                    } else {

                                        throw commissionRecordError;

                                    }
                                } else {

                                    console.log(
                                        "=========================================="
                                    );

                                    console.log(
                                        "🤝 REFERRAL COMMISSION RECORDED"
                                    );

                                    console.log(
                                        "Referrer:",
                                        referrerId
                                    );

                                    console.log(
                                        "Referred User:",
                                        transaction.user_id
                                    );

                                    console.log(
                                        "Deposit USD:",
                                        creditedUSD
                                    );

                                    console.log(
                                        "Commission Percent:",
                                        referralCommissionPercent
                                    );

                                    console.log(
                                        "Commission USD:",
                                        referralCommissionAmount
                                    );

                                    console.log(
                                        "Status: earned (not paid)"
                                    );

                                    console.log(
                                        "=========================================="
                                    );
                                }
                            }
                        }
                    }
                } else {

                    console.log(
                        "Referral commission skipped: deposit is below $8 USD.",
                        creditedUSD
                    );
                }

            } catch (referralError) {

                // The customer's deposit has already been credited.
                // Never reverse it because referral processing failed.

                console.error(
                    "REFERRAL COMMISSION PROCESSING ERROR:",
                    referralError
                );

            }
            // ==========================================
            // CALCULATE FINAL TRADING BALANCE
            // ==========================================
const {
    data: latestWallet,
    error: latestWalletError
} = await supabase
    .from("wallets")
    .select(
        "id, balance, bonus_balance, demo_balance, currency"
    )
    .eq(
        "id",
        wallet.id
    )
    .maybeSingle();

if (latestWalletError) {
    console.error(
        "Unable to reload wallet after deposit promotion:",
        latestWalletError
    );
}

const finalWallet =
    latestWallet ||
    updatedWallet;

const finalBonusBalance =
    Number(
        finalWallet.bonus_balance || 0
    );

const finalTradingBalance =
    Number(
        (
            Number(
                finalWallet.balance || 0
            ) +
            finalBonusBalance
        ).toFixed(6)
    );


            // ==========================================
            // COMPLETE TRANSACTION
            // ==========================================

            const {
                data: completedTransaction,
                error: completionError
            } = await supabase
                .from("wallet_transactions")
                .update({

                    status:
                        "completed",

                    merchant_request_id:
                        merchantRequestId,

                    mpesa_receipt:
                        String(
                            mpesaReceipt
                        ),

                    result_code:
                        resultCode,

                    result_description:
                        resultDescription,

                    balance_before:
                        currentBalance,

                    balance_after:
                        newBalance

                })
                .eq(
                    "id",
                    transaction.id
                )
                .eq(
                    "status",
                    "processing"
                )
                .select()
                .maybeSingle();


            if (completionError) {

                console.error(
                    "Transaction completion error:",
                    completionError
                );

                return;
            }


            if (!completedTransaction) {

                console.log(
                    "Deposit completion was already handled:",
                    transaction.reference
                );

                return;
            }


            // ==========================================
            // SUCCESS LOG
            // ==========================================

            console.log(
                "=========================================="
            );

            console.log(
                "💰 MPESA PAYMENT SUCCESS"
            );

            console.log(
                "Reference:",
                transaction.reference
            );

            console.log(
                "User:",
                transaction.user_id
            );

            console.log(
                "M-Pesa Amount:",
                callbackAmountKES,
                "KES"
            );

            console.log(
                "USD Credited:",
                creditedUSD,
                "USD"
            );

            console.log(
                "Deposit Real Balance:",
                newBalance,
                "USD"
            );

            console.log(
                "Deposit Bonus:",
                depositBonus,
                "USD"
            );

            console.log(
                "Final Trading Balance:",
                finalTradingBalance,
                "USD"
            );

            console.log(
                "Referral Commission:",
                referralCommissionAmount,
                "USD"
            );

            console.log(
                "Receipt:",
                mpesaReceipt
            );

            console.log(
                "Phone:",
                phoneNumber
            );

            console.log(
                "Old Balance:",
                currentBalance
            );

            console.log(
                "New Balance:",
                updatedWallet.balance
            );

            console.log(
                "=========================================="
            );
            // ==========================================
            // SUCCESS LOG
            // ==========================================

            console.log(
                "=========================================="
            );

            console.log(
                "💰 MPESA PAYMENT SUCCESS"
            );

            console.log(
                "Reference:",
                transaction.reference
            );

            console.log(
                "User:",
                transaction.user_id
            );

            console.log(
                "M-Pesa Amount:",
                callbackAmountKES,
                "KES"
            );

            console.log(
                "USD Credited:",
                creditedUSD,
                "USD"
            );

            console.log(
                "Receipt:",
                mpesaReceipt
            );

            console.log(
                "Phone:",
                phoneNumber
            );

            console.log(
                "Old Balance:",
                currentBalance
            );

            console.log(
                "New Balance:",
                updatedWallet.balance
            );

            console.log(
                "=========================================="
            );

        } catch (error) {

            console.error(
                "M-Pesa callback processing error:",
                error
            );

        }

    }
);
// ==========================================
// KYC / WITHDRAWAL VERIFICATION
// ==========================================

async function getUserKycStatus(userId) {
    const { data, error } = await supabase
        .from("kyc_verifications")
        .select("id,status,rejection_reason,reviewed_at")
        .eq("user_id", userId)
        .maybeSingle();

    if (error) {
        throw error;
    }

    if (!data) {
        return {
            exists: false,
            status: "unverified",
            rejection_reason: null,
            reviewed_at: null
        };
    }

    return {
        exists: true,
        status: String(data.status || "unverified").toLowerCase(),
        rejection_reason: data.rejection_reason || null,
        reviewed_at: data.reviewed_at || null
    };
}


// ==========================================
// CHECK WHETHER USER HAS COMPLETED DEPOSIT
// ==========================================
async function userHasCompletedDeposit(userId) {
    try {
        const { data, error } = await supabase
            .from("wallet_transactions")
            .select("id, amount, status, transaction_type, type, payment_method")
            .eq("user_id", userId)
            .eq("status", "completed")
            .or("transaction_type.eq.deposit,type.eq.deposit")
            .limit(1);

        if (error) {
            console.error(
                "COMPLETED DEPOSIT CHECK ERROR:",
                error
            );

            throw error;
        }

        return Array.isArray(data) && data.length > 0;

    } catch (error) {

        console.error(
            "userHasCompletedDeposit ERROR:",
            error
        );

        throw error;
    }
}
// ==========================================
// GET WITHDRAWAL ELIGIBILITY
// ==========================================

app.get(
    "/api/wallet/withdrawal-status",
    authenticateUser,
    async (req, res) => {

        try {

            const userId =
                req.user.id;


            // ==========================================
            // LOAD USER ROLE
            // ==========================================

            const {
                data: withdrawalProfile,
                error: withdrawalProfileError
            } = await supabase
                .from("profiles")
                .select("role")
                .eq(
                    "id",
                    userId
                )
                .maybeSingle();


            if (
                withdrawalProfileError
            ) {

                console.error(
                    "WITHDRAWAL STATUS ROLE LOOKUP ERROR:",
                    withdrawalProfileError
                );

                return res.status(500).json({

                    success: false,

                    message:
                        "Unable to verify withdrawal permissions."

                });

            }


            // ==========================================
            // NORMALIZE USER ROLE
            // ==========================================

            const withdrawalUserRole =
                String(
                    withdrawalProfile?.role ||
                    ""
                )
                .trim()
                .toLowerCase();


            // ==========================================
            // ROLES EXEMPT FROM KYC
            // ==========================================

            const verificationExemptRoles = [

                "admin",
                "super_admin",
                "owner"

            ];


            const isVerificationExempt =
                verificationExemptRoles.includes(
                    withdrawalUserRole
                );


            // ==========================================
            // CHECK COMPLETED DEPOSIT
            // ==========================================
            //
            // IMPORTANT:
            // This requirement applies to EVERYONE,
            // including admin, super_admin and owner.
            //
            // ==========================================

            const hasCompletedDeposit =
                await userHasCompletedDeposit(
                    userId
                );


            if (
                !hasCompletedDeposit
            ) {

                return res.json({

                    success: true,

                    canWithdraw:
                        false,

                    reason:
                        "no_deposit",

                    kycStatus:
                        isVerificationExempt
                            ? "exempt"
                            : "unverified",

                    userRole:
                        withdrawalUserRole,

                    verificationExempt:
                        isVerificationExempt,

                    message:
                        "Make a deposit first before requesting a withdrawal."

                });

            }


            // ==========================================
            // KYC EXEMPTION
            // ==========================================
            //
            // admin
            // super_admin
            // owner
            //
            // do NOT need approved KYC.
            //
            // ==========================================

            if (
                isVerificationExempt
            ) {

                console.log(
                    "WITHDRAWAL STATUS - KYC BYPASSED"
                );

                console.log(
                    "USER:",
                    userId
                );

                console.log(
                    "USER ROLE:",
                    withdrawalUserRole
                );


                return res.json({

                    success: true,

                    canWithdraw:
                        true,

                    reason:
                        "role_exempt",

                    kycStatus:
                        "exempt",

                    userRole:
                        withdrawalUserRole,

                    verificationExempt:
                        true,

                    message:
                        "Withdrawal verification bypassed for administrator account."

                });

            }


            // ==========================================
            // NORMAL USER KYC CHECK
            // ==========================================
            //
            // Only normal users reach this section.
            //
            // They MUST have approved KYC.
            //
            // ==========================================

            const kyc =
                await getUserKycStatus(
                    userId
                );


            if (
                kyc.status !== "approved"
            ) {

                return res.json({

                    success: true,

                    canWithdraw:
                        false,

                    reason:
                        "verification_required",

                    kycStatus:
                        kyc.status,

                    rejectionReason:
                        kyc.rejection_reason ||
                        null,

                    userRole:
                        withdrawalUserRole,

                    verificationExempt:
                        false,

                    message:
                        kyc.status === "pending"
                            ? "Your verification is under review."
                            : kyc.status === "rejected"
                                ? "Your verification was rejected. Please submit it again."
                                : "Identity verification is required before withdrawal."

                });

            }


            // ==========================================
            // NORMAL USER APPROVED
            // ==========================================

            return res.json({

                success: true,

                canWithdraw:
                    true,

                reason:
                    "approved",

                kycStatus:
                    "approved",

                userRole:
                    withdrawalUserRole,

                verificationExempt:
                    false,

                message:
                    "Verification approved. You can withdraw."

            });


        } catch (error) {

            console.error(
                "Withdrawal eligibility error:",
                error
            );


            return res.status(500).json({

                success: false,

                message:
                    "Unable to check withdrawal eligibility."

            });

        }

    }
);

// ==========================================
// GET USER KYC STATUS
// ==========================================

app.get(
    "/api/kyc/status",
    authenticateUser,
    async (req, res) => {

        try {

            const kyc =
                await getUserKycStatus(req.user.id);

            return res.json({
                success: true,
                kyc
            });

        } catch (error) {

            console.error(
                "KYC status error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Unable to load verification status."
            });

        }

    }
);

// ==========================================
// SUBMIT KYC DETAILS
// ==========================================

app.post(
    "/api/kyc/submit",
    authenticateUser,
    kycUpload.fields([
        {
            name: "id_front",
            maxCount: 1
        },
        {
            name: "id_back",
            maxCount: 1
        },
        {
            name: "selfie",
            maxCount: 1
        },
        {
            name: "proof_of_address",
            maxCount: 1
        }
    ]),
    async (req, res) => {

        try {

            const userId = req.user.id;

            // ------------------------------------------
            // READ FORM DATA
            // ------------------------------------------

            const fullLegalName =
                String(
                    req.body.full_legal_name ||
                    req.body.fullLegalName ||
                    ""
                ).trim();

            const dateOfBirth =
                String(
                    req.body.date_of_birth ||
                    req.body.dateOfBirth ||
                    ""
                ).trim();

            const countryOfResidence =
                String(
                    req.body.country_of_residence ||
                    req.body.countryOfResidence ||
                    ""
                ).trim();

            const phoneNumber =
                String(
                    req.body.phone_number ||
                    req.body.phoneNumber ||
                    ""
                ).trim();

            const residentialAddress =
                String(
                    req.body.residential_address ||
                    req.body.residentialAddress ||
                    ""
                ).trim();

            const governmentIdType =
                String(
                    req.body.government_id_type ||
                    req.body.governmentIdType ||
                    ""
                ).trim();

            const governmentIdNumber =
                String(
                    req.body.government_id_number ||
                    req.body.governmentIdNumber ||
                    ""
                ).trim();

            const declarationValue =
                req.body.declaration_accepted ??
                req.body.declarationAccepted;

            const declarationAccepted =
                declarationValue === true ||
                String(declarationValue).toLowerCase() === "true" ||
                String(declarationValue) === "1" ||
                String(declarationValue).toLowerCase() === "on";


            // ------------------------------------------
            // VALIDATE REQUIRED DETAILS
            // ------------------------------------------

            if (
                !fullLegalName ||
                !dateOfBirth ||
                !countryOfResidence ||
                !phoneNumber ||
                !residentialAddress ||
                !governmentIdType ||
                !governmentIdNumber
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please complete all required verification details."
                });

            }


            // ------------------------------------------
            // VALIDATE DECLARATION
            // ------------------------------------------

            if (!declarationAccepted) {

                return res.status(400).json({
                    success: false,
                    message:
                        "You must accept the verification declaration."
                });

            }


            // ------------------------------------------
            // CHECK COMPLETED DEPOSIT
            // ------------------------------------------

            const hasCompletedDeposit =
                await userHasCompletedDeposit(userId);

            if (!hasCompletedDeposit) {

                return res.status(403).json({
                    success: false,
                    reason: "no_deposit",
                    message:
                        "A completed deposit is required before verification."
                });

            }


            // ------------------------------------------
            // GET EXISTING KYC
            // ------------------------------------------

            const {
                data: existing,
                error: existingError
            } = await supabase
                .from("kyc_verifications")
                .select(
                    "id,status,id_front_path,id_back_path,selfie_path,proof_of_address_path"
                )
                .eq("user_id", userId)
                .maybeSingle();


            if (existingError) {
                throw existingError;
            }


            // ------------------------------------------
            // GET UPLOADED FILES
            // ------------------------------------------

            const files =
                req.files || {};

            const idFrontFile =
                files.id_front?.[0] || null;

            const idBackFile =
                files.id_back?.[0] || null;

            const selfieFile =
                files.selfie?.[0] || null;

            const proofOfAddressFile =
                files.proof_of_address?.[0] || null;


            // ------------------------------------------
            // REQUIRED FILES
            // ------------------------------------------

            if (!idFrontFile) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please upload the front of your identification document."
                });

            }

            if (!selfieFile) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please upload your selfie."
                });

            }


            // ------------------------------------------
            // STORAGE BUCKET
            // ------------------------------------------

            const bucketName =
                "kyc-documents";


            // ------------------------------------------
            // SAFE FILE EXTENSION
            // ------------------------------------------

            function getSafeExtension(file) {

                const originalName =
                    String(
                        file.originalname || ""
                    ).toLowerCase();

                const extension =
                    path.extname(
                        originalName
                    );

                const allowedExtensions = [
                    ".jpg",
                    ".jpeg",
                    ".png",
                    ".webp",
                    ".pdf"
                ];

                if (
                    allowedExtensions.includes(
                        extension
                    )
                ) {
                    return extension;
                }

                if (
                    file.mimetype === "image/jpeg"
                ) {
                    return ".jpg";
                }

                if (
                    file.mimetype === "image/png"
                ) {
                    return ".png";
                }

                if (
                    file.mimetype === "image/webp"
                ) {
                    return ".webp";
                }

                if (
                    file.mimetype === "application/pdf"
                ) {
                    return ".pdf";
                }

                return "";
            }


            // ------------------------------------------
            // UPLOAD FILE TO PRIVATE STORAGE
            // ------------------------------------------

            async function uploadKycFile(
                file,
                documentType
            ) {

                if (!file) {
                    return null;
                }

                const extension =
                    getSafeExtension(file);

                if (!extension) {

                    throw new Error(
                        "Unsupported file type for " +
                        documentType +
                        ". Please upload JPG, PNG, WEBP, or PDF."
                    );

                }

                const timestamp =
                    Date.now();

                const randomPart =
                    crypto
                        .randomBytes(8)
                        .toString("hex");

                const storagePath =
                    `${userId}/${timestamp}-${randomPart}-${documentType}${extension}`;


                const {
                    data,
                    error
                } = await supabase
                    .storage
                    .from(bucketName)
                    .upload(
                        storagePath,
                        file.buffer,
                        {
                            contentType:
                                file.mimetype ||
                                "application/octet-stream",

                            cacheControl:
                                "3600",

                            upsert:
                                false
                        }
                    );


                if (error) {
                    throw error;
                }


                return data?.path ||
                    storagePath;
            }


            // ------------------------------------------
            // UPLOAD DOCUMENTS
            // ------------------------------------------

            const idFrontPath =
                await uploadKycFile(
                    idFrontFile,
                    "id-front"
                );

            const idBackPath =
                await uploadKycFile(
                    idBackFile,
                    "id-back"
                );

            const selfiePath =
                await uploadKycFile(
                    selfieFile,
                    "selfie"
                );

            const proofOfAddressPath =
                await uploadKycFile(
                    proofOfAddressFile,
                    "proof-of-address"
                );


            // ------------------------------------------
            // BUILD DATABASE PAYLOAD
            // ------------------------------------------

            const payload = {

                user_id:
                    userId,

                status:
                    "pending",

                full_legal_name:
                    fullLegalName,

                date_of_birth:
                    dateOfBirth,

                country_of_residence:
                    countryOfResidence,

                phone_number:
                    phoneNumber,

                residential_address:
                    residentialAddress,

                government_id_type:
                    governmentIdType,

                government_id_number:
                    governmentIdNumber,

                /*
                    Only replace an existing path when
                    a new file was actually uploaded.
                */

                id_front_path:
                    idFrontPath ||
                    existing?.id_front_path ||
                    null,

                id_back_path:
                    idBackPath ||
                    existing?.id_back_path ||
                    null,

                selfie_path:
                    selfiePath ||
                    existing?.selfie_path ||
                    null,

                proof_of_address_path:
                    proofOfAddressPath ||
                    existing?.proof_of_address_path ||
                    null,

                declaration_accepted:
                    true,

                rejection_reason:
                    null,

                reviewed_by:
                    null,

                reviewed_at:
                    null,

                updated_at:
                    new Date().toISOString()
            };


            // ------------------------------------------
            // SAVE KYC RECORD
            // ------------------------------------------

            let result;


            if (existing) {

                result =
                    await supabase
                        .from(
                            "kyc_verifications"
                        )
                        .update(payload)
                        .eq(
                            "id",
                            existing.id
                        )
                        .select()
                        .single();

            } else {

                result =
                    await supabase
                        .from(
                            "kyc_verifications"
                        )
                        .insert(payload)
                        .select()
                        .single();

            }


            if (result.error) {
                throw result.error;
            }


            // ------------------------------------------
            // SUCCESS
            // ------------------------------------------

            return res.json({

                success: true,

                message:
                    "Verification submitted successfully. Your documents are now under review.",

                kyc:
                    result.data

            });


        } catch (error) {

            console.error(
                "KYC submission error:",
                error
            );


            return res.status(500).json({

                success: false,

                message:
                    "Unable to submit verification."

            });

        }

    }
);
// ==========================================
// CREATE WITHDRAWAL REQUEST + MPESA B2C
// ==========================================
// ======================================================
// CREATE WITHDRAWAL REQUEST
// ======================================================
// IMPORTANT:
// This route ONLY creates a PENDING withdrawal request.
// It DOES NOT send M-Pesa B2C.
//
// Admin approval will later trigger B2C payment.
// ======================================================

app.post(
    "/api/wallet/withdraw",
    authenticateUser,
    async (req, res) => {

        try {

            // ==========================================
            // WITHDRAWAL VERIFICATION GATE
            // ==========================================

            const userId =
                req.user.id;


            // ==========================================
            // LOAD USER ROLE
            // ==========================================

            const {
                data: withdrawalProfile,
                error: withdrawalProfileError
            } = await supabase
                .from("profiles")
                .select("role")
                .eq(
                    "id",
                    userId
                )
                .maybeSingle();


            if (
                withdrawalProfileError
            ) {

                console.error(
                    "WITHDRAWAL ROLE LOOKUP ERROR:",
                    withdrawalProfileError
                );

                return res.status(500).json({

                    success: false,

                    message:
                        "Unable to verify withdrawal permissions."

                });

            }


            const withdrawalUserRole =
                String(
                    withdrawalProfile?.role ||
                    ""
                )
                .trim()
                .toLowerCase();


            // ==========================================
            // ROLES EXEMPT FROM KYC VERIFICATION
            // ==========================================

            const verificationExemptRoles = [

                "admin",
                "super_admin",
                "owner"

            ];


            const isVerificationExempt =
                verificationExemptRoles.includes(
                    withdrawalUserRole
                );


            // ==========================================
            // CHECK WHETHER USER HAS COMPLETED DEPOSIT
            // ==========================================
            //
            // This requirement remains for EVERYONE,
            // including admin, super_admin and owner.
            //
            // ==========================================

            const hasCompletedDeposit =
                await userHasCompletedDeposit(
                    userId
                );


            if (
                !hasCompletedDeposit
            ) {

                return res.status(403).json({

                    success: false,

                    code:
                        "NO_DEPOSIT",

                    message:
                        "Make a deposit first before requesting a withdrawal."

                });

            }


            // ==========================================
            // KYC VERIFICATION
            // ==========================================
            //
            // Normal users MUST have approved KYC.
            //
            // admin
            // super_admin
            // owner
            //
            // are exempt from this verification gate.
            //
            // ==========================================

            if (
                !isVerificationExempt
            ) {

                const kyc =
                    await getUserKycStatus(
                        userId
                    );


                if (
                    kyc.status !== "approved"
                ) {

                    return res.status(403).json({

                        success: false,

                        code:
                            "VERIFICATION_REQUIRED",

                        kycStatus:
                            kyc.status,

                        rejectionReason:
                            kyc.rejection_reason ||
                            null,

                        message:
                            kyc.status === "pending"
                                ? "Your verification is still under review."
                                : kyc.status === "rejected"
                                    ? "Your verification was rejected. Please submit your verification again."
                                    : "Identity verification is required before withdrawal."

                    });

                }

            }


            // ==================================================
            // READ REQUEST
            // ==================================================

            const amount =
                Number(
                    req.body.amount
                );


            const paymentMethod =
                String(
                    req.body.paymentMethod ||
                    "mpesa"
                )
                .trim()
                .toLowerCase();


            const rawPhoneNumber =
                String(
                    req.body.phoneNumber ||
                    ""
                )
                .trim();


            // ==================================================
            // VALIDATE AMOUNT
            // ==================================================

            if (
                !Number.isFinite(amount) ||
                amount < 0.10
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Minimum withdrawal amount is $0.10"

                });

            }


            const withdrawalAmount =
                Number(
                    amount.toFixed(6)
                );


            if (
                !Number.isFinite(
                    withdrawalAmount
                ) ||
                withdrawalAmount <= 0
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid withdrawal amount"

                });

            }


            // ==================================================
            // VALIDATE PAYMENT METHOD
            // ==================================================

            if (
                paymentMethod !== "mpesa"
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Only M-Pesa withdrawals are currently supported"

                });

            }


            // ==================================================
            // NORMALIZE PHONE NUMBER
            // ==================================================

            let phoneNumber =
                rawPhoneNumber
                    .replace(/\s+/g, "")
                    .replace(/-/g, "");


            if (
                phoneNumber.startsWith("+254")
            ) {

                phoneNumber =
                    phoneNumber.substring(1);

            }
            else if (
                phoneNumber.startsWith("07") &&
                phoneNumber.length === 10
            ) {

                phoneNumber =
                    "254" +
                    phoneNumber.substring(1);

            }
            else if (
                phoneNumber.startsWith("7") &&
                phoneNumber.length === 9
            ) {

                phoneNumber =
                    "254" +
                    phoneNumber;

            }


            if (
                !/^2547\d{8}$/.test(
                    phoneNumber
                )
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Enter a valid M-Pesa phone number"

                });

            }


            // ==================================================
            // GET USER WALLET
            // ==================================================

            const wallet =
                await getOrCreateWallet(
                    req.user.id
                );


            if (!wallet) {

                return res.status(500).json({

                    success: false,

                    message:
                        "Wallet could not be loaded"

                });

            }


            // ==================================================
            // GET TRADING / BONUS / WITHDRAWABLE BALANCES
            // ==================================================
            //
            // REAL BALANCE:
            //     Actual customer capital.
            //
            // BONUS BALANCE:
            //     Promotional trading credit.
            //
            // TRADING BALANCE:
            //     Real + Bonus.
            //
            // WITHDRAWABLE:
            //     Trading balance - remaining bonus.
            //
            // The bonus itself can never be withdrawn.
            // ==================================================

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
                ) ||
                !Number.isFinite(
                    currentBonusBalance
                )
            ) {

                return res.status(500).json({

                    success: false,

                    message:
                        "Invalid wallet balance"

                });

            }


            // ==================================================
            // CALCULATE CURRENT TRADING BALANCE
            // ==================================================

            const tradingBalance =
                Number(
                    (
                        currentRealBalance +
                        currentBonusBalance
                    ).toFixed(6)
                );


            // ==================================================
            // CALCULATE WITHDRAWABLE BALANCE
            // ==================================================
            //
            // Promotional bonus is protected.
            //
            // Example:
            //
            // Real      = $100
            // Bonus     = $50
            // Trading   = $150
            // Withdrawable = $100
            //
            // If account grows to $250 while $50 bonus
            // remains protected:
            //
            // Trading   = $250
            // Bonus     = $50
            // Withdrawable = $200
            // ==================================================

            const withdrawableBalance =
                Number(
                    Math.max(
                        0,
                        tradingBalance -
                        currentBonusBalance
                    ).toFixed(6)
                );


            // ==================================================
            // CHECK REQUEST AGAINST WITHDRAWABLE BALANCE
            // ==================================================

            if (
                withdrawalAmount >
                withdrawableBalance
            ) {

                return res.status(400).json({

                    success: false,

                    code:
                        "WITHDRAWAL_LIMIT_EXCEEDED",

                    message:
                        "Withdrawal amount exceeds your available withdrawable balance.",

                    balances: {

                        tradingBalance:
                            tradingBalance,

                        bonusBalance:
                            currentBonusBalance,

                        withdrawableBalance:
                            withdrawableBalance

                    }

                });

            }


            // ==================================================
            // CALCULATE 10% PROCESSING FEE
            // ==================================================

            const processingFee =
                Number(
                    (
                        withdrawalAmount *
                        0.10
                    ).toFixed(6)
                );


            // ==================================================
            // CALCULATE ACTUAL PAYOUT
            // ==================================================

            const payoutAmount =
                Number(
                    (
                        withdrawalAmount -
                        processingFee
                    ).toFixed(6)
                );


            if (
                !Number.isFinite(
                    payoutAmount
                ) ||
                payoutAmount <= 0
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Withdrawal amount is too small after the processing fee."

                });

            }


            // ==================================================
            // CALCULATE NEW REAL BALANCE
            // ==================================================
            //
            // The requested withdrawal is reserved from the
            // customer's withdrawable/real balance.
            //
            // The processing fee is NOT part of the customer's
            // remaining balance.
            //
            // It is deducted from the amount paid to the user.
            // ==================================================

            const newBalance =
                Number(
                    (
                        currentRealBalance -
                        withdrawalAmount
                    ).toFixed(6)
                );


            if (
                newBalance < 0
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Insufficient withdrawable balance"

                });

            }


            // ==================================================
            // GENERATE WITHDRAWAL REFERENCES
            // ==================================================

            const reference =
                "WDR-" +
                Date.now() +
                "-" +
                crypto
                    .randomBytes(4)
                    .toString("hex")
                    .toUpperCase();


            const originatorConversationID =
                "KMF-" +
                Date.now() +
                "-" +
                crypto
                    .randomBytes(4)
                    .toString("hex")
                    .toUpperCase();


            // ==================================================
            // CALCULATE KES PAYOUT
            // ==================================================
            //
            // M-Pesa receives the amount AFTER the 10% fee.
            // ==================================================

            const kesAmount =
                Number(
                    (
                        payoutAmount *
                        USD_KES_WITHDRAWAL_RATE
                    ).toFixed(2)
                );


            if (
                !Number.isFinite(
                    kesAmount
                ) ||
                kesAmount < 1
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Withdrawal amount is too small for M-Pesa"

                });

            }


            // ==================================================
            // RESERVE REAL WALLET BALANCE
            // ==================================================
            //
            // The money is reserved now so the user cannot
            // spend the same funds while the withdrawal is
            // waiting for admin review.
            //
            // IMPORTANT:
            // No M-Pesa payment is sent here.
            // ==================================================

            const {

                data: updatedWallet,

                error: walletUpdateError

            } = await supabase
                .from("wallets")
                .update({

                    balance:
                        newBalance

                })
                .eq(
                    "id",
                    wallet.id
                )
                .eq(
                    "balance",
                    currentRealBalance
                )
                .select()
                .maybeSingle();


            if (
                walletUpdateError
            ) {

                console.error(
                    "WITHDRAWAL WALLET RESERVE ERROR:",
                    walletUpdateError
                );

                return res.status(500).json({

                    success: false,

                    message:
                        "Unable to reserve withdrawal funds"

                });

            }


            if (
                !updatedWallet
            ) {

                return res.status(409).json({

                    success: false,

                    message:
                        "Wallet balance changed. Please try again."

                });

            }


            // ==================================================
            // CREATE PENDING WITHDRAWAL
            // ==================================================

            const {

                data: withdrawal,

                error: withdrawalError

            } = await supabase
                .from("withdrawals")
                .insert({

                    user_id:
                        req.user.id,

                    wallet_id:
                        wallet.id,

                    amount:
                        withdrawalAmount,

                    processing_fee:
                        processingFee,

                    payout_amount:
                        payoutAmount,

                    phone_number:
                        phoneNumber,

                    payment_method:
                        "mpesa",

                    status:
                        "pending",

                    reference:
                        reference,

                    originator_conversation_id:
                        originatorConversationID,

                    risk_status:
                        "normal",

                    risk_score:
                        0,

                    risk_flags:
                        []

                })
                .select()
                .single();


            // ==================================================
            // WITHDRAWAL INSERT FAILED
            // ==================================================

            if (
                withdrawalError
            ) {

                console.error(
                    "WITHDRAWAL INSERT ERROR:",
                    withdrawalError
                );


                // Restore wallet balance
                await supabase
                    .from("wallets")
                    .update({

                        balance:
                            currentRealBalance

                    })
                    .eq(
                        "id",
                        wallet.id
                    )
                    .eq(
                        "balance",
                        newBalance
                    );


                return res.status(500).json({

                    success: false,

                    message:
                        "Unable to create withdrawal request"

                });

            }


            // ==================================================
            // RECORD WITHDRAWAL TRANSACTION
            // ==================================================

            const {

                data: walletTransaction,

                error: transactionError

            } = await supabase
                .from("wallet_transactions")
                .insert({

                    user_id:
                        req.user.id,

                    wallet_id:
                        wallet.id,

                    transaction_type:
                        "withdrawal",

                    type:
                        "withdrawal",

                    amount:
                        withdrawalAmount,

                    status:
                        "pending",

                    payment_method:
                        "mpesa",

                    reference:
                        reference,

                    reference_id:
                        withdrawal.id,

                    description:
                        `M-Pesa withdrawal pending admin approval. Requested: $${withdrawalAmount.toFixed(2)}. Processing fee: $${processingFee.toFixed(2)}. Customer payout: $${payoutAmount.toFixed(2)}.`,

                    balance_before:
                        currentRealBalance,

                    balance_after:
                        newBalance

                })
                .select()
                .single();


            // ==================================================
            // TRANSACTION LOG FAILED
            // ==================================================

            if (
                transactionError
            ) {

                console.error(
                    "WITHDRAWAL TRANSACTION LOG ERROR:",
                    transactionError
                );


                // Mark withdrawal cancelled
                await supabase
                    .from("withdrawals")
                    .update({

                        status:
                            "cancelled"

                    })
                    .eq(
                        "id",
                        withdrawal.id
                    )
                    .eq(
                        "user_id",
                        req.user.id
                    );


                // Restore wallet balance
                const {

                    error: restoreError

                } = await supabase
                    .from("wallets")
                    .update({

                        balance:
                            currentRealBalance

                    })
                    .eq(
                        "id",
                        wallet.id
                    )
                    .eq(
                        "balance",
                        newBalance
                    );


                if (
                    restoreError
                ) {

                    console.error(
                        "WITHDRAWAL WALLET RESTORE ERROR:",
                        restoreError
                    );

                }


                return res.status(500).json({

                    success: false,

                    message:
                        "Unable to record withdrawal transaction"

                });

            }


            // ==================================================
            // CREATE AUDIT LOG
            // ==================================================

            const {

                error: auditError

            } = await supabase
                .from("withdrawal_audit_logs")
                .insert({

                    withdrawal_id:
                        withdrawal.id,

                    user_id:
                        req.user.id,

                    admin_id:
                        null,

                    action:
                        "withdrawal_requested",

                    reason:
                        null,

                    notes:
                        isVerificationExempt
                            ? `User submitted withdrawal request. KYC verification bypassed because account role is ${withdrawalUserRole}. Waiting for admin review.`
                            : "User submitted withdrawal request. Waiting for admin review.",

                    status_before:
                        null,

                    status_after:
                        "pending",

                    amount:
                        withdrawalAmount,

                    metadata: {

                        payment_method:
                            "mpesa",

                        phone_number:
                            phoneNumber,

                        kes_amount:
                            kesAmount,

                        reference:
                            reference,

                        requested_amount:
                            withdrawalAmount,

                        processing_fee:
                            processingFee,

                        payout_amount:
                            payoutAmount,

                        trading_balance:
                            tradingBalance,

                        bonus_balance:
                            currentBonusBalance,

                        withdrawable_balance:
                            withdrawableBalance,

                        processing_fee_percent:
                            10,

                        user_role:
                            withdrawalUserRole,

                        verification_exempt:
                            isVerificationExempt

                    }

                });


            if (
                auditError
            ) {

                console.error(
                    "WITHDRAWAL AUDIT LOG ERROR:",
                    auditError
                );

                // We do NOT cancel the withdrawal merely because
                // the audit log failed. The financial transaction
                // itself has already been recorded safely.
            }


            // ==================================================
            // LOG
            // ==================================================

            console.log(
                "=========================================="
            );

            console.log(
                "WITHDRAWAL REQUEST CREATED"
            );

            console.log(
                "WITHDRAWAL ID:",
                withdrawal.id
            );

            console.log(
                "USER:",
                req.user.id
            );

            console.log(
                "USER ROLE:",
                withdrawalUserRole
            );

            console.log(
                "VERIFICATION EXEMPT:",
                isVerificationExempt
            );

            console.log(
                "AMOUNT USD:",
                withdrawalAmount
            );

            console.log(
                "AMOUNT KES:",
                kesAmount
            );

            console.log(
                "PHONE:",
                phoneNumber
            );

            console.log(
                "REFERENCE:",
                reference
            );

            console.log(
                "STATUS:",
                "PENDING"
            );

            console.log(
                "B2C SENT:",
                false
            );

            console.log(
                "=========================================="
            );


            // ==================================================
            // RESPONSE
            // ==================================================

            return res.status(201).json({

                success:
                    true,

                message:
                    "Withdrawal request submitted and is waiting for admin approval.",

                withdrawal: {

                    id:
                        withdrawal.id,

                    reference:
                        reference,

                    amount:
                        withdrawalAmount,

                    tradingBalance:
                        tradingBalance,

                    bonusBalance:
                        currentBonusBalance,

                    withdrawableAmount:
                        withdrawableBalance,

                    requestedAmount:
                        withdrawalAmount,

                    processingFee:
                        processingFee,

                    processingFeePercent:
                        10,

                    payoutAmount:
                        payoutAmount,

                    phoneNumber:
                        phoneNumber,

                    paymentMethod:
                        "mpesa",

                    status:
                        "pending",

                    kesAmount:
                        kesAmount,

                    adminApprovalRequired:
                        true,

                    verificationExempt:
                        isVerificationExempt,

                    userRole:
                        withdrawalUserRole

                }

            });

        }

        catch (error) {

            console.error(
                "WITHDRAWAL REQUEST ERROR:",
                error
            );


            return res.status(500).json({

                success: false,

                message:
                    error.message ||
                    "Unable to create withdrawal request"

            });

        }

    }
);
// ======================================================
// ADMIN APPROVE WITHDRAWAL
// ======================================================
//
// FLOW:
//
// pending
//    ↓
// admin approves
//    ↓
// processing
//    ↓
// M-Pesa B2C
//    ↓
// Safaricom callback
//    ↓
// completed / failed
//
// IMPORTANT:
// This route does NOT create a new withdrawal.
// It only approves an existing pending withdrawal.
//
// ======================================================

app.post(
    "/api/admin/withdrawals/:id/approve",
    authenticateUser,
    async (req, res) => {

        try {

            // ==================================================
            // VERIFY ADMIN
            // ==================================================

            const adminUserId =
                req.user?.id;

            if (!adminUserId) {

                return res.status(401).json({

                    success: false,

                    message:
                        "Authentication required"

                });

            }


            // ==================================================
            // LOAD ADMIN PROFILE
            // ==================================================

            const {

                data: adminProfile,

                error: adminProfileError

            } = await supabase
                .from("profiles")
                .select(
                    "id, username, full_name, role"
                )
                .eq(
                    "id",
                    adminUserId
                )
                .maybeSingle();


            if (
                adminProfileError
            ) {

                console.error(
                    "ADMIN PROFILE LOOKUP ERROR:",
                    adminProfileError
                );

                return res.status(500).json({

                    success: false,

                    message:
                        "Unable to verify administrator"

                });

            }


            if (!adminProfile) {

                return res.status(403).json({

                    success: false,

                    message:
                        "Administrator profile not found"

                });

            }


            const adminRole =
                String(
                    adminProfile.role ||
                    ""
                )
                .trim()
                .toLowerCase();


            const allowedAdminRoles = [

                "admin",
                "super_admin",
                "owner"

            ];


            if (
                !allowedAdminRoles.includes(
                    adminRole
                )
            ) {

                return res.status(403).json({

                    success: false,

                    message:
                        "Administrator permission required"

                });

            }


            // ==================================================
            // READ WITHDRAWAL ID
            // ==================================================

            const withdrawalId =
                String(
                    req.params.id ||
                    ""
                ).trim();


            if (!withdrawalId) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Withdrawal ID is required"

                });

            }


            // ==================================================
            // LOAD WITHDRAWAL
            // ==================================================

            const {

                data: withdrawal,

                error: withdrawalError

            } = await supabase
                .from("withdrawals")
                .select("*")
                .eq(
                    "id",
                    withdrawalId
                )
                .maybeSingle();


            if (
                withdrawalError
            ) {

                console.error(
                    "ADMIN WITHDRAWAL LOOKUP ERROR:",
                    withdrawalError
                );

                return res.status(500).json({

                    success: false,

                    message:
                        "Unable to load withdrawal"

                });

            }


            if (!withdrawal) {

                return res.status(404).json({

                    success: false,

                    message:
                        "Withdrawal not found"

                });

            }


            // ==================================================
            // ONLY PENDING WITHDRAWALS CAN BE APPROVED
            // ==================================================
if (
    withdrawal.status !== "pending"
) {

    return res.status(409).json({

        success: false,

        message:
            `Withdrawal cannot be approved because its current status is ${withdrawal.status}`,

        status:
            withdrawal.status

    });

}

            // ==================================================
            // CALCULATE KES AMOUNT
            // ==================================================

            const withdrawalAmount =
                Number(
                    withdrawal.amount
                );


            if (
                !Number.isFinite(
                    withdrawalAmount
                ) ||
                withdrawalAmount <= 0
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid withdrawal amount"

                });

            }



// ==================================================
// READ STORED FEE AND PAYOUT
// ==================================================

const processingFee =
    Number(
        withdrawal.processing_fee || 0
    );

const payoutAmount =
    Number(
        withdrawal.payout_amount ||
        (
            withdrawalAmount -
            processingFee
        ).toFixed(6)
    );


if (
    !Number.isFinite(processingFee) ||
    processingFee < 0
) {

    return res.status(400).json({

        success: false,

        message:
            "Invalid withdrawal processing fee"

    });

}


if (
    !Number.isFinite(payoutAmount) ||
    payoutAmount <= 0 ||
    payoutAmount > withdrawalAmount
) {

    return res.status(400).json({

        success: false,

        message:
            "Invalid withdrawal payout amount"

    });

}


// ==================================================
// CALCULATE KES PAYOUT
// ==================================================

const kesAmount =
    Number(
        (
            payoutAmount *
            USD_KES_WITHDRAWAL_RATE
        ).toFixed(2)
    );

            if (
                !Number.isFinite(
                    kesAmount
                ) ||
                kesAmount < 1
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Withdrawal amount is too small for M-Pesa"

                });

            }


            // ==================================================
            // READ ADMIN NOTES
            // ==================================================

            const adminNotes =
                String(
                    req.body?.adminNotes ||
                    ""
                ).trim();


            // ==================================================
            // CHANGE PENDING → PROCESSING
            // ==================================================
            //
            // The status change happens BEFORE sending B2C.
            //
            // This prevents two admins from approving the same
            // withdrawal at the same time.
            //
            // ==================================================

            const {

                data: processingWithdrawal,

                error: processingError

            } = await supabase
                .from("withdrawals")
                .update({

                    status:
                        "processing",

                    reviewed_by:
                        adminUserId,

                    reviewed_at:
                        new Date().toISOString(),

                    approved_at:
                        new Date().toISOString(),

                    processing_at:
                        new Date().toISOString(),

                    admin_notes:
                        adminNotes ||
                        null,

                    updated_at:
                        new Date().toISOString()

                })
                .eq(
                    "id",
                    withdrawal.id
                )
  .eq(
    "status",
    "pending"
)

                .select()
                .maybeSingle();


            if (
                processingError
            ) {

                console.error(
                    "WITHDRAWAL APPROVAL UPDATE ERROR:",
                    processingError
                );

                return res.status(500).json({

                    success: false,

                    message:
                        "Unable to approve withdrawal"

                });

            }


            // ==================================================
            // DUPLICATE APPROVAL PROTECTION
            // ==================================================

            if (!processingWithdrawal) {

                return res.status(409).json({

                    success: false,

                    message:
                        "Withdrawal has already been processed or approved"

                });

            }


            // ==================================================
            // UPDATE WALLET TRANSACTION
            // ==================================================

            const {

                error: walletTransactionError

            } = await supabase
                .from("wallet_transactions")
                .update({

                    status:
                        "processing",

                    description:
                        "M-Pesa withdrawal approved by admin and being processed"

                })
                .eq(
                    "reference_id",
                    withdrawal.id
                )
                .eq(
                    "transaction_type",
                    "withdrawal"
                )
               .in(
    "status",
    [
        "pending",
        "processing"
    ]
)
            if (
                walletTransactionError
            ) {

                console.error(
                    "WITHDRAWAL WALLET TRANSACTION PROCESSING ERROR:",
                    walletTransactionError
                );

            }


            // ==================================================
            // CREATE APPROVAL AUDIT LOG
            // ==================================================

            const {

                error: auditError

            } = await supabase
                .from("withdrawal_audit_logs")
                .insert({

                    withdrawal_id:
                        withdrawal.id,

                    user_id:
                        withdrawal.user_id,

                    admin_id:
                        adminUserId,

                    action:
                        "withdrawal_approved",

                    reason:
                        null,

                    notes:
                        adminNotes ||
                        "Withdrawal approved by administrator. M-Pesa B2C processing started.",

                    status_before:
                        "pending",

                    status_after:
                        "processing",

                    amount:
                        withdrawalAmount,

               metadata: {

    admin_role:
        adminRole,

    admin_username:
        adminProfile.username ||
        null,

    payment_method:
        withdrawal.payment_method,

    phone_number:
        withdrawal.phone_number,

    requested_amount:
        withdrawalAmount,

    processing_fee:
        processingFee,

    processing_fee_percent:
        10,

    payout_amount:
        payoutAmount,

    kes_amount:
        kesAmount,

    reference:
        withdrawal.reference

}

                });


            if (
                auditError
            ) {

                console.error(
                    "WITHDRAWAL APPROVAL AUDIT ERROR:",
                    auditError
                );

            }


            // ==================================================
            // SEND MPESA B2C
            // ==================================================
            //
            // IMPORTANT:
            // We use the EXISTING initiateMpesaB2C()
            // function already in server.js.
            //
            // We do NOT duplicate the M-Pesa implementation.
            //
            // ==================================================

            try {

                const b2cResponse =
                    await initiateMpesaB2C({

                        phoneNumber:
                            withdrawal.phone_number,

                        amount:
                            kesAmount,

                        originatorConversationID:
                            withdrawal.originator_conversation_id,

                        remarks:
                            `KMFBinary withdrawal ${withdrawal.reference}`

                    });


                // ==================================================
                // LOG B2C REQUEST
                // ==================================================

                console.log(
                    "=========================================="
                );

                console.log(
                    "💸 ADMIN APPROVED WITHDRAWAL"
                );

                console.log(
                    "Withdrawal ID:",
                    withdrawal.id
                );

                console.log(
                    "Reference:",
                    withdrawal.reference
                );

                console.log(
                    "Admin:",
                    adminUserId
                );

                console.log(
                    "Admin Role:",
                    adminRole
                );

              console.log(
    "Requested USD Amount:",
    withdrawalAmount
);

console.log(
    "Processing Fee USD:",
    processingFee
);

console.log(
    "Payout USD:",
    payoutAmount
);

console.log(
    "M-Pesa KES Amount:",
    kesAmount
);

                console.log(
                    "Phone:",
                    withdrawal.phone_number
                );

                console.log(
                    "B2C STATUS:",
                    "PROCESSING"
                );

                console.log(
                    "B2C RESPONSE:",
                    b2cResponse
                );

                console.log(
                    "=========================================="
                );


                return res.status(200).json({

                    success:
                        true,

                    message:
                        "Withdrawal approved and M-Pesa B2C payment is being processed.",

                 withdrawal: {

    id:
        withdrawal.id,

    reference:
        withdrawal.reference,

    amount:
        withdrawalAmount,

    processingFee:
        processingFee,

    payoutAmount:
        payoutAmount,

    kesAmount:
        kesAmount,

    phoneNumber:
        withdrawal.phone_number,

    status:
        "processing"

},

                    admin: {

                        id:
                            adminUserId,

                        role:
                            adminRole

                    }

                });

            }

            catch (b2cError) {

                // ==================================================
                // IMPORTANT SAFETY RULE
                // ==================================================
                //
                // DO NOT automatically refund here.
                //
                // The B2C request may have reached Safaricom even
                // if our server did not receive a normal response.
                //
                // Automatically refunding could create a situation
                // where the user gets both:
                //
                // 1. The refund
                // 2. The M-Pesa payment
                //
                // The withdrawal therefore remains PROCESSING until
                // it is reconciled.
                //
                // ==================================================

                console.error(
                    "=========================================="
                );

                console.error(
                    "⚠️ B2C REQUEST ERROR AFTER APPROVAL"
                );

                console.error(
                    "Withdrawal:",
                    withdrawal.reference
                );

                console.error(
                    "Error:",
                    b2cError
                );

                console.error(
                    "Withdrawal remains PROCESSING for reconciliation."
                );

                console.error(
                    "=========================================="
                );


                await supabase
                    .from("withdrawal_audit_logs")
                    .insert({

                        withdrawal_id:
                            withdrawal.id,

                        user_id:
                            withdrawal.user_id,

                        admin_id:
                            adminUserId,

                        action:
                            "b2c_request_error",

                        reason:
                            "M-Pesa B2C request returned an error after withdrawal approval.",

                        notes:
                            b2cError?.message ||
                            "B2C request error. Manual reconciliation required.",

                        status_before:
                            "processing",

                        status_after:
                            "processing",

                        amount:
                            withdrawalAmount,

                        metadata: {

                            reference:
                                withdrawal.reference,

                            error:
                                b2cError?.message ||
                                String(b2cError),

                            kes_amount:
                                kesAmount

                        }

                    })
                    .catch(
                        auditLogError => {

                            console.error(
                                "B2C ERROR AUDIT LOG ERROR:",
                                auditLogError
                            );

                        }
                    );


                return res.status(502).json({

                    success:
                        false,

                    message:
                        "M-Pesa payment could not be confirmed. The withdrawal remains processing and requires reconciliation.",

                    withdrawal: {

                        id:
                            withdrawal.id,

                        reference:
                            withdrawal.reference,

                        status:
                            "processing"

                    }

                });

            }

        }

        catch (error) {

            console.error(
                "ADMIN WITHDRAWAL APPROVAL ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    error.message ||
                    "Unable to approve withdrawal"

            });

        }

    }
);
// ==========================================
// MPESA B2C RESULT CALLBACK
// ==========================================

// Safaricom should send POST callbacks.
// GET is provided only so the endpoint can be tested
// without generating an error.

app.get(
    "/api/mpesa/b2c/result",
    (req, res) => {

        console.log(
            "B2C RESULT GET REQUEST:",
            req.originalUrl
        );

        return res.status(200).json({

            success: true,

            message:
                "B2C result endpoint is active. POST required."

        });

    }
);


// ==========================================
// MPESA B2C TRANSACTION STATUS RESULT
// ==========================================

app.post(
    "/api/mpesa/b2c/status/result",
    async (req, res) => {

        console.log("====================================");
        console.log("🔥 MPESA B2C STATUS RESULT CALLBACK");
        console.log("====================================");

        console.log(
            JSON.stringify(req.body, null, 2)
        );

        // Acknowledge Safaricom
        res.status(200).json({
            Result: {
                ResultCode: 0,
                ResultDesc:
                    "Status callback received successfully"
            }
        });

        try {

            const result =
                req.body?.Result;

            if (!result) {

                console.log(
                    "❌ STATUS RESULT BODY MISSING"
                );

                return;
            }

            console.log(
                "Status ResultCode:",
                result.ResultCode
            );

            console.log(
                "Status ResultDesc:",
                result.ResultDesc
            );

            console.log(
                "ConversationID:",
                result.ConversationID
            );

            console.log(
                "OriginatorConversationID:",
                result.OriginatorConversationID
            );

            console.log(
                "TransactionID:",
                result.TransactionID
            );

            console.log(
                "ResultParameters:",
                result.ResultParameters
            );

        }
        catch (error) {

            console.error(
                "❌ STATUS CALLBACK ERROR:",
                error.message
            );

        }

    }
);


// ==========================================
// MPESA B2C RESULT CALLBACK
// ==========================================

app.post(
    "/api/mpesa/b2c/result",
    async (req, res) => {

        console.log(
            "=========================================="
        );

        console.log(
            "🔥 MPESA B2C RESULT CALLBACK"
        );

        console.log(
            JSON.stringify(
                req.body,
                null,
                2
            )
        );

        console.log(
            "=========================================="
        );


        // ==========================================
        // ACKNOWLEDGE SAFARICOM IMMEDIATELY
        // ==========================================

        res.status(200).json({

            Result: {

                ResultCode: 0,

                ResultDesc:
                    "Callback received successfully"

            }

        });


        try {

            const result =
                req.body?.Result;


            if (!result) {

                console.error(
                    "B2C callback missing Result object"
                );

                return;

            }


            // ==========================================
            // READ IDENTIFIERS
            // ==========================================

            const originatorConversationID =
                String(
                    result.OriginatorConversationID ||
                    ""
                ).trim();

            const conversationID =
                String(
                    result.ConversationID ||
                    ""
                ).trim();

            const transactionIDFromResult =
                String(
                    result.TransactionID ||
                    ""
                ).trim();

            const resultCode =
                Number(
                    result.ResultCode
                );

            const resultDescription =
                String(
                    result.ResultDesc ||
                    "No result description"
                );


            console.log(
                "OriginatorConversationID:",
                originatorConversationID
            );

            console.log(
                "ConversationID:",
                conversationID
            );

            console.log(
                "TransactionID:",
                transactionIDFromResult
            );

            console.log(
                "ResultCode:",
                resultCode
            );

            console.log(
                "ResultDesc:",
                resultDescription
            );


            if (!originatorConversationID) {

                console.error(
                    "B2C callback missing OriginatorConversationID"
                );

                return;

            }


            // ==========================================
            // FIND WITHDRAWAL
            // ==========================================

            const {
                data: withdrawal,
                error: withdrawalError
            } = await supabase
                .from("withdrawals")
                .select("*")
                .eq(
                    "originator_conversation_id",
                    originatorConversationID
                )
                .maybeSingle();


            if (withdrawalError) {

                console.error(
                    "B2C withdrawal lookup error:",
                    withdrawalError
                );

                return;

            }


            if (!withdrawal) {

                console.error(
                    "=========================================="
                );

                console.error(
                    "❌ WITHDRAWAL NOT FOUND"
                );

                console.error(
                    "OriginatorConversationID:",
                    originatorConversationID
                );

                console.error(
                    "=========================================="
                );

                return;

            }


            console.log(
                "Withdrawal found:",
                withdrawal.reference
            );

// ==========================================
// DUPLICATE PROTECTION
// ==========================================
//
// A withdrawal can reach the B2C callback in either:
//
// pending     = legacy/older B2C flow
// processing  = new admin-approved B2C flow
//
// Both are allowed to continue.
// completed / failed / timeout withdrawals are ignored.
// ==========================================

if (
    withdrawal.status !== "pending" &&
    withdrawal.status !== "processing"
) {

    console.log(
        "B2C callback already processed:",
        withdrawal.reference,
        withdrawal.status
    );

    return;

}
            // ==========================================
            // SUCCESS
            // ==========================================

            if (
                resultCode === 0
            ) {

                let transactionID =
                    transactionIDFromResult ||
                    null;

                let mpesaReceipt =
                    null;


                // ==========================================
                // READ RESULT PARAMETERS
                // ==========================================

                const parameters =
                    result
                        .ResultParameters
                        ?.ResultParameter ||
                    [];


                if (
                    Array.isArray(parameters)
                ) {

                    for (
                        const parameter
                        of parameters
                    ) {

                        const key =
                            String(
                                parameter?.Key ||
                                ""
                            ).trim();


                        if (
                            key ===
                            "TransactionID"
                        ) {

                            transactionID =
                                String(
                                    parameter?.Value ||
                                    transactionID ||
                                    ""
                                );

                        }


                        if (
                            key ===
                            "TransactionReceipt"
                        ) {

                            mpesaReceipt =
                                String(
                                    parameter?.Value ||
                                    ""
                                );

                        }

                    }

                }


                // ==========================================
                // COMPLETE WITHDRAWAL
                // ==========================================

                const {
                    data: completedWithdrawal,
                    error: completionError
                } = await supabase
                    .from("withdrawals")
                    .update({

                        status:
                            "completed",

                        conversation_id:
                            conversationID ||
                            withdrawal.conversation_id ||
                            null,

                        transaction_id:
                            transactionID,

                        mpesa_receipt:
                            mpesaReceipt,

                        result_code:
                            String(
                                resultCode
                            ),

                        result_description:
                            resultDescription,

                        updated_at:
                            new Date().toISOString()

                    })
                    .eq(
                        "id",
                        withdrawal.id
                    )
                    .in(
    "status",
    [
        "pending",
        "processing"
    ]
)
                    .select()
                    .maybeSingle();


                if (completionError) {

                    console.error(
                        "B2C withdrawal completion error:",
                        completionError
                    );

                    return;

                }


                if (!completedWithdrawal) {

                    console.log(
                        "Withdrawal was already processed:",
                        withdrawal.reference
                    );

                    return;

                }


                // ==========================================
                // COMPLETE WALLET TRANSACTION
                // ==========================================

                const {
                    error: walletTransactionError
                } = await supabase
                    .from("wallet_transactions")
                    .update({

                        status:
                            "completed",

                        mpesa_receipt:
                            mpesaReceipt,

                        result_code:
                            String(
                                resultCode
                            ),

                        result_description:
                            resultDescription

                    })
                 .eq(
    "reference_id",
    withdrawal.id
)
.in(
    "status",
    [
        "pending",
        "processing"
    ]
); 

                if (
                    walletTransactionError
                ) {

                    console.error(
                        "Wallet transaction completion error:",
                        walletTransactionError
                    );

                }


                // ==========================================
                // SUCCESS LOG
                // ==========================================

                console.log(
                    "=========================================="
                );

                console.log(
                    "💰 MPESA WITHDRAWAL COMPLETED"
                );

                console.log(
                    "Reference:",
                    withdrawal.reference
                );

                console.log(
                    "USD Amount:",
                    withdrawal.amount
                );

                console.log(
                    "Phone:",
                    withdrawal.phone_number
                );

                console.log(
                    "TransactionID:",
                    transactionID
                );

                console.log(
                    "Receipt:",
                    mpesaReceipt
                );

                console.log(
                    "=========================================="
                );

                return;

            }


            // ==========================================
            // FAILED B2C TRANSACTION
            // ==========================================

            console.log(
                "=========================================="
            );

            console.log(
                "❌ MPESA B2C FAILED"
            );

            console.log(
                "Reference:",
                withdrawal.reference
            );

            console.log(
                "ResultCode:",
                resultCode
            );

            console.log(
                "ResultDesc:",
                resultDescription
            );

            console.log(
                "=========================================="
            );


            // ==========================================
            // MARK WITHDRAWAL FAILED
            // ==========================================

            const {
                data: failedWithdrawal,
                error: failedWithdrawalError
            } = await supabase
                .from("withdrawals")
                .update({

                    status:
                        "failed",

                    conversation_id:
                        conversationID ||
                        withdrawal.conversation_id ||
                        null,

                    transaction_id:
                        transactionIDFromResult ||
                        withdrawal.transaction_id ||
                        null,

                    result_code:
                        String(
                            resultCode
                        ),

                    result_description:
                        resultDescription,

                    updated_at:
                        new Date().toISOString()

                })
                .eq(
                    "id",
                    withdrawal.id
                )
                .in(
    "status",
    [
        "pending",
        "processing"
    ]
)
                .select()
                .maybeSingle();


            if (failedWithdrawalError) {

                console.error(
                    "Failed withdrawal update error:",
                    failedWithdrawalError
                );

                return;

            }


            // ==========================================
            // DUPLICATE CALLBACK PROTECTION
            // ==========================================

            if (!failedWithdrawal) {

                console.log(
                    "Withdrawal already processed."
                );

                console.log(
                    "Refund skipped."
                );

                return;

            }


            // ==========================================
            // MARK ORIGINAL TRANSACTION FAILED
            // ==========================================

            const {
                error: walletTransactionError
            } = await supabase
                .from("wallet_transactions")
                .update({

                    status:
                        "failed",

                    result_code:
                        String(
                            resultCode
                        ),

                    result_description:
                        resultDescription

                })
               .eq(
    "reference_id",
    withdrawal.id
)
.in(
    "status",
    [
        "pending",
        "processing"
    ]
);

            if (
                walletTransactionError
            ) {

                console.error(
                    "Wallet transaction failure update error:",
                    walletTransactionError
                );

            }


            // ==========================================
            // CHECK IF REFUND ALREADY EXISTS
            // ==========================================

            const {
                data: existingRefund,
                error: existingRefundError
            } = await supabase
                .from("wallet_transactions")
                .select("id")
                .eq(
                    "reference_id",
                    withdrawal.id
                )
                .eq(
                    "transaction_type",
                    "refund"
                )
                .maybeSingle();


            if (existingRefundError) {

                console.error(
                    "Refund lookup error:",
                    existingRefundError
                );

                return;

            }


            if (existingRefund) {

                console.log(
                    "Refund already exists:",
                    withdrawal.reference
                );

                return;

            }


            // ==========================================
            // GET WALLET
            // ==========================================

            const {
                data: wallet,
                error: walletError
            } = await supabase
                .from("wallets")
                .select("*")
                .eq(
                    "id",
                    withdrawal.wallet_id
                )
                .eq(
                    "user_id",
                    withdrawal.user_id
                )
                .maybeSingle();


            if (walletError) {

                console.error(
                    "Refund wallet lookup error:",
                    walletError
                );

                return;

            }


            if (!wallet) {

                console.error(
                    "Refund wallet not found:",
                    withdrawal.wallet_id
                );

                return;

            }


            // ==========================================
            // REFUND VALUES
            // ==========================================

            const walletBalance =
                Number(
                    wallet.balance
                );

            const withdrawalAmount =
                Number(
                    withdrawal.amount
                );


            if (
                !Number.isFinite(
                    walletBalance
                ) ||
                !Number.isFinite(
                    withdrawalAmount
                ) ||
                withdrawalAmount <= 0
            ) {

                console.error(
                    "Invalid refund values:",
                    {
                        walletBalance,
                        withdrawalAmount
                    }
                );

                return;

            }


            // ==========================================
            // 6 DECIMAL PRECISION
            // ==========================================

            const refundAmount =
                Number(
                    withdrawalAmount.toFixed(6)
                );

            const refundBalance =
                Number(
                    (
                        walletBalance +
                        refundAmount
                    ).toFixed(6)
                );


            // ==========================================
            // ATOMIC-STYLE REFUND
            // ==========================================

            const {
                data: refundedWallet,
                error: refundError
            } = await supabase
                .from("wallets")
                .update({

                    balance:
                        refundBalance,

                    updated_at:
                        new Date().toISOString()

                })
                .eq(
                    "id",
                    withdrawal.wallet_id
                )
                .eq(
                    "user_id",
                    withdrawal.user_id
                )
                .eq(
                    "balance",
                    walletBalance
                )
                .select()
                .maybeSingle();


            if (refundError) {

                console.error(
                    "Withdrawal refund error:",
                    refundError
                );

                return;

            }


            if (!refundedWallet) {

                console.error(
                    "=========================================="
                );

                console.error(
                    "❌ REFUND FAILED"
                );

                console.error(
                    "Wallet balance changed before refund."
                );

                console.error(
                    "Withdrawal:",
                    withdrawal.reference
                );

                console.error(
                    "=========================================="
                );

                return;

            }


            // ==========================================
            // RECORD REFUND
            // ==========================================

            const {
                error: refundTransactionError
            } = await supabase
                .from("wallet_transactions")
                .insert({

                    user_id:
                        withdrawal.user_id,

                    wallet_id:
                        withdrawal.wallet_id,

                    transaction_type:
                        "refund",

                    type:
                        "refund",

                    amount:
                        refundAmount,

                    status:
                        "completed",

                    reference:
                        `REFUND-${withdrawal.reference}`,

                    reference_id:
                        withdrawal.id,

                    payment_method:
                        "mpesa",

                    description:
                        "Refund for failed M-Pesa withdrawal",

                    balance_before:
                        walletBalance,

                    balance_after:
                        refundBalance

                });


            if (
                refundTransactionError
            ) {

                console.error(
                    "Refund transaction log error:",
                    refundTransactionError
                );

            }


            // ==========================================
            // REFUND SUCCESS LOG
            // ==========================================

            console.log(
                "=========================================="
            );

            console.log(
                "💰 WITHDRAWAL REFUNDED"
            );

            console.log(
                "Reference:",
                withdrawal.reference
            );

            console.log(
                "Refund USD:",
                refundAmount
            );

            console.log(
                "Balance Before:",
                walletBalance
            );

            console.log(
                "Balance After:",
                refundBalance
            );

            console.log(
                "=========================================="
            );

        }

        catch (error) {

            console.error(
                "B2C result callback error:",
                error
            );

        }

    }
);
// ==========================================
// ADMIN REJECT WITHDRAWAL
// ==========================================

app.post(
    "/api/admin/withdrawals/:id/reject",
    authenticateUser,
    async (req, res) => {

        try {

            const withdrawalId =
                String(
                    req.params.id || ""
                ).trim();

            const reason =
                String(
                    req.body?.reason || ""
                ).trim();


            if (!withdrawalId) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Withdrawal ID is required"

                });

            }


            if (!reason) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Rejection reason is required"

                });

            }


            if (reason.length > 500) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Rejection reason is too long"

                });

            }


            // ==========================================
            // VERIFY ADMIN
            // ==========================================

            const {
                data: adminProfile,
                error: adminError
            } = await supabase
                .from("profiles")
                .select(
                    "id, role"
                )
                .eq(
                    "id",
                    req.user.id
                )
                .maybeSingle();


            const adminRole =
                String(
                    adminProfile?.role || ""
                )
                    .trim()
                    .toLowerCase();


            const allowedAdminRoles = [
                "admin",
                "super_admin",
                "owner"
            ];


            if (
                adminError ||
                !adminProfile ||
                !allowedAdminRoles.includes(
                    adminRole
                )
            ) {

                return res.status(403).json({

                    success:
                        false,

                    message:
                        "Admin access required"

                });

            }


            // ==========================================
            // LOAD WITHDRAWAL
            // ==========================================

            const {
                data: withdrawal,
                error: withdrawalError
            } = await supabase
                .from("withdrawals")
                .select("*")
                .eq(
                    "id",
                    withdrawalId
                )
                .maybeSingle();


            if (withdrawalError) {

                console.error(
                    "Reject withdrawal load error:",
                    withdrawalError
                );

                return res.status(500).json({

                    success:
                        false,

                    message:
                        "Unable to load withdrawal"

                });

            }


            if (!withdrawal) {

                return res.status(404).json({

                    success:
                        false,

                    message:
                        "Withdrawal not found"

                });

            }


            // ==========================================
            // ONLY PENDING CAN BE REJECTED
            // ==========================================

            if (
                String(
                    withdrawal.status || ""
                )
                    .trim()
                    .toLowerCase() !==
                "pending"
            ) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        `Withdrawal cannot be rejected because its current status is ${withdrawal.status}`

                });

            }


            // ==========================================
            // VALIDATE WITHDRAWAL AMOUNT
            // ==========================================

            const amount =
                Number(
                    withdrawal.amount || 0
                );


            if (
                !Number.isFinite(amount) ||
                amount <= 0
            ) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Invalid withdrawal amount"

                });

            }


            // ==========================================
            // IMPORTANT FINANCIAL RULE
            // ==========================================
            //
            // The withdrawal amount was already reserved
            // from the user's wallet when the withdrawal
            // request was created.
            //
            // REJECTION DOES NOT REFUND THE USER.
            //
            // The reserved funds remain with KMFBinary
            // pending further resolution.
            //
            // Therefore:
            //
            // - DO NOT update wallet.balance
            // - DO NOT create withdrawal_refund
            // - DO NOT add money back to the user
            //
            // ==========================================


            // ==========================================
            // MARK WITHDRAWAL REJECTED
            // ==========================================

            const {
                data: rejectedWithdrawal,
                error: rejectionUpdateError
            } = await supabase
                .from("withdrawals")
                .update({

                    status:
                        "rejected",

                    reviewed_by:
                        req.user.id,

                    reviewed_at:
                        new Date().toISOString(),

                    rejection_reason:
                        reason,

                    admin_notes:
                        `Withdrawal rejected. Reserved funds retained by KMFBinary pending resolution. Reason: ${reason}`,

                    updated_at:
                        new Date().toISOString()

                })
                .eq(
                    "id",
                    withdrawal.id
                )
                .eq(
                    "status",
                    "pending"
                )
                .select("*")
                .maybeSingle();


            if (
                rejectionUpdateError
            ) {

                console.error(
                    "Reject withdrawal update error:",
                    rejectionUpdateError
                );

                return res.status(409).json({

                    success:
                        false,

                    message:
                        "Withdrawal could not be rejected. Please try again."

                });

            }


            if (
                !rejectedWithdrawal
            ) {

                return res.status(409).json({

                    success:
                        false,

                    message:
                        "Withdrawal could not be rejected because it may have already been processed."

                });

            }


            // ==========================================
            // MARK ORIGINAL WALLET TRANSACTION REJECTED
            // ==========================================

            const {
                data: originalTransaction,
                error: originalTransactionLookupError
            } = await supabase
                .from("wallet_transactions")
                .select("*")
                .eq(
                    "reference_id",
                    withdrawal.id
                )
                .eq(
                    "transaction_type",
                    "withdrawal"
                )
                .maybeSingle();


            if (
                originalTransactionLookupError
            ) {

                console.error(
                    "Original withdrawal transaction lookup error:",
                    originalTransactionLookupError
                );

            }


            if (
                originalTransaction
            ) {

                const {
                    error:
                        originalTransactionUpdateError
                } = await supabase
                    .from("wallet_transactions")
                    .update({

                        status:
                            "rejected",

                        updated_at:
                            new Date().toISOString()

                    })
                    .eq(
                        "id",
                        originalTransaction.id
                    );


                if (
                    originalTransactionUpdateError
                ) {

                    console.error(
                        "Original withdrawal transaction update error:",
                        originalTransactionUpdateError
                    );

                }

            }


            // ==========================================
            // NO REFUND TRANSACTION
            // ==========================================
            //
            // IMPORTANT:
            //
            // We intentionally DO NOT create:
            //
            // transaction_type: "deposit"
            // type: "withdrawal_refund"
            //
            // because the rejected withdrawal amount
            // must NOT return to the user's wallet.
            //
            // The funds remain retained by KMFBinary
            // pending resolution.
            //
            // ==========================================


            // ==========================================
            // AUDIT LOG
            // ==========================================

            const {
                error: auditError
            } = await supabase
                .from("withdrawal_audit_logs")
                .insert({

                    withdrawal_id:
                        withdrawal.id,

                    user_id:
                        withdrawal.user_id,

                    admin_id:
                        req.user.id,

                    action:
                        "withdrawal_rejected",

                    reason:
                        reason,

                    notes:
                        "Withdrawal rejected by administrator. Reserved funds were not returned to the user and remain retained by KMFBinary pending resolution.",

                    status_before:
                        "pending",

                    status_after:
                        "rejected",

                    amount:
                        amount,

                    metadata: {

                        withdrawal_reference:
                            withdrawal.reference ||
                            null,

                        funds_status:
                            "retained_by_kmfbinary",

                        refund_processed:
                            false,

                        refund_reference:
                            null,

                        admin_role:
                            adminRole

                    }

                });


            if (
                auditError
            ) {

                console.error(
                    "Withdrawal rejection audit error:",
                    auditError
                );

            }


            // ==========================================
            // SERVER LOG
            // ==========================================

            console.log(
                `ADMIN WITHDRAWAL REJECTED: admin=${req.user.id} role=${adminRole} withdrawal=${withdrawal.id} user=${withdrawal.user_id} amount=${amount} funds=RETAINED_BY_KMFBINARY reason=${reason}`
            );


            // ==========================================
            // RESPONSE
            // ==========================================

            return res.json({

                success:
                    true,

                message:
                    `Withdrawal rejected. $${amount.toFixed(6)} remains retained by KMFBinary pending resolution.`,

                withdrawal:
                    rejectedWithdrawal,

                funds: {

                    amount:
                        amount,

                    status:
                        "retained_by_kmfbinary",

                    refunded:
                        false

                },

                changedBy: {

                    id:
                        req.user.id,

                    role:
                        adminRole

                }

            });

        }

        catch (error) {

            console.error(
                "Admin reject withdrawal exception:",
                error
            );

            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to reject withdrawal"

            });

        }

    }
);
// ==========================================
// MPESA B2C TIMEOUT CALLBACK
// ==========================================

app.get(
    "/api/mpesa/b2c/timeout",
    (req, res) => {

        console.log(
            "B2C TIMEOUT GET REQUEST:",
            req.originalUrl
        );

        return res.status(200).json({

            success: true,

            message:
                "B2C timeout endpoint is active. POST required."

        });

    }
);


app.post(
    "/api/mpesa/b2c/timeout",
    async (req, res) => {

        console.log(
            "=========================================="
        );

        console.log(
            "⚠️ MPESA B2C TIMEOUT"
        );

        console.log(
            JSON.stringify(
                req.body,
                null,
                2
            )
        );

        console.log(
            "=========================================="
        );


        // ==========================================
        // ACKNOWLEDGE SAFARICOM
        // ==========================================

        res.status(200).json({

            Result: {

                ResultCode: 0,

                ResultDesc:
                    "Timeout callback received"

            }

        });


        try {

            const result =
                req.body?.Result;


            if (!result) {

                console.error(
                    "Timeout callback missing Result object"
                );

                return;

            }


            const originatorConversationID =
                String(
                    result.OriginatorConversationID ||
                    ""
                ).trim();


            if (!originatorConversationID) {

                console.error(
                    "Timeout callback missing OriginatorConversationID"
                );

                return;

            }


            // ==========================================
            // FIND WITHDRAWAL
            // ==========================================

            const {
                data: withdrawal,
                error
            } = await supabase
                .from("withdrawals")
                .select("*")
                .eq(
                    "originator_conversation_id",
                    originatorConversationID
                )
                .maybeSingle();


            if (error) {

                console.error(
                    "Timeout withdrawal lookup error:",
                    error
                );

                return;

            }


            if (!withdrawal) {

                console.error(
                    "Timeout withdrawal not found:",
                    originatorConversationID
                );

                return;

            }

// ==========================================
// DUPLICATE PROTECTION
// ==========================================
//
// A withdrawal can reach the B2C callback in either:
//
// pending     = older/legacy flow
// processing  = admin-approved flow
//
// completed / failed / timeout are ignored.
// ==========================================

if (
    withdrawal.status !== "pending" &&
    withdrawal.status !== "processing"
) {

    console.log(
        "B2C callback already processed:",
        withdrawal.reference,
        withdrawal.status
    );

    return;

}

            // ==========================================
            // MARK TIMEOUT
            // ==========================================

            const timeoutDescription =
                "M-Pesa B2C timed out. Awaiting reconciliation.";


            const {
                data: timedOutWithdrawal,
                error: timeoutError
            } = await supabase
                .from("withdrawals")
                .update({

                    status:
                        "timeout",

                    result_code:
                        String(
                            result?.ResultCode ??
                            ""
                        ),

                    result_description:
                        timeoutDescription,

                    updated_at:
                        new Date().toISOString()

                })
                .eq(
                    "id",
                    withdrawal.id
                )
                .eq(
                    "status",
                    "pending"
                )
                .select()
                .maybeSingle();


            if (timeoutError) {

                console.error(
                    "Timeout update error:",
                    timeoutError
                );

                return;

            }


            if (!timedOutWithdrawal) {

                console.log(
                    "Timeout already processed:"
                );

                return;

            }


            // ==========================================
            // UPDATE WALLET TRANSACTION
            // ==========================================

            const {
                error: walletTransactionError
            } = await supabase
                .from("wallet_transactions")
                .update({

                    status:
                        "timeout",

                    result_code:
                        String(
                            result?.ResultCode ??
                            ""
                        ),

                    result_description:
                        timeoutDescription

                })
                .eq(
                    "reference_id",
                    withdrawal.id
                )
                .eq(
                    "status",
                    "pending"
                );


            if (
                walletTransactionError
            ) {

                console.error(
                    "Timeout wallet transaction update error:",
                    walletTransactionError
                );

            }


            // ==========================================
            // DO NOT REFUND TIMEOUT
            // ==========================================
            //
            // Timeout does not prove payment failed.
            // Funds remain reserved until reconciliation.
            //


            console.log(
                "=========================================="
            );

            console.log(
                "⚠️ WITHDRAWAL MARKED TIMEOUT"
            );

            console.log(
                "Reference:",
                withdrawal.reference
            );

            console.log(
                "USD Amount:",
                withdrawal.amount
            );

            console.log(
                "Phone:",
                withdrawal.phone_number
            );

            console.log(
                "Status:",
                "timeout"
            );

            console.log(
                "Funds remain reserved pending reconciliation."
            );

            console.log(
                "=========================================="
            );

        }

        catch (error) {

            console.error(
                "B2C timeout callback error:",
                error
            );

        }

    }
);


// ==========================================
// GET USER'S TRADES ONLY
// ==========================================

app.get(
    "/api/trades",
    authenticateUser,
    async (req, res) => {

        try {

            const {
                data,
                error
            } = await supabase
                .from("trades")
                .select("*")
                .eq(
                    "user_id",
                    req.user.id
                )
                .order(
                    "created_at",
                    {
                        ascending: false
                    }
                );

            if (error) {

                console.error(
                    "Get trades error:",
                    error
                );

                return res.status(500).json({

                    success: false,

                    message:
                        "Unable to load trades"

                });

            }

            res.json({

                success: true,

                trades:
                    data || []

            });

        }

        catch (error) {

            console.error(
                "Trades API error:",
                error
            );

            res.status(500).json({

                success: false,

                message:
                    "Server error"

            });

        }

    }
);


// ==========================================
// ACCUMULATOR CASH OUT
// ==========================================

app.post(
    "/api/trades/:tradeId/cashout",
    authenticateUser,
    async (req, res) => {

        try {

            const tradeId =
                req.params.tradeId;


            if (!tradeId) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Missing trade ID"

                });

            }


            // ==========================================
            // GET PENDING ACCUMULATOR TRADE
            // ==========================================

            const {
                data: trade,
                error: tradeError
            } = await supabase
                .from("trades")
                .select("*")
                .eq(
                    "id",
                    tradeId
                )
                .eq(
                    "user_id",
                    req.user.id
                )
                .eq(
                    "contract_type",
                    "accumulator"
                )
                .eq(
                    "status",
                    "pending"
                )
                .maybeSingle();


            if (tradeError) {

                console.error(
                    "Cashout trade lookup error:",
                    tradeError
                );

                return res.status(500).json({

                    success: false,

                    message:
                        "Unable to find accumulator trade"

                });

            }


            if (!trade) {

                return res.status(404).json({

                    success: false,

                    message:
                        "Accumulator trade is no longer active"

                });

            }


            // ==========================================
            // CHECK KNOCKOUT
            // ==========================================

            const symbol =
                settlement.getSyntheticSymbol(
                    trade
                );


            if (!symbol) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Unable to identify market"

                });

            }


            const currentPrice =
                Number(
                    syntheticMarket.getPrice(
                        symbol
                    )
                );


            const barrier =
                Number(
                    trade.accumulator_barrier
                );


            const direction =
                String(
                    trade.accumulator_direction ||
                    ""
                )
                .trim()
                .toLowerCase();


            const knockout =
                (
                    direction === "above" &&
                    currentPrice <= barrier
                ) ||
                (
                    direction === "below" &&
                    currentPrice >= barrier
                );


            if (knockout) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Accumulator has already hit the knockout barrier"

                });

            }


            // ==========================================
            // CALCULATE CURRENT PAYOUT
            // ==========================================

            const growth =
                Number(
                    trade.accumulator_growth
                );


            const createdAt =
                new Date(
                    trade.created_at
                ).getTime();


            const elapsedSeconds =
                Math.max(
                    0,
                    Math.floor(
                        (
                            Date.now() -
                            createdAt
                        ) / 1000
                    )
                );


            const rawPayout =
                Number(trade.stake) *
                Math.pow(
                    1 + growth,
                    elapsedSeconds
                );


            // ==========================================
            // MAXIMUM PAYOUT
            // ==========================================

            const maxPayout =
                Number(trade.stake) *
                ACCUMULATOR_MAX_MULTIPLIER;


            const payout =
                Math.min(
                    rawPayout,
                    maxPayout
                );


            // ==========================================
            // 6 DECIMAL PRECISION
            // ==========================================

            const precisePayout =
                Number(
                    payout.toFixed(6)
                );


            const profit =
                Number(
                    (
                        precisePayout -
                        Number(trade.stake)
                    ).toFixed(6)
                );


            // ==========================================
            // CASH OUT
            // ==========================================

            const {
                data: updatedTrade,
                error: updateError
            } = await supabase
                .from("trades")
                .update({

                    status:
                        "won",

                    exit_price:
                        currentPrice,

                    payout:
                        precisePayout,

                    profit:
                        profit,

                    settled_at:
                        new Date().toISOString()

                })
                .eq(
                    "id",
                    trade.id
                )
                .eq(
                    "user_id",
                    req.user.id
                )
                .eq(
                    "status",
                    "pending"
                )
                .select()
                .maybeSingle();


            if (updateError) {

                console.error(
                    "Accumulator cashout update error:",
                    updateError
                );

                return res.status(500).json({

                    success: false,

                    message:
                        "Unable to cash out"

                });

            }


            if (!updatedTrade) {

                return res.status(409).json({

                    success: false,

                    message:
                        "Trade was already settled"

                });

            }


            // ==========================================
            // CREDIT PAYOUT
            // ==========================================

            const walletMode =
                String(
                    trade.mode || "real"
                )
                .trim()
                .toLowerCase();


            const balanceField =
                walletMode === "demo"
                    ? "demo_balance"
                    : "balance";


            const {
                data: wallet,
                error: walletError
            } = await supabase
                .from("wallets")
                .select("*")
                .eq(
                    "user_id",
                    req.user.id
                )
                .maybeSingle();


            if (walletError || !wallet) {

                console.error(
                    "Cashout wallet error:",
                    walletError
                );

                return res.status(500).json({

                    success: false,

                    message:
                        "Unable to load wallet"

                });

            }


            const oldBalance =
                Number(
                    wallet[balanceField]
                );


            const newBalance =
                Number(
                    (
                        oldBalance +
                        precisePayout
                    ).toFixed(6)
                );


            // ==========================================
            // ATOMIC-STYLE WALLET CREDIT
            // ==========================================

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
                    oldBalance
                )
                .select()
                .maybeSingle();


            if (walletUpdateError) {

                console.error(
                    "Cashout wallet update error:",
                    walletUpdateError
                );

                return res.status(500).json({

                    success: false,

                    message:
                        "Unable to credit cashout"

                });

            }


            if (!updatedWallet) {

                return res.status(409).json({

                    success: false,

                    message:
                        "Wallet balance changed. Cashout cancelled."

                });

            }


            // ==========================================
            // WALLET TRANSACTION
            // ==========================================

            const {
                error: payoutTransactionError
            } = await supabase
                .from("wallet_transactions")
                .insert({

                    user_id:
                        req.user.id,

                    wallet_id:
                        wallet.id,

                    transaction_type:
                        "trade_payout",

                    type:
                        "trade_payout",

                    amount:
                        precisePayout,

                    status:
                        "completed",

                    payment_method:
                        "wallet",

                    reference:
                        "PAYOUT-" +
                        trade.id,

                    reference_id:
                        trade.id,

                    description:
                        "Accumulator trade payout",

                    balance_before:
                        oldBalance,

                    balance_after:
                        newBalance

                });


            if (payoutTransactionError) {

                console.error(
                    "Accumulator payout transaction error:",
                    payoutTransactionError
                );

            }


            // ==========================================
            // CASHOUT LOG
            // ==========================================

            console.log(
                "=========================================="
            );

            console.log(
                "💰 ACCUMULATOR CASHOUT"
            );

            console.log(
                "Trade:",
                trade.id
            );

            console.log(
                "Stake:",
                trade.stake
            );

            console.log(
                "Growth:",
                growth
            );

            console.log(
                "Payout:",
                precisePayout
            );

            console.log(
                "Profit:",
                profit
            );

            console.log(
                "Balance Before:",
                oldBalance
            );

            console.log(
                "Balance After:",
                newBalance
            );

            console.log(
                "=========================================="
            );


            return res.json({

                success:
                    true,

                message:
                    "Accumulator cashed out successfully",

                trade:
                    updatedTrade,

                payout:
                    precisePayout,

                profit:
                    profit,

                balance:
                    newBalance

            });

        }

        catch (error) {

            console.error(
                "Accumulator cashout error:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "Unable to cash out accumulator"

            });

        }

    }
);


// ==========================================
// GET ONE USER TRADE
// ==========================================

app.get(
    "/api/trades/:id",
    authenticateUser,
    async (req, res) => {

        try {

            const tradeId =
                req.params.id;


            if (!tradeId) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Trade ID is required"

                });

            }


            const {
                data,
                error
            } = await supabase
                .from("trades")
                .select("*")
                .eq(
                    "id",
                    tradeId
                )
                .eq(
                    "user_id",
                    req.user.id
                )
                .single();


            if (
                error ||
                !data
            ) {

                return res.status(404).json({

                    success: false,

                    message:
                        "Trade not found"

                });

            }


            res.json({

                success: true,

                trade:
                    data

            });

        }

        catch (error) {

            console.error(
                "Single trade API error:",
                error
            );

            res.status(500).json({

                success: false,

                message:
                    "Server error"

            });

        }

    }
);


// ==========================================
// PLACE TRADE
// ==========================================

app.post(
    "/api/trades",
    authenticateUser,
    async (req, res) => {

        console.log(
            "TRADE REQUEST FROM:",
            req.user.id
        );

        process.stdout.write(
            "\n>>> POST TRADE CHECKPOINT <<<\n"
        );


        try {

            console.log(
                "========== ENTERED TRY BLOCK =========="
            );


            const {
                marketId,
                action,
                stake,
                duration,
                durationUnit,
                targetDigit
            } = req.body;


            const contractType =
                String(
                    req.body.contractType || ""
                )
                .trim()
                .toLowerCase();


            if (!marketId) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Missing marketId"

                });

            }


            if (!contractType) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Missing contractType"

                });

            }


            if (!action) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Missing action"

                });

            }


            if (
                stake === undefined ||
                stake === null
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Missing stake"

                });

            }


            const amount =
                Number(stake);


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

                return res.status(400).json({

                    success: false,

                    message:
                        "Duration must be a positive whole number"

                });

            }


            if (
                contractDurationUnit !== "s" &&
                contractDurationUnit !== "t"
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Duration unit must be seconds (s) or ticks (t)"

                });

            }


            console.log(
                "DURATION DEBUG:",
                "duration received =",
                contractDuration,
                "duration unit =",
                contractDurationUnit
            );


            if (
                !Number.isFinite(
                    amount
                )
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Stake must be a number"

                });

            }


            if (
                amount < 0.35
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Minimum stake is $0.35"

                });

            }


            // ==========================================
            // MARKET QUERY
            // ==========================================

            console.log(
                "TRADE CHECKPOINT 2 - BEFORE MARKET QUERY"
            );


          
            const isUUID =
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
                    .test(String(marketId || "").trim());

            let marketQuery = supabase
                .from("markets")
                .select("*")
                .eq("is_active", true);

            marketQuery = isUUID
                ? marketQuery.eq("id", String(marketId).trim())
                : marketQuery.eq("symbol", String(marketId).trim());

            const {
                data: market,
                error: marketError
            } = await marketQuery.single();




            console.log(
                "TRADE CHECKPOINT 3 - AFTER MARKET QUERY"
            );


            console.log(
                "========== MARKET LOOKUP DEBUG =========="
            );

            console.log(
                "marketId:",
                marketId
            );

            console.log(
                "market:",
                market
            );

            console.log(
                "marketError:",
                marketError
            );

            console.log(
                "=========================================="
            );


            if (
                marketError ||
                !market
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Market not found or inactive"

                });

            }


            // ==========================================
            // CONTRACT TYPE VALIDATION
            // ==========================================

            const allowedContractTypes = [

                "matches",

                "differs",

                "over_under",

                "odd_even",

                "rise_fall",

                "higher_lower",

                "touch_no_touch",

                "accumulator"

            ];


            const isVOLMarket =
                String(
                    market.symbol || ""
                )
                .trim()
                .toUpperCase()
                .startsWith("VOL-");


            if (
                !allowedContractTypes.includes(
                    contractType
                )
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Unsupported contract type"

                });

            }


            // ==========================================
            // VOL MARKETS
            // ==========================================

            if (
                !isVOLMarket &&
                market.contract_type !== contractType
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Contract type does not match market"

                });

            }


            console.log(
                "CONTRACT VALIDATION PASSED"
            );

            console.log(
                "Market:",
                market.symbol
            );

            console.log(
                "Database contract:",
                market.contract_type
            );

            console.log(
                "Selected contract:",
                contractType
            );

            console.log(
                "Is VOL market:",
                isVOLMarket
            );


            // ==========================================
            // VALID ACTIONS
            // ==========================================

            const validActions = {

                matches: [
                    "matches"
                ],

                differs: [
                    "differs"
                ],

                over_under: [
                    "over",
                    "under"
                ],

                odd_even: [
                    "odd",
                    "even"
                ],

                rise_fall: [
                    "rise",
                    "fall"
                ],

                higher_lower: [
                    "higher",
                    "lower"
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
                !validActions[contractType] ||
                !validActions[contractType].includes(
                    action
                )
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid trade action"

                });

            }


            console.log(
                "SYNTHETIC DEBUG MARKET:",
                market
            );

            console.log(
                "MARKET SYMBOL:",
                market.symbol
            );


            const syntheticSymbol =
                getSyntheticSymbol(
                    market
                );


            console.log(
                "SYNTHETIC SYMBOL RESULT:",
                syntheticSymbol
            );


            if (!syntheticSymbol) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Synthetic market is not configured"

                });

            }


                     const syntheticConfig =
                syntheticMarket.markets[
                    syntheticSymbol
                ];


            console.log(
                "ACCUMULATOR CHECKPOINT 1 - SYNTHETIC CONFIG:",
                syntheticConfig
            );


            if (!syntheticConfig) {

                return res.status(500).json({

                    success: false,

                    message:
                        "Synthetic market configuration not found"

                });

            }


            console.log(
                "ACCUMULATOR CHECKPOINT 2 - BEFORE GET PRICE"
            );


            const entryPrice =
                syntheticMarket.getPrice(
                    syntheticSymbol
                );


            console.log(
                "ACCUMULATOR CHECKPOINT 3 - ENTRY PRICE:",
                entryPrice
            );


            console.log(
                "ACCUMULATOR CHECKPOINT 4 - BEFORE GET MARKET"
            );


            const marketInfo =
                syntheticMarket.getMarket(
                    syntheticSymbol
                );


            console.log(
                "ACCUMULATOR CHECKPOINT 5 - MARKET INFO:",
                marketInfo
            );


            const entryTick =
                marketInfo
                    ? Number(
                        marketInfo.tick
                    )
                    : null;


            console.log(
                "ACCUMULATOR CHECKPOINT 6 - ENTRY TICK:",
                entryTick
            );


            if (
                entryPrice === null ||
                !Number.isFinite(entryPrice)
            ) {

                console.error(
                    "ACCUMULATOR ERROR - CURRENT MARKET PRICE UNAVAILABLE:",
                    entryPrice
                );

                return res.status(500).json({

                    success: false,

                    message:
                        "Current market price unavailable"

                });

            }


            console.log(
                "ACCUMULATOR CHECKPOINT 7 - ENTRY PRICE VALID:",
                entryPrice
            );


            let finalTargetDigit = null;


            // ==========================================
            // TARGET DIGIT VALIDATION
            // ==========================================

            let suppliedDigit = null;


            if (
                targetDigit !== null &&
                targetDigit !== undefined &&
                targetDigit !== ""
            ) {

                suppliedDigit =
                    Number(
                        targetDigit
                    );

            }


            // ==========================================
            // RISE / FALL
            // ==========================================

            if (
                contractType ===
                "rise_fall"
            ) {

                finalTargetDigit =
                    null;

            }


            // ==========================================
            // HIGHER / LOWER
            // ==========================================
let higherLowerBarrier = null;

if (contractType === "higher_lower") {

    const suppliedBarrier =
        Number(req.body.barrierPrice);

    if (
        !Number.isFinite(suppliedBarrier) ||
        suppliedBarrier <= 0
    ) {
        return res.status(400).json({
            success: false,
            message:
                "Higher/Lower requires a valid price barrier"
        });
    }

    higherLowerBarrier =
        Number(
            suppliedBarrier.toFixed(2)
        );

    finalTargetDigit = null;
}
            // ==========================================
            // OVER / UNDER
            // ==========================================

            if (
                contractType ===
                "over_under"
            ) {

                if (
                    !Number.isInteger(
                        suppliedDigit
                    ) ||
                    suppliedDigit < 1 ||
                    suppliedDigit > 8
                ) {

                    return res.status(400).json({

                        success: false,

                        message:
                            "Target digit must be an integer from 1 to 8 for Over/Under"

                    });

                }


                finalTargetDigit =
                    suppliedDigit;

            }


            // ==========================================
            // MATCHES
            // ==========================================

            if (
                contractType ===
                "matches"
            ) {

                if (
                    !Number.isInteger(
                        suppliedDigit
                    ) ||
                    suppliedDigit < 0 ||
                    suppliedDigit > 9
                ) {

                    return res.status(400).json({

                        success: false,

                        message:
                            "Target digit must be an integer from 0 to 9 for Matches"

                    });

                }


                finalTargetDigit =
                    suppliedDigit;

            }


            // ==========================================
            // DIFFERS
            // ==========================================

            if (
                contractType ===
                "differs"
            ) {

                if (
                    !Number.isInteger(
                        suppliedDigit
                    ) ||
                    suppliedDigit < 0 ||
                    suppliedDigit > 9
                ) {

                    return res.status(400).json({

                        success: false,

                        message:
                            "Target digit must be an integer from 0 to 9 for Differs"

                    });

                }


                finalTargetDigit =
                    suppliedDigit;

            }


            // ==========================================
            // ODD / EVEN
            // ==========================================

            if (
                contractType ===
                "odd_even"
            ) {

                finalTargetDigit =
                    null;

            }


            // ==========================================
            // TOUCH / NO TOUCH
            // ==========================================

            let barrierPrice = null;

            let barrierDirection = null;


            if (
                contractType ===
                "touch_no_touch"
            ) {

                barrierDirection =
                    String(
                        req.body.barrierDirection || ""
                    )
                    .trim()
                    .toLowerCase();


                if (
                    barrierDirection !== "above" &&
                    barrierDirection !== "below"
                ) {

                    return res.status(400).json({

                        success: false,

                        message:
                            "Touch/No Touch barrier direction must be above or below"

                    });

                }


                barrierPrice =
                    calculateTouchBarrier(
                        entryPrice,
                        barrierDirection
                    );

            }

            // ==========================================
            // ACCUMULATOR VARIABLES
            // ==========================================

            let accumulatorGrowth = null;

            let accumulatorBarrier = null;

            let accumulatorDirection = null;

            let accumulatorLowerBoundary = null;

            let accumulatorUpperBoundary = null;


            // ==========================================
            // TRADE EXPIRY
            // ==========================================

            let expiresAt = null;

            let expirySeconds =
                contractDuration;


            if (
                contractDurationUnit ===
                "s"
            ) {

                expiresAt =
                    new Date(
                        Date.now() +
                        contractDuration * 1000
                    );

                expirySeconds =
                    contractDuration;

            }


            if (
                contractDurationUnit ===
                "t"
            ) {

                // Each synthetic tick is treated as 1 second.
                expirySeconds =
                    contractDuration;

                // Database requires expires_at
                // even for tick trades.
                expiresAt =
                    new Date(
                        Date.now() +
                        contractDuration * 1000
                    );

            }


            // ==========================================
            // ACCUMULATOR
            // ==========================================

            if (
                contractType ===
                "accumulator"
            ) {

                finalTargetDigit =
                    null;


                // ------------------------------------------
                // GROWTH
                // ------------------------------------------

                accumulatorGrowth =
                    Number(
                        req.body.accumulatorGrowth
                    );


       // ------------------------------------------
// VALIDATE ACCUMULATOR GROWTH
// ------------------------------------------

const rawAccumulatorGrowth =
    req.body.accumulatorGrowth;

console.log(
    "ACCUMULATOR RAW GROWTH:",
    rawAccumulatorGrowth,
    "TYPE:",
    typeof rawAccumulatorGrowth
);

accumulatorGrowth =
    Number(
        Number(rawAccumulatorGrowth).toFixed(2)
    );

console.log(
    "ACCUMULATOR NORMALIZED GROWTH:",
    accumulatorGrowth
);

if (
    !Number.isFinite(
        accumulatorGrowth
    ) ||
    !ACCUMULATOR_GROWTH_OPTIONS.includes(
        accumulatorGrowth
    )
) {

    return res.status(400).json({

        success: false,

        message:
            "Accumulator growth must be 1%, 2%, 3%, 4% or 5%"

    });

}


                // ------------------------------------------
                // DIRECTION
                // ------------------------------------------

                accumulatorDirection =
                    String(
                        req.body.accumulatorDirection || ""
                    )
                    .trim()
                    .toLowerCase();


                if (
                    accumulatorDirection !==
                        "above" &&
                    accumulatorDirection !==
                        "below"
                ) {

                    return res.status(400).json({

                        success: false,

                        message:
                            "Accumulator direction must be above or below"

                    });

                }


                // ------------------------------------------
                // CALCULATE TWO FIXED BOUNDARIES
                // ------------------------------------------
                //
                // Entry price is the CENTER.
                //
                // Example:
                //
                // Entry = 100
                // Knockout = 2%
                //
                // Lower = 98
                // Upper = 102
                //
                // The boundaries remain fixed for
                // the lifetime of the trade.
                // ------------------------------------------
                console.log(
                    "ACCUMULATOR CHECKPOINT 8 - BEFORE BOUNDARY CALCULATION"
                );

                console.log(
                    "ACCUMULATOR ENTRY PRICE:",
                    entryPrice
                );

                console.log(
                    "ACCUMULATOR KNOCKOUT PERCENT:",
                    ACCUMULATOR_KNOCKOUT_PERCENT
                );


                const accumulatorBoundaries =
                    calculateAccumulatorBoundaries(
                        entryPrice
                    );


                console.log(
                    "ACCUMULATOR CHECKPOINT 9 - BOUNDARIES:",
                    accumulatorBoundaries
                );


                if (
                    !accumulatorBoundaries
                ) {

                    return res.status(500).json({

                        success: false,

                        message:
                            "Unable to calculate accumulator boundaries"

                    });

                }


                accumulatorLowerBoundary =
                    Number(
                        accumulatorBoundaries.lowerBoundary
                    );


                accumulatorUpperBoundary =
                    Number(
                        accumulatorBoundaries.upperBoundary
                    );


                console.log(
                    "ACCUMULATOR CHECKPOINT 10 - LOWER:",
                    accumulatorLowerBoundary
                );

                console.log(
                    "ACCUMULATOR CHECKPOINT 11 - UPPER:",
                    accumulatorUpperBoundary
                );
                // ------------------------------------------
                // LEGACY BARRIER FIELD
                // ------------------------------------------
                //
                // Keep the old database field populated
                // for compatibility.
                //
                // Above -> lower knockout
                // Below -> upper knockout
                // ------------------------------------------

                accumulatorBarrier =
                    accumulatorDirection ===
                    "above"
                        ? accumulatorLowerBoundary
                        : accumulatorUpperBoundary;

            }
            // ==========================================
            // GET USER WALLET
            // ==========================================

            const wallet =
                await getOrCreateWallet(
                    req.user.id
                );
// ==========================================
// DEMO / REAL ACCOUNT MODE
// ==========================================

const tradeMode =
    String(
        req.body.mode || "demo"
    )
    .trim()
    .toLowerCase();


if (
    tradeMode !== "demo" &&
    tradeMode !== "real"
) {

    return res.status(400).json({

        success: false,

        message:
            "Invalid trading account mode. Use demo or real."

    });

}
      // ==========================================
// SELECT AVAILABLE TRADING BALANCE
// ==========================================
//
// DEMO:
//     demo_balance only
//
// LIVE / REAL:
//     balance + bonus_balance
//
// IMPORTANT:
//     The live account uses the combined trading balance.
//     Real balance is consumed first.
//     Bonus is used only when the real balance is not enough.
//
// NOTE:
//     The trade records only the total stake.
// ==========================================

const isDemoTrade =
    tradeMode === "demo";


// ==========================================
// READ WALLET BALANCES
// ==========================================

const currentRealBalance =
    Number(
        wallet.balance || 0
    );

const currentBonusBalance =
    Number(
        wallet.bonus_balance || 0
    );

const currentDemoBalance =
    Number(
        wallet.demo_balance || 0
    );


if (
    !Number.isFinite(
        currentRealBalance
    ) ||
    !Number.isFinite(
        currentBonusBalance
    ) ||
    !Number.isFinite(
        currentDemoBalance
    )
) {

    return res.status(500).json({

        success: false,

        message:
            "Invalid wallet balance"

    });

}


// ==========================================
// CALCULATE AVAILABLE TRADING BALANCE
// ==========================================

const currentTradingBalance =
    isDemoTrade
        ? currentDemoBalance
        : (
            currentRealBalance +
            currentBonusBalance
        );


// ==========================================
// CHECK AVAILABLE BALANCE
// ==========================================

if (
    amount >
    currentTradingBalance
) {

    return res.status(400).json({

        success: false,

        message:
            `Insufficient ${tradeMode} balance`

    });

}


// ==========================================
// CALCULATE STAKE FUNDING
// ==========================================
//
// DEMO:
//     demo_balance is reduced.
//
// LIVE:
//     Real balance is consumed first.
//     Bonus covers the remaining amount.
// ==========================================

let realStakeAmount = 0;

let bonusStakeAmount = 0;

let newRealBalance =
    currentRealBalance;

let newBonusBalance =
    currentBonusBalance;

let newDemoBalance =
    currentDemoBalance;


if (isDemoTrade) {

    // ==========================================
    // DEMO TRADE
    // ==========================================

    newDemoBalance =
        Number(
            (
                currentDemoBalance -
                amount
            ).toFixed(6)
        );

} else {

    // ==========================================
    // LIVE / REAL TRADE
    // ==========================================

    realStakeAmount =
        Math.min(
            amount,
            currentRealBalance
        );

    bonusStakeAmount =
        Number(
            (
                amount -
                realStakeAmount
            ).toFixed(6)
        );


    newRealBalance =
        Number(
            (
                currentRealBalance -
                realStakeAmount
            ).toFixed(6)
        );


    newBonusBalance =
        Number(
            (
                currentBonusBalance -
                bonusStakeAmount
            ).toFixed(6)
        );

}


// ==========================================
// SAFETY CHECK
// ==========================================

if (
    newRealBalance < 0 ||
    newBonusBalance < 0 ||
    newDemoBalance < 0
) {

    return res.status(400).json({

        success: false,

        message:
            "Insufficient trading balance"

    });

}


// ==========================================
// RESERVE TRADE STAKE
// ==========================================
//
// IMPORTANT:
// Supabase update() can only be called once
// on the query builder.
//
// Therefore we prepare the update object first.
// ==========================================

let walletUpdateData = {

    updated_at:
        new Date().toISOString()

};


if (isDemoTrade) {

    walletUpdateData.demo_balance =
        newDemoBalance;

} else {

    walletUpdateData.balance =
        newRealBalance;

    walletUpdateData.bonus_balance =
        newBonusBalance;

}


let walletUpdateQuery =
    supabase
        .from("wallets")
        .update(
            walletUpdateData
        )
        .eq(
            "id",
            wallet.id
        );


if (isDemoTrade) {

    walletUpdateQuery =
        walletUpdateQuery
            .eq(
                "demo_balance",
                currentDemoBalance
            );

} else {

    walletUpdateQuery =
        walletUpdateQuery
            .eq(
                "balance",
                currentRealBalance
            )
            .eq(
                "bonus_balance",
                currentBonusBalance
            );

}


const {
    data: updatedWallet,
    error: walletUpdateError
} =
    await walletUpdateQuery
        .select()
        .maybeSingle();


if (walletUpdateError) {

    console.error(
        "Trade wallet update error:",
        walletUpdateError
    );

    return res.status(500).json({

        success: false,

        message:
            "Unable to reserve trade stake"

    });

}


if (!updatedWallet) {

    return res.status(409).json({

        success: false,

        message:
            "Wallet balance changed. Please try again."

    });

}


// ==========================================
// TRADE FUNDING LOG
// ==========================================

console.log(
    "=========================================="
);

console.log(
    "TRADE WALLET RESERVATION"
);

console.log(
    "TRADE MODE:",
    tradeMode
);

console.log(
    "TRADE STAKE:",
    amount
);

console.log(
    "TRADING BALANCE BEFORE:",
    currentTradingBalance
);

console.log(
    "REAL BALANCE BEFORE:",
    currentRealBalance
);

console.log(
    "BONUS BALANCE BEFORE:",
    currentBonusBalance
);

console.log(
    "DEMO BALANCE BEFORE:",
    currentDemoBalance
);

console.log(
    "REAL STAKE USED:",
    realStakeAmount
);

console.log(
    "BONUS STAKE USED:",
    bonusStakeAmount
);

console.log(
    "REAL BALANCE AFTER:",
    newRealBalance
);

console.log(
    "BONUS BALANCE AFTER:",
    newBonusBalance
);

console.log(
    "DEMO BALANCE AFTER:",
    newDemoBalance
);

console.log(
    "=========================================="
);


// ==========================================
// CREATE TRADE
// ==========================================

const {
    data: trade,
    error: tradeError
} =
    await supabase
        .from("trades")
        .insert({

            user_id:
                req.user.id,

            market_id:
                market.id,

            symbol:
                market.symbol,

            contract_type:
                contractType,

            action:
                action,

            stake:
                amount,

            entry_price:
                entryPrice,

            target_price:

                contractType ===
                "touch_no_touch"

                    ? barrierPrice

                    : contractType ===
                      "higher_lower"

                        ? higherLowerBarrier

                        : null,

            target_digit:
                finalTargetDigit,

            expiry_seconds:
                expirySeconds,

            duration:
                contractDuration,

            duration_unit:
                contractDurationUnit,

            entry_tick:
                entryTick,

            expiry_tick:

                contractDurationUnit ===
                "t"

                    ? entryTick +
                      contractDuration

                    : null,

            expires_at:

                expiresAt
                    ? expiresAt.toISOString()
                    : null,

            status:
                "pending",

            mode:
                tradeMode,

            barrier_touched:
                false,

            barrier_touched_at:
                null,

            barrier_direction:
                barrierDirection,

            accumulator_broken:
                false,

            accumulator_broken_at:
                null,

            accumulator_growth:
                accumulatorGrowth,

            accumulator_barrier:
                accumulatorBarrier,

            accumulator_lower_boundary:
                accumulatorLowerBoundary,

            accumulator_upper_boundary:
                accumulatorUpperBoundary,

            accumulator_direction:
                accumulatorDirection,

            accumulator_current_rate:
                accumulatorGrowth

        })
        .select()
        .single();


if (tradeError) {

    console.error(
        "Trade insert error:",
        tradeError
    );


    // ==========================================
    // RESTORE STAKE AFTER TRADE INSERT FAILURE
    // ==========================================

    let restoreData = {

        updated_at:
            new Date().toISOString()

    };


    if (isDemoTrade) {

        restoreData.demo_balance =
            currentDemoBalance;

    } else {

        restoreData.balance =
            currentRealBalance;

        restoreData.bonus_balance =
            currentBonusBalance;

    }


    let restoreQuery =
        supabase
            .from("wallets")
            .update(
                restoreData
            )
            .eq(
                "id",
                wallet.id
            );


    if (isDemoTrade) {

        restoreQuery =
            restoreQuery
                .eq(
                    "demo_balance",
                    newDemoBalance
                );

    } else {

        restoreQuery =
            restoreQuery
                .eq(
                    "balance",
                    newRealBalance
                )
                .eq(
                    "bonus_balance",
                    newBonusBalance
                );

    }


    const {
        error: restoreError
    } =
        await restoreQuery;


    if (restoreError) {

        console.error(
            "Trade stake restore error:",
            restoreError
        );

    }


    return res.status(500).json({

        success: false,

        message:
            "Unable to create trade. Your stake was restored."

    });

}


// ==========================================
// RECORD TRADE STAKE TRANSACTION
// ==========================================

const transactionBalanceBefore =
    isDemoTrade
        ? currentDemoBalance
        : currentTradingBalance;

const transactionBalanceAfter =
    isDemoTrade
        ? newDemoBalance
        : (
            newRealBalance +
            newBonusBalance
        );


const {
    error: transactionError
} =
    await supabase
        .from("wallet_transactions")
        .insert({

            user_id:
                req.user.id,

            wallet_id:
                wallet.id,

            transaction_type:
                "trade_stake",

            type:
                "trade_stake",

            amount:
                Number(
                    amount.toFixed(6)
                ),

            status:
                "completed",

            payment_method:
                "wallet",

            reference:
                "TRADE-" +
                trade.id,

            reference_id:
                trade.id,

            description:
                "Trade stake reserved",

            balance_before:
                Number(
                    transactionBalanceBefore
                        .toFixed(6)
                ),

            balance_after:
                Number(
                    transactionBalanceAfter
                        .toFixed(6)
                )

        });


if (transactionError) {

    console.error(
        "Trade wallet transaction error:",
        transactionError
    );


    // ==========================================
    // RESTORE WALLET
    // ==========================================

    let restoreTransactionData = {

        updated_at:
            new Date().toISOString()

    };


    if (isDemoTrade) {

        restoreTransactionData.demo_balance =
            currentDemoBalance;

    } else {

        restoreTransactionData.balance =
            currentRealBalance;

        restoreTransactionData.bonus_balance =
            currentBonusBalance;

    }


    let restoreTransactionQuery =
        supabase
            .from("wallets")
            .update(
                restoreTransactionData
            )
            .eq(
                "id",
                wallet.id
            );


    if (isDemoTrade) {

        restoreTransactionQuery =
            restoreTransactionQuery
                .eq(
                    "demo_balance",
                    newDemoBalance
                );

    } else {

        restoreTransactionQuery =
            restoreTransactionQuery
                .eq(
                    "balance",
                    newRealBalance
                )
                .eq(
                    "bonus_balance",
                    newBonusBalance
                );

    }


    const {
        error: transactionRestoreError
    } =
        await restoreTransactionQuery;


    if (transactionRestoreError) {

        console.error(
            "Trade transaction wallet restore error:",
            transactionRestoreError
        );

    }


    // ==========================================
    // CANCEL TRADE
    // ==========================================

    const {
        error: cancelTradeError
    } =
        await supabase
            .from("trades")
            .update({

                status:
                    "cancelled"

            })
            .eq(
                "id",
                trade.id
            )
            .eq(
                "status",
                "pending"
            );


    if (cancelTradeError) {

        console.error(
            "Trade cancellation error:",
            cancelTradeError
        );

    }


    return res.status(500).json({

        success: false,

        message:
            "Unable to record trade payment. Your stake was restored."

    });

}


// ==========================================
// TRADE CREATED
// ==========================================

console.log(
    "Trade created:",
    trade.id,
    "User:",
    req.user.id,
    "Database symbol:",
    market.symbol,
    "Synthetic market:",
    syntheticSymbol,
    "Contract:",
    contractType,
    "Action:",
    action,
    "Entry:",
    entryPrice,
    "Entry Digit:",
    getLastDigit(
        entryPrice
    ),
    "Target Digit:",
    finalTargetDigit,
    "Target Price:",
    higherLowerBarrier,
    "Duration:",
    contractDuration +
    " " +
    contractDurationUnit
);


return res.json({

    success:
        true,

    message:
        "Trade placed successfully",

    trade

});

} catch (error) {

    console.error(
        "Trade error:",
        error
    );

    return res.status(500).json({

        success:
            false,

        message:
            "Unable to place trade"

    });

}

}); 

// ======================================================
// GET MARKET STATISTICS
// ======================================================

app.get(
    "/api/market-statistics",
    authenticateUser,
    async (req, res) => {

        try {

            const requestedSymbol =
                String(req.query.symbol || "")
                    .trim()
                    .toUpperCase();

            let limit =
                Number(req.query.limit || 100);
                const targetDigit =
    Number(req.query.digit);
   if (
    Number.isFinite(targetDigit) &&
    (
        !Number.isInteger(targetDigit) ||
        targetDigit < 0 ||
        targetDigit > 9
    )
) {
    return res.status(400).json({
        success: false,
        message: "Valid target digit is required"
    });
}

            if (!requestedSymbol) {

                return res.status(400).json({
                    success: false,
                    message: "Market symbol is required"
                });

            }

            if (!Number.isFinite(limit)) {
                limit = 100;
            }

            limit = Math.floor(limit);

            const allowedLimits = [
                100,
                300,
                500,
                1000
            ];

            if (!allowedLimits.includes(limit)) {

                limit = 100;

            }

            const syntheticSymbolMap = {

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
                "VOL-100-1S": "VOL-100-1S"

            };

            const syntheticSymbol =
                syntheticSymbolMap[requestedSymbol] ||
                requestedSymbol;


            const history =
                syntheticMarket.getHistory(
                    syntheticSymbol,
                    limit
                );


            const ticks =
                Array.isArray(history)
                    ? history
                    : [];
const latestTick =
    ticks.length > 0
        ? ticks[ticks.length - 1]
        : null;

const latestPrice =
    Number(latestTick?.price);

const latestDigit =
    Number.isFinite(latestPrice)
        ? Math.abs(
            Math.floor(
                latestPrice * 100
            )
        ) % 10
        : null;

            // ==========================================
            // DIGIT COUNTS
            // ==========================================

            const digitCounts = {
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


            for (const item of ticks) {

                const price =
                    Number(item?.price);

                if (!Number.isFinite(price)) {
                    continue;
                }


                const digit =
                    Math.abs(
                        Math.floor(
                            price * 100
                        )
                    ) % 10;


                digitCounts[digit]++;

            }


            // ==========================================
            // TOTAL VALID TICKS
            // ==========================================

            const totalDigits =
                Object.values(
                    digitCounts
                )
                .reduce(
                    (sum, count) =>
                        sum + count,
                    0
                );
// ==========================================
// TARGET DIGIT CONTRACT STATISTICS
// ==========================================

let overCount = 0;
let underCount = 0;
let matchesCount = 0;
let differsCount = 0;

if (
    Number.isInteger(targetDigit) &&
    targetDigit >= 0 &&
    targetDigit <= 9
) {

    for (
        let digit = 0;
        digit <= 9;
        digit++
    ) {

        const count =
            digitCounts[digit];

        if (digit > targetDigit) {
            overCount += count;
        }

        if (digit < targetDigit) {
            underCount += count;
        }

        if (digit === targetDigit) {
            matchesCount += count;
        }

    }

    differsCount =
        totalDigits -
        matchesCount;
}

const overPercentage =
    totalDigits > 0
        ? Math.round(
            (overCount / totalDigits) * 100
        )
        : 0;

const underPercentage =
    totalDigits > 0
        ? 100 - overPercentage
        : 0;

const matchesPercentage =
    totalDigits > 0
        ? Math.round(
            (matchesCount / totalDigits) * 100
        )
        : 0;

const differsPercentage =
    totalDigits > 0
        ? 100 - matchesPercentage
        : 0;

            // ==========================================
            // LARGEST REMAINDER PERCENTAGES
            // TOTAL WILL ALWAYS EQUAL 100
            // ==========================================

            const digitFrequency = {};

            if (totalDigits > 0) {

                const calculations =
                    Object.keys(
                        digitCounts
                    )
                    .map(digit => {

                        const exact =
                            (
                                digitCounts[digit] /
                                totalDigits
                            ) * 100;

                        const floor =
                            Math.floor(exact);

                        return {
                            digit,
                            count:
                                digitCounts[digit],
                            exact,
                            percentage: floor,
                            remainder:
                                exact - floor
                        };

                    });


                let assigned =
                    calculations.reduce(
                        (sum, item) =>
                            sum + item.percentage,
                        0
                    );


                let remaining =
                    100 - assigned;


                calculations.sort(
                    (a, b) => {

                        if (
                            b.remainder !==
                            a.remainder
                        ) {

                            return (
                                b.remainder -
                                a.remainder
                            );

                        }

                        return (
                            Number(a.digit) -
                            Number(b.digit)
                        );

                    }
                );


                for (
                    let i = 0;
                    i < remaining;
                    i++
                ) {

                    calculations[i]
                        .percentage++;

                }


                calculations.sort(
                    (a, b) =>
                        Number(a.digit) -
                        Number(b.digit)
                );


                for (const item of calculations) {

                    digitFrequency[item.digit] = {

                        count:
                            item.count,

                        percentage:
                            item.percentage

                    };

                }

            } else {

                for (
                    let digit = 0;
                    digit <= 9;
                    digit++
                ) {

                    digitFrequency[digit] = {

                        count: 0,

                        percentage: 0

                    };

                }

            }


            // ==========================================
            // MOST / LEAST FREQUENT DIGITS
            // ==========================================

            let mostFrequentDigits = [];
            let leastFrequentDigits = [];


            if (totalDigits > 0) {

                const counts =
                    Object.values(
                        digitCounts
                    );


                const maxCount =
                    Math.max(...counts);

                const minCount =
                    Math.min(...counts);


                mostFrequentDigits =
                    Object.keys(digitCounts)
                        .filter(
                            digit =>
                                digitCounts[digit] ===
                                maxCount
                        )
                        .map(Number);


                leastFrequentDigits =
                    Object.keys(digitCounts)
                        .filter(
                            digit =>
                                digitCounts[digit] ===
                                minCount
                        )
                        .map(Number);

            }


            // ==========================================
            // ODD / EVEN
            // ==========================================

            let oddCount = 0;
            let evenCount = 0;


            for (
                let digit = 0;
                digit <= 9;
                digit++
            ) {

                if (digit % 2 === 0) {

                    evenCount +=
                        digitCounts[digit];

                } else {

                    oddCount +=
                        digitCounts[digit];

                }

            }


            const oddPercentage =
                totalDigits > 0
                    ? Math.round(
                        (
                            oddCount /
                            totalDigits
                        ) * 100
                    )
                    : 0;


            const evenPercentage =
                totalDigits > 0
                    ? 100 - oddPercentage
                    : 0;


            // ==========================================
            // TICK-TO-TICK VOLATILITY
            // POPULATION STANDARD DEVIATION
            // ==========================================

            const changes = [];


            for (
                let i = 1;
                i < ticks.length;
                i++
            ) {

                const current =
                    Number(
                        ticks[i]?.price
                    );

                const previous =
                    Number(
                        ticks[i - 1]?.price
                    );


                if (
                    Number.isFinite(current) &&
                    Number.isFinite(previous)
                ) {

                    changes.push(
                        current - previous
                    );

                }

            }


            let volatility = 0;


            if (changes.length > 0) {

                const mean =
                    changes.reduce(
                        (sum, value) =>
                            sum + value,
                        0
                    ) /
                    changes.length;


                const variance =
                    changes.reduce(
                        (sum, value) =>
                            sum +
                            Math.pow(
                                value - mean,
                                2
                            ),
                        0
                    ) /
                    changes.length;


                volatility =
                    Math.sqrt(variance);

            }


            volatility =
                Number(
                    volatility.toFixed(6)
                );


            // ==========================================
            // RESPONSE
            // ==========================================

            return res.json({

                success: true,

                symbol:
                    syntheticSymbol,
                    latestPrice,

latestDigit,

                sampleSize:
                    totalDigits,

                requestedLimit:
                    limit,

                digitFrequency,

                mostFrequentDigits,

                leastFrequentDigits,

                oddEven: {

                    odd: {

                        count:
                            oddCount,

                        percentage:
                            oddPercentage

                    },

                    even: {

                        count:
                            evenCount,

                        percentage:
                            evenPercentage

                    }

                },
                targetDigit,

overUnder: {

    over: {

        count:
            overCount,

        percentage:
            overPercentage

    },

    under: {

        count:
            underCount,

        percentage:
            underPercentage

    }

},

matchesDiffers: {

    matches: {

        count:
            matchesCount,

        percentage:
            matchesPercentage

    },

    differs: {

        count:
            differsCount,

        percentage:
            differsPercentage

    }

},

                volatility

            });

        }

        catch (error) {

            console.error(
                "Market statistics API error:",
                error
            );


            return res.status(500).json({

                success: false,

                message:
                    "Unable to calculate market statistics"

            });

        }

    }
);
// ======================================================
// KMFBINARY AUTOMATION ENGINE
// ======================================================
//
// Automation uses the EXISTING /api/trades endpoint.
//
// Each automation run:
// 1. Scans for a setup
// 2. Places ONE trade
// 3. Trade expires after EXACTLY 1 second
// 4. Waits for settlement
// 5. Records result
// 6. Moves to the next run
//
// Example:
// 10 runs = 10 separate 1-second trades
//
// ======================================================
// ==========================================
// GET SYNTHETIC MARKET HISTORY
// ==========================================

app.get(
    "/api/market-history",
    authenticateUser,
    async (req, res) => {

        try {

            const requestedSymbol =
                String(req.query.symbol || "")
                    .trim()
                    .toUpperCase();

            let limit =
                Number(req.query.limit || 500);

            if (!requestedSymbol) {

                return res.status(400).json({
                    success: false,
                    message: "Market symbol is required"
                });

            }

            if (!Number.isFinite(limit)) {
                limit = 500;
            }

            limit = Math.floor(limit);

            if (limit < 50) {
                limit = 50;
            }

            if (limit > 1000) {
                limit = 1000;
            }

            const syntheticSymbolMap = {
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
                "VOL-100-1S": "VOL-100-1S"
            };

            const syntheticSymbol =
                syntheticSymbolMap[requestedSymbol] ||
                requestedSymbol;

            const history =
                syntheticMarket.getHistory(
                    syntheticSymbol,
                    limit
                );

            return res.json({

                success: true,

                symbol:
                    syntheticSymbol,

                history:
                    Array.isArray(history)
                        ? history
                        : []

            });

        }

        catch (error) {

            console.error(
                "Market history API error:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "Unable to load synthetic market history"

            });

        }

    }
);
const automationSessions = new Map();

const AUTOMATION_MIN_STAKE = 0.35;
const AUTOMATION_MAX_RUNS = 15;

// Polling frequency for checking trade settlement.
const AUTOMATION_POLL_MS = 100;

// Small delay between completed trades and the next scan.
const AUTOMATION_SCAN_DELAY_MS = 200;

// Maximum time automation will wait for a settlement.
// This is NOT the trade duration.
const AUTOMATION_TRADE_TIMEOUT_MS = 120000;


// ======================================================
// AUTOMATION HELPERS
// ======================================================

function automationNumber(value, fallback = 0) {

    const n = Number(value);

    return Number.isFinite(n)
        ? n
        : fallback;

}


function automationSleep(ms) {

    return new Promise(resolve => {

        setTimeout(resolve, ms);

    });

}


// ======================================================
// FIND USER AUTOMATION SESSION
// ======================================================

function getUserAutomationSession(
    userId,
    requestedSessionId = null
) {

    if (requestedSessionId) {

        const requestedSession =
            automationSessions.get(
                requestedSessionId
            );

        if (
            requestedSession &&
            requestedSession.userId === userId
        ) {

            return requestedSession;

        }

        return null;

    }


    const userSessions =
        Array.from(
            automationSessions.values()
        )
        .filter(
            session =>
                session.userId === userId
        )
        .sort(
            (a, b) =>
                new Date(
                    b.startedAt || 0
                ) -
                new Date(
                    a.startedAt || 0
                )
        );


    return userSessions[0] || null;

}


// ======================================================
// GET AUTOMATION TRADE
// ======================================================

async function getAutomationTrade(
    tradeId,
    userId
) {

    const {
        data,
        error
    } = await supabase
        .from("trades")
        .select("*")
        .eq(
            "id",
            tradeId
        )
        .eq(
            "user_id",
            userId
        )
        .maybeSingle();


    if (error) {

        throw error;

    }


    return data;

}


// ======================================================
// WAIT FOR SETTLEMENT
// ======================================================

async function waitForAutomationSettlement(
    tradeId,
    userId
) {

    const startedAt =
        Date.now();


    console.log(
        "AUTOMATION WAITING FOR SETTLEMENT:",
        tradeId
    );


    while (
        Date.now() -
        startedAt <
        AUTOMATION_TRADE_TIMEOUT_MS
    ) {

        const trade =
            await getAutomationTrade(
                tradeId,
                userId
            );


        if (!trade) {

            throw new Error(
                "Automated trade disappeared"
            );

        }


        const status =
            String(
                trade.status ||
                trade.result ||
                ""
            )
            .trim()
            .toLowerCase();


        if (
            status === "won" ||
            status === "lost" ||
            status === "cancelled"
        ) {

            console.log(
                "AUTOMATION TRADE SETTLED:",
                tradeId,
                "STATUS:",
                status
            );

            return trade;

        }


        await automationSleep(
            AUTOMATION_POLL_MS
        );

    }


    throw new Error(
        "Automation trade settlement timeout"
    );

}


// ======================================================
// GET ACTIVE MARKETS
// ======================================================

async function getAutomationMarkets() {

    const {
        data,
        error
    } = await supabase
        .from("markets")
        .select("*")
        .eq(
            "is_active",
            true
        );


    if (error) {

        throw error;

    }


    return data || [];

}


// ======================================================
// BUILD AUTOMATION MARKET DATA
// ======================================================

function getAutomationMarketData(
    market
) {

    const symbol =
        String(
            market?.symbol || market || ""
        )
        .trim()
        .toUpperCase();


    const syntheticSymbol =
        market?.symbol
            ? getSyntheticSymbol(market)
            : symbol;


    if (!syntheticSymbol) {

        return null;

    }


    const price =
        Number(
            syntheticMarket.getPrice(
                syntheticSymbol
            )
        );


    if (
        !Number.isFinite(price)
    ) {

        return null;

    }


    const marketInfo =
        syntheticMarket.getMarket(
            syntheticSymbol
        );


    const tick =
        marketInfo &&
        Number.isFinite(
            Number(
                marketInfo.tick
            )
        )
            ? Number(
                marketInfo.tick
            )
            : 0;


    const previousPrice =
        marketInfo &&
        Number.isFinite(
            Number(
                marketInfo.previousPrice
            )
        )
            ? Number(
                marketInfo.previousPrice
            )
            : null;


    const lastDigit =
        getLastDigit(price);


    return {

        market,

        symbol,

        syntheticSymbol,

        price,

        previousPrice,

        tick,

        lastDigit

    };

}


// ======================================================
// AUTOMATION SCANNER
// KMF + VOL SUPPORT
// AUTO = VOL FIRST, THEN KMF
// ======================================================

async function scanAutomationSetup(
    requestedMarket = "AUTO",
    requestedContract = "AUTO"
) {

    try {

        const markets =
            await getAutomationMarkets();


        if (
            !Array.isArray(markets) ||
            markets.length === 0
        ) {

            throw new Error(
                "No active automation markets available"
            );

        }


        const marketRequest =
            String(
                requestedMarket || "AUTO"
            )
            .trim()
            .toUpperCase();


        const contractRequest =
            String(
                requestedContract || "AUTO"
            )
            .trim()
            .toLowerCase();


        // ------------------------------------------------
        // MARKET CLASSIFICATION
        // ------------------------------------------------

        const isVolSymbol =
            (symbol) =>
                String(symbol || "")
                .toUpperCase()
                .startsWith("VOL-");


        const isKmfSymbol =
            (symbol) =>
                String(symbol || "")
                .toUpperCase()
                .startsWith("KMF-");


        // ------------------------------------------------
        // FILTER MARKETS
        // ------------------------------------------------

        let eligibleMarkets =
            markets.filter(
                (market) => {

                    if (
                        !market ||
                        market.is_active === false
                    ) {

                        return false;

                    }


                    const symbol =
                        String(
                            market.symbol || ""
                        )
                        .trim()
                        .toUpperCase();


                    if (
                        marketRequest === "VOL"
                    ) {

                        return isVolSymbol(
                            symbol
                        );

                    }


                    if (
                        marketRequest === "KMF"
                    ) {

                        return isKmfSymbol(
                            symbol
                        );

                    }


                    if (
                        marketRequest !== "AUTO"
                    ) {

                        return (
                            symbol ===
                            marketRequest
                        );

                    }


                    return (
                        isKmfSymbol(symbol) ||
                        isVolSymbol(symbol)
                    );

                }
            );


        if (
            eligibleMarkets.length === 0
        ) {

            throw new Error(
                `No active markets found for ${marketRequest}`
            );

        }


        // ------------------------------------------------
        // AUTO PRIORITY
        // VOL FIRST
        // ------------------------------------------------

        if (
            marketRequest === "AUTO"
        ) {

            eligibleMarkets.sort(
                (a, b) => {

                    const aVol =
                        isVolSymbol(
                            a.symbol
                        )
                            ? 1
                            : 0;


                    const bVol =
                        isVolSymbol(
                            b.symbol
                        )
                            ? 1
                            : 0;


                    return bVol - aVol;

                }
            );

        }


        const candidates = [];


        // ------------------------------------------------
        // SCAN MARKETS
        // ------------------------------------------------

        for (
            const market of eligibleMarkets
        ) {

            try {

                const databaseSymbol =
                    String(
                        market.symbol || ""
                    )
                    .trim()
                    .toUpperCase();


                const isVOL =
                    isVolSymbol(
                        databaseSymbol
                    );


                const isKMF =
                    isKmfSymbol(
                        databaseSymbol
                    );


                const marketData =
                    getAutomationMarketData(
                        market
                    );


                if (!marketData) {

                    continue;

                }


                const syntheticSymbol =
                    String(
                        marketData.syntheticSymbol ||
                        databaseSymbol
                    )
                    .trim()
                    .toUpperCase();


                const currentPrice =
                    Number(
                        marketData.price ??
                        marketData.currentPrice ??
                        marketData.current_price ??
                        marketData.lastPrice ??
                        marketData.last_price
                    );


                const previousPrice =
                    Number(
                        marketData.previousPrice ??
                        marketData.previous_price ??
                        marketData.prevPrice ??
                        marketData.prev_price ??
                        marketData.openPrice ??
                        marketData.open_price ??
                        currentPrice
                    );


                const currentTick =
                    Number(
                        marketData.tick ??
                        marketData.currentTick ??
                        marketData.current_tick ??
                        marketData.lastTick ??
                        marketData.last_tick ??
                        0
                    );


                if (
                    !Number.isFinite(
                        currentPrice
                    )
                ) {

                    continue;

                }


                const safePreviousPrice =
                    Number.isFinite(
                        previousPrice
                    )
                        ? previousPrice
                        : currentPrice;


                const movement =
                    currentPrice -
                    safePreviousPrice;


                const absMovement =
                    Math.abs(
                        movement
                    );


                const movementBase =
                    Math.max(
                        Math.abs(
                            safePreviousPrice
                        ) * 0.00001,
                        0.000001
                    );


                const normalizedMovement =
                    Math.min(
                        absMovement /
                        movementBase,
                        10
                    );


                // ========================================
                // VOL LOGIC
                // ========================================

                if (isVOL) {

                    let action;


                    if (
                        movement > 0
                    ) {

                        action =
                            "rise";

                    }

                    else if (
                        movement < 0
                    ) {

                        action =
                            "fall";

                    }

                    else {

                        action =
                            currentTick % 2 === 0
                                ? "rise"
                                : "fall";

                    }


                    let confidence =
                        60;


                    confidence +=
                        Math.min(
                            normalizedMovement * 3,
                            20
                        );


                    if (
                        movement !== 0
                    ) {

                        confidence += 5;

                    }


                    confidence =
                        Math.min(
                            Math.round(
                                confidence
                            ),
                            95
                        );


                    candidates.push({

                        marketId:
                            market.id,

                        symbol:
                            databaseSymbol,

                        syntheticSymbol,

                        marketName:
                            market.market_name ||
                            market.name ||
                            databaseSymbol,

                        price:
                            currentPrice,

                        tick:
                            currentTick,

                        previousPrice:
                            safePreviousPrice,

                        movement,

                        contractType:
                            "rise_fall",

                        action,

                        barrierPrice:
                            null,

                        targetDigit:
                            null,

                        confidence,

                        marketClass:
                            "VOL",

                        reason:
                            movement > 0
                                ? `VOL momentum rising: ${movement.toFixed(4)}`
                                : movement < 0
                                ? `VOL momentum falling: ${Math.abs(movement).toFixed(4)}`
                                : "VOL market flat; direction selected from latest tick.",

                        isVOL:
                            true,

                        isKMF:
                            false

                    });


                    continue;

                }


                // ========================================
                // KMF LOGIC
                // ========================================

                if (isKMF) {

                    const databaseContract =
                        String(
                            market.contract_type || ""
                        )
                        .trim()
                        .toLowerCase();


                    let contractType =
                        databaseContract;


                    // Respect requested contract when
                    // one was explicitly selected.
                    if (
                        contractRequest !== "auto" &&
                        contractRequest !== databaseContract
                    ) {

                        continue;

                    }


                    let action =
                        null;


                    let barrierPrice =
                        null;


                    let targetDigit =
                        null;


                    let confidence =
                        50;


                    let reason =
                        "";


                    // ------------------------------------
                    // RISE / FALL
                    // ------------------------------------

                    if (
                        databaseContract ===
                        "rise_fall"
                    ) {

                        action =
                            movement >= 0
                                ? "rise"
                                : "fall";


                        confidence +=
                            Math.min(
                                normalizedMovement * 2,
                                20
                            );


                        reason =
                            movement >= 0
                                ? "KMF price movement is rising."
                                : "KMF price movement is falling.";

                    }


                    // ------------------------------------
                    // HIGHER / LOWER
                    // ------------------------------------

                    else if (
                        databaseContract ===
                        "higher_lower"
                    ) {

                        action =
                            movement >= 0
                                ? "higher"
                                : "lower";


                        const distance =
                            Math.max(
                                Math.abs(
                                    currentPrice
                                ) * 0.00005,
                                0.01
                            );


                        barrierPrice =
                            movement >= 0
                                ? currentPrice + distance
                                : currentPrice - distance;


                        confidence +=
                            Math.min(
                                normalizedMovement * 2,
                                20
                            );


                        reason =
                            movement >= 0
                                ? "KMF momentum favors higher."
                                : "KMF momentum favors lower.";

                    }


                    // ------------------------------------
                    // ODD / EVEN
                    // ------------------------------------

                    else if (
                        databaseContract ===
                        "odd_even"
                    ) {

                        const priceText =
                            Math.abs(
                                currentPrice
                            )
                            .toFixed(2)
                            .replace(
                                ".",
                                ""
                            );


                        const lastDigit =
                            Number(
                                priceText.slice(-1)
                            );


                        action =
                            lastDigit % 2 === 0
                                ? "even"
                                : "odd";


                        confidence =
                            55;


                        reason =
                            `Latest price digit is ${lastDigit}; selecting ${action}.`;

                    }


                    // ------------------------------------
                    // OVER / UNDER
                    // ------------------------------------

                    else if (
                        databaseContract ===
                        "over_under"
                    ) {

                        const priceText =
                            Math.abs(
                                currentPrice
                            )
                            .toFixed(2)
                            .replace(
                                ".",
                                ""
                            );


                        let lastDigit =
                            Number(
                                priceText.slice(-1)
                            );


                        if (
                            !Number.isFinite(
                                lastDigit
                            )
                        ) {

                            lastDigit =
                                5;

                        }


                        targetDigit =
                            Math.min(
                                Math.max(
                                    lastDigit,
                                    1
                                ),
                                8
                            );


                        action =
                            lastDigit >= 5
                                ? "over"
                                : "under";


                        confidence =
                            55;


                        reason =
                            `Latest digit is ${lastDigit}; selecting ${action} ${targetDigit}.`;

                    }


                    // ------------------------------------
                    // FALLBACK
                    // ------------------------------------

                    else {

                        contractType =
                            "rise_fall";


                        action =
                            movement >= 0
                                ? "rise"
                                : "fall";


                        confidence =
                            55;


                        reason =
                            "Unsupported KMF contract detected; using rise/fall fallback.";

                    }


                    confidence =
                        Math.min(
                            Math.round(
                                confidence
                            ),
                            95
                        );


                    candidates.push({

                        marketId:
                            market.id,

                        symbol:
                            databaseSymbol,

                        syntheticSymbol,

                        marketName:
                            market.market_name ||
                            market.name ||
                            databaseSymbol,

                        price:
                            currentPrice,

                        tick:
                            currentTick,

                        previousPrice:
                            safePreviousPrice,

                        movement,

                        contractType,

                        action,

                        barrierPrice,

                        targetDigit,

                        confidence,

                        marketClass:
                            "KMF",

                        reason,

                        isVOL:
                            false,

                        isKMF:
                            true

                    });

                }

            }

            catch (marketError) {

                console.error(
                    "AUTOMATION MARKET SCAN ERROR:",
                    market.symbol,
                    marketError
                );

            }

        }


        // ------------------------------------------------
        // CONFIDENCE FILTER
        // ------------------------------------------------

        let validCandidates =
            candidates.filter(
                candidate =>
                    Number(
                        candidate.confidence
                    ) >= 55
            );


        // ------------------------------------------------
        // AUTO = VOL FIRST
        // ------------------------------------------------

        if (
            marketRequest === "AUTO"
        ) {

            const volCandidates =
                validCandidates.filter(
                    candidate =>
                        candidate.isVOL === true
                );


            if (
                volCandidates.length > 0
            ) {

                validCandidates =
                    volCandidates;

            }

        }


        // ------------------------------------------------
        // SORT
        // ------------------------------------------------

        validCandidates.sort(
            (a, b) =>
                Number(
                    b.confidence
                ) -
                Number(
                    a.confidence
                )
        );


        if (
            validCandidates.length === 0
        ) {

            return null;

        }


        const selected =
            validCandidates[0];


        // ------------------------------------------------
        // LOG SCAN
        // ------------------------------------------------

        console.log(
            "=========================================="
        );

        console.log(
            "AUTOMATION SCANNER RESULT"
        );

        console.log(
            "REQUESTED MARKET:",
            marketRequest
        );

        console.log(
            "SELECTED MARKET:",
            selected.symbol
        );

        console.log(
            "MARKET CLASS:",
            selected.marketClass
        );

        console.log(
            "SYNTHETIC SYMBOL:",
            selected.syntheticSymbol
        );

        console.log(
            "CONTRACT:",
            selected.contractType
        );

        console.log(
            "ACTION:",
            selected.action
        );

        console.log(
            "PRICE:",
            selected.price
        );

        console.log(
            "MOVEMENT:",
            selected.movement
        );

        console.log(
            "CONFIDENCE:",
            selected.confidence
        );

        console.log(
            "REASON:",
            selected.reason
        );

        console.log(
            "QUALIFIED: true"
        );

        console.log(
            "=========================================="
        );


        // ------------------------------------------------
        // IMPORTANT:
        // runAutomationSession() requires
        // setup.qualified === true
        // ------------------------------------------------

        return {

            qualified:
                true,

            marketId:
                selected.marketId,

            symbol:
                selected.symbol,

            syntheticSymbol:
                selected.syntheticSymbol,

            price:
                selected.price,

            tick:
                selected.tick,

            previousPrice:
                selected.previousPrice,

            movement:
                selected.movement,

            lastDigit:
                Number(
                    String(
                        Math.abs(
                            selected.price
                        )
                    )
                    .replace(
                        ".",
                        ""
                    )
                    .slice(-1)
                ),

            contractType:
                selected.contractType,

            action:
                selected.action,

            barrierPrice:
                selected.barrierPrice,

            targetDigit:
                selected.targetDigit,

            confidence:
                selected.confidence,

            reason:
                selected.reason,

            marketClass:
                selected.marketClass,

            isVOL:
                selected.isVOL,

            isKMF:
                selected.isKMF,

            candidates:
                validCandidates

        };

    }

    catch (error) {

        console.error(
            "AUTOMATION SCANNER ERROR:",
            error
        );

        return null;

    }

}


// ======================================================
// PLACE AUTOMATED TRADE
// ======================================================

async function placeAutomationTrade(
    session,
    setup
) {

    const tradingMode =
        String(
            session.accountType ||
            session.account ||
            session.tradingMode ||
            "DEMO"
        )
        .trim()
        .toUpperCase() === "LIVE"
            ? "real"
            : "demo";


    // IMPORTANT:
    // Automation is ALWAYS exactly 1 second.
    const tradePayload = {

        marketId:
            setup.marketId,

        contractType:
            setup.contractType,

        action:
            setup.action,

        stake:
            Number(
                session.stake
            ),

        duration:
            1,

        durationUnit:
            "s",

        mode:
            tradingMode

    };


    if (
        setup.targetDigit !== null &&
        setup.targetDigit !== undefined
    ) {

        tradePayload.targetDigit =
            setup.targetDigit;

    }


    if (
        setup.barrierPrice !== null &&
        setup.barrierPrice !== undefined
    ) {

        tradePayload.barrierPrice =
            setup.barrierPrice;

    }


    console.log(
        "AUTOMATION PLACING TRADE..."
    );

    console.log(
        "AUTOMATION DURATION: 1 second"
    );

    console.log(
        "AUTOMATION STAKE:",
        session.stake
    );

    console.log(
        "AUTOMATION MARKET:",
        setup.symbol
    );

    console.log(
        "AUTOMATION ACTION:",
        setup.action
    );


    const response =
        await axios.post(

            `http://127.0.0.1:${PORT}/api/trades`,

            tradePayload,

            {

                headers: {

                    Authorization:
                        session.authorization,

                    "Content-Type":
                        "application/json"

                },

                timeout:
                    15000

            }

        );


    if (
        !response.data ||
        !response.data.success ||
        !response.data.trade
    ) {

        throw new Error(
            response.data?.message ||
            "Automated trade was not created"
        );

    }


    console.log(
        "AUTOMATION TRADE CREATED:",
        response.data.trade.id
    );


    return response.data.trade;

}


// ======================================================
// AUTOMATION RISK CHECK
// ======================================================

function automationRiskStopReason(
    session
) {

    const targetRuns =
        Number(
            session.targetRuns ??
            session.runs ??
            0
        );


    const completedRuns =
        Number(
            session.completedRuns ||
            0
        );


    const netProfit =
        Number(
            session.netProfit ||
            0
        );


    const tp =
        Number(
            session.tp ||
            0
        );


    const sl =
        Number(
            session.sl ||
            0
        );


    const maxLoss =
        Number(
            session.maxLoss ||
            0
        );


    const losses =
        Number(
            session.losses ||
            0
        );


    if (
        targetRuns > 0 &&
        completedRuns >= targetRuns
    ) {

        return "Selected runs completed";

    }


    if (
        tp > 0 &&
        netProfit >= tp
    ) {

        return "Take Profit reached";

    }


    if (
        sl > 0 &&
        netProfit <= -sl
    ) {

        return "Stop Loss reached";

    }


    if (
        maxLoss > 0 &&
        losses >= maxLoss
    ) {

        return "Maximum losses reached";

    }


    return null;

}


// ======================================================
// UPDATE SESSION
// ======================================================

async function saveAutomationSession(
    session
) {

    session.updatedAt =
        new Date().toISOString();

}


// ======================================================
// AUTOMATION EXECUTION LOOP
// ======================================================

async function runAutomationSession(
    session
) {

    try {

        while (
            session.running
        ) {

            // ------------------------------------------
            // STOP REQUEST
            // ------------------------------------------

            if (
                session.stopRequested
            ) {

                session.running =
                    false;

                session.status =
                    "STOPPED";

                session.stopReason =
                    session.stopReason ||
                    "Manual stop requested";

                break;

            }


            // ------------------------------------------
            // RISK CHECK
            // ------------------------------------------

            const stopReason =
                automationRiskStopReason(
                    session
                );


            if (stopReason) {

                session.running =
                    false;

                session.status =
                    "COMPLETED";

                session.stopReason =
                    stopReason;

                break;

            }


            // ------------------------------------------
            // RUN NUMBER
            // ------------------------------------------

            const nextRun =
                Number(
                    session.completedRuns || 0
                ) + 1;


            console.log(
                "=========================================="
            );

            console.log(
                "AUTOMATION RUN:",
                nextRun,
                "/",
                session.targetRuns
            );

            console.log(
                "=========================================="
            );


            // ------------------------------------------
            // SCANNING
            // ------------------------------------------

            session.status =
                "SCANNING";

            session.signal =
                "SCANNING";

            session.riskStatus =
                "Monitoring limits";


            await saveAutomationSession(
                session
            );


            // ------------------------------------------
            // SCAN
            // ------------------------------------------

            const setup =
                await scanAutomationSetup(
                    session.market,
                    session.contractType
                );


            session.lastScan =
                new Date().toISOString();


            if (
                !setup ||
                setup.qualified !== true
            ) {

                session.signal =
                    "WAIT";

                session.lastReason =
                    setup?.reason ||
                    "No suitable setup";


                await saveAutomationSession(
                    session
                );


                await automationSleep(
                    AUTOMATION_SCAN_DELAY_MS
                );


                continue;

            }


            // ------------------------------------------
            // SETUP FOUND
            // ------------------------------------------

            session.signal =
                String(
                    setup.action
                )
                .toUpperCase();


            session.selectedMarket =
                setup.symbol;


            session.selectedContract =
                setup.contractType;


            session.confidence =
                setup.confidence;


            session.reason =
                setup.reason;


            session.lastReason =
                setup.reason;


            session.status =
                "PLACING";


            await saveAutomationSession(
                session
            );


            // ------------------------------------------
            // PLACE 1-SECOND TRADE
            // ------------------------------------------

            const trade =
                await placeAutomationTrade(
                    session,
                    setup
                );


            session.activeTradeId =
                trade.id;


            session.status =
                "WAITING";


            session.lastTrade =
                trade;


            session.trades.push({

                tradeId:
                    trade.id,

                market:
                    trade.symbol,

                contractType:
                    trade.contract_type,

                action:
                    trade.action,

                stake:
                    trade.stake,

                duration:
                    1,

                durationUnit:
                    "s",

                status:
                    "pending",

                createdAt:
                    trade.created_at ||
                    new Date().toISOString()

            });


            await saveAutomationSession(
                session
            );


            // ------------------------------------------
            // WAIT FOR SETTLEMENT
            // ------------------------------------------

            const settledTrade =
                await waitForAutomationSettlement(
                    trade.id,
                    session.userId
                );


            session.activeTradeId =
                null;


            // ------------------------------------------
            // SETTLEMENT STATUS
            // ------------------------------------------

            const status =
                String(
                    settledTrade.status ||
                    settledTrade.result ||
                    ""
                )
                .trim()
                .toLowerCase();


            // ------------------------------------------
            // CALCULATE PROFIT
            // ------------------------------------------

            let profit;


            const actualTradeProfit =
                Number(
                    settledTrade.profit
                );


            if (
                Number.isFinite(
                    actualTradeProfit
                )
            ) {

                profit =
                    actualTradeProfit;

            }

            else if (
                status === "won"
            ) {

                profit =
                    automationNumber(
                        settledTrade.payout
                    ) -
                    automationNumber(
                        settledTrade.stake
                    );

            }

            else if (
                status === "lost"
            ) {

                profit =
                    -automationNumber(
                        settledTrade.stake
                    );

            }

            else {

                profit =
                    0;

            }


            profit =
                Number(
                    profit.toFixed(6)
                );


            // ------------------------------------------
            // UPDATE COUNTERS
            // ------------------------------------------

            session.completedRuns++;


            if (
                status === "won"
            ) {

                session.wins++;

            }

            else if (
                status === "lost"
            ) {

                session.losses++;

            }


            // ------------------------------------------
            // UPDATE PROFIT
            // ------------------------------------------

            session.netProfit =
                Number(
                    (
                        Number(
                            session.netProfit || 0
                        ) +
                        profit
                    )
                    .toFixed(6)
                );


            session.profit =
                session.netProfit;


            session.totalProfit =
                session.netProfit;


            // ------------------------------------------
            // WIN RATE
            // ------------------------------------------

            session.winRate =
                session.completedRuns > 0
                    ? Number(
                        (
                            session.wins /
                            session.completedRuns *
                            100
                        )
                        .toFixed(2)
                    )
                    : 0;


            // ------------------------------------------
            // UPDATE TRADE RECORD
            // ------------------------------------------

            const trackedTrade =
                session.trades.find(
                    item =>
                        item.tradeId ===
                        settledTrade.id
                );


            if (trackedTrade) {

                trackedTrade.status =
                    status;

                trackedTrade.payout =
                    settledTrade.payout;

                trackedTrade.profit =
                    profit;

                trackedTrade.settledAt =
                    settledTrade.settled_at ||
                    new Date().toISOString();

            }


            // ------------------------------------------
            // STORE RESULT
            // ------------------------------------------

            session.results.push({

                run:
                    session.completedRuns,

                tradeId:
                    settledTrade.id,

                market:
                    settledTrade.symbol,

                contractType:
                    settledTrade.contract_type,

                action:
                    settledTrade.action,

                stake:
                    settledTrade.stake,

                duration:
                    1,

                durationUnit:
                    "s",

                status,

                payout:
                    settledTrade.payout,

                profit,

                cumulativeProfit:
                    session.netProfit,

                confidence:
                    setup.confidence,

                reason:
                    setup.reason,

                completedAt:
                    new Date().toISOString()

            });


            session.lastTrade =
                settledTrade;


            session.status =
                "REASSESSING";


            await saveAutomationSession(
                session
            );


            console.log(
                "AUTOMATION RUN COMPLETE:",
                session.completedRuns,
                "/",
                session.targetRuns
            );

            console.log(
                "RESULT:",
                status
            );

            console.log(
                "PROFIT:",
                profit
            );

            console.log(
                "TOTAL PROFIT:",
                session.netProfit
            );


            // ------------------------------------------
            // STOP AFTER FINAL RUN
            // ------------------------------------------

            if (
                session.completedRuns >=
                session.targetRuns
            ) {

                session.running =
                    false;

                session.status =
                    "COMPLETED";

                session.stopReason =
                    "Selected runs completed";

                break;

            }


            // ------------------------------------------
            // STOP REQUEST
            // ------------------------------------------

            if (
                session.stopRequested
            ) {

                session.running =
                    false;

                session.status =
                    "STOPPED";

                session.stopReason =
                    session.stopReason ||
                    "Manual stop requested";

                break;

            }


            // ------------------------------------------
            // RISK CHECK AFTER TRADE
            // ------------------------------------------

            const afterTradeReason =
                automationRiskStopReason(
                    session
                );


            if (
                afterTradeReason
            ) {

                session.running =
                    false;

                session.status =
                    "COMPLETED";

                session.stopReason =
                    afterTradeReason;

                break;

            }


            // ------------------------------------------
            // SHORT COOLDOWN
            // ------------------------------------------

            await automationSleep(
                AUTOMATION_SCAN_DELAY_MS
            );

        }

    }

    catch (error) {

        console.error(
            "Automation engine error:",
            error
        );


        session.running =
            false;


        session.status =
            "ERROR";


        session.stopReason =
            error.message ||
            "Automation engine error";


        session.error =
            error.message;

    }

    finally {

        session.running =
            false;


        if (
            session.status ===
            "STOPPING"
        ) {

            session.status =
                "STOPPED";

        }


        if (
            session.status ===
            "RUNNING"
        ) {

            session.status =
                "COMPLETED";

        }


        await saveAutomationSession(
            session
        );

    }

}


// ======================================================
// START AUTOMATION
// ======================================================

app.post(
    "/api/automation/start",
    authenticateUser,
    async (req, res) => {

        try {

            console.log("");
            console.log(
                "=========================================="
            );
            console.log(
                "AUTOMATION START REQUEST"
            );
            console.log(
                "=========================================="
            );


            const authHeader =
                req.headers.authorization;


            if (!authHeader) {

                return res.status(401).json({

                    success: false,

                    message:
                        "Authentication required"

                });

            }


            const userId =
                req.user?.id ||
                req.user?.user_id ||
                null;


            if (!userId) {

                return res.status(401).json({

                    success: false,

                    message:
                        "Authenticated user not found"

                });

            }


            const automationMode =
                String(
                    req.body.automationMode ||
                    req.body.mode ||
                    "AUTOMATED"
                )
                .trim()
                .toUpperCase();


            if (
                automationMode !== "AUTOMATED" &&
                automationMode !== "MANUAL"
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid automation mode"

                });

            }


            const accountType =
                String(
                    req.body.accountType ||
                    req.body.account ||
                    req.body.tradingMode ||
                    "DEMO"
                )
                .trim()
                .toUpperCase();


            if (
                accountType !== "DEMO" &&
                accountType !== "LIVE"
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid account type"

                });

            }


            const market =
                String(
                    req.body.market ||
                    "AUTO"
                )
                .trim()
                .toUpperCase();


            const contractType =
                String(
                    req.body.contractType ||
                    req.body.marketType ||
                    "AUTO"
                )
                .trim()
                .toLowerCase();


            const stake =
                Number(
                    req.body.stake
                );


            const runs =
                Number(
                    req.body.runs
                );


            const tp =
                Number(
                    req.body.tp ??
                    req.body.takeProfit ??
                    0
                );


            const sl =
                Number(
                    req.body.sl ??
                    req.body.stopLoss ??
                    0
                );


            const maxLoss =
                Number(
                    req.body.maxLoss ??
                    0
                );


            if (
                !Number.isFinite(stake) ||
                stake < AUTOMATION_MIN_STAKE
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        `Minimum automation stake is $${AUTOMATION_MIN_STAKE}`

                });

            }


            if (
                !Number.isFinite(runs) ||
                runs < 1 ||
                runs > AUTOMATION_MAX_RUNS
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        `Runs must be between 1 and ${AUTOMATION_MAX_RUNS}`

                });

            }


            const existingSession =
                Array.from(
                    automationSessions.values()
                )
                .find(
                    session =>
                        session.userId === userId &&
                        session.running === true
                );


            if (existingSession) {

                return res.status(409).json({

                    success: false,

                    message:
                        "An automation session is already running",

                    sessionId:
                        existingSession.sessionId

                });

            }


            // ------------------------------------------
            // CREATE SESSION
            // ------------------------------------------

            const sessionId =
                crypto.randomUUID();


            const session = {

                sessionId,

                userId,

                authorization:
                    authHeader,

                automationMode,

                mode:
                    automationMode,

                accountType,

                account:
                    accountType,

                tradingMode:
                    accountType.toLowerCase(),

                market,

                contractType,

                stake,

                // IMPORTANT:
                // Automation duration is fixed at 1 second.
                duration:
                    1,

                durationUnit:
                    "s",

                runs,

                targetRuns:
                    runs,

                tp:
                    Math.max(
                        0,
                        tp
                    ),

                sl:
                    Math.max(
                        0,
                        sl
                    ),

                maxLoss:
                    Math.max(
                        0,
                        maxLoss
                    ),

                completedRuns:
                    0,

                wins:
                    0,

                losses:
                    0,

                netProfit:
                    0,

                profit:
                    0,

                totalProfit:
                    0,

                winRate:
                    0,

                running:
                    true,

                status:
                    "RUNNING",

                signal:
                    "Scanning",

                selectedMarket:
                    null,

                selectedContract:
                    null,

                confidence:
                    null,

                reason:
                    "AI is scanning for a qualifying setup.",

                lastReason:
                    null,

                riskStatus:
                    "Monitoring limits",

                activeTradeId:
                    null,

                lastTrade:
                    null,

                lastScan:
                    null,

                startedAt:
                    new Date().toISOString(),

                updatedAt:
                    new Date().toISOString(),

                trades:
                    [],

                results:
                    [],

                logs:
                    [],

                stopRequested:
                    false,

                stopReason:
                    null

            };


            automationSessions.set(
                sessionId,
                session
            );


            console.log(
                "AUTOMATION SESSION CREATED:",
                sessionId
            );

            console.log(
                "USER:",
                userId
            );

            console.log(
                "ACCOUNT:",
                accountType
            );

            console.log(
                "AUTOMATION MODE:",
                automationMode
            );

            console.log(
                "MARKET:",
                market
            );

            console.log(
                "CONTRACT:",
                contractType
            );

            console.log(
                "STAKE:",
                stake
            );

            console.log(
                "DURATION:",
                "1 second"
            );

            console.log(
                "RUNS:",
                runs
            );

            console.log(
                "TP:",
                tp
            );

            console.log(
                "SL:",
                sl
            );

            console.log(
                "MAX LOSS:",
                maxLoss
            );


            // ------------------------------------------
            // RESPONSE
            // ------------------------------------------

            res.status(200).json({

                success:
                    true,

                message:
                    "Automation session started",

                sessionId,

                status:
                    "RUNNING",

                session: {

                    sessionId,

                    accountType,

                    automationMode,

                    market,

                    contractType,

                    stake,

                    duration:
                        1,

                    durationUnit:
                        "s",

                    runs,

                    targetRuns:
                        runs,

                    tp,

                    sl,

                    maxLoss,

                    completedRuns:
                        0,

                    wins:
                        0,

                    losses:
                        0,

                    netProfit:
                        0,

                    profit:
                        0,

                    totalProfit:
                        0,

                    winRate:
                        0,

                    status:
                        "RUNNING"

                }

            });


            // ------------------------------------------
            // START BACKGROUND AUTOMATION
            // ------------------------------------------

            setImmediate(
                () => {

                    runAutomationSession(
                        session
                    )
                    .catch(
                        error => {

                            console.error(
                                "AUTOMATION SESSION ERROR:",
                                error
                            );


                            session.running =
                                false;

                            session.status =
                                "ERROR";

                            session.stopReason =
                                error.message ||
                                "Automation session failed";

                            session.updatedAt =
                                new Date().toISOString();

                        }
                    );

                }
            );

        }

        catch (error) {

            console.error(
                "AUTOMATION START ERROR:",
                error
            );


            return res.status(500).json({

                success: false,

                message:
                    error.message ||
                    "Failed to start automation"

            });

        }

    }
);


// ======================================================
// STOP AUTOMATION
// ======================================================

app.post(
    "/api/automation/stop",
    authenticateUser,
    async (req, res) => {

        try {

            const userId =
                req.user.id;


            const requestedSessionId =
                String(
                    req.body?.sessionId ||
                    req.query?.sessionId ||
                    ""
                )
                .trim() ||
                null;


            const session =
                getUserAutomationSession(
                    userId,
                    requestedSessionId
                );


            if (!session) {

                return res.status(404).json({

                    success: false,

                    message:
                        "Automation session not found"

                });

            }


            if (
                !session.running
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "No active automation session",

                    sessionId:
                        session.sessionId,

                    status:
                        session.status

                });

            }


            session.stopRequested =
                true;

            session.status =
                "STOPPING";

            session.stopReason =
                "Manual stop requested";


            if (
                !session.activeTradeId
            ) {

                session.running =
                    false;

                session.status =
                    "STOPPED";

            }


            await saveAutomationSession(
                session
            );


            return res.json({

                success:
                    true,

                message:
                    session.activeTradeId
                        ? "Automation stop requested. Current trade will finish before stopping."
                        : "Automation stopped",

                sessionId:
                    session.sessionId,

                status:
                    session.status,

                activeTradeId:
                    session.activeTradeId,

                netProfit:
                    session.netProfit,

                completedRuns:
                    session.completedRuns

            });

        }

        catch (error) {

            console.error(
                "Automation stop error:",
                error
            );


            return res.status(500).json({

                success: false,

                message:
                    "Unable to stop automation"

            });

        }

    }
);


// ======================================================
// AUTOMATION STATUS
// ======================================================

app.get(
    "/api/automation/status",
    authenticateUser,
    async (req, res) => {

        try {

            const userId =
                req.user.id;


            const sessionId =
                String(
                    req.query.sessionId ||
                    ""
                )
                .trim() ||
                null;


            const session =
                getUserAutomationSession(
                    userId,
                    sessionId
                );


            if (!session) {

                return res.status(404).json({

                    success: false,

                    message:
                        "Automation session not found"

                });

            }


            const completedRuns =
                Number(
                    session.completedRuns ||
                    0
                );


            const wins =
                Number(
                    session.wins ||
                    0
                );


            const losses =
                Number(
                    session.losses ||
                    0
                );


            const winRate =
                completedRuns > 0
                    ? Number(
                        (
                            wins /
                            completedRuns *
                            100
                        )
                        .toFixed(2)
                    )
                    : 0;


            const netProfit =
                Number(
                    session.netProfit ||
                    0
                );


            return res.status(200).json({

                success:
                    true,

                sessionId:
                    session.sessionId,

                status:
                    session.status ||
                    (
                        session.running
                            ? "RUNNING"
                            : "STOPPED"
                    ),

                running:
                    Boolean(
                        session.running
                    ),

                signal:
                    session.signal ||
                    "Scanning",

                market:
                    session.selectedMarket ||
                    session.market ||
                    "AI scanning",

                contract:
                    session.selectedContract ||
                    session.contractType ||
                    "AUTO",

                confidence:
                    Number(
                        session.confidence ||
                        0
                    ),

                reason:
                    session.lastReason ||
                    session.reason ||
                    "Waiting for qualifying setup",

                riskStatus:
                    session.riskStatus ||
                    "OK",

                runs:
                    Number(
                        session.runs ||
                        0
                    ),

                targetRuns:
                    Number(
                        session.targetRuns ??
                        session.runs ??
                        0
                    ),

                completedRuns,

                wins,

                losses,

                winRate,

                netProfit,

                profit:
                    netProfit,

                totalProfit:
                    netProfit,

                stake:
                    Number(
                        session.stake ||
                        0
                    ),

                duration:
                    1,

                durationUnit:
                    "s",

                takeProfit:
                    Number(
                        session.tp ||
                        0
                    ),

                stopLoss:
                    Number(
                        session.sl ||
                        0
                    ),

                maxLoss:
                    Number(
                        session.maxLoss ||
                        0
                    ),

                activeTradeId:
                    session.activeTradeId ||
                    null,

                lastTrade:
                    session.lastTrade ||
                    null,

                trades:
                    session.trades ||
                    [],

                results:
                    session.results ||
                    [],

                stopReason:
                    session.stopReason ||
                    null,

                startedAt:
                    session.startedAt ||
                    null,

                updatedAt:
                    session.updatedAt ||
                    null

            });

        }

        catch (error) {

            console.error(
                "Automation status error:",
                error
            );


            return res.status(500).json({

                success: false,

                message:
                    error.message ||
                    "Failed to get automation status"

            });

        }

    }
);


// ======================================================
// AUTOMATION RESULTS
// ======================================================

app.get(
    "/api/automation/results",
    authenticateUser,
    async (req, res) => {

        try {

            const userId =
                req.user.id;


            const requestedSessionId =
                String(
                    req.query.sessionId ||
                    ""
                )
                .trim() ||
                null;


            const session =
                getUserAutomationSession(
                    userId,
                    requestedSessionId
                );


            if (!session) {

                return res.json({

                    success:
                        true,

                    results:
                        []

                });

            }


            return res.json({

                success:
                    true,

                results:
                    session.results ||
                    [],

                session: {

                    sessionId:
                        session.sessionId,

                    status:
                        session.status,

                    running:
                        session.running,

                    completedRuns:
                        session.completedRuns,

                    wins:
                        session.wins,

                    losses:
                        session.losses,

                    winRate:
                        session.winRate,

                    netProfit:
                        session.netProfit,

                    profit:
                        session.netProfit,

                    totalProfit:
                        session.netProfit,

                    stopReason:
                        session.stopReason

                }

            });

        }

        catch (error) {

            console.error(
                "Automation results error:",
                error
            );


            return res.status(500).json({

                success: false,

                message:
                    "Unable to load automation results"

            });

        }

    }
);
// ======================================================
// BUY / SELL MARKET
// ======================================================

const KMF_KES_PER_USD =
    Number(
        process.env.KMF_KES_PER_USD ||
        130
    );


// ======================================================
// GET BUY / SELL MARKET
// ======================================================

app.get(
    "/api/buy-sell/market",
    async (req, res) => {

        try {

            const price =
                Number(
                    buySellMarket.getPrice(
                        "KMF-BS"
                    )
                );


            const market =
                buySellMarket.getMarket(
                    "KMF-BS"
                );


            return res.json({

                success:
                    true,

                market: {

                    symbol:
                        "KMF-BS",

                    price,

                    previousPrice:
                        Number(
                            market?.previousPrice ||
                            price
                        ),

                    tick:
                        Number(
                            market?.tick ||
                            0
                        )

                }

            });

        }

        catch (error) {

            console.error(
                "BUY/SELL MARKET ERROR:",
                error
            );


            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to load Buy/Sell market"

            });

        }

    }
);


// ======================================================
// GET BUY / SELL CANDLES
// ======================================================

app.get(
    "/api/buy-sell/candles",
    async (req, res) => {

        try {

            const candles =
                buySellMarket.getCandles(
                    "KMF-BS"
                );


            return res.json({

                success:
                    true,

                symbol:
                    "KMF-BS",

                timeframe:
                    "1m",

                candles

            });

        }

        catch (error) {

            console.error(
                "BUY/SELL CANDLES ERROR:",
                error
            );


            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to load Buy/Sell candles"

            });

        }

    }
);


// ======================================================
// GET USER BUY / SELL TRADES
// ======================================================

app.get(
    "/api/buy-sell/open",
    authenticateUser,
    async (req, res) => {

        try {

            const {

                data: trades,

                error

            } = await supabase
                .from("buy_sell_trades")
                .select("*")
                .eq(
                    "user_id",
                    req.user.id
                )
                .eq(
                    "status",
                    "open"
                )
                .order(
                    "created_at",
                    {
                        ascending:
                            false
                    }
                );


            if (error) {

                console.error(
                    "BUY/SELL OPEN ERROR:",
                    error
                );

                return res.status(500).json({

                    success:
                        false,

                    message:
                        "Unable to load Buy/Sell positions"

                });

            }


            return res.json({

                success:
                    true,

                trades:
                    trades || []

            });

        }

        catch (error) {

            console.error(
                "BUY/SELL OPEN REQUEST ERROR:",
                error
            );


            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to load Buy/Sell positions"

            });

        }

    }
);
// ======================================================
// BUY / SELL CASH OUT
// ======================================================

app.post(
    "/api/buy-sell/:id/cashout",
    authenticateUser,
    async (req, res) => {

        try {

            const result =
                await buySellSettlement.cashOutBuySellTrade(
                    req.params.id,
                    req.user.id
                );


            return res
                .status(
                    result.statusCode || 200
                )
                .json({

                    success:
                        result.success,

                    message:
                        result.message,

                    trade:
                        result.trade || null

                });

        }

        catch (error) {

            console.error(
                "BUY/SELL CASH OUT REQUEST ERROR:",
                error
            );


            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to cash out Buy/Sell position"

            });

        }

    }
);
// ==========================================
// GET BUY / SELL POSITION
// ==========================================

app.get(
    "/api/buy-sell/:id",
    authenticateUser,
    async (req, res) => {

        try {

            const tradeId =
                req.params.id;

            const userId =
                req.user.id;

            const {
                data: trade,
                error
            } = await supabase
                .from("buy_sell_trades")
                .select("*")
                .eq("id", tradeId)
                .eq("user_id", userId)
                .maybeSingle();

            if (error) {

                console.error(
                    "BUY/SELL POSITION QUERY ERROR:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to retrieve Buy/Sell position."
                });

            }

            if (!trade) {

                return res.status(404).json({
                    success: false,
                    message:
                        "Buy/Sell position not found."
                });

            }

            return res.json({
                success: true,
                trade
            });

        }

        catch (error) {

            console.error(
                "BUY/SELL POSITION ERROR:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Unable to retrieve Buy/Sell position."
            });

        }

    }
);
// ======================================================
// OPEN BUY / SELL TRADE
// ======================================================

app.post(
    "/api/buy-sell/open",
    authenticateUser,
    async (req, res) => {

        try {

            // ==================================================
            // READ INPUT
            // ==================================================

            const side =
                String(
                    req.body.side ||
                    ""
                )
                .trim()
                .toLowerCase();


            const stakeKes =
                Number(
                    req.body.stakeKes
                );


            const durationSeconds =
                Number(
                    req.body.durationSeconds
                );


            const mode =
                String(
                    req.body.mode ||
                    "demo"
                )
                .trim()
                .toLowerCase();


            const takeProfitMultiplier =
                Number(
                    req.body.takeProfitMultiplier
                );


            // ==================================================
            // VALIDATE SIDE
            // ==================================================

            if (
                side !== "buy" &&
                side !== "sell"
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Side must be BUY or SELL"

                });

            }


            // ==================================================
            // VALIDATE STAKE
            // ==================================================

            if (
                !Number.isFinite(stakeKes) ||
                stakeKes < 100
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Minimum Buy/Sell stake is KSh 100"

                });

            }


            // ==================================================
            // VALIDATE DURATION
            // ==================================================

            const validDurations = [

                5,
                10,
                30,
                60,
                120,
                300,
                600,
                900,
                1800,
                3600

            ];


            if (
                !validDurations.includes(
                    durationSeconds
                )
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid Buy/Sell duration"

                });

            }


            // ==================================================
            // VALIDATE ACCOUNT MODE
            // ==================================================

            if (
                mode !== "demo" &&
                mode !== "real"
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Account mode must be demo or real"

                });

            }


            // ==================================================
            // VALIDATE TAKE PROFIT
            // ==================================================
if (
    ![
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
        takeProfitMultiplier
    )
) {

    return res.status(400).json({
        success: false,
        message:
            "Take Profit must be between 1.5x and 10x"
    });

}
            // ==================================================
            // KES → USD CONVERSION
            // ==================================================

            const stakeUsd =
                Number(
                    (
                        stakeKes /
                        KMF_KES_PER_USD
                    ).toFixed(6)
                );


            if (
                !Number.isFinite(stakeUsd) ||
                stakeUsd <= 0
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid stake conversion"

                });

            }


            // ==================================================
            // GET USER WALLET
            // ==================================================

            const wallet =
                await getOrCreateWallet(
                    req.user.id
                );


            if (!wallet) {

                return res.status(500).json({

                    success: false,

                    message:
                        "Wallet could not be loaded"

                });

            }


            // ==================================================
            // SELECT BALANCE
            // ==================================================

            const balanceField =
                mode === "demo"
                    ? "demo_balance"
                    : "balance";


            const currentBalance =
                Number(
                    wallet[balanceField]
                );


            if (
                !Number.isFinite(
                    currentBalance
                )
            ) {

                return res.status(500).json({

                    success: false,

                    message:
                        "Invalid wallet balance"

                });

            }


            // ==================================================
            // CHECK FUNDS
            // ==================================================

            if (
                currentBalance <
                stakeUsd
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        `Insufficient ${mode} balance`

                });

            }


            // ==================================================
            // GET CURRENT MARKET PRICE
            // ==================================================

            const entryPrice =
                Number(
                    buySellMarket.getPrice(
                        "KMF-BS"
                    )
                );


            if (
                !Number.isFinite(
                    entryPrice
                ) ||
                entryPrice <= 0
            ) {

                return res.status(503).json({

                    success: false,

                    message:
                        "Buy/Sell market price unavailable"

                });

            }


            // ==================================================
            // CALCULATE NEW WALLET BALANCE
            // ==================================================

            const newBalance =
                Number(
                    (
                        currentBalance -
                        stakeUsd
                    ).toFixed(6)
                );


            // ==================================================
            // RESERVE STAKE
            // ==================================================

            const {

                data: updatedWallet,

                error: walletUpdateError

            } = await supabase
                .from("wallets")
                .update({

                    [balanceField]:
                        newBalance

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
                walletUpdateError
            ) {

                console.error(
                    "BUY/SELL WALLET RESERVE ERROR:",
                    walletUpdateError
                );

                return res.status(500).json({

                    success: false,

                    message:
                        "Unable to reserve wallet balance"

                });

            }


            if (
                !updatedWallet
            ) {

                return res.status(409).json({

                    success: false,

                    message:
                        "Wallet balance changed. Please try again."

                });

            }


            // ==================================================
            // CREATE TRADE TIMES
            // ==================================================

            const openedAt =
                new Date();


            const expiresAt =
                new Date(
                    openedAt.getTime() +
                    durationSeconds *
                    1000
                );


            // ==================================================
            // CREATE BUY / SELL TRADE
            // ==================================================

            const {

                data: trade,

                error: tradeError

            } = await supabase
                .from("buy_sell_trades")
                .insert({

                    user_id:
                        req.user.id,

                    symbol:
                        "KMF-BS",

                    mode:
                        mode,

                    side:
                        side,

                    stake_kes:
                        Number(
                            stakeKes.toFixed(2)
                        ),

                    stake_usd:
                        stakeUsd,

                    duration_seconds:
                        durationSeconds,

                    entry_price:
                        entryPrice,

                    current_price:
                        entryPrice,

                    pnl_kes:
                        0,

                    take_profit_multiplier:
                        takeProfitMultiplier,

                    status:
                        "open",

                    opened_at:
                        openedAt.toISOString(),

                    expires_at:
                        expiresAt.toISOString()

                })
                .select()
                .single();


            // ==================================================
            // TRADE CREATION FAILED
            // ==================================================

            if (
                tradeError
            ) {

                console.error(
                    "BUY/SELL TRADE INSERT ERROR:",
                    tradeError
                );


                // Restore reserved balance
                await supabase
                    .from("wallets")
                    .update({

                        [balanceField]:
                            currentBalance

                    })
                    .eq(
                        "id",
                        wallet.id
                    )
                    .eq(
                        balanceField,
                        newBalance
                    );


                return res.status(500).json({

                    success: false,

                    message:
                        "Unable to create Buy/Sell trade"

                });

            }


            // ==================================================
            // RECORD STAKE TRANSACTION
            // ==================================================

            const {

                error: transactionError

            } = await supabase
                .from("wallet_transactions")
                .insert({

                    user_id:
                        req.user.id,

                    wallet_id:
                        wallet.id,

                    transaction_type:
                        "buy_sell_stake",

                    type:
                        "buy_sell_stake",

                    amount:
                        stakeUsd,

                    status:
                        "completed",

                    payment_method:
                        "wallet",

                    reference:
                        "BS-STAKE-" +
                        trade.id,

                    reference_id:
                        trade.id,

                    description:
                        `Buy/Sell ${side.toUpperCase()} stake reserved`,

                    balance_before:
                        currentBalance,

                    balance_after:
                        newBalance

                });


            // ==================================================
            // STAKE TRANSACTION FAILED
            // ==================================================

            if (
                transactionError
            ) {

                console.error(
                    "BUY/SELL TRANSACTION LOG ERROR:",
                    transactionError
                );


                // Restore wallet balance
                const {

                    error: restoreError

                } = await supabase
                    .from("wallets")
                    .update({

                        [balanceField]:
                            currentBalance

                    })
                    .eq(
                        "id",
                        wallet.id
                    )
                    .eq(
                        balanceField,
                        newBalance
                    );


                if (
                    restoreError
                ) {

                    console.error(
                        "BUY/SELL WALLET RESTORE ERROR:",
                        restoreError
                    );

                }


                // Remove trade
                const {

                    error: deleteTradeError

                } = await supabase
                    .from("buy_sell_trades")
                    .delete()
                    .eq(
                        "id",
                        trade.id
                    )
                    .eq(
                        "user_id",
                        req.user.id
                    );


                if (
                    deleteTradeError
                ) {

                    console.error(
                        "BUY/SELL FAILED TRADE DELETE ERROR:",
                        deleteTradeError
                    );

                }


                return res.status(500).json({

                    success: false,

                    message:
                        "Unable to record Buy/Sell stake"

                });

            }


            // ==================================================
            // CALCULATE TP TARGET
            // ==================================================

            const takeProfitTargetKes =
                Number(
                    (
                        stakeKes *
                        takeProfitMultiplier
                    ).toFixed(2)
                );


            // ==================================================
            // LOG TRADE
            // ==================================================

            console.log(
                "=========================================="
            );

            console.log(
                "BUY/SELL TRADE OPENED"
            );

            console.log(
                "TRADE:",
                trade.id
            );

            console.log(
                "USER:",
                req.user.id
            );

            console.log(
                "MODE:",
                mode
            );

            console.log(
                "SIDE:",
                side
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
                "ENTRY:",
                entryPrice
            );

            console.log(
                "DURATION:",
                durationSeconds
            );

            console.log(
                "EXPIRES AT:",
                expiresAt.toISOString()
            );

            console.log(
                "TP MULTIPLIER:",
                takeProfitMultiplier
            );

            console.log(
                "TP TARGET KES:",
                takeProfitTargetKes
            );

            console.log(
                "=========================================="
            );


            // ==================================================
            // RESPONSE
            // ==================================================

            return res.status(201).json({

                success:
                    true,

                message:
                    `${side.toUpperCase()} position opened`,

                trade

            });

        }

        catch (error) {

            console.error(
                "BUY/SELL OPEN ERROR:",
                error
            );


            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to open Buy/Sell position"

            });

        }

    }
);
// ==========================================
// REGULAR TRADE SETTLEMENT WORKERS
// ==========================================

setInterval(
    async () => {

        try {

            await settleExpiredTrades();

        }
        catch (error) {

            console.error(
                "EXPIRED TRADE SETTLEMENT WORKER ERROR:",
                error
            );

        }

    },
    1000
);


setInterval(
    async () => {

        try {

            await settleTickTrades();

        }
        catch (error) {

            console.error(
                "TICK TRADE SETTLEMENT WORKER ERROR:",
                error
            );

        }

    },
    250
);


setInterval(
    async () => {

        try {

            await monitorTouchTrades();

        }
        catch (error) {

            console.error(
                "TOUCH TRADE MONITOR ERROR:",
                error
            );

        }

    },
    250
);


setInterval(
    async () => {

        try {

            await monitorActiveAccumulators();

        }
        catch (error) {

            console.error(
                "ACCUMULATOR MONITOR ERROR:",
                error
            );

        }

    },
    250
);


// ==========================================
// BUY / SELL SETTLEMENT WORKER
// ==========================================

setInterval(
    async () => {

        try {

            await buySellSettlement
                .settleBuySellTrades();

        }
        catch (error) {

            console.error(
                "BUY/SELL SETTLEMENT WORKER ERROR:",
                error
            );

        }

    },
    1000
);
// ==========================================
// CUSTOMER CARE AUTO REPLY
// ==========================================

function getCustomerCareAutoReply(message) {

    const text =
        String(message || "")
            .trim()
            .toLowerCase();

    if (
        text.includes("hello") ||
        text.includes("hi") ||
        text.includes("hey")
    ) {
        return {
            reply:
                "Hello 👋 Welcome to KMFBinary Customer Care. How can we help you today?",
            options: [
                "💰 Deposit problem",
                "💸 Withdrawal problem",
                "📊 Trade problem",
                "💳 Payment methods",
                "🔐 Account / Login",
                "🤖 Automation",
                "🧠 AI Analysis",
                "👨‍💼 Talk to a live agent",
                "❓ Other"
            ]
        };
    }

    if (
        text.includes("deposit")
    ) {
        return {
            reply:
                "I'm sorry you're having trouble with your deposit. Please tell us what happened: M-Pesa deposit, card deposit, bank deposit, deposit deducted but balance not updated, or another deposit issue."
        };
    }

    if (
        text.includes("withdraw")
    ) {
        return {
            reply:
                "I'm sorry you're having trouble with your withdrawal. Please tell us what happened: withdrawal pending, withdrawal failed, money not received, wrong withdrawal details, or another withdrawal issue."
        };
    }

    if (
        text.includes("live agent") ||
        text.includes("human") ||
        text.includes("support agent")
    ) {
        return {
            reply:
               "👨‍💼 Kindly be patient as we connect you to a live agent. An agent will respond to you shortly."
        };
    }

    if (
        text.includes("trade")
    ) {
        return {
            reply:
                "📊 We can help with your trade. Please tell us whether the trade won't execute, the result looks incorrect, your balance was deducted, the trade is still pending, or you have another trading issue."
        };
    }

    if (
        text.includes("payment")
    ) {
        return {
            reply:
                "💳 Which payment method do you need help with? M-Pesa, Card, Bank, USDT, or another payment method?"
        };
    }

    if (
        text.includes("login") ||
        text.includes("password") ||
        text.includes("account")
    ) {
        return {
            reply:
                "🔐 Please tell us what account problem you're experiencing: login, password, registration, verification, profile, or another account issue."
        };
    }

    if (
        text.includes("automation")
    ) {
        return {
            reply:
                "🤖 Please tell us what problem you're experiencing with automated trading. A support agent can check your account and assist you."
        };
    }

    if (
        text.includes("ai analysis") ||
        text.includes("ai")
    ) {
        return {
            reply:
                "🧠 Please tell us what problem you're experiencing with AI Analysis. A support agent can help you."
        };
    }

    return {
        reply:
            "Thanks for contacting KMFBinary Customer Care. Your message has been received. Please describe your problem and a support agent will assist you."
    };
}
// ==========================================
// CUSTOMER CARE API
// ==========================================


// ==========================================
// GET OR CREATE CUSTOMER CONVERSATION
// ==========================================

app.get(
    "/api/support/conversation",
    authenticateUser,
    async (req, res) => {

        try {

            const userId =
                req.user.id;


            let {
                data: conversation,
                error
            } =
                await supabase
                    .from(
                        "support_conversations"
                    )
                    .select("*")
                    .eq(
                        "user_id",
                        userId
                    )
                    .eq(
                        "status",
                        "open"
                    )
                    .order(
                        "created_at",
                        {
                            ascending: false
                        }
                    )
                    .limit(1)
                    .maybeSingle();


            if (error) {
                throw error;
            }


            // ==========================================
            // CREATE CONVERSATION IF NONE EXISTS
            // ==========================================

            if (!conversation) {

                const result =
                    await supabase
                        .from(
                            "support_conversations"
                        )
                        .insert({

                            user_id:
                                userId,

                            status:
                                "open"

                        })
                        .select()
                        .single();


                if (result.error) {
                    throw result.error;
                }


                conversation =
                    result.data;

            }


            return res.json({

                success:
                    true,

                conversation

            });

        }

        catch (error) {

            console.error(
                "CUSTOMER CARE CONVERSATION ERROR:",
                error
            );


            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to load customer care."

            });

        }

    }
);


// ==========================================
// GET CUSTOMER CARE MESSAGES
// ==========================================

app.get(
    "/api/support/messages",
    authenticateUser,
    async (req, res) => {

        try {

            const userId =
                req.user.id;


            // ==========================================
            // FIND OPEN CONVERSATION
            // ==========================================

            const {
                data: conversation,
                error: conversationError
            } =
                await supabase
                    .from(
                        "support_conversations"
                    )
                    .select("id")
                    .eq(
                        "user_id",
                        userId
                    )
                    .eq(
                        "status",
                        "open"
                    )
                    .order(
                        "created_at",
                        {
                            ascending: false
                        }
                    )
                    .limit(1)
                    .maybeSingle();


            if (conversationError) {
                throw conversationError;
            }


            // ==========================================
            // NO CONVERSATION YET
            // ==========================================

            if (!conversation) {

                return res.json({

                    success:
                        true,

                    messages:
                        []

                });

            }


            // ==========================================
            // GET MESSAGES
            // ==========================================

            const {
                data: messages,
                error
            } =
                await supabase
                    .from(
                        "support_messages"
                    )
                    .select("*")
                    .eq(
                        "conversation_id",
                        conversation.id
                    )
                    .order(
                        "created_at",
                        {
                            ascending: true
                        }
                    );


            if (error) {
                throw error;
            }


            return res.json({

                success:
                    true,

                messages:
                    messages || []

            });

        }

        catch (error) {

            console.error(
                "CUSTOMER CARE MESSAGES ERROR:",
                error
            );


            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to load messages."

            });

        }

    }
);


// ==========================================
// SEND CUSTOMER CARE MESSAGE
// ==========================================

app.post(
    "/api/support/messages",
    authenticateUser,
    async (req, res) => {

        try {

            const userId =
                req.user.id;


            // ==========================================
            // MESSAGE
            // ==========================================

            const message =
                String(
                    req.body.message || ""
                ).trim();


            if (!message) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Message cannot be empty."

                });

            }


            if (message.length > 2000) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Message is too long."

                });

            }


            // ==========================================
            // FIND OPEN CONVERSATION
            // ==========================================

            let {
                data: conversation,
                error: conversationError
            } =
                await supabase
                    .from(
                        "support_conversations"
                    )
                    .select("*")
                    .eq(
                        "user_id",
                        userId
                    )
                    .eq(
                        "status",
                        "open"
                    )
                    .order(
                        "created_at",
                        {
                            ascending: false
                        }
                    )
                    .limit(1)
                    .maybeSingle();


            if (conversationError) {
                throw conversationError;
            }


            // ==========================================
            // CREATE CONVERSATION IF NEEDED
            // ==========================================

            if (!conversation) {

                const result =
                    await supabase
                        .from(
                            "support_conversations"
                        )
                        .insert({

                            user_id:
                                userId,

                            status:
                                "open"

                        })
                        .select()
                        .single();


                if (result.error) {
                    throw result.error;
                }


                conversation =
                    result.data;

            }


            // ==========================================
            // INSERT MESSAGE
            // ==========================================

            const {
                data: newMessage,
                error
            } =
                await supabase
                    .from(
                        "support_messages"
                    )
                    .insert({

                        conversation_id:
                            conversation.id,

                        sender_id:
                            userId,

                        sender_type:
                            "customer",

                        message:
                            message

                    })
                    .select()
                    .single();


            if (error) {
                throw error;
            }
// ==========================================
// AUTOMATIC CUSTOMER CARE REPLY
// ==========================================

const autoReply =
    getCustomerCareAutoReply(message);


// ==========================================
// SEND AUTOMATIC REPLY
// ==========================================

if (
    autoReply &&
    autoReply.reply
) {

    const {
        error: autoReplyError
    } =
        await supabase
            .from(
                "support_messages"
            )
            .insert({

                conversation_id:
                    conversation.id,

                sender_id:
                    userId,

                sender_type:
                    "support",

                message:
                    autoReply.reply

            });


    if (autoReplyError) {

        console.error(
            "CUSTOMER CARE AUTO REPLY ERROR:",
            autoReplyError
        );

    }

}

            // ==========================================
            // UPDATE CONVERSATION TIME
            // ==========================================

            await supabase
                .from(
                    "support_conversations"
                )
                .update({

                    updated_at:
                        new Date().toISOString()

                })
                .eq(
                    "id",
                    conversation.id
                );


            return res.json({

                success:
                    true,

                message:
                    newMessage

            });

        }

        catch (error) {

            console.error(
                "CUSTOMER CARE SEND ERROR:",
                error
            );


            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to send message."

            });

        }

    }
);


// ==========================================
// END CUSTOMER CARE API
// ==========================================
// ==========================================
// ADMIN ROUTES
// ==========================================

registerAdminRoutes(
    app,
    authenticateUser
);

// ==========================================
// START SERVER
// ==========================================

/* =====================================================
   KMFBINARY REFERRAL API
   Uses existing Supabase client and authentication
   ===================================================== */

async function ensureReferralProfile(userId) {
    const { data: existing, error: lookupError } =
        await supabase
            .from("referral_profiles")
            .select("user_id, referral_code")
            .eq("user_id", userId)
            .maybeSingle();

    if (lookupError) throw lookupError;
    if (existing) return existing;

    for (let attempt = 0; attempt < 5; attempt++) {
        const referralCode =
            "KMF" +
            crypto.randomBytes(5).toString("hex").toUpperCase();

        const { data, error } = await supabase
            .from("referral_profiles")
            .insert({
                user_id: userId,
                referral_code: referralCode
            })
            .select("user_id, referral_code")
            .maybeSingle();

        if (!error && data) return data;

        // Another request may have created this user's profile.
        const { data: retryProfile, error: retryError } =
            await supabase
                .from("referral_profiles")
                .select("user_id, referral_code")
                .eq("user_id", userId)
                .maybeSingle();

        if (retryError) throw retryError;
        if (retryProfile) return retryProfile;

        // Retry only for a duplicate referral code.
        if (
            !String(error?.message || "")
                .toLowerCase()
                .includes("duplicate")
        ) {
            throw error || new Error(
                "Unable to create referral profile"
            );
        }
    }

    throw new Error("Unable to generate a unique referral code");
}


// -----------------------------------------------------
// GET REFERRAL DASHBOARD DATA
// -----------------------------------------------------

app.get(
    "/api/referrals/dashboard",
    authenticateUser,
    async (req, res) => {
        try {
            const userId = req.user.id;

            const referralProfile =
                await ensureReferralProfile(userId);

            const [
                referralsResult,
                commissionsResult,
                promotionsResult
            ] = await Promise.all([
                supabase
                    .from("referrals")
                    .select(
                        "id, referred_user_id, status, successful_deposit_total, first_deposit_at, created_at"
                    )
                    .eq("referrer_id", userId)
                    .order("created_at", { ascending: false }),

                supabase
                    .from("referral_commissions")
                    .select(
                        "referred_user_id, deposit_amount, commission_amount, status, created_at"
                    )
                    .eq("referrer_id", userId),

                supabase
                    .from("promotions")
                    .select(
                        "id, name, type, bonus_percent, min_deposit, max_bonus, active, start_at, expires_at"
                    )
                    .order("created_at", { ascending: false })
            ]);

            if (referralsResult.error) {
                throw referralsResult.error;
            }

            if (commissionsResult.error) {
                throw commissionsResult.error;
            }

            if (promotionsResult.error) {
                throw promotionsResult.error;
            }

            const referrals = referralsResult.data || [];
            const commissions = commissionsResult.data || [];
            const promotions = promotionsResult.data || [];

            const referredIds = [
                ...new Set(
                    referrals.map(item => item.referred_user_id)
                )
            ];

            let profiles = [];

            if (referredIds.length > 0) {
                const { data, error } = await supabase
                    .from("profiles")
                    .select("id, username, full_name")
                    .in("id", referredIds);

                if (error) throw error;
                profiles = data || [];
            }

            const profileById = new Map(
                profiles.map(profile => [profile.id, profile])
            );

            const money = value =>
                Number(Number(value || 0).toFixed(2));

            const referredUsers = referrals.map(referral => {
                const userProfile =
                    profileById.get(referral.referred_user_id);

                const userCommissions = commissions.filter(
                    item =>
                        item.referred_user_id ===
                        referral.referred_user_id
                );

                let commissionStatus = "No commission";

                if (
                    userCommissions.some(
                        item => item.status === "paid"
                    )
                ) {
                    commissionStatus = "Paid";
                } else if (
                    userCommissions.some(
                        item => item.status === "approved"
                    )
                ) {
                    commissionStatus = "Approved";
                } else if (
                    userCommissions.some(
                        item => item.status === "pending"
                    )
                ) {
                    commissionStatus = "Pending";
                } else if (
                    userCommissions.some(
                        item => item.status === "rejected"
                    )
                ) {
                    commissionStatus = "Rejected";
                }

                return {
                    userId: referral.referred_user_id,
                    username:
                        userProfile?.username ||
                        userProfile?.full_name ||
                        "KMFBinary user",
                    registeredAt: referral.created_at,
                    status: referral.status,
                    successfulDepositTotal:
                        money(referral.successful_deposit_total),
                    commissionStatus
                };
            });

            const earned = commissions
                .filter(item =>
                    ["approved", "paid"].includes(
                        String(item.status || "").toLowerCase()
                    )
                )
                .reduce(
                    (sum, item) =>
                        sum + Number(item.commission_amount || 0),
                    0
                );

            const pending = commissions
                .filter(
                    item =>
                        String(item.status || "").toLowerCase() ===
                        "pending"
                )
                .reduce(
                    (sum, item) =>
                        sum + Number(item.commission_amount || 0),
                    0
                );

            const now = Date.now();

            const promotionList = promotions.map(promotion => {
                const startsAt = promotion.start_at
                    ? new Date(promotion.start_at).getTime()
                    : null;

                const expiresAt = promotion.expires_at
                    ? new Date(promotion.expires_at).getTime()
                    : null;

                const isActive =
                    promotion.active === true &&
                    (!startsAt || startsAt <= now) &&
                    (!expiresAt || expiresAt >= now);

                return {
                    id: promotion.id,
                    name: promotion.name,
                    type: promotion.type,
                    bonusPercent: Number(
                        promotion.bonus_percent || 0
                    ),
                    minDeposit: Number(
                        promotion.min_deposit || 0
                    ),
                    maxBonus: Number(
                        promotion.max_bonus || 0
                    ),
                    active: isActive,
                    startsAt: promotion.start_at,
                    expiresAt: promotion.expires_at
                };
            });

            const baseUrl =
                process.env.FRONTEND_URL ||
                req.get("origin") ||
                "";

            const referralLink = baseUrl
                ? `${baseUrl.replace(/\/$/, "")}/register.html?ref=${encodeURIComponent(referralProfile.referral_code)}`
                : `/register.html?ref=${encodeURIComponent(referralProfile.referral_code)}`;

            return res.json({
                success: true,
                referralCode: referralProfile.referral_code,
                referralLink,
                stats: {
                    total: referrals.length,
                    depositing: referrals.filter(
                        item =>
                            Number(item.successful_deposit_total || 0) > 0 ||
                            ["deposited", "eligible"].includes(item.status)
                    ).length,
                    earned: money(earned),
                    pending: money(pending)
                },
                referredUsers,
                promotions: promotionList
            });
        } catch (error) {
            console.error("Referral dashboard error:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to load referral information"
            });
        }
    }
);


// -----------------------------------------------------
// APPLY A REFERRAL CODE ONCE PER ACCOUNT
// -----------------------------------------------------

app.post(
    "/api/referrals/apply",
    authenticateUser,
    async (req, res) => {
        try {
            const userId = req.user.id;

            const referralCode = String(
                req.body?.referralCode || ""
            ).trim().toUpperCase();

            if (
                !referralCode ||
                referralCode.length > 40
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Enter a valid referral code."
                });
            }

            const { data: owner, error: ownerError } =
                await supabase
                    .from("referral_profiles")
                    .select("user_id, referral_code")
                    .eq("referral_code", referralCode)
                    .maybeSingle();

            if (ownerError) throw ownerError;

            if (!owner) {
                return res.status(404).json({
                    success: false,
                    message: "Referral code not found."
                });
            }

            if (owner.user_id === userId) {
                return res.status(400).json({
                    success: false,
                    message: "You cannot use your own referral code."
                });
            }

            const { data: existing, error: existingError } =
                await supabase
                    .from("referrals")
                    .select("id")
                    .eq("referred_user_id", userId)
                    .maybeSingle();

            if (existingError) throw existingError;

            if (existing) {
                return res.status(409).json({
                    success: false,
                    message: "A referral code has already been applied to this account."
                });
            }

            const { error: insertError } = await supabase
                .from("referrals")
                .insert({
                    referrer_id: owner.user_id,
                    referred_user_id: userId,
                    status: "registered",
                    successful_deposit_total: 0
                });

            if (insertError) {
                // The unique referred_user_id constraint also
                // protects against simultaneous applications.
                if (
                    insertError.code === "23505"
                ) {
                    return res.status(409).json({
                        success: false,
                        message: "A referral code has already been applied to this account."
                    });
                }

                throw insertError;
            }

            return res.json({
                success: true,
                message: "Referral code applied successfully."
            });
        } catch (error) {
            console.error("Apply referral code error:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to apply this referral code."
            });
        }
    }
);
app.listen(
    PORT,
    () => {

        console.log(
            "=========================================="
        );

        console.log(
            `KMFBinary server running on port ${PORT}`
        );

        console.log(
            "http://localhost:" + PORT
        );

        console.log(
            "=========================================="
        );

    }
);