require("dotenv").config();

const { Pool } = require("pg");

const isRenderDatabase = Boolean(process.env.DATABASE_URL);

const poolConfig = {
    // Gói miễn phí: ít kết nối là đủ, tránh làm Supabase pooler quá tải
    max: 5,

    // Đóng kết nối nhàn rỗi sớm (trước khi pooler Supabase tự cắt), tránh
    // giữ lại "kết nối chết" gây lỗi "Connection terminated" ở lần dùng sau
    idleTimeoutMillis: 10000,

    // Từ Singapore sang Sydney + bắt tay SSL có thể chậm lúc đầu
    connectionTimeoutMillis: 20000,

    // Giữ socket TCP sống, phát hiện sớm kết nối đã đứt
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Lỗi xảy ra ở bước MỞ kết nối (câu lệnh chưa hề được gửi đi) nên thử lại
// là an toàn, kể cả với INSERT/UPDATE.
function isConnectPhaseError(err) {
    const message = String((err && err.message) || "");

    return (
        message.includes("Connection terminated due to connection timeout") ||
        message.includes("timeout exceeded when trying to connect")
    );
}

async function query(text, params = []) {
    let lastError;

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            return await pool.query(text, params);
        } catch (err) {
            lastError = err;

            if (!isConnectPhaseError(err) || attempt === 3) throw err;

            console.warn(
                `Chưa kết nối được database (lần ${attempt}/3), thử lại...`
            );

            await sleep(500 * attempt);
        }
    }

    throw lastError;
}

// Kiểm tra kết nối lúc khởi động: thử lại vài lần trước khi bỏ cuộc
async function testConnection(retries = 5, delayMs = 3000) {
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const result = await pool.query("SELECT NOW() AS server_time");

            console.log(
                "PostgreSQL connected:",
                result.rows[0].server_time
            );

            return;
        } catch (err) {
            lastError = err;

            console.warn(
                `Kết nối database thất bại (lần ${attempt}/${retries}): ${err.message}`
            );

            if (attempt < retries) await sleep(delayMs);
        }
    }

    throw lastError;
}

module.exports = {
    pool,
    query,
    testConnection
};