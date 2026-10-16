"use strict";

const crypto = require("crypto");
const supabase = require("./supabase");

function registerAdminRoutes(app, authenticateUser) {

    // ==========================================
    // ROLE HELPERS
    // ==========================================

    const VALID_ROLES = [
        "user",
        "admin",
        "super_admin",
        "owner"
    ];

    function normalizeRole(role) {
        return String(role || "")
            .trim()
            .toLowerCase();
    }

    function isAdminRole(role) {
        return [
            "admin",
            "super_admin",
            "owner"
        ].includes(normalizeRole(role));
    }

    function isSuperAdminRole(role) {
        return [
            "super_admin",
            "owner"
        ].includes(normalizeRole(role));
    }

    function isOwnerRole(role) {
        return normalizeRole(role) === "owner";
    }

    function generateReference(prefix) {
        return `${prefix}-${crypto.randomUUID()}`;
    }

    function parsePositiveAmount(value) {

        const amount = Number(value);

        if (!Number.isFinite(amount)) {
            return null;
        }

        if (amount <= 0) {
            return null;
        }

        return Number(
            amount.toFixed(6)
        );
    }

    function parseNonNegativeAmount(value) {

        const amount = Number(value);

        if (!Number.isFinite(amount)) {
            return null;
        }

        if (amount < 0) {
            return null;
        }

        return Number(
            amount.toFixed(6)
        );
    }


    // ==========================================
    // GET ADMIN PROFILE
    // ==========================================

    async function getAdminProfile(userId) {

        if (!userId) {
            return {
                profile: null,
                error: new Error("User ID is missing")
            };
        }

        const {
            data: profile,
            error
        } = await supabase
            .from("profiles")
            .select(
                "id, username, full_name, country, role"
            )
            .eq("id", userId)
            .maybeSingle();

        return {
            profile,
            error
        };
    }


    // ==========================================
    // LOAD ADMIN CONTEXT
    // ==========================================

    async function loadAdminContext(req, res) {

        if (
            !req.user ||
            !req.user.id
        ) {
            res.status(401).json({
                success: false,
                message: "Authentication required"
            });

            return false;
        }

        const {
            profile,
            error
        } = await getAdminProfile(
            req.user.id
        );

        if (error) {

            console.error(
                "Admin profile check error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to verify admin access"
            });

            return false;
        }

        const role =
            normalizeRole(
                profile && profile.role
            );

        if (
            !profile ||
            !isAdminRole(role)
        ) {

            res.status(403).json({
                success: false,
                message: "Admin access denied"
            });

            return false;
        }

        req.adminProfile = profile;
        req.adminRole = role;

        req.isAdmin =
            role === "admin";

        req.isSuperAdmin =
            isSuperAdminRole(role);

        req.isOwner =
            isOwnerRole(role);

        return true;
    }


    // ==========================================
    // ADMIN AUTHORIZATION
    // ==========================================

    async function requireAdmin(
        req,
        res,
        next
    ) {

        try {

            const allowed =
                await loadAdminContext(
                    req,
                    res
                );

            if (!allowed) {
                return;
            }

            next();

        }

        catch (error) {

            console.error(
                "Admin authorization error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Unable to verify admin access"
            });
        }
    }


    // ==========================================
    // SUPER ADMIN AUTHORIZATION
    // ==========================================

    async function requireSuperAdmin(
        req,
        res,
        next
    ) {

        try {

            const allowed =
                await loadAdminContext(
                    req,
                    res
                );

            if (!allowed) {
                return;
            }

            if (!req.isSuperAdmin) {

                return res.status(403).json({
                    success: false,
                    message:
                        "Super Admin access required"
                });
            }

            next();

        }

        catch (error) {

            console.error(
                "Super Admin authorization error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Unable to verify Super Admin access"
            });
        }
    }


    // ==========================================
    // OWNER AUTHORIZATION
    // ==========================================

    async function requireOwner(
        req,
        res,
        next
    ) {

        try {

            const allowed =
                await loadAdminContext(
                    req,
                    res
                );

            if (!allowed) {
                return;
            }

            if (!req.isOwner) {

                return res.status(403).json({
                    success: false,
                    message:
                        "Owner access required"
                });
            }

            next();

        }

        catch (error) {

            console.error(
                "Owner authorization error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Unable to verify Owner access"
            });
        }
    }


    // ==========================================
    // ADMIN AUTH TEST
    // ==========================================

    app.get(
        "/api/admin/me",
        authenticateUser,
        requireAdmin,
        async (req, res) => {

            return res.json({

                success: true,

                admin: {

                    id:
                        req.user.id,

                    email:
                        req.user.email,

                    profile:
                        req.adminProfile,

                    role:
                        req.adminRole,

                    permissions: {

                        viewDashboard: true,
                        viewUsers: true,
                        viewWallets: true,
                        viewTrades: true,
                        viewTransactions: true,
                        viewFinance: true,
                        viewDeposits: true,
                        viewWithdrawals: true,
                        viewMarkets: true,

                        manageMarkets: true,

                        manageWalletBalances:
                            req.isOwner,

                        approveDeposits:
                            req.isOwner,

                        forceWithdrawals:
                            req.isOwner,

                        modifySettledTrades:
                            req.isOwner,

                        changeAdminRoles:
                            req.isSuperAdmin,

                        manageSuperAdmins:
                            req.isOwner,

                        manageOwner: false
                    }
                }
            });
        }
    );


    // ==========================================
    // ADMIN DASHBOARD
    // ==========================================

    app.get(
        "/api/admin/dashboard",
        authenticateUser,
        requireAdmin,
        async (req, res) => {

            try {

                const [
                    usersResult,
                    walletsResult,
                    tradesResult,
                    pendingDepositsResult,
                    pendingWithdrawalsResult,
                    marketsResult
                ] = await Promise.all([

                    supabase
                        .from("profiles")
                        .select(
                            "id",
                            {
                                count: "exact",
                                head: true
                            }
                        ),

                    supabase
                        .from("wallets")
                        .select(
                            "id",
                            {
                                count: "exact",
                                head: true
                            }
                        ),

                    supabase
                        .from("trades")
                        .select(
                            "id",
                            {
                                count: "exact",
                                head: true
                            }
                        ),

                    supabase
                        .from("wallet_transactions")
                        .select(
                            "id",
                            {
                                count: "exact",
                                head: true
                            }
                        )
                        .eq(
                            "transaction_type",
                            "deposit"
                        )
                        .eq(
                            "status",
                            "pending"
                        ),

                    supabase
                        .from("wallet_transactions")
                        .select(
                            "id",
                            {
                                count: "exact",
                                head: true
                            }
                        )
                        .eq(
                            "transaction_type",
                            "withdrawal"
                        )
                        .eq(
                            "status",
                            "pending"
                        ),

                    supabase
                        .from("markets")
                        .select(
                            "id, symbol, market_name, contract_type, is_active"
                        )
                        .order("symbol")
                ]);


                const errors = [
                    usersResult.error,
                    walletsResult.error,
                    tradesResult.error,
                    pendingDepositsResult.error,
                    pendingWithdrawalsResult.error,
                    marketsResult.error
                ].filter(Boolean);


                if (errors.length) {

                    console.error(
                        "Admin dashboard database errors:",
                        errors
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Unable to load dashboard"
                    });
                }


                return res.json({

                    success: true,

                    adminRole:
                        req.adminRole,

                    stats: {

                        users:
                            usersResult.count || 0,

                        wallets:
                            walletsResult.count || 0,

                        trades:
                            tradesResult.count || 0,

                        pendingDeposits:
                            pendingDepositsResult.count || 0,

                        pendingWithdrawals:
                            pendingWithdrawalsResult.count || 0
                    },

                    markets:
                        marketsResult.data || []
                });

            }

            catch (error) {

                console.error(
                    "Admin dashboard error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to load admin dashboard"
                });
            }
        }
    );


    // ==========================================
    // USERS
    // ==========================================

    app.get(
        "/api/admin/users",
        authenticateUser,
        requireAdmin,
        async (req, res) => {

            try {

                const limit =
                    Math.min(
                        Math.max(
                            Number(
                                req.query.limit
                            ) || 100,
                            1
                        ),
                        500
                    );

                const offset =
                    Math.max(
                        Number(
                            req.query.offset
                        ) || 0,
                        0
                    );

                const {
                    data: profiles,
                    error: profileError,
                    count
                } = await supabase
                    .from("profiles")
                    .select(
                        "id, username, full_name, country, role, created_at",
                        {
                            count: "exact"
                        }
                    )
                    .order(
                        "created_at",
                        {
                            ascending: false
                        }
                    )
                    .range(
                        offset,
                        offset + limit - 1
                    );

                if (profileError) {

                    console.error(
                        "Admin users error:",
                        profileError
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Unable to load users"
                    });
                }

                const userIds =
                    (profiles || []).map(
                        user => user.id
                    );

                let wallets = [];

                if (userIds.length) {

                    const {
                        data,
                        error
                    } = await supabase
                        .from("wallets")
                        .select(
                            "id, user_id, balance, demo_balance, currency, updated_at"
                        )
                        .in(
                            "user_id",
                            userIds
                        );

                    if (!error) {
                        wallets =
                            data || [];
                    }
                }

                const walletMap = {};

                wallets.forEach(
                    wallet => {
                        walletMap[
                            wallet.user_id
                        ] = wallet;
                    }
                );

                const users =
                    (profiles || []).map(
                        user => ({
                            ...user,
                            wallet:
                                walletMap[
                                    user.id
                                ] || null
                        })
                    );

                return res.json({

                    success: true,

                    users,

                    total:
                        count || 0,

                    offset,

                    limit
                });

            }

            catch (error) {

                console.error(
                    "Admin users exception:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to load users"
                });
            }
        }
    );


    // ==========================================
    // ROLE MANAGEMENT
    // ==========================================

    app.patch(
        "/api/admin/users/:id/role",
        authenticateUser,
        requireAdmin,
        async (req, res) => {

            try {

                const targetUserId =
                    String(
                        req.params.id || ""
                    ).trim();

                const requestedRole =
                    normalizeRole(
                        req.body &&
                        req.body.role
                    );

                if (!targetUserId) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "Target user ID is required"
                    });
                }

                if (
                    !VALID_ROLES.includes(
                        requestedRole
                    )
                ) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "Invalid role. Allowed roles: user, admin, super_admin, owner"
                    });
                }

                if (
                    targetUserId ===
                    req.user.id
                ) {

                    return res.status(403).json({
                        success: false,
                        message:
                            "You cannot change your own role"
                    });
                }

                const {
                    data: targetProfile,
                    error: targetError
                } = await supabase
                    .from("profiles")
                    .select(
                        "id, username, full_name, country, role"
                    )
                    .eq(
                        "id",
                        targetUserId
                    )
                    .maybeSingle();

                if (targetError) {

                    console.error(
                        "Target profile lookup error:",
                        targetError
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Unable to load target user"
                    });
                }

                if (!targetProfile) {

                    return res.status(404).json({
                        success: false,
                        message:
                            "Target user not found"
                    });
                }

                const currentTargetRole =
                    normalizeRole(
                        targetProfile.role
                    );

                if (
                    currentTargetRole ===
                    "owner"
                ) {

                    return res.status(403).json({
                        success: false,
                        message:
                            "The Owner account cannot be modified"
                    });
                }

                if (
                    requestedRole ===
                    "owner"
                ) {

                    return res.status(403).json({
                        success: false,
                        message:
                            "Owner role cannot be assigned through this route"
                    });
                }

                if (
                    req.adminRole ===
                    "admin"
                ) {

                    return res.status(403).json({
                        success: false,
                        message:
                            "Admin role management is not permitted"
                    });
                }

                if (
                    req.adminRole ===
                    "super_admin"
                ) {

                    if (
                        currentTargetRole ===
                        "super_admin"
                    ) {

                        return res.status(403).json({
                            success: false,
                            message:
                                "Super Admin cannot modify another Super Admin"
                        });
                    }

                    if (
                        requestedRole !==
                            "admin" &&
                        requestedRole !==
                            "user"
                    ) {

                        return res.status(403).json({
                            success: false,
                            message:
                                "Super Admin can only assign admin or user roles"
                        });
                    }
                }

                if (
                    req.adminRole ===
                    "owner"
                ) {

                    if (
                        requestedRole ===
                        "owner"
                    ) {

                        return res.status(403).json({
                            success: false,
                            message:
                                "Owner role cannot be assigned"
                        });
                    }
                }

                if (
                    currentTargetRole ===
                    requestedRole
                ) {

                    return res.status(400).json({
                        success: false,
                        message:
                            `User already has the ${requestedRole} role`
                    });
                }

                const {
                    data: updatedProfile,
                    error: updateError
                } = await supabase
                    .from("profiles")
                    .update({
                        role:
                            requestedRole
                    })
                    .eq(
                        "id",
                        targetUserId
                    )
                    .select(
                        "id, username, full_name, country, role, created_at"
                    )
                    .single();

                if (updateError) {

                    console.error(
                        "Admin role update error:",
                        updateError
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Unable to update user role"
                    });
                }

                console.log(
                    `ADMIN ROLE CHANGE: ${req.user.id} changed ${targetUserId} from ${currentTargetRole} to ${requestedRole}`
                );

                return res.json({

                    success: true,

                    message:
                        `User role changed from ${currentTargetRole} to ${requestedRole}`,

                    user:
                        updatedProfile,

                    changedBy: {
                        id:
                            req.user.id,

                        role:
                            req.adminRole
                    }
                });

            }

            catch (error) {

                console.error(
                    "Admin role management exception:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to change user role"
                });
            }
        }
    );


    // ==========================================
    // WALLETS
    // ==========================================

    app.get(
        "/api/admin/wallets",
        authenticateUser,
        requireAdmin,
        async (req, res) => {

            try {

                const {
                    data,
                    error
                } = await supabase
                    .from("wallets")
                    .select("*")
                    .order(
                        "updated_at",
                        {
                            ascending: false
                        }
                    );

                if (error) {

                    console.error(
                        "Admin wallets error:",
                        error
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Unable to load wallets"
                    });
                }

                return res.json({
                    success: true,
                    wallets:
                        data || []
                });

            }

            catch (error) {

                console.error(
                    "Admin wallets exception:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to load wallets"
                });
            }
        }
    );


    // ==========================================
    // TRADES
    // ==========================================

    app.get(
        "/api/admin/trades",
        authenticateUser,
        requireAdmin,
        async (req, res) => {

            try {

                const limit =
                    Math.min(
                        Math.max(
                            Number(
                                req.query.limit
                            ) || 100,
                            1
                        ),
                        500
                    );

                const {
                    data,
                    error
                } = await supabase
                    .from("trades")
                    .select("*")
                    .order(
                        "created_at",
                        {
                            ascending: false
                        }
                    )
                    .limit(limit);

                if (error) {

                    console.error(
                        "Admin trades error:",
                        error
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Unable to load trades"
                    });
                }

                return res.json({
                    success: true,
                    trades:
                        data || []
                });

            }

            catch (error) {

                console.error(
                    "Admin trades exception:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to load trades"
                });
            }
        }
    );


    // ==========================================
    // TRANSACTIONS
    // ==========================================

    app.get(
        "/api/admin/transactions",
        authenticateUser,
        requireAdmin,
        async (req, res) => {

            try {

                const limit =
                    Math.min(
                        Math.max(
                            Number(
                                req.query.limit
                            ) || 100,
                            1
                        ),
                        500
                    );

                const {
                    data,
                    error
                } = await supabase
                    .from("wallet_transactions")
                    .select("*")
                    .order(
                        "created_at",
                        {
                            ascending: false
                        }
                    )
                    .limit(limit);

                if (error) {

                    console.error(
                        "Admin transactions error:",
                        error
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Unable to load transactions"
                    });
                }

                return res.json({
                    success: true,
                    transactions:
                        data || []
                });

            }

            catch (error) {

                console.error(
                    "Admin transactions exception:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to load transactions"
                });
            }
        }
    );
