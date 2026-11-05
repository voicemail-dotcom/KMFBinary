/* ============================================================
   KMFBINARY WALLET
   ============================================================

   Handles:
   - Demo / Live account
   - Wallet balances
   - Deposit
   - Withdrawal
   - Withdrawal calculation
   - Bonus protection display
   - 10% processing fee
   - Transaction history
   - Withdrawal eligibility
   - Account switching

   IMPORTANT:
   Backend remains the final authority for balances and
   withdrawal validation.
   ============================================================ */

let walletData = null;
let transactions = [];
let tradeHistory = [];

let currentHistoryFilter = "all";
let walletRefreshTimer = null;

let withdrawalEligibilityData = null;

let depositMonitorTimer = null;

const USD_KES_DEPOSIT_RATE = 135;
const USD_KES_WITHDRAWAL_RATE = 124;

const WITHDRAWAL_FEE_PERCENT = 10;

const WALLET_REFRESH_INTERVAL = 5000;


/* ============================================================
   BACKEND API
============================================================ */

/*
   Frontend:
   http://127.0.0.1:5500

   Backend:
   http://localhost:3000

   All /api/... requests from this wallet are therefore sent
   directly to the Express backend.
*/

const WALLET_API_BASE_URL = window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
    ? "http://localhost:3000"
    : "https://kmfbinary.site";

/* ============================================================
   BASIC HELPERS
============================================================ */

function money(value) {
    const number = Number(value || 0);

    if (!Number.isFinite(number)) {
        return "$0.00";
    }

    return `$${number.toFixed(2)}`;
}


function numberValue(value) {
    const number = Number(value);

    return Number.isFinite(number)
        ? number
        : 0;
}


function roundMoney(value) {
    return Number(
        numberValue(value).toFixed(2)
    );
}


function getAccountMode() {
    const mode = String(
        localStorage.getItem("kmf_account_mode") || "demo"
    ).toLowerCase();

    return mode === "live"
        ? "live"
        : "demo";
}


function setAccountMode(mode) {
    localStorage.setItem(
        "kmf_account_mode",
        mode === "live" ? "live" : "demo"
    );
}


function isLiveAccount() {
    return getAccountMode() === "live";
}


/* ============================================================
   MESSAGE
============================================================ */

function showMessage(
    message,
    type = "info"
) {
    const box = document.getElementById(
        "messageBox"
    );

    if (!box) {
        return;
    }

    box.textContent = message;

    box.className = "";

    box.classList.add(type);

    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });
}


function clearMessage() {
    const box = document.getElementById(
        "messageBox"
    );

    if (!box) {
        return;
    }

    box.textContent = "";
    box.className = "";
}


/* ============================================================
   PHONE NORMALIZATION
============================================================ */

function normalizeKenyanPhone(value) {
    let phone = String(
        value || ""
    ).trim();

    phone = phone.replace(
        /[\s\-()]/g,
        ""
    );

    if (phone.startsWith("+254")) {
        phone = phone.substring(1);
    }

    if (
        phone.startsWith("07") ||
        phone.startsWith("01")
    ) {
        phone = "254" + phone.substring(1);
    }

    if (
        phone.startsWith("7") ||
        phone.startsWith("1")
    ) {
        phone = "254" + phone;
    }

    return phone;
}


function isValidKenyanPhone(value) {
    const phone = normalizeKenyanPhone(
        value
    );

    return /^254[17]\d{8}$/.test(phone);
}


/* ============================================================
   ACCOUNT UI
============================================================ */

function updateAccountUI() {

    const live = isLiveAccount();

    const accountName =
        document.getElementById(
            "accountName"
        );

    const accountSubtitle =
        document.getElementById(
            "accountSubtitle"
        );

    const accountDot =
        document.getElementById(
            "accountDot"
        );

    const balanceLabel =
        document.getElementById(
            "balanceLabel"
        );

    const balanceNote =
        document.getElementById(
            "balanceNote"
        );

    const demoNotice =
        document.getElementById(
            "demoNotice"
        );

    const walletActions =
        document.getElementById(
            "walletActions"
        );

    if (live) {

        if (accountName) {
            accountName.textContent =
                "LIVE ACCOUNT";
        }

        if (accountSubtitle) {
            accountSubtitle.textContent =
                "Real account funds";
        }

        if (accountDot) {
            accountDot.style.background =
                "#21d07a";
        }

        if (balanceLabel) {
            balanceLabel.textContent =
                "Live Available Balance";
        }

        if (balanceNote) {
            balanceNote.textContent =
                "Live trading account";
        }

        if (demoNotice) {
            demoNotice.classList.add(
                "hidden"
            );
        }

        if (walletActions) {
            walletActions.style.display =
                "block";
        }

    } else {

        if (accountName) {
            accountName.textContent =
                "DEMO ACCOUNT";
        }

        if (accountSubtitle) {
            accountSubtitle.textContent =
                "Virtual funds only";
        }

        if (accountDot) {
            accountDot.style.background =
                "#6eb0ff";
        }

        if (balanceLabel) {
            balanceLabel.textContent =
                "Demo Available Balance";
        }

        if (balanceNote) {
            balanceNote.textContent =
                "Virtual funds only";
        }

        if (demoNotice) {
            demoNotice.classList.remove(
                "hidden"
            );
        }

        if (walletActions) {
            walletActions.style.display =
                "none";
        }
    }
}


