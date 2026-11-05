"use strict";

const crypto = require("crypto");

const { query } = require("./db");
const fs = require("fs");
const path = require("path");

const PRIVATE_KYC_DIR = path.resolve(
    __dirname,
    "..",
    "..",
    "KMFBinary-private-kyc"
);

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
// GET ADMIN PROFILE — NEON
// ==========================================

async function getAdminProfile(userId) {
    if (!userId) {
        return {
            profile: null,
            error: new Error("User ID is missing")
        };
    }

    try {
        const result = await query(
            `SELECT id, username, full_name, country, role
             FROM profiles
             WHERE id = $1
             LIMIT 1`,
            [userId]
        );

        return {
            profile: result.rows[0] || null,
            error: null
        };
    } catch (error) {
        return {
            profile: null,
            error
        };
    }
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
    // ADMIN USER LIST — NEON
    // ==========================================

    app.get(
        "/api/admin/users",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
                const limit = Math.min(
                    Math.max(Number(req.query.limit) || 100, 1),
                    500
                );

                const result = await query(
                    `SELECT id, username, full_name, country, role
                     FROM profiles
                     ORDER BY username ASC NULLS LAST
                     LIMIT $1`,
                    [limit]
                );

                return res.json({
                    success: true,
                    users: result.rows
                });
            } catch (error) {
                console.error("Admin user list error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to load users"
                });
            }
        }
    );

    // ==========================================
    // ADMIN DASHBOARD — NEON
    // ==========================================

    app.get(
        "/api/admin/dashboard",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            const runDashboardQuery = async (name, sql, params = []) => {
                try {
                    return await query(sql, params);
                } catch (error) {
                    console.error(`[ADMIN DASHBOARD FAILED: ${name}]`, {
                        message: error.message,
                        code: error.code,
                        detail: error.detail,
                        hint: error.hint,
                        position: error.position
                    });

                    throw error;
                }
            };

            try {
                const usersResult = await runDashboardQuery(
                    "users",
                    `SELECT COUNT(*)::int AS count FROM profiles`
                );

                const walletsResult = await runDashboardQuery(
                    "wallets",
                    `SELECT COUNT(*)::int AS count FROM wallets`
                );

                const tradesResult = await runDashboardQuery(
                    "trades",
                    `SELECT COUNT(*)::int AS count FROM trades`
                );

                const pendingDepositsResult = await runDashboardQuery(
                    "pending deposits",
                    `SELECT COUNT(*)::int AS count
                     FROM wallet_transactions
                     WHERE transaction_type = $1 AND status = $2`,
                    ["deposit", "pending"]
                );

               const pendingWithdrawalsResult = await runDashboardQuery(
    "pending withdrawals",
    `SELECT COUNT(*)::int AS count
     FROM wallet_transactions
     WHERE transaction_type = $1 AND status = $2`,
    ["withdrawal", "pending"]
);

const pendingVerificationsResult = await runDashboardQuery(
    "pending verifications",
    `SELECT COUNT(*)::int AS count
     FROM kyc_verifications
     WHERE status = $1`,
    ["pending"]
);

                const marketsResult = await runDashboardQuery(
                    "markets",
                    `SELECT id, symbol, market_name, contract_type, is_active
                     FROM markets
                     ORDER BY symbol`
                );

                return res.json({
                    success: true,
                    adminRole: req.adminRole,
                    stats: {
                        users: usersResult.rows[0].count,
                        wallets: walletsResult.rows[0].count,
                        trades: tradesResult.rows[0].count,
                        pendingDeposits: pendingDepositsResult.rows[0].count,
                        pendingWithdrawals: pendingWithdrawalsResult.rows[0].count,
pendingVerifications: pendingVerificationsResult.rows[0].count
                    },
                    markets: marketsResult.rows
                });
            } catch (error) {
                console.error("Admin dashboard error:", error.message);

                return res.status(500).json({
                    success: false,
                    message: "Unable to load admin dashboard",
                    error: process.env.NODE_ENV === "production"
                        ? undefined
                        : error.message,
                    code: process.env.NODE_ENV === "production"
                        ? undefined
                        : error.code
                });
            }
        }
    );

    // ==========================================
    // KYC VERIFICATION REVIEW — NEON
    // ==========================================

    const isValidKycId = (id) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            String(id || "")
        );

    // List real verification records and summary counts.
    app.get(
        "/api/admin/kyc-verifications",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
                const [recordsResult, countsResult] = await Promise.all([
                    query(
                        `SELECT
                            kv.id,
                            kv.user_id,
                            kv.status,
                            kv.full_legal_name,
                            kv.date_of_birth,
                            kv.country_of_residence,
                            kv.phone_number,
                            kv.residential_address,
                            kv.declaration_accepted,
                            kv.rejection_reason,
                            kv.reviewed_by,
                            kv.reviewed_at,
                            kv.created_at,
                            kv.updated_at,
                            kv.kra_report_uploaded_at,
                           (kv.kra_report_path IS NOT NULL
    AND kv.kra_report_path <> '') AS has_kra_report,

(kv.id_front_path IS NOT NULL
    AND kv.id_front_path <> '') AS has_id_front,

(kv.id_back_path IS NOT NULL
    AND kv.id_back_path <> '') AS has_id_back,

(kv.proof_of_address_path IS NOT NULL
    AND kv.proof_of_address_path <> '') AS has_proof_of_address,
                            p.username,
                            p.full_name
                         FROM kyc_verifications kv
                         LEFT JOIN profiles p ON p.id = kv.user_id
                         ORDER BY
                            CASE WHEN kv.status = 'pending' THEN 0 ELSE 1 END,
                            kv.created_at DESC
                         LIMIT 500`
                    ),
                    query(
                        `SELECT
                            COUNT(*) FILTER (
                                WHERE status = 'pending'
                            )::int AS pending,
                            COUNT(*) FILTER (
                                WHERE status = 'approved'
                            )::int AS approved,
                            COUNT(*) FILTER (
                                WHERE status = 'rejected'
                            )::int AS rejected
                         FROM kyc_verifications`
                    )
                ]);

                return res.json({
                    success: true,
                    counts: countsResult.rows[0],
                    verifications: recordsResult.rows
                });
            } catch (error) {
                console.error("Admin KYC list error:", error.message);
                return res.status(500).json({
                    success: false,
                    message: "Unable to load verification records"
                });
            }
        }
    );

    // View the private KRA PDF without exposing its filesystem path.
    app.get(
        "/api/admin/kyc-verifications/:id/kra-report",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
                const id = String(req.params.id || "");

                if (!isValidKycId(id)) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid verification ID"
                    });
                }

                const result = await query(
                    `SELECT kra_report_path
                     FROM kyc_verifications
                     WHERE id = $1
                     LIMIT 1`,
                    [id]
                );

                if (!result.rows.length || !result.rows[0].kra_report_path) {
                    return res.status(404).json({
                        success: false,
                        message: "KRA report not found"
                    });
                }

                const filename = result.rows[0].kra_report_path;

                // Accept only the generated UUID PDF filenames.
                if (
                    typeof filename !== "string" ||
                    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/i.test(filename)
                ) {
                    return res.status(404).json({
                        success: false,
                        message: "KRA report file is unavailable"
                    });
                }

                const filePath = path.resolve(PRIVATE_KYC_DIR, filename);
                const relativePath = path.relative(PRIVATE_KYC_DIR, filePath);

                if (
                    relativePath.startsWith("..") ||
                    path.isAbsolute(relativePath)
                ) {
                    return res.status(403).json({
                        success: false,
                        message: "Invalid document path"
                    });
                }

                await fs.promises.access(filePath, fs.constants.R_OK);

                res.setHeader("Content-Type", "application/pdf");
                res.setHeader(
                    "Content-Disposition",
                    'inline; filename="kra-report.pdf"'
                );
                res.setHeader("Cache-Control", "private, no-store");
                res.setHeader("X-Content-Type-Options", "nosniff");

                const stream = fs.createReadStream(filePath);

                stream.on("error", (error) => {
                    console.error("KRA report stream error:", error.message);

                    if (!res.headersSent) {
                        res.status(500).end("Unable to open KRA report");
                    } else {
                        res.destroy(error);
                    }
                });

                return stream.pipe(res);
            } catch (error) {
                if (error.code === "ENOENT" || error.code === "EACCES") {
                    return res.status(404).json({
                        success: false,
                        message: "KRA report file is unavailable"
                    });
                }

                console.error("Admin KYC document error:", error.message);

                return res.status(500).json({
                    success: false,
                    message: "Unable to open KRA report"
                });
            }
        }
    );
    // View private KYC identity and residence images.
    app.get(
        "/api/admin/kyc-verifications/:id/document/:documentType",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
                const id = String(req.params.id || "");
                const documentType = String(
                    req.params.documentType || ""
                );

                if (!isValidKycId(id)) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid verification ID"
                    });
                }

                // Only these predefined database columns are allowed.
                const allowedDocuments = {
                    id_front: {
                        column: "id_front_path",
                        title: "id-front"
                    },
                    id_back: {
                        column: "id_back_path",
                        title: "id-back"
                    },
                    proof_of_address: {
                        column: "proof_of_address_path",
                        title: "proof-of-address"
                    }
                };

                const document = allowedDocuments[documentType];

                if (!document) {
                    return res.status(400).json({
                        success: false,
                        message: "Unsupported document type"
                    });
                }

                const result = await query(
                    `SELECT ${document.column} AS filename
                     FROM kyc_verifications
                     WHERE id = $1
                     LIMIT 1`,
                    [id]
                );

                if (
                    !result.rows.length ||
                    !result.rows[0].filename
                ) {
                    return res.status(404).json({
                        success: false,
                        message: "KYC document not found"
                    });
                }

                const filename = result.rows[0].filename;

                // Accept only generated UUID image filenames.
                const filenameMatch =
                    typeof filename === "string" &&
                    filename.match(
                        /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(jpg|png|webp)$/i
                    );

                if (!filenameMatch) {
                    return res.status(404).json({
                        success: false,
                        message: "KYC document file is unavailable"
                    });
                }

                const extension = filenameMatch[2].toLowerCase();

                const contentTypes = {
                    jpg: "image/jpeg",
                    png: "image/png",
                    webp: "image/webp"
                };

                const filePath = path.resolve(
                    PRIVATE_KYC_DIR,
                    filename
                );

                const relativePath = path.relative(
                    PRIVATE_KYC_DIR,
                    filePath
                );

                if (
                    relativePath.startsWith("..") ||
                    path.isAbsolute(relativePath)
                ) {
                    return res.status(403).json({
                        success: false,
                        message: "Invalid document path"
                    });
                }

                await fs.promises.access(
                    filePath,
                    fs.constants.R_OK
                );

                res.setHeader(
                    "Content-Type",
                    contentTypes[extension]
                );
                res.setHeader(
                    "Content-Disposition",
                    `inline; filename="${document.title}.${extension}"`
                );
                res.setHeader("Cache-Control", "private, no-store");
                res.setHeader("X-Content-Type-Options", "nosniff");
                res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");

                const stream = fs.createReadStream(filePath);

                stream.on("error", (error) => {
                    console.error(
                        "Private KYC image stream error:",
                        error.message
                    );

                    if (!res.headersSent) {
                        res.status(500).end(
                            "Unable to open KYC document"
                        );
                    } else {
                        res.destroy(error);
                    }
                });

                return stream.pipe(res);
            } catch (error) {
                if (
                    error.code === "ENOENT" ||
                    error.code === "EACCES"
                ) {
                    return res.status(404).json({
                        success: false,
                        message: "KYC document file is unavailable"
                    });
                }

                console.error(
                    "Admin KYC image error:",
                    error.message
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to open KYC document"
                });
            }
        }
    );
    // Approve a pending verification.
    app.patch(
        "/api/admin/kyc-verifications/:id/approve",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
                const id = String(req.params.id || "");

                if (!isValidKycId(id)) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid verification ID"
                    });
                }

                const result = await query(
                    `UPDATE kyc_verifications
                     SET status = 'approved',
                         rejection_reason = NULL,
                         reviewed_by = $2,
                         reviewed_at = NOW(),
                         updated_at = NOW()
                     WHERE id = $1
                       AND status = 'pending'
                     RETURNING id, user_id, status, reviewed_at`,
                    [id, req.user.id]
                );

                if (!result.rows.length) {
                    return res.status(409).json({
                        success: false,
                        message: "Record not found or already reviewed"
                    });
                }

                return res.json({
                    success: true,
                    message: "Verification approved",
                    verification: result.rows[0]
                });
            } catch (error) {
                console.error("KYC approval error:", error.message);

                return res.status(500).json({
                    success: false,
                    message: "Unable to approve verification"
                });
            }
        }
    );

 
    // Reject a pending KYC verification with a clear reason.
    app.patch(
        "/api/admin/kyc-verifications/:id/reject",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
                const id = String(req.params.id || "");
                const reasonCode = String(
                    (req.body && req.body.reason_code) || ""
                ).trim();

                const customReason = String(
                    (req.body && req.body.rejection_reason) || ""
                ).trim();

                if (!isValidKycId(id)) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid verification ID"
                    });
                }

                const rejectionReasons = {
                    id_front_unclear:
                        "The front of your identification document is blurry, cropped, or unreadable. Please upload a clear, complete image with all details visible.",

                    id_back_unclear:
                        "The back of your identification document is blurry, incomplete, or unreadable. Please upload a clear image of the entire back side.",

                    dob_mismatch:
                        "The date of birth in your application does not match your identification document. Please check your details and correct any errors before resubmitting.",

                    kra_unsigned:
                        "Your submitted KRA document appears to be missing a required signature. Please upload a complete, signed document where a signature is required.",

                    kra_mismatch:
                        "The information on your KRA document could not be matched with the details provided in your application. Please verify that the document belongs to you and that your information is accurate.",

                    proof_of_residence_invalid:
                        "Your proof of residence could not be accepted because it is unclear, incomplete, outdated, or does not meet the verification requirements. Please upload a valid, readable document showing your residential address.",

                    name_mismatch:
                        "The name on your identification document does not match the full legal name entered in your application. Please check your details and correct any discrepancies.",

                    id_expired:
                        "Your identification document appears to be expired or invalid. Please provide a valid, acceptable document.",

                    missing_documents:
                        "One or more required documents are missing or incomplete. Please upload all requested documents before resubmitting.",

                    other: customReason
                };

                if (!Object.prototype.hasOwnProperty.call(
                    rejectionReasons,
                    reasonCode
                )) {
                    return res.status(400).json({
                        success: false,
                        message: "Select a valid KYC rejection reason"
                    });
                }

                const reason = rejectionReasons[reasonCode];

                if (
                    typeof reason !== "string" ||
                    reason.trim().length < 10 ||
                    reason.trim().length > 1000
                ) {
                    return res.status(400).json({
                        success: false,
                        message: reasonCode === "other"
                            ? "Enter a specific explanation between 10 and 1000 characters"
                            : "The rejection reason is invalid"
                    });
                }

                const result = await query(
                    `UPDATE kyc_verifications
                     SET status = 'rejected',
                         rejection_reason = $2,
                         reviewed_by = $3,
                         reviewed_at = NOW(),
                         updated_at = NOW()
                     WHERE id = $1
                       AND status = 'pending'
                     RETURNING id, user_id, status,
                               rejection_reason, reviewed_at`,
                    [id, reason.trim(), req.user.id]
                );

                if (!result.rows.length) {
                    return res.status(409).json({
                        success: false,
                        message: "Record not found or already reviewed"
                    });
                }

                return res.json({
                    success: true,
                    message: "Verification rejected with corrective feedback",
                    verification: result.rows[0]
                });
            } catch (error) {
                console.error(
                    "KYC rejection error:",
                    error.message
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to reject verification"
                });
            }
        }
    );

        // ==========================================
    // ROLE MANAGEMENT — NEON
    // ==========================================

    app.patch(
        "/api/admin/users/:id/role",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
                const targetUserId = String(req.params.id || "").trim();
                const requestedRole = normalizeRole(req.body && req.body.role);

                if (!targetUserId) {
                    return res.status(400).json({
                        success: false,
                        message: "Target user ID is required"
                    });
                }

                if (!VALID_ROLES.includes(requestedRole)) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid role. Allowed roles: user, admin, super_admin, owner"
                    });
                }

                if (targetUserId === req.user.id) {
                    return res.status(403).json({
                        success: false,
                        message: "You cannot change your own role"
                    });
                }

                const targetResult = await query(
                    `SELECT id, username, full_name, country, role
                     FROM profiles
                     WHERE id = $1
                     LIMIT 1`,
                    [targetUserId]
                );

                const targetProfile = targetResult.rows[0];

                if (!targetProfile) {
                    return res.status(404).json({
                        success: false,
                        message: "Target user not found"
                    });
                }

                const currentTargetRole = normalizeRole(targetProfile.role);

                if (currentTargetRole === "owner") {
                    return res.status(403).json({
                        success: false,
                        message: "The Owner account cannot be modified"
                    });
                }

                if (requestedRole === "owner") {
                    return res.status(403).json({
                        success: false,
                        message: "Owner role cannot be assigned through this route"
                    });
                }

                if (req.adminRole === "admin") {
                    return res.status(403).json({
                        success: false,
                        message: "Admin role management is not permitted"
                    });
                }

                if (req.adminRole === "super_admin") {
                    if (currentTargetRole === "super_admin") {
                        return res.status(403).json({
                            success: false,
                            message: "Super Admin cannot modify another Super Admin"
                        });
                    }

                    if (!["admin", "user"].includes(requestedRole)) {
                        return res.status(403).json({
                            success: false,
                            message: "Super Admin can only assign admin or user roles"
                        });
                    }
                }

                if (currentTargetRole === requestedRole) {
                    return res.status(400).json({
                        success: false,
                        message: `User already has the ${requestedRole} role`
                    });
                }

                const updateResult = await query(
                    `UPDATE profiles
                     SET role = $1
                     WHERE id = $2
                     RETURNING id, username, full_name, country, role, created_at`,
                    [requestedRole, targetUserId]
                );

                const updatedProfile = updateResult.rows[0];

                if (!updatedProfile) {
                    return res.status(404).json({
                        success: false,
                        message: "Target user not found"
                    });
                }

                console.log(
                    `ADMIN ROLE CHANGE: ${req.user.id} changed ${targetUserId} from ${currentTargetRole} to ${requestedRole}`
                );

                return res.json({
                    success: true,
                    message: `User role changed from ${currentTargetRole} to ${requestedRole}`,
                    user: updatedProfile,
                    changedBy: {
                        id: req.user.id,
                        role: req.adminRole
                    }
                });
            } catch (error) {
                console.error("Admin role management error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to change user role"
                });
            }
        }
    );
    // ==========================================
    // WALLETS — NEON
    // ==========================================

    app.get(
        "/api/admin/wallets",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
                const result = await query(
                    `SELECT *
                     FROM wallets
                     ORDER BY updated_at DESC`
                );

                return res.json({
                    success: true,
                    wallets: result.rows
                });
            } catch (error) {
                console.error("Admin wallets error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to load wallets"
                });
            }
        }
    );

        // ==========================================
    // TRADES — NEON
    // ==========================================

    app.get(
        "/api/admin/trades",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
                const limit = Math.min(
                    Math.max(Number(req.query.limit) || 100, 1),
                    500
                );

                const result = await query(
                    `SELECT *
                     FROM trades
                     ORDER BY created_at DESC
                     LIMIT $1`,
                    [limit]
                );

                return res.json({
                    success: true,
                    trades: result.rows
                });
            } catch (error) {
                console.error("Admin trades error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to load trades"
                });
            }
        }
    );
        // ==========================================
    // TRANSACTIONS — NEON
    // ==========================================

    app.get(
        "/api/admin/transactions",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
                const limit = Math.min(
                    Math.max(Number(req.query.limit) || 100, 1),
                    500
                );

                const result = await query(
                    `SELECT *
                     FROM wallet_transactions
                     ORDER BY created_at DESC
                     LIMIT $1`,
                    [limit]
                );

                return res.json({
                    success: true,
                    transactions: result.rows
                });
            } catch (error) {
                console.error("Admin transactions error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to load transactions"
                });
            }
        }
    );
    // ==========================================
    // PROMOTIONS — NEON
    // ==========================================

    app.get(
        "/api/admin/promotions",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
                const result = await query(
                    `SELECT *
                     FROM promotions
                     ORDER BY created_at DESC`
                );

                return res.json({
                    success: true,
                    promotions: result.rows
                });
            } catch (error) {
                console.error("Admin promotions error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to load promotions"
                });
            }
        }
    );

    app.get(
        "/api/admin/promotions/:id",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
                const result = await query(
                    `SELECT *
                     FROM promotions
                     WHERE id = $1
                     LIMIT 1`,
                    [req.params.id]
                );

                if (!result.rows.length) {
                    return res.status(404).json({
                        success: false,
                        message: "Promotion not found"
                    });
                }

                return res.json({
                    success: true,
                    promotion: result.rows[0]
                });
            } catch (error) {
                console.error("Admin promotion lookup error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to load promotion"
                });
            }
        }
    );

    app.patch(
        "/api/admin/promotions/:id",
        authenticateUser,
        requireSuperAdmin,
        async (req, res) => {
            try {
                const {
                    name,
                    bonus_percent,
                    min_deposit,
                    max_bonus,
                    active,
                    start_at,
                    expires_at
                } = req.body || {};

                const existingResult = await query(
                    `SELECT *
                     FROM promotions
                     WHERE id = $1
                     LIMIT 1`,
                    [req.params.id]
                );

                if (!existingResult.rows.length) {
                    return res.status(404).json({
                        success: false,
                        message: "Promotion not found"
                    });
                }

                const existing = existingResult.rows[0];

                const nextName =
                    name === undefined ? existing.name : String(name).trim();

                const nextBonusPercent =
                    bonus_percent === undefined
                        ? Number(existing.bonus_percent)
                        : Number(bonus_percent);

                const nextMinDeposit =
                    min_deposit === undefined
                        ? Number(existing.min_deposit)
                        : Number(min_deposit);

                const nextMaxBonus =
                    max_bonus === undefined
                        ? existing.max_bonus
                        : max_bonus;

                const nextActive =
                    active === undefined ? existing.active : active;

                const nextStartAt =
                    start_at === undefined ? existing.start_at : start_at;

                const nextExpiresAt =
                    expires_at === undefined ? existing.expires_at : expires_at;

                if (!nextName) {
                    return res.status(400).json({
                        success: false,
                        message: "Promotion name is required"
                    });
                }

                if (
                    !Number.isFinite(nextBonusPercent) ||
                    nextBonusPercent < 0 ||
                    nextBonusPercent > 100
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "Bonus percentage must be between 0 and 100"
                    });
                }

                if (
                    !Number.isFinite(nextMinDeposit) ||
                    nextMinDeposit < 0
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "Minimum deposit must be zero or greater"
                    });
                }

                if (
                    nextMaxBonus !== null &&
                    nextMaxBonus !== "" &&
                    (
                        !Number.isFinite(Number(nextMaxBonus)) ||
                        Number(nextMaxBonus) < 0
                    )
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "Maximum bonus must be zero or greater"
                    });
                }

                if (typeof nextActive !== "boolean") {
                    return res.status(400).json({
                        success: false,
                        message: "Active must be true or false"
                    });
                }

                if (
                    nextStartAt &&
                    nextExpiresAt &&
                    new Date(nextExpiresAt) < new Date(nextStartAt)
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "Expiry cannot be earlier than the start date"
                    });
                }

                const result = await query(
                    `UPDATE promotions
                     SET name = $1,
                         bonus_percent = $2,
                         min_deposit = $3,
                         max_bonus = $4,
                         active = $5,
                         start_at = $6,
                         expires_at = $7,
                         updated_at = NOW()
                     WHERE id = $8
                     RETURNING *`,
                    [
                        nextName,
                        nextBonusPercent,
                        nextMinDeposit,
                        nextMaxBonus === "" ? null : nextMaxBonus,
                        nextActive,
                        nextStartAt || null,
                        nextExpiresAt || null,
                        req.params.id
                    ]
                );

                return res.json({
                    success: true,
                    promotion: result.rows[0]
                });
            } catch (error) {
                console.error("Admin promotion update error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to update promotion"
                });
            }
        }
    );

    app.patch(
        "/api/admin/promotions/:id/status",
        authenticateUser,
        requireSuperAdmin,
        async (req, res) => {
            try {
                const { active } = req.body || {};

                if (typeof active !== "boolean") {
                    return res.status(400).json({
                        success: false,
                        message: "Active must be true or false"
                    });
                }

                const existingResult = await query(
                    `SELECT id, expires_at
                     FROM promotions
                     WHERE id = $1
                     LIMIT 1`,
                    [req.params.id]
                );

                const existing = existingResult.rows[0];

                if (!existing) {
                    return res.status(404).json({
                        success: false,
                        message: "Promotion not found"
                    });
                }

                if (
                    active &&
                    existing.expires_at &&
                    new Date(existing.expires_at) < new Date()
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "An expired promotion cannot be activated"
                    });
                }

                const result = await query(
                    `UPDATE promotions
                     SET active = $1,
                         updated_at = NOW()
                     WHERE id = $2
                     RETURNING *`,
                    [active, req.params.id]
                );

                return res.json({
                    success: true,
                    promotion: result.rows[0]
                });
            } catch (error) {
                console.error("Promotion status update error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to update promotion status"
                });
            }
        }
    );


    // ==========================================
    // USER BONUSES — NEON
    // ==========================================

    app.get(
        "/api/admin/user-bonuses",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
                const result = await query(
                    `SELECT
                         ub.*,
                         CASE
                             WHEN p.id IS NULL THEN NULL
                             ELSE json_build_object(
                                 'id', p.id,
                                 'name', p.name,
                                 'bonus_percent', p.bonus_percent,
                                 'active', p.active
                             )
                         END AS promotion
                     FROM user_bonuses ub
                     LEFT JOIN promotions p
                         ON p.id = ub.promotion_id
                     ORDER BY ub.created_at DESC
                     LIMIT 500`
                );

                return res.json({
                    success: true,
                    bonuses: result.rows
                });
            } catch (error) {
                console.error("Admin user bonuses error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to load user bonuses"
                });
            }
        }
    );

    app.get(
        "/api/admin/users/:id/bonuses",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
                const result = await query(
                    `SELECT
                         ub.*,
                         CASE
                             WHEN p.id IS NULL THEN NULL
                             ELSE json_build_object(
                                 'id', p.id,
                                 'name', p.name,
                                 'bonus_percent', p.bonus_percent,
                                 'active', p.active
                             )
                         END AS promotion
                     FROM user_bonuses ub
                     LEFT JOIN promotions p
                         ON p.id = ub.promotion_id
                     WHERE ub.user_id = $1
                     ORDER BY ub.created_at DESC`,
                    [req.params.id]
                );

                return res.json({
                    success: true,
                    bonuses: result.rows
                });
            } catch (error) {
                console.error("User bonuses lookup error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to load user bonuses"
                });
            }
        }
    );


    // ==========================================
    // REFERRAL SETTINGS — NEON
    // Keep only one GET route and one PATCH route
    // ==========================================

    app.get(
        "/api/admin/referral-settings",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
                const result = await query(
                    `SELECT *
                     FROM referral_settings
                     ORDER BY id
                     LIMIT 1`
                );

                return res.json({
                    success: true,
                    settings: result.rows[0] || null
                });
            } catch (error) {
                console.error("Referral settings lookup error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to load referral settings"
                });
            }
        }
    );

    app.patch(
        "/api/admin/referral-settings",
        authenticateUser,
        requireOwner,
        async (req, res) => {
            try {
                const { commission_percent } = req.body || {};

                const commissionPercent = Number(commission_percent);

                if (![5, 10].includes(commissionPercent)) {
                    return res.status(400).json({
                        success: false,
                        message: "Commission percentage must be 5 or 10"
                    });
                }

                const result = await query(
                    `UPDATE referral_settings
                     SET commission_percent = $1,
                         minimum_deposit = $2,
                         updated_at = NOW()
                     WHERE id = (
                         SELECT id
                         FROM referral_settings
                         ORDER BY id
                         LIMIT 1
                     )
                     RETURNING *`,
                    [commissionPercent, 8]
                );

                if (!result.rows.length) {
                    return res.status(404).json({
                        success: false,
                        message: "Referral settings not found"
                    });
                }

                return res.json({
                    success: true,
                    settings: result.rows[0]
                });
            } catch (error) {
                console.error("Referral settings update error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to update referral settings"
                });
            }
        }
    );


    // ==========================================
    // REFERRAL COMMISSIONS — NEON
    // ==========================================

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

                const result = await query(
                    `SELECT *
                     FROM referral_commissions
                     ORDER BY id DESC
                     LIMIT $1`,
                    [limit]
                );

                return res.json({
                    success: true,
                    commissions: result.rows
                });
            } catch (error) {
                console.error("Referral commissions error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to load referral commissions"
                });
            }
        }
    );

    app.get(
        "/api/admin/users/:id/referral-commissions",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
                const result = await query(
                    `SELECT *
                     FROM referral_commissions
                     WHERE referrer_id = $1
                     ORDER BY id DESC
                     LIMIT 500`,
                    [req.params.id]
                );

                return res.json({
                    success: true,
                    commissions: result.rows
                });
            } catch (error) {
                console.error("User referral commissions error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to load user referral commissions"
                });
            }
        }
    );
    
    // ==========================================
    // FINANCE — NEON
    // Response structure matches admin.html
    // ==========================================

    app.get(
        "/api/admin/finance",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
                const [
                    walletsResult,
                    transactionsResult,
                    withdrawalsResult,
                    profilesResult
                ] = await Promise.all([
                    query(
                        `SELECT *
                         FROM wallets`
                    ),
                    query(
                        `SELECT *
                         FROM wallet_transactions
                         ORDER BY created_at DESC`
                    ),
                    query(
                        `SELECT *
                         FROM withdrawals
                         ORDER BY created_at DESC`
                    ),
                    query(
                        `SELECT id, username, full_name, country, role
                         FROM profiles`
                    )
                ]);

              
const wallets = walletsResult.rows;

// Keep the complete withdrawal list to preserve the existing
// fallback behavior when the withdrawals table is empty.
const allTransactions = transactionsResult.rows;
const allWithdrawals = withdrawalsResult.rows;
const profiles = profilesResult.rows;
const hasWithdrawalRecords = allWithdrawals.length > 0;

// Default to the rolling last 24 hours.
const requestedPeriod = String(req.query.period || "24h");
let rangeStart;
let rangeEnd;

if (req.query.startAt || req.query.endAt) {
    const startText = String(req.query.startAt || "");
    const endText = String(req.query.endAt || "");

    rangeStart = new Date(startText);
    rangeEnd = new Date(endText);

    if (
        !req.query.startAt ||
        !req.query.endAt ||
        !Number.isFinite(rangeStart.getTime()) ||
        !Number.isFinite(rangeEnd.getTime()) ||
        rangeStart >= rangeEnd
    ) {
        return res.status(400).json({
            success: false,
            message: "A valid start and end date are required."
        });
    }
} else if (requestedPeriod === "24h") {
    rangeEnd = new Date();
    rangeStart = new Date(rangeEnd.getTime() - 24 * 60 * 60 * 1000);
} else if (requestedPeriod === "today") {
    // Use Kenya local time, regardless of the server timezone.
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Nairobi",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(new Date());

    const dateParts = Object.fromEntries(
        parts.map(part => [part.type, part.value])
    );

    const today = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
    const tomorrowDate = new Date(`${today}T00:00:00+03:00`);
    tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);

    rangeStart = new Date(`${today}T00:00:00+03:00`);
    rangeEnd = tomorrowDate;
} else {
    return res.status(400).json({
        success: false,
        message: "Unsupported financial reporting period."
    });
}