// ============================================================
// PROMOTIONS & BONUSES
// ============================================================

// GET ALL PROMOTIONS
app.get(
    "/api/admin/promotions",
    authenticateUser,
    requireAdmin,
    async (req, res) => {
        try {
            const { data, error } = await supabase
                .from("promotions")
                .select("*")
                .order("id", { ascending: true });

            if (error) {
                console.error("Admin promotions error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Failed to load promotions"
                });
            }

            return res.json({
                success: true,
                promotions: data || []
            });

        } catch (error) {
            console.error("Admin promotions exception:", error);

            return res.status(500).json({
                success: false,
                message: "Failed to load promotions"
            });
        }
    }
);


// GET SINGLE PROMOTION
app.get(
    "/api/admin/promotions/:id",
    authenticateUser,
    requireAdmin,
    async (req, res) => {
        try {
            const promotionId = Number(req.params.id);

            if (!Number.isInteger(promotionId) || promotionId <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid promotion ID"
                });
            }

            const { data, error } = await supabase
                .from("promotions")
                .select("*")
                .eq("id", promotionId)
                .maybeSingle();

            if (error) {
                console.error("Get promotion error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Failed to load promotion"
                });
            }

            if (!data) {
                return res.status(404).json({
                    success: false,
                    message: "Promotion not found"
                });
            }

            return res.json({
                success: true,
                promotion: data
            });

        } catch (error) {
            console.error("Get promotion exception:", error);

            return res.status(500).json({
                success: false,
                message: "Failed to load promotion"
            });
        }
    }
);


// UPDATE PROMOTION
app.patch(
    "/api/admin/promotions/:id",
    authenticateUser,
    requireAdmin,
    async (req, res) => {
        try {
            const promotionId = Number(req.params.id);

            if (!Number.isInteger(promotionId) || promotionId <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid promotion ID"
                });
            }

            const {
                name,
                bonus_percent,
                min_deposit,
                max_bonus,
                active,
                start_at,
                expires_at
            } = req.body || {};

            const updates = {};

            // NAME
            if (name !== undefined) {
                if (
                    typeof name !== "string" ||
                    name.trim().length < 2
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid promotion name"
                    });
                }

                updates.name = name.trim();
            }

            // BONUS PERCENT
            if (bonus_percent !== undefined) {
                const percent = Number(bonus_percent);

                if (
                    !Number.isFinite(percent) ||
                    percent < 0 ||
                    percent > 100
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Bonus percentage must be between 0 and 100"
                    });
                }

                updates.bonus_percent = Number(
                    percent.toFixed(2)
                );
            }

            // MINIMUM DEPOSIT
            if (min_deposit !== undefined) {
                const minimum = Number(min_deposit);

                if (
                    !Number.isFinite(minimum) ||
                    minimum < 0
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Minimum deposit cannot be negative"
                    });
                }

                updates.min_deposit = Number(
                    minimum.toFixed(2)
                );
            }

            // MAXIMUM BONUS
            if (max_bonus !== undefined) {

                if (
                    max_bonus === null ||
                    max_bonus === ""
                ) {
                    updates.max_bonus = null;
                } else {
                    const maximum = Number(max_bonus);

                    if (
                        !Number.isFinite(maximum) ||
                        maximum < 0
                    ) {
                        return res.status(400).json({
                            success: false,
                            message:
                                "Maximum bonus must be zero or greater"
                        });
                    }

                    updates.max_bonus = Number(
                        maximum.toFixed(2)
                    );
                }
            }

            // ACTIVE / INACTIVE
            if (active !== undefined) {
                if (typeof active !== "boolean") {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Active value must be true or false"
                    });
                }

                updates.active = active;
            }

            // START DATE
            if (start_at !== undefined) {

                if (
                    start_at === null ||
                    start_at === ""
                ) {
                    updates.start_at = null;
                } else {
                    const startDate = new Date(start_at);

                    if (Number.isNaN(startDate.getTime())) {
                        return res.status(400).json({
                            success: false,
                            message: "Invalid start date"
                        });
                    }

                    updates.start_at =
                        startDate.toISOString();
                }
            }

            // EXPIRY DATE
            if (expires_at !== undefined) {

                if (
                    expires_at === null ||
                    expires_at === ""
                ) {
                    updates.expires_at = null;
                } else {
                    const expiryDate = new Date(expires_at);

                    if (Number.isNaN(expiryDate.getTime())) {
                        return res.status(400).json({
                            success: false,
                            message: "Invalid expiry date"
                        });
                    }

                    updates.expires_at =
                        expiryDate.toISOString();
                }
            }

            // NOTHING TO UPDATE
            if (Object.keys(updates).length === 0) {
                return res.status(400).json({
                    success: false,
                    message: "No valid changes supplied"
                });
            }

            // CHECK CURRENT PROMOTION
            const { data: existingPromotion, error: findError } =
                await supabase
                    .from("promotions")
                    .select("*")
                    .eq("id", promotionId)
                    .maybeSingle();

            if (findError) {
                console.error(
                    "Find promotion error:",
                    findError
                );

                return res.status(500).json({
                    success: false,
                    message: "Failed to find promotion"
                });
            }

            if (!existingPromotion) {
                return res.status(404).json({
                    success: false,
                    message: "Promotion not found"
                });
            }

            // VALIDATE MAX BONUS AGAINST REQUESTED VALUES
            const finalMinDeposit =
                updates.min_deposit !== undefined
                    ? updates.min_deposit
                    : Number(existingPromotion.min_deposit || 0);

            const finalMaxBonus =
                updates.max_bonus !== undefined
                    ? updates.max_bonus
                    : existingPromotion.max_bonus;

            if (
                finalMaxBonus !== null &&
                finalMaxBonus !== undefined &&
                Number(finalMaxBonus) < 0
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Maximum bonus cannot be negative"
                });
            }

            // VALIDATE DATES
            const finalStart =
                updates.start_at !== undefined
                    ? updates.start_at
                    : existingPromotion.start_at;

            const finalExpiry =
                updates.expires_at !== undefined
                    ? updates.expires_at
                    : existingPromotion.expires_at;

            if (finalStart && finalExpiry) {
                const startTime =
                    new Date(finalStart).getTime();

                const expiryTime =
                    new Date(finalExpiry).getTime();

                if (expiryTime < startTime) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Expiry date cannot be before start date"
                    });
                }
            }

            updates.updated_at = new Date().toISOString();

            const { data, error } = await supabase
                .from("promotions")
                .update(updates)
                .eq("id", promotionId)
                .select()
                .single();

            if (error) {
                console.error(
                    "Update promotion error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message: "Failed to update promotion"
                });
            }

            return res.json({
                success: true,
                message: "Promotion updated successfully",
                promotion: data
            });

        } catch (error) {
            console.error(
                "Update promotion exception:",
                error
            );

            return res.status(500).json({
                success: false,
                message: "Failed to update promotion"
            });
        }
    }
);


// QUICK ACTIVATE / DEACTIVATE
app.patch(
    "/api/admin/promotions/:id/status",
    authenticateUser,
    requireAdmin,
    async (req, res) => {
        try {
            const promotionId = Number(req.params.id);
            const { active } = req.body || {};

            if (!Number.isInteger(promotionId) || promotionId <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid promotion ID"
                });
            }

            if (typeof active !== "boolean") {
                return res.status(400).json({
                    success: false,
                    message:
                        "Active value must be true or false"
                });
            }

            const { data: promotion, error: findError } =
                await supabase
                    .from("promotions")
                    .select("*")
                    .eq("id", promotionId)
                    .maybeSingle();

            if (findError) {
                console.error(
                    "Promotion status lookup error:",
                    findError
                );

                return res.status(500).json({
                    success: false,
                    message: "Failed to find promotion"
                });
            }

            if (!promotion) {
                return res.status(404).json({
                    success: false,
                    message: "Promotion not found"
                });
            }

            // Prevent activating an already-expired promotion
            if (active && promotion.expires_at) {
                const expiry =
                    new Date(promotion.expires_at).getTime();

                if (
                    Number.isFinite(expiry) &&
                    expiry < Date.now()
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "This promotion has already expired. Update the expiry date first."
                    });
                }
            }

            const { data, error } = await supabase
                .from("promotions")
                .update({
                    active,
                    updated_at: new Date().toISOString()
                })
                .eq("id", promotionId)
                .select()
                .single();

            if (error) {
                console.error(
                    "Promotion status update error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Failed to change promotion status"
                });
            }

            return res.json({
                success: true,
                message: active
                    ? "Promotion activated successfully"
                    : "Promotion deactivated successfully",
                promotion: data
            });

        } catch (error) {
            console.error(
                "Promotion status exception:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Failed to change promotion status"
            });
        }
    }
);


// ============================================================
// USER BONUS RECORDS
// ============================================================

// GET BONUS HISTORY
app.get(
    "/api/admin/user-bonuses",
    authenticateUser,
    requireAdmin,
    async (req, res) => {
        try {
            const limit = Math.min(
                Math.max(Number(req.query.limit) || 100, 1),
                500
            );

            const { data, error } = await supabase
                .from("user_bonuses")
                .select(`
                    *,
                    promotions (
                        id,
                        name,
                        type,
                        bonus_percent
                    )
                `)
                .order("id", { ascending: false })
                .limit(limit);

            if (error) {
                console.error(
                    "User bonuses error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Failed to load bonus records"
                });
            }

            return res.json({
                success: true,
                bonuses: data || []
            });

        } catch (error) {
            console.error(
                "User bonuses exception:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Failed to load bonus records"
            });
        }
    }
);


// GET BONUSES FOR A SPECIFIC USER
app.get(
    "/api/admin/users/:id/bonuses",
    authenticateUser,
    requireAdmin,
    async (req, res) => {
        try {
            const userId = String(req.params.id || "").trim();

            if (!userId) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid user ID"
                });
            }

            const { data, error } = await supabase
                .from("user_bonuses")
                .select(`
                    *,
                    promotions (
                        id,
                        name,
                        type,
                        bonus_percent,
                        min_deposit,
                        max_bonus
                    )
                `)
                .eq("user_id", userId)
                .order("id", { ascending: false });

            if (error) {
                console.error(
                    "User-specific bonuses error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Failed to load user bonuses"
                });
            }

            return res.json({
                success: true,
                bonuses: data || []
            });

        } catch (error) {
            console.error(
                "User-specific bonuses exception:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Failed to load user bonuses"
            });
        }
    }
);


// ============================================================
// REFERRAL COMMISSION SETTINGS
// ============================================================

// GET CURRENT REFERRAL SETTINGS
app.get(
    "/api/admin/referral-settings",
    authenticateUser,
    requireAdmin,
    async (req, res) => {
        try {
            const { data, error } = await supabase
                .from("referral_settings")
                .select("id, commission_percent, minimum_deposit, updated_at")
                .eq("id", 1)
                .maybeSingle();

            if (error) {
                console.error("Referral settings lookup error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to load referral settings"
                });
            }

            if (!data) {
                return res.status(404).json({
                    success: false,
                    message: "Referral settings have not been configured"
                });
            }

            return res.json({
                success: true,
                settings: data
            });

        } catch (error) {
            console.error("Referral settings exception:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to load referral settings"
            });
        }
    }
);