/* ============================================================
   CALCULATE BALANCES
============================================================ */

/*
   Current promotional model:

   wallet.balance
       = total live trading balance

   wallet.bonus_balance
       = protected promotional amount

   withdrawable
       = trading balance - protected bonus

   Example:

   Trading = 150
   Bonus   = 50
   Withdrawable = 100

   Trading = 250
   Bonus   = 50
   Withdrawable = 200

   Trading = 30
   Bonus   = 50
   Withdrawable = 0
*/

function calculateLiveBalances(wallet) {

    const tradingBalance = roundMoney(
        wallet && wallet.balance
            ? wallet.balance
            : 0
    );

    const bonusBalance = roundMoney(
        wallet && wallet.bonus_balance
            ? wallet.bonus_balance
            : 0
    );

    const withdrawableBalance =
        roundMoney(
            Math.max(
                0,
                tradingBalance -
                bonusBalance
            )
        );

    return {
        tradingBalance,
        bonusBalance,
        withdrawableBalance
    };
}


/* ============================================================
   UPDATE BALANCE DISPLAY
============================================================ */

function updateBalanceDisplay() {

    if (!walletData) {
        return;
    }

    const live = isLiveAccount();

    const balanceElement =
        document.getElementById(
            "balance"
        );

    const tradingElement =
        document.getElementById(
            "tradingBalance"
        );

    const bonusElement =
        document.getElementById(
            "bonusBalance"
        );

    const withdrawableElement =
        document.getElementById(
            "withdrawableBalance"
        );

    if (!live) {

        const demoBalance =
            numberValue(
                walletData.demo_balance
            );

        if (balanceElement) {
            balanceElement.textContent =
                money(demoBalance);
        }

        if (tradingElement) {
            tradingElement.textContent =
                money(demoBalance);
        }

        if (bonusElement) {
            bonusElement.textContent =
                "$0.00";
        }

        if (withdrawableElement) {
            withdrawableElement.textContent =
                money(demoBalance);
        }

        updateWithdrawalSummary(
            demoBalance,
            0,
            demoBalance
        );

        return;
    }

    const balances =
        calculateLiveBalances(
            walletData
        );

    if (balanceElement) {
        balanceElement.textContent =
            money(
                balances.tradingBalance
            );
    }

    if (tradingElement) {
        tradingElement.textContent =
            money(
                balances.tradingBalance
            );
    }

    if (bonusElement) {
        bonusElement.textContent =
            money(
                balances.bonusBalance
            );
    }

    if (withdrawableElement) {
        withdrawableElement.textContent =
            money(
                balances.withdrawableBalance
            );
    }

    const maxAmount =
        document.getElementById(
            "withdrawMaxAmount"
        );

    if (maxAmount) {
        maxAmount.textContent =
            money(
                balances.withdrawableBalance
            );
    }

    updateWithdrawalSummary(
        balances.tradingBalance,
        balances.bonusBalance,
        balances.withdrawableBalance
    );
}


/* ============================================================
   WITHDRAWAL CALCULATION
============================================================ */

function calculateWithdrawal(
    requestedAmount,
    withdrawableAmount
) {

    const request = Math.max(
        0,
        numberValue(requestedAmount)
    );

    const available = Math.max(
        0,
        numberValue(withdrawableAmount)
    );

    const fee = roundMoney(
        request *
        (WITHDRAWAL_FEE_PERCENT / 100)
    );

    const payout = roundMoney(
        Math.max(
            0,
            request - fee
        )
    );

    return {
        request,
        available,
        fee,
        payout,
        exceedsAvailable:
            request > available
    };
}


function updateWithdrawalSummary(
    tradingBalance,
    bonusBalance,
    withdrawableBalance
) {

    const amountInput =
        document.getElementById(
            "withdrawAmount"
        );

    const requestedAmount =
        amountInput
            ? numberValue(
                amountInput.value
            )
            : 0;

    const calculation =
        calculateWithdrawal(
            requestedAmount,
            withdrawableBalance
        );

    const tradingElement =
        document.getElementById(
            "withdrawSummaryTrading"
        );

    const bonusElement =
        document.getElementById(
            "withdrawSummaryBonus"
        );

    const withdrawableElement =
        document.getElementById(
            "withdrawSummaryWithdrawable"
        );

    const requestElement =
        document.getElementById(
            "withdrawSummaryRequest"
        );

    const feeElement =
        document.getElementById(
            "withdrawSummaryFee"
        );

    const payoutElement =
        document.getElementById(
            "withdrawSummaryPayout"
        );

    if (tradingElement) {
        tradingElement.textContent =
            money(tradingBalance);
    }

    if (bonusElement) {
        bonusElement.textContent =
            money(bonusBalance);
    }

    if (withdrawableElement) {
        withdrawableElement.textContent =
            money(withdrawableBalance);
    }

    if (requestElement) {
        requestElement.textContent =
            money(calculation.request);
    }

    if (feeElement) {
        feeElement.textContent =
            money(calculation.fee);
    }

    if (payoutElement) {
        payoutElement.textContent =
            money(calculation.payout);
    }
}


