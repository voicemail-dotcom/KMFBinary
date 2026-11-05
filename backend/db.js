
const { Pool } = require("pg");
require("dotenv").config();

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is missing from .env");
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

pool.on("error", (error) => {
    console.error("Unexpected Neon database error:", error.message);
});
async function query(text, params = []) {
    

    try {
        const result = await pool.query(text, params);
        return result;
    } catch (error) {
       

        throw error;
    }
}
module.exports = {
    pool,
    query
};