// UPDATE REFERRAL COMMISSION RATE
app.patch(
    "/api/admin/referral-settings",
    authenticateUser,
    requireAdmin,
    async (req, res) => {
        try {
            // Only the Owner can change the commission rate.
            if (!req.isOwner) {
                return res.status(403).json({
                    success: false,
                    message: "Only the Owner can change referral settings"
                });
            }

            const percent = Number(
                req.body && req.body.commission_percent
            );

            if (![5, 10].includes(percent)) {
                return res.status(400).json({
                    success: false,
                    message: "Commission must be either 5% or 10%"
                });
            }

            const { data, error } = await supabase
                .from("referral_settings")
                .update({
                    commission_percent: percent,
                    minimum_deposit: 8,
                    updated_at: new Date().toISOString()
                })
                .eq("id", 1)
                .select("id, commission_percent, minimum_deposit, updated_at")
                .single();

            if (error) {
                console.error("Referral settings update error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to save referral settings"
                });
            }

            console.log(
                `REFERRAL SETTINGS: ${req.user.id} set commission to ${percent}%`
            );

            return res.json({
                success: true,
                message: `Referral commission updated to ${percent}%`,
                settings: data
            });

        } catch (error) {
            console.error("Referral settings update exception:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to save referral settings"
            });
        }
    }
);


 // ============================================================
 // REFERRAL COMMISSION SETTINGS
 // ============================================================

 // GET REFERRAL SETTINGS
 app.get(
     "/api/admin/referral-settings",
     authenticateUser,
     requireAdmin,
     async (req, res) => {
         try {
             const { data, error } = await supabase
                 .from("referral_settings")
                 .select("id, commission_percent, minimum_deposit, updated_at")
                 .eq("id", 1)
                 .maybeSingle();

             if (error) {
                 console.error("Referral settings lookup error:", error);
                 return res.status(500).json({
                     success: false,
                     message: "Unable to load referral settings"
                 });
             }

             if (!data) {
                 return res.status(404).json({
                     success: false,
                     message: "Referral settings have not been configured"
                 });
             }

             return res.json({
                 success: true,
                 settings: data
             });
         } catch (error) {
             console.error("Referral settings exception:", error);
             return res.status(500).json({
                 success: false,
                 message: "Unable to load referral settings"
             });
         }
     }
 );

 // UPDATE REFERRAL COMMISSION RATE
 app.patch(
     "/api/admin/referral-settings",
     authenticateUser,
     requireAdmin,
     async (req, res) => {
         try {
             // Only the Owner can change the commission rate.
             if (!req.isOwner) {
                 return res.status(403).json({
                     success: false,
                     message: "Only the Owner can change referral settings"
                 });
             }

             const percent = Number(
                 req.body && req.body.commission_percent
             );

             if (![5, 10].includes(percent)) {
                 return res.status(400).json({
                     success: false,
                     message: "Commission must be either 5% or 10%"
                 });
             }

             const { data, error } = await supabase
                 .from("referral_settings")
                 .update({
                     commission_percent: percent,
                     minimum_deposit: 8,
                     updated_at: new Date().toISOString()
                 })
                 .eq("id", 1)
                 .select("id, commission_percent, minimum_deposit, updated_at")
                 .single();

             if (error) {
                 console.error("Referral settings update error:", error);
                 return res.status(500).json({
                     success: false,
                     message: "Unable to save referral settings"
                 });
             }

             console.log(
                 `REFERRAL SETTINGS: ${req.user.id} set commission to ${percent}%`
             );

             return res.json({
                 success: true,
                 message: `Referral commission updated to ${percent}%`,
                 settings: data
             });
         } catch (error) {
             console.error("Referral settings update exception:", error);
             return res.status(500).json({
                 success: false,
                 message: "Unable to save referral settings"
             });
         }
     }
 );
// ============================================================
// REFERRAL COMMISSIONS
// ============================================================

// GET REFERRAL COMMISSION HISTORY
app.get(
    "/api/admin/referral-commissions",
    authenticateUser,
    requireAdmin,
    async (req, res) => {
        try {
            const limit = Math.min(
                Math.max(Number(req.query.limit) || 100, 1),
                500
            );

            const { data, error } = await supabase
                .from("referral_commissions")
                .select("*")
                .order("id", { ascending: false })
                .limit(limit);

            if (error) {
                console.error(
                    "Referral commissions error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Failed to load referral commissions"
                });
            }

            return res.json({
                success: true,
                commissions: data || []
            });

        } catch (error) {
            console.error(
                "Referral commissions exception:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Failed to load referral commissions"
            });
        }
    }
);


// GET REFERRAL COMMISSIONS FOR A USER
app.get(
    "/api/admin/users/:id/referral-commissions",
    authenticateUser,
    requireAdmin,
    async (req, res) => {
        try {
            const userId = String(req.params.id || "").trim();

            if (!userId) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid user ID"
                });
            }

            const { data, error } = await supabase
                .from("referral_commissions")
                .select("*")
                .eq("referrer_id", userId)
                .order("id", { ascending: false });

            if (error) {
                console.error(
                    "User referral commissions error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Failed to load referral commissions"
                });
            }

            return res.json({
                success: true,
                commissions: data || []
            });

        } catch (error) {
            console.error(
                "User referral commissions exception:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Failed to load referral commissions"
            });
        }
    }
);
// ==========================================
// FINANCIAL OVERVIEW
// ==========================================

app.get(
    "/api/admin/finance",
    authenticateUser,
    requireAdmin,
    async (req, res) => {

        try {

            // ------------------------------------------
            // EXCHANGE RATES
            // ------------------------------------------

            const depositRate =
                Number(
                    process.env.USD_KES_DEPOSIT_RATE || 135
                );

            const withdrawalRate =
                Number(
                    process.env.USD_KES_WITHDRAWAL_RATE || 124
                );


            // ------------------------------------------
            // LOAD FINANCIAL DATA
            // ------------------------------------------

            const [
                walletsResult,
                transactionsResult,
                withdrawalsResult,
                profilesResult
            ] = await Promise.all([

                supabase
                    .from("wallets")
                    .select(
                        "id, user_id, balance, demo_balance, currency, updated_at"
                    ),

                supabase
                    .from("wallet_transactions")
                    .select(
                        "*"
                    )
                    .order(
                        "created_at",
                        {
                            ascending: false
                        }
                    ),

                supabase
                    .from("withdrawals")
                    .select(
                        "*"
                    )
                    .order(
                        "created_at",
                        {
                            ascending: false
                        }
                    ),

                supabase
                    .from("profiles")
                    .select(
                        "id, username, full_name, country, role, created_at"
                    )
            ]);


            // ------------------------------------------
            // DATABASE ERRORS
            // ------------------------------------------

            const errors = [

                walletsResult.error,

                transactionsResult.error,

                withdrawalsResult.error,

                profilesResult.error

            ].filter(Boolean);


            if (errors.length) {

                console.error(
                    "Admin financial overview database errors:",
                    errors
                );

                return res.status(500).json({

                    success: false,

                    message:
                        "Unable to load financial overview"

                });
            }


            const wallets =
                walletsResult.data || [];

            const transactions =
                transactionsResult.data || [];

            const withdrawals =
                withdrawalsResult.data || [];

            const profiles =
                profilesResult.data || [];


            // ------------------------------------------
            // HELPERS
            // ------------------------------------------

            function amountOf(transaction) {

                const amount =
                    Number(
                        transaction &&
                        transaction.amount
                    );

                return Number.isFinite(amount)
                    ? amount
                    : 0;
            }


            function roundAmount(value) {

                return Number(
                    Number(value || 0)
                        .toFixed(6)
                );
            }


            // ------------------------------------------
            // CUSTOMER LIVE BALANCES
            //
            // IMPORTANT:
            // demo_balance is NOT included.
            // Only real/live wallet.balance counts.
            // ------------------------------------------

            const customerLiabilityUsd =
                roundAmount(
                    wallets.reduce(
                        (
                            total,
                            wallet
                        ) => {

                            return total +
                                Math.max(
                                    Number(
                                        wallet.balance || 0
                                    ),
                                    0
                                );

                        },
                        0
                    )
                );


            const customerLiabilityKes =
                roundAmount(
                    customerLiabilityUsd *
                    withdrawalRate
                );


            // ------------------------------------------
            // FUNDED USERS
            // ------------------------------------------

            const fundedUserIds =
                new Set(

                    transactions
                        .filter(
                            tx =>
                                String(
                                    tx.transaction_type ||
                                    ""
                                ).toLowerCase() ===
                                    "deposit" &&
                                String(
                                    tx.status ||
                                    ""
                                ).toLowerCase() ===
                                    "completed"
                        )
                        .map(
                            tx =>
                                tx.user_id
                        )
                        .filter(Boolean)

                );


            const fundedUsers =
                fundedUserIds.size;


            // ------------------------------------------
            // TRANSACTION TOTALS
            // ------------------------------------------

            let completedDeposits = 0;

            let pendingDeposits = 0;

            let failedDeposits = 0;

            let completedWithdrawals = 0;

            let pendingWithdrawals = 0;

            let rejectedWithdrawals = 0;

            let failedWithdrawals = 0;

            let tradeStakes = 0;

            let tradePayouts = 0;

            let refunds = 0;

            let bonuses = 0;


            transactions.forEach(
                tx => {

                    const type =
                        String(
                            tx.transaction_type ||
                            tx.type ||
                            ""
                        )
                            .trim()
                            .toLowerCase();

                    const status =
                        String(
                            tx.status ||
                            ""
                        )
                            .trim()
                            .toLowerCase();

                    const amount =
                        amountOf(tx);


                    // ----------------------------------
                    // DEPOSITS
                    // ----------------------------------

                    if (
                        type ===
                        "deposit"
                    ) {

                        if (
                            status ===
                            "completed"
                        ) {

                            completedDeposits +=
                                amount;

                        }

                        else if (
                            status ===
                            "pending"
                        ) {

                            pendingDeposits +=
                                amount;

                        }

                        else if (
                            status ===
                                "failed" ||
                            status ===
                                "rejected"
                        ) {

                            failedDeposits +=
                                amount;

                        }

                    }


                    // ----------------------------------
                    // WITHDRAWALS
                    // ----------------------------------

                    if (
                        type ===
                        "withdrawal"
                    ) {

                        if (
                            status ===
                            "completed"
                        ) {

                            completedWithdrawals +=
                                amount;

                        }

                        else if (
                            status ===
                            "pending"
                        ) {

                            pendingWithdrawals +=
                                amount;

                        }

                        else if (
                            status ===
                            "rejected"
                        ) {

                            rejectedWithdrawals +=
                                amount;

                        }

                        else if (
                            status ===
                            "failed"
                        ) {

                            failedWithdrawals +=
                                amount;

                        }

                    }


                    // ----------------------------------
                    // TRADE STAKES
                    // ----------------------------------

                    if (
                        type ===
                        "trade_stake"
                    ) {

                        if (
                            status ===
                            "completed"
                        ) {

                            tradeStakes +=
                                amount;

                        }

                    }


                    // ----------------------------------
                    // TRADE PAYOUTS
                    // ----------------------------------

                    if (
                        type ===
                        "trade_payout"
                    ) {

                        if (
                            status ===
                            "completed"
                        ) {

                            tradePayouts +=
                                amount;

                        }

                    }


                    // ----------------------------------
                    // REFUNDS
                    // ----------------------------------

                    if (
                        type ===
                            "refund" ||
                        type ===
                            "withdrawal_refund"
                    ) {

                        if (
                            status ===
                            "completed"
                        ) {

                            refunds +=
                                amount;

                        }

                    }


                    // ----------------------------------
                    // BONUSES / OWNER ADJUSTMENTS
                    // ----------------------------------

                    if (
                        type ===
                        "bonus"
                    ) {

                        if (
                            status ===
                            "completed"
                        ) {

                            bonuses +=
                                amount;

                        }

                    }

                }
            );


            // ------------------------------------------
            // ALSO CHECK WITHDRAWALS TABLE
            //
            // This is important because the withdrawals
            // table is the authoritative withdrawal
            // workflow table.
            // ------------------------------------------

            const withdrawalStatusTotals = {

                pending: 0,

                completed: 0,

                rejected: 0,

                failed: 0

            };


            withdrawals.forEach(
                withdrawal => {

                    const status =
                        String(
                            withdrawal.status ||
                            ""
                        )
                            .trim()
                            .toLowerCase();

                    const amount =
                        Number(
                            withdrawal.amount || 0
                        );

                    if (
                        !Number.isFinite(
                            amount
                        )
                    ) {
                        return;
                    }

                    if (
                        Object.prototype.hasOwnProperty.call(
                            withdrawalStatusTotals,
                            status
                        )
                    ) {

                        withdrawalStatusTotals[
                            status
                        ] += amount;

                    }

                }
            );


            // ------------------------------------------
            // USE WITHDRAWALS TABLE FOR COUNTS / AMOUNTS
            // WHEN AVAILABLE
            // ------------------------------------------

            const withdrawalRows =
                withdrawals.length > 0;


            const finalPendingWithdrawals =
                withdrawalRows
                    ? roundAmount(
                        withdrawalStatusTotals.pending
                    )
                    : roundAmount(
                        pendingWithdrawals
                    );


            const finalCompletedWithdrawals =
                withdrawalRows
                    ? roundAmount(
                        withdrawalStatusTotals.completed
                    )
                    : roundAmount(
                        completedWithdrawals
                    );


            const finalRejectedWithdrawals =
                withdrawalRows
                    ? roundAmount(
                        withdrawalStatusTotals.rejected
                    )
                    : roundAmount(
                        rejectedWithdrawals
                    );


            const finalFailedWithdrawals =
                withdrawalRows
                    ? roundAmount(
                        withdrawalStatusTotals.failed
                    )
                    : roundAmount(
                        failedWithdrawals
                    );


            // ------------------------------------------
            // BUSINESS CASH
            //
            // DO NOT INVENT THIS VALUE.
            //
            // The actual M-Pesa/Till/Business cash
            // exists outside Supabase.
            // ------------------------------------------

            const businessCashAvailable =
                null;


            // ------------------------------------------
            // FINANCIAL MOVEMENT
            //
            // This is platform activity, NOT business
            // profit.
            // ------------------------------------------

            const netDepositFlowUsd =
                roundAmount(
                    completedDeposits -
                    finalCompletedWithdrawals
                );


            const tradingNetFlowUsd =
                roundAmount(
                    tradePayouts -
                    tradeStakes
                );


            // ------------------------------------------
            // USER BALANCE DETAILS
            // ------------------------------------------

            const profileMap = {};

            profiles.forEach(
                profile => {

                    profileMap[
                        profile.id
                    ] = profile;

                }
            );


            const userBalances =
                wallets
                    .map(
                        wallet => {

                            const profile =
                                profileMap[
                                    wallet.user_id
                                ] ||
                                null;

                            return {

                                user_id:
                                    wallet.user_id,

                                username:
                                    profile?.username ||
                                    null,

                                full_name:
                                    profile?.full_name ||
                                    null,

                                country:
                                    profile?.country ||
                                    null,

                                role:
                                    profile?.role ||
                                    "user",

                                currency:
                                    wallet.currency ||
                                    "USD",

                                live_balance:
                                    roundAmount(
                                        wallet.balance
                                    ),

                                live_balance_kes:
                                    roundAmount(
                                        Number(
                                            wallet.balance || 0
                                        ) *
                                        withdrawalRate
                                    ),

                                demo_balance:
                                    roundAmount(
                                        wallet.demo_balance
                                    ),

                                updated_at:
                                    wallet.updated_at ||
                                    null

                            };

                        }
                    )
                    .sort(
                        (
                            a,
                            b
                        ) =>
                            b.live_balance -
                            a.live_balance
                    );


            // ------------------------------------------
            // RECENT FINANCIAL TRANSACTIONS
            // ------------------------------------------

            const recentTransactions =
                transactions
                    .slice(
                        0,
                        100
                    )
                    .map(
                        tx => {

                            const profile =
                                profileMap[
                                    tx.user_id
                                ] ||
                                null;

                            return {

                                ...tx,

                                username:
                                    profile?.username ||
                                    null,

                                full_name:
                                    profile?.full_name ||
                                    null

                            };

                        }
                    );


            // ------------------------------------------
            // COUNTS
            // ------------------------------------------

            const completedDepositCount =
                transactions.filter(
                    tx =>
                        String(
                            tx.transaction_type ||
                            ""
                        ).toLowerCase() ===
                            "deposit" &&
                        String(
                            tx.status ||
                            ""
                        ).toLowerCase() ===
                            "completed"
                ).length;


            const completedWithdrawalCount =
                withdrawals.filter(
                    withdrawal =>
                        String(
                            withdrawal.status ||
                            ""
                        ).toLowerCase() ===
                            "completed"
                ).length;


            const pendingWithdrawalCount =
                withdrawals.filter(
                    withdrawal =>
                        String(
                            withdrawal.status ||
                            ""
                        ).toLowerCase() ===
                            "pending"
                ).length;


            const pendingDepositCount =
                transactions.filter(
                    tx =>
                        String(
                            tx.transaction_type ||
                            ""
                        ).toLowerCase() ===
                            "deposit" &&
                        String(
                            tx.status ||
                            ""
                        ).toLowerCase() ===
                            "pending"
                ).length;


            // ------------------------------------------
            // FINAL RESPONSE
            // ------------------------------------------

            return res.json({

                success: true,

                finance: {

                    // ================================
                    // CUSTOMER FUNDS
                    // ================================

                    customerFunds: {

                        liabilityUsd:
                            customerLiabilityUsd,

                        liabilityKes:
                            customerLiabilityKes,

                        fundedUsers,

                        totalWallets:
                            wallets.length,

                        exchangeRate:
                            withdrawalRate,

                        exchangeRateLabel:
                            "USD/KES estimated withdrawal rate"

                    },


                    // ================================
                    // DEPOSITS
                    // ================================

                    deposits: {

                        completedUsd:
                            roundAmount(
                                completedDeposits
                            ),

                        completedKes:
                            roundAmount(
                                completedDeposits *
                                depositRate
                            ),

                        pendingUsd:
                            roundAmount(
                                pendingDeposits
                            ),

                        pendingKes:
                            roundAmount(
                                pendingDeposits *
                                depositRate
                            ),

                        failedUsd:
                            roundAmount(
                                failedDeposits
                            ),

                        completedCount:
                            completedDepositCount,

                        pendingCount:
                            pendingDepositCount

                    },


                    // ================================
                    // WITHDRAWALS
                    // ================================

                    withdrawals: {

                        completedUsd:
                            finalCompletedWithdrawals,

                        completedKes:
                            roundAmount(
                                finalCompletedWithdrawals *
                                withdrawalRate
                            ),

                        pendingUsd:
                            finalPendingWithdrawals,

                        pendingKes:
                            roundAmount(
                                finalPendingWithdrawals *
                                withdrawalRate
                            ),

                        rejectedUsd:
                            finalRejectedWithdrawals,

                        failedUsd:
                            finalFailedWithdrawals,

                        completedCount:
                            completedWithdrawalCount,

                        pendingCount:
                            pendingWithdrawalCount

                    },


                    // ================================
                    // TRADING
                    // ================================

                    trading: {

                        stakesUsd:
                            roundAmount(
                                tradeStakes
                            ),

                        payoutsUsd:
                            roundAmount(
                                tradePayouts
                            ),

                        netTradingFlowUsd:
                            tradingNetFlowUsd

                    },


                    // ================================
                    // OTHER
                    // ================================

                    other: {

                        refundsUsd:
                            roundAmount(
                                refunds
                            ),

                        bonusesUsd:
                            roundAmount(
                                bonuses
                            )

                    },


                    // ================================
                    // PLATFORM FLOW
                    // ================================

                    platformFlow: {

                        depositsMinusWithdrawalsUsd:
                            netDepositFlowUsd,

                        depositsMinusWithdrawalsKes:
                            roundAmount(
                                netDepositFlowUsd *
                                withdrawalRate
                            )

                    },


                    // ================================
                    // BUSINESS CASH
                    // ================================

                    businessCash: {

                        available:
                            businessCashAvailable,

                        status:
                            "external",

                        message:
                            "Actual business cash is held outside Supabase, such as the M-Pesa Till/Business account. It must be verified separately."

                    },


                    // ================================
                    // USER BALANCES
                    // ================================

                    userBalances,


                    // ================================
                    // RECENT TRANSACTIONS
                    // ================================

                    recentTransactions

                }

            });

        }

        catch (error) {

            console.error(
                "Admin financial overview exception:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "Unable to load financial overview"

            });

        }

    }
);
    // ==========================================
    // DEPOSITS
    // ==========================================

    app.get(
        "/api/admin/deposits",
        authenticateUser,
        requireAdmin,
        async (req, res) => {

            try {

                const status =
                    String(
                        req.query.status ||
                        "pending"
                    )
                        .trim()
                        .toLowerCase();

                const {
                    data,
                    error
                } = await supabase
                    .from("wallet_transactions")
                    .select("*")
                    .eq(
                        "transaction_type",
                        "deposit"
                    )
                    .eq(
                        "status",
                        status
                    )
                    .order(
                        "created_at",
                        {
                            ascending: false
                        }
                    )
                    .limit(200);

                if (error) {

                    console.error(
                        "Admin deposits error:",
                        error
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Unable to load deposits"
                    });
                }

                return res.json({
                    success: true,
                    deposits:
                        data || []
                });

            }

            catch (error) {

                console.error(
                    "Admin deposits exception:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to load deposits"
                });
            }
        }
    );


    // ==========================================
    // WITHDRAWALS
    // ==========================================

   app.get(
    "/api/admin/withdrawals",
    authenticateUser,
    requireAdmin,
    async (req, res) => {
        try {
            const status =
                req.query.status
                    ? String(
                        req.query.status
                    )
                        .trim()
                        .toLowerCase()
                    : null;

            // ------------------------------------------
            // LOAD WITHDRAWALS
            // ------------------------------------------

            let withdrawalQuery =
                supabase
                    .from("withdrawals")
                    .select("*")
                    .order(
                        "created_at",
                        {
                            ascending: false
                        }
                    )
                    .limit(200);

            if (status) {
                withdrawalQuery =
                    withdrawalQuery.eq(
                        "status",
                        status
                    );
            }

            const {
                data: withdrawals,
                error: withdrawalError
            } = await withdrawalQuery;

            if (withdrawalError) {
                console.error(
                    "Admin withdrawals error:",
                    withdrawalError
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to load withdrawals"
                });
            }

            // ------------------------------------------
            // LOAD RELATED WALLET TRANSACTIONS
            // ------------------------------------------

            const withdrawalIds =
                (withdrawals || []).map(
                    withdrawal =>
                        withdrawal.id
                );

            let transactions = [];

            if (withdrawalIds.length) {
                const {
                    data,
                    error
                } = await supabase
                    .from("wallet_transactions")
                    .select("*")
                    .eq(
                        "transaction_type",
                        "withdrawal"
                    )
                    .in(
                        "reference_id",
                        withdrawalIds
                    );

                if (error) {
                    console.error(
                        "Admin withdrawal transactions error:",
                        error
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Unable to load withdrawal transactions"
                    });
                }

                transactions =
                    data || [];
            }

            // ------------------------------------------
            // COMBINE WITHDRAWAL + TRANSACTION DATA
            // ------------------------------------------

            const transactionMap =
                new Map();

            transactions.forEach(
                transaction => {
                    transactionMap.set(
                        String(
                            transaction.reference_id
                        ),
                        transaction
                    );
                }
            );

            const result =
                (withdrawals || []).map(
                    withdrawal => {
                        const transaction =
                            transactionMap.get(
                                String(
                                    withdrawal.id
                                )
                            );

                        return {
                            ...withdrawal,

                            // IMPORTANT:
                            // This is the real withdrawals.id
                            withdrawal_id:
                                withdrawal.id,

                            // Wallet transaction ID
                            wallet_transaction_id:
                                transaction?.id ||
                                null,

                            transaction_status:
                                transaction?.status ||
                                null,

                            mpesa_receipt:
                                transaction?.mpesa_receipt ||
                                withdrawal.mpesa_receipt ||
                                null,

                            result_description:
                                transaction?.result_description ||
                                withdrawal.result_description ||
                                null
                        };
                    }
                );

            return res.json({
                success: true,
                withdrawals:
                    result
            });
        }
        catch (error) {
            console.error(
                "Admin withdrawals exception:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Unable to load withdrawals"
            });
        }
    }
);
    // ==========================================
    // REJECT WITHDRAWAL
    // ==========================================

    app.post(
        "/api/admin/withdrawals/:id/reject",
        authenticateUser,
        requireAdmin,
        async (req, res) => {

            try {

                const withdrawalId =
                    String(
                        req.params.id || ""
                    ).trim();

                const rejectionReason =
                    String(
                        req.body &&
                        req.body.reason ||
                        ""
                    ).trim();

                if (!withdrawalId) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "Withdrawal ID is required"
                    });
                }

                if (!rejectionReason) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "A rejection reason is required"
                    });
                }

                if (
                    rejectionReason.length >
                    500
                ) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "Rejection reason cannot exceed 500 characters"
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
                        "Admin withdrawal rejection lookup error:",
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


                // ==========================================
                // ONLY PENDING WITHDRAWALS CAN BE REJECTED
                // ==========================================

                const currentStatus =
                    String(
                        withdrawal.status ||
                        ""
                    )
                        .trim()
                        .toLowerCase();


                if (
                    currentStatus !==
                    "pending"
                ) {

                    return res.status(409).json({
                        success: false,
                        message:
                            `Withdrawal cannot be rejected because its current status is "${currentStatus || "unknown"}"`
                    });
                }


                const userId =
                    String(
                        withdrawal.user_id ||
                        ""
                    ).trim();


                if (!userId) {

                    return res.status(500).json({
                        success: false,
                        message:
                            "Withdrawal has no associated user"
                    });
                }


                const amount =
                    parsePositiveAmount(
                        withdrawal.amount
                    );


                if (!amount) {

                    return res.status(500).json({
                        success: false,
                        message:
                            "Withdrawal amount is invalid"
                    });
                }


                // ==========================================
                // LOAD USER WALLET
                // ==========================================

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

                    console.error(
                        "Withdrawal rejection wallet lookup error:",
                        walletError
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Unable to load user wallet"
                    });
                }


                if (!wallet) {

                    return res.status(404).json({
                        success: false,
                        message:
                            "User wallet not found"
                    });
                }


                const balanceBefore =
                    Number(
                        wallet.balance || 0
                    );


                const balanceAfter =
                    Number(
                        (
                            balanceBefore +
                            amount
                        ).toFixed(6)
                    );


                // ==========================================
                // REFUND RESERVED FUNDS
                // ==========================================

                const {
                    data: updatedWallet,
                    error: walletUpdateError
                } = await supabase
                    .from("wallets")
                    .update({
                        balance:
                            balanceAfter,

                        updated_at:
                            new Date().toISOString()
                    })
                    .eq(
                        "id",
                        wallet.id
                    )
                    .eq(
                        "balance",
                        balanceBefore
                    )
                    .select()
                    .maybeSingle();


                if (walletUpdateError) {

                    console.error(
                        "Withdrawal rejection wallet refund error:",
                        walletUpdateError
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Unable to refund withdrawal amount"
                    });
                }


                if (!updatedWallet) {

                    return res.status(409).json({
                        success: false,
                        message:
                            "Wallet changed before the refund was applied. Please refresh and try again."
                    });
                }


                // ==========================================
                // UPDATE WITHDRAWAL
                // ==========================================

                const now =
                    new Date().toISOString();


                const {
                    data: updatedWithdrawal,
                    error: withdrawalUpdateError
                } = await supabase
                    .from("withdrawals")
                    .update({

                        status:
                            "rejected",

                        reviewed_by:
                            req.user.id,

                        reviewed_at:
                            now,

                        rejection_reason:
                            rejectionReason,

                        admin_notes:
                            rejectionReason

                    })
                    .eq(
                        "id",
                        withdrawalId
                    )
                    .eq(
                        "status",
                        "pending"
                    )
                    .select()
                    .maybeSingle();


                if (withdrawalUpdateError) {

                    console.error(
                        "Withdrawal rejection update error:",
                        withdrawalUpdateError
                    );


                    // Roll back wallet refund
                    await supabase
                        .from("wallets")
                        .update({
                            balance:
                                balanceBefore,

                            updated_at:
                                new Date().toISOString()
                        })
                        .eq(
                            "id",
                            wallet.id
                        )
                        .eq(
                            "balance",
                            balanceAfter
                        );


                    return res.status(500).json({
                        success: false,
                        message:
                            "Withdrawal rejection failed. Wallet refund was rolled back."
                    });
                }


                if (!updatedWithdrawal) {

                    // Roll back wallet refund
                    await supabase
                        .from("wallets")
                        .update({
                            balance:
                                balanceBefore,

                            updated_at:
                                new Date().toISOString()
                        })
                        .eq(
                            "id",
                            wallet.id
                        )
                        .eq(
                            "balance",
                            balanceAfter
                        );


                    return res.status(409).json({
                        success: false,
                        message:
                            "Withdrawal was already processed by another action."
                    });
                }


                // ==========================================
                // FIND RELATED WALLET TRANSACTION
                // ==========================================

                let walletTransaction = null;


                if (withdrawal.reference) {

                    const {
                        data: transaction,
                        error:
                            transactionLookupError
                    } = await supabase
                        .from("wallet_transactions")
                        .select("*")
                        .eq(
                            "transaction_type",
                            "withdrawal"
                        )
                        .eq(
                            "reference",
                            withdrawal.reference
                        )
                        .maybeSingle();


                    if (
                        transactionLookupError
                    ) {

                        console.error(
                            "Withdrawal wallet transaction lookup error:",
                            transactionLookupError
                        );

                    }
                    else {

                        walletTransaction =
                            transaction;

                    }
                }


                // ==========================================
                // MARK ORIGINAL WITHDRAWAL TRANSACTION
                // ==========================================

                if (walletTransaction) {

                    const {
                        error:
                            transactionUpdateError
                    } = await supabase
                        .from("wallet_transactions")
                        .update({

                            status:
                                "rejected",

                            description:
                                `Withdrawal rejected: ${rejectionReason}`,

                            balance_after:
                                balanceAfter

                        })
                        .eq(
                            "id",
                            walletTransaction.id
                        )
                        .eq(
                            "status",
                            "pending"
                        );


                    if (
                        transactionUpdateError
                    ) {

                        console.error(
                            "Withdrawal wallet transaction update error:",
                            transactionUpdateError
                        );

                    }
                }


                // ==========================================
                // CREATE REFUND TRANSACTION
                // ==========================================

                const refundReference =
                    generateReference(
                        "WITHDRAWAL-REFUND"
                    );


                const {
                    data: refundTransaction,
                    error:
                        refundTransactionError
                } = await supabase
                    .from("wallet_transactions")
                    .insert({

                        user_id:
                            userId,

                        wallet_id:
                            wallet.id,

                        transaction_type:
                            "refund",

                        type:
                            "withdrawal_refund",

                        amount:
                            amount,

                        status:
                            "completed",

                        payment_method:
                            "wallet",

                        reference:
                            refundReference,

                        description:
                            `Withdrawal refund: ${rejectionReason}`,

                        balance_before:
                            balanceBefore,

                        balance_after:
                            balanceAfter

                    })
                    .select()
                    .single();


                if (
                    refundTransactionError
                ) {

                    console.error(
                        "Withdrawal refund transaction error:",
                        refundTransactionError
                    );

                    /*
                     * IMPORTANT:
                     * The wallet has already been refunded and
                     * the withdrawal has already been marked rejected.
                     *
                     * We do NOT reverse the user's money here.
                     * Instead, return an explicit reconciliation
                     * error so the admin can identify the issue.
                     */

                    await supabase
                        .from("withdrawals")
                        .update({
                            admin_notes:
                                `RECONCILIATION REQUIRED: wallet refunded but refund transaction failed. ${rejectionReason}`
                        })
                        .eq(
                            "id",
                            withdrawalId
                        );


                    return res.status(500).json({
                        success: false,
                        message:
                            "Withdrawal was rejected and wallet refunded, but the refund transaction could not be recorded. Reconciliation is required."
                    });
                }


                // ==========================================
                // AUDIT LOG
                // ==========================================

                const {
                    error:
                        auditError
                } = await supabase
                    .from("withdrawal_audit_logs")
                    .insert({

                        withdrawal_id:
                            withdrawalId,

                        user_id:
                            userId,

                        admin_id:
                            req.user.id,

                        action:
                            "withdrawal_rejected",

                        reason:
                            rejectionReason,

                        notes:
                            "Withdrawal rejected by administrator and reserved funds returned to wallet.",

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

                            refund_reference:
                                refundReference,

                            admin_role:
                                req.adminRole

                        }

                    });


                if (auditError) {

                    console.error(
                        "Withdrawal rejection audit log error:",
                        auditError
                    );

                    /*
                     * Do not reverse the financial operation merely
                     * because audit logging failed.
                     *
                     * The withdrawal and wallet remain correctly
                     * processed, but the server logs the problem.
                     */
                }


                console.log(
                    `ADMIN WITHDRAWAL REJECTED: admin=${req.user.id} role=${req.adminRole} withdrawal=${withdrawalId} user=${userId} amount=${amount} refund=${refundReference} reason=${rejectionReason}`
                );


                return res.json({

                    success:
                        true,

                    message:
                        `Withdrawal rejected and $${amount.toFixed(6)} returned to the user's wallet.`,

                    withdrawal:
                        updatedWithdrawal,

                    refund:
                        refundTransaction,

                    wallet:
                        updatedWallet,

                    changedBy: {

                        id:
                            req.user.id,

                        role:
                            req.adminRole

                    }

                });

            }

            catch (error) {

                console.error(
                    "Admin withdrawal rejection exception:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to reject withdrawal"
                });
            }
        }
    );
    // ==========================================
    // MARKETS
    // ==========================================

    app.get(
        "/api/admin/markets",
        authenticateUser,
        requireAdmin,
        async (req, res) => {

            try {

                const {
                    data,
                    error
                } = await supabase
                    .from("markets")
                    .select("*")
                    .order("symbol");

                if (error) {

                    console.error(
                        "Admin markets error:",
                        error
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Unable to load markets"
                    });
                }

                return res.json({
                    success: true,
                    markets:
                        data || []
                });

            }

            catch (error) {

                console.error(
                    "Admin markets exception:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to load markets"
                });
            }
        }
    );


    // ==========================================
    // ACTIVATE / DEACTIVATE MARKET
    // ==========================================

    app.patch(
        "/api/admin/markets/:id",
        authenticateUser,
        requireAdmin,
        async (req, res) => {

            try {

                const isActive =
                    req.body &&
                    req.body.is_active;

                if (
                    typeof isActive !==
                    "boolean"
                ) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "is_active must be true or false"
                    });
                }

                const {
                    data,
                    error
                } = await supabase
                    .from("markets")
                    .update({
                        is_active:
                            isActive
                    })
                    .eq(
                        "id",
                        req.params.id
                    )
                    .select()
                    .single();

                if (error) {

                    console.error(
                        "Admin market update error:",
                        error
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Unable to update market"
                    });
                }

                return res.json({
                    success: true,
                    market:
                        data
                });

            }

            catch (error) {

                console.error(
                    "Admin market update exception:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to update market"
                });
            }
        }
    );


    // ==========================================
    // OWNER: WALLET BALANCE VIEW
    // ==========================================

    app.get(
        "/api/admin/owner/wallet/:userId",
        authenticateUser,
        requireOwner,
        async (req, res) => {

            try {

                const userId =
                    String(
                        req.params.userId || ""
                    ).trim();

                if (!userId) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "User ID is required"
                    });
                }

                const {
                    data: wallet,
                    error
                } = await supabase
                    .from("wallets")
                    .select("*")
                    .eq(
                        "user_id",
                        userId
                    )
                    .maybeSingle();

                if (error) {

                    console.error(
                        "Owner wallet lookup error:",
                        error
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Unable to load wallet"
                    });
                }

                if (!wallet) {

                    return res.status(404).json({
                        success: false,
                        message:
                            "Wallet not found"
                    });
                }

                return res.json({

                    success: true,

                    wallet
                });

            }

            catch (error) {

                console.error(
                    "Owner wallet lookup exception:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to load wallet"
                });
            }
        }
    );


    // ==========================================
    // OWNER: CREDIT LIVE BALANCE
    // ==========================================

    app.post(
        "/api/admin/owner/wallet/:userId/credit",
        authenticateUser,
        requireOwner,
        async (req, res) => {

            try {

                const userId =
                    String(
                        req.params.userId || ""
                    ).trim();

                const amount =
                    parsePositiveAmount(
                        req.body &&
                        req.body.amount
                    );

                const reason =
                    String(
                        req.body &&
                        req.body.reason ||
                        ""
                    ).trim();

                if (!userId) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "User ID is required"
                    });
                }

                if (!amount) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "Credit amount must be greater than zero"
                    });
                }

                if (amount > 1000000) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "Credit amount cannot exceed $1,000,000"
                    });
                }

                if (!reason) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "A reason is required"
                    });
                }

                if (reason.length > 500) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "Reason cannot exceed 500 characters"
                    });
                }

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

                    console.error(
                        "Owner credit wallet lookup error:",
                        walletError
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Unable to load target wallet"
                    });
                }

                if (!wallet) {

                    return res.status(404).json({
                        success: false,
                        message:
                            "Target wallet not found"
                    });
                }

                const balanceBefore =
                    Number(
                        wallet.balance || 0
                    );

                const balanceAfter =
                    Number(
                        (
                            balanceBefore +
                            amount
                        ).toFixed(6)
                    );

                const {
                    data: updatedWallet,
                    error: updateError
                } = await supabase
                    .from("wallets")
                    .update({
                        balance:
                            balanceAfter,
                        updated_at:
                            new Date().toISOString()
                    })
                    .eq(
                        "id",
                        wallet.id
                    )
                    .eq(
                        "balance",
                        balanceBefore
                    )
                    .select()
                    .maybeSingle();

                if (updateError) {

                    console.error(
                        "Owner credit wallet update error:",
                        updateError
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Unable to credit wallet"
                    });
                }

                if (!updatedWallet) {

                    return res.status(409).json({
                        success: false,
                        message:
                            "Wallet changed before the credit was applied. Please try again."
                    });
                }

                const reference =
                    generateReference(
                        "OWNER-CREDIT"
                    );

                const {
                    data: transaction,
                    error: transactionError
                } = await supabase
                    .from("wallet_transactions")
                    .insert({

                        user_id:
                            userId,

                        wallet_id:
                            wallet.id,

                        transaction_type:
                            "bonus",

                        type:
                            "owner_credit",

                        amount:
                            amount,

                        status:
                            "completed",

                        payment_method:
                            "owner",

                        reference,

                        description:
                            reason,

                        balance_before:
                            balanceBefore,

                        balance_after:
                            balanceAfter

                    })
                    .select()
                    .single();

                if (transactionError) {

                    console.error(
                        "Owner credit transaction error:",
                        transactionError
                    );

                    await supabase
                        .from("wallets")
                        .update({
                            balance:
                                balanceBefore,
                            updated_at:
                                new Date().toISOString()
                        })
                        .eq(
                            "id",
                            wallet.id
                        )
                        .eq(
                            "balance",
                            balanceAfter
                        );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Credit transaction could not be recorded. Wallet change was rolled back."
                    });
                }

                console.log(
                    `OWNER WALLET CREDIT: owner=${req.user.id} user=${userId} amount=${amount} before=${balanceBefore} after=${balanceAfter} reference=${reference}`
                );

                return res.json({

                    success: true,

                    message:
                        `Wallet credited with $${amount.toFixed(6)}`,

                    wallet:
                        updatedWallet,

                    transaction,

                    changedBy: {
                        id:
                            req.user.id,

                        role:
                            req.adminRole
                    }
                });

            }

            catch (error) {

                console.error(
                    "Owner wallet credit exception:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to credit wallet"
                });
            }
        }
    );


    // ==========================================
    // OWNER: DEBIT LIVE BALANCE
    // ==========================================

    app.post(
        "/api/admin/owner/wallet/:userId/debit",
        authenticateUser,
        requireOwner,
        async (req, res) => {

            try {

                const userId =
                    String(
                        req.params.userId || ""
                    ).trim();

                const amount =
                    parsePositiveAmount(
                        req.body &&
                        req.body.amount
                    );

                const reason =
                    String(
                        req.body &&
                        req.body.reason ||
                        ""
                    ).trim();

                if (!userId) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "User ID is required"
                    });
                }

                if (!amount) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "Debit amount must be greater than zero"
                    });
                }

                if (amount > 1000000) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "Debit amount cannot exceed $1,000,000"
                    });
                }

                if (!reason) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "A reason is required"
                    });
                }

                if (reason.length > 500) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "Reason cannot exceed 500 characters"
                    });
                }

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

                    console.error(
                        "Owner debit wallet lookup error:",
                        walletError
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Unable to load target wallet"
                    });
                }

                if (!wallet) {

                    return res.status(404).json({
                        success: false,
                        message:
                            "Target wallet not found"
                    });
                }

                const balanceBefore =
                    Number(
                        wallet.balance || 0
                    );

                if (amount > balanceBefore) {

                    return res.status(400).json({
                        success: false,
                        message:
                            `Insufficient live balance. Current balance is $${balanceBefore.toFixed(6)}`
                    });
                }

                const balanceAfter =
                    Number(
                        (
                            balanceBefore -
                            amount
                        ).toFixed(6)
                    );

                const {
                    data: updatedWallet,
                    error: updateError
                } = await supabase
                    .from("wallets")
                    .update({
                        balance:
                            balanceAfter,
                        updated_at:
                            new Date().toISOString()
                    })
                    .eq(
                        "id",
                        wallet.id
                    )
                    .eq(
                        "balance",
                        balanceBefore
                    )
                    .select()
                    .maybeSingle();

                if (updateError) {

                    console.error(
                        "Owner debit wallet update error:",
                        updateError
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Unable to debit wallet"
                    });
                }

                if (!updatedWallet) {

                    return res.status(409).json({
                        success: false,
                        message:
                            "Wallet changed before the debit was applied. Please try again."
                    });
                }

                const reference =
                    generateReference(
                        "OWNER-DEBIT"
                    );

                const {
                    data: transaction,
                    error: transactionError
                } = await supabase
                    .from("wallet_transactions")
                    .insert({

                        user_id:
                            userId,

                        wallet_id:
                            wallet.id,

                        transaction_type:
                            "bonus",

                        type:
                            "owner_debit",

                        amount:
                            amount,

                        status:
                            "completed",

                        payment_method:
                            "owner",

                        reference,

                        description:
                            reason,

                        balance_before:
                            balanceBefore,

                        balance_after:
                            balanceAfter

                    })
                    .select()
                    .single();

                if (transactionError) {

                    console.error(
                        "Owner debit transaction error:",
                        transactionError
                    );

                    await supabase
                        .from("wallets")
                        .update({
                            balance:
                                balanceBefore,
                            updated_at:
                                new Date().toISOString()
                        })
                        .eq(
                            "id",
                            wallet.id
                        )
                        .eq(
                            "balance",
                            balanceAfter
                        );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Debit transaction could not be recorded. Wallet change was rolled back."
                    });
                }

                console.log(
                    `OWNER WALLET DEBIT: owner=${req.user.id} user=${userId} amount=${amount} before=${balanceBefore} after=${balanceAfter} reference=${reference}`
                );

                return res.json({

                    success: true,

                    message:
                        `Wallet debited by $${amount.toFixed(6)}`,

                    wallet:
                        updatedWallet,

                    transaction,

                    changedBy: {
                        id:
                            req.user.id,

                        role:
                            req.adminRole
                    }
                });

            }

            catch (error) {

                console.error(
                    "Owner wallet debit exception:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to debit wallet"
                });
            }
        }
    );


    // ==========================================
    // OWNER: SET EXACT LIVE BALANCE
    // ==========================================

    app.post(
        "/api/admin/owner/wallet/:userId/set-balance",
        authenticateUser,
        requireOwner,
        async (req, res) => {

            try {

                const userId =
                    String(
                        req.params.userId || ""
                    ).trim();

                const newBalance =
                    parseNonNegativeAmount(
                        req.body &&
                        req.body.balance
                    );

                const reason =
                    String(
                        req.body &&
                        req.body.reason ||
                        ""
                    ).trim();

                if (!userId) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "User ID is required"
                    });
                }

                if (newBalance === null) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "Balance must be zero or greater"
                    });
                }

                if (newBalance > 1000000) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "Balance cannot exceed $1,000,000"
                    });
                }

                if (!reason) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "A reason is required"
                    });
                }

                if (reason.length > 500) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "Reason cannot exceed 500 characters"
                    });
                }

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

                    console.error(
                        "Owner set-balance wallet lookup error:",
                        walletError
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Unable to load target wallet"
                    });
                }

                if (!wallet) {

                    return res.status(404).json({
                        success: false,
                        message:
                            "Target wallet not found"
                    });
                }

                const balanceBefore =
                    Number(
                        wallet.balance || 0
                    );

                const difference =
                    Number(
                        (
                            newBalance -
                            balanceBefore
                        ).toFixed(6)
                    );

                if (difference === 0) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "New balance is the same as the current balance"
                    });
                }

                const {
                    data: updatedWallet,
                    error: updateError
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
                        balanceBefore
                    )
                    .select()
                    .maybeSingle();

                if (updateError) {

                    console.error(
                        "Owner set-balance wallet update error:",
                        updateError
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Unable to set wallet balance"
                    });
                }

                if (!updatedWallet) {

                    return res.status(409).json({
                        success: false,
                        message:
                            "Wallet changed before the balance was set. Please try again."
                    });
                }

                const transactionType =
                    "bonus";

                const reference =
                    generateReference(
                        "OWNER-SET"
                    );

                const {
                    data: transaction,
                    error: transactionError
                } = await supabase
                    .from("wallet_transactions")
                    .insert({

                        user_id:
                            userId,

                        wallet_id:
                            wallet.id,

                        transaction_type:
                            transactionType,

                        type:
                            "owner_balance_adjustment",

                        amount:
                            Math.abs(difference),

                        status:
                            "completed",

                        payment_method:
                            "owner",

                        reference,

                        description:
                            reason,

                        balance_before:
                            balanceBefore,

                        balance_after:
                            newBalance

                    })
                    .select()
                    .single();

                if (transactionError) {

                    console.error(
                        "Owner set-balance transaction error:",
                        transactionError
                    );

                    await supabase
                        .from("wallets")
                        .update({
                            balance:
                                balanceBefore,
                            updated_at:
                                new Date().toISOString()
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
                            "Balance transaction could not be recorded. Wallet change was rolled back."
                    });
                }

                console.log(
                    `OWNER WALLET SET: owner=${req.user.id} user=${userId} before=${balanceBefore} after=${newBalance} difference=${difference} reference=${reference}`
                );

                return res.json({

                    success: true,

                    message:
                        `Wallet balance set to $${newBalance.toFixed(6)}`,

                    wallet:
                        updatedWallet,

                    transaction,

                    changedBy: {
                        id:
                            req.user.id,

                        role:
                            req.adminRole
                    }
                });

            }

            catch (error) {

                console.error(
                    "Owner wallet set-balance exception:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to set wallet balance"
                });
            }
        }
    );

// ============================================================
// OWNER PLATFORM TRANSFERS
// USER WALLET <-> KMFBINARY PLATFORM WALLET
// OWNER ONLY
// ============================================================


// ============================================================
// USER WALLET -> KMFBINARY
// ============================================================

app.post(
    "/api/admin/owner/transfer/user-to-kmf",
    authenticateUser,
    async (req, res) => {

        try {

            // OWNER ONLY
         
const adminContextLoaded =
    await loadAdminContext(req, res);

if (!adminContextLoaded) {
    return;
}

if (!isOwnerRole(req.adminRole)) {
    return res.status(403).json({
        success: false,
        message: "Owner permission required."
    });
}

            const {
                userId,
                amount,
                reason
            } = req.body || {};

            // ------------------------------------------------
            // VALIDATE USER
            // ------------------------------------------------

            if (!userId) {

                return res.status(400).json({
                    success: false,
                    message:
                        "User ID is required."
                });

            }

            const transferAmount =
                parsePositiveAmount(
                    amount
                );

            if (
                transferAmount === null ||
                transferAmount <= 0
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "A valid transfer amount is required."
                });

            }

            if (
                transferAmount > 1000000
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Maximum transfer amount is $1,000,000."
                });

            }

            const transferReason =
                String(
                    reason ||
                    "Owner transfer from user wallet to KMFBinary"
                )
                .trim()
                .slice(0, 500);


            // ------------------------------------------------
            // LOAD USER WALLET
            // ------------------------------------------------

            const {
                data: userWallet,
                error: userWalletError
            } = await supabase
                .from("wallets")
                .select("*")
                .eq("user_id", userId)
                .maybeSingle();

            if (
                userWalletError
            ) {

                console.error(
                    "USER TO KMF - WALLET ERROR:",
                    userWalletError
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to load user wallet."
                });

            }

            if (!userWallet) {

                return res.status(404).json({
                    success: false,
                    message:
                        "User wallet not found."
                });

            }


            // ------------------------------------------------
            // CURRENT USER BALANCE
            // ------------------------------------------------

            const userBalanceBefore =
                Number(
                    userWallet.balance || 0
                );

            if (
                !Number.isFinite(
                    userBalanceBefore
                )
            ) {

                return res.status(500).json({
                    success: false,
                    message:
                        "User wallet balance is invalid."
                });

            }

            if (
                transferAmount >
                userBalanceBefore
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "User does not have enough live wallet balance."
                });

            }


            // ------------------------------------------------
            // LOAD KMFBINARY PLATFORM WALLET
            // ------------------------------------------------

            const {
                data: platformWallet,
                error: platformWalletError
            } = await supabase
                .from("platform_wallet")
                .select("*")
                .limit(1)
                .maybeSingle();

            if (
                platformWalletError
            ) {

                console.error(
                    "USER TO KMF - PLATFORM WALLET ERROR:",
                    platformWalletError
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to load KMFBinary platform balance."
                });

            }

            if (!platformWallet) {

                return res.status(500).json({
                    success: false,
                    message:
                        "KMFBinary platform wallet has not been created."
                });

            }


            // ------------------------------------------------
            // CURRENT PLATFORM BALANCE
            // ------------------------------------------------

            const platformBalanceBefore =
                Number(
                    platformWallet.balance || 0
                );

            if (
                !Number.isFinite(
                    platformBalanceBefore
                )
            ) {

                return res.status(500).json({
                    success: false,
                    message:
                        "KMFBinary platform balance is invalid."
                });

            }


            // ------------------------------------------------
            // CALCULATE NEW BALANCES
            // ------------------------------------------------

            const userBalanceAfter =
                Number(
                    (
                        userBalanceBefore -
                        transferAmount
                    ).toFixed(6)
                );

            const platformBalanceAfter =
                Number(
                    (
                        platformBalanceBefore +
                        transferAmount
                    ).toFixed(6)
                );


            // ------------------------------------------------
            // UNIQUE REFERENCE
            // ------------------------------------------------

            const reference =
                generateReference(
                    "KMF-IN"
                );


            // ------------------------------------------------
            // DEDUCT USER WALLET
            // ------------------------------------------------

            const {
                data: updatedUserWallet,
                error: userUpdateError
            } = await supabase
                .from("wallets")
                .update({
                    balance:
                        userBalanceAfter,
                    updated_at:
                        new Date().toISOString()
                })
                .eq(
                    "id",
                    userWallet.id
                )
                .eq(
                    "balance",
                    userBalanceBefore
                )
                .select("*")
                .maybeSingle();

            if (
                userUpdateError
            ) {

                console.error(
                    "USER TO KMF - USER WALLET UPDATE ERROR:",
                    userUpdateError
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to update user wallet."
                });

            }

            if (!updatedUserWallet) {

                return res.status(409).json({
                    success: false,
                    message:
                        "User wallet changed before the transfer could be completed. Please try again."
                });

            }


            // ------------------------------------------------
            // ADD TO KMFBINARY PLATFORM BALANCE
            // ------------------------------------------------

            const {
                data: updatedPlatformWallet,
                error: platformUpdateError
            } = await supabase
                .from("platform_wallet")
                .update({
                    balance:
                        platformBalanceAfter,
                    updated_at:
                        new Date().toISOString()
                })
                .eq(
                    "id",
                    platformWallet.id
                )
                .eq(
                    "balance",
                    platformBalanceBefore
                )
                .select("*")
                .maybeSingle();

            if (
                platformUpdateError ||
                !updatedPlatformWallet
            ) {

                console.error(
                    "USER TO KMF - PLATFORM UPDATE ERROR:",
                    platformUpdateError
                );


                // --------------------------------------------
                // ROLLBACK USER WALLET
                // --------------------------------------------

                await supabase
                    .from("wallets")
                    .update({
                        balance:
                            userBalanceBefore,
                        updated_at:
                            new Date().toISOString()
                    })
                    .eq(
                        "id",
                        userWallet.id
                    )
                    .eq(
                        "balance",
                        userBalanceAfter
                    );


                return res.status(500).json({
                    success: false,
                    message:
                        "Transfer could not be completed. User wallet was restored."
                });

            }


            // ------------------------------------------------
            // RECORD PLATFORM TRANSFER
            // ------------------------------------------------

            const {
                data: platformTransaction,
                error: platformTransactionError
            } = await supabase
                .from("platform_transactions")
                .insert({

                    platform_wallet_id:
                        platformWallet.id,

                    user_id:
                        userId,

                    direction:
                        "user_to_kmf",

                    amount:
                        transferAmount,

                    platform_balance_before:
                        platformBalanceBefore,

                    platform_balance_after:
                        platformBalanceAfter,

                    user_balance_before:
                        userBalanceBefore,

                    user_balance_after:
                        userBalanceAfter,

                    reference:
                        reference,

                    reason:
                        transferReason,

                    performed_by:
                        req.user.id

                })
                .select("*")
                .single();


            if (
                platformTransactionError
            ) {

                console.error(
                    "USER TO KMF - TRANSACTION RECORD ERROR:",
                    platformTransactionError
                );


                // --------------------------------------------
                // ROLLBACK PLATFORM BALANCE
                // --------------------------------------------

                await supabase
                    .from("platform_wallet")
                    .update({
                        balance:
                            platformBalanceBefore,
                        updated_at:
                            new Date().toISOString()
                    })
                    .eq(
                        "id",
                        platformWallet.id
                    )
                    .eq(
                        "balance",
                        platformBalanceAfter
                    );


                // --------------------------------------------
                // ROLLBACK USER BALANCE
                // --------------------------------------------

                await supabase
                    .from("wallets")
                    .update({
                        balance:
                            userBalanceBefore,
                        updated_at:
                            new Date().toISOString()
                    })
                    .eq(
                        "id",
                        userWallet.id
                    )
                    .eq(
                        "balance",
                        userBalanceAfter
                    );


                return res.status(500).json({
                    success: false,
                    message:
                        "Transfer record could not be created. Balances were restored."
                });

            }


            // ------------------------------------------------
            // AUDIT LOG
            // ------------------------------------------------

            await supabase
                .from("audit_logs")
                .insert({

                    user_id:
                        req.user.id,

                    action:
                        "owner_user_to_kmf_transfer",

                    entity_type:
                        "platform_transfer",

                    entity_id:
                        platformTransaction.id,

                    notes:
                        `Owner transferred $${transferAmount.toFixed(6)} from user wallet to KMFBinary.`,

                    metadata: {

                        reference:
                            reference,

                        target_user_id:
                            userId,

                        amount:
                            transferAmount,

                        user_balance_before:
                            userBalanceBefore,

                        user_balance_after:
                            userBalanceAfter,

                        platform_balance_before:
                            platformBalanceBefore,

                        platform_balance_after:
                            platformBalanceAfter,

                        reason:
                            transferReason

                    }

                });


            return res.json({

                success:
                    true,

                message:
                    "Funds successfully transferred from user wallet to KMFBinary.",

                reference:
                    reference,

                transfer: {

                    direction:
                        "user_to_kmf",

                    amount:
                        transferAmount,

                    userBalanceBefore:
                        userBalanceBefore,

                    userBalanceAfter:
                        userBalanceAfter,

                    platformBalanceBefore:
                        platformBalanceBefore,

                    platformBalanceAfter:
                        platformBalanceAfter,

                    reason:
                        transferReason

                }

            });

        } catch (error) {

            console.error(
                "USER TO KMF TRANSFER ERROR:",
                error
            );

            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to complete User to KMFBinary transfer."

            });

        }

    }
);


/* ==========================================
   GET CUSTOMER LIVE WALLET BALANCE
========================================== */

app.get(
    "/api/admin/owner/user-wallet/:userId",
    authenticateUser,
    async (req, res) => {
        try {
            const adminContextLoaded =
                await loadAdminContext(req, res);

            if (!adminContextLoaded) return;

            if (!isOwnerRole(req.adminRole)) {
                return res.status(403).json({
                    success: false,
                    message: "Owner permission required."
                });
            }

            const userId =
                String(req.params.userId || "").trim();

            if (!userId) {
                return res.status(400).json({
                    success: false,
                    message: "User ID is required."
                });
            }

            const {
                data: wallet,
                error
            } = await supabase
                .from("wallets")
                .select("user_id, balance, currency")
                .eq("user_id", userId)
                .maybeSingle();

            if (error) {
                console.error(
                    "Customer wallet lookup error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to load customer balance."
                });
            }

            if (!wallet) {
                return res.status(404).json({
                    success: false,
                    message: "Customer wallet not found."
                });
            }

            return res.json({
                success: true,
                wallet: {
                    user_id: wallet.user_id,
                    balance: Number(wallet.balance),
                    currency: wallet.currency || "USD"
                }
            });
        } catch (error) {
            console.error(
                "Customer wallet lookup failed:",
                error
            );

            return res.status(500).json({
                success: false,
                message: "Server error loading customer balance."
            });
        }
    }
);

// ============================================================
// KMFBINARY -> USER WALLET
// ============================================================

app.post(
    "/api/admin/owner/transfer/kmf-to-user",
    authenticateUser,
    async (req, res) => {

        try {

            // OWNER ONLY
         
const adminContextLoaded =
    await loadAdminContext(req, res);

if (!adminContextLoaded) {
    return;
}

if (!isOwnerRole(req.adminRole)) {
    return res.status(403).json({
        success: false,
        message: "Owner permission required."
    });
}

            const {
                userId,
                amount,
                reason
            } = req.body || {};


            // ------------------------------------------------
            // VALIDATE USER
            // ------------------------------------------------

            if (!userId) {

                return res.status(400).json({
                    success: false,
                    message:
                        "User ID is required."
                });

            }

            const transferAmount =
                parsePositiveAmount(
                    amount
                );

            if (
                transferAmount === null ||
                transferAmount <= 0
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "A valid transfer amount is required."
                });

            }

            if (
                transferAmount > 1000000
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Maximum transfer amount is $1,000,000."
                });

            }

            const transferReason =
                String(
                    reason ||
                    "Owner transfer from KMFBinary to user wallet"
                )
                .trim()
                .slice(0, 500);


            // ------------------------------------------------
            // LOAD USER WALLET
            // ------------------------------------------------

            const {
                data: userWallet,
                error: userWalletError
            } = await supabase
                .from("wallets")
                .select("*")
                .eq(
                    "user_id",
                    userId
                )
                .maybeSingle();

            if (
                userWalletError
            ) {

                console.error(
                    "KMF TO USER - WALLET ERROR:",
                    userWalletError
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to load user wallet."
                });

            }

            if (!userWallet) {

                return res.status(404).json({
                    success: false,
                    message:
                        "User wallet not found."
                });

            }


            // ------------------------------------------------
            // LOAD PLATFORM WALLET
            // ------------------------------------------------

            const {
                data: platformWallet,
                error: platformWalletError
            } = await supabase
                .from("platform_wallet")
                .select("*")
                .limit(1)
                .maybeSingle();

            if (
                platformWalletError
            ) {

                console.error(
                    "KMF TO USER - PLATFORM WALLET ERROR:",
                    platformWalletError
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to load KMFBinary platform balance."
                });

            }

            if (!platformWallet) {

                return res.status(500).json({
                    success: false,
                    message:
                        "KMFBinary platform wallet has not been created."
                });

            }


            // ------------------------------------------------
            // CURRENT BALANCES
            // ------------------------------------------------

            const userBalanceBefore =
                Number(
                    userWallet.balance || 0
                );

            const platformBalanceBefore =
                Number(
                    platformWallet.balance || 0
                );


            if (
                !Number.isFinite(
                    userBalanceBefore
                ) ||
                !Number.isFinite(
                    platformBalanceBefore
                )
            ) {

                return res.status(500).json({
                    success: false,
                    message:
                        "One of the wallet balances is invalid."
                });

            }


            // ------------------------------------------------
            // CHECK PLATFORM BALANCE
            // ------------------------------------------------

            if (
                transferAmount >
                platformBalanceBefore
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "KMFBinary does not have enough platform balance for this transfer."
                });

            }


            // ------------------------------------------------
            // CALCULATE NEW BALANCES
            // ------------------------------------------------

            const platformBalanceAfter =
                Number(
                    (
                        platformBalanceBefore -
                        transferAmount
                    ).toFixed(6)
                );

            const userBalanceAfter =
                Number(
                    (
                        userBalanceBefore +
                        transferAmount
                    ).toFixed(6)
                );


            // ------------------------------------------------
            // UNIQUE REFERENCE
            // ------------------------------------------------

            const reference =
                generateReference(
                    "KMF-OUT"
                );


            // ------------------------------------------------
            // DEDUCT KMFBINARY PLATFORM BALANCE
            // ------------------------------------------------

            const {
                data: updatedPlatformWallet,
                error: platformUpdateError
            } = await supabase
                .from("platform_wallet")
                .update({
                    balance:
                        platformBalanceAfter,
                    updated_at:
                        new Date().toISOString()
                })
                .eq(
                    "id",
                    platformWallet.id
                )
                .eq(
                    "balance",
                    platformBalanceBefore
                )
                .select("*")
                .maybeSingle();

            if (
                platformUpdateError
            ) {

                console.error(
                    "KMF TO USER - PLATFORM UPDATE ERROR:",
                    platformUpdateError
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to update KMFBinary platform balance."
                });

            }

            if (!updatedPlatformWallet) {

                return res.status(409).json({
                    success: false,
                    message:
                        "KMFBinary balance changed before the transfer could be completed. Please try again."
                });

            }


            // ------------------------------------------------
            // CREDIT USER WALLET
            // ------------------------------------------------

            const {
                data: updatedUserWallet,
                error: userUpdateError
            } = await supabase
                .from("wallets")
                .update({
                    balance:
                        userBalanceAfter,
                    updated_at:
                        new Date().toISOString()
                })
                .eq(
                    "id",
                    userWallet.id
                )
                .eq(
                    "balance",
                    userBalanceBefore
                )
                .select("*")
                .maybeSingle();

            if (
                userUpdateError ||
                !updatedUserWallet
            ) {

                console.error(
                    "KMF TO USER - USER UPDATE ERROR:",
                    userUpdateError
                );


                // --------------------------------------------
                // ROLLBACK PLATFORM BALANCE
                // --------------------------------------------

                await supabase
                    .from("platform_wallet")
                    .update({
                        balance:
                            platformBalanceBefore,
                        updated_at:
                            new Date().toISOString()
                    })
                    .eq(
                        "id",
                        platformWallet.id
                    )
                    .eq(
                        "balance",
                        platformBalanceAfter
                    );


                return res.status(
                    userUpdateError
                        ? 500
                        : 409
                ).json({

                    success:
                        false,

                    message:
                        "Transfer could not be completed. KMFBinary platform balance was restored."

                });

            }


            // ------------------------------------------------
            // RECORD PLATFORM TRANSFER
            // ------------------------------------------------

            const {
                data: platformTransaction,
                error: platformTransactionError
            } = await supabase
                .from("platform_transactions")
                .insert({

                    platform_wallet_id:
                        platformWallet.id,

                    user_id:
                        userId,

                    direction:
                        "kmf_to_user",

                    amount:
                        transferAmount,

                    platform_balance_before:
                        platformBalanceBefore,

                    platform_balance_after:
                        platformBalanceAfter,

                    user_balance_before:
                        userBalanceBefore,

                    user_balance_after:
                        userBalanceAfter,

                    reference:
                        reference,

                    reason:
                        transferReason,

                    performed_by:
                        req.user.id

                })
                .select("*")
                .single();


            if (
                platformTransactionError
            ) {

                console.error(
                    "KMF TO USER - TRANSACTION RECORD ERROR:",
                    platformTransactionError
                );


                // --------------------------------------------
                // ROLLBACK USER BALANCE
                // --------------------------------------------

                await supabase
                    .from("wallets")
                    .update({
                        balance:
                            userBalanceBefore,
                        updated_at:
                            new Date().toISOString()
                    })
                    .eq(
                        "id",
                        userWallet.id
                    )
                    .eq(
                        "balance",
                        userBalanceAfter
                    );


                // --------------------------------------------
                // ROLLBACK PLATFORM BALANCE
                // --------------------------------------------

                await supabase
                    .from("platform_wallet")
                    .update({
                        balance:
                            platformBalanceBefore,
                        updated_at:
                            new Date().toISOString()
                    })
                    .eq(
                        "id",
                        platformWallet.id
                    )
                    .eq(
                        "balance",
                        platformBalanceAfter
                    );


                return res.status(500).json({

                    success:
                        false,

                    message:
                        "Transfer record could not be created. Balances were restored."

                });

            }


            // ------------------------------------------------
            // AUDIT LOG
            // ------------------------------------------------

            await supabase
                .from("audit_logs")
                .insert({

                    user_id:
                        req.user.id,

                    action:
                        "owner_kmf_to_user_transfer",

                    entity_type:
                        "platform_transfer",

                    entity_id:
                        platformTransaction.id,

                    notes:
                        `Owner transferred $${transferAmount.toFixed(6)} from KMFBinary to user wallet.`,

                    metadata: {

                        reference:
                            reference,

                        target_user_id:
                            userId,

                        amount:
                            transferAmount,

                        platform_balance_before:
                            platformBalanceBefore,

                        platform_balance_after:
                            platformBalanceAfter,

                        user_balance_before:
                            userBalanceBefore,

                        user_balance_after:
                            userBalanceAfter,

                        reason:
                            transferReason

                    }

                });


            return res.json({

                success:
                    true,

                message:
                    "Funds successfully transferred from KMFBinary to user wallet.",

                reference:
                    reference,

                transfer: {

                    direction:
                        "kmf_to_user",

                    amount:
                        transferAmount,

                    platformBalanceBefore:
                        platformBalanceBefore,

                    platformBalanceAfter:
                        platformBalanceAfter,

                    userBalanceBefore:
                        userBalanceBefore,

                    userBalanceAfter:
                        userBalanceAfter,

                    reason:
                        transferReason

                }

            });

        } catch (error) {

            console.error(
                "KMF TO USER TRANSFER ERROR:",
                error
            );

            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to complete KMFBinary to User transfer."

            });

        }

    }
);
    // ==========================================
    // OWNER CONTROL STATUS
    // ==========================================

    app.get(
        "/api/admin/owner/status",
        authenticateUser,
        requireOwner,
        async (req, res) => {

            return res.json({

                success: true,

                owner: {
                    id:
                        req.user.id,

                    email:
                        req.user.email,

                    role:
                        req.adminRole
                },

                controls: {

                    walletBalances: true,

                    deposits: true,

                    withdrawals: true,

                    trades: true,

                    markets: true,

                    users: true,

                    adminRoles: true,

                    superAdminRoles: true
                }
            });
        }
    );


    // ==========================================
    // CUSTOMER CARE ADMIN
    // ==========================================


    // ==========================================
    // GET SUPPORT CONVERSATIONS
    // ==========================================

    app.get(
        "/api/admin/support/conversations",
        authenticateUser,
        requireAdmin,
        async (req, res) => {

            try {

                const status =
                    String(
                        req.query.status ||
                        "open"
                    )
                        .trim()
                        .toLowerCase();


                if (
                    status !== "open" &&
                    status !== "closed" &&
                    status !== "all"
                ) {

                    return res.status(400).json({

                        success:
                            false,

                        message:
                            "Invalid conversation status"

                    });

                }


                let query =
                    supabase
                        .from(
                            "support_conversations"
                        )
                        .select("*")
                        .order(
                            "updated_at",
                            {
                                ascending:
                                    false
                            }
                        )
                        .limit(200);


                if (
                    status !== "all"
                ) {

                    query =
                        query.eq(
                            "status",
                            status
                        );

                }


                const {
                    data: conversations,
                    error
                } =
                    await query;


                if (error) {

                    console.error(
                        "Admin support conversations error:",
                        error
                    );

                    return res.status(500).json({

                        success:
                            false,

                        message:
                            "Unable to load support conversations"

                    });

                }


                const conversationList =
                    conversations || [];


                // ==========================================
                // LOAD CUSTOMER PROFILES
                // ==========================================

                const userIds =
                    [
                        ...new Set(
                            conversationList
                                .map(
                                    conversation =>
                                        conversation.user_id
                                )
                                .filter(Boolean)
                        )
                    ];


                let profiles = [];


                if (
                    userIds.length
                ) {

                    const {
                        data,
                        error:
                            profileError
                    } =
                        await supabase
                            .from(
                                "profiles"
                            )
                            .select(
                                "id, username, full_name, country, role"
                            )
                            .in(
                                "id",
                                userIds
                            );


                    if (
                        profileError
                    ) {

                        console.error(
                            "Admin support profile lookup error:",
                            profileError
                        );

                    }
                    else {

                        profiles =
                            data || [];

                    }

                }


                const profileMap =
                    {};


                profiles.forEach(
                    profile => {

                        profileMap[
                            profile.id
                        ] =
                            profile;

                    }
                );


                // ==========================================
                // LOAD SUPPORT MESSAGES
                // ==========================================

                const conversationIds =
                    conversationList
                        .map(
                            conversation =>
                                conversation.id
                        )
                        .filter(Boolean);


                let messages = [];


                if (
                    conversationIds.length
                ) {

                    const {
                        data,
                        error:
                            messageError
                    } =
                        await supabase
                            .from(
                                "support_messages"
                            )
                            .select("*")
                            .in(
                                "conversation_id",
                                conversationIds
                            )
                            .order(
                                "created_at",
                                {
                                    ascending:
                                        false
                                }
                            );


                    if (
                        messageError
                    ) {

                        console.error(
                            "Admin support message lookup error:",
                            messageError
                        );

                    }
                    else {

                        messages =
                            data || [];

                    }

                }


                const lastMessageMap =
                    {};

                const unreadMap =
                    {};


                messages.forEach(
                    message => {

                        const conversationId =
                            message.conversation_id;


                        if (
                            !lastMessageMap[
                                conversationId
                            ]
                        ) {

                            lastMessageMap[
                                conversationId
                            ] =
                                message;

                        }


                        if (
                            message.sender_type ===
                                "customer" &&
                            !message.read_at
                        ) {

                            unreadMap[
                                conversationId
                            ] =
                                (
                                    unreadMap[
                                        conversationId
                                    ] ||
                                    0
                                ) + 1;

                        }

                    }
                );


                const result =
                    conversationList.map(
                        conversation => ({

                            ...conversation,

                            customer:
                                profileMap[
                                    conversation.user_id
                                ] ||
                                null,

                            lastMessage:
                                lastMessageMap[
                                    conversation.id
                                ] ||
                                null,

                            unreadCount:
                                unreadMap[
                                    conversation.id
                                ] ||
                                0

                        })
                    );


                return res.json({

                    success:
                        true,

                    conversations:
                        result

                });

            }

            catch (error) {

                console.error(
                    "Admin support conversations exception:",
                    error
                );

                return res.status(500).json({

                    success:
                        false,

                    message:
                        "Unable to load support conversations"

                });

            }

        }
    );


    // ==========================================
    // GET SUPPORT CONVERSATION MESSAGES
    // ==========================================

    app.get(
        "/api/admin/support/conversations/:id/messages",
        authenticateUser,
        requireAdmin,
        async (req, res) => {

            try {

                const conversationId =
                    String(
                        req.params.id ||
                        ""
                    ).trim();


                if (
                    !conversationId
                ) {

                    return res.status(400).json({

                        success:
                            false,

                        message:
                            "Conversation ID is required"

                    });

                }


                const {
                    data: conversation,
                    error:
                        conversationError
                } =
                    await supabase
                        .from(
                            "support_conversations"
                        )
                        .select("*")
                        .eq(
                            "id",
                            conversationId
                        )
                        .maybeSingle();


                if (
                    conversationError
                ) {

                    console.error(
                        "Admin support conversation lookup error:",
                        conversationError
                    );

                    return res.status(500).json({

                        success:
                            false,

                        message:
                            "Unable to load conversation"

                    });

                }


                if (
                    !conversation
                ) {

                    return res.status(404).json({

                        success:
                            false,

                        message:
                            "Conversation not found"

                    });

                }


                const {
                    data: messages,
                    error:
                        messageError
                } =
                    await supabase
                        .from(
                            "support_messages"
                        )
                        .select("*")
                        .eq(
                            "conversation_id",
                            conversationId
                        )
                        .order(
                            "created_at",
                            {
                                ascending:
                                    true
                            }
                        );


                if (
                    messageError
                ) {

                    console.error(
                        "Admin support messages error:",
                        messageError
                    );

                    return res.status(500).json({

                        success:
                            false,

                        message:
                            "Unable to load conversation messages"

                    });

                }


                const {
                    data: customer,
                    error:
                        customerError
                } =
                    await supabase
                        .from(
                            "profiles"
                        )
                        .select(
                            "id, username, full_name, country, role"
                        )
                        .eq(
                            "id",
                            conversation.user_id
                        )
                        .maybeSingle();


                if (
                    customerError
                ) {

                    console.error(
                        "Admin support customer lookup error:",
                        customerError
                    );

                }


                return res.json({

                    success:
                        true,

                    conversation,

                    customer:
                        customer ||
                        null,

                    messages:
                        messages ||
                        []

                });

            }

            catch (error) {

                console.error(
                    "Admin support messages exception:",
                    error
                );

                return res.status(500).json({

                    success:
                        false,

                    message:
                        "Unable to load conversation messages"

                });

            }

        }
    );


    // ==========================================
    // ADMIN SEND SUPPORT REPLY
    // ==========================================

    app.post(
        "/api/admin/support/conversations/:id/messages",
        authenticateUser,
        requireAdmin,
        async (req, res) => {

            try {

                const conversationId =
                    String(
                        req.params.id ||
                        ""
                    ).trim();


                const message =
                    String(
                        req.body &&
                        req.body.message ||
                        ""
                    ).trim();


                if (
                    !conversationId
                ) {

                    return res.status(400).json({

                        success:
                            false,

                        message:
                            "Conversation ID is required"

                    });

                }


                if (
                    !message
                ) {

                    return res.status(400).json({

                        success:
                            false,

                        message:
                            "Message cannot be empty"

                    });

                }


                if (
                    message.length >
                    2000
                ) {

                    return res.status(400).json({

                        success:
                            false,

                        message:
                            "Message is too long"

                    });

                }


                const {
                    data: conversation,
                    error:
                        conversationError
                } =
                    await supabase
                        .from(
                            "support_conversations"
                        )
                        .select("*")
                        .eq(
                            "id",
                            conversationId
                        )
                        .maybeSingle();


                if (
                    conversationError
                ) {

                    console.error(
                        "Admin support reply conversation lookup error:",
                        conversationError
                    );

                    return res.status(500).json({

                        success:
                            false,

                        message:
                            "Unable to load conversation"

                    });

                }


                if (
                    !conversation
                ) {

                    return res.status(404).json({

                        success:
                            false,

                        message:
                            "Conversation not found"

                    });

                }


                if (
                    conversation.status !==
                    "open"
                ) {

                    return res.status(400).json({

                        success:
                            false,

                        message:
                            "This conversation is closed"

                    });

                }


                const {
                    data: newMessage,
                    error:
                        messageError
                } =
                    await supabase
                        .from(
                            "support_messages"
                        )
                        .insert({

                            conversation_id:
                                conversationId,

                            sender_id:
                                req.user.id,

                            sender_type:
                                "support",

                            message:
                                message

                        })
                        .select()
                        .single();


                if (
                    messageError
                ) {

                    console.error(
                        "Admin support reply insert error:",
                        messageError
                    );

                    return res.status(500).json({

                        success:
                            false,

                        message:
                            "Unable to send support reply"

                    });

                }


                const {
                    data:
                        updatedConversation,
                    error:
                        updateError
                } =
                    await supabase
                        .from(
                            "support_conversations"
                        )
                        .update({

                            updated_at:
                                new Date()
                                    .toISOString()

                        })
                        .eq(
                            "id",
                            conversationId
                        )
                        .select()
                        .single();


                if (
                    updateError
                ) {

                    console.error(
                        "Admin support conversation update error:",
                        updateError
                    );

                }


                console.log(
                    `ADMIN SUPPORT REPLY: admin=${req.user.id} conversation=${conversationId}`
                );


                return res.json({

                    success:
                        true,

                    message:
                        newMessage,

                    conversation:
                        updatedConversation ||
                        conversation

                });

            }

            catch (error) {

                console.error(
                    "Admin support reply exception:",
                    error
                );

                return res.status(500).json({

                    success:
                        false,

                    message:
                        "Unable to send support reply"

                });

            }

        }
    );


    // ==========================================
    // MARK CUSTOMER MESSAGES AS READ
    // ==========================================

    app.patch(
        "/api/admin/support/conversations/:id/read",
        authenticateUser,
        requireAdmin,
        async (req, res) => {

            try {

                const conversationId =
                    String(
                        req.params.id ||
                        ""
                    ).trim();


                if (
                    !conversationId
                ) {

                    return res.status(400).json({

                        success:
                            false,

                        message:
                            "Conversation ID is required"

                    });

                }


                const {
                    data: conversation,
                    error:
                        conversationError
                } =
                    await supabase
                        .from(
                            "support_conversations"
                        )
                        .select("id")
                        .eq(
                            "id",
                            conversationId
                        )
                        .maybeSingle();


                if (
                    conversationError
                ) {

                    console.error(
                        "Admin support read conversation error:",
                        conversationError
                    );

                    return res.status(500).json({

                        success:
                            false,

                        message:
                            "Unable to verify conversation"

                    });

                }


                if (
                    !conversation
                ) {

                    return res.status(404).json({

                        success:
                            false,

                        message:
                            "Conversation not found"

                    });

                }


                const {
                    data,
                    error
                } =
                    await supabase
                        .from(
                            "support_messages"
                        )
                        .update({

                            read_at:
                                new Date()
                                    .toISOString()

                        })
                        .eq(
                            "conversation_id",
                            conversationId
                        )
                        .eq(
                            "sender_type",
                            "customer"
                        )
                        .is(
                            "read_at",
                            null
                        )
                        .select();


                if (
                    error
                ) {

                    console.error(
                        "Admin support mark read error:",
                        error
                    );

                    return res.status(500).json({

                        success:
                            false,

                        message:
                            "Unable to mark messages as read"

                    });

                }


                return res.json({

                    success:
                        true,

                    updated:
                        (data || [])
                            .length

                });

            }

            catch (error) {

                console.error(
                    "Admin support mark read exception:",
                    error
                );

                return res.status(500).json({

                    success:
                        false,

                    message:
                        "Unable to mark messages as read"

                });

            }

        }
    );


    // ==========================================
    // CLOSE SUPPORT CONVERSATION
    // ==========================================

    app.patch(
        "/api/admin/support/conversations/:id/close",
        authenticateUser,
        requireAdmin,
        async (req, res) => {

            try {

                const conversationId =
                    String(
                        req.params.id ||
                        ""
                    ).trim();


                if (
                    !conversationId
                ) {

                    return res.status(400).json({

                        success:
                            false,

                        message:
                            "Conversation ID is required"

                    });

                }


                const {
                    data: conversation,
                    error:
                        conversationError
                } =
                    await supabase
                        .from(
                            "support_conversations"
                        )
                        .select("*")
                        .eq(
                            "id",
                            conversationId
                        )
                        .maybeSingle();


                if (
                    conversationError
                ) {

                    console.error(
                        "Admin close conversation lookup error:",
                        conversationError
                    );

                    return res.status(500).json({

                        success:
                            false,

                        message:
                            "Unable to load conversation"

                    });

                }


                if (
                    !conversation
                ) {

                    return res.status(404).json({

                        success:
                            false,

                        message:
                            "Conversation not found"

                    });

                }


                const {
                    data: updatedConversation,
                    error:
                        updateError
                } =
                    await supabase
                        .from(
                            "support_conversations"
                        )
                        .update({

                            status:
                                "closed",

                            updated_at:
                                new Date()
                                    .toISOString()

                        })
                        .eq(
                            "id",
                            conversationId
                        )
                        .select()
                        .single();


                if (
                    updateError
                ) {

                    console.error(
                        "Admin close conversation error:",
                        updateError
                    );

                    return res.status(500).json({

                        success:
                            false,

                        message:
                            "Unable to close conversation"

                    });

                }


                console.log(
                    `ADMIN SUPPORT CLOSED: admin=${req.user.id} conversation=${conversationId}`
                );


                return res.json({

                    success:
                        true,

                    conversation:
                        updatedConversation

                });

            }

            catch (error) {

                console.error(
                    "Admin close conversation exception:",
                    error
                );

                return res.status(500).json({

                    success:
                        false,

                    message:
                        "Unable to close conversation"

                });

            }

        }
    );


    // ==========================================
    // REOPEN SUPPORT CONVERSATION
    // ==========================================

    app.patch(
        "/api/admin/support/conversations/:id/reopen",
        authenticateUser,
        requireAdmin,
        async (req, res) => {

            try {

                const conversationId =
                    String(
                        req.params.id ||
                        ""
                    ).trim();


                if (
                    !conversationId
                ) {

                    return res.status(400).json({

                        success:
                            false,

                        message:
                            "Conversation ID is required"

                    });

                }


                const {
                    data: updatedConversation,
                    error
                } =
                    await supabase
                        .from(
                            "support_conversations"
                        )
                        .update({

                            status:
                                "open",

                            updated_at:
                                new Date()
                                    .toISOString()

                        })
                        .eq(
                            "id",
                            conversationId
                        )
                        .select()
                        .maybeSingle();


                if (
                    error
                ) {

                    console.error(
                        "Admin reopen conversation error:",
                        error
                    );

                    return res.status(500).json({

                        success:
                            false,

                        message:
                            "Unable to reopen conversation"

                    });

                }


                if (
                    !updatedConversation
                ) {

                    return res.status(404).json({

                        success:
                            false,

                        message:
                            "Conversation not found"

                    });

                }


                console.log(
                    `ADMIN SUPPORT REOPENED: admin=${req.user.id} conversation=${conversationId}`
                );


                return res.json({

                    success:
                        true,

                    conversation:
                        updatedConversation

                });

            }

            catch (error) {

                console.error(
                    "Admin reopen conversation exception:",
                    error
                );

                return res.status(500).json({

                    success:
                        false,

                    message:
                        "Unable to reopen conversation"

                });

            }

        }
    );


    // ==========================================
    // END CUSTOMER CARE ADMIN
    // ==========================================


    // ==========================================
    // SECURITY
    // ==========================================
    //
    // OWNER IS THE HIGHEST PRIVILEGE LEVEL.
    //
    // OWNER ACCOUNT ITSELF REMAINS PROTECTED.
    //
    // No route allows:
    //
    // - Owner self-promotion
    // - Owner deletion
    // - Modification of Owner role
    // - Creation of another Owner
    //
    // Wallet balance modification is Owner-only.
    //
    // Every Owner wallet modification:
    //
    // - changes LIVE balance only
    // - records a wallet transaction
    // - records before/after balances
    // - generates a unique reference
    // - requires a reason
    // - uses authenticated Owner identity
    //
    // CUSTOMER CARE:
    //
    // - Customers can access only their own conversations
    // - Admins can view conversations
    // - Admins can reply
    // - Admins can mark customer messages as read
    // - Admins can close conversations
    // - Admins can reopen conversations
    //
    // ==========================================

}

module.exports = registerAdminRoutes;