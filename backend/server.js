const express = require("express");

console.log("==========================================");
console.log("KMFinary SERVER FILE:", __filename);
console.log("SERVER VERSION TEST: VOL FIX 002");
console.log("==========================================");

const path = require("path");
const fsPromises = require("fs/promises");
const cors = require("cors");
const crypto = require("crypto");
const axios = require("axios");
const multer = require("multer");
const db = require("./db");
const PRIVATE_KYC_DIR = path.resolve(
    __dirname,
    "..",
    "..",
    "KMFBinary-private-kyc"
);
const kycUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024
    }
});
// ==========================================
// KRA REPORT UPLOAD — PRIVATE KYC
// ==========================================

const kraReportUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 1
    }
});

const kycDocumentsUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 4,
        fields: 20
    }
});

require("dotenv").config();

const supabase = require("./supabase");
const settlement = require("./settlement");
const syntheticMarket = require("./synthetic-market");
const buySellMarket = require("./buy-sell-market");
const buySellSettlement = require("./buy-sell-settlement");
const registerAdminRoutes = require("./admin-routes");

const settleExpiredTrades = settlement.settleExpiredTrades;
const settleTickTrades = settlement.settleTickTrades;
const monitorTouchTrades = settlement.monitorTouchTrades;
const monitorActiveAccumulators =
    settlement.monitorActiveAccumulators;

const app = express();

// ==========================================
// SERVE FRONTEND FILES
// ==========================================

const frontendPath = path.join(__dirname, "..");

app.use(express.static(frontendPath));

const PORT = process.env.PORT || 3000;

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
    Number(process.env.ACCUMULATOR_KNOCKOUT_PERCENT || 0.02);

// ==========================================
// CALCULATE ACCUMULATOR BOUNDARIES
// ==========================================

function calculateAccumulatorBoundaries(entryPrice) {
    const price = Number(entryPrice);

    if (!Number.isFinite(price) || price <= 0) {
        return null;
    }

    const distance = price * ACCUMULATOR_KNOCKOUT_PERCENT;

    const lowerBoundary = Number(
        (price - distance).toFixed(2)
    );

    const upperBoundary = Number(
        (price + distance).toFixed(2)
    );

    return {
        entryPrice: Number(price.toFixed(2)),
        lowerBoundary,
        upperBoundary
    };
}

const ACCUMULATOR_MAX_MULTIPLIER =
    Number(process.env.ACCUMULATOR_MAX_MULTIPLIER || 100);

const TOUCH_BARRIER_DISTANCE =
    Number(process.env.TOUCH_BARRIER_DISTANCE || 2);

const TOUCH_EXPIRIES = [5, 10, 30, 60];

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
    Number(process.env.USD_KES_DEPOSIT_RATE || 135);

const USD_KES_WITHDRAWAL_RATE =
    Number(process.env.USD_KES_WITHDRAWAL_RATE || 124);

console.log("USD/KES Deposit Rate:", USD_KES_DEPOSIT_RATE);
console.log("USD/KES Withdrawal Rate:", USD_KES_WITHDRAWAL_RATE);

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
        console.log("==========================================");
        console.log("❌ INVALID JSON REQUEST");
        console.log("Method:", req.method);
        console.log("URL:", req.originalUrl);
        console.log("Content-Type:", req.headers["content-type"]);
        console.log("User-Agent:", req.headers["user-agent"]);
        console.log("==========================================");

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
        const authHeader = req.headers.authorization;

        if (
            typeof authHeader !== "string" ||
            !authHeader.startsWith("Bearer ")
        ) {
            return res.status(401).json({
                success: false,
                message: "Authentication required"
            });
        }

        const token = authHeader.substring(7).trim();

        if (!token) {
            return res.status(401).json({
                success: false,
                message: "Authentication token missing"
            });
        }

        // KEEP SUPABASE AUTHENTICATION.
        // Only database operations are being migrated to Neon.
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

        req.user = {
            id: user.id,
            email: user.email || null,
            role: user.role || "authenticated"
        };

        next();
    } catch (error) {
        console.error("Authentication error:", error);

        return res.status(401).json({
            success: false,
            message: "Authentication failed"
        });
    }
}

/* ============================================================
   KYC VERIFICATION — NEON DATABASE
   Authentication: existing Supabase Auth middleware
   Document: private KRA PDF only
   ============================================================ */
/* ============================================================
   USER PROFILE — NEON + SUPABASE AUTH METADATA
   Neon stores name, username and country.
   Supabase user metadata stores the profile contact phone.
   This does not change or verify the authentication phone.
============================================================ */

app.get(
    "/api/profile",
    authenticateUser,
    async (req, res) => {
        try {
            const result = await db.query(
                `SELECT id, username, full_name, country, created_at, role
                 FROM public.profiles
                 WHERE id = $1
                 LIMIT 1`,
                [req.user.id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Profile not found"
                });
            }

            const authResult =
                await supabase.auth.admin.getUserById(req.user.id);

            if (authResult.error || !authResult.data?.user) {
                console.error(
                    "GET /api/profile: Unable to read Supabase user metadata:",
                    authResult.error
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to load profile contact details"
                });
            }

            const profile = result.rows[0];
            const authUser = authResult.data.user;
            const metadata = authUser.user_metadata || {};

            const phone =
                typeof metadata.profile_phone === "string"
                    ? metadata.profile_phone
                    : "";

            return res.json({
                success: true,
                profile: {
                    id: profile.id,
                    username: profile.username || "",
                    full_name: profile.full_name || "",
                    country: profile.country || "",
                    phone: phone,
                    created_at: profile.created_at,
                    role: profile.role
                }
            });
        } catch (error) {
            console.error("GET /api/profile error:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to load profile"
            });
        }
    }
);

app.patch(
    "/api/profile",
    authenticateUser,
    async (req, res) => {
        try {
            const {
                full_name,
                username,
                country,
                phone
            } = req.body || {};

            const fields = {
                full_name: {
                    value: full_name,
                    max: 100
                },
                username: {
                    value: username,
                    max: 50
                },
                country: {
                    value: country,
                    max: 80
                },
                phone: {
                    value: phone,
                    max: 30
                }
            };

            for (const [field, rules] of Object.entries(fields)) {
                if (
                    typeof rules.value !== "string" ||
                    rules.value.length > rules.max
                ) {
                    return res.status(400).json({
                        success: false,
                        message: `Invalid ${field}`
                    });
                }
            }

            const cleanFullName = full_name.trim();
            const cleanUsername = username.trim();
            const cleanCountry = country.trim();
            const cleanPhone = phone.trim();

            // Read existing metadata so other user metadata is preserved.
            const authResult =
                await supabase.auth.admin.getUserById(req.user.id);

            if (authResult.error || !authResult.data?.user) {
                console.error(
                    "PATCH /api/profile: Unable to read Supabase user metadata:",
                    authResult.error
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to save profile contact details"
                });
            }

            const existingMetadata =
                authResult.data.user.user_metadata || {};
// Save the contact phone as profile metadata.
// Do not modify authUser.phone or the verified phone field.
const metadataResult =
    await supabase.auth.admin.updateUserById(
        req.user.id,
        {
            user_metadata: {
                ...existingMetadata,
                profile_phone: cleanPhone
            }
        }
    );


if (metadataResult.error) {
    console.error(
        "PATCH /api/profile: Supabase metadata update failed:",
        metadataResult.error
    );

    return res.status(500).json({
        success: false,
        message: "Unable to save phone number"
    });
}
            const result = await db.query(
                `UPDATE public.profiles
                 SET full_name = $1,
                     username = $2,
                     country = $3
                 WHERE id = $4
                 RETURNING id, username, full_name, country, created_at, role`,
                [
                    cleanFullName,
                    cleanUsername,
                    cleanCountry,
                    req.user.id
                ]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Profile not found"
                });
            }

            const profile = result.rows[0];

            return res.json({
                success: true,
                message: "Profile updated successfully",
                profile: {
                    id: profile.id,
                    username: profile.username || "",
                    full_name: profile.full_name || "",
                    country: profile.country || "",
                    phone: cleanPhone,
                    created_at: profile.created_at,
                    role: profile.role
                }
            });
        } catch (error) {
            console.error("PATCH /api/profile error:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to update profile"
            });
        }
    }
);
/* ============================================================
   END USER PROFILE — NEON
============================================================ */

// Return the user's latest KYC status.
// Never return the private document's filesystem path.
app.get(
    "/api/kyc/status",
    authenticateUser,
    async (req, res) => {
        try {
            const result = await db.query(
                `SELECT
                    id,
                    status,
                    full_legal_name,
                    date_of_birth,
                    country_of_residence,
                    phone_number,
                    residential_address,
                    declaration_accepted,
                    rejection_reason,
                    reviewed_at,
                    kra_report_uploaded_at,
                    created_at,
                    updated_at
                 FROM kyc_verifications
                 WHERE user_id = $1
                 ORDER BY
                    updated_at DESC NULLS LAST,
                    created_at DESC
                 LIMIT 1`,
                [req.user.id]
            );

            const verification = result.rows[0] || null;

            return res.json({
                success: true,
                status: verification
                    ? verification.status
                    : "not_submitted",
                verification,
                kyc: verification
            });
        } catch (error) {
            console.error("KYC status error:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to load verification status"
            });
        }
    }
);


function handleKraReportUpload(req, res, next) {
    kycDocumentsUpload.fields([
        { name: "kra_report", maxCount: 1 },
        { name: "id_front", maxCount: 1 },
        { name: "id_back", maxCount: 1 },
        { name: "proof_of_address", maxCount: 1 }
    ])(req, res, (error) => {
        if (error) {
            if (error instanceof multer.MulterError) {
                let message = "Invalid KYC document upload.";

                if (error.code === "LIMIT_FILE_SIZE") {
                    message = "Each KYC document must not exceed 5 MB.";
                } else if (error.code === "LIMIT_FILE_COUNT") {
                    message = "You can upload a maximum of four KYC documents.";
                } else if (
                    error.code === "LIMIT_UNEXPECTED_FILE"
                ) {
                    message = "Unexpected or duplicate document field.";
                }

                return res.status(400).json({
                    success: false,
                    message
                });
            }

            console.error("KYC upload middleware error:", error);

            return res.status(400).json({
                success: false,
                message: "Unable to process the uploaded documents."
            });
        }

        next();
    });
}

// Submit a new KYC verification or resubmit after rejection.
app.post(
    "/api/kyc/submit",
    authenticateUser,
    handleKraReportUpload,
    async (req, res) => {
        let client;
        const savedFilePaths = [];
        let transactionStarted = false;

        try {
            const userId = req.user.id;

            const fullLegalName = String(
                req.body.full_legal_name || ""
            ).trim();

            const dateOfBirth = String(
                req.body.date_of_birth || ""
            ).trim();

            const countryOfResidence = String(
                req.body.country_of_residence || ""
            ).trim();

            const phoneNumber = String(
                req.body.phone_number || ""
            ).trim();

            const residentialAddress = String(
                req.body.residential_address || ""
            ).trim();

            const declarationAccepted = [
                "true",
                "1",
                "on"
            ].includes(
                String(
                    req.body.declaration_accepted || ""
                ).trim().toLowerCase()
            );

            // ------------------------------
            // Validate submitted information
            // ------------------------------

            if (
                fullLegalName.length < 2 ||
                fullLegalName.length > 150
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Enter your full legal name"
                });
            }

            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
                return res.status(400).json({
                    success: false,
                    message: "Enter a valid date of birth"
                });
            }

            const parsedBirthDate = new Date(
                `${dateOfBirth}T00:00:00.000Z`
            );

            if (
                Number.isNaN(parsedBirthDate.getTime()) ||
                parsedBirthDate.toISOString().slice(0, 10) !== dateOfBirth ||
                dateOfBirth >= new Date().toISOString().slice(0, 10)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Date of birth must be a valid past date"
                });
            }

            if (
                countryOfResidence.length < 2 ||
                countryOfResidence.length > 100
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Enter your country of residence"
                });
            }

            if (
                phoneNumber.length < 7 ||
                phoneNumber.length > 25
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Enter a valid phone number"
                });
            }

            if (
                residentialAddress.length < 5 ||
                residentialAddress.length > 500
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Enter your residential address"
                });
            }

            if (!declarationAccepted) {
                return res.status(400).json({
                    success: false,
                    message: "You must accept the declaration"
                });
            }

          
            // ------------------------------
            // Save all documents privately
            // ------------------------------

            
           
const documentFilenames = {};

const allowedKycDocuments = {
    kra_report: ["application/pdf"],
    id_front: ["image/jpeg", "image/png", "image/webp"],
    id_back: ["image/jpeg", "image/png", "image/webp"],
    proof_of_address: ["image/jpeg", "image/png", "image/webp"]
};

const requiredKycDocuments = [
    "kra_report",
    "id_front",
    "id_back",
    "proof_of_address"
];

const kycFiles = [];
const uploadedFields = new Set();

for (const [field, files] of Object.entries(req.files || {})) {
    const allowedTypes = allowedKycDocuments[field];

    if (!allowedTypes || !Array.isArray(files) || files.length !== 1) {
        return res.status(400).json({
            success: false,
            message: "Invalid KYC document upload."
        });
    }

    for (const file of files) {
        if (
            !file ||
            !Buffer.isBuffer(file.buffer) ||
            file.buffer.length === 0 ||
            !allowedTypes.includes(file.mimetype)
        ) {
            return res.status(400).json({
                success: false,
                message: `Invalid file for ${field}.`
            });
        }

        let extension;

        if (file.mimetype === "application/pdf") {
            extension = "pdf";
        } else if (file.mimetype === "image/jpeg") {
            extension = "jpg";
        } else if (file.mimetype === "image/png") {
            extension = "png";
        } else if (file.mimetype === "image/webp") {
            extension = "webp";
        }

        kycFiles.push({
            field,
            extension,
            file
        });

        uploadedFields.add(field);
    }
}

const missingDocuments = requiredKycDocuments.filter(
    field => !uploadedFields.has(field)
);

if (missingDocuments.length > 0) {
    return res.status(400).json({
        success: false,
        message: "Upload your KRA report, both sides of your ID, and proof of address."
    });
}

await fsPromises.mkdir(PRIVATE_KYC_DIR, {
    recursive: true,
    mode: 0o700
});

for (const item of kycFiles) {
    const filename = `${crypto.randomUUID()}.${item.extension}`;

    const filePath = path.join(PRIVATE_KYC_DIR, filename);

    await fsPromises.writeFile(filePath, item.file.buffer, {
        flag: "wx",
        mode: 0o600
    });

    savedFilePaths.push(filePath);
    documentFilenames[item.field] = filename;
}


            // ------------------------------
            // Check Neon and prevent duplicate
            // pending/approved submissions.
            // ------------------------------

            client = await db.pool.connect();

            await client.query("BEGIN");
            transactionStarted = true;

            // Serializes submissions for the same user, including
            // when the user has not submitted any KYC record before.
            await client.query(
                `SELECT pg_advisory_xact_lock(
                    hashtext($1),
                    hashtext('kyc_submission')
                )`,
                [userId]
            );

            const latestResult = await client.query(
                `SELECT id, status
                 FROM kyc_verifications
                 WHERE user_id = $1
                 ORDER BY
                    updated_at DESC NULLS LAST,
                    created_at DESC
                 LIMIT 1`,
                [userId]
            );

            const latest = latestResult.rows[0] || null;

            const latestStatus = String(
                latest?.status || ""
            ).trim().toLowerCase();

            if (
                latestStatus === "pending" ||
                latestStatus === "approved" ||
                latestStatus === "verified"
            ) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return res.status(409).json({
                    success: false,
                    message: latestStatus === "pending"
                        ? "Your verification is already pending review"
                        : "Your verification has already been approved",
                    status: latestStatus
                });
            }

            
            // Store only the generated filename in Neon.
            // Do not expose filesystem paths to the frontend.
    const insertResult = await client.query(
    `UPDATE kyc_verifications
     SET
        status = 'pending',
        full_legal_name = $2,
        date_of_birth = $3,
        country_of_residence = $4,
        phone_number = $5,
        residential_address = $6,
        kra_report_path = $7,
        id_front_path = $8,
        id_back_path = $9,
        proof_of_address_path = $10,
        kra_report_uploaded_at = NOW(),
        declaration_accepted = TRUE,
        rejection_reason = NULL,
        reviewed_by = NULL,
        reviewed_at = NULL,
        updated_at = NOW()
     WHERE user_id = $1
       AND LOWER(TRIM(status)) = 'rejected'
     RETURNING
        id,
        status,
        full_legal_name,
        date_of_birth,
        country_of_residence,
        phone_number,
        residential_address,
        id_front_path,
        id_back_path,
        proof_of_address_path,
        kra_report_path,
        declaration_accepted,
        kra_report_uploaded_at,
        created_at,
        updated_at`,
    [
        userId,
        fullLegalName,
        dateOfBirth,
        countryOfResidence,
        phoneNumber,
        residentialAddress,
        documentFilenames.kra_report,
        documentFilenames.id_front,
        documentFilenames.id_back,
        documentFilenames.proof_of_address
    ]
);     
if (insertResult.rowCount === 0) {
    // No rejected record was updated, so create the first record.
    const existingResult = await client.query(
        `SELECT id, status
         FROM kyc_verifications
         WHERE user_id = $1
         LIMIT 1`,
        [userId]
    );

    if (existingResult.rows.length > 0) {
        throw new Error(
            "Your existing verification could not be resubmitted. Please refresh and try again."
        );
    }
const newResult = await client.query(
    `INSERT INTO kyc_verifications (
        id,
        user_id,
        status,
        full_legal_name,
        date_of_birth,
        country_of_residence,
        phone_number,
        residential_address,
        kra_report_path,
        id_front_path,
        id_back_path,
        proof_of_address_path,
        kra_report_uploaded_at,
        declaration_accepted,
        created_at,
        updated_at
    )
    VALUES (
        $1, $2, 'pending',
        $3, $4, $5, $6, $7,
        $8, $9, $10, $11,
        NOW(), TRUE, NOW(), NOW()
    )
    RETURNING
        id,
        status,
        full_legal_name,
        date_of_birth,
        country_of_residence,
        phone_number,
        residential_address,
        kra_report_path,
        id_front_path,
        id_back_path,
        proof_of_address_path,
        declaration_accepted,
        kra_report_uploaded_at,
        created_at,
        updated_at`,
    [
        crypto.randomUUID(),
        userId,
        fullLegalName,
        dateOfBirth,
        countryOfResidence,
        phoneNumber,
        residentialAddress,
        documentFilenames.kra_report,
        documentFilenames.id_front,
        documentFilenames.id_back,
        documentFilenames.proof_of_address
    ]
);
    insertResult.rows = newResult.rows;
    insertResult.rowCount = newResult.rowCount;
}
            await client.query("COMMIT");
            transactionStarted = false;

          const verification = insertResult.rows[0];

return res.status(201).json({
    success: true,
    message: "KYC documents submitted successfully. Your application is pending review.",
    status: verification.status,
    verification,
    kyc: verification
});
        } catch (error) {
            if (client && transactionStarted) {
                try {
                    await client.query("ROLLBACK");
                } catch (rollbackError) {
                    console.error(
                        "KYC transaction rollback error:",
                        rollbackError
                    );
                }

                transactionStarted = false;
            }

          
            // Remove newly saved files if submission fails.
            for (const filePath of savedFilePaths) {
                try {
                    await fsPromises.unlink(filePath);
                } catch (fileError) {
                    if (fileError.code !== "ENOENT") {
                        console.error(
                            "KYC orphan-file cleanup error:",
                            fileError
                        );
                    }
                }
            }


            console.error("KYC submission error:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to submit verification. Please try again."
            });
        } finally {
            if (client) {
                client.release();
            }
        }
    }
);

// ==========================================
// ADMIN ROUTES
// ==========================================
registerAdminRoutes(app, authenticateUser);

const registeredRoutesAfterAdmin =
    (app.router || app._router)?.stack || [];

console.log(
    "COMPLETED DEPOSITS ROUTE AFTER REGISTRATION:",
    registeredRoutesAfterAdmin
        .filter(layer => layer.route)
        .filter(layer =>
            layer.route.path === "/api/admin/completed-deposits"
        )
        .map(layer => ({
            path: layer.route.path,
            methods: Object.keys(layer.route.methods)
        }))
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
            : String(market.symbol || "")
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
    const number = Number(price);

    if (!Number.isFinite(number)) {
        return null;
    }

    return Math.abs(Math.floor(number * 100)) % 10;
}

// ==========================================
// TOUCH / NO TOUCH FIXED BARRIER
// ==========================================

function calculateTouchBarrier(entryPrice, direction) {
    const price = Number(entryPrice);

    const normalizedDirection =
        String(direction || "").trim().toLowerCase();

    if (!Number.isFinite(price) || price <= 0) {
        throw new Error("Invalid touch barrier entry price");
    }

    const distance = TOUCH_BARRIER_DISTANCE;

    if (normalizedDirection === "above") {
        return Number((price + distance).toFixed(2));
    }

    if (normalizedDirection === "below") {
        return Number((price - distance).toFixed(2));
    }

    throw new Error(
        "Touch barrier direction must be above or below"
    );
}

// ==========================================
// ACCUMULATOR FIXED KNOCKOUT BARRIER
// ==========================================

function calculateAccumulatorBarrier(entryPrice, direction) {
    const price = Number(entryPrice);

    const normalizedDirection =
        String(direction || "").trim().toLowerCase();

    if (!Number.isFinite(price) || price <= 0) {
        throw new Error("Invalid accumulator entry price");
    }

    const distance = price * ACCUMULATOR_KNOCKOUT_PERCENT;

    if (normalizedDirection === "above") {
        return Number((price + distance).toFixed(2));
    }

    if (normalizedDirection === "below") {
        return Number((price - distance).toFixed(2));
    }

    throw new Error(
        "Accumulator direction must be above or below"
    );
}

// ==========================================
// WALLET HELPER — NEON
// ==========================================

async function getOrCreateWallet(userId) {
    try {
        const result = await db.query(
            `SELECT *
             FROM wallets
             WHERE user_id = $1
             LIMIT 1`,
            [userId]
        );

        if (result.rows.length > 0) {
            return result.rows[0];
        }

        const created = await db.query(
            `INSERT INTO wallets (
                user_id,
                balance,
                bonus_balance,
                demo_balance,
                currency
            )
            VALUES ($1, 0, 0, 10000, 'USD')
            ON CONFLICT (user_id) DO NOTHING
            RETURNING *`,
            [userId]
        );

        if (created.rows.length > 0) {
            return created.rows[0];
        }

        // Handle another request creating the wallet simultaneously.
        const retry = await db.query(
            `SELECT *
             FROM wallets
             WHERE user_id = $1
             LIMIT 1`,
            [userId]
        );

        if (retry.rows.length > 0) {
            return retry.rows[0];
        }

        throw new Error(
            "Wallet could not be found or created in Neon"
        );
    } catch (error) {
        console.error("Neon getOrCreateWallet error:", error);
        throw error;
    }
}

// ============================================================
// KMFBINARY PROMOTIONS & REFERRALS — NEON
// ============================================================

async function getActivePromotion(type) {
    try {
        const result = await db.query(
            `SELECT *
             FROM promotions
             WHERE type = $1
               AND active = TRUE
               AND (start_at IS NULL OR start_at <= NOW())
               AND (expires_at IS NULL OR expires_at >= NOW())
             ORDER BY id DESC
             LIMIT 1`,
            [type]
        );

        return result.rows[0] || null;
    } catch (error) {
        console.error("Neon getActivePromotion error:", error);
        throw error;
    }
}

async function calculateDepositBonus(
    userId,
    depositAmount,
    depositId
) {
    const amount = Number(depositAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
        return {
            bonusAmount: 0,
            promotion: null,
            isReferred: false
        };
    }

    const referralResult = await db.query(
        `SELECT 1
         FROM referrals
         WHERE referred_user_id = $1
         LIMIT 1`,
        [userId]
    );

    const isReferred = referralResult.rows.length > 0;

    let promotion = null;

    if (isReferred) {
        promotion = await getActivePromotion("referral_deposit");
    }

    if (!promotion) {
        promotion = await getActivePromotion("deposit");
    }

    if (!promotion) {
        return {
            bonusAmount: 0,
            promotion: null,
            isReferred
        };
    }

    const minimumDeposit = Number(promotion.min_deposit || 0);

    if (amount < minimumDeposit) {
        return {
            bonusAmount: 0,
            promotion,
            isReferred
        };
    }

    let bonusAmount =
        amount * (Number(promotion.bonus_percent || 0) / 100);

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

    bonusAmount = Number(bonusAmount.toFixed(2));

    return {
        bonusAmount: Math.max(0, bonusAmount),
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
    if (
        !promotion ||
        !Number.isFinite(Number(bonusAmount)) ||
        Number(bonusAmount) <= 0
    ) {
        return null;
    }

    const result = await db.query(
        `INSERT INTO user_bonuses (
            user_id,
            promotion_id,
            deposit_id,
            deposit_amount,
            bonus_amount,
            remaining_bonus,
            status
        )
        VALUES ($1, $2, $3, $4, $5, $5, 'active')
        RETURNING *`,
        [
            userId,
            promotion.id,
            depositId || null,
            Number(depositAmount),
            Number(bonusAmount)
        ]
    );

    return result.rows[0] || null;
}

async function getTradingBalance(userId) {
    const wallet = await getOrCreateWallet(userId);

    const realBalance = Number(wallet.balance || 0);
    const bonusBalance = Number(wallet.bonus_balance || 0);

    return {
        realBalance,
        bonusBalance,
        tradingBalance: realBalance + bonusBalance,
        withdrawableBalance: realBalance
    };
}

async function addBonusToWallet(userId, bonusAmount) {
    const amount = Number(bonusAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
        return null;
    }

    const wallet = await getOrCreateWallet(userId);

    const result = await db.query(
        `UPDATE wallets
         SET bonus_balance = ROUND(
                (COALESCE(bonus_balance, 0) + $1)::numeric,
                2
             ),
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [amount, wallet.id]
    );

    if (!result.rows.length) {
        throw new Error("Wallet not found while adding bonus");
    }

    return result.rows[0];
}

async function clearBonusBalance(
    userId,
    reason = "bonus_ended"
) {
    const wallet = await getOrCreateWallet(userId);

    const result = await db.query(
        `UPDATE wallets
         SET bonus_balance = 0,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [wallet.id]
    );

    if (!result.rows.length) {
        throw new Error("Wallet not found while clearing bonus");
    }

    await db.query(
        `UPDATE user_bonuses
         SET remaining_bonus = 0,
             status = 'ended',
             ended_at = NOW()
         WHERE user_id = $1
           AND status = 'active'`,
        [userId]
    );

    console.log(
        `KMFBinary bonus cleared for user ${userId}. Reason: ${reason}`
    );

    return result.rows[0];
}

// ==========================================
// MPESA DARAJA HELPERS
// ==========================================

async function getMpesaAccessToken() {
    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;

    if (!consumerKey || !consumerSecret) {
        throw new Error("M-Pesa consumer credentials are missing");
    }

    const auth = Buffer
        .from(`${consumerKey}:${consumerSecret}`)
        .toString("base64");

    const response = await axios.get(
       "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
        {
            headers: {
                Authorization: `Basic ${auth}`
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
    const accessToken = await getMpesaAccessToken();

    const shortcode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;

    if (!shortcode || !passkey) {
        throw new Error("M-Pesa STK configuration is incomplete");
    }

    const now = new Date();

    const kenyaTime = new Date(
        now.toLocaleString("en-US", {
            timeZone: "Africa/Nairobi"
        })
    );

    const timestamp =
        kenyaTime.getFullYear().toString() +
        String(kenyaTime.getMonth() + 1).padStart(2, "0") +
        String(kenyaTime.getDate()).padStart(2, "0") +
        String(kenyaTime.getHours()).padStart(2, "0") +
        String(kenyaTime.getMinutes()).padStart(2, "0") +
        String(kenyaTime.getSeconds()).padStart(2, "0");

    const password = Buffer
        .from(shortcode + passkey + timestamp)
        .toString("base64");

    console.log("STK TIMESTAMP:", timestamp);
    console.log("STK PASSWORD LENGTH:", password.length);
    console.log("SHORTCODE USED:", shortcode);
    console.log("PASSKEY LENGTH:", passkey.length);
    console.log("STK CALLBACK URL:", process.env.MPESA_CALLBACK_URL);

    const response = await axios.post(
        "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
        {
            BusinessShortCode: shortcode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: "CustomerBuyGoodsOnline",
            Amount: amount,
            PartyA: phoneNumber,
           PartyB: process.env.MPESA_TILL_NUMBER,
            PhoneNumber: phoneNumber,
            CallBackURL: process.env.MPESA_CALLBACK_URL,
            AccountReference: accountReference,
            TransactionDesc: transactionDescription
        },
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            }
        }
    );

    return response.data;
}

// ==========================================
// MPESA STK PUSH QUERY
// ==========================================

async function queryMpesaStkPush(checkoutRequestId) {
    const accessToken = await getMpesaAccessToken();

    const shortcode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;

    if (!shortcode || !passkey) {
        throw new Error("M-Pesa STK configuration is incomplete");
    }

    if (!checkoutRequestId) {
        throw new Error("CheckoutRequestID is required");
    }

    const now = new Date();

    const kenyaTime = new Date(
        now.toLocaleString("en-US", {
            timeZone: "Africa/Nairobi"
        })
    );

    const timestamp =
        kenyaTime.getFullYear().toString() +
        String(kenyaTime.getMonth() + 1).padStart(2, "0") +
        String(kenyaTime.getDate()).padStart(2, "0") +
        String(kenyaTime.getHours()).padStart(2, "0") +
        String(kenyaTime.getMinutes()).padStart(2, "0") +
        String(kenyaTime.getSeconds()).padStart(2, "0");

    const password = Buffer
        .from(shortcode + passkey + timestamp)
        .toString("base64");

    console.log("==========================================");
    console.log("🔎 MPESA STK QUERY");
    console.log("CheckoutRequestID:", checkoutRequestId);
    console.log("==========================================");

    const response = await axios.post(
        "https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query",
        {
            BusinessShortCode: shortcode,
            Password: password,
            Timestamp: timestamp,
            CheckoutRequestID: checkoutRequestId
        },
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            }
        }
    );

    console.log("🔥 STK QUERY RESPONSE:", response.data);

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
    const accessToken = await getMpesaAccessToken();

    const shortcode = process.env.MPESA_B2C_SHORTCODE;
    const initiatorName = process.env.MPESA_B2C_INITIATOR_NAME;
    const securityCredential = process.env.MPESA_B2C_SECURITY_CREDENTIAL;
    const resultURL = process.env.MPESA_B2C_RESULT_URL;
    const timeoutURL = process.env.MPESA_B2C_TIMEOUT_URL;

    if (
        !shortcode ||
        !initiatorName ||
        !securityCredential ||
        !resultURL ||
        !timeoutURL
    ) {
        throw new Error("B2C M-Pesa configuration is incomplete");
    }

    console.log("====================================");
    console.log("🔥 MPESA B2C REQUEST");
    console.log("Amount:", amount);
    console.log("Phone:", phoneNumber);
    console.log("OriginatorConversationID:", originatorConversationID);
    console.log("🔥 B2C RESULT URL:", resultURL);
    console.log("🔥 B2C TIMEOUT URL:", timeoutURL);
    console.log("====================================");

    const response = await axios.post(
        "https://sandbox.safaricom.co.ke/mpesa/b2c/v3/paymentrequest",
        {
            OriginatorConversationID: originatorConversationID,
            InitiatorName: initiatorName,
            SecurityCredential: securityCredential,
            CommandID: "BusinessPayment",
            Amount: amount,
            PartyA: shortcode,
            PartyB: phoneNumber,
            Remarks: remarks || "KMFBinary withdrawal",
            QueueTimeOutURL: timeoutURL,
            ResultURL: resultURL,
            Occassion: "KMFBinary withdrawal"
        },
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            }
        }
    );

    console.log("🔥 MPESA B2C RESPONSE:", response.data);

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

            console.log("====================================");
            console.log("🔎 MPESA B2C STATUS QUERY");
            console.log("OriginatorConversationID:", originatorConversationID);
            console.log("====================================");

            const accessToken = await getMpesaAccessToken();

            const shortcode = process.env.MPESA_B2C_SHORTCODE;
            const initiatorName = process.env.MPESA_B2C_INITIATOR_NAME;
            const securityCredential =
                process.env.MPESA_B2C_SECURITY_CREDENTIAL;
            const resultURL = process.env.MPESA_B2C_STATUS_RESULT_URL;
            const timeoutURL = process.env.MPESA_B2C_STATUS_TIMEOUT_URL;

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

            const response = await axios.post(
                "https://sandbox.safaricom.co.ke/mpesa/transactionstatus/v1/query",
                {
                    Initiator: initiatorName,
                    SecurityCredential: securityCredential,
                    CommandID: "TransactionStatusQuery",
                    TransactionID: "",
                    OriginalConversationID: originatorConversationID,
                    PartyA: shortcode,
                    IdentifierType: "4",
                    ResultURL: resultURL,
                    QueueTimeOutURL: timeoutURL,
                    Remarks: "KMFBinary transaction status",
                    Occasion: "KMFBinary status query"
                },
                {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        "Content-Type": "application/json"
                    }
                }
            );

            console.log("🔥 MPESA STATUS RESPONSE:", response.data);

            return res.json({
                success: true,
                data: response.data
            });
        } catch (error) {
            console.error(
                "❌ MPESA STATUS ERROR:",
                error.response?.data || error.message
            );

            return res.status(500).json({
                success: false,
                error: error.response?.data || error.message
            });
        }
    }
);

// ==========================================
// GET CURRENT SYNTHETIC PRICES
// ==========================================

app.get("/api/prices", (req, res) => {
    try {
        const prices = syntheticMarket.getAllPrices();

        return res.json({
            success: true,
            prices
        });
    } catch (error) {
        console.error("Price API error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load market prices"
        });
    }
});

// ==========================================
// HOME
// ==========================================

app.get("/", (req, res) => {
    return res.json({
        success: true,
        message: "KMFBinary backend is running",
        mode: "synthetic-development"
    });
});

// ==========================================
// GET ACTIVE MARKETS — NEON
// ==========================================

app.get("/api/markets", async (req, res) => {
    try {
        const marketsResult = await db.query(
            `SELECT *
             FROM markets
             WHERE is_active = TRUE
             ORDER BY market_name ASC`
        );

        const markets = [...marketsResult.rows];

        // Load 1-second volatility markets using their real database UUIDs.
        const oneSecondMarketsResult = await db.query(
            `SELECT *
             FROM markets
             WHERE symbol = ANY($1::text[])
               AND is_active = TRUE`,
            [[
                "VOL-10-1S",
                "VOL-25-1S",
                "VOL-50-1S",
                "VOL-75-1S",
                "VOL-100-1S"
            ]]
        );

        const oneSecondMarkets = oneSecondMarketsResult.rows;

        const existingSymbols = new Set(
            markets.map(market =>
                String(market.symbol || "")
                    .trim()
                    .toUpperCase()
            )
        );

        oneSecondMarkets.forEach(market => {
            const symbol = String(market.symbol || "")
                .trim()
                .toUpperCase();

            if (!existingSymbols.has(symbol)) {
                markets.push(market);
                existingSymbols.add(symbol);
            } else {
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

        markets.sort((a, b) => {
            const nameA = String(a.market_name || a.symbol || "");
            const nameB = String(b.market_name || b.symbol || "");

            return nameA.localeCompare(nameB);
        });

        return res.json({
            success: true,
            markets
        });
    } catch (error) {
        console.error("Markets API error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load markets"
        });
    }
});

// ==========================================
// TEST DATABASE — NEON
// ==========================================

app.get("/api/test-db", async (req, res) => {
    try {
        const result = await db.query(
            `SELECT *
             FROM markets
             LIMIT 10`
        );

        return res.json({
            success: true,
            message: "Neon connection successful",
            markets: result.rows
        });
    } catch (error) {
        console.error("Neon database test error:", error);

        return res.status(500).json({
            success: false,
            message: "Neon connection failed"
        });
    }
});

// ==========================================
// WALLET
// ==========================================

// ==========================================
// GET USER WALLET — NEON
// ==========================================

app.get(
    "/api/wallet",
    authenticateUser,
    async (req, res) => {
        try {
            const result = await db.query(
                `SELECT
                    id,
                    user_id,
                    balance,
                    demo_balance,
                    bonus_balance,
                    currency,
                    created_at,
                    updated_at
                 FROM wallets
                 WHERE user_id = $1
                 LIMIT 1`,
                [req.user.id]
            );

            const wallet = result.rows[0];

            if (!wallet) {
                return res.status(404).json({
                    success: false,
                    message: "Wallet not found"
                });
            }

            return res.json({
                success: true,
                wallet
            });
        } catch (error) {
            console.error("Get Neon wallet error:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to load wallet"
            });
        }
    }
);

// ==========================================
// GET WALLET TRANSACTIONS — NEON
// ==========================================

app.get(
    "/api/wallet/transactions",
    authenticateUser,
    async (req, res) => {
        try {
            const result = await db.query(
                `SELECT
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
                 FROM wallet_transactions
                 WHERE user_id = $1
                 ORDER BY created_at DESC
                 LIMIT 100`,
                [req.user.id]
            );

            return res.json({
                success: true,
                transactions: result.rows
            });
        } catch (error) {
            console.error("Wallet transactions API error:", error);

            return res.status(500).json({
                success: false,
                message: "Server error"
            });
        }
    }
);

// ==========================================
// GENERIC DEPOSIT REQUEST — NEON
// ==========================================

app.post(
    "/api/wallet/deposit",
    authenticateUser,
    async (req, res) => {
        try {
            const amount = Number(req.body.amount);

            const paymentMethod = String(
                req.body.paymentMethod || ""
            )
                .trim()
                .toLowerCase();

            if (!Number.isFinite(amount) || amount < 2) {
                return res.status(400).json({
                    success: false,
                    message: "Minimum deposit is $2.00"
                });
            }

            if (!paymentMethod) {
                return res.status(400).json({
                    success: false,
                    message: "Payment method is required"
                });
            }

            await getOrCreateWallet(req.user.id);

            const depositAmount =
                Math.round(amount * 1000000) / 1000000;

            const reference =
                "DEP-" +
                Date.now() +
                "-" +
                crypto.randomBytes(4).toString("hex").toUpperCase();

            const result = await db.query(
                `INSERT INTO wallet_transactions (
                    user_id,
                    transaction_type,
                    amount,
                    status,
                    payment_method,
                    reference
                )
                VALUES ($1, 'deposit', $2, 'pending', $3, $4)
                RETURNING *`,
                [
                    req.user.id,
                    depositAmount,
                    paymentMethod,
                    reference
                ]
            );

            const transaction = result.rows[0];

            return res.json({
                success: true,
                message:
                    "Deposit request created. Payment is pending confirmation.",
                deposit: transaction
            });
        } catch (error) {
            console.error("Deposit API error:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to process deposit"
            });
        }
    }
);

// ==========================================
// MPESA API DEBUG
// ==========================================

app.use("/api/mpesa", (req, res, next) => {
    console.log(
        "🔥 MPESA API REQUEST:",
        req.method,
        req.originalUrl
    );

    next();
});

 // ==========================================
 // MPESA STK PUSH — NEON
 // ==========================================

app.post(
    "/api/mpesa/stkpush",
    authenticateUser,
    async (req, res) => {
        console.log("🔥 MPESA STK REQUEST RECEIVED");

        try {

            // READ USD AMOUNT FROM FRONTEND
            // Prefer usdAmount because amount may contain KES.
            const amount = Number(
                req.body.usdAmount ?? req.body.amount
            );

            let phoneNumber = String(
                req.body.phoneNumber || ""
            )
                .trim()
                .replace(/\s+/g, "");

            // VALIDATE AMOUNT
            if (!Number.isFinite(amount) || amount <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Enter a valid deposit amount."
                });
            }

            // READ PLATFORM MINIMUM DEPOSIT FROM NEON
            const minimumResult = await db.query(
                `SELECT setting_value
                 FROM platform_settings
                 WHERE setting_key = $1
                 LIMIT 1`,
                ["minimum_deposit_usd"]
            );

            if (!minimumResult.rows[0]) {
                console.error(
                    "Minimum deposit setting is missing from platform_settings."
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Deposit settings are unavailable. Please contact support."
                });
            }

            const minimumDeposit = Number(
                minimumResult.rows[0].setting_value
            );

            if (
                !Number.isFinite(minimumDeposit) ||
                minimumDeposit <= 0
            ) {
                console.error(
                    "Invalid minimum deposit setting:",
                    minimumResult.rows[0].setting_value
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Deposit settings are invalid. Please contact support."
                });
            }

            // ENFORCE CONFIGURED MINIMUM
            if (amount < minimumDeposit) {
                return res.status(400).json({
                    success: false,
                    code: "MINIMUM_DEPOSIT_NOT_MET",
                    minimumDeposit,
                    message:
                        `Minimum deposit is $${minimumDeposit.toFixed(2)}.`
                });
            }

            // NORMALIZE PHONE
            if (/^07\d{8}$/.test(phoneNumber)) {
                phoneNumber = "254" + phoneNumber.substring(1);
            }

            if (/^\+2547\d{8}$/.test(phoneNumber)) {
                phoneNumber = phoneNumber.substring(1);
            }

            if (!/^2547\d{8}$/.test(phoneNumber)) {
                return res.status(400).json({
                    success: false,
                    message: "Use phone format 2547XXXXXXXX"
                });
            }

            // PRECISE USD AMOUNT
            const depositAmount =
                Math.round(amount * 1000000) / 1000000;

            if (
                !Number.isFinite(depositAmount) ||
                depositAmount < minimumDeposit
            ) {
                return res.status(400).json({
                    success: false,
                    code: "MINIMUM_DEPOSIT_NOT_MET",
                    minimumDeposit,
                    message:
                        `Minimum deposit is $${minimumDeposit.toFixed(2)}.`
                });
            }

            // KES AMOUNT
            const kesAmount = Math.round(
                depositAmount * USD_KES_DEPOSIT_RATE
            );

            if (!Number.isFinite(kesAmount) || kesAmount < 1) {
                return res.status(400).json({
                    success: false,
                    message: "Deposit amount is too small"
                });
            }

            // MAKE SURE WALLET EXISTS
            await getOrCreateWallet(req.user.id);

            // CREATE DEPOSIT TRANSACTION — NEON
            const reference =
                "DEP-" +
                Date.now() +
                "-" +
                crypto.randomBytes(4).toString("hex").toUpperCase();

            const transactionResult = await db.query(
                `INSERT INTO wallet_transactions (
                    user_id,
                    transaction_type,
                    type,
                    amount,
                    status,
                    payment_method,
                    reference,
                    description
                )
                VALUES (
                    $1,
                    'deposit',
                    'deposit',
                    $2,
                    'pending',
                    'mpesa',
                    $3,
                    'M-Pesa deposit'
                )
                RETURNING *`,
                [
                    req.user.id,
                    depositAmount,
                    reference
                ]
            );

            const transaction = transactionResult.rows[0];

            if (!transaction) {
                return res.status(500).json({
                    success: false,
                    message: "Unable to create payment transaction"
                });
            }

            // SEND STK PUSH
            let mpesaResponse;

            try {
                console.log("==========================================");
                console.log("STK USD amount:", depositAmount);
                console.log("KES amount sent:", kesAmount);
                console.log("Minimum deposit:", minimumDeposit);
                console.log("Reference:", reference);
                console.log("==========================================");

                mpesaResponse = await initiateMpesaStkPush({
                    phoneNumber,
                    amount: kesAmount,
                    accountReference: reference,
                    transactionDescription: "KMFBinary Deposit"
                });

            } catch (mpesaError) {
                console.error("M-Pesa STK request outcome uncertain:", {
                    status: mpesaError.response?.status,
                    response: mpesaError.response?.data,
                    message: mpesaError.message,
                    reference
                });

                // Keep uncertain outcomes pending for reconciliation.
                try {
                    await db.query(
                        `UPDATE wallet_transactions
                         SET result_code = 'STK_OUTCOME_UNKNOWN',
                             result_description = $1
                         WHERE id = $2
                           AND status = 'pending'`,
                        [
                            "STK outcome uncertain. Verify with Safaricom before retrying.",
                            transaction.id
                        ]
                    );
                } catch (updateError) {
                    console.error(
                        "Unable to record uncertain STK outcome:",
                        updateError
                    );
                }

                return res.status(502).json({
                    success: false,
                    status: "verification_required",
                    reference,
                    message:
                        "We could not confirm the M-Pesa request outcome. Do not retry this deposit yet; contact support to verify the payment."
                });
            }

            console.log("M-Pesa STK response:", mpesaResponse);

            // CHECK MPESA RESPONSE
            if (String(mpesaResponse?.ResponseCode) !== "0") {
                const failureMessage =
                    mpesaResponse?.ResponseDescription ||
                    mpesaResponse?.errorMessage ||
                    "M-Pesa STK Push failed";

                await db.query(
                    `UPDATE wallet_transactions
                     SET status = 'failed',
                         result_code = $1,
                         result_description = $2
                     WHERE id = $3
                       AND status = 'pending'`,
                    [
                        String(mpesaResponse?.ResponseCode || ""),
                        failureMessage,
                        transaction.id
                    ]
                );

                return res.status(400).json({
                    success: false,
                    message: failureMessage
                });
            }

            // SAVE AND VERIFY MPESA REQUEST IDS — NEON
            try {
                const saveResult = await db.query(
                    `UPDATE wallet_transactions
                     SET checkout_request_id = $1,
                         merchant_request_id = $2
                     WHERE id = $3
                     RETURNING id, reference, transaction_type, status,
                               checkout_request_id, merchant_request_id`,
                    [
                        mpesaResponse.CheckoutRequestID,
                        mpesaResponse.MerchantRequestID,
                        transaction.id
                    ]
                );

                if (!saveResult.rows[0]) {
                    throw new Error(
                        `No deposit row updated for transaction ID ${transaction.id}`
                    );
                }

                console.log(
                    "MPESA IDS SAVED AND VERIFIED:",
                    saveResult.rows[0]
                );

            } catch (updateError) {
                console.error("Unable to save/verify M-Pesa request IDs:", {
                    transactionId: transaction.id,
                    reference,
                    checkoutRequestId: mpesaResponse?.CheckoutRequestID,
                    merchantRequestId: mpesaResponse?.MerchantRequestID,
                    error: updateError.message
                });

                return res.status(500).json({
                    success: false,
                    message:
                        "Payment prompt may have been sent, but its reference could not be verified. Contact support before retrying.",
                    reference
                });
            }

            // RESPONSE
            return res.json({
                success: true,
                message:
                    "M-Pesa payment prompt sent. Enter your PIN on your phone.",
                reference,
                checkoutRequestId: mpesaResponse.CheckoutRequestID,
                merchantRequestId: mpesaResponse.MerchantRequestID,
                transactionId: transaction.id,
                amountUSD: depositAmount,
                amountKES: kesAmount
            });

        } catch (error) {
            console.error("M-Pesa STK Push error:", error);

            return res.status(500).json({
                success: false,
                message:
                    error.message ||
                    "Unable to initiate M-Pesa payment"
            });
        }
    }
);

// ==========================================
// MPESA STK QUERY ROUTE — NEON
// ==========================================

app.get(
    "/api/mpesa/stkpush/query/:checkoutRequestId",
    authenticateUser,
    async (req, res) => {
        try {
            const checkoutRequestId = String(
                req.params.checkoutRequestId || ""
            ).trim();

            if (!checkoutRequestId) {
                return res.status(400).json({
                    success: false,
                    message: "CheckoutRequestID is required"
                });
            }

            // FIND USER'S TRANSACTION — NEON
const transactionResult = await db.query(
                            `SELECT *
                 FROM wallet_transactions
                 WHERE user_id = $1
                   AND checkout_request_id = $2
                   AND transaction_type = 'deposit'
                 LIMIT 1`,
                [
                    req.user.id,
                    checkoutRequestId
                ]
            );

            const transaction = transactionResult.rows[0] || null;

            if (!transaction) {
                return res.status(404).json({
                    success: false,
                    message: "Deposit transaction not found"
                });
            }

            // ALREADY COMPLETED
            if (transaction.status === "completed") {
                return res.json({
                    success: true,
                    status: "completed",
                    message:
                        "This deposit has already been completed.",
                    transaction
                });
            }

            // QUERY SAFARICOM.
            // This route does not directly credit the wallet.
            const mpesaResponse =
                await queryMpesaStkPush(checkoutRequestId);

            return res.json({
                success: true,
                status: transaction.status,
                transaction,
                mpesa: mpesaResponse
            });
        } catch (error) {
            console.error(
                "STK Push Query error:",
                error.response?.data || error.message
            );

            return res.status(500).json({
                success: false,
                message: "Unable to query M-Pesa payment",
                error: error.response?.data || error.message
            });
        }
    }
);

// ==========================================
// MPESA CALLBACK
// ==========================================

app.post("/api/mpesa/callback", async (req, res) => {
    console.log("==========================================");
    console.log("🔥 MPESA CALLBACK RECEIVED");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("==========================================");

    // ACKNOWLEDGE SAFARICOM IMMEDIATELY
    res.status(200).json({
        ResultCode: 0,
        ResultDesc: "Callback received successfully"
    });

    try {
        const stkCallback = req.body?.Body?.stkCallback;

        if (!stkCallback) {
            console.error("Invalid M-Pesa callback structure");
            return;
        }

        const checkoutRequestId = stkCallback.CheckoutRequestID;
        const merchantRequestId = stkCallback.MerchantRequestID;
        const resultCode = String(stkCallback.ResultCode);
        const resultDescription = stkCallback.ResultDesc || "";
        console.log("MPESA CALLBACK IDENTIFIERS:", {
            checkoutRequestId,
            merchantRequestId,
            resultCode
        });
        if (!checkoutRequestId) {
            console.error("Missing CheckoutRequestID");
            return;
        }

        // FIND DEPOSIT — NEON
      
        // Retry briefly in case STK initiation has not saved the checkout ID yet.
        let transaction = null;
        const callbackLookupAttempts = 10;

        for (let attempt = 1; attempt <= callbackLookupAttempts; attempt++) {
            const transactionResult = await db.query(
                `SELECT *
                 FROM wallet_transactions
                 WHERE checkout_request_id = $1
                   AND transaction_type = 'deposit'
                 LIMIT 1`,
                [checkoutRequestId]
            );

            transaction = transactionResult.rows[0] || null;

            if (transaction) {
                break;
            }

            if (attempt < callbackLookupAttempts) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        if (!transaction) {
            console.error(
                "M-Pesa callback could not be matched to a deposit after retries:",
                {
                    checkoutRequestId,
                    merchantRequestId
                }
            );
            return;
        }
console.log("MPESA CALLBACK MATCHED DEPOSIT:", {
    transactionId: transaction.id,
    reference: transaction.reference,
    status: transaction.status,
    checkoutRequestId: transaction.checkout_request_id
});

        // DUPLICATE PROTECTION
        if (transaction.status === "completed") {
            console.log(
                "Deposit already completed:",
                transaction.reference
            );
            return;
        }

        // FAILED PAYMENT
        if (Number(stkCallback.ResultCode) !== 0) {
            await db.query(
                `UPDATE wallet_transactions
                 SET status = 'failed',
                     result_code = $1,
                     result_description = $2,
                     merchant_request_id = $3
                 WHERE id = $4
                   AND status = 'pending'`,
                [
                    resultCode,
                    resultDescription,
                    merchantRequestId,
                    transaction.id
                ]
            );

            console.log(
                "M-Pesa payment failed:",
                transaction.reference,
                resultDescription
            );

            return;
        }

        // READ CALLBACK METADATA
        const items =
            stkCallback.CallbackMetadata?.Item || [];

        function getMetadataValue(name) {
            const item = items.find(x => x.Name === name);
            return item ? item.Value : null;
        }

        const mpesaReceipt =
            getMetadataValue("MpesaReceiptNumber");

        const callbackAmountKES =
            Number(getMetadataValue("Amount"));

        const phoneNumber =
            getMetadataValue("PhoneNumber");

        // REQUIRE MPESA RECEIPT BEFORE CREDITING
        if (
            typeof mpesaReceipt !== "string" ||
            !mpesaReceipt.trim()
        ) {
            console.error("M-Pesa receipt missing:", {
                reference: transaction.reference,
                checkoutRequestId,
                merchantRequestId
            });

            try {
                await db.query(
                    `UPDATE wallet_transactions
                     SET result_code = 'RECEIPT_MISSING',
                         result_description = $1,
                         merchant_request_id = $2
                     WHERE id = $3
                       AND status = 'pending'`,
                    [
                        "Safaricom reported success, but the receipt is missing. Manual verification required.",
                        merchantRequestId,
                        transaction.id
                    ]
                );
            } catch (updateError) {
                console.error(
                    "Unable to record missing M-Pesa receipt:",
                    updateError
                );
            }

            return;
        }

        // VALIDATE STORED USD
        const depositAmountUSD = Number(transaction.amount);

        if (
            !Number.isFinite(depositAmountUSD) ||
            depositAmountUSD <= 0
        ) {
            console.error(
                "Invalid stored deposit amount:",
                transaction.amount
            );
            return;
        }

        // EXPECTED KES
        const expectedAmountKES = Math.max(
            1,
            Math.round(
                depositAmountUSD * USD_KES_DEPOSIT_RATE
            )
        );

        console.log("M-Pesa amount verification:", {
            depositUSD: depositAmountUSD,
            expectedKES: expectedAmountKES,
            receivedKES: callbackAmountKES,
            rate: USD_KES_DEPOSIT_RATE
        });

               // VERIFY KES AMOUNT — HOLD MISMATCH FOR RECONCILIATION
        if (
            !Number.isFinite(callbackAmountKES) ||
            callbackAmountKES !== expectedAmountKES
        ) {
            console.error("M-Pesa amount mismatch:", {
                expectedKES: expectedAmountKES,
                receivedKES: callbackAmountKES,
                depositUSD: depositAmountUSD,
                reference: transaction.reference,
                checkoutRequestId,
                merchantRequestId
            });

            try {
                await db.query(
                    `UPDATE wallet_transactions
                     SET result_code = 'AMOUNT_MISMATCH',
                         result_description = $1,
                         merchant_request_id = $2
                     WHERE id = $3
                       AND status = 'pending'`,
                    [
                        "M-Pesa amount mismatch. Verify payment with Safaricom before resolving.",
                        merchantRequestId,
                        transaction.id
                    ]
                );
            } catch (updateError) {
                console.error(
                    "Unable to record M-Pesa amount mismatch:",
                    updateError
                );
            }

            return;
        }
        // CONVERT KES TO USD
        const creditedUSD =
            Math.round(
                (callbackAmountKES / USD_KES_DEPOSIT_RATE) *
                1000000
            ) / 1000000;

        // GET WALLET — NEON
        const wallet = await getOrCreateWallet(transaction.user_id);
        const currentBalance = Number(wallet.balance);

        if (!Number.isFinite(currentBalance)) {
            console.error("Invalid wallet balance:", wallet.balance);
            return;
        }


        // CREDIT WALLET, COMPLETE DEPOSIT, AND AWARD BONUS ATOMICALLY
       const client = await db.pool.connect();

        try {
            await client.query("BEGIN");

            // Lock the pending deposit to prevent duplicate processing.
            const lockedResult = await client.query(
                `SELECT *
                 FROM wallet_transactions
                 WHERE id = $1
                 FOR UPDATE`,
                [transaction.id]
            );

            const lockedTransaction = lockedResult.rows[0];

            if (
                !lockedTransaction ||
                lockedTransaction.status !== "pending"
            ) {
                await client.query("ROLLBACK");

                console.log(
                    "Deposit already handled:",
                    transaction.reference,
                    lockedTransaction?.status
                );

                return;
            }

            // Calculate the eligible promotion for this verified deposit.
            const bonus = await calculateDepositBonus(
                transaction.user_id,
                creditedUSD,
                null
            );

            const bonusAmount = Number(bonus.bonusAmount) || 0;

            // Credit the user's real, withdrawable wallet.
            const walletResult = await client.query(
                `UPDATE wallets
                 SET balance = balance + $1,
                     updated_at = NOW()
                 WHERE user_id = $2
                 RETURNING balance`,
                [creditedUSD, transaction.user_id]
            );

            if (!walletResult.rows[0]) {
                throw new Error("Deposit wallet not found");
            }

            const newBalance = Number(walletResult.rows[0].balance);

            // Mark the deposit completed within the same transaction.
            const completedResult = await client.query(
                `UPDATE wallet_transactions
                 SET status = 'completed',
                     balance_before = $1,
                     balance_after = $2,
                     amount = $3,
                     result_code = $4,
                     result_description = $5,
                     mpesa_receipt = $6,
                     merchant_request_id = $7
                 WHERE id = $8
                   AND status = 'pending'
                 RETURNING id`,
                [
                    newBalance - creditedUSD,
                    newBalance,
                    creditedUSD,
                    resultCode,
                    resultDescription,
                    String(mpesaReceipt),
                    merchantRequestId,
                    transaction.id
                ]
            );

            if (!completedResult.rows[0]) {
                throw new Error("Could not complete deposit transaction");
            }

            // Award a promotion bonus only when one is eligible.
            if (bonusAmount > 0 && bonus.promotion) {
                // Add a bonus history record. deposit_id stays NULL because
                // its current BIGINT type cannot store the deposit UUID.
                await client.query(
                    `INSERT INTO user_bonuses (
                        user_id,
                        promotion_id,
                        deposit_id,
                        deposit_amount,
                        bonus_amount,
                        remaining_bonus,
                        status
                    )
                    VALUES ($1, $2, NULL, $3, $4, $4, 'active')`,
                    [
                        transaction.user_id,
                        bonus.promotion.id,
                        creditedUSD,
                        bonusAmount
                    ]
                );

                // Bonus funds remain separate from the real wallet balance.
                const bonusWalletResult = await client.query(
                    `UPDATE wallets
                     SET bonus_balance = ROUND(
                            (COALESCE(bonus_balance, 0) + $1)::numeric,
                            2
                         ),
                         updated_at = NOW()
                     WHERE user_id = $2
                     RETURNING bonus_balance`,
                    [bonusAmount, transaction.user_id]
                );

                if (!bonusWalletResult.rows[0]) {
                    throw new Error("Could not update wallet bonus balance");
                }

                // Record the bonus with a unique reference for auditability.
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
                    VALUES (
                        $1, 'bonus', 'deposit_bonus', $2, 'completed',
                        'promotion', $3, $4, $5, $5, NOW()
                    )`,
                    [
                        transaction.user_id,
                        bonusAmount,
                        `DEPOSIT_BONUS_${transaction.id}`,
                        `Deposit bonus for deposit ${transaction.reference}; promotion: ${bonus.promotion.name}`,
                        newBalance
                    ]
                );
            }

                        // ==========================================
            // RECORD VERIFIED M-PESA CASH IN
            // Keep this insert inside the deposit transaction.

            const businessCashReference = String(
                mpesaReceipt || ""
            ).trim();

            if (
                !businessCashReference ||
                !Number.isFinite(callbackAmountKES) ||
                callbackAmountKES <= 0
            ) {
                throw new Error(
                    "Cannot record cash-in: invalid M-Pesa receipt or amount."
                );
            }

            await client.query(
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
                VALUES (
                    NOW(),
                    'cash_in',
                    $1,
                    $2,
                    'mpesa_stk',
                    $3,
                    'confirmed',
                    NULL
                )
                ON CONFLICT (source, reference)
                WHERE reference IS NOT NULL
                DO NOTHING`,
                [
                    callbackAmountKES,
                    businessCashReference,
                    `Verified M-Pesa deposit. Reference: ${transaction.reference}. Receipt: ${businessCashReference}`
                ]
            );

            // Commit everything together exactly once.
            await client.query("COMMIT");

            console.log("DEPOSIT CREDITED:", {
                reference: transaction.reference,
                creditedUSD,
                bonusUSD: bonusAmount,
                newBalance,
                businessCashInKES: callbackAmountKES,
                mpesaReceipt: businessCashReference
            });

      } catch (creditError) {
        try {
            await client.query("ROLLBACK");
        } catch (rollbackError) {
            console.error(
                "M-Pesa deposit rollback error:",
                rollbackError.message
            );
        }

        console.error(
            "M-Pesa deposit credit failed:",
            creditError
        );

        console.error(
            "Deposit requires reconciliation:",
            transaction.reference,
            checkoutRequestId
        );
    } finally {
        client.release();
    }
} catch (error) {
        console.error(
            "M-Pesa callback processing error:",
            error
        );
    }
});
// ==========================================
// CREATE WITHDRAWAL REQUEST — NEON
// ==========================================

/* ==========================================
   WITHDRAWAL ELIGIBILITY STATUS
========================================== */

async function getWithdrawalEligibility(userId) {
    // Get the user's actual role from the database.
    const profileResult = await db.query(
        `SELECT role
         FROM profiles
         WHERE id = $1
         LIMIT 1`,
        [userId]
    );

    const role = String(
        profileResult.rows[0]?.role || ""
    ).trim().toLowerCase();

    // Privileged roles are exempt from KYC/deposit checks.
    if (["admin", "super_admin", "owner"].includes(role)) {
        return {
            canWithdraw: true,
            status: "eligible",
            reason: "role_exempt",
            message: "Your account is exempt from withdrawal verification."
        };
    }

    // Check the user's latest KYC verification.
    const kycResult = await db.query(
        `SELECT status
         FROM kyc_verifications
         WHERE user_id = $1
         ORDER BY updated_at DESC NULLS LAST,
                  created_at DESC
         LIMIT 1`,
        [userId]
    );

    const kycStatus = String(
        kycResult.rows[0]?.status || ""
    ).trim().toLowerCase();

    if (kycStatus === "rejected") {
        return {
            canWithdraw: false,
            status: "rejected",
            message: "Your verification was rejected. Please review your verification details."
        };
    }

    if (kycStatus === "pending") {
        return {
            canWithdraw: false,
            status: "verification_pending",
            message: "Your verification is awaiting approval."
        };
    }

    if (!["approved", "verified"].includes(kycStatus)) {
        return {
            canWithdraw: false,
            status: "verification_required",
            message: "Please complete your identity verification before withdrawing."
        };
    }

    // Require at least one completed deposit.
    const depositResult = await db.query(
        `SELECT EXISTS (
            SELECT 1
            FROM wallet_transactions
            WHERE user_id = $1
              AND transaction_type = 'deposit'
              AND status = 'completed'
        ) AS has_completed_deposit`,
        [userId]
    );

    if (depositResult.rows[0]?.has_completed_deposit !== true) {
        return {
            canWithdraw: false,
            status: "no_deposit",
            message: "You need at least one completed deposit before withdrawing."
        };
    }

    return {
        canWithdraw: true,
        status: "eligible",
        message: "You are eligible to withdraw."
    };
}


/* ==========================================
   WITHDRAWAL STATUS API
========================================== */

app.get(
    "/api/wallet/withdrawal-status",
    authenticateUser,
    async (req, res) => {
        try {
            const eligibility =
                await getWithdrawalEligibility(req.user.id);

            return res.json({
                success: true,
                ...eligibility
            });

        } catch (error) {
            console.error(
                "WITHDRAWAL STATUS ERROR:",
                error
            );

            return res.status(500).json({
                success: false,
                canWithdraw: false,
                status: "error",
                message: "Unable to check withdrawal eligibility. Please try again."
            });
        }
    }
);


app.post(
    "/api/wallet/withdraw",
    authenticateUser,
    async (req, res) => {
        let client;
        let transactionStarted = false;

        try {
            // ==========================================
            // CHECK WITHDRAWAL ELIGIBILITY
            // ==========================================

            const eligibility =
                await getWithdrawalEligibility(req.user.id);

            if (!eligibility.canWithdraw) {
                return res.status(403).json({
                    success: false,
                    canWithdraw: false,
                    status: eligibility.status,
                    message: eligibility.message
                });
            }

            // ==========================================
            // VALIDATE REQUEST
            // ==========================================

            const amount = Number(req.body.amount);

            const paymentMethod = String(
                req.body.paymentMethod || ""
            ).trim().toLowerCase();

            let phoneNumber = String(
                req.body.phoneNumber || ""
            ).trim().replace(/\s+/g, "");

            if (!Number.isFinite(amount) || amount < 0.10) {
                return res.status(400).json({
                    success: false,
                    message: "Minimum withdrawal is $0.10"
                });
            }

            const withdrawalAmount = Number(
                amount.toFixed(6)
            );

            if (paymentMethod !== "mpesa") {
                return res.status(400).json({
                    success: false,
                    message:
                        "Only M-Pesa withdrawals are currently available."
                });
            }

            if (/^07\d{8}$/.test(phoneNumber)) {
                phoneNumber = "254" + phoneNumber.substring(1);
            }

            if (/^\+2547\d{8}$/.test(phoneNumber)) {
                phoneNumber = phoneNumber.substring(1);
            }

            if (!/^2547\d{8}$/.test(phoneNumber)) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Enter a valid M-Pesa number, e.g. 254712345678"
                });
            }

            // ==========================================
            // PREPARE WALLET
            // ==========================================

            const existingWallet =
                await getOrCreateWallet(req.user.id);

            if (!existingWallet?.id) {
                throw new Error("WALLET_NOT_FOUND");
            }

            // ==========================================
            // CALCULATE FIXED REQUEST VALUES
            // ==========================================

            const processingFee = Number(
                (withdrawalAmount * 0.10).toFixed(6)
            );

            const payoutAmount = Number(
                (withdrawalAmount - processingFee).toFixed(6)
            );

            const kesAmount = Number(
                (
                    payoutAmount *
                    USD_KES_WITHDRAWAL_RATE
                ).toFixed(2)
            );

            if (!Number.isFinite(kesAmount) || kesAmount < 1) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Withdrawal amount is too small for M-Pesa"
                });
            }

            const reference =
                "WDR-" +
                Date.now() +
                "-" +
                crypto.randomBytes(4).toString("hex").toUpperCase();

            const originatorConversationID =
                "KMF-" +
                Date.now() +
                "-" +
                crypto.randomBytes(4).toString("hex").toUpperCase();

            // ==========================================
            // ATOMIC NEON TRANSACTION
            // Wallet + withdrawal + ledger + audit
            // ==========================================

            client = await db.pool.connect();

            await client.query("BEGIN");
            transactionStarted = true;

            // Lock the current wallet so concurrent withdrawal
            // requests cannot spend the same available balance.
            const walletResult = await client.query(
                `SELECT *
                 FROM wallets
                 WHERE id = $1
                   AND user_id = $2
                 FOR UPDATE`,
                [existingWallet.id, req.user.id]
            );

            const wallet = walletResult.rows[0];

            if (!wallet) {
                throw new Error("WALLET_NOT_FOUND");
            }

            const currentRealBalance = Number(wallet.balance);
            const currentBonusBalance = Number(
                wallet.bonus_balance || 0
            );

            if (
                !Number.isFinite(currentRealBalance) ||
                currentRealBalance < 0
            ) {
                throw new Error("INVALID_WALLET_BALANCE");
            }

            // Bonus and demo funds are not withdrawable.
            const tradingBalance =
                currentRealBalance + currentBonusBalance;

            const withdrawableBalance = currentRealBalance;

            if (withdrawalAmount > withdrawableBalance) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return res.status(400).json({
                    success: false,
                    message: "Insufficient withdrawable balance"
                });
            }

            const newBalance = Number(
                (currentRealBalance - withdrawalAmount).toFixed(6)
            );

            if (newBalance < 0) {
                throw new Error("INSUFFICIENT_BALANCE");
            }

            // Reserve the full requested amount, including the fee.
            const walletUpdate = await client.query(
                `UPDATE wallets
                 SET balance = $1,
                     updated_at = NOW()
                 WHERE id = $2
                   AND user_id = $3
                 RETURNING id`,
                [newBalance, wallet.id, req.user.id]
            );

            if (walletUpdate.rows.length !== 1) {
                throw new Error("WALLET_UPDATE_FAILED");
            }

            // Create the pending withdrawal.
            // No M-Pesa payout is sent by this route.
            const withdrawalResult = await client.query(
                `INSERT INTO withdrawals (
                    user_id,
                    wallet_id,
                    amount,
                    processing_fee,
                    payout_amount,
                    phone_number,
                    payment_method,
                    status,
                    reference,
                    originator_conversation_id,
                    risk_status,
                    risk_score,
                    risk_flags
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6, $7,
                    $8, $9, $10, $11, $12, $13::jsonb
                )
                RETURNING *`,
                [
                    req.user.id,
                    wallet.id,
                    withdrawalAmount,
                    processingFee,
                    payoutAmount,
                    phoneNumber,
                    "mpesa",
                    "pending",
                    reference,
                    originatorConversationID,
                    "normal",
                    0,
                    JSON.stringify([])
                ]
            );

            const withdrawal = withdrawalResult.rows[0];

            if (!withdrawal) {
                throw new Error("WITHDRAWAL_INSERT_FAILED");
            }

            // Record the reserved amount in the wallet ledger.
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
                    req.user.id,
                    wallet.id,
                    "withdrawal",
                    "withdrawal",
                    withdrawalAmount,
                    "pending",
                    "mpesa",
                    reference,
                    withdrawal.id,
                    `M-Pesa withdrawal pending admin approval. Requested: $${withdrawalAmount.toFixed(2)}. Processing fee: $${processingFee.toFixed(2)}. Customer payout: $${payoutAmount.toFixed(2)}.`,
                    currentRealBalance,
                    newBalance
                ]
            );

            // Record the request audit entry in the same transaction.
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
                    $1, $2, $3, $4, $5,
                    $6, $7, $8, $9, $10::jsonb
                )`,
                [
                    withdrawal.id,
                    req.user.id,
                    null,
                    "withdrawal_requested",
                    null,
                    "User submitted withdrawal request. Waiting for admin review.",
                    null,
                    "pending",
                    withdrawalAmount,
                    JSON.stringify({
                        payment_method: "mpesa",
                        phone_number: phoneNumber,
                        kes_amount: kesAmount,
                        reference,
                        requested_amount: withdrawalAmount,
                        processing_fee: processingFee,
                        payout_amount: payoutAmount,
                        trading_balance: tradingBalance,
                        bonus_balance: currentBonusBalance,
                        withdrawable_balance: withdrawableBalance,
                        processing_fee_percent: 10,
                        user_role: req.user.role || "authenticated"
                    })
                ]
            );

            // All four database changes succeed together.
            await client.query("COMMIT");
            transactionStarted = false;

            console.log("WITHDRAWAL REQUEST CREATED", {
                withdrawalId: withdrawal.id,
                userId: req.user.id,
                amount: withdrawalAmount,
                fee: processingFee,
                payout: payoutAmount,
                kesAmount,
                reference,
                status: "pending",
                b2cSent: false
            });

            return res.status(201).json({
                success: true,
                message:
                    "Withdrawal request submitted and is waiting for admin approval.",
                withdrawal: {
                    id: withdrawal.id,
                    reference,
                    amount: withdrawalAmount,
                    tradingBalance,
                    bonusBalance: currentBonusBalance,
                    withdrawableAmount: withdrawableBalance,
                    requestedAmount: withdrawalAmount,
                    processingFee,
                    processingFeePercent: 10,
                    payoutAmount,
                    phoneNumber,
                    paymentMethod: "mpesa",
                    status: "pending",
                    kesAmount,
                    adminApprovalRequired: true
                }
            });

        } catch (error) {
            if (client && transactionStarted) {
                try {
                    await client.query("ROLLBACK");
                } catch (rollbackError) {
                    console.error(
                        "WITHDRAWAL ROLLBACK ERROR:",
                        rollbackError
                    );
                }
            }

            console.error("CREATE WITHDRAWAL ERROR:", error);

            if (error.message === "WALLET_NOT_FOUND") {
                return res.status(404).json({
                    success: false,
                    message: "Wallet not found"
                });
            }

            if (error.message === "INVALID_WALLET_BALANCE") {
                return res.status(500).json({
                    success: false,
                    message: "Invalid wallet balance"
                });
            }

            if (error.message === "INSUFFICIENT_BALANCE") {
                return res.status(400).json({
                    success: false,
                    message: "Insufficient withdrawable balance"
                });
            }

            if (error.message === "WALLET_UPDATE_FAILED") {
                return res.status(409).json({
                    success: false,
                    message:
                        "Unable to reserve withdrawal funds. Please try again."
                });
            }

            return res.status(500).json({
                success: false,
                message: "Unable to process withdrawal request."
            });

        } finally {
            if (client) {
                client.release();
            }
        }
    }
);

// ======================================================
// ADMIN APPROVE WITHDRAWAL
// ======================================================

app.post(
    "/api/admin/withdrawals/:id/approve",
    authenticateUser,
    async (req, res) => {
        try {
            // ==========================================
            // VERIFY ADMIN ID
            // ==========================================

            const adminUserId = req.user?.id;

            if (!adminUserId) {
                return res.status(401).json({
                    success: false,
                    message: "Authentication required"
                });
            }


            // ==========================================
            // LOAD ADMIN PROFILE — NEON
            // ==========================================

            let adminProfile;

            try {
                const adminProfileResult = await db.query(
                    `SELECT id, username, full_name, role
                     FROM profiles
                     WHERE id = $1
                     LIMIT 1`,
                    [adminUserId]
                );

                adminProfile =
                    adminProfileResult.rows[0] || null;

            } catch (adminProfileError) {
                console.error(
                    "ADMIN PROFILE LOOKUP ERROR:",
                    adminProfileError
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to verify administrator"
                });
            }

            if (!adminProfile) {
                return res.status(403).json({
                    success: false,
                    message: "Administrator profile not found"
                });
            }

            const adminRole = String(
                adminProfile.role || ""
            ).trim().toLowerCase();

            const allowedAdminRoles = [
                "admin",
                "super_admin",
                "owner"
            ];

            if (!allowedAdminRoles.includes(adminRole)) {
                return res.status(403).json({
                    success: false,
                    message: "Administrator permission required"
                });
            }


            // ==========================================
            // VALIDATE WITHDRAWAL ID
            // ==========================================

            const withdrawalId = String(
                req.params.id || ""
            ).trim();

            if (!withdrawalId) {
                return res.status(400).json({
                    success: false,
                    message: "Withdrawal ID is required"
                });
            }


            // ==========================================
            // LOAD WITHDRAWAL — NEON
            // ==========================================

            let withdrawal;

            try {
                const withdrawalResult = await db.query(
                    `SELECT *
                     FROM withdrawals
                     WHERE id = $1
                     LIMIT 1`,
                    [withdrawalId]
                );

                withdrawal =
                    withdrawalResult.rows[0] || null;

            } catch (withdrawalError) {
                console.error(
                    "ADMIN WITHDRAWAL LOOKUP ERROR:",
                    withdrawalError
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to load withdrawal"
                });
            }

            if (!withdrawal) {
                return res.status(404).json({
                    success: false,
                    message: "Withdrawal not found"
                });
            }


            // ==========================================
            // ONLY PENDING WITHDRAWALS CAN BE APPROVED
            // ==========================================

            if (withdrawal.status !== "pending") {
                return res.status(409).json({
                    success: false,
                    message:
                        `Withdrawal cannot be approved because its current status is ${withdrawal.status}`,
                    status: withdrawal.status
                });
            }


            // ==========================================
            // VALIDATE AMOUNT, FEE AND PAYOUT
            // ==========================================

            const withdrawalAmount =
                Number(withdrawal.amount);

            if (
                !Number.isFinite(withdrawalAmount) ||
                withdrawalAmount <= 0
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid withdrawal amount"
                });
            }

            const processingFee =
                Number(withdrawal.processing_fee || 0);

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
                    message: "Invalid withdrawal processing fee"
                });
            }

            if (
                !Number.isFinite(payoutAmount) ||
                payoutAmount <= 0 ||
                payoutAmount > withdrawalAmount
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid withdrawal payout amount"
                });
            }

            const kesAmount = Number(
                (
                    payoutAmount *
                    USD_KES_WITHDRAWAL_RATE
                ).toFixed(2)
            );

            if (
                !Number.isFinite(kesAmount) ||
                kesAmount < 1
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Withdrawal amount is too small for M-Pesa"
                });
            }

            const adminNotes = String(
                req.body?.adminNotes || ""
            ).trim();


            // ==========================================
            // ATOMICALLY CHANGE PENDING → PROCESSING
            // NEON
            // ==========================================
            //
            // The WHERE status = 'pending' condition prevents
            // two administrators from approving the same
            // withdrawal concurrently.
            // ==========================================

            let processingWithdrawal;

            try {
                const processingResult = await db.query(
                    `UPDATE withdrawals
                     SET status = 'processing',
                         reviewed_by = $2,
                         reviewed_at = NOW(),
                         approved_at = NOW(),
                         processing_at = NOW(),
                         admin_notes = $3,
                         updated_at = NOW()
                     WHERE id = $1
                       AND status = 'pending'
                     RETURNING *`,
                    [
                        withdrawal.id,
                        adminUserId,
                        adminNotes || null
                    ]
                );

                processingWithdrawal =
                    processingResult.rows[0] || null;

            } catch (processingError) {
                console.error(
                    "WITHDRAWAL APPROVAL UPDATE ERROR:",
                    processingError
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to approve withdrawal"
                });
            }

            if (!processingWithdrawal) {
                return res.status(409).json({
                    success: false,
                    message:
                        "Withdrawal has already been processed or approved"
                });
            }


            // ==========================================
            // UPDATE WALLET TRANSACTION — NEON
            // ==========================================

            try {
                await db.query(
                    `UPDATE wallet_transactions
                     SET status = 'processing',
                         description = $1
                     WHERE reference_id = $2
                       AND transaction_type = 'withdrawal'
                       AND status IN ('pending', 'processing')`,
                    [
                        "M-Pesa withdrawal approved by admin and being processed",
                        withdrawal.id
                    ]
                );

            } catch (walletTransactionError) {
                console.error(
                    "WITHDRAWAL WALLET TRANSACTION PROCESSING ERROR:",
                    walletTransactionError
                );
            }


            // ==========================================
            // CREATE APPROVAL AUDIT LOG — NEON
            // ==========================================

            try {
                await db.query(
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
                        $1, $2, $3, $4, $5,
                        $6, $7, $8, $9, $10::jsonb
                    )`,
                    [
                        withdrawal.id,
                        withdrawal.user_id,
                        adminUserId,
                        "withdrawal_approved",
                        null,
                        adminNotes ||
                            "Withdrawal approved by administrator. M-Pesa B2C processing started.",
                        "pending",
                        "processing",
                        withdrawalAmount,
                        JSON.stringify({
                            admin_role: adminRole,
                            admin_username: adminProfile.username || null,
                            payment_method: withdrawal.payment_method,
                            phone_number: withdrawal.phone_number,
                            requested_amount: withdrawalAmount,
                            processing_fee: processingFee,
                            processing_fee_percent: 10,
                            payout_amount: payoutAmount,
                            kes_amount: kesAmount,
                            reference: withdrawal.reference
                        })
                    ]
                );

            } catch (auditError) {
                console.error(
                    "WITHDRAWAL APPROVAL AUDIT ERROR:",
                    auditError
                );
            }


            // ==========================================
            // SEND MPESA B2C
            // ==========================================
            //
            // Keep using the existing initiateMpesaB2C()
            // function. Do not duplicate its implementation.
            // ==========================================

            try {
                const b2cResponse = await initiateMpesaB2C({
                    phoneNumber: withdrawal.phone_number,
                    amount: kesAmount,
                    originatorConversationID:
                        withdrawal.originator_conversation_id,
                    remarks:
                        `KMFBinary withdrawal ${withdrawal.reference}`
                });

                console.log("==========================================");
                console.log("💸 ADMIN APPROVED WITHDRAWAL");
                console.log("Withdrawal ID:", withdrawal.id);
                console.log("Reference:", withdrawal.reference);
                console.log("Admin:", adminUserId);
                console.log("Admin Role:", adminRole);
                console.log("Requested USD Amount:", withdrawalAmount);
                console.log("Processing Fee USD:", processingFee);
                console.log("Payout USD:", payoutAmount);
                console.log("M-Pesa KES Amount:", kesAmount);
                console.log("Phone:", withdrawal.phone_number);
                console.log("B2C STATUS:", "PROCESSING");
                console.log("B2C RESPONSE:", b2cResponse);
                console.log("==========================================");

                return res.status(200).json({
                    success: true,
                    message:
                        "Withdrawal approved and M-Pesa B2C payment is being processed.",
                    withdrawal: {
                        id: withdrawal.id,
                        reference: withdrawal.reference,
                        amount: withdrawalAmount,
                        processingFee,
                        payoutAmount,
                        kesAmount,
                        phoneNumber: withdrawal.phone_number,
                        status: "processing"
                    },
                    admin: {
                        id: adminUserId,
                        role: adminRole
                    }
                });

            } catch (b2cError) {

                // ==========================================
                // IMPORTANT SAFETY RULE
                // ==========================================
                //
                // DO NOT automatically refund here.
                //
                // Safaricom may have received the B2C request
                // even if this server did not receive a normal
                // response. A refund could result in the user
                // receiving both the refund and M-Pesa payment.
                //
                // Keep the withdrawal PROCESSING until it has
                // been reconciled.
                // ==========================================

                console.error("==========================================");
                console.error("⚠️ B2C REQUEST ERROR AFTER APPROVAL");
                console.error("Withdrawal:", withdrawal.reference);
                console.error("Error:", b2cError);
                console.error(
                    "Withdrawal remains PROCESSING for reconciliation."
                );
                console.error("==========================================");

                try {
                    await db.query(
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
                            $1, $2, $3, $4, $5,
                            $6, $7, $8, $9, $10::jsonb
                        )`,
                        [
                            withdrawal.id,
                            withdrawal.user_id,
                            adminUserId,
                            "b2c_request_error",
                            "M-Pesa B2C request returned an error after withdrawal approval.",
                            b2cError?.message ||
                                "B2C request error. Manual reconciliation required.",
                            "processing",
                            "processing",
                            withdrawalAmount,
                            JSON.stringify({
                                reference: withdrawal.reference,
                                error:
                                    b2cError?.message ||
                                    String(b2cError),
                                kes_amount: kesAmount
                            })
                        ]
                    );

                } catch (auditLogError) {
                    console.error(
                        "B2C ERROR AUDIT LOG ERROR:",
                        auditLogError
                    );
                }

                return res.status(502).json({
                    success: false,
                    message:
                        "M-Pesa payment could not be confirmed. The withdrawal remains processing and requires reconciliation.",
                    withdrawal: {
                        id: withdrawal.id,
                        reference: withdrawal.reference,
                        status: "processing"
                    }
                });
            }

        } catch (error) {
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
// MPESA B2C RESULT CALLBACK — GET TEST
// ==========================================

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

        res.status(200).json({
            Result: {
                ResultCode: 0,
                ResultDesc:
                    "Status callback received successfully"
            }
        });

        try {
            const result = req.body?.Result;

            if (!result) {
                console.log(
                    "❌ STATUS RESULT BODY MISSING"
                );
                return;
            }

            console.log("Status ResultCode:", result.ResultCode);
            console.log("Status ResultDesc:", result.ResultDesc);
            console.log("ConversationID:", result.ConversationID);
            console.log(
                "OriginatorConversationID:",
                result.OriginatorConversationID
            );
            console.log("TransactionID:", result.TransactionID);
            console.log(
                "ResultParameters:",
                result.ResultParameters
            );
        } catch (error) {
            console.error(
                "❌ STATUS CALLBACK ERROR:",
                error.message
            );
        }
    }
);


// ==========================================
// MPESA B2C RESULT CALLBACK — NEON
// ==========================================

app.post(
    "/api/mpesa/b2c/result",
    async (req, res) => {
        console.log(
            "=========================================="
        );
        console.log("🔥 MPESA B2C RESULT CALLBACK");
        console.log(
            JSON.stringify(req.body, null, 2)
        );
        console.log(
            "=========================================="
        );

        // Acknowledge Safaricom immediately.
        res.status(200).json({
            Result: {
                ResultCode: 0,
                ResultDesc: "Callback received successfully"
            }
        });

        try {
            const result = req.body?.Result;

            if (!result) {
                console.error(
                    "B2C callback missing Result object"
                );
                return;
            }

            // ==========================================
            // READ IDENTIFIERS
            // ==========================================

            const originatorConversationID = String(
                result.OriginatorConversationID || ""
            ).trim();

            const conversationID = String(
                result.ConversationID || ""
            ).trim();

            const transactionIDFromResult = String(
                result.TransactionID || ""
            ).trim();

            const resultCode = Number(result.ResultCode);

            const resultDescription = String(
                result.ResultDesc || "No result description"
            );

            console.log(
                "OriginatorConversationID:",
                originatorConversationID
            );
            console.log("ConversationID:", conversationID);
            console.log(
                "TransactionID:",
                transactionIDFromResult
            );
            console.log("ResultCode:", resultCode);
            console.log("ResultDesc:", resultDescription);

            if (!originatorConversationID) {
                console.error(
                    "B2C callback missing OriginatorConversationID"
                );
                return;
            }

            // ==========================================
            // FIND WITHDRAWAL — NEON
            // ==========================================

            const withdrawalResult = await db.query(
                `SELECT *
                 FROM withdrawals
                 WHERE originator_conversation_id = $1
                 LIMIT 1`,
                [originatorConversationID]
            );

            const withdrawal =
                withdrawalResult.rows[0] || null;

            if (!withdrawal) {
                console.error(
                    "=========================================="
                );
                console.error("❌ WITHDRAWAL NOT FOUND");
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
            // DUPLICATE CALLBACK PROTECTION
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
            // SUCCESS — ATOMIC NEON UPDATE
            // ==========================================

            if (resultCode === 0) {
              let transactionID =
    transactionIDFromResult || null;

let mpesaReceipt = null;
let callbackAmountKES = null;
                const parameters =
                    result.ResultParameters
                        ?.ResultParameter || [];

               if (Array.isArray(parameters)) {
    for (const parameter of parameters) {
        const key = String(
            parameter?.Key || ""
        ).trim();

        if (key === "TransactionID") {
            transactionID = String(
                parameter?.Value ||
                transactionID ||
                ""
            ).trim() || null;
        }

        if (key === "TransactionReceipt") {
            mpesaReceipt = String(
                parameter?.Value || ""
            ).trim() || null;
        }

        // Actual KSh amount paid by M-Pesa
        if (key === "TransactionAmount") {
            const parsedAmount = Number(
                parameter?.Value
            );

            if (
                Number.isFinite(parsedAmount) &&
                parsedAmount > 0
            ) {
                callbackAmountKES = parsedAmount;
            }
        }
    }
}

const client = await db.pool.connect();
                try {
                    await client.query("BEGIN");

                    // Lock and recheck the withdrawal.
                    const lockedResult = await client.query(
                        `SELECT *
                         FROM withdrawals
                         WHERE id = $1
                         FOR UPDATE`,
                        [withdrawal.id]
                    );

                    const lockedWithdrawal =
                        lockedResult.rows[0] || null;

                    // Another callback or process may have
                    // already handled this withdrawal.
                    if (
                        !lockedWithdrawal ||
                        !["pending", "processing"].includes(
                            lockedWithdrawal.status
                        )
                    ) {
                        await client.query("COMMIT");

                        console.log(
                            "B2C success callback skipped; withdrawal already handled:",
                            withdrawal.reference,
                            lockedWithdrawal?.status || "not found"
                        );

                        return;
                    }

                    // Complete the withdrawal inside the
                    // same transaction as its ledger update.
                    const completionResult = await client.query(
                        `UPDATE withdrawals
                         SET status = 'completed',
                             conversation_id = $1,
                             transaction_id = $2,
                             mpesa_receipt = $3,
                             result_code = $4,
                             result_description = $5,
                             updated_at = NOW()
                         WHERE id = $6
                           AND status IN ('pending', 'processing')
                         RETURNING id`,
                        [
                            conversationID ||
                                lockedWithdrawal.conversation_id ||
                                null,
                            transactionID,
                            mpesaReceipt,
                            String(resultCode),
                            resultDescription,
                            lockedWithdrawal.id
                        ]
                    );

                    if (completionResult.rowCount !== 1) {
                        throw new Error(
                            "Unable to complete withdrawal record"
                        );
                    }

                    // Update only the ledger entry for this
                    // withdrawal. Never swallow ledger errors.
                    const ledgerResult = await client.query(
                        `UPDATE wallet_transactions
                         SET status = 'completed',
                             mpesa_receipt = $1,
                             result_code = $2,
                             result_description = $3,
                             updated_at = NOW()
                         WHERE reference_id = $4
                           AND transaction_type = 'withdrawal'
                           AND status IN ('pending', 'processing')
                         RETURNING id`,
                        [
                            mpesaReceipt,
                            String(resultCode),
                            resultDescription,
                            lockedWithdrawal.id
                        ]
                    );

                  if (ledgerResult.rowCount !== 1) {
    throw new Error(
        "Expected exactly one withdrawal ledger entry; found " +
        ledgerResult.rowCount
    );
}

// ==========================================
// RECORD VERIFIED M-PESA CASH OUT — NEON
// ==========================================

if (!mpesaReceipt) {
    throw new Error(
        "Successful B2C callback has no M-Pesa receipt; reconciliation required."
    );
}

if (
    !Number.isFinite(callbackAmountKES) ||
    callbackAmountKES <= 0
) {
    throw new Error(
        "Successful B2C callback has no valid TransactionAmount; reconciliation required."
    );
}

await client.query(
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
    VALUES (
        NOW(),
        'cash_out',
        $1,
        $2,
        'mpesa_b2c',
        $3,
        'confirmed',
        NULL
    )
    ON CONFLICT (source, reference)
    WHERE reference IS NOT NULL
    DO NOTHING`,
    [
        callbackAmountKES,
        String(mpesaReceipt).trim(),
        `Verified M-Pesa B2C withdrawal. Withdrawal reference: ${lockedWithdrawal.reference}. Receipt: ${mpesaReceipt}`
    ]
);

// Withdrawal, wallet transaction, and cash ledger
// entry are committed together.
await client.query("COMMIT");

                    console.log(
                        "=========================================="
                    );
                    console.log("💰 MPESA WITHDRAWAL COMPLETED");
                    console.log(
                        "Reference:",
                        lockedWithdrawal.reference
                    );
                    console.log(
                        "USD Amount:",
                        lockedWithdrawal.amount
                    );
                    console.log(
                        "Phone:",
                        lockedWithdrawal.phone_number
                    );
                    console.log(
                        "TransactionID:",
                        transactionID
                    );
                    console.log("Receipt:", mpesaReceipt);
                    console.log(
                        "Withdrawal and ledger updated atomically."
                    );
                    console.log(
                        "=========================================="
                    );

                    return;

                } catch (completionError) {
                    try {
                        await client.query("ROLLBACK");
                    } catch (rollbackError) {
                        console.error(
                            "B2C success rollback failed:",
                            rollbackError
                        );
                    }

                    console.error(
                        "B2C success database update failed; reconciliation required:",
                        {
                            reference: withdrawal.reference,
                            error: completionError.message
                        }
                    );

                    // Safaricom has already been acknowledged.
                    // Keep database changes rolled back and
                    // reconcile the callback rather than
                    // pretending the ledger update succeeded.
                } finally {
                    client.release();
                }

                return;
            }



        } catch (error) {
            console.error(
                "B2C result callback error:",
                error
            );
        }
    }
);


// ==========================================
// ADMIN REJECT WITHDRAWAL — NEON POSTGRES
// ==========================================

app.post(
    "/api/admin/withdrawals/:id/reject",
    authenticateUser,
    async (req, res) => {
        try {
            const withdrawalId =
                String(req.params.id || "").trim();

            const reason =
                String(req.body?.reason || "").trim();

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
                    message: "Rejection reason is too long"
                });
            }

            // ==========================================
            // VERIFY ADMIN — NEON
            // ==========================================

            const adminResult = await db.query(
                `SELECT id, role
                 FROM profiles
                 WHERE id = $1
                 LIMIT 1`,
                [req.user.id]
            );

            const adminProfile =
                adminResult.rows[0] || null;

            const adminRole = String(
                adminProfile?.role || ""
            ).trim().toLowerCase();

            const allowedAdminRoles = [
                "admin",
                "super_admin",
                "owner"
            ];

            if (
                !adminProfile ||
                !allowedAdminRoles.includes(adminRole)
            ) {
                return res.status(403).json({
                    success: false,
                    message: "Admin access required"
                });
            }

            // ==========================================
            // LOAD WITHDRAWAL — NEON
            // ==========================================

            const withdrawalResult = await db.query(
                `SELECT *
                 FROM withdrawals
                 WHERE id = $1
                 LIMIT 1`,
                [withdrawalId]
            );

            const withdrawal =
                withdrawalResult.rows[0] || null;

            if (!withdrawal) {
                return res.status(404).json({
                    success: false,
                    message: "Withdrawal not found"
                });
            }

            if (
                String(withdrawal.status || "")
                    .trim()
                    .toLowerCase() !== "pending"
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        `Withdrawal cannot be rejected because its current status is ${withdrawal.status}`
                });
            }

            const amount = Number(
                withdrawal.amount || 0
            );

            if (
                !Number.isFinite(amount) ||
                amount <= 0
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid withdrawal amount"
                });
            }

            // ==========================================
            // REJECT WITHDRAWAL — NO WALLET REFUND
            // ==========================================
            //
            // Funds remain retained by KMFBinary.
            // Do not update wallets.balance.
            // Do not create a refund transaction.
            //

            const rejectionResult = await db.query(
                `UPDATE withdrawals
                 SET
                     status = $1,
                     reviewed_by = $2,
                     reviewed_at = NOW(),
                     rejection_reason = $3,
                     admin_notes = $4,
                     updated_at = NOW()
                 WHERE id = $5
                   AND status = $6
                 RETURNING *`,
                [
                    "rejected",
                    req.user.id,
                    reason,
                    `Withdrawal rejected. Reserved funds retained by KMFBinary pending resolution. Reason: ${reason}`,
                    withdrawal.id,
                    "pending"
                ]
            );

            const rejectedWithdrawal =
                rejectionResult.rows[0] || null;

            if (!rejectedWithdrawal) {
                return res.status(409).json({
                    success: false,
                    message:
                        "Withdrawal could not be rejected because it may already have been processed."
                });
            }

            // ==========================================
            // UPDATE ORIGINAL WALLET TRANSACTION
            // ==========================================

            try {
                await db.query(
                    `UPDATE wallet_transactions
                     SET
                         status = $1,
                         updated_at = NOW()
                     WHERE reference_id = $2
                       AND transaction_type = $3
                       AND status IN ('pending', 'processing')`,
                    [
                        "rejected",
                        withdrawal.id,
                        "withdrawal"
                    ]
                );
            } catch (transactionError) {
                console.error(
                    "Original withdrawal transaction update error:",
                    transactionError
                );
            }

            // ==========================================
            // AUDIT LOG — NEON
            // ==========================================

            try {
                await db.query(
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
                        $1, $2, $3, $4, $5,
                        $6, $7, $8, $9, $10
                    )`,
                    [
                        withdrawal.id,
                        withdrawal.user_id,
                        req.user.id,
                        "withdrawal_rejected",
                        reason,
                        "Withdrawal rejected by administrator. Reserved funds remain retained by KMFBinary pending resolution; no automatic refund was issued.",
                        "pending",
                        "rejected",
                        amount,
                        JSON.stringify({
                            withdrawal_reference:
                                withdrawal.reference || null,
                            funds_status:
                                "retained_by_kmfbinary",
                            refund_processed: false,
                            refund_reference: null,
                            admin_role: adminRole
                        })
                    ]
                );
            } catch (auditError) {
                console.error(
                    "Withdrawal rejection audit error:",
                    auditError
                );
            }

            return res.json({
                success: true,
                message:
                    "Withdrawal rejected. Funds remain retained by KMFBinary pending resolution.",
                withdrawal: rejectedWithdrawal,
                funds_status: "retained_by_kmfbinary",
                refund_processed: false
            });

        } catch (error) {
            console.error(
                "Reject withdrawal error:",
                error
            );

            return res.status(500).json({
                success: false,
                message: "Unable to reject withdrawal"
            });
        }
    }
);


// ==========================================
// MPESA B2C TIMEOUT CALLBACK — GET TEST
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


// ==========================================
// MPESA B2C TIMEOUT CALLBACK — NEON
// ==========================================

app.post(
    "/api/mpesa/b2c/timeout",
    async (req, res) => {
        console.log(
            "=========================================="
        );
        console.log("⚠️ MPESA B2C TIMEOUT");
        console.log(
            JSON.stringify(req.body, null, 2)
        );
        console.log(
            "=========================================="
        );

        res.status(200).json({
            Result: {
                ResultCode: 0,
                ResultDesc: "Timeout callback received"
            }
        });

        try {
            const result = req.body?.Result;

            if (!result) {
                console.error(
                    "Timeout callback missing Result object"
                );
                return;
            }

            const originatorConversationID = String(
                result.OriginatorConversationID || ""
            ).trim();

            if (!originatorConversationID) {
                console.error(
                    "Timeout callback missing OriginatorConversationID"
                );
                return;
            }

            // ==========================================
            // FIND WITHDRAWAL — NEON
            // ==========================================

            const withdrawalResult = await db.query(
                `SELECT *
                 FROM withdrawals
                 WHERE originator_conversation_id = $1
                 LIMIT 1`,
                [originatorConversationID]
            );

            const withdrawal =
                withdrawalResult.rows[0] || null;

            if (!withdrawal) {
                console.error(
                    "Timeout withdrawal not found:",
                    originatorConversationID
                );
                return;
            }

            // ==========================================
            // DUPLICATE CALLBACK PROTECTION
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
            // MARK TIMEOUT — NEON
            // ==========================================

            const timeoutDescription =
                "M-Pesa B2C timed out. Awaiting reconciliation.";

            const timeoutResult = await db.query(
                `UPDATE withdrawals
                 SET
                     status = $1,
                     result_code = $2,
                     result_description = $3,
                     updated_at = NOW()
                 WHERE id = $4
                   AND status IN ('pending', 'processing')
                 RETURNING *`,
                [
                    "timeout",
                    String(result?.ResultCode ?? ""),
                    timeoutDescription,
                    withdrawal.id
                ]
            );

            const timedOutWithdrawal =
                timeoutResult.rows[0] || null;

            if (!timedOutWithdrawal) {
                console.log(
                    "Timeout already processed or withdrawal status changed."
                );
                return;
            }

            // ==========================================
            // UPDATE WALLET TRANSACTION — NEON
            // ==========================================

            try {
                await db.query(
                    `UPDATE wallet_transactions
                     SET
                         status = $1,
                         result_code = $2,
                         result_description = $3,
                         updated_at = NOW()
                     WHERE reference_id = $4
                       AND transaction_type = $5
                       AND status IN ('pending', 'processing')`,
                    [
                        "timeout",
                        String(result?.ResultCode ?? ""),
                        timeoutDescription,
                        withdrawal.id,
                        "withdrawal"
                    ]
                );
            } catch (walletTransactionError) {
                console.error(
                    "Timeout wallet transaction update error:",
                    walletTransactionError
                );
            }

            // ==========================================
            // DO NOT REFUND TIMEOUT
            // ==========================================
            //
            // Timeout does not prove that M-Pesa failed.
            // Funds remain reserved until reconciliation.
            //

            console.log(
                "=========================================="
            );
            console.log("⚠️ WITHDRAWAL MARKED TIMEOUT");
            console.log("Reference:", withdrawal.reference);
            console.log("USD Amount:", withdrawal.amount);
            console.log("Phone:", withdrawal.phone_number);
            console.log("Status:", "timeout");
            console.log(
                "Funds remain reserved pending reconciliation."
            );
            console.log(
                "=========================================="
            );

        } catch (error) {
            console.error(
                "B2C timeout callback error:",
                error
            );
        }
    }
);


// ==========================================
// GET USER'S TRADES ONLY — NEON
// ==========================================

app.get(
    "/api/trades",
    authenticateUser,
    async (req, res) => {
        try {
            const result = await db.query(
                `SELECT *
                 FROM trades
                 WHERE user_id = $1
                 ORDER BY created_at DESC`,
                [req.user.id]
            );

            return res.json({
                success: true,
                trades: result.rows || []
            });
        } catch (error) {
            console.error("Trades API error:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to load trades"
            });
        }
    }
);


// ==========================================
// ACCUMULATOR CASH OUT — NEON
// ==========================================

app.post(
    "/api/trades/:tradeId/cashout",
    authenticateUser,
    async (req, res) => {
        try {
            const tradeId = req.params.tradeId;

            if (!tradeId) {
                return res.status(400).json({
                    success: false,
                    message: "Missing trade ID"
                });
            }

            // ==========================================
            // GET PENDING ACCUMULATOR TRADE
            // ==========================================

            const tradeResult = await db.query(
                `SELECT *
                 FROM trades
                 WHERE id = $1
                   AND user_id = $2
                   AND contract_type = $3
                   AND status = $4
                 LIMIT 1`,
                [
                    tradeId,
                    req.user.id,
                    "accumulator",
                    "pending"
                ]
            );

            const trade = tradeResult.rows[0] || null;

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

            const symbol = settlement.getSyntheticSymbol(trade);

            if (!symbol) {
                return res.status(400).json({
                    success: false,
                    message: "Unable to identify market"
                });
            }

            const currentPrice = Number(
                syntheticMarket.getPrice(symbol)
            );

            const barrier = Number(
                trade.accumulator_barrier
            );

            const direction = String(
                trade.accumulator_direction || ""
            ).trim().toLowerCase();

            const knockout =
                (direction === "above" &&
                    currentPrice <= barrier) ||
                (direction === "below" &&
                    currentPrice >= barrier);

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

            const growth = Number(
                trade.accumulator_growth
            );

            const createdAt =
                new Date(trade.created_at).getTime();

            const elapsedSeconds = Math.max(
                0,
                Math.floor(
                    (Date.now() - createdAt) / 1000
                )
            );

            const rawPayout =
                Number(trade.stake) *
                Math.pow(1 + growth, elapsedSeconds);

            // ==========================================
            // MAXIMUM PAYOUT
            // ==========================================

            const maxPayout =
                Number(trade.stake) *
                ACCUMULATOR_MAX_MULTIPLIER;

            const payout = Math.min(
                rawPayout,
                maxPayout
            );

            const precisePayout = Number(
                payout.toFixed(6)
            );

            const profit = Number(
                (
                    precisePayout -
                    Number(trade.stake)
                ).toFixed(6)
            );

            // ==========================================
            // SETTLE TRADE — NEON
            // ==========================================

            const updateResult = await db.query(
                `UPDATE trades
                 SET
                     status = $1,
                     exit_price = $2,
                     payout = $3,
                     profit = $4,
                     settled_at = NOW()
                 WHERE id = $5
                   AND user_id = $6
                   AND status = $7
                 RETURNING *`,
                [
                    "won",
                    currentPrice,
                    precisePayout,
                    profit,
                    trade.id,
                    req.user.id,
                    "pending"
                ]
            );

            const updatedTrade =
                updateResult.rows[0] || null;

            if (!updatedTrade) {
                return res.status(409).json({
                    success: false,
                    message: "Trade was already settled"
                });
            }

            // ==========================================
            // LOAD WALLET — NEON
            // ==========================================

            const walletResult = await db.query(
                `SELECT *
                 FROM wallets
                 WHERE user_id = $1
                 LIMIT 1`,
                [req.user.id]
            );

            const wallet =
                walletResult.rows[0] || null;

            if (!wallet) {
                console.error(
                    "Cashout wallet not found for user:",
                    req.user.id
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to load wallet"
                });
            }

            const walletMode = String(
                trade.mode || "real"
            ).trim().toLowerCase();

            const balanceField =
                walletMode === "demo"
                    ? "demo_balance"
                    : "balance";

            const oldBalance = Number(
                wallet[balanceField]
            );

            if (!Number.isFinite(oldBalance)) {
                return res.status(500).json({
                    success: false,
                    message: "Invalid wallet balance"
                });
            }

            const newBalance = Number(
                (oldBalance + precisePayout).toFixed(6)
            );

            // ==========================================
            // CREDIT WALLET — NEON
            // ==========================================
            //
            // balanceField is selected from a fixed
            // allowlist above, not directly from input.
            //

            const walletUpdateResult = await db.query(
                `UPDATE wallets
                 SET ${balanceField} = $1,
                     updated_at = NOW()
                 WHERE id = $2
                   AND ${balanceField} = $3
                 RETURNING *`,
                [
                    newBalance,
                    wallet.id,
                    oldBalance
                ]
            );

            const updatedWallet =
                walletUpdateResult.rows[0] || null;

            if (!updatedWallet) {
                console.error(
                    "Cashout wallet update failed after trade settlement:",
                    trade.id
                );

                return res.status(409).json({
                    success: false,
                    message:
                        "Wallet balance changed. Cashout requires reconciliation."
                });
            }

            // ==========================================
            // WALLET TRANSACTION — NEON
            // ==========================================

            try {
                await db.query(
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
                        req.user.id,
                        wallet.id,
                        "trade_payout",
                        "trade_payout",
                        precisePayout,
                        "completed",
                        "wallet",
                        "PAYOUT-" + trade.id,
                        trade.id,
                        "Accumulator trade payout",
                        oldBalance,
                        newBalance
                    ]
                );
            } catch (payoutTransactionError) {
                console.error(
                    "Accumulator payout transaction error:",
                    payoutTransactionError
                );
            }

            console.log("==========================================");
            console.log("💰 ACCUMULATOR CASHOUT");
            console.log("Trade:", trade.id);
            console.log("Stake:", trade.stake);
            console.log("Growth:", growth);
            console.log("Payout:", precisePayout);
            console.log("Profit:", profit);
            console.log("Balance Before:", oldBalance);
            console.log("Balance After:", newBalance);
            console.log("==========================================");

            return res.json({
                success: true,
                message:
                    "Accumulator cashed out successfully",
                trade: updatedTrade,
                payout: precisePayout,
                profit,
                balance: newBalance
            });

        } catch (error) {
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
// GET ONE USER TRADE — NEON
// ==========================================

app.get(
    "/api/trades/:id",
    authenticateUser,
    async (req, res) => {
        try {
            const tradeId = req.params.id;

            if (!tradeId) {
                return res.status(400).json({
                    success: false,
                    message: "Trade ID is required"
                });
            }

            const result = await db.query(
                `SELECT *
                 FROM trades
                 WHERE id = $1
                   AND user_id = $2
                 LIMIT 1`,
                [tradeId, req.user.id]
            );

            const trade = result.rows[0] || null;

            if (!trade) {
                return res.status(404).json({
                    success: false,
                    message: "Trade not found"
                });
            }

            return res.json({
                success: true,
                trade
            });

        } catch (error) {
            console.error(
                "Single trade API error:",
                error
            );

            return res.status(500).json({
                success: false,
                message: "Server error"
            });
        }
    }
);


// ==========================================
// PLACE TRADE
// Supabase Auth remains unchanged.
// Database operations below use Neon.
// ==========================================

app.post(
    "/api/trades",
    authenticateUser,
    async (req, res) => {
        console.log("TRADE REQUEST FROM:", req.user.id);
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

            const contractType = String(
                req.body.contractType || ""
            ).trim().toLowerCase();

            if (!marketId) {
                return res.status(400).json({
                    success: false,
                    message: "Missing marketId"
                });
            }

            if (!contractType) {
                return res.status(400).json({
                    success: false,
                    message: "Missing contractType"
                });
            }

            if (!action) {
                return res.status(400).json({
                    success: false,
                    message: "Missing action"
                });
            }

            if (stake === undefined || stake === null) {
                return res.status(400).json({
                    success: false,
                    message: "Missing stake"
                });
            }

            const amount = Number(stake);
            const contractDuration = Number(duration);

            const contractDurationUnit = String(
                durationUnit || "s"
            ).trim().toLowerCase();

            if (
                !Number.isInteger(contractDuration) ||
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

            if (!Number.isFinite(amount)) {
                return res.status(400).json({
                    success: false,
                    message: "Stake must be a number"
                });
            }

            if (amount < 0.35) {
                return res.status(400).json({
                    success: false,
                    message: "Minimum stake is $0.35"
                });
            }

            // ==========================================
            // MARKET QUERY — NEON
            // ==========================================

            console.log(
                "TRADE CHECKPOINT 2 - BEFORE MARKET QUERY"
            );

            const normalizedMarketId =
                String(marketId || "").trim();

            const isUUID =
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
                    .test(normalizedMarketId);

            const marketResult = await db.query(
                `SELECT *
                 FROM markets
                 WHERE is_active = TRUE
                   AND ${isUUID ? "id" : "symbol"} = $1
                 LIMIT 1`,
                [normalizedMarketId]
            );

            const market = marketResult.rows[0] || null;

            console.log(
                "TRADE CHECKPOINT 3 - AFTER MARKET QUERY"
            );
            console.log(
                "========== MARKET LOOKUP DEBUG =========="
            );
            console.log("marketId:", marketId);
            console.log("market:", market);
            console.log(
                "=========================================="
            );

            if (!market) {
                return res.status(400).json({
                    success: false,
                    message: "Market not found or inactive"
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

            const isVOLMarket = String(
                market.symbol || ""
            ).trim().toUpperCase().startsWith("VOL-");

            if (!allowedContractTypes.includes(contractType)) {
                return res.status(400).json({
                    success: false,
                    message: "Unsupported contract type"
                });
            }

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

            console.log("CONTRACT VALIDATION PASSED");
            console.log("Market:", market.symbol);
            console.log(
                "Database contract:",
                market.contract_type
            );
            console.log(
                "Selected contract:",
                contractType
            );
            console.log("Is VOL market:", isVOLMarket);

            // ==========================================
            // VALID ACTIONS
            // ==========================================

            const validActions = {
                matches: ["matches"],
                differs: ["differs"],
                over_under: ["over", "under"],
                odd_even: ["odd", "even"],
                rise_fall: ["rise", "fall"],
                higher_lower: ["higher", "lower"],
                touch_no_touch: ["touch", "no_touch"],
                accumulator: ["accumulate"]
            };

            if (
                !validActions[contractType] ||
                !validActions[contractType].includes(action)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid trade action"
                });
            }

            console.log("SYNTHETIC DEBUG MARKET:", market);
            console.log("MARKET SYMBOL:", market.symbol);

            const syntheticSymbol =
                getSyntheticSymbol(market);

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
                syntheticMarket.markets[syntheticSymbol];

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
                syntheticMarket.getPrice(syntheticSymbol);

            console.log(
                "ACCUMULATOR CHECKPOINT 3 - ENTRY PRICE:",
                entryPrice
            );

            console.log(
                "ACCUMULATOR CHECKPOINT 4 - BEFORE GET MARKET"
            );

            const marketInfo =
                syntheticMarket.getMarket(syntheticSymbol);

            console.log(
                "ACCUMULATOR CHECKPOINT 5 - MARKET INFO:",
                marketInfo
            );

            const entryTick = marketInfo
                ? Number(marketInfo.tick)
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
            let suppliedDigit = null;

            // ==========================================
            // TARGET DIGIT VALIDATION
            // ==========================================

            if (
                targetDigit !== null &&
                targetDigit !== undefined &&
                targetDigit !== ""
            ) {
                suppliedDigit = Number(targetDigit);
            }

            // ==========================================
            // RISE / FALL
            // ==========================================

            if (contractType === "rise_fall") {
                finalTargetDigit = null;
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

                higherLowerBarrier = Number(
                    suppliedBarrier.toFixed(2)
                );

                finalTargetDigit = null;
            }

            // ==========================================
            // OVER / UNDER
            // ==========================================

            if (contractType === "over_under") {
                if (
                    !Number.isInteger(suppliedDigit) ||
                    suppliedDigit < 1 ||
                    suppliedDigit > 8
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Target digit must be an integer from 1 to 8 for Over/Under"
                    });
                }

                finalTargetDigit = suppliedDigit;
            }

            // ==========================================
            // MATCHES
            // ==========================================

            if (contractType === "matches") {
                if (
                    !Number.isInteger(suppliedDigit) ||
                    suppliedDigit < 0 ||
                    suppliedDigit > 9
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Target digit must be an integer from 0 to 9 for Matches"
                    });
                }

                finalTargetDigit = suppliedDigit;
            }

            // ==========================================
            // DIFFERS
            // ==========================================

            if (contractType === "differs") {
                if (
                    !Number.isInteger(suppliedDigit) ||
                    suppliedDigit < 0 ||
                    suppliedDigit > 9
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Target digit must be an integer from 0 to 9 for Differs"
                    });
                }

                finalTargetDigit = suppliedDigit;
            }

            // ==========================================
            // ODD / EVEN
            // ==========================================

            if (contractType === "odd_even") {
                finalTargetDigit = null;
            }

            // ==========================================
            // TOUCH / NO TOUCH
            // ==========================================

            let barrierPrice = null;
            let barrierDirection = null;

            if (contractType === "touch_no_touch") {
                barrierDirection = String(
                    req.body.barrierDirection || ""
                ).trim().toLowerCase();

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

                barrierPrice = calculateTouchBarrier(
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
            let expirySeconds = contractDuration;

            if (contractDurationUnit === "s") {
                expiresAt = new Date(
                    Date.now() + contractDuration * 1000
                );

                expirySeconds = contractDuration;
            }

            if (contractDurationUnit === "t") {
                // Each synthetic tick is treated as 1 second.
                expirySeconds = contractDuration;

                // Database requires expires_at for tick trades.
                expiresAt = new Date(
                    Date.now() + contractDuration * 1000
                );
            }

            // ==========================================
            // ACCUMULATOR
            // ==========================================

            if (contractType === "accumulator") {
                finalTargetDigit = null;

                const rawAccumulatorGrowth =
                    req.body.accumulatorGrowth;

                console.log(
                    "ACCUMULATOR RAW GROWTH:",
                    rawAccumulatorGrowth,
                    "TYPE:",
                    typeof rawAccumulatorGrowth
                );

                accumulatorGrowth = Number(
                    Number(rawAccumulatorGrowth).toFixed(2)
                );

                console.log(
                    "ACCUMULATOR NORMALIZED GROWTH:",
                    accumulatorGrowth
                );

                if (
                    !Number.isFinite(accumulatorGrowth) ||
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

                accumulatorDirection = String(
                    req.body.accumulatorDirection || ""
                ).trim().toLowerCase();

                if (
                    accumulatorDirection !== "above" &&
                    accumulatorDirection !== "below"
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Accumulator direction must be above or below"
                    });
                }

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
                    calculateAccumulatorBoundaries(entryPrice);

                console.log(
                    "ACCUMULATOR CHECKPOINT 9 - BOUNDARIES:",
                    accumulatorBoundaries
                );

                if (!accumulatorBoundaries) {
                    return res.status(500).json({
                        success: false,
                        message:
                            "Unable to calculate accumulator boundaries"
                    });
                }

                accumulatorLowerBoundary = Number(
                    accumulatorBoundaries.lowerBoundary
                );

                accumulatorUpperBoundary = Number(
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

                // Preserve the legacy barrier field.
                accumulatorBarrier =
                    accumulatorDirection === "above"
                        ? accumulatorLowerBoundary
                        : accumulatorUpperBoundary;
            }

            // ==========================================
            // GET USER WALLET
            // ==========================================

            // Keep your existing getOrCreateWallet helper.
            // It must use Neon internally for database queries.
            const wallet =
                await getOrCreateWallet(req.user.id);

            // ==========================================
            // DEMO / REAL ACCOUNT MODE
            // ==========================================

            const tradeMode = String(
                req.body.mode || "demo"
            ).trim().toLowerCase();

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

            const isDemoTrade = tradeMode === "demo";

            // ==========================================
            // READ WALLET BALANCES
            // ==========================================

            const currentRealBalance =
                Number(wallet.balance || 0);

            const currentBonusBalance =
                Number(wallet.bonus_balance || 0);

            const currentDemoBalance =
                Number(wallet.demo_balance || 0);

            if (
                !Number.isFinite(currentRealBalance) ||
                !Number.isFinite(currentBonusBalance) ||
                !Number.isFinite(currentDemoBalance)
            ) {
                return res.status(500).json({
                    success: false,
                    message: "Invalid wallet balance"
                });
            }

            // ==========================================
            // AVAILABLE TRADING BALANCE
            // ==========================================

            const currentTradingBalance = isDemoTrade
                ? currentDemoBalance
                : currentRealBalance + currentBonusBalance;

            if (amount > currentTradingBalance) {
                return res.status(400).json({
                    success: false,
                    message:
                        `Insufficient ${tradeMode} balance`
                });
            }

            // ==========================================
            // CALCULATE STAKE FUNDING
            // ==========================================

            let realStakeAmount = 0;
            let bonusStakeAmount = 0;

            let newRealBalance = currentRealBalance;
            let newBonusBalance = currentBonusBalance;
            let newDemoBalance = currentDemoBalance;

            if (isDemoTrade) {
                newDemoBalance = Number(
                    (
                        currentDemoBalance - amount
                    ).toFixed(6)
                );
            } else {
                realStakeAmount = Math.min(
                    amount,
                    currentRealBalance
                );

                bonusStakeAmount = Number(
                    (
                        amount - realStakeAmount
                    ).toFixed(6)
                );

                newRealBalance = Number(
                    (
                        currentRealBalance -
                        realStakeAmount
                    ).toFixed(6)
                );

                newBonusBalance = Number(
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
            // RESERVE TRADE STAKE — NEON
            // ==========================================

            let walletUpdateResult;

            try {
                if (isDemoTrade) {
                    walletUpdateResult = await db.query(
                        `UPDATE wallets
                         SET
                             demo_balance = $1,
                             updated_at = NOW()
                         WHERE id = $2
                           AND demo_balance = $3
                         RETURNING *`,
                        [
                            newDemoBalance,
                            wallet.id,
                            currentDemoBalance
                        ]
                    );
                } else {
                    walletUpdateResult = await db.query(
                        `UPDATE wallets
                         SET
                             balance = $1,
                             bonus_balance = $2,
                             updated_at = NOW()
                         WHERE id = $3
                           AND balance = $4
                           AND bonus_balance = $5
                         RETURNING *`,
                        [
                            newRealBalance,
                            newBonusBalance,
                            wallet.id,
                            currentRealBalance,
                            currentBonusBalance
                        ]
                    );
                }
            } catch (walletUpdateError) {
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

            const updatedWallet =
                walletUpdateResult.rows[0] || null;

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

            console.log("==========================================");
            console.log("TRADE WALLET RESERVATION");
            console.log("TRADE MODE:", tradeMode);
            console.log("TRADE STAKE:", amount);
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
            console.log("REAL STAKE USED:", realStakeAmount);
            console.log("BONUS STAKE USED:", bonusStakeAmount);
            console.log("REAL BALANCE AFTER:", newRealBalance);
            console.log("BONUS BALANCE AFTER:", newBonusBalance);
            console.log("DEMO BALANCE AFTER:", newDemoBalance);
            console.log("==========================================");

            // ==========================================
            // CREATE TRADE — NEON
            // ==========================================

            let trade;

            try {
                const tradeResult = await db.query(
                    `INSERT INTO trades (
                        user_id,
                        market_id,
                        symbol,
                        contract_type,
                        action,
                        stake,
                        entry_price,
                        target_price,
                        target_digit,
                        expiry_seconds,
                        duration,
                        duration_unit,
                        entry_tick,
                        expiry_tick,
                        expires_at,
                        status,
                        mode,
                        barrier_touched,
                        barrier_touched_at,
                        barrier_direction,
                        accumulator_broken,
                        accumulator_broken_at,
                        accumulator_growth,
                        accumulator_barrier,
                        accumulator_lower_boundary,
                        accumulator_upper_boundary,
                        accumulator_direction,
                        accumulator_current_rate
                    )
                    VALUES (
                        $1, $2, $3, $4, $5, $6, $7,
                        $8, $9, $10, $11, $12, $13, $14,
                        $15, $16, $17, $18, $19, $20,
                        $21, $22, $23, $24, $25, $26,
                        $27, $28
                    )
                    RETURNING *`,
                    [
                        req.user.id,
                        market.id,
                        market.symbol,
                        contractType,
                        action,
                        amount,
                        entryPrice,

                        contractType === "touch_no_touch"
                            ? barrierPrice
                            : contractType === "higher_lower"
                                ? higherLowerBarrier
                                : null,

                        finalTargetDigit,
                        expirySeconds,
                        contractDuration,
                        contractDurationUnit,
                        entryTick,

                        contractDurationUnit === "t"
                            ? entryTick + contractDuration
                            : null,

                        expiresAt
                            ? expiresAt.toISOString()
                            : null,

                        "pending",
                        tradeMode,
                        false,
                        null,
                        barrierDirection,
                        false,
                        null,
                        accumulatorGrowth,
                        accumulatorBarrier,
                        accumulatorLowerBoundary,
                        accumulatorUpperBoundary,
                        accumulatorDirection,
                        accumulatorGrowth
                    ]
                );

                trade = tradeResult.rows[0] || null;

                if (!trade) {
                    throw new Error(
                        "Trade insert returned no record"
                    );
                }
            } catch (tradeError) {
                console.error(
                    "Trade insert error:",
                    tradeError
                );

                // ==========================================
                // RESTORE STAKE AFTER TRADE INSERT FAILURE
                // ==========================================

                try {
                    if (isDemoTrade) {
                        await db.query(
                            `UPDATE wallets
                             SET
                                 demo_balance = $1,
                                 updated_at = NOW()
                             WHERE id = $2
                               AND demo_balance = $3`,
                            [
                                currentDemoBalance,
                                wallet.id,
                                newDemoBalance
                            ]
                        );
                    } else {
                        await db.query(
                            `UPDATE wallets
                             SET
                                 balance = $1,
                                 bonus_balance = $2,
                                 updated_at = NOW()
                             WHERE id = $3
                               AND balance = $4
                               AND bonus_balance = $5`,
                            [
                                currentRealBalance,
                                currentBonusBalance,
                                wallet.id,
                                newRealBalance,
                                newBonusBalance
                            ]
                        );
                    }
                } catch (restoreError) {
                    console.error(
                        "Trade stake restore error:",
                        restoreError
                    );
                }

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to create trade. Your stake restoration was attempted."
                });
            }

     
            // ==========================================
            // RECORD TRADE STAKE TRANSACTION — NEON
            // ==========================================

            const transactionBalanceBefore = isDemoTrade
                ? currentDemoBalance
                : currentTradingBalance;

            const transactionBalanceAfter = isDemoTrade
                ? newDemoBalance
                : newRealBalance + newBonusBalance;

            let transactionError = null;

            try {
                await db.query(
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
                        req.user.id,
                        wallet.id,
                        "trade_stake",
                        "trade_stake",
                        Number(amount.toFixed(6)),
                        "completed",
                        "wallet",
                        "TRADE-" + trade.id,
                        trade.id,
                        "Trade stake reserved",
                        Number(transactionBalanceBefore.toFixed(6)),
                        Number(transactionBalanceAfter.toFixed(6))
                    ]
                );
            } catch (error) {
                transactionError = error;

                console.error(
                    "Trade wallet transaction error:",
                    error
                );
            }

            // ==========================================
            // RESTORE STAKE AND CANCEL ONLY ON FAILURE
            // ==========================================

            if (transactionError) {
                let restored = false;

                try {
                    let restoreResult;

                    if (isDemoTrade) {
                        restoreResult = await db.query(
                            `UPDATE wallets
                             SET demo_balance = $1,
                                 updated_at = NOW()
                             WHERE id = $2
                               AND demo_balance = $3
                             RETURNING id`,
                            [
                                currentDemoBalance,
                                wallet.id,
                                newDemoBalance
                            ]
                        );
                    } else {
                        restoreResult = await db.query(
                            `UPDATE wallets
                             SET balance = $1,
                                 bonus_balance = $2,
                                 updated_at = NOW()
                             WHERE id = $3
                               AND balance = $4
                               AND bonus_balance = $5
                             RETURNING id`,
                            [
                                currentRealBalance,
                                currentBonusBalance,
                                wallet.id,
                                newRealBalance,
                                newBonusBalance
                            ]
                        );
                    }

                    restored = Boolean(
                        restoreResult.rows &&
                        restoreResult.rows.length > 0
                    );

                    if (!restored) {
                        console.error(
                            "Stake restoration could not be confirmed."
                        );
                    }
                } catch (restoreError) {
                    console.error(
                        "Trade stake restore error:",
                        restoreError
                    );
                }

                let cancelled = false;

                try {
                    const cancelResult = await db.query(
                        `UPDATE trades
                         SET status = 'cancelled'
                         WHERE id = $1
                           AND status = 'pending'
                         RETURNING id`,
                        [trade.id]
                    );

                    cancelled = Boolean(
                        cancelResult.rows &&
                        cancelResult.rows.length > 0
                    );

                    if (!cancelled) {
                        console.error(
                            "Trade was not cancelled because it was no longer pending:",
                            trade.id
                        );
                    }
                } catch (cancelError) {
                    console.error(
                        "Trade cancellation error:",
                        cancelError
                    );
                }

                return res.status(500).json({
                    success: false,
                    message: restored
                        ? "Unable to record trade payment. Stake restoration was completed."
                        : "Unable to record trade payment. Stake restoration could not be confirmed. Contact support before retrying.",
                    tradeCancelled: cancelled,
                    stakeRestored: restored
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
    getLastDigit(entryPrice),
    "Target Digit:",
    finalTargetDigit,
    "Target Price:",
    trade.target_price,
    "Duration:",
    contractDuration + " " + contractDurationUnit
);

return res.json({
    success: true,
    message: "Trade placed successfully",
    trade
});
} catch (error) {
    console.error("Trade error:", error);

    return res.status(500).json({
        success: false,
        message: "Unable to place trade"
    });
}
}
);

// ======================================================
// GET MARKET STATISTICS
// ======================================================

app.get(
    "/api/market-statistics",
    authenticateUser,
    async (req, res) => {
        try {
            const requestedSymbol = String(
                req.query.symbol || ""
            ).trim().toUpperCase();

            let limit = Number(req.query.limit || 100);
            const targetDigit = Number(req.query.digit);

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

            const allowedLimits = [100, 300, 500, 1000];

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

            const history = syntheticMarket.getHistory(
                syntheticSymbol,
                limit
            );

            const ticks = Array.isArray(history) ? history : [];

            const latestTick =
                ticks.length > 0
                    ? ticks[ticks.length - 1]
                    : null;

            const latestPrice = Number(latestTick?.price);

            const latestDigit = Number.isFinite(latestPrice)
                ? Math.abs(Math.floor(latestPrice * 100)) % 10
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
                const price = Number(item?.price);

                if (!Number.isFinite(price)) {
                    continue;
                }

                const digit =
                    Math.abs(Math.floor(price * 100)) % 10;

                digitCounts[digit]++;
            }

            // ==========================================
            // TOTAL VALID TICKS
            // ==========================================

            const totalDigits = Object.values(digitCounts)
                .reduce((sum, count) => sum + count, 0);

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
                for (let digit = 0; digit <= 9; digit++) {
                    const count = digitCounts[digit];

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

                differsCount = totalDigits - matchesCount;
            }

            const overPercentage = totalDigits > 0
                ? Math.round((overCount / totalDigits) * 100)
                : 0;

            const underPercentage = totalDigits > 0
                ? 100 - overPercentage
                : 0;

            const matchesPercentage = totalDigits > 0
                ? Math.round((matchesCount / totalDigits) * 100)
                : 0;

            const differsPercentage = totalDigits > 0
                ? 100 - matchesPercentage
                : 0;

            // ==========================================
            // LARGEST REMAINDER PERCENTAGES
            // TOTAL WILL ALWAYS EQUAL 100
            // ==========================================

            const digitFrequency = {};

            if (totalDigits > 0) {
                const calculations = Object.keys(digitCounts)
                    .map(digit => {
                        const exact =
                            (digitCounts[digit] / totalDigits) * 100;

                        const floor = Math.floor(exact);

                        return {
                            digit,
                            count: digitCounts[digit],
                            percentage: floor,
                            remainder: exact - floor
                        };
                    });

                const assigned = calculations.reduce(
                    (sum, item) => sum + item.percentage,
                    0
                );

                const remaining = 100 - assigned;

                calculations.sort((a, b) => {
                    if (b.remainder !== a.remainder) {
                        return b.remainder - a.remainder;
                    }

                    return Number(a.digit) - Number(b.digit);
                });

                for (let i = 0; i < remaining; i++) {
                    calculations[i].percentage++;
                }

                calculations.sort(
                    (a, b) => Number(a.digit) - Number(b.digit)
                );

                for (const item of calculations) {
                    digitFrequency[item.digit] = {
                        count: item.count,
                        percentage: item.percentage
                    };
                }
            } else {
                for (let digit = 0; digit <= 9; digit++) {
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
                const counts = Object.values(digitCounts);
                const maxCount = Math.max(...counts);
                const minCount = Math.min(...counts);

                mostFrequentDigits =
                    Object.keys(digitCounts)
                        .filter(
                            digit =>
                                digitCounts[digit] === maxCount
                        )
                        .map(Number);

                leastFrequentDigits =
                    Object.keys(digitCounts)
                        .filter(
                            digit =>
                                digitCounts[digit] === minCount
                        )
                        .map(Number);
            }

            // ==========================================
            // ODD / EVEN
            // ==========================================

            let oddCount = 0;
            let evenCount = 0;

            for (let digit = 0; digit <= 9; digit++) {
                if (digit % 2 === 0) {
                    evenCount += digitCounts[digit];
                } else {
                    oddCount += digitCounts[digit];
                }
            }

            const oddPercentage =
                totalDigits > 0
                    ? Math.round(
                        (oddCount / totalDigits) * 100
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

            for (let i = 1; i < ticks.length; i++) {
                const current = Number(ticks[i]?.price);
                const previous = Number(ticks[i - 1]?.price);

                if (
                    Number.isFinite(current) &&
                    Number.isFinite(previous)
                ) {
                    changes.push(current - previous);
                }
            }

            let volatility = 0;

            if (changes.length > 0) {
                const mean =
                    changes.reduce(
                        (sum, value) => sum + value,
                        0
                    ) / changes.length;

                const variance =
                    changes.reduce(
                        (sum, value) =>
                            sum + Math.pow(value - mean, 2),
                        0
                    ) / changes.length;

                volatility = Math.sqrt(variance);
            }

            volatility = Number(volatility.toFixed(6));

            // ==========================================
            // RESPONSE
            // ==========================================

            return res.json({
                success: true,
                symbol: syntheticSymbol,
                latestPrice,
                latestDigit,
                sampleSize: totalDigits,
                requestedLimit: limit,
                digitFrequency,
                mostFrequentDigits,
                leastFrequentDigits,

                oddEven: {
                    odd: {
                        count: oddCount,
                        percentage: oddPercentage
                    },

                    even: {
                        count: evenCount,
                        percentage: evenPercentage
                    }
                },

                targetDigit,

                overUnder: {
                    over: {
                        count: overCount,
                        percentage: overPercentage
                    },

                    under: {
                        count: underCount,
                        percentage: underPercentage
                    }
                },

                matchesDiffers: {
                    matches: {
                        count: matchesCount,
                        percentage: matchesPercentage
                    },

                    differs: {
                        count: differsCount,
                        percentage: differsPercentage
                    }
                },

                volatility
            });
        } catch (error) {
            console.error(
                "Market statistics API error:",
                error
            );

            return res.status(500).json({
                success: false,
                message: "Unable to calculate market statistics"
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

            let limit = Number(req.query.limit || 500);

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

            const history = syntheticMarket.getHistory(
                syntheticSymbol,
                limit
            );

            return res.json({
                success: true,
                symbol: syntheticSymbol,
                history: Array.isArray(history) ? history : []
            });
        } catch (error) {
            console.error(
                "Market history API error:",
                error
            );

            return res.status(500).json({
                success: false,
                message: "Unable to load synthetic market history"
            });
        }
    }
);

const automationSessions = new Map();

const AUTOMATION_MIN_STAKE = 0.35;
const AUTOMATION_MAX_RUNS = 15;

const AUTOMATION_POLL_MS = 100;
const AUTOMATION_SCAN_DELAY_MS = 200;
const AUTOMATION_TRADE_TIMEOUT_MS = 120000;


// ======================================================
// AUTOMATION HELPERS
// ======================================================

function automationNumber(value, fallback = 0) {
    const n = Number(value);

    return Number.isFinite(n) ? n : fallback;
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
            automationSessions.get(requestedSessionId);

        if (
            requestedSession &&
            requestedSession.userId === userId
        ) {
            return requestedSession;
        }

        return null;
    }

    const userSessions =
        Array.from(automationSessions.values())
            .filter(session => session.userId === userId)
            .sort(
                (a, b) =>
                    new Date(b.startedAt || 0) -
                    new Date(a.startedAt || 0)
            );

    return userSessions[0] || null;
}


// ======================================================
// GET AUTOMATION TRADE — NEON
// ======================================================

async function getAutomationTrade(tradeId, userId) {
    const result = await db.query(
        `SELECT *
         FROM trades
         WHERE id = $1
           AND user_id = $2
         LIMIT 1`,
        [tradeId, userId]
    );

    return result.rows[0] || null;
}


// ======================================================
// WAIT FOR SETTLEMENT
// ======================================================

async function waitForAutomationSettlement(tradeId, userId) {
    const startedAt = Date.now();

    console.log(
        "AUTOMATION WAITING FOR SETTLEMENT:",
        tradeId
    );

    while (
        Date.now() - startedAt <
        AUTOMATION_TRADE_TIMEOUT_MS
    ) {
        const trade = await getAutomationTrade(
            tradeId,
            userId
        );

        if (!trade) {
            throw new Error("Automated trade disappeared");
        }

        const status = String(
            trade.status || trade.result || ""
        ).trim().toLowerCase();

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

        await automationSleep(AUTOMATION_POLL_MS);
    }

    throw new Error("Automation trade settlement timeout");
}


// ======================================================
// GET ACTIVE MARKETS — NEON
// ======================================================

async function getAutomationMarkets() {
    const result = await db.query(
        `SELECT *
         FROM markets
         WHERE is_active = TRUE`
    );

    return result.rows || [];
}


// ======================================================
// BUILD AUTOMATION MARKET DATA
// ======================================================

function getAutomationMarketData(market) {
    const symbol = String(
        market?.symbol || market || ""
    ).trim().toUpperCase();

    const syntheticSymbol = market?.symbol
        ? getSyntheticSymbol(market)
        : symbol;

    if (!syntheticSymbol) {
        return null;
    }

    const price = Number(
        syntheticMarket.getPrice(syntheticSymbol)
    );

    if (!Number.isFinite(price)) {
        return null;
    }

    const marketInfo =
        syntheticMarket.getMarket(syntheticSymbol);

    const tick =
        marketInfo &&
        Number.isFinite(Number(marketInfo.tick))
            ? Number(marketInfo.tick)
            : 0;

    const previousPrice =
        marketInfo &&
        Number.isFinite(Number(marketInfo.previousPrice))
            ? Number(marketInfo.previousPrice)
            : null;

    const lastDigit = getLastDigit(price);

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
        const markets = await getAutomationMarkets();

        if (!Array.isArray(markets) || markets.length === 0) {
            throw new Error(
                "No active automation markets available"
            );
        }

        const marketRequest = String(
            requestedMarket || "AUTO"
        ).trim().toUpperCase();

        const contractRequest = String(
            requestedContract || "AUTO"
        ).trim().toLowerCase();

        const isVolSymbol = symbol =>
            String(symbol || "")
                .toUpperCase()
                .startsWith("VOL-");

        const isKmfSymbol = symbol =>
            String(symbol || "")
                .toUpperCase()
                .startsWith("KMF-");

        let eligibleMarkets = markets.filter(market => {
            if (!market || market.is_active === false) {
                return false;
            }

            const symbol = String(
                market.symbol || ""
            ).trim().toUpperCase();

            if (marketRequest === "VOL") {
                return isVolSymbol(symbol);
            }

            if (marketRequest === "KMF") {
                return isKmfSymbol(symbol);
            }

            if (marketRequest !== "AUTO") {
                return symbol === marketRequest;
            }

            return (
                isKmfSymbol(symbol) ||
                isVolSymbol(symbol)
            );
        });

        if (eligibleMarkets.length === 0) {
            throw new Error(
                `No active markets found for ${marketRequest}`
            );
        }

        if (marketRequest === "AUTO") {
            eligibleMarkets.sort((a, b) => {
                const aVol = isVolSymbol(a.symbol) ? 1 : 0;
                const bVol = isVolSymbol(b.symbol) ? 1 : 0;

                return bVol - aVol;
            });
        }

        const candidates = [];

        for (const market of eligibleMarkets) {
            try {
                const databaseSymbol = String(
                    market.symbol || ""
                ).trim().toUpperCase();

                const isVOL = isVolSymbol(databaseSymbol);
                const isKMF = isKmfSymbol(databaseSymbol);

                const marketData =
                    getAutomationMarketData(market);

                if (!marketData) {
                    continue;
                }

                const syntheticSymbol = String(
                    marketData.syntheticSymbol || databaseSymbol
                ).trim().toUpperCase();

                const currentPrice = Number(
                    marketData.price ??
                    marketData.currentPrice ??
                    marketData.current_price ??
                    marketData.lastPrice ??
                    marketData.last_price
                );

                const previousPrice = Number(
                    marketData.previousPrice ??
                    marketData.previous_price ??
                    marketData.prevPrice ??
                    marketData.prev_price ??
                    marketData.openPrice ??
                    marketData.open_price ??
                    currentPrice
                );

                const currentTick = Number(
                    marketData.tick ??
                    marketData.currentTick ??
                    marketData.current_tick ??
                    marketData.lastTick ??
                    marketData.last_tick ??
                    0
                );

                if (!Number.isFinite(currentPrice)) {
                    continue;
                }

                const safePreviousPrice =
                    Number.isFinite(previousPrice)
                        ? previousPrice
                        : currentPrice;

                const movement =
                    currentPrice - safePreviousPrice;

                const absMovement = Math.abs(movement);

                const movementBase = Math.max(
                    Math.abs(safePreviousPrice) * 0.00001,
                    0.000001
                );

                const normalizedMovement = Math.min(
                    absMovement / movementBase,
                    10
                );

                // ========================================
                // VOL LOGIC
                // ========================================

                if (isVOL) {
                    let action;

                    if (movement > 0) {
                        action = "rise";
                    } else if (movement < 0) {
                        action = "fall";
                    } else {
                        action =
                            currentTick % 2 === 0
                                ? "rise"
                                : "fall";
                    }

                    let confidence = 60;

                    confidence += Math.min(
                        normalizedMovement * 3,
                        20
                    );

                    if (movement !== 0) {
                        confidence += 5;
                    }

                    confidence = Math.min(
                        Math.round(confidence),
                        95
                    );

                    candidates.push({
                        marketId: market.id,
                        symbol: databaseSymbol,
                        syntheticSymbol,

                        marketName:
                            market.market_name ||
                            market.name ||
                            databaseSymbol,

                        price: currentPrice,
                        tick: currentTick,
                        previousPrice: safePreviousPrice,
                        movement,
                        contractType: "rise_fall",
                        action,
                        barrierPrice: null,
                        targetDigit: null,
                        confidence,
                        marketClass: "VOL",

                        reason:
                            movement > 0
                                ? `VOL momentum rising: ${movement.toFixed(4)}`
                                : movement < 0
                                    ? `VOL momentum falling: ${Math.abs(movement).toFixed(4)}`
                                    : "VOL market flat; direction selected from latest tick.",

                        isVOL: true,
                        isKMF: false
                    });

                    continue;
                }

                // ========================================
                // KMF LOGIC
                // ========================================

                if (isKMF) {
                    const databaseContract = String(
                        market.contract_type || ""
                    ).trim().toLowerCase();

                    let contractType = databaseContract;

                    if (
                        contractRequest !== "auto" &&
                        contractRequest !== databaseContract
                    ) {
                        continue;
                    }

                    let action = null;
                    let barrierPrice = null;
                    let targetDigit = null;
                    let confidence = 50;
                    let reason = "";

                    // RISE / FALL

                    if (databaseContract === "rise_fall") {
                        action =
                            movement >= 0
                                ? "rise"
                                : "fall";

                        confidence += Math.min(
                            normalizedMovement * 2,
                            20
                        );

                        reason =
                            movement >= 0
                                ? "KMF price movement is rising."
                                : "KMF price movement is falling.";
                    }

                    // HIGHER / LOWER

                    else if (
                        databaseContract === "higher_lower"
                    ) {
                        action =
                            movement >= 0
                                ? "higher"
                                : "lower";

                        const distance = Math.max(
                            Math.abs(currentPrice) * 0.00005,
                            0.01
                        );

                        barrierPrice =
                            movement >= 0
                                ? currentPrice + distance
                                : currentPrice - distance;

                        confidence += Math.min(
                            normalizedMovement * 2,
                            20
                        );

                        reason =
                            movement >= 0
                                ? "KMF momentum favors higher."
                                : "KMF momentum favors lower.";
                    }

                    // ODD / EVEN

                    else if (
                        databaseContract === "odd_even"
                    ) {
                        const priceText = Math.abs(currentPrice)
                            .toFixed(2)
                            .replace(".", "");

                        const lastDigit =
                            Number(priceText.slice(-1));

                        action =
                            lastDigit % 2 === 0
                                ? "even"
                                : "odd";

                        confidence = 55;

                        reason =
                            `Latest price digit is ${lastDigit}; selecting ${action}.`;
                    }

                    // OVER / UNDER

                    else if (
                        databaseContract === "over_under"
                    ) {
                        const priceText = Math.abs(currentPrice)
                            .toFixed(2)
                            .replace(".", "");

                        let lastDigit =
                            Number(priceText.slice(-1));

                        if (!Number.isFinite(lastDigit)) {
                            lastDigit = 5;
                        }

                        targetDigit = Math.min(
                            Math.max(lastDigit, 1),
                            8
                        );

                        action =
                            lastDigit >= 5
                                ? "over"
                                : "under";

                        confidence = 55;

                        reason =
                            `Latest digit is ${lastDigit}; selecting ${action} ${targetDigit}.`;
                    }

                    // FALLBACK

                    else {
                        contractType = "rise_fall";

                        action =
                            movement >= 0
                                ? "rise"
                                : "fall";

                        confidence = 55;

                        reason =
                            "Unsupported KMF contract detected; using rise/fall fallback.";
                    }

                    confidence = Math.min(
                        Math.round(confidence),
                        95
                    );

                    candidates.push({
                        marketId: market.id,
                        symbol: databaseSymbol,
                        syntheticSymbol,

                        marketName:
                            market.market_name ||
                            market.name ||
                            databaseSymbol,

                        price: currentPrice,
                        tick: currentTick,
                        previousPrice: safePreviousPrice,
                        movement,
                        contractType,
                        action,
                        barrierPrice,
                        targetDigit,
                        confidence,
                        marketClass: "KMF",
                        reason,
                        isVOL: false,
                        isKMF: true
                    });
                }
            } catch (marketError) {
                console.error(
                    "AUTOMATION MARKET SCAN ERROR:",
                    market.symbol,
                    marketError
                );
            }
        }

        // CONFIDENCE FILTER

        let validCandidates = candidates.filter(
            candidate =>
                Number(candidate.confidence) >= 55
        );

        // AUTO = VOL FIRST

        if (marketRequest === "AUTO") {
            const volCandidates = validCandidates.filter(
                candidate => candidate.isVOL === true
            );

            if (volCandidates.length > 0) {
                validCandidates = volCandidates;
            }
        }

        // SORT

        validCandidates.sort(
            (a, b) =>
                Number(b.confidence) -
                Number(a.confidence)
        );

        if (validCandidates.length === 0) {
            return null;
        }

        const selected = validCandidates[0];

        console.log(
            "=========================================="
        );
        console.log("AUTOMATION SCANNER RESULT");
        console.log("REQUESTED MARKET:", marketRequest);
        console.log("SELECTED MARKET:", selected.symbol);
        console.log("MARKET CLASS:", selected.marketClass);
        console.log("SYNTHETIC SYMBOL:", selected.syntheticSymbol);
        console.log("CONTRACT:", selected.contractType);
        console.log("ACTION:", selected.action);
        console.log("PRICE:", selected.price);
        console.log("MOVEMENT:", selected.movement);
        console.log("CONFIDENCE:", selected.confidence);
        console.log("REASON:", selected.reason);
        console.log("QUALIFIED: true");
        console.log(
            "=========================================="
        );

        return {
            qualified: true,
            marketId: selected.marketId,
            symbol: selected.symbol,
            syntheticSymbol: selected.syntheticSymbol,
            price: selected.price,
            tick: selected.tick,
            previousPrice: selected.previousPrice,
            movement: selected.movement,

            lastDigit: Number(
                String(Math.abs(selected.price))
                    .replace(".", "")
                    .slice(-1)
            ),

            contractType: selected.contractType,
            action: selected.action,
            barrierPrice: selected.barrierPrice,
            targetDigit: selected.targetDigit,
            confidence: selected.confidence,
            reason: selected.reason,
            marketClass: selected.marketClass,
            isVOL: selected.isVOL,
            isKMF: selected.isKMF,
            candidates: validCandidates
        };
    } catch (error) {
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

async function placeAutomationTrade(session, setup) {
    const tradingMode =
        String(
            session.accountType ||
            session.account ||
            session.tradingMode ||
            "DEMO"
        ).trim().toUpperCase() === "LIVE"
            ? "real"
            : "demo";

    const tradePayload = {
        marketId: setup.marketId,
        contractType: setup.contractType,
        action: setup.action,
        stake: Number(session.stake),
        duration: 1,
        durationUnit: "s",
        mode: tradingMode
    };

    if (
        setup.targetDigit !== null &&
        setup.targetDigit !== undefined
    ) {
        tradePayload.targetDigit = setup.targetDigit;
    }

    if (
        setup.barrierPrice !== null &&
        setup.barrierPrice !== undefined
    ) {
        tradePayload.barrierPrice = setup.barrierPrice;
    }

    console.log("AUTOMATION PLACING TRADE...");
    console.log("AUTOMATION DURATION: 1 second");
    console.log("AUTOMATION STAKE:", session.stake);
    console.log("AUTOMATION MARKET:", setup.symbol);
    console.log("AUTOMATION ACTION:", setup.action);

    const response = await axios.post(
        `http://127.0.0.1:${PORT}/api/trades`,
        tradePayload,
        {
            headers: {
                Authorization: session.authorization,
                "Content-Type": "application/json"
            },
            timeout: 15000
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

function automationRiskStopReason(session) {
    const targetRuns = Number(
        session.targetRuns ??
        session.runs ??
        0
    );

    const completedRuns =
        Number(session.completedRuns || 0);

    const netProfit =
        Number(session.netProfit || 0);

    const tp = Number(session.tp || 0);
    const sl = Number(session.sl || 0);
    const maxLoss = Number(session.maxLoss || 0);
    const losses = Number(session.losses || 0);

    if (targetRuns > 0 && completedRuns >= targetRuns) {
        return "Selected runs completed";
    }

    if (tp > 0 && netProfit >= tp) {
        return "Take Profit reached";
    }

    if (sl > 0 && netProfit <= -sl) {
        return "Stop Loss reached";
    }

    if (maxLoss > 0 && losses >= maxLoss) {
        return "Maximum losses reached";
    }

    return null;
}


// ======================================================
// UPDATE SESSION
// ======================================================

async function saveAutomationSession(session) {
    session.updatedAt = new Date().toISOString();
}


// ======================================================
// AUTOMATION EXECUTION LOOP
// ======================================================

async function runAutomationSession(session) {
    try {
        while (session.running) {
            if (session.stopRequested) {
                session.running = false;
                session.status = "STOPPED";

                session.stopReason =
                    session.stopReason ||
                    "Manual stop requested";

                break;
            }

            const stopReason =
                automationRiskStopReason(session);

            if (stopReason) {
                session.running = false;
                session.status = "COMPLETED";
                session.stopReason = stopReason;
                break;
            }

            const nextRun =
                Number(session.completedRuns || 0) + 1;

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

            session.status = "SCANNING";
            session.signal = "SCANNING";
            session.riskStatus = "Monitoring limits";

            await saveAutomationSession(session);

            const setup = await scanAutomationSetup(
                session.market,
                session.contractType
            );

            session.lastScan = new Date().toISOString();

            if (!setup || setup.qualified !== true) {
                session.signal = "WAIT";

                session.lastReason =
                    setup?.reason ||
                    "No suitable setup";

                await saveAutomationSession(session);

                await automationSleep(
                    AUTOMATION_SCAN_DELAY_MS
                );

                continue;
            }

            session.signal =
                String(setup.action).toUpperCase();

            session.selectedMarket = setup.symbol;
            session.selectedContract = setup.contractType;
            session.confidence = setup.confidence;
            session.reason = setup.reason;
            session.lastReason = setup.reason;
            session.status = "PLACING";

            await saveAutomationSession(session);

            const trade = await placeAutomationTrade(
                session,
                setup
            );

            session.activeTradeId = trade.id;
            session.status = "WAITING";
            session.lastTrade = trade;

            session.trades.push({
                tradeId: trade.id,
                market: trade.symbol,
                contractType: trade.contract_type,
                action: trade.action,
                stake: trade.stake,
                duration: 1,
                durationUnit: "s",
                status: "pending",
                createdAt:
                    trade.created_at ||
                    new Date().toISOString()
            });

            await saveAutomationSession(session);

            const settledTrade =
                await waitForAutomationSettlement(
                    trade.id,
                    session.userId
                );

            session.activeTradeId = null;

            const status = String(
                settledTrade.status ||
                settledTrade.result ||
                ""
            ).trim().toLowerCase();

            let profit;

            const actualTradeProfit =
                Number(settledTrade.profit);

            if (Number.isFinite(actualTradeProfit)) {
                profit = actualTradeProfit;
            } else if (status === "won") {
                profit =
                    automationNumber(settledTrade.payout) -
                    automationNumber(settledTrade.stake);
            } else if (status === "lost") {
                profit =
                    -automationNumber(settledTrade.stake);
            } else {
                profit = 0;
            }

            profit = Number(profit.toFixed(6));

            session.completedRuns++;

            if (status === "won") {
                session.wins++;
            } else if (status === "lost") {
                session.losses++;
            }

            session.netProfit = Number(
                (
                    Number(session.netProfit || 0) +
                    profit
                ).toFixed(6)
            );

            session.profit = session.netProfit;
            session.totalProfit = session.netProfit;

            session.winRate =
                session.completedRuns > 0
                    ? Number(
                        (
                            session.wins /
                            session.completedRuns *
                            100
                        ).toFixed(2)
                    )
                    : 0;

            const trackedTrade = session.trades.find(
                item => item.tradeId === settledTrade.id
            );

            if (trackedTrade) {
                trackedTrade.status = status;
                trackedTrade.payout = settledTrade.payout;
                trackedTrade.profit = profit;

                trackedTrade.settledAt =
                    settledTrade.settled_at ||
                    new Date().toISOString();
            }

            session.results.push({
                run: session.completedRuns,
                tradeId: settledTrade.id,
                market: settledTrade.symbol,
                contractType: settledTrade.contract_type,
                action: settledTrade.action,
                stake: settledTrade.stake,
                duration: 1,
                durationUnit: "s",
                status,
                payout: settledTrade.payout,
                profit,
                cumulativeProfit: session.netProfit,
                confidence: setup.confidence,
                reason: setup.reason,
                completedAt: new Date().toISOString()
            });

            session.lastTrade = settledTrade;
            session.status = "REASSESSING";

            await saveAutomationSession(session);

            console.log(
                "AUTOMATION RUN COMPLETE:",
                session.completedRuns,
                "/",
                session.targetRuns
            );

            console.log("RESULT:", status);
            console.log("PROFIT:", profit);
            console.log("TOTAL PROFIT:", session.netProfit);

            if (
                session.completedRuns >=
                session.targetRuns
            ) {
                session.running = false;
                session.status = "COMPLETED";
                session.stopReason = "Selected runs completed";
                break;
            }

            if (session.stopRequested) {
                session.running = false;
                session.status = "STOPPED";

                session.stopReason =
                    session.stopReason ||
                    "Manual stop requested";

                break;
            }

            const afterTradeReason =
                automationRiskStopReason(session);

            if (afterTradeReason) {
                session.running = false;
                session.status = "COMPLETED";
                session.stopReason = afterTradeReason;
                break;
            }

            await automationSleep(
                AUTOMATION_SCAN_DELAY_MS
            );
        }
    } catch (error) {
        console.error(
            "Automation engine error:",
            error
        );

        session.running = false;
        session.status = "ERROR";

        session.stopReason =
            error.message ||
            "Automation engine error";

        session.error = error.message;
    } finally {
        session.running = false;

        if (session.status === "STOPPING") {
            session.status = "STOPPED";
        }

        if (session.status === "RUNNING") {
            session.status = "COMPLETED";
        }

        await saveAutomationSession(session);
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
            console.log("AUTOMATION START REQUEST");
            console.log(
                "=========================================="
            );

            const authHeader =
                req.headers.authorization;

            if (!authHeader) {
                return res.status(401).json({
                    success: false,
                    message: "Authentication required"
                });
            }

            const userId =
                req.user?.id ||
                req.user?.user_id ||
                null;

            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: "Authenticated user not found"
                });
            }

            const automationMode = String(
                req.body.automationMode ||
                req.body.mode ||
                "AUTOMATED"
            ).trim().toUpperCase();

            if (
                automationMode !== "AUTOMATED" &&
                automationMode !== "MANUAL"
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid automation mode"
                });
            }

            const accountType = String(
                req.body.accountType ||
                req.body.account ||
                req.body.tradingMode ||
                "DEMO"
            ).trim().toUpperCase();

            if (
                accountType !== "DEMO" &&
                accountType !== "LIVE"
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid account type"
                });
            }

            const market = String(
                req.body.market || "AUTO"
            ).trim().toUpperCase();

            const contractType = String(
                req.body.contractType ||
                req.body.marketType ||
                "AUTO"
            ).trim().toLowerCase();

            const stake = Number(req.body.stake);
            const runs = Number(req.body.runs);

            const tp = Number(
                req.body.tp ??
                req.body.takeProfit ??
                0
            );

            const sl = Number(
                req.body.sl ??
                req.body.stopLoss ??
                0
            );

            const maxLoss = Number(req.body.maxLoss ?? 0);

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
                Array.from(automationSessions.values())
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
                    sessionId: existingSession.sessionId
                });
            }

            // ------------------------------------------
            // CREATE SESSION
            // ------------------------------------------

            const sessionId = crypto.randomUUID();

            const session = {
                sessionId,
                userId,
                authorization: authHeader,
                automationMode,
                mode: automationMode,
                accountType,
                account: accountType,
                tradingMode: accountType.toLowerCase(),
                market,
                contractType,
                stake,

                duration: 1,
                durationUnit: "s",

                runs,
                targetRuns: runs,
                tp: Math.max(0, tp),
                sl: Math.max(0, sl),
                maxLoss: Math.max(0, maxLoss),

                completedRuns: 0,
                wins: 0,
                losses: 0,
                netProfit: 0,
                profit: 0,
                totalProfit: 0,
                winRate: 0,

                running: true,
                status: "RUNNING",
                signal: "Scanning",
                selectedMarket: null,
                selectedContract: null,
                confidence: null,
                reason: "AI is scanning for a qualifying setup.",
                lastReason: null,
                riskStatus: "Monitoring limits",
                activeTradeId: null,
                lastTrade: null,
                lastScan: null,

                startedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),

                trades: [],
                results: [],
                logs: [],

                stopRequested: false,
                stopReason: null
            };

            automationSessions.set(sessionId, session);

            console.log("AUTOMATION SESSION CREATED:", sessionId);
            console.log("USER:", userId);
            console.log("ACCOUNT:", accountType);
            console.log("AUTOMATION MODE:", automationMode);
            console.log("MARKET:", market);
            console.log("CONTRACT:", contractType);
            console.log("STAKE:", stake);
            console.log("DURATION:", "1 second");
            console.log("RUNS:", runs);
            console.log("TP:", tp);
            console.log("SL:", sl);
            console.log("MAX LOSS:", maxLoss);

            // ------------------------------------------
            // RESPONSE
            // ------------------------------------------

            res.status(200).json({
                success: true,
                message: "Automation session started",
                sessionId,
                status: "RUNNING",

                session: {
                    sessionId,
                    accountType,
                    automationMode,
                    market,
                    contractType,
                    stake,
                    duration: 1,
                    durationUnit: "s",
                    runs,
                    targetRuns: runs,
                    tp,
                    sl,
                    maxLoss,
                    completedRuns: 0,
                    wins: 0,
                    losses: 0,
                    netProfit: 0,
                    profit: 0,
                    totalProfit: 0,
                    winRate: 0,
                    status: "RUNNING"
                }
            });

            // ------------------------------------------
            // START BACKGROUND AUTOMATION
            // ------------------------------------------

            setImmediate(() => {
                runAutomationSession(session)
                    .catch(error => {
                        console.error(
                            "AUTOMATION SESSION ERROR:",
                            error
                        );

                        session.running = false;
                        session.status = "ERROR";

                        session.stopReason =
                            error.message ||
                            "Automation session failed";

                        session.updatedAt =
                            new Date().toISOString();
                    });
            });
        } catch (error) {
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
            const userId = req.user.id;

            const requestedSessionId = String(
                req.body?.sessionId ||
                req.query?.sessionId ||
                ""
            ).trim() || null;

            const session = getUserAutomationSession(
                userId,
                requestedSessionId
            );

            if (!session) {
                return res.status(404).json({
                    success: false,
                    message: "Automation session not found"
                });
            }

            if (!session.running) {
                return res.status(400).json({
                    success: false,
                    message: "No active automation session",
                    sessionId: session.sessionId,
                    status: session.status
                });
            }

            session.stopRequested = true;
            session.status = "STOPPING";
            session.stopReason = "Manual stop requested";

            if (!session.activeTradeId) {
                session.running = false;
                session.status = "STOPPED";
            }

            await saveAutomationSession(session);

            return res.json({
                success: true,
                message: session.activeTradeId
                    ? "Automation stop requested. Current trade will finish before stopping."
                    : "Automation stopped",
                sessionId: session.sessionId,
                status: session.status,
                activeTradeId: session.activeTradeId,
                netProfit: session.netProfit,
                completedRuns: session.completedRuns
            });
        } catch (error) {
            console.error(
                "Automation stop error:",
                error
            );

            return res.status(500).json({
                success: false,
                message: "Unable to stop automation"
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
            const userId = req.user.id;

            const sessionId = String(
                req.query.sessionId || ""
            ).trim() || null;

            const session = getUserAutomationSession(
                userId,
                sessionId
            );

            if (!session) {
                return res.status(404).json({
                    success: false,
                    message: "Automation session not found"
                });
            }

            const completedRuns =
                Number(session.completedRuns || 0);

            const wins = Number(session.wins || 0);
            const losses = Number(session.losses || 0);

            const winRate =
                completedRuns > 0
                    ? Number(
                        (
                            wins /
                            completedRuns *
                            100
                        ).toFixed(2)
                    )
                    : 0;

            const netProfit =
                Number(session.netProfit || 0);

            return res.status(200).json({
                success: true,
                sessionId: session.sessionId,

                status:
                    session.status ||
                    (session.running ? "RUNNING" : "STOPPED"),

                running: Boolean(session.running),
                signal: session.signal || "Scanning",

                market:
                    session.selectedMarket ||
                    session.market ||
                    "AI scanning",

                contract:
                    session.selectedContract ||
                    session.contractType ||
                    "AUTO",

                confidence: Number(session.confidence || 0),

                reason:
                    session.lastReason ||
                    session.reason ||
                    "Waiting for qualifying setup",

                riskStatus: session.riskStatus || "OK",
                runs: Number(session.runs || 0),

                targetRuns: Number(
                    session.targetRuns ??
                    session.runs ??
                    0
                ),

                completedRuns,
                wins,
                losses,
                winRate,
                netProfit,
                profit: netProfit,
                totalProfit: netProfit,

                stake: Number(session.stake || 0),
                duration: 1,
                durationUnit: "s",

                takeProfit: Number(session.tp || 0),
                stopLoss: Number(session.sl || 0),
                maxLoss: Number(session.maxLoss || 0),

                activeTradeId: session.activeTradeId || null,
                lastTrade: session.lastTrade || null,
                trades: session.trades || [],
                results: session.results || [],
                stopReason: session.stopReason || null,
                startedAt: session.startedAt || null,
                updatedAt: session.updatedAt || null
            });
        } catch (error) {
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
            const userId = req.user.id;

            const requestedSessionId = String(
                req.query.sessionId || ""
            ).trim() || null;

            const session = getUserAutomationSession(
                userId,
                requestedSessionId
            );

            if (!session) {
                return res.json({
                    success: true,
                    results: []
                });
            }

            return res.json({
                success: true,
                results: session.results || [],

                session: {
                    sessionId: session.sessionId,
                    status: session.status,
                    running: session.running,
                    completedRuns: session.completedRuns,
                    wins: session.wins,
                    losses: session.losses,
                    winRate: session.winRate,
                    netProfit: session.netProfit,
                    profit: session.netProfit,
                    totalProfit: session.netProfit,
                    stopReason: session.stopReason
                }
            });
        } catch (error) {
            console.error(
                "Automation results error:",
                error
            );

            return res.status(500).json({
                success: false,
                message: "Unable to load automation results"
            });
        }
    }
);


// ======================================================
// BUY / SELL MARKET
// ======================================================

const KMF_KES_PER_USD =
    Number(process.env.KMF_KES_PER_USD || 130);


// ======================================================
// GET BUY / SELL MARKET
// ======================================================

app.get(
    "/api/buy-sell/market",
    async (req, res) => {
        try {
            const price = Number(
                buySellMarket.getPrice("KMF-BS")
            );

            const market =
                buySellMarket.getMarket("KMF-BS");

            return res.json({
                success: true,

                market: {
                    symbol: "KMF-BS",
                    price,

                    previousPrice:
                        Number(market?.previousPrice || price),

                    tick: Number(market?.tick || 0)
                }
            });
        } catch (error) {
            console.error(
                "BUY/SELL MARKET ERROR:",
                error
            );

            return res.status(500).json({
                success: false,
                message: "Unable to load Buy/Sell market"
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
                buySellMarket.getCandles("KMF-BS");

            return res.json({
                success: true,
                symbol: "KMF-BS",
                timeframe: "1m",
                candles
            });
        } catch (error) {
            console.error("BUY/SELL CANDLES ERROR:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to load Buy/Sell candles"
            });
        }
    }
);


// ======================================================
// GET USER BUY / SELL TRADES — NEON
// ======================================================

app.get(
    "/api/buy-sell/open",
    authenticateUser,
    async (req, res) => {
        try {
            const result = await db.query(
                `SELECT *
                 FROM buy_sell_trades
                 WHERE user_id = $1
                   AND status = $2
                 ORDER BY created_at DESC`,
                [req.user.id, "open"]
            );

            return res.json({
                success: true,
                trades: result.rows || []
            });
        } catch (error) {
            console.error("BUY/SELL OPEN ERROR:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to load Buy/Sell positions"
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
                .status(result.statusCode || 200)
                .json({
                    success: result.success,
                    message: result.message,
                    trade: result.trade || null
                });
        } catch (error) {
            console.error("BUY/SELL CASH OUT REQUEST ERROR:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to cash out Buy/Sell position"
            });
        }
    }
);


// ======================================================
// GET BUY / SELL POSITION — NEON
// ======================================================

app.get(
    "/api/buy-sell/:id",
    authenticateUser,
    async (req, res) => {
        try {
            const result = await db.query(
                `SELECT *
                 FROM buy_sell_trades
                 WHERE id = $1
                   AND user_id = $2
                 LIMIT 1`,
                [req.params.id, req.user.id]
            );

            const trade = result.rows[0];

            if (!trade) {
                return res.status(404).json({
                    success: false,
                    message: "Buy/Sell position not found."
                });
            }

            return res.json({
                success: true,
                trade
            });
        } catch (error) {
            console.error("BUY/SELL POSITION QUERY ERROR:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to retrieve Buy/Sell position."
            });
        }
    }
);


// ======================================================
// OPEN BUY / SELL TRADE — NEON
// ======================================================

app.post(
    "/api/buy-sell/open",
    authenticateUser,
    async (req, res) => {
        const client = await db.pool.connect();

        try {
            const side =
                String(req.body.side || "").trim().toLowerCase();

            const stakeKes = Number(req.body.stakeKes);
            const durationSeconds = Number(req.body.durationSeconds);

            const mode =
                String(req.body.mode || "demo").trim().toLowerCase();

            const takeProfitMultiplier =
                Number(req.body.takeProfitMultiplier);

            if (side !== "buy" && side !== "sell") {
                return res.status(400).json({
                    success: false,
                    message: "Side must be BUY or SELL"
                });
            }

            if (!Number.isFinite(stakeKes) || stakeKes < 100) {
                return res.status(400).json({
                    success: false,
                    message: "Minimum Buy/Sell stake is KSh 100"
                });
            }

            const validDurations = [
                5, 10, 30, 60, 120,
                300, 600, 900, 1800, 3600
            ];

            if (!validDurations.includes(durationSeconds)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid Buy/Sell duration"
                });
            }

            if (mode !== "demo" && mode !== "real") {
                return res.status(400).json({
                    success: false,
                    message: "Account mode must be demo or real"
                });
            }

            if (
                ![
                    1.5, 2, 3, 4, 5,
                    6, 7, 8, 9, 10
                ].includes(takeProfitMultiplier)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Take Profit must be between 1.5x and 10x"
                });
            }

            const stakeUsd = Number(
                (stakeKes / KMF_KES_PER_USD).toFixed(6)
            );

            if (!Number.isFinite(stakeUsd) || stakeUsd <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid stake conversion"
                });
            }

            const entryPrice =
                Number(buySellMarket.getPrice("KMF-BS"));

            if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
                return res.status(503).json({
                    success: false,
                    message: "Buy/Sell market price unavailable"
                });
            }

            const balanceField =
                mode === "demo" ? "demo_balance" : "balance";

            const openedAt = new Date();

            const expiresAt = new Date(
                openedAt.getTime() + durationSeconds * 1000
            );

            let trade;

            await client.query("BEGIN");

            const walletResult = await client.query(
                `SELECT *
                 FROM wallets
                 WHERE user_id = $1
                 LIMIT 1
                 FOR UPDATE`,
                [req.user.id]
            );

            const wallet = walletResult.rows[0];

            if (!wallet) {
                throw new Error("WALLET_NOT_FOUND");
            }

            const currentBalance = Number(wallet[balanceField]);

            if (!Number.isFinite(currentBalance)) {
                throw new Error("INVALID_WALLET_BALANCE");
            }

            if (currentBalance < stakeUsd) {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    success: false,
                    message: `Insufficient ${mode} balance`
                });
            }

            const newBalance = Number(
                (currentBalance - stakeUsd).toFixed(6)
            );

            // Reserve the stake using the locked wallet.
            const walletUpdate = await client.query(
                `UPDATE wallets
                 SET ${balanceField} = $1,
                     updated_at = NOW()
                 WHERE id = $2
                   AND user_id = $3
                 RETURNING id`,
                [newBalance, wallet.id, req.user.id]
            );

            if (walletUpdate.rows.length === 0) {
                throw new Error("WALLET_UPDATE_FAILED");
            }

            // Create the trade.
            const tradeResult = await client.query(
                `INSERT INTO buy_sell_trades (
                    user_id,
                    symbol,
                    mode,
                    side,
                    stake_kes,
                    stake_usd,
                    duration_seconds,
                    entry_price,
                    current_price,
                    pnl_kes,
                    take_profit_multiplier,
                    status,
                    opened_at,
                    expires_at
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6, $7,
                    $8, $9, $10, $11, $12, $13, $14
                )
                RETURNING *`,
                [
                    req.user.id,
                    "KMF-BS",
                    mode,
                    side,
                    Number(stakeKes.toFixed(2)),
                    stakeUsd,
                    durationSeconds,
                    entryPrice,
                    entryPrice,
                    0,
                    takeProfitMultiplier,
                    "open",
                    openedAt,
                    expiresAt
                ]
            );

            trade = tradeResult.rows[0];

            // Record the reserved stake.
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
                    req.user.id,
                    wallet.id,
                    "buy_sell_stake",
                    "buy_sell_stake",
                    stakeUsd,
                    "completed",
                    "wallet",
                    `BS-STAKE-${trade.id}`,
                    trade.id,
                    `Buy/Sell ${side.toUpperCase()} stake reserved`,
                    currentBalance,
                    newBalance
                ]
            );

            await client.query("COMMIT");

            console.log("BUY/SELL TRADE OPENED", {
                tradeId: trade.id,
                userId: req.user.id,
                mode,
                side,
                stakeKes,
                stakeUsd,
                entryPrice,
                durationSeconds,
                expiresAt: expiresAt.toISOString(),
                takeProfitMultiplier
            });

            return res.status(201).json({
                success: true,
                message: `${side.toUpperCase()} position opened`,
                trade
            });

        } catch (error) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                console.error(
                    "BUY/SELL ROLLBACK ERROR:",
                    rollbackError.message
                );
            }

            console.error("BUY/SELL OPEN ERROR:", error);

            if (error.message === "WALLET_NOT_FOUND") {
                return res.status(404).json({
                    success: false,
                    message: "Wallet not found"
                });
            }

            if (error.message === "INVALID_WALLET_BALANCE") {
                return res.status(500).json({
                    success: false,
                    message: "Invalid wallet balance"
                });
            }

            if (error.message === "WALLET_UPDATE_FAILED") {
                return res.status(409).json({
                    success: false,
                    message: "Unable to reserve stake. Please try again."
                });
            }

            return res.status(500).json({
                success: false,
                message: "Unable to open Buy/Sell position"
            });

        } finally {
            client.release();
        }
    }
);


// ==========================================
// SETTLEMENT WORKER — PREVENT OVERLAPPING RUNS
// ==========================================

function createSettlementWorker(workerName, task) {
    let isRunning = false;

    return async function () {
        if (isRunning) return;

        isRunning = true;

        try {
            await task();
        } catch (error) {
            console.error(workerName + " ERROR:", error);
        } finally {
            isRunning = false;
        }
    };
}


// ==========================================
// REGULAR TRADE SETTLEMENT WORKERS
// ==========================================

const runExpiredTradeSettlement =
    createSettlementWorker(
        "EXPIRED TRADE SETTLEMENT WORKER",
        settleExpiredTrades
    );

const runTickTradeSettlement =
    createSettlementWorker(
        "TICK TRADE SETTLEMENT WORKER",
        settleTickTrades
    );

const runTouchTradeMonitor =
    createSettlementWorker(
        "TOUCH TRADE MONITOR",
        monitorTouchTrades
    );

const runAccumulatorMonitor =
    createSettlementWorker(
        "ACCUMULATOR MONITOR",
        monitorActiveAccumulators
    );

setInterval(runExpiredTradeSettlement, 1000);
setInterval(runTickTradeSettlement, 250);
setInterval(runTouchTradeMonitor, 250);
setInterval(runAccumulatorMonitor, 250);


// ==========================================
// BUY / SELL SETTLEMENT WORKER
// ==========================================

const runBuySellSettlement =
    createSettlementWorker(
        "BUY/SELL SETTLEMENT WORKER",
        () => buySellSettlement.settleBuySellTrades()
    );

setInterval(runBuySellSettlement, 1000);


// ==========================================
// CUSTOMER CARE AUTO REPLY
// ==========================================

function getCustomerCareAutoReply(message) {
    const text = String(message || "").trim().toLowerCase();

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

    if (text.includes("deposit")) {
        return {
            reply:
                "I'm sorry you're having trouble with your deposit. Please tell us what happened: M-Pesa deposit, card deposit, bank deposit, deposit deducted but balance not updated, or another deposit issue."
        };
    }

    if (text.includes("withdraw")) {
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

    if (text.includes("trade")) {
        return {
            reply:
                "📊 We can help with your trade. Please tell us whether the trade won't execute, the result looks incorrect, your balance was deducted, the trade is still pending, or you have another trading issue."
        };
    }

    if (text.includes("payment")) {
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

    if (text.includes("automation")) {
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
// GET OR CREATE CUSTOMER CONVERSATION — NEON
// ==========================================

app.get(
    "/api/support/conversation",
    authenticateUser,
    async (req, res) => {
        try {
            const userId = req.user.id;

            const conversationResult = await db.query(
                `SELECT *
                 FROM support_conversations
                 WHERE user_id = $1
                   AND status = $2
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [userId, "open"]
            );

            let conversation = conversationResult.rows[0] || null;

            if (!conversation) {
                const result = await db.query(
                    `INSERT INTO support_conversations (user_id, status)
                     VALUES ($1, $2)
                     RETURNING *`,
                    [userId, "open"]
                );

                conversation = result.rows[0];
            }

            return res.json({
                success: true,
                conversation
            });
        } catch (error) {
            console.error("CUSTOMER CARE CONVERSATION ERROR:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to load customer care."
            });
        }
    }
);


// ==========================================
// GET CUSTOMER CARE MESSAGES — NEON
// ==========================================

app.get(
    "/api/support/messages",
    authenticateUser,
    async (req, res) => {
        try {
            const conversationResult = await db.query(
                `SELECT id
                 FROM support_conversations
                 WHERE user_id = $1
                   AND status = $2
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [req.user.id, "open"]
            );

            const conversation = conversationResult.rows[0] || null;

            if (!conversation) {
                return res.json({
                    success: true,
                    messages: []
                });
            }

            const messagesResult = await db.query(
                `SELECT *
                 FROM support_messages
                 WHERE conversation_id = $1
                 ORDER BY created_at ASC`,
                [conversation.id]
            );

            return res.json({
                success: true,
                messages: messagesResult.rows || []
            });
        } catch (error) {
            console.error("CUSTOMER CARE MESSAGES ERROR:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to load messages."
            });
        }
    }
);


// ==========================================
// SEND CUSTOMER CARE MESSAGE — NEON
// ==========================================

app.post(
    "/api/support/messages",
    authenticateUser,
    async (req, res) => {
        try {
            const userId = req.user.id;
            const message = String(req.body.message || "").trim();

            if (!message) {
                return res.status(400).json({
                    success: false,
                    message: "Message cannot be empty."
                });
            }

            if (message.length > 2000) {
                return res.status(400).json({
                    success: false,
                    message: "Message is too long."
                });
            }

            const conversationResult = await db.query(
                `SELECT *
                 FROM support_conversations
                 WHERE user_id = $1
                   AND status = $2
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [userId, "open"]
            );

            let conversation = conversationResult.rows[0] || null;

            if (!conversation) {
                const result = await db.query(
                    `INSERT INTO support_conversations (user_id, status)
                     VALUES ($1, $2)
                     RETURNING *`,
                    [userId, "open"]
                );

                conversation = result.rows[0];
            }

            const messageResult = await db.query(
                `INSERT INTO support_messages (
                    conversation_id,
                    sender_id,
                    sender_type,
                    message
                )
                VALUES ($1, $2, $3, $4)
                RETURNING *`,
                [conversation.id, userId, "customer", message]
            );

            const newMessage = messageResult.rows[0];

            const autoReply = getCustomerCareAutoReply(message);

            if (autoReply && autoReply.reply) {
                try {
                    await db.query(
                        `INSERT INTO support_messages (
                            conversation_id,
                            sender_id,
                            sender_type,
                            message
                        )
                        VALUES ($1, $2, $3, $4)`,
                        [
                            conversation.id,
                            userId,
                            "support",
                            autoReply.reply
                        ]
                    );
                } catch (autoReplyError) {
                    console.error(
                        "CUSTOMER CARE AUTO REPLY ERROR:",
                        autoReplyError
                    );
                }
            }

            await db.query(
                `UPDATE support_conversations
                 SET updated_at = NOW()
                 WHERE id = $1`,
                [conversation.id]
            );

            return res.json({
                success: true,
                message: newMessage
            });
        } catch (error) {
            console.error("CUSTOMER CARE SEND ERROR:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to send message."
            });
        }
    }
);



// ======================================================
// REFERRAL API — NEON DATABASE
// ======================================================

async function ensureReferralProfile(userId) {
    const lookupResult = await db.query(
        `SELECT user_id, referral_code
         FROM referral_profiles
         WHERE user_id = $1
         LIMIT 1`,
        [userId]
    );

    if (lookupResult.rows[0]) {
        return lookupResult.rows[0];
    }

    for (let attempt = 0; attempt < 5; attempt++) {
        const referralCode =
            "KMF" +
            crypto.randomBytes(5).toString("hex").toUpperCase();

        try {
            const insertResult = await db.query(
                `INSERT INTO referral_profiles (user_id, referral_code)
                 VALUES ($1, $2)
                 RETURNING user_id, referral_code`,
                [userId, referralCode]
            );

            if (insertResult.rows[0]) {
                return insertResult.rows[0];
            }
        } catch (error) {
            const retryResult = await db.query(
                `SELECT user_id, referral_code
                 FROM referral_profiles
                 WHERE user_id = $1
                 LIMIT 1`,
                [userId]
            );

            if (retryResult.rows[0]) {
                return retryResult.rows[0];
            }

            if (
                error.code !== "23505" ||
                !String(error.constraint || "")
                    .toLowerCase()
                    .includes("referral_code")
            ) {
                throw error;
            }
        }
    }

    throw new Error("Unable to generate a unique referral code");
}


// ==========================================
// GET REFERRAL DASHBOARD — NEON
// ==========================================

app.get(
    "/api/referrals/dashboard",
    authenticateUser,
    async (req, res) => {
        try {
            const userId = req.user.id;
            const referralProfile = await ensureReferralProfile(userId);

            const [
                referralsResult,
                commissionsResult,
                promotionsResult
            ] = await Promise.all([
                db.query(
                    `SELECT id, referred_user_id, status,
                            successful_deposit_total,
                            first_deposit_at, created_at
                     FROM referrals
                     WHERE referrer_id = $1
                     ORDER BY created_at DESC`,
                    [userId]
                ),

                db.query(
                    `SELECT referred_user_id, deposit_amount,
                            commission_amount, status, created_at
                     FROM referral_commissions
                     WHERE referrer_id = $1`,
                    [userId]
                ),

                db.query(
                    `SELECT id, name, type, bonus_percent,
                            min_deposit, max_bonus, active,
                            start_at, expires_at
                     FROM promotions
                     ORDER BY created_at DESC`
                )
            ]);

            const referrals = referralsResult.rows || [];
            const commissions = commissionsResult.rows || [];
            const promotions = promotionsResult.rows || [];

            const referredIds = [
                ...new Set(referrals.map(item => item.referred_user_id))
            ];

            let profiles = [];

            if (referredIds.length > 0) {
                const profilesResult = await db.query(
                    `SELECT id, username, full_name
                     FROM profiles
                     WHERE id = ANY($1)`,
                    [referredIds]
                );

                profiles = profilesResult.rows || [];
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

                if (userCommissions.some(item => item.status === "paid")) {
                    commissionStatus = "Paid";
                } else if (
                    userCommissions.some(item => item.status === "approved")
                ) {
                    commissionStatus = "Approved";
                } else if (
                    userCommissions.some(item => item.status === "pending")
                ) {
                    commissionStatus = "Pending";
                } else if (
                    userCommissions.some(item => item.status === "rejected")
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
                        String(item.status || "").toLowerCase() === "pending"
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

                return {
                    id: promotion.id,
                    name: promotion.name,
                    type: promotion.type,
                    bonusPercent: Number(promotion.bonus_percent || 0),
                    minDeposit: Number(promotion.min_deposit || 0),
                    maxBonus: Number(promotion.max_bonus || 0),
                    active:
                        promotion.active === true &&
                        (!startsAt || startsAt <= now) &&
                        (!expiresAt || expiresAt >= now),
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


/* ==========================================
   APPLY REFERRAL CODE ONCE PER ACCOUNT — NEON
========================================== */

app.post(
    "/api/referrals/apply",
    authenticateUser,
    async (req, res) => {
        try {
            const userId = req.user.id;

            const referralCode = String(
                req.body?.referralCode || ""
            ).trim().toUpperCase();

            if (!referralCode || referralCode.length > 40) {
                return res.status(400).json({
                    success: false,
                    message: "Enter a valid referral code."
                });
            }

            const ownerResult = await db.query(
                `SELECT user_id, referral_code
                 FROM referral_profiles
                 WHERE referral_code = $1
                 LIMIT 1`,
                [referralCode]
            );

            const owner = ownerResult.rows[0] || null;

            if (!owner) {
                return res.status(404).json({
                    success: false,
                    message: "Referral code not found."
                });
            }

            if (String(owner.user_id) === String(userId)) {
                return res.status(400).json({
                    success: false,
                    message: "You cannot use your own referral code."
                });
            }

            const existingResult = await db.query(
                `SELECT id
                 FROM referrals
                 WHERE referred_user_id = $1
                 LIMIT 1`,
                [userId]
            );

            if (existingResult.rows.length > 0) {
                return res.status(409).json({
                    success: false,
                    message:
                        "A referral code has already been applied to this account."
                });
            }

            try {
                await db.query(
                    `INSERT INTO referrals (
                        referrer_id,
                        referred_user_id,
                        status,
                        successful_deposit_total
                    )
                    VALUES ($1, $2, $3, $4)`,
                    [owner.user_id, userId, "registered", 0]
                );
            } catch (insertError) {
                if (insertError.code === "23505") {
                    return res.status(409).json({
                        success: false,
                        message:
                            "A referral code has already been applied to this account."
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


/* ==========================================
   START SERVER
========================================== */

app.listen(PORT, () => {
    console.log("==========================================");
    console.log(`KMFBinary server running on port ${PORT}`);
    console.log("http://localhost:" + PORT);
    console.log("==========================================");
});