/* ============================================================
   AUTH
============================================================ */

async function getCurrentUser() {

    try {

        if (
            typeof supabase === "undefined"
        ) {
            return null;
        }

        if (
            typeof window.supabaseClient !==
            "undefined" &&
            window.supabaseClient
        ) {

            const {
                data,
                error
            } =
                await window.supabaseClient
                    .auth
                    .getUser();

            if (error) {
                console.error(
                    "Supabase auth error:",
                    error
                );

                return null;
            }

            return data?.user || null;
        }

        return null;

    } catch (error) {

        console.error(
            "getCurrentUser error:",
            error
        );

        return null;
    }
}


/* ============================================================
   API REQUEST HELPER
============================================================ */

async function walletApi(
    url,
    options = {}
) {

    /*
       If the caller supplies /api/...
       send it to the Express backend.

       Example:

       /api/wallet
       becomes:

       http://localhost:3000/api/wallet

       Absolute URLs are left unchanged.
    */

    let requestUrl = url;

    if (
        typeof url === "string" &&
        url.startsWith("/")
    ) {
        requestUrl =
            WALLET_API_BASE_URL +
            url;
    }


    /* ========================================================
       GET CURRENT SUPABASE SESSION
    ======================================================== */

    let accessToken = null;

    try {

        if (
            typeof window.supabaseClient !==
            "undefined" &&
            window.supabaseClient
        ) {

            const {
                data,
                error
            } =
                await window.supabaseClient
                    .auth
                    .getSession();

            if (error) {

                console.error(
                    "Supabase session error:",
                    error
                );

            } else {

                accessToken =
                    data?.session?.access_token ||
                    null;
            }
        }

    } catch (error) {

        console.error(
            "Unable to get Supabase session:",
            error
        );
    }


    /* ========================================================
       REQUEST HEADERS
    ======================================================== */

    const requestHeaders = {
        "Content-Type":
            "application/json",
        ...(options.headers || {})
    };


    /*
       Send the Supabase access token to the
       Express backend.

       Backend authenticateUser expects:

       Authorization: Bearer <access_token>
    */

    if (accessToken) {

        requestHeaders.Authorization =
            `Bearer ${accessToken}`;
    }


    const requestOptions = {
        ...options,
        headers: requestHeaders
    };


    /* ========================================================
       SEND REQUEST
    ======================================================== */

    const response =
        await fetch(
            requestUrl,
            requestOptions
        );

    let data = null;

    try {
        data = await response.json();
    } catch (_) {
        data = null;
    }

    if (!response.ok) {

        const error =
            new Error(
                data?.error ||
                data?.message ||
                `Request failed (${response.status})`
            );

        error.status =
            response.status;

        error.data =
            data;

        throw error;
    }

    return data;
}


/* ============================================================
   LOAD WALLET
============================================================ */

async function loadWallet(
    silent = false
) {

    try {

        const data =
            await walletApi(
                "/api/wallet"
            );

        /*
           The backend normally returns the
           wallet object directly or inside
           data.wallet.
        */

        walletData =
            data?.wallet ||
            data?.data?.wallet ||
            data?.data ||
            data;

        if (!walletData) {
            throw new Error(
                "Wallet data was not returned."
            );
        }

        updateAccountUI();

        updateBalanceDisplay();

        if (isLiveAccount()) {

            await checkWithdrawalEligibility(
                silent
            );

        } else {

            hideWithdrawalForDemo();
        }

        await loadTransactions(
            silent
        );

    } catch (error) {

        console.error(
            "loadWallet error:",
            error
        );

        if (!silent) {

            showMessage(
                error.message ||
                "Unable to load wallet.",
                "error"
            );
        }
    }
}


/* ============================================================
   WITHDRAWAL ELIGIBILITY
============================================================ */

