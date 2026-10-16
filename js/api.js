"use strict";

const API_BASE_URL = "http://localhost:3000";


// ==========================================
// SUPABASE CONFIGURATION
// ==========================================

const SUPABASE_URL =
    "https://nugufikdivanyzmghofq.supabase.co";

const SUPABASE_KEY =
    "sb_publishable_NfsjmPephsaJrRB6vLXglw_G6yTdPTl";


// ==========================================
// INITIALIZE SUPABASE
// ==========================================

function initializeSupabase() {

    if (window.supabaseClient) {
        return window.supabaseClient;
    }

    if (!window.supabase) {
        console.error(
            "Supabase library is not loaded."
        );
        return null;
    }

    window.supabaseClient =
        window.supabase.createClient(
            SUPABASE_URL,
            SUPABASE_KEY
        );

    console.log(
        "Supabase client initialized."
    );

    return window.supabaseClient;
}

// ==========================================
// INITIALIZE IMMEDIATELY
// ==========================================

initializeSupabase();


// ==========================================
// GET AUTH TOKEN
// ==========================================

async function getAuthToken() {

    const client =
        initializeSupabase();

    if (!client) {
        return null;
    }

    const {
        data: { session },
        error
    } =
        await client.auth.getSession();

    if (error) {

        console.error(
            "Session error:",
            error
        );

        return null;
    }

    if (!session) {

        console.warn(
            "No active Supabase session."
        );

        return null;
    }

    return session.access_token;
}


// ==========================================
// GET CURRENT USER
// ==========================================

async function getCurrentUser() {

    const client =
        initializeSupabase();

    if (!client) {
        return null;
    }

    const {
        data: { user },
        error
    } =
        await client.auth.getUser();

    if (error) {

        console.error(
            "User error:",
            error
        );

        return null;
    }

    return user;
}


// ==========================================
// API REQUEST
// ==========================================

async function apiRequest(
    endpoint,
    options = {}
) {

    const token =
        await getAuthToken();

    const headers = {

        "Content-Type":
            "application/json",

        ...(options.headers || {})

    };

    if (token) {

        headers["Authorization"] =
            "Bearer " + token;

    }

    const response =
        await fetch(
            API_BASE_URL + endpoint,
            {
                ...options,
                headers
            }
        );

    let data;

    try {

        data =
            await response.json();

    } catch (error) {

        throw new Error(
            "Server returned an invalid response."
        );

    }

    if (!response.ok) {

        if (
            response.status === 401
        ) {

            throw new Error(
                "Authentication required. Please log in again."
            );

        }

        throw new Error(
            data.error ||
            data.message ||
            "API request failed."
        );

    }

    return data;
}


// ==========================================
// GET MARKETS
// ==========================================

async function getMarkets() {

    const response =
        await apiRequest(
            "/api/markets"
        );

    if (
        response &&
        Array.isArray(
            response.markets
        )
    ) {

        return response.markets;

    }

    return [];
}


// ==========================================
// GET PRICES
// ==========================================

async function getPrices() {

    return await apiRequest(
        "/api/prices"
    );

}


// ==========================================
// PLACE TRADE
// ==========================================

async function placeTrade(
    tradeData
) {

    const response =
        await apiRequest(
            "/api/trades",
            {
                method: "POST",

                body:
                    JSON.stringify(
                        tradeData
                    )
            }
        );

    if (
        response &&
        response.trade
    ) {

        return response;

    }

    throw new Error(
        "Backend did not return a trade."
    );

}


// ==========================================
// GET USER TRADES
// ==========================================

async function getTrades() {

    const response =
        await apiRequest(
            "/api/trades"
        );

    if (
        response &&
        Array.isArray(
            response.trades
        )
    ) {

        return response.trades;

    }

    return [];
}


// ==========================================
// GET ONE USER TRADE
// ==========================================

async function getTrade(
    tradeId
) {

    const response =
        await apiRequest(
            "/api/trades/" +
            encodeURIComponent(
                tradeId
            )
        );

    if (
        response &&
        response.trade
    ) {

        return response.trade;

    }

    return null;
}


// ==========================================
// GET WALLET
// ==========================================

async function getWallet() {

    return await apiRequest(
        "/api/wallet"
    );

}


// ==========================================
// GET WALLET TRANSACTIONS
// ==========================================

async function getWalletTransactions() {

    const response =
        await apiRequest(
            "/api/wallet/transactions"
        );

    if (
        response &&
        Array.isArray(
            response.transactions
        )
    ) {

        return response.transactions;

    }

    return [];
}


// ==========================================
// CHECK AUTHENTICATION
// ==========================================

async function isAuthenticated() {

    const token =
        await getAuthToken();

    return !!token;

}