const isInSelectedPeriod = item => {
    const timestamp = new Date(item.created_at).getTime();

    return (
        Number.isFinite(timestamp) &&
        timestamp >= rangeStart.getTime() &&
        timestamp <= rangeEnd.getTime()
    );
};

const transactions = allTransactions.filter(isInSelectedPeriod);
const withdrawals = allWithdrawals.filter(isInSelectedPeriod);

                const profileMap = new Map(
                    profiles.map(profile => [
                        String(profile.id),
                        profile
                    ])
                );

                const amountOf = item =>
                    Number(item.amount) || 0;

                const statusOf = item =>
                    String(item.status || "").toLowerCase();

                const typeOf = item =>
                    String(item.transaction_type || "").toLowerCase();

                const sum = (items, predicate) =>
                    items.reduce(
                        (total, item) =>
                            predicate(item)
                                ? total + amountOf(item)
                                : total,
                        0
                    );

                // Keep the project's established conversion rates.
                const DEPOSIT_KES_RATE = 135;
                const WITHDRAWAL_KES_RATE = 124;

                const liveBalance = wallet =>
                    Number(wallet.balance) || 0;

                const totalWalletBalances = wallets.reduce(
                    (total, wallet) =>
                        total + liveBalance(wallet),
                    0
                );

                const fundedUsers = new Set(
                    wallets
                        .filter(wallet => liveBalance(wallet) > 0)
                        .map(wallet => String(wallet.user_id))
                ).size;

             // Period-based completed deposits — preserve existing finance metrics.
const completedDeposits = sum(
    transactions,
    item =>
        typeOf(item) === "deposit" &&
        statusOf(item) === "completed"
);

// All-time verified completed deposits for the separate overview card.
// Owner credits are excluded because their transaction_type is "bonus".
const verifiedCustomerDeposits = sum(
    allTransactions,
    item =>
        typeOf(item) === "deposit" &&
        statusOf(item) === "completed"
);

                const pendingDeposits = sum(
                    transactions,
                    item =>
                        typeOf(item) === "deposit" &&
                        statusOf(item) === "pending"
                );

                const failedDeposits = sum(
                    transactions,
                    item =>
                        typeOf(item) === "deposit" &&
                        ["failed", "rejected", "cancelled"].includes(
                            statusOf(item)
                        )
                );

                             const completedWithdrawalTransactions = sum(
                    transactions,
                    item =>
                        typeOf(item) === "withdrawal" &&
                        statusOf(item) === "completed"
                );

                const pendingWithdrawalTransactions = sum(
                    transactions,
                    item =>
                        typeOf(item) === "withdrawal" &&
                        ["pending", "processing"].includes(statusOf(item))
                );

                const rejectedWithdrawalTransactions = sum(
                    transactions,
                    item =>
                        typeOf(item) === "withdrawal" &&
                        statusOf(item) === "rejected"
                );

                const failedWithdrawalTransactions = sum(
                    transactions,
                    item =>
                        typeOf(item) === "withdrawal" &&
                        ["failed", "cancelled", "timeout"].includes(
                            statusOf(item)
                        )
                );

                // Prefer the withdrawals table when it has records.
                const completedWithdrawals = hasWithdrawalRecords
                    ? sum(
                        withdrawals,
                        item => statusOf(item) === "completed"
                    )
                    : completedWithdrawalTransactions;

                const pendingWithdrawals = hasWithdrawalRecords
                    ? sum(
                        withdrawals,
                        item =>
                            ["pending", "processing"].includes(
                                statusOf(item)
                            )
                    )
                    : pendingWithdrawalTransactions;

                const rejectedWithdrawals = hasWithdrawalRecords
                    ? sum(
                        withdrawals,
                        item => statusOf(item) === "rejected"
                    )
                    : rejectedWithdrawalTransactions;

                const failedWithdrawals = hasWithdrawalRecords
                    ? sum(
                        withdrawals,
                        item =>
                            ["failed", "cancelled", "timeout"].includes(
                                statusOf(item)
                            )
                    )
                    : failedWithdrawalTransactions;

                const tradeStakes = sum(
                    transactions,
                    item =>
                        ["trade_stake", "buy_sell_stake"].includes(
                            typeOf(item)
                        ) &&
                        statusOf(item) === "completed"
                );

             
const tradePayouts = sum(
    transactions,
    item =>
        [
            "trade_payout",
            "buy_sell_settlement"
        ].includes(typeOf(item)) &&
        statusOf(item) === "completed"
);


                const refunds = sum(
                    transactions,
                    item =>
                        typeOf(item) === "refund" &&
                        statusOf(item) === "completed"
                );

                const bonuses = sum(
                    transactions,
                    item =>
                        ["bonus", "deposit_bonus"].includes(
                            typeOf(item)
                        ) &&
                        statusOf(item) === "completed"
                );
                // Flatten profile fields to match admin.html.
                const userBalances = wallets.map(wallet => {
                    const profile =
                        profileMap.get(String(wallet.user_id)) || {};

                    const balance = liveBalance(wallet);

                    return {
                        ...wallet,
                        username: profile.username || null,
                        full_name: profile.full_name || null,
                        country: profile.country || null,
                        live_balance: balance,
                        live_balance_kes: balance * DEPOSIT_KES_RATE
                    };
                });

                const recentTransactions = transactions
                    .slice(0, 100)
                    .map(transaction => {
                        const profile =
                            profileMap.get(
                                String(transaction.user_id)
                            ) || {};

                        return {
                            ...transaction,
                            username: profile.username || null,
                            full_name: profile.full_name || null
                        };
                    });

                const netDepositsMinusWithdrawals =
                    completedDeposits - completedWithdrawals;

                const netDepositsMinusWithdrawalsKes =
                    completedDeposits * DEPOSIT_KES_RATE -
                    completedWithdrawals * WITHDRAWAL_KES_RATE;

                // IMPORTANT: admin.html reads data.finance.
                return res.json({
                    success: true,

                    finance: {
                        customerFunds: {
                            liabilityUsd: totalWalletBalances,
                            liabilityKes:
                                totalWalletBalances * DEPOSIT_KES_RATE,
                            fundedUsers,
                            totalWallets: wallets.length,
                            totalLiveWalletBalances:
                                totalWalletBalances,
                            customerLiabilities:
                                totalWalletBalances
                        },
verifiedCustomerDeposits: {
    totalUsd: verifiedCustomerDeposits,
    totalKes: verifiedCustomerDeposits * DEPOSIT_KES_RATE
},
                        deposits: {
                            completedUsd: completedDeposits,
                            pendingUsd: pendingDeposits,
                            failedUsd: failedDeposits,
                            completedKes:
                                completedDeposits * DEPOSIT_KES_RATE,
                            pendingKes:
                                pendingDeposits * DEPOSIT_KES_RATE
                        },

                        withdrawals: {
                            completedUsd: completedWithdrawals,
                            pendingUsd: pendingWithdrawals,
                            rejectedUsd: rejectedWithdrawals,
                            failedUsd: failedWithdrawals,
                            completedKes:
                                completedWithdrawals *
                                WITHDRAWAL_KES_RATE,
                            pendingKes:
                                pendingWithdrawals *
                                WITHDRAWAL_KES_RATE
                        },

                        trading: {
                            stakesUsd: tradeStakes,
                            payoutsUsd: tradePayouts,
                            netTradingFlowUsd:
                                tradeStakes - tradePayouts,
                            stakes: tradeStakes,
                            payouts: tradePayouts,
                            net: tradeStakes - tradePayouts
                        },

                        other: {
                            refundsUsd: refunds,
                            bonusesUsd: bonuses,
                            refunds,
                            bonuses
                        },

                        platformFlow: {
                            depositsMinusWithdrawalsUsd:
                                netDepositsMinusWithdrawals,
                            depositsMinusWithdrawalsKes:
                                netDepositsMinusWithdrawalsKes,
                            netDepositFlow:
                                netDepositsMinusWithdrawals,
                            tradingNetFlow:
                                tradeStakes - tradePayouts
                        },

                        businessCash: {
                            available: null,
                            message:
                                "External business cash balance is not available from wallet records."
                        },

                        userBalances,
                        recentTransactions
                    }
                });

            } catch (error) {
                console.error("Admin finance error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to load finance data"
                });
            }
        }
    );


    // ==========================================
    // PLATFORM SETTINGS — MINIMUM DEPOSIT
    // OWNER ONLY
    // ==========================================

    app.get(
        "/api/admin/platform-settings/minimum-deposit",
        authenticateUser,
        requireOwner,
        async (req, res) => {
            try {
                const result = await query(
                    `SELECT setting_value
                     FROM platform_settings
                     WHERE setting_key = $1
                     LIMIT 1`,
                    ["minimum_deposit_usd"]
                );

                if (!result.rows.length) {
                    return res.status(500).json({
                        success: false,
                        message: "Minimum deposit setting is missing"
                    });
                }

                const minimumDeposit = Number(
                    result.rows[0].setting_value
                );

                if (
                    !Number.isFinite(minimumDeposit) ||
                    minimumDeposit <= 0
                ) {
                    return res.status(500).json({
                        success: false,
                        message: "Minimum deposit setting is invalid"
                    });
                }

                return res.json({
                    success: true,
                    minimumDeposit
                });
            } catch (error) {
                console.error(
                    "Minimum deposit settings lookup error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to load minimum deposit setting"
                });
            }
        }
    );

    app.patch(
        "/api/admin/platform-settings/minimum-deposit",
        authenticateUser,
        requireOwner,
        async (req, res) => {
            try {
                const minimumDeposit = Number(
                    req.body?.minimumDeposit
                );

                if (
                    !Number.isFinite(minimumDeposit) ||
                    minimumDeposit < 2 ||
                    minimumDeposit > 10000
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Minimum deposit must be between $2 and $10,000"
                    });
                }

                const value = minimumDeposit.toFixed(2);

                const result = await query(
                    `INSERT INTO platform_settings (
                        setting_key,
                        setting_value,
                        updated_at,
                        updated_by
                    )
                    VALUES ($1, $2, NOW(), $3)
                    ON CONFLICT (setting_key)
                    DO UPDATE SET
                        setting_value = EXCLUDED.setting_value,
                        updated_at = NOW(),
                        updated_by = EXCLUDED.updated_by
                    RETURNING setting_value`,
                    [
                        "minimum_deposit_usd",
                        value,
                        req.user.id
                    ]
                );

                console.log(
                    `MINIMUM DEPOSIT UPDATED: $${value} by owner ${req.user.id}`
                );

                return res.json({
                    success: true,
                    message: "Minimum deposit updated successfully",
                    minimumDeposit: Number(
                        result.rows[0].setting_value
                    )
                });
            } catch (error) {
                console.error(
                    "Minimum deposit settings update error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to update minimum deposit setting"
                });
            }
        }
    );

    // ==========================================
    // BUSINESS CASH LEDGER — NEON
    // OWNER ONLY
    // ==========================================

    const BUSINESS_CASH_TYPES = [
        "opening_balance",
        "cash_in",
        "cash_out",
        "fee",
        "adjustment_in",
        "adjustment_out"
    ];

    const BUSINESS_CASH_STATUSES = [
        "confirmed",
        "unreconciled",
        "needs_review"
    ];

    function parseBusinessCashDate(value) {
        if (!value) return null;

        const date = new Date(value);

        if (Number.isNaN(date.getTime())) {
            return null;
        }

        return date;
    }

    function businessCashSignedAmount(row) {
        const amount = Number(row.amount_kes);

        switch (row.movement_type) {
            case "cash_in":
            case "adjustment_in":
                return amount;

            case "cash_out":
            case "fee":
            case "adjustment_out":
                return -amount;

            default:
                return 0;
        }
    }

    // GET BUSINESS CASH REPORT
    app.get(
        "/api/admin/business-cash",
        authenticateUser,
        requireOwner,
        async (req, res) => {
            try {
                const now = new Date();

                let startAt = parseBusinessCashDate(
                    req.query.startAt
                );

                let endAt = parseBusinessCashDate(
                    req.query.endAt
                );

                if (
                    (req.query.startAt && !startAt) ||
                    (req.query.endAt && !endAt)
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid report date."
                    });
                }

                if (!startAt && !endAt) {
                    const period =
                        String(req.query.period || "24h");

                    const periodMilliseconds = {
                        "24h": 24 * 60 * 60 * 1000,
                        "7d": 7 * 24 * 60 * 60 * 1000,
                        "30d": 30 * 24 * 60 * 60 * 1000
                    };

                    if (period === "all") {
                        startAt = new Date(0);
                    } else {
                        const duration =
                            periodMilliseconds[period];

                        if (!duration) {
                            return res.status(400).json({
                                success: false,
                                message: "Invalid report period."
                            });
                        }

                        startAt = new Date(
                            now.getTime() - duration
                        );
                    }

                    endAt = now;
                } else if (!startAt || !endAt) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Both startAt and endAt are required."
                    });
                }

                if (startAt > endAt) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Start date cannot be after end date."
                    });
                }

                const ledgerResult = await query(
                    `SELECT
                        id,
                        effective_at,
                        movement_type,
                        amount_kes,
                        reference,
                        source,
                        description,
                        reconciliation_status,
                        created_by,
                        created_at
                     FROM business_cash_movements
                     WHERE effective_at <= $1
                     ORDER BY effective_at ASC, created_at ASC`,
                    [endAt.toISOString()]
                );

                const allMovements = ledgerResult.rows;

           
                const openingRecord = allMovements.find(
                    row => row.movement_type === "opening_balance"
                );

                const reportMovements = allMovements.filter(row => {
                    const time =
                        new Date(row.effective_at).getTime();

                    return (
                        time >= startAt.getTime() &&
                        time <= endAt.getTime()
                    );
                });

                let cashIn = 0;
                let cashOut = 0;
                let fees = 0;
                let adjustmentsIn = 0;
                let adjustmentsOut = 0;

                for (const row of reportMovements) {
                    const amount = Number(row.amount_kes);

                    switch (row.movement_type) {
                        case "cash_in":
                            cashIn += amount;
                            break;
                        case "cash_out":
                            cashOut += amount;
                            break;
                        case "fee":
                            fees += amount;
                            break;
                        case "adjustment_in":
                            adjustmentsIn += amount;
                            break;
                        case "adjustment_out":
                            adjustmentsOut += amount;
                            break;
                    }
                }

                const baselineExists = Boolean(openingRecord);

                const baselineTime = openingRecord
                    ? new Date(openingRecord.effective_at).getTime()
                    : null;

                // If no opening entry exists, use zero as the baseline.
                const openingKnown = !baselineExists ||
                    baselineTime <= startAt.getTime();

                const closingKnown = !baselineExists ||
                    baselineTime <= endAt.getTime();

                let openingBalance = 0;
                let closingBalance = 0;

                if (baselineExists) {
                    openingBalance =
                        Number(openingRecord.amount_kes);

                    closingBalance =
                        Number(openingRecord.amount_kes);

                    for (const row of allMovements) {
                        if (row.id === openingRecord.id) {
                            continue;
                        }

                        const time =
                            new Date(row.effective_at).getTime();

                        if (time <= baselineTime) {
                            continue;
                        }

                        const signed =
                            businessCashSignedAmount(row);

                        if (time < startAt.getTime()) {
                            openingBalance += signed;
                        }

                        if (time <= endAt.getTime()) {
                            closingBalance += signed;
                        }
                    }
                } else {
                    // With no opening record, calculate from zero.
                    for (const row of allMovements) {
                        const time =
                            new Date(row.effective_at).getTime();

                        if (time < startAt.getTime()) {
                            openingBalance +=
                                businessCashSignedAmount(row);
                        }

                        if (time <= endAt.getTime()) {
                            closingBalance +=
                                businessCashSignedAmount(row);
                        }
                    }
                }

                const rounded = value =>
                    value === null
                        ? null
                        : Number(value.toFixed(2));

                const unreconciledCount =
                    allMovements.filter(row =>
                        row.reconciliation_status !== "confirmed"
                    ).length;

                return res.json({
                    success: true,
                    report: {
                        startAt: startAt.toISOString(),
                        endAt: endAt.toISOString(),
                        currency: "KES",

                        balanceKnown: closingKnown,
                        openingBalanceKnown: openingKnown,
                        closingBalanceKnown: closingKnown,

                        openingBalance: openingKnown
                            ? rounded(openingBalance)
                            : null,

                        cashIn: rounded(cashIn),
                        cashOut: rounded(cashOut),
                        fees: rounded(fees),
                        adjustmentsIn: rounded(adjustmentsIn),
                        adjustmentsOut: rounded(adjustmentsOut),

                        closingBalance: closingKnown
                            ? rounded(closingBalance)
                            : null,

                        unreconciledCount,

                        message: !openingKnown
                            ? "The selected period begins before the recorded opening balance."
                            : unreconciledCount > 0
                                ? "Some ledger entries still require reconciliation."
                                : "Ledger report loaded."
                    },

                    movements: reportMovements
                });

            } catch (error) {
                console.error(
                    "Business cash report error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to load business cash report."
                });
            }
        }
    );

    // RECORD BUSINESS CASH MOVEMENT
    app.post(
        "/api/admin/business-cash/movements",
        authenticateUser,
        requireOwner,
        async (req, res) => {
            try {
                const movementType = String(
                    req.body?.movementType || ""
                ).trim();

                const amountKes = Number(
                    req.body?.amountKes
                );

                const description = String(
                    req.body?.description || ""
                ).trim();

                const reference = String(
                    req.body?.reference || ""
                ).trim();

                const status = String(
                    req.body?.reconciliationStatus ||
                    "unreconciled"
                ).trim();

                const effectiveAt = req.body?.effectiveAt
                    ? parseBusinessCashDate(
                        req.body.effectiveAt
                    )
                    : new Date();

                if (
                    !BUSINESS_CASH_TYPES.includes(movementType)
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid movement type."
                    });
                }

                if (
                    !Number.isFinite(amountKes) ||
                    amountKes <= 0 ||
                    amountKes > 999999999999
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Enter a valid positive KSh amount."
                    });
                }

                if (
                    !description ||
                    description.length > 1000
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "A reason is required (maximum 1000 characters)."
                    });
                }

                if (reference.length > 200) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Reference must not exceed 200 characters."
                    });
                }

                if (
                    !BUSINESS_CASH_STATUSES.includes(status)
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Invalid reconciliation status."
                    });
                }

                if (!effectiveAt) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid effective date."
                    });
                }

                if (
                    movementType === "opening_balance" &&
                    status !== "confirmed"
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "The opening balance must be confirmed against an actual Till or cash record."
                    });
                }

                if (movementType === "opening_balance") {
                    const existing = await query(
                        `SELECT id
                         FROM business_cash_movements
                         LIMIT 1`
                    );

                    if (existing.rows.length > 0) {
                        return res.status(409).json({
                            success: false,
                            message:
                                "An opening balance or other ledger entry already exists. Use an adjustment to correct the balance."
                        });
                    }
                }

                const result = await query(
                    `INSERT INTO business_cash_movements (
                        effective_at,
                        movement_type,
                        amount_kes,
                        reference,
                        source,
                        description,
                        reconciliation_status,
                        created_by
                    )
                    VALUES ($1, $2, $3, $4, 'manual', $5, $6, $7)
                    RETURNING
                        id,
                        effective_at,
                        movement_type,
                        amount_kes,
                        reference,
                        source,
                        description,
                        reconciliation_status,
                        created_by,
                        created_at`,
                    [
                        effectiveAt.toISOString(),
                        movementType,
                        Number(amountKes.toFixed(2)),
                        reference || null,
                        description,
                        status,
                        req.user.id
                    ]
                );

                return res.status(201).json({
                    success: true,
                    message:
                        "Business cash movement recorded.",
                    movement: result.rows[0]
                });

            } catch (error) {
                console.error(
                    "Business cash movement error:",
                    error
                );

                if (error.code === "23505") {
                    return res.status(409).json({
                        success: false,
                        message:
                            "This source/reference combination already exists."
                    });
                }

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to record business cash movement."
                });
            }
        }
    );

    // ==========================================
    // DEPOSITS — NEON
    // ==========================================

    app.get(
        "/api/admin/deposits",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
                const status = String(
                    req.query.status || "pending"
                ).trim().toLowerCase();

                const result = await query(
                    `SELECT *
                     FROM wallet_transactions
                     WHERE transaction_type = $1
                       AND status = $2
                     ORDER BY created_at DESC
                     LIMIT 200`,
                    ["deposit", status]
                );

                return res.json({
                    success: true,
                    deposits: result.rows
                });
            } catch (error) {
                console.error("Admin deposits error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to load deposits"
                });
            }
        }
    );


    
    // ==========================================
    // COMPLETED DEPOSITS — NEON
    // Read-only history; does not credit wallets
    // ==========================================

    app.get(
        "/api/admin/completed-deposits",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
               const result = await query(
    `SELECT
        wt.user_id,
        wt.reference,
        wt.amount,
        wt.mpesa_receipt,
        bcm.amount_kes,
        wt.created_at AS completed_at,
        wt.status
     FROM wallet_transactions wt
     LEFT JOIN LATERAL (
        SELECT bcm.amount_kes
        FROM business_cash_movements bcm
        WHERE bcm.reference = wt.mpesa_receipt
          AND bcm.source = 'mpesa_stk'
          AND bcm.movement_type = 'cash_in'
        ORDER BY bcm.created_at DESC
        LIMIT 1
     ) bcm ON TRUE
     WHERE wt.transaction_type = 'deposit'
       AND LOWER(wt.status) = 'completed'
     ORDER BY wt.created_at DESC
     LIMIT 500`
);
                return res.json({
                    success: true,
                    deposits: result.rows
                });
            } catch (error) {
                console.error(
                    "Admin completed deposits error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to load completed deposits"
                });
            }
        }
    );

    // ==========================================
    // WITHDRAWALS — NEON
    // ==========================================

    app.get(
        "/api/admin/withdrawals",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
                const status = String(
                    req.query.status || ""
                ).trim().toLowerCase();

                const withdrawalsResult = status
                    ? await query(
                        `SELECT *
                         FROM withdrawals
                         WHERE status = $1
                         ORDER BY created_at DESC
                         LIMIT 200`,
                        [status]
                    )
                    : await query(
                        `SELECT *
                         FROM withdrawals
                         ORDER BY created_at DESC
                         LIMIT 200`
                    );

                const withdrawals = withdrawalsResult.rows;

                if (!withdrawals.length) {
                    return res.json({
                        success: true,
                        withdrawals: []
                    });
                }

                const ids = withdrawals.map(item => item.id);

                const transactionsResult = await query(
                    `SELECT *
                     FROM wallet_transactions
                  WHERE transaction_type = $1
  AND reference_id = ANY($2::uuid[])`,
["withdrawal", ids]
                );

                const transactionByReference = new Map();

                for (const transaction of transactionsResult.rows) {
                    transactionByReference.set(
                        String(transaction.reference_id),
                        transaction
                    );
                }

                const enrichedWithdrawals = withdrawals.map(withdrawal => {
                    const transaction = transactionByReference.get(
                        String(withdrawal.id)
                    ) || transactionsResult.rows.find(
                        item =>
                            item.reference === withdrawal.reference
                    );

                    return {
                        ...withdrawal,
                        withdrawal_id: withdrawal.id,
                        wallet_transaction_id: transaction?.id || null,
                        transaction_status: transaction?.status || null,
                        mpesa_receipt:
                            transaction?.mpesa_receipt || null,
                        result_description:
                            transaction?.result_description ||
                            transaction?.description ||
                            null
                    };
                });

                return res.json({
                    success: true,
                    withdrawals: enrichedWithdrawals
                });
            } catch (error) {
                console.error("Admin withdrawals error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to load withdrawals"
                });
            }
        }
    );


    // ==========================================
    // REJECT WITHDRAWAL — NEON
    // Rejected funds are NOT returned to the user
    // ==========================================

    app.post(
        "/api/admin/withdrawals/:id/reject",
        authenticateUser,
        requireOwner,
        async (req, res) => {
            const withdrawalId = String(
                req.params.id || ""
            ).trim();

            const reason = String(
                req.body?.reason || ""
            ).trim();

            if (!withdrawalId) {
                return res.status(400).json({
                    success: false,
                    message: "Withdrawal ID is required"
                });
            }

            if (!reason) {
                return res.status(400).json({
                    success: false,
                    message: "Rejection reason is required"
                });
            }

            if (reason.length > 500) {
                return res.status(400).json({
                    success: false,
                    message: "Rejection reason cannot exceed 500 characters"
                });
            }

         let client;

try {
    client = await require("./db").pool.connect();
                await client.query("BEGIN");

                const withdrawalResult = await client.query(
                    `SELECT *
                     FROM withdrawals
                     WHERE id = $1
                     FOR UPDATE`,
                    [withdrawalId]
                );

                const withdrawal = withdrawalResult.rows[0];

                if (!withdrawal) {
                    await client.query("ROLLBACK");

                    return res.status(404).json({
                        success: false,
                        message: "Withdrawal not found"
                    });
                }

                if (String(withdrawal.status).toLowerCase() !== "pending") {
                    await client.query("ROLLBACK");

                    return res.status(400).json({
                        success: false,
                        message: "Only pending withdrawals can be rejected"
                    });
                }

                if (!withdrawal.user_id) {
                    await client.query("ROLLBACK");

                    return res.status(400).json({
                        success: false,
                        message: "Withdrawal has no associated user"
                    });
                }

                const amount = Number(withdrawal.amount);

                if (!Number.isFinite(amount) || amount <= 0) {
                    await client.query("ROLLBACK");

                    return res.status(400).json({
                        success: false,
                        message: "Withdrawal amount is invalid"
                    });
                }

                const updatedResult = await client.query(
                    `UPDATE withdrawals
                     SET status = 'rejected',
                         reviewed_by = $1,
                         reviewed_at = NOW(),
                         rejection_reason = $2,
                         admin_notes = $2
                     WHERE id = $3
                       AND status = 'pending'
                     RETURNING *`,
                    [req.user.id, reason, withdrawalId]
                );

                if (!updatedResult.rows.length) {
                    await client.query("ROLLBACK");

                    return res.status(409).json({
                        success: false,
                        message: "Withdrawal status changed; refresh and try again"
                    });
                }

                const updatedWithdrawal = updatedResult.rows[0];

                await client.query(
                    `UPDATE wallet_transactions
                     SET status = 'rejected',
                         description = $1
                     WHERE transaction_type = 'withdrawal'
                       AND (
                           reference = $2
                           OR reference_id = $3
                       )
                       AND status = 'pending'`,
                    [
                        `Withdrawal rejected by administrator: ${reason}`,
                        withdrawal.reference || "",
                        withdrawalId
                    ]
                );

                try {
                    await client.query(
                        `INSERT INTO withdrawal_audit_logs (
                            withdrawal_id,
                            user_id,
                            admin_id,
                            action,
                            reason,
                            notes,
                            status_before,
                            status_after,
                            amount,
                            metadata
                        )
                        VALUES (
                                                      $1, $2, $3, $4, $5, $6,
                            $7, $8, $9, $10::jsonb
                        )`,
                                               [
                            withdrawal.id,
                            withdrawal.user_id,
                            req.user.id,
                            "withdrawal_rejected",
                            reason,
                            "Withdrawal rejected by administrator. Funds were not returned to the user's wallet.",
                            "pending",
                            "rejected",
                            amount,
                            JSON.stringify({
                                // metadata fields...
                            }),
                            // An extra admin-role parameter may remain here
                        ]
                    );
                } catch (auditError) {
                    console.error(
                        "Withdrawal audit log insert failed:",
                        auditError
                    );

                    throw auditError;
                }

                await client.query("COMMIT");

                return res.json({
                    success: true,
                    message:
                        "Withdrawal rejected. Funds were not returned to the user's wallet.",
                    withdrawal: updatedWithdrawal
                });
                     } catch (error) {
                if (client) {
                    try {
                        await client.query("ROLLBACK");
                    } catch (rollbackError) {
                        console.error(
                            "Withdrawal rejection rollback error:",
                            rollbackError
                        );
                    }
                }

                console.error("Withdrawal rejection error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to reject withdrawal"
                });
           } finally {
    if (client) {
        client.release();
    }
}
        }
    );
    // ==========================================
    // MARKETS — NEON
    // ==========================================

    app.get(
        "/api/admin/markets",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
                const result = await query(
                    `SELECT *
                     FROM markets
                     ORDER BY symbol`
                );

                return res.json({
                    success: true,
                    markets: result.rows
                });
            } catch (error) {
                console.error("Admin markets error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to load markets"
                });
            }
        }
    );

    app.patch(
        "/api/admin/markets/:id",
        authenticateUser,
        requireAdmin,
        async (req, res) => {
            try {
                const { is_active } = req.body || {};

                if (typeof is_active !== "boolean") {
                    return res.status(400).json({
                        success: false,
                        message: "is_active must be true or false"
                    });
                }

                const result = await query(
                    `UPDATE markets
                     SET is_active = $1
                     WHERE id = $2
                     RETURNING *`,
                    [is_active, req.params.id]
                );

                if (!result.rows.length) {
                    return res.status(404).json({
                        success: false,
                        message: "Market not found"
                    });
                }

                return res.json({
                    success: true,
                    market: result.rows[0]
                });
            } catch (error) {
                console.error("Market update error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to update market"
                });
            }
        }
    );


    // ==========================================
    // OWNER — VIEW USER WALLET
    // ==========================================

    app.get(
        "/api/admin/owner/wallet/:userId",
        authenticateUser,
        requireOwner,
        async (req, res) => {
            try {
                const result = await query(
                    `SELECT *
                     FROM wallets
                     WHERE user_id = $1
                     LIMIT 1`,
                    [req.params.userId]
                );

                if (!result.rows.length) {
                    return res.status(404).json({
                        success: false,
                        message: "User wallet not found"
                    });
                }

                return res.json({
                    success: true,
                    wallet: result.rows[0]
                });
            } catch (error) {
                console.error("Owner wallet lookup error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to load user wallet"
                });
            }
        }
    );


    // ==========================================
    // OWNER — CREDIT USER WALLET
    // ==========================================

    app.post(
        "/api/admin/owner/wallet/:userId/credit",
        authenticateUser,
        requireOwner,
        async (req, res) => {
            const userId = String(req.params.userId || "").trim();
            const amount = parsePositiveAmount(req.body?.amount);
            const reason = String(req.body?.reason || "").trim();

            if (!userId || amount === null || amount > 1000000 || !reason || reason.length > 500) {
                return res.status(400).json({
                    success: false,
                    message: "Valid user ID, amount up to 1,000,000, and reason are required"
                });
            }

            const client = await require("./db").pool.connect();

            try {
                await client.query("BEGIN");

                const walletResult = await client.query(
                    `SELECT *
                     FROM wallets
                     WHERE user_id = $1
                     FOR UPDATE`,
                    [userId]
                );

                const wallet = walletResult.rows[0];

                if (!wallet) {
                    await client.query("ROLLBACK");

                    return res.status(404).json({
                        success: false,
                        message: "User wallet not found"
                    });
                }

                const balanceBefore = Number(wallet.balance) || 0;
                const balanceAfter = Number((balanceBefore + amount).toFixed(6));

                const updatedResult = await client.query(
                    `UPDATE wallets
                     SET balance = $1,
                         updated_at = NOW()
                     WHERE id = $2
                     RETURNING *`,
                    [balanceAfter, wallet.id]
                );

                const reference = generateReference("OWNER-CREDIT");

                await client.query(
                    `INSERT INTO wallet_transactions (
                        user_id,
                        transaction_type,
                        type,
                        amount,
                        status,
                        payment_method,
                        reference,
                        description,
                        balance_before,
                        balance_after,
                        created_at
                    )
                VALUES ($1, 'adjustment', 'owner_credit', $2, 'completed',
        'owner', $3, $4, $5, $6, NOW()) `,
                    [
                        userId,
                        amount,
                        reference,
                        reason,
                        balanceBefore,
                        balanceAfter
                    ]
                );

                await client.query("COMMIT");

                return res.json({
                    success: true,
                    message: "User wallet credited successfully",
                    wallet: updatedResult.rows[0],
                    reference
                });
            } catch (error) {
                try {
                    await client.query("ROLLBACK");
                } catch {}

                console.error("Owner wallet credit error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to credit user wallet"
                });
            } finally {
                client.release();
            }
        }
    );


    // ==========================================
    // OWNER — DEBIT USER WALLET
    // ==========================================

    app.post(
        "/api/admin/owner/wallet/:userId/debit",
        authenticateUser,
        requireOwner,
        async (req, res) => {
            const userId = String(req.params.userId || "").trim();
            const amount = parsePositiveAmount(req.body?.amount);
            const reason = String(req.body?.reason || "").trim();

            if (!userId || amount === null || amount > 1000000 || !reason || reason.length > 500) {
                return res.status(400).json({
                    success: false,
                    message: "Valid user ID, amount up to 1,000,000, and reason are required"
                });
            }

            const client = await require("./db").pool.connect();

            try {
                await client.query("BEGIN");

                const walletResult = await client.query(
                    `SELECT *
                     FROM wallets
                     WHERE user_id = $1
                     FOR UPDATE`,
                    [userId]
                );

                const wallet = walletResult.rows[0];

                if (!wallet) {
                    await client.query("ROLLBACK");

                    return res.status(404).json({
                        success: false,
                        message: "User wallet not found"
                    });
                }

                const balanceBefore = Number(wallet.balance) || 0;

                if (amount > balanceBefore) {
                    await client.query("ROLLBACK");

                    return res.status(400).json({
                        success: false,
                        message: "Insufficient wallet balance"
                    });
                }

                const balanceAfter = Number((balanceBefore - amount).toFixed(6));

                const updatedResult = await client.query(
                    `UPDATE wallets
                     SET balance = $1,
                         updated_at = NOW()
                     WHERE id = $2
                     RETURNING *`,
                    [balanceAfter, wallet.id]
                );

                const reference = generateReference("OWNER-DEBIT");

                await client.query(
                    `INSERT INTO wallet_transactions (
                        user_id,
                        transaction_type,
                        type,
                        amount,
                        status,
                        payment_method,
                        reference,
                        description,
                        balance_before,
                        balance_after,
                        created_at
                    )
                  VALUES ($1, 'adjustment', 'owner_debit', $2, 'completed',
        'owner', $3, $4, $5, $6, NOW()) `,
                    [
                        userId,
                        amount,
                        reference,
                        reason,
                        balanceBefore,
                        balanceAfter
                    ]
                );

                await client.query("COMMIT");

                return res.json({
                    success: true,
                    message: "User wallet debited successfully",
                    wallet: updatedResult.rows[0],
                    reference
                });
            } catch (error) {
                try {
                    await client.query("ROLLBACK");
                } catch {}

                console.error("Owner wallet debit error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to debit user wallet"
                });
            } finally {
                client.release();
            }
        }
    );


    // ==========================================
    // OWNER — SET USER WALLET BALANCE
    // ==========================================

    app.post(
        "/api/admin/owner/wallet/:userId/set-balance",
        authenticateUser,
        requireOwner,
        async (req, res) => {
            const userId = String(req.params.userId || "").trim();
           const newBalance = parseNonNegativeAmount(
    req.body?.newBalance ?? req.body?.balance
);
            const reason = String(req.body?.reason || "").trim();

            if (
    !userId ||
    newBalance === null ||
    newBalance > 1000000 ||
    !reason ||
    reason.length > 500
) {
                return res.status(400).json({
                    success: false,
                    message: "Valid user ID, balance up to 1,000,000, and reason are required"
                });
            }

            const client = await require("./db").pool.connect();

            try {
                await client.query("BEGIN");

                const walletResult = await client.query(
                    `SELECT *
                     FROM wallets
                     WHERE user_id = $1
                     FOR UPDATE`,
                    [userId]
                );

                const wallet = walletResult.rows[0];

                if (!wallet) {
                    await client.query("ROLLBACK");

                    return res.status(404).json({
                        success: false,
                        message: "User wallet not found"
                    });
                }

                const balanceBefore = Number(wallet.balance) || 0;
               const difference = Number(
    (newBalance - balanceBefore).toFixed(6)
);

                if (difference === 0) {
                    await client.query("ROLLBACK");

                    return res.status(400).json({
                        success: false,
                        message: "The wallet already has that balance"
                    });
                }

                const updatedResult = await client.query(
                    `UPDATE wallets
                     SET balance = $1,
                         updated_at = NOW()
                     WHERE id = $2
                     RETURNING *`,
                 [newBalance, wallet.id]
                );

                const reference = generateReference("OWNER-SET");

                await client.query(
                    `INSERT INTO wallet_transactions (
                        user_id,
                        transaction_type,
                        type,
                        amount,
                        status,
                        payment_method,
                        reference,
                        description,
                        balance_before,
                        balance_after,
                        created_at
                    )
                 VALUES ($1, 'adjustment', 'owner_balance_adjustment', $2,
        'completed', 'owner', $3, $4, $5, $6, NOW()) `,
                    [
                        userId,
                        Math.abs(difference),
                        reference,
                        reason,
                        balanceBefore,
                        newBalance
                    ]
                );

                await client.query("COMMIT");

                return res.json({
                    success: true,
                    message: "User wallet balance updated successfully",
                    wallet: updatedResult.rows[0],
                    reference
                });
            } catch (error) {
                try {
                    await client.query("ROLLBACK");
                } catch {}

                console.error("Owner set wallet balance error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to set user wallet balance"
                });
            } finally {
                client.release();
            }
        }
    );


    // ==========================================
    // OWNER — USER WALLET TO KMFBINARY PLATFORM
    // ==========================================

    app.post(
        "/api/admin/owner/transfer/user-to-kmf",
        authenticateUser,
        requireOwner,
        async (req, res) => {
            const userId = String(req.body?.userId || "").trim();
            const amount = parsePositiveAmount(req.body?.amount);
            const reason = String(req.body?.reason || "").trim();

            if (!userId || amount === null || amount > 1000000 || !reason || reason.length > 500) {
                return res.status(400).json({
                    success: false,
                    message: "Valid user ID, amount up to 1,000,000, and reason are required"
                });
            }

            const client = await require("./db").pool.connect();

            try {
                await client.query("BEGIN");

                const walletResult = await client.query(
                    `SELECT *
                     FROM wallets
                     WHERE user_id = $1
                     FOR UPDATE`,
                    [userId]
                );

                const userWallet = walletResult.rows[0];

                if (!userWallet) {
                    await client.query("ROLLBACK");

                    return res.status(404).json({
                        success: false,
                        message: "User wallet not found"
                    });
                }

                const platformResult = await client.query(
                    `SELECT *
                     FROM platform_wallet
                     ORDER BY id
                     LIMIT 1
                     FOR UPDATE`
                );

                const platformWallet = platformResult.rows[0];

                if (!platformWallet) {
                    await client.query("ROLLBACK");

                    return res.status(404).json({
                        success: false,
                        message: "KMFBinary platform wallet not found"
                    });
                }

                const userBefore = Number(userWallet.balance) || 0;
                const platformBefore = Number(platformWallet.balance) || 0;

                if (amount > userBefore) {
                    await client.query("ROLLBACK");

                    return res.status(400).json({
                        success: false,
                        message: "Insufficient user wallet balance"
                    });
                }

                const userAfter = Number((userBefore - amount).toFixed(6));
                const platformAfter = Number((platformBefore + amount).toFixed(6));
                const reference = generateReference("KMF-IN");

                await client.query(
                    `UPDATE wallets
                     SET balance = $1,
                         updated_at = NOW()
                     WHERE id = $2`,
                    [userAfter, userWallet.id]
                );

                await client.query(
                    `UPDATE platform_wallet
                     SET balance = $1,
                         updated_at = NOW()
                     WHERE id = $2`,
                    [platformAfter, platformWallet.id]
                );

                await client.query(
                    `INSERT INTO platform_transactions (
                        platform_wallet_id,
                        user_id,
                        direction,
                        amount,
                        platform_balance_before,
                        platform_balance_after,
                        user_balance_before,
                        user_balance_after,
                        reference,
                        reason,
                        performed_by
                    )
                    VALUES ($1, $2, 'user_to_kmf', $3, $4, $5, $6, $7, $8, $9, $10)`,
                    [
                        platformWallet.id,
                        userId,
                        amount,
                        platformBefore,
                        platformAfter,
                        userBefore,
                        userAfter,
                        reference,
                        reason,
                        req.user.id
                    ]
                );

                await client.query("COMMIT");

                return res.json({
                    success: true,
                    message: "Funds transferred from user wallet to KMFBinary",
                    reference,
                    userBalance: userAfter,
                    platformBalance: platformAfter
                });
            } catch (error) {
                try {
                    await client.query("ROLLBACK");
                } catch {}

                console.error("User-to-platform transfer error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to transfer funds"
                });
            } finally {
                client.release();
            }
        }
    );


    // ==========================================
    // OWNER — VIEW USER WALLET SUMMARY
    // ==========================================

    app.get(
        "/api/admin/owner/user-wallet/:userId",
        authenticateUser,
        requireOwner,
        async (req, res) => {
            try {
                const result = await query(
                    `SELECT user_id, balance, currency
                     FROM wallets
                     WHERE user_id = $1
                     LIMIT 1`,
                    [req.params.userId]
                );

                if (!result.rows.length) {
                    return res.status(404).json({
                        success: false,
                        message: "User wallet not found"
                    });
                }

                return res.json({
                    success: true,
                    wallet: result.rows[0]
                });
            } catch (error) {
                console.error("Owner user-wallet lookup error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to load user wallet"
                });
            }
        }
    );


    // ==========================================
    // OWNER — KMFBINARY PLATFORM TO USER WALLET
    // ==========================================

    app.post(
        "/api/admin/owner/transfer/kmf-to-user",
        authenticateUser,
        requireOwner,
        async (req, res) => {
            const userId = String(req.body?.userId || "").trim();
            const amount = parsePositiveAmount(req.body?.amount);
            const reason = String(req.body?.reason || "").trim();

            if (!userId || amount === null || amount > 1000000 || !reason || reason.length > 500) {
                return res.status(400).json({
                    success: false,
                    message: "Valid user ID, amount up to 1,000,000, and reason are required"
                });
            }

            const client = await require("./db").pool.connect();

            try {
                await client.query("BEGIN");

                const walletResult = await client.query(
                    `SELECT *
                     FROM wallets
                     WHERE user_id = $1
                     FOR UPDATE`,
                    [userId]
                );

                const userWallet = walletResult.rows[0];

                if (!userWallet) {
                    await client.query("ROLLBACK");

                    return res.status(404).json({
                        success: false,
                        message: "User wallet not found"
                    });
                }

                const platformResult = await client.query(
                    `SELECT *
                     FROM platform_wallet
                     ORDER BY id
                     LIMIT 1
                     FOR UPDATE`
                );

                const platformWallet = platformResult.rows[0];

                if (!platformWallet) {
                    await client.query("ROLLBACK");

                    return res.status(404).json({
                        success: false,
                        message: "KMFBinary platform wallet not found"
                    });
                }

                const userBefore = Number(userWallet.balance) || 0;
                const platformBefore = Number(platformWallet.balance) || 0;

                if (amount > platformBefore) {
                    await client.query("ROLLBACK");

                    return res.status(400).json({
                        success: false,
                        message: "Insufficient KMFBinary platform balance"
                    });
                }

                const userAfter = Number((userBefore + amount).toFixed(6));
                const platformAfter = Number((platformBefore - amount).toFixed(6));
                const reference = generateReference("KMF-OUT");

                await client.query(
                    `UPDATE platform_wallet
                     SET balance = $1,
                         updated_at = NOW()
                     WHERE id = $2`,
                    [platformAfter, platformWallet.id]
                );

                await client.query(
                    `UPDATE wallets
                     SET balance = $1,
                         updated_at = NOW()
                     WHERE id = $2`,
                    [userAfter, userWallet.id]
                );

                await client.query(
                    `INSERT INTO platform_transactions (
                        platform_wallet_id,
                        user_id,
                        direction,
                        amount,
                        platform_balance_before,
                        platform_balance_after,
                        user_balance_before,
                        user_balance_after,
                        reference,
                        reason,
                        performed_by
                    )
                    VALUES ($1, $2, 'kmf_to_user', $3, $4, $5, $6, $7, $8, $9, $10)`,
                    [
                        platformWallet.id,
                        userId,
                        amount,
                        platformBefore,
                        platformAfter,
                        userBefore,
                        userAfter,
                        reference,
                        reason,
                        req.user.id
                    ]
                );

                await client.query("COMMIT");

                return res.json({
                    success: true,
                    message: "Funds transferred from KMFBinary to user wallet",
                    reference,
                    userBalance: userAfter,
                    platformBalance: platformAfter
                });
            } catch (error) {
                try {
                    await client.query("ROLLBACK");
                } catch {}

                console.error("Platform-to-user transfer error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to transfer funds"
                });
            } finally {
                client.release();
            }
        }
    );


    // ==========================================
    // OWNER STATUS — PLATFORM WALLET
    // ==========================================

    app.get(
        "/api/admin/owner/status",
        authenticateUser,
        requireOwner,
        async (req, res) => {
            try {
                const result = await require("./db").pool.query(
                    `SELECT id, balance, currency, updated_at
                     FROM platform_wallet
                     ORDER BY id
                     LIMIT 1`
                );

                const platformWallet = result.rows[0];

                if (!platformWallet) {
                    return res.status(404).json({
                        success: false,
                        message: "KMFBinary platform wallet not found"
                    });
                }

                return res.json({
                    success: true,
                    owner: true,
                    permissions: {
                        managePlatformWallet: true,
                        manageUserWallets: true,
                        transferUserToPlatform: true,
                        transferPlatformToUser: true,
                        manageAdminRoles: true
                    },
                    platformBalance:
                        Number(platformWallet.balance) || 0,
                    currency: platformWallet.currency || "USD",
                    updatedAt: platformWallet.updated_at
                });
            } catch (error) {
                console.error(
                    "Owner platform status error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to load platform wallet status"
                });
            }
        }
    );

    // ==========================================
    // CUSTOMER CARE ADMIN — NEON
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
                const status = String(req.query.status || "open")
                    .trim()
                    .toLowerCase();

                if (!["open", "closed", "all"].includes(status)) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid conversation status"
                    });
                }
const queryWithRetry = async (sql, params = []) => {
    const retryable = (error) => {
        const message = String(error?.message || "").toLowerCase();

        return [
            "connection terminated",
            "timeout exceeded when trying to connect",
            "connection timeout",
            "econnreset",
            "etimedout",
            "epipe",
            "too many clients",
            "57p03",
            "53300"
        ].some(text => message.includes(text));
    };

    for (let attempt = 0; ; attempt++) {
        try {
            return await query(sql, params);
        } catch (error) {
            if (attempt >= 2 || !retryable(error)) {
                throw error;
            }

            const delay = attempt === 0 ? 350 : 800;

            console.warn(
                `Customer Care database retry ${attempt + 1}/2:`,
                error.message
            );

            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
};
                const conversationsResult = status === "all"
                    ? await query(
                        `SELECT *
                         FROM support_conversations
                         ORDER BY updated_at DESC
                         LIMIT 200`
                    )
                    : await query(
                        `SELECT *
                         FROM support_conversations
                         WHERE status = $1
                         ORDER BY updated_at DESC
                         LIMIT 200`,
                        [status]
                    );

                const conversations = conversationsResult.rows;

                if (!conversations.length) {
                    return res.json({
                        success: true,
                        conversations: []
                    });
                }

                const customerIds = [
                    ...new Set(
                        conversations
                            .map(item => item.user_id)
                            .filter(Boolean)
                            .map(String)
                    )
                ];

                const conversationIds = conversations.map(
                    item => item.id
                );

                const [profilesResult, messagesResult] =
                    await Promise.all([
                        customerIds.length
                            ? query(
                                `SELECT id, username, full_name, country, role
                                 FROM profiles
                                 WHERE id = ANY($1::uuid[])`,
                                [customerIds]
                            )
                            : Promise.resolve({ rows: [] }),

                        query(
                            `SELECT *
                             FROM support_messages
                             WHERE conversation_id = ANY($1::uuid[])
                             ORDER BY created_at DESC`,
                            [conversationIds]
                        )
                    ]);

                const profileMap = new Map(
                    profilesResult.rows.map(profile => [
                        String(profile.id),
                        profile
                    ])
                );

                const lastMessageMap = new Map();
                const unreadMap = new Map();

                for (const message of messagesResult.rows) {
                    const id = String(message.conversation_id);

                    // Messages are newest first.
                    if (!lastMessageMap.has(id)) {
                        lastMessageMap.set(id, message);
                    }

                    if (
                        message.sender_type === "customer" &&
                        !message.read_at
                    ) {
                        unreadMap.set(
                            id,
                            (unreadMap.get(id) || 0) + 1
                        );
                    }
                }

                const enrichedConversations = conversations.map(
                    conversation => {
                        const id = String(conversation.id);

                        return {
                            ...conversation,
                            customer:
                                profileMap.get(
                                    String(conversation.user_id)
                                ) || null,
                            lastMessage:
                                lastMessageMap.get(id) || null,
                            unreadCount:
                                unreadMap.get(id) || 0
                        };
                    }
                );

                return res.json({
                    success: true,
                    conversations: enrichedConversations
                });
            } catch (error) {
                console.error(
                    "Admin support conversations error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to load support conversations"
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
                const conversationId = String(
                    req.params.id || ""
                ).trim();

                if (!conversationId) {
                    return res.status(400).json({
                        success: false,
                        message: "Conversation ID is required"
                    });
                }

                const conversationResult = await query(
                    `SELECT *
                     FROM support_conversations
                     WHERE id = $1
                     LIMIT 1`,
                    [conversationId]
                );

                if (!conversationResult.rows.length) {
                    return res.status(404).json({
                        success: false,
                        message: "Conversation not found"
                    });
                }

                const conversation = conversationResult.rows[0];

                const [messagesResult, customerResult] =
                    await Promise.all([
                        query(
                            `SELECT *
                             FROM support_messages
                             WHERE conversation_id = $1
                             ORDER BY created_at ASC`,
                            [conversationId]
                        ),

                        query(
                            `SELECT id, username, full_name, country, role
                             FROM profiles
                             WHERE id = $1
                             LIMIT 1`,
                            [conversation.user_id]
                        )
                    ]);

                return res.json({
                    success: true,
                    conversation,
                    customer: customerResult.rows[0] || null,
                    messages: messagesResult.rows
                });
            } catch (error) {
                console.error(
                    "Admin support messages error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to load conversation messages"
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
            const client = await require("./db").pool.connect();
            let transactionStarted = false;

            try {
                const conversationId = String(
                    req.params.id || ""
                ).trim();

                const message = String(
                    req.body?.message || ""
                ).trim();

                if (!conversationId) {
                    return res.status(400).json({
                        success: false,
                        message: "Conversation ID is required"
                    });
                }

                if (!message) {
                    return res.status(400).json({
                        success: false,
                        message: "Message cannot be empty"
                    });
                }

                if (message.length > 2000) {
                    return res.status(400).json({
                        success: false,
                        message: "Message is too long"
                    });
                }

                await client.query("BEGIN");
                transactionStarted = true;

                const conversationResult = await client.query(
                    `SELECT *
                     FROM support_conversations
                     WHERE id = $1
                     FOR UPDATE`,
                    [conversationId]
                );

                if (!conversationResult.rows.length) {
                    await client.query("ROLLBACK");
                    transactionStarted = false;

                    return res.status(404).json({
                        success: false,
                        message: "Conversation not found"
                    });
                }

                const conversation = conversationResult.rows[0];

                if (conversation.status !== "open") {
                    await client.query("ROLLBACK");
                    transactionStarted = false;

                    return res.status(400).json({
                        success: false,
                        message: "This conversation is closed"
                    });
                }

                const messageResult = await client.query(
                    `INSERT INTO support_messages (
                        conversation_id,
                        sender_id,
                        sender_type,
                        message
                    )
                    VALUES ($1, $2, 'support', $3)
                    RETURNING *`,
                    [
                        conversationId,
                        req.user.id,
                        message
                    ]
                );

                const updatedConversationResult =
                    await client.query(
                        `UPDATE support_conversations
                         SET updated_at = NOW()
                         WHERE id = $1
                         RETURNING *`,
                        [conversationId]
                    );

                await client.query("COMMIT");
                transactionStarted = false;

                console.log(
                    `ADMIN SUPPORT REPLY: admin=${req.user.id} conversation=${conversationId}`
                );

                return res.json({
                    success: true,
                    message: messageResult.rows[0],
                    conversation:
                        updatedConversationResult.rows[0] ||
                        conversation
                });
            } catch (error) {
                if (transactionStarted) {
                    try {
                        await client.query("ROLLBACK");
                    } catch (rollbackError) {
                        console.error(
                            "Support reply rollback error:",
                            rollbackError
                        );
                    }
                }

                console.error(
                    "Admin support reply error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to send support reply"
                });
            } finally {
                client.release();
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
                const conversationId = String(
                    req.params.id || ""
                ).trim();

                if (!conversationId) {
                    return res.status(400).json({
                        success: false,
                        message: "Conversation ID is required"
                    });
                }

                const conversationResult = await query(
                    `SELECT id
                     FROM support_conversations
                     WHERE id = $1
                     LIMIT 1`,
                    [conversationId]
                );

                if (!conversationResult.rows.length) {
                    return res.status(404).json({
                        success: false,
                        message: "Conversation not found"
                    });
                }

                const result = await query(
                    `UPDATE support_messages
                     SET read_at = NOW()
                     WHERE conversation_id = $1
                       AND sender_type = 'customer'
                       AND read_at IS NULL`,
                    [conversationId]
                );

                return res.json({
                    success: true,
                    updated: result.rowCount
                });
            } catch (error) {
                console.error(
                    "Admin support mark-read error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to mark messages as read"
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
                const conversationId = String(
                    req.params.id || ""
                ).trim();

                if (!conversationId) {
                    return res.status(400).json({
                        success: false,
                        message: "Conversation ID is required"
                    });
                }

                const result = await query(
                    `UPDATE support_conversations
                     SET status = 'closed',
                         updated_at = NOW()
                     WHERE id = $1
                     RETURNING *`,
                    [conversationId]
                );

                if (!result.rows.length) {
                    return res.status(404).json({
                        success: false,
                        message: "Conversation not found"
                    });
                }

                return res.json({
                    success: true,
                    conversation: result.rows[0]
                });
            } catch (error) {
                console.error(
                    "Close support conversation error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to close support conversation"
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
                const conversationId = String(
                    req.params.id || ""
                ).trim();

                if (!conversationId) {
                    return res.status(400).json({
                        success: false,
                        message: "Conversation ID is required"
                    });
                }

                const result = await query(
                    `UPDATE support_conversations
                     SET status = 'open',
                         updated_at = NOW()
                     WHERE id = $1
                     RETURNING *`,
                    [conversationId]
                );

                if (!result.rows.length) {
                    return res.status(404).json({
                        success: false,
                        message: "Conversation not found"
                    });
                }

                return res.json({
                    success: true,
                    conversation: result.rows[0]
                });
            } catch (error) {
                console.error(
                    "Reopen support conversation error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to reopen support conversation"
                });
            }
        }
    );
}

// ==========================================
// EXPORT ADMIN ROUTES
// ==========================================

module.exports = registerAdminRoutes;