async function checkWithdrawalEligibility(
    silent = false
) {

    if (!isLiveAccount()) {
        hideWithdrawalForDemo();
        return;
    }

    const statusBox =
        document.getElementById(
            "withdrawalStatusBox"
        );

    const statusTitle =
        document.getElementById(
            "withdrawalStatusTitle"
        );

    const statusMessage =
        document.getElementById(
            "withdrawalStatusMessage"
        );

    const form =
        document.getElementById(
            "withdrawalForm"
        );

    const verificationButton =
        document.getElementById(
            "openVerificationButton"
        );

    try {

        const data =
            await walletApi(
                "/api/wallet/withdrawal-status"
            );

        withdrawalEligibilityData =
            data;

        const status =
            String(
                data?.status ||
                data?.eligibility ||
                ""
            ).toLowerCase();


        /* ====================================================
           CORRECTION:
           Backend uses canWithdraw: true.

           This also keeps compatibility with any older
           frontend/backend response that used:
           - status: approved
           - status: eligible
           - eligible: true
        ==================================================== */

        const canWithdraw =
            data?.canWithdraw === true ||
            status === "approved" ||
            status === "eligible" ||
            data?.eligible === true;


        if (canWithdraw) {

            if (statusBox) {
                statusBox.className =
                    "status-box success";
            }

            if (statusTitle) {

                if (
                    data?.reason ===
                    "role_exempt"
                ) {

                    statusTitle.textContent =
                        "Withdrawal Available";

                } else {

                    statusTitle.textContent =
                        "Withdrawal Available";
                }
            }

            if (statusMessage) {

                if (
                    data?.reason ===
                    "role_exempt"
                ) {

                    statusMessage.textContent =
                        "Your administrator account is eligible for withdrawals.";

                } else {

                    statusMessage.textContent =
                        "Your account is eligible for withdrawals.";
                }
            }

            if (form) {
                form.classList.remove(
                    "hidden"
                );
            }

            if (verificationButton) {
                verificationButton.classList.add(
                    "hidden"
                );
            }

            return;
        }


        if (
            status === "no_deposit" ||
            status === "deposit_required"
        ) {

            if (statusBox) {
                statusBox.className =
                    "status-box warning";
            }

            if (statusTitle) {
                statusTitle.textContent =
                    "Deposit Required";
            }

            if (statusMessage) {
                statusMessage.textContent =
                    "You must complete at least one successful Live Account deposit before requesting a withdrawal.";
            }

            if (form) {
                form.classList.add(
                    "hidden"
                );
            }

            if (verificationButton) {
                verificationButton.classList.add(
                    "hidden"
                );
            }

            return;
        }


        if (
            status === "pending" ||
            status === "verification_pending"
        ) {

            if (statusBox) {
                statusBox.className =
                    "status-box warning";
            }

            if (statusTitle) {
                statusTitle.textContent =
                    "Verification Pending";
            }

            if (statusMessage) {
                statusMessage.textContent =
                    "Your verification is still being reviewed.";
            }

            if (form) {
                form.classList.add(
                    "hidden"
                );
            }

            if (verificationButton) {
                verificationButton.classList.add(
                    "hidden"
                );
            }

            return;
        }


        if (
            status === "rejected"
        ) {

            if (statusBox) {
                statusBox.className =
                    "status-box error";
            }

            if (statusTitle) {
                statusTitle.textContent =
                    "Verification Required";
            }

            if (statusMessage) {
                statusMessage.textContent =
                    data?.message ||
                    "Your verification was not approved.";
            }

            if (form) {
                form.classList.add(
                    "hidden"
                );
            }

            if (verificationButton) {
                verificationButton.classList.remove(
                    "hidden"
                );
            }

            return;
        }


        if (statusBox) {
            statusBox.className =
                "status-box warning";
        }

        if (statusTitle) {
            statusTitle.textContent =
                "Verification Required";
        }

        if (statusMessage) {
            statusMessage.textContent =
                data?.message ||
                "Complete account verification before requesting a withdrawal.";
        }

        if (form) {
            form.classList.add(
                "hidden"
            );
        }

        if (verificationButton) {
            verificationButton.classList.remove(
                "hidden"
            );
        }

    } catch (error) {

        console.error(
            "checkWithdrawalEligibility error:",
            error
        );

        if (!silent) {

            if (statusBox) {
                statusBox.className =
                    "status-box error";
            }

            if (statusTitle) {
                statusTitle.textContent =
                    "Unable to Check Withdrawal";
            }

            if (statusMessage) {
                statusMessage.textContent =
                    error.message ||
                    "Unable to check withdrawal eligibility.";
            }
        }
    }
}


function hideWithdrawalForDemo() {

    const statusBox =
        document.getElementById(
            "withdrawalStatusBox"
        );

    const form =
        document.getElementById(
            "withdrawalForm"
        );

    const verificationButton =
        document.getElementById(
            "openVerificationButton"
        );

    if (statusBox) {
        statusBox.className =
            "status-box";
    }

    if (form) {
        form.classList.add(
            "hidden"
        );
    }

    if (verificationButton) {
        verificationButton.classList.add(
            "hidden"
        );
    }
}


/* ============================================================
   DEPOSIT METHOD
============================================================ */

function updateMpesaField() {

    const method =
        document.getElementById(
            "depositMethod"
        )?.value;

    const group =
        document.getElementById(
            "mpesaPhoneGroup"
        );

    if (!group) {
        return;
    }

    if (method === "mpesa") {
        group.classList.remove(
            "hidden"
        );
    } else {
        group.classList.add(
            "hidden"
        );
    }
}


/* ============================================================
   WITHDRAWAL METHOD
============================================================ */

function updateWithdrawPhoneField() {

    const method =
        document.getElementById(
            "withdrawMethod"
        )?.value;

    const group =
        document.getElementById(
            "withdrawPhoneGroup"
        );

    if (!group) {
        return;
    }

    if (method === "mpesa") {
        group.classList.remove(
            "hidden"
        );
    } else {
        group.classList.add(
            "hidden"
        );
    }
}


/* ============================================================
   DEPOSIT
============================================================ */
async function handleDeposit(event) {
    event.preventDefault();
    clearMessage();

    if (!isLiveAccount()) {
        showMessage(
            "Deposits are available only on the Live Account.",
            "error"
        );
        return;
    }

    const amount = numberValue(
        document.getElementById("depositAmount")?.value
    );

    const method =
        document.getElementById("depositMethod")?.value || "mpesa";

    const phone =
        document.getElementById("mpesaPhone")?.value || "";

    if (!Number.isFinite(amount) || amount <= 0) {
        showMessage("Enter a valid deposit amount.", "error");
        return;
    }

    if (method === "mpesa" && !isValidKenyanPhone(phone)) {
        showMessage("Enter a valid Kenyan M-Pesa number.", "error");
        return;
    }

    const button = document.getElementById("depositButton");

    if (button) {
        button.disabled = true;
        button.textContent = "Processing...";
    }

    try {
        if (method === "mpesa") {
            const normalizedPhone = normalizeKenyanPhone(phone);

            const result = await walletApi("/api/mpesa/stkpush", {
                method: "POST",
                body: JSON.stringify({
                    phoneNumber: normalizedPhone,
                    amount: amount,
                    usdAmount: amount
                })
            });

            showMessage(
                result?.message ||
                "M-Pesa payment request sent. Check your phone.",
                "success"
            );
        } else {
            const result = await walletApi("/api/wallet/deposit", {
                method: "POST",
                body: JSON.stringify({
                    amount,
                    paymentMethod: method
                })
            });

            showMessage(
                result?.message || "Deposit request submitted.",
                "success"
            );
        }

        const amountInput = document.getElementById("depositAmount");

        if (amountInput) {
            amountInput.value = "";
        }

        await loadWallet(true);

    } catch (error) {
        console.error("handleDeposit error:", error);

        showMessage(
            error.message || "Deposit request failed.",
            "error"
        );
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = "Deposit";
        }
    }
}

/* ============================================================
   WITHDRAWAL INPUT CHANGE
============================================================ */

function handleWithdrawalAmountInput() {

    if (!walletData) {
        return;
    }

    const balances =
        calculateLiveBalances(
            walletData
        );

    updateWithdrawalSummary(
        balances.tradingBalance,
        balances.bonusBalance,
        balances.withdrawableBalance
    );
}


/* ============================================================
   WITHDRAWAL
============================================================ */

async function handleWithdrawal(
    event
) {

    event.preventDefault();

    clearMessage();

    if (!isLiveAccount()) {

        showMessage(
            "Withdrawals are available only on the Live Account.",
            "error"
        );

        return;
    }

    if (!walletData) {

        showMessage(
            "Wallet information is not loaded yet.",
            "error"
        );

        return;
    }

    const balances =
        calculateLiveBalances(
            walletData
        );

    const amount =
        roundMoney(
            document.getElementById(
                "withdrawAmount"
            )?.value
        );

    const method =
        document.getElementById(
            "withdrawMethod"
        )?.value ||
        "mpesa";

    const rawPhone =
        document.getElementById(
            "withdrawPhone"
        )?.value ||
        "";

    if (
        !Number.isFinite(amount) ||
        amount < 0.10
    ) {

        showMessage(
            "Minimum withdrawal amount is $0.10.",
            "error"
        );

        return;
    }

    if (
        amount >
        balances.withdrawableBalance
    ) {

        showMessage(
            `You can withdraw a maximum of ${money(balances.withdrawableBalance)}. Your promotional bonus cannot be withdrawn.`,
            "error"
        );

        return;
    }

    if (
        method !== "mpesa"
    ) {

        showMessage(
            "M-Pesa is currently the available withdrawal method.",
            "error"
        );

        return;
    }

    if (
        !isValidKenyanPhone(rawPhone)
    ) {

        showMessage(
            "Enter a valid Kenyan M-Pesa number.",
            "error"
        );

        return;
    }

    const calculation =
        calculateWithdrawal(
            amount,
            balances.withdrawableBalance
        );

    if (
        calculation.exceedsAvailable
    ) {

        showMessage(
            "Withdrawal amount exceeds your withdrawable balance.",
            "error"
        );

        return;
    }

    const confirmed =
        window.confirm(
            [
                "Confirm withdrawal",
                "",
                `Requested: ${money(amount)}`,
                `Processing fee (10%): ${money(calculation.fee)}`,
                `You receive: ${money(calculation.payout)}`,
                "",
                "Continue?"
            ].join("\n")
        );

    if (!confirmed) {
        return;
    }

    const button =
        document.getElementById(
            "withdrawButton"
        );

    if (button) {
        button.disabled = true;
        button.textContent =
            "Submitting...";
    }

    try {

        const normalizedPhone =
            normalizeKenyanPhone(
                rawPhone
            );

        const result =
            await walletApi(
                "/api/wallet/withdraw",
                {
                    method: "POST",
                    body: JSON.stringify({
                        amount,
                        paymentMethod:
                            method,
                        phoneNumber:
                            normalizedPhone
                    })
                }
            );

        const finalFee =
            numberValue(
                result?.processingFee
            );

        const finalPayout =
            numberValue(
                result?.payoutAmount
            );

        if (
            Number.isFinite(
                finalFee
            ) &&
            Number.isFinite(
                finalPayout
            )
        ) {

            showMessage(
                `Withdrawal request submitted. Fee: ${money(finalFee)}. Amount to receive: ${money(finalPayout)}.`,
                "success"
            );

        } else {

            showMessage(
                result?.message ||
                "Withdrawal request submitted and is awaiting processing.",
                "success"
            );
        }

        const amountInput =
            document.getElementById(
                "withdrawAmount"
            );

        const phoneInput =
            document.getElementById(
                "withdrawPhone"
            );

        if (amountInput) {
            amountInput.value = "";
        }

        if (phoneInput) {
            phoneInput.value = "";
        }

        await loadWallet();

    } catch (error) {

        console.error(
            "handleWithdrawal error:",
            error
        );

        if (
            error?.data?.code ===
            "INSUFFICIENT_WITHDRAWABLE_BALANCE"
        ) {

            showMessage(
                error.data.message ||
                "The requested amount is greater than your withdrawable balance.",
                "error"
            );

        } else {

            showMessage(
                error.message ||
                "Withdrawal request failed.",
                "error"
            );
        }

        await loadWallet(
            true
        );

    } finally {

        if (button) {
            button.disabled = false;
            button.textContent =
                "Request Withdrawal";
        }
    }
}


