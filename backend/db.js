require("dotenv").config();

const { Pool } = require("pg");

const isRenderDatabase = Boolean(process.env.DATABASE_URL);

const poolConfig = {
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
};

if (isRenderDatabase) {
    poolConfig.connectionString = process.env.DATABASE_URL;

    poolConfig.ssl = {
        rejectUnauthorized: false
    };
} else {
    poolConfig.host = process.env.DB_HOST;
    poolConfig.port = Number(process.env.DB_PORT || 5432);
    poolConfig.database = process.env.DB_NAME;
    poolConfig.user = process.env.DB_USER;
    poolConfig.password = process.env.DB_PASSWORD;
}

const pool = new Pool(poolConfig);

pool.on("error", (err) => {
    console.error("PostgreSQL error:", err.message);
});

async function query(text, params = []) {
    return pool.query(text, params);
}

async function testConnection() {
    const result = await query("SELECT NOW() AS server_time");

    console.log(
        "PostgreSQL connected:",
        result.rows[0].server_time
    );
}

module.exports = {
    pool,
    query,
    testConnection
};