/* ============================================================
   TRANSACTIONS
============================================================ */

async function loadTransactions(
    silent = false
) {

    try {

        const data =
            await walletApi(
                "/api/wallet/transactions"
            );

        transactions =
            data?.transactions ||
            data?.data?.transactions ||
            data?.data ||
            [];

        if (!Array.isArray(
            transactions
        )) {
            transactions = [];
        }

        renderHistory();

    } catch (error) {

        console.error(
            "loadTransactions error:",
            error
        );

        if (!silent) {

            const historyList =
                document.getElementById(
                    "historyList"
                );

            if (historyList) {

                historyList.innerHTML = `
                    <div class="empty-history">
                        Transaction history is currently unavailable.
                    </div>
                `;
            }
        }
    }
}


/* ============================================================
   HISTORY FILTER
============================================================ */

function matchesHistoryFilter(
    transaction
) {

    if (
        currentHistoryFilter ===
        "all"
    ) {
        return true;
    }

    const type =
        String(
            transaction?.type ||
            transaction?.transaction_type ||
            ""
        ).toLowerCase();

    return type.includes(
        currentHistoryFilter
    );
}


function matchesHistorySearch(
    transaction
) {

    const search =
        String(
            document.getElementById(
                "historySearch"
            )?.value ||
            ""
        )
        .trim()
        .toLowerCase();

    if (!search) {
        return true;
    }

    const text =
        JSON.stringify(
            transaction
        ).toLowerCase();

    return text.includes(
        search
    );
}


function matchesHistoryDate(
    transaction
) {

    const selectedDate =
        document.getElementById(
            "historyDate"
        )?.value ||
        "";

    if (!selectedDate) {
        return true;
    }

    const dateValue =
        transaction?.created_at ||
        transaction?.createdAt ||
        transaction?.date;

    if (!dateValue) {
        return false;
    }

    const date =
        new Date(
            dateValue
        );

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return false;
    }

    const year =
        date.getFullYear();

    const month =
        String(
            date.getMonth() + 1
        ).padStart(2, "0");

    const day =
        String(
            date.getDate()
        ).padStart(2, "0");

    return (
        `${year}-${month}-${day}` ===
        selectedDate
    );
}


function getTransactionAmount(
    transaction
) {

    return numberValue(
        transaction?.amount ??
        transaction?.value ??
        transaction?.payout_amount ??
        0
    );
}


function getTransactionType(
    transaction
) {

    return String(
        transaction?.type ||
        transaction?.transaction_type ||
        "Transaction"
    );
}


function getTransactionStatus(
    transaction
) {

    return String(
        transaction?.status ||
        "unknown"
    );
}


function formatTransactionDate(
    transaction
) {

    const value =
        transaction?.created_at ||
        transaction?.createdAt ||
        transaction?.date;

    if (!value) {
        return "";
    }

    const date =
        new Date(value);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return "";
    }

    return date.toLocaleString();
}


/* ============================================================
   RENDER HISTORY
============================================================ */

function renderHistory() {

    const list =
        document.getElementById(
            "historyList"
        );

    if (!list) {
        return;
    }

    const filtered =
        transactions.filter(
            transaction =>
                matchesHistoryFilter(
                    transaction
                ) &&
                matchesHistorySearch(
                    transaction
                ) &&
                matchesHistoryDate(
                    transaction
                )
        );

    if (!filtered.length) {

        list.innerHTML = `
            <div class="empty-history">
                No transactions found.
            </div>
        `;

        return;
    }

    list.innerHTML =
        filtered
            .map(
                transaction =>
                    renderTransactionItem(
                        transaction
                    )
            )
            .join("");

    list
        .querySelectorAll(
            "[data-transaction-index]"
        )
        .forEach(
            element => {

                element.addEventListener(
                    "click",
                    () => {

                        const index =
                            Number(
                                element.dataset
                                    .transactionIndex
                            );

                        const transaction =
                            filtered[index];

                        openTransactionModal(
                            transaction
                        );
                    }
                );
            }
        );
}


function renderTransactionItem(
    transaction
) {

    const type =
        getTransactionType(
            transaction
        );

    const status =
        getTransactionStatus(
            transaction
        );

    const amount =
        getTransactionAmount(
            transaction
        );

    const date =
        formatTransactionDate(
            transaction
        );

    const statusLower =
        status.toLowerCase();

    let amountPrefix = "";

    if (
        type
            .toLowerCase()
            .includes("deposit")
    ) {
        amountPrefix = "+";
    }

    if (
        type
            .toLowerCase()
            .includes("withdraw")
    ) {
        amountPrefix = "-";
    }

    return `
        <div
            class="history-item"
            data-transaction-index="${escapeHtml(
                String(
                    transactions.indexOf(
                        transaction
                    )
                )
            )}"
            style="cursor:pointer;"
        >

            <div class="history-left">

                <div class="history-type">
                    ${escapeHtml(type)}
                </div>

                <div class="history-date-text">
                    ${escapeHtml(date)}
                </div>

            </div>

            <div class="history-right">

                <div class="history-amount">
                    ${amountPrefix}${money(amount)}
                </div>

                <div class="history-status">
                    ${escapeHtml(status)}
                </div>

            </div>

        </div>
    `;
}


/* ============================================================
   ESCAPE HTML
============================================================ */

function escapeHtml(value) {

    return String(
        value ?? ""
    )
        .replace(
            /&/g,
            "&amp;"
        )
        .replace(
            /</g,
            "&lt;"
        )
        .replace(
            />/g,
            "&gt;"
        )
        .replace(
            /"/g,
            "&quot;"
        )
        .replace(
            /'/g,
            "&#039;"
        );
}


/* ============================================================
   TRANSACTION MODAL
============================================================ */

function openTransactionModal(
    transaction
) {

    const modal =
        document.getElementById(
            "transactionModal"
        );

    const details =
        document.getElementById(
            "transactionDetails"
        );

    if (!modal || !details) {
        return;
    }

    const type =
        getTransactionType(
            transaction
        );

    const status =
        getTransactionStatus(
            transaction
        );

    const amount =
        getTransactionAmount(
            transaction
        );

    const date =
        formatTransactionDate(
            transaction
        );

    const reference =
        transaction?.reference ||
        transaction?.transaction_id ||
        transaction?.transactionId ||
        transaction?.id ||
        "-";

    const fee =
        transaction?.processing_fee;

    const payout =
        transaction?.payout_amount;

    let html = `

        <div class="detail-row">
            <span class="detail-label">
                Type
            </span>

            <span class="detail-value">
                ${escapeHtml(type)}
            </span>
        </div>

        <div class="detail-row">
            <span class="detail-label">
                Amount
            </span>

            <span class="detail-value">
                ${money(amount)}
            </span>
        </div>

        <div class="detail-row">
            <span class="detail-label">
                Status
            </span>

            <span class="detail-value">
                ${escapeHtml(status)}
            </span>
        </div>

        <div class="detail-row">
            <span class="detail-label">
                Date
            </span>

            <span class="detail-value">
                ${escapeHtml(date)}
            </span>
        </div>

        <div class="detail-row">
            <span class="detail-label">
                Reference
            </span>

            <span class="detail-value">
                ${escapeHtml(reference)}
            </span>
        </div>
    `;

    if (
        fee !== undefined &&
        fee !== null
    ) {

        html += `

            <div class="detail-row">

                <span class="detail-label">
                    Processing Fee
                </span>

                <span class="detail-value">
                    ${money(fee)}
                </span>

            </div>
        `;
    }

    if (
        payout !== undefined &&
        payout !== null
    ) {

        html += `

            <div class="detail-row">

                <span class="detail-label">
                    Amount Received
                </span>

                <span class="detail-value">
                    ${money(payout)}
                </span>

            </div>
        `;
    }

    details.innerHTML =
        html;

    modal.classList.add(
        "show"
    );
}


function closeTransactionModal() {

    const modal =
        document.getElementById(
            "transactionModal"
        );

    if (modal) {
        modal.classList.remove(
            "show"
        );
    }
}


/* ============================================================
   ACCOUNT SWITCH
============================================================ */

async function switchAccount() {

    const current =
        getAccountMode();

    const next =
        current === "demo"
            ? "live"
            : "demo";

    setAccountMode(
        next
    );

    updateAccountUI();

    clearMessage();

    await loadWallet();

    window.dispatchEvent(
        new CustomEvent(
            "kmfAccountChanged",
            {
                detail: {
                    mode: next
                }
            }
        )
    );
}


/* ============================================================
   VERIFICATION BUTTON
============================================================ */

function openVerification() {

    window.location.href =
        "verification.html";
}


/* ============================================================
   REFRESH
============================================================ */

function startWalletRefresh() {

    if (walletRefreshTimer) {
        clearInterval(
            walletRefreshTimer
        );
    }

    walletRefreshTimer =
        setInterval(
            async () => {

                await loadWallet(
                    true
                );

            },
            WALLET_REFRESH_INTERVAL
        );
}


/* ============================================================
   STORAGE / ACCOUNT EVENTS
============================================================ */

window.addEventListener(
    "storage",
    async event => {

        if (
            event.key ===
            "kmf_account_mode"
        ) {

            updateAccountUI();

            await loadWallet(
                true
            );
        }
    }
);


window.addEventListener(
    "kmfAccountChanged",
    async () => {

        updateAccountUI();

        await loadWallet(
            true
        );
    }
);


/* ============================================================
   EVENT LISTENERS
============================================================ */

function setupWalletEvents() {

    const switchButton =
        document.getElementById(
            "switchAccountButton"
        );

    if (switchButton) {

        switchButton.addEventListener(
            "click",
            switchAccount
        );
    }


    const depositForm =
        document.getElementById(
            "depositForm"
        );

    if (depositForm) {

        depositForm.addEventListener(
            "submit",
            handleDeposit
        );
    }


    const withdrawalForm =
        document.getElementById(
            "withdrawalForm"
        );

    if (withdrawalForm) {

        withdrawalForm.addEventListener(
            "submit",
            handleWithdrawal
        );
    }


    const depositMethod =
        document.getElementById(
            "depositMethod"
        );

    if (depositMethod) {

        depositMethod.addEventListener(
            "change",
            updateMpesaField
        );
    }


    const withdrawalMethod =
        document.getElementById(
            "withdrawMethod"
        );

    if (withdrawalMethod) {

        withdrawalMethod.addEventListener(
            "change",
            updateWithdrawPhoneField
        );
    }


    const withdrawalAmount =
        document.getElementById(
            "withdrawAmount"
        );

    if (withdrawalAmount) {

        withdrawalAmount.addEventListener(
            "input",
            handleWithdrawalAmountInput
        );

        withdrawalAmount.addEventListener(
            "change",
            handleWithdrawalAmountInput
        );
    }


    const verificationButton =
        document.getElementById(
            "openVerificationButton"
        );

    if (verificationButton) {

        verificationButton.addEventListener(
            "click",
            openVerification
        );
    }


    document
        .querySelectorAll(
            "[data-history-filter]"
        )
        .forEach(
            button => {

                button.addEventListener(
                    "click",
                    () => {

                        document
                            .querySelectorAll(
                                "[data-history-filter]"
                            )
                            .forEach(
                                item =>
                                    item.classList.remove(
                                        "active"
                                    )
                            );

                        button.classList.add(
                            "active"
                        );

                        currentHistoryFilter =
                            button.dataset
                                .historyFilter ||
                            "all";

                        renderHistory();
                    }
                );
            }
        );


    const historySearch =
        document.getElementById(
            "historySearch"
        );

    if (historySearch) {

        historySearch.addEventListener(
            "input",
            renderHistory
        );
    }


    const historyDate =
        document.getElementById(
            "historyDate"
        );

    if (historyDate) {

        historyDate.addEventListener(
            "change",
            renderHistory
        );
    }


    const closeModal =
        document.getElementById(
            "closeTransactionModal"
        );

    if (closeModal) {

        closeModal.addEventListener(
            "click",
            closeTransactionModal
        );
    }


    const modal =
        document.getElementById(
            "transactionModal"
        );

    if (modal) {

        modal.addEventListener(
            "click",
            event => {

                if (
                    event.target ===
                    modal
                ) {

                    closeTransactionModal();
                }
            }
        );
    }
}


/* ============================================================
   INITIALIZE
============================================================ */

async function initializeWallet() {

    try {

        updateAccountUI();

        setupWalletEvents();

        updateMpesaField();

        updateWithdrawPhoneField();

        await loadWallet();

        startWalletRefresh();

    } catch (error) {

        console.error(
            "initializeWallet error:",
            error
        );

        showMessage(
            "Unable to initialize wallet.",
            "error"
        );
    }
}


/* ============================================================
   START
============================================================ */

if (
    document.readyState ===
    "loading"
) {

    document.addEventListener(
        "DOMContentLoaded",
        initializeWallet
    );

} else {

    initializeWallet();
}