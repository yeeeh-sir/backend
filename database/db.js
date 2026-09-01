const mysql = require("mysql2/promise");
const crypto = require("crypto");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

/* =========================================================
   LOAD ENVIRONMENT VARIABLES
========================================================= */

dotenv.config({
  path: path.resolve(__dirname, "..", ".env"),
});

/* =========================================================
   DATABASE NAME
========================================================= */

const dbName = String(
  process.env.DB_NAME || "defaultdb"
).trim();

let pool = null;

/* =========================================================
   NORMALIZE PEM CERTIFICATES
========================================================= */

function normalizePemCertificate(value, sourceLabel = "certificate") {
  if (value === undefined || value === null) {
    return null;
  }

  let cert = String(value).trim();

  if (!cert) {
    return null;
  }

  cert = cert
    .replace(/\uFEFF/g, "")
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  if (
    (cert.startsWith('"') && cert.endsWith('"')) ||
    (cert.startsWith("'") && cert.endsWith("'"))
  ) {
    cert = cert.slice(1, -1).trim();
  }

  try {
    if (
      cert.includes("%0A") ||
      cert.includes("%0D") ||
      cert.includes("%2B") ||
      cert.includes("%3D") ||
      cert.includes("%2F")
    ) {
      cert = decodeURIComponent(cert);
    }
  } catch (error) {
    console.warn(
      `[database] Could not URL-decode ${sourceLabel}.`
    );
  }

  cert = cert
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  if (
    !cert.includes("-----BEGIN CERTIFICATE-----") ||
    !cert.includes("-----END CERTIFICATE-----")
  ) {
    return null;
  }

  return cert;
}

/* =========================================================
   READ AIVEN CA CERTIFICATE
========================================================= */

function getCaCertificate() {
  const caFile =
    process.env.DB_SSL_CA_FILE ||
    "/etc/secrets/aiven-ca.pem";

  /* -------------------------------------------------------
     TRY RENDER SECRET FILE
  ------------------------------------------------------- */

  if (fs.existsSync(caFile)) {
    try {
      const ca = normalizePemCertificate(
        fs.readFileSync(caFile, "utf8"),
        caFile
      );

      if (ca) {
        console.log(
          `[database] Aiven CA loaded from: ${caFile}`
        );

        return ca;
      }

      console.warn(
        `[database] CA file does not contain a valid PEM certificate: ${caFile}`
      );
    } catch (error) {
      console.warn(
        "[database] Failed to read CA file:",
        error.message
      );
    }
  }

  /* -------------------------------------------------------
     FALLBACK TO DB_SSL_CA
  ------------------------------------------------------- */

  const ca = normalizePemCertificate(
    process.env.DB_SSL_CA,
    "DB_SSL_CA"
  );

  if (!ca) {
    if (process.env.DB_SSL_CA) {
      console.warn(
        "[database] DB_SSL_CA is present but is not a valid PEM certificate."
      );
    }

    return null;
  }

  console.log(
    "[database] Aiven CA loaded from DB_SSL_CA environment variable"
  );

  return ca;
}

function isTruthy(value) {
  if (value === undefined || value === null) {
    return false;
  }

  return [
    "1",
    "true",
    "yes",
    "on",
  ].includes(
    String(value)
      .trim()
      .toLowerCase()
  );
}

function isSslEnabledForRemoteDatabase() {
  if (process.env.DB_SSL === undefined) {
    return true;
  }

  return isTruthy(process.env.DB_SSL);
}

/* Production detection: the primary signal is NODE_ENV=production, but it can
   also be overridden explicitly via DB_ENV=production (useful on platforms that
   do not automatically set NODE_ENV). In production we refuse to run with
   unverified TLS, which is what makes certificate verification mandatory. */
function isProduction() {
  const nodeEnv = String(process.env.NODE_ENV || "")
    .trim()
    .toLowerCase();

  const dbEnv = String(process.env.DB_ENV || "")
    .trim()
    .toLowerCase();

  return (
    nodeEnv === "production" ||
    dbEnv === "production"
  );
}

/* Whether the operator explicitly allowed unverified TLS through
   DB_SSL_REJECT_UNAUTHORIZED=0/false. Only honoured outside production. */
function allowUnverifiedTls() {
  const rejectUnauthorized = String(
    process.env.DB_SSL_REJECT_UNAUTHORIZED ?? "true"
  )
    .trim()
    .toLowerCase();

  return ["0", "false", "no", "off"].includes(
    rejectUnauthorized
  );
}

/* Clear, actionable error when verified TLS cannot be configured. */
function missingCaError(message) {
  return new Error(
    "[database] " +
      message +
      "\n" +
      "  To enable verified TLS for the remote database, provide the server's " +
      "CA certificate PEM:\n" +
      "    - DB_SSL_CA_FILE=/path/to/ca-certificate.pem (preferred, reads via fs), or\n" +
      "    - DB_SSL_CA='-----BEGIN CERTIFICATE----- ... -----END CERTIFICATE-----' (inline)\n" +
      "  Both are read from the environment at startup; nothing is hard-coded.\n" +
      "  Do NOT set DB_SSL_REJECT_UNAUTHORIZED=false in production."
  );
}

/* =========================================================
   DATABASE CONNECTION CONFIG
========================================================= */

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTransientRetry(connectionPool) {
  if (!connectionPool || typeof connectionPool !== 'object') {
    return connectionPool;
  }

  const retryableCodes = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'PROTOCOL_CONNECTION_LOST',
    'ER_SERVER_SHUTDOWN',
    'EPIPE',
    'ECONNREFUSED',
    'ERR_SOCKET_CLOSED',
    /* Transient name-resolution / reachability failures. These occur when the
       host resolver briefly cannot resolve the Aiven hostname or the network is
       momentarily down (getaddrinfo ENOTFOUND / EAI_AGAIN). Retrying once gives
       DNS/network a chance to recover instead of failing the query immediately. */
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EADDRNOTAVAIL',
  ]);

  const wrapMethod = (method, methodName) => (...args) => {
    let attempt = 0;

    const execute = async () => {
      try {
        return await method(...args);
      } catch (error) {
        const errorCode = error && error.code;

        if (attempt >= 2 || !retryableCodes.has(errorCode)) {
          throw error;
        }

        attempt += 1;

        console.warn(
          `[database] ${methodName} failed with ${errorCode}. Retrying (${attempt}/2) after ${attempt * 500}ms...`
        );

        await wait(500 * attempt);
        return execute();
      }
    };

    return execute();
  };

  connectionPool.query = wrapMethod(connectionPool.query.bind(connectionPool), 'query');
  connectionPool.execute = wrapMethod(connectionPool.execute.bind(connectionPool), 'execute');

  connectionPool.on('error', (error) => {
    const errorCode = error && error.code;

    if (retryableCodes.has(errorCode)) {
      console.warn(
        `[database] Pool error detected (${errorCode}). Marking pool stale for reconnect.`
      );

      pool = null;
    }
  });

  return connectionPool;
}

function getConnectionConfig(
  useVerifiedSsl = true
) {
  const host = String(
    process.env.DB_HOST || ""
  ).trim();

  const port = Number(
    String(
      process.env.DB_PORT || "3306"
    ).trim()
  );

  const user = String(
    process.env.DB_USER || "root"
  ).trim();

  /*
   * NEVER trim the password.
   */

  const password =
    process.env.DB_PASSWORD || "";

  if (!host) {
    throw new Error(
      "DB_HOST is missing."
    );
  }

  if (
    !Number.isInteger(port) ||
    port <= 0 ||
    port > 65535
  ) {
    throw new Error(
      `Invalid DB_PORT: ${process.env.DB_PORT}`
    );
  }

  if (!user) {
    throw new Error(
      "DB_USER is missing."
    );
  }

  const config = {
    host,
    port,
    user,
    password,
    database: dbName,

    connectTimeout: 30000,

    waitForConnections: true,

    connectionLimit: 10,

    queueLimit: 0,

    multipleStatements: false,

    charset: "utf8mb4",
  };

  /* =======================================================
     LOCAL DATABASE
  ======================================================= */

  const isLocalDatabase =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1";

  if (isLocalDatabase) {
    console.log(
      "[database] Local database detected: SSL disabled to preserve XAMPP/MySQL compatibility"
    );

    return config;
  }

  /* =======================================================
     REMOTE DATABASE
  ======================================================= */

  const sslEnabled =
    isSslEnabledForRemoteDatabase();

  if (!sslEnabled) {
    console.log(
      "[database] Remote database detected: DB_SSL is disabled, so TLS is turned off."
    );

    return config;
  }

  const production =
    isProduction();

  const ca =
    getCaCertificate();

  const allowUnverified =
    allowUnverifiedTls();

  /* -------------------------------------------------------
     VERIFIED TLS WITH CA CERTIFICATE
  ------------------------------------------------------- */
  if (ca && useVerifiedSsl && !allowUnverified) {
    config.ssl = {
      ca,
      rejectUnauthorized: true,
    };

    console.log(
      "[database] Remote database TLS enabled with certificate verification (CA loaded)."
    );

    return config;
  }

  /* -------------------------------------------------------
     CA PRESENT BUT UNVERIFIED EXPLICITLY REQUESTED (DEV ONLY)
  ------------------------------------------------------- */
  if (ca && allowUnverified) {
    if (production) {
      throw missingCaError(
        "DB_SSL_REJECT_UNAUTHORIZED is disabled but the environment is production. " +
          "Refusing to connect without certificate verification. " +
          "Remove DB_SSL_REJECT_UNAUTHORIZED or set it to true in production."
      );
    }

    config.ssl = {
      ca,
      rejectUnauthorized: false,
    };

    console.warn(
      "[database] Remote database TLS enabled, but certificate verification is disabled via DB_SSL_REJECT_UNAUTHORIZED (development only)."
    );

    return config;
  }

  /* -------------------------------------------------------
     NO CA PROVIDED
  ------------------------------------------------------- */
  if (!ca) {
    if (production) {
      throw missingCaError(
        "Remote database TLS is enabled, but no CA certificate (DB_SSL_CA / DB_SSL_CA_FILE) was provided, " +
          "so certificate verification cannot be enabled. Refusing to connect without verified TLS."
      );
    }

    if (!useVerifiedSsl) {
      /* Second pass (dev fallback) or explicit dev override: encrypted without
         verification. Never allowed in production (handled above). */
      config.ssl = {
        rejectUnauthorized: false,
      };

      console.warn(
        "[database] Remote database TLS is enabled, but no CA certificate (DB_SSL_CA / DB_SSL_CA_FILE) was provided. " +
          "Falling back to encrypted TLS WITHOUT certificate verification. Development only — " +
          "configure DB_SSL_CA or DB_SSL_CA_FILE before deploying."
      );

      return config;
    }

    /* First pass with no CA: the caller (createDatabasePool) retries with
       useVerifiedSsl=false for a dev-only fallback. In production that retry
       will throw above. */
    config.ssl = {
      rejectUnauthorized: false,
    };

    console.warn(
      "[database] Remote database TLS is enabled, but no CA certificate (DB_SSL_CA / DB_SSL_CA_FILE) was provided yet. " +
        "Will attempt verified TLS if a CA is configured; otherwise development-only fallback will be used. " +
        "In production this is a hard error."
    );

    return config;
  }

  return config;
}

/* =========================================================
   CREATE DATABASE POOL
========================================================= */

async function createDatabasePool() {
  const verifiedConfig =
    getConnectionConfig(true);

  console.log(
    `[database] Connecting to ${verifiedConfig.host}:${verifiedConfig.port}`
  );

  console.log(
    `[database] Database: ${dbName}`
  );

  console.log(
    `[database] User: ${verifiedConfig.user}`
  );

  console.log(
    `[database] SSL: ${verifiedConfig.ssl
      ? "enabled"
      : "disabled"
    }`
  );

  let testPool = withTransientRetry(
    mysql.createPool(
      verifiedConfig
    )
  );

  /* -------------------------------------------------------
     TEST VERIFIED CONNECTION
  ------------------------------------------------------- */

  try {
    const connection =
      await testPool.getConnection();

    try {
      await connection.query(
        "SELECT 1 AS connection_test"
      );

      console.log(
        "[database] Successfully connected using verified TLS."
      );

      return testPool;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error(
      "[database] Verified SSL connection failed."
    );

    console.error(
      "Code:",
      error.code
    );

    console.error(
      "Message:",
      error.message
    );

    try {
      await testPool.end();
    } catch { }

    /*
     * Only fallback for TLS/certificate errors.
     */

    const sslErrorCodes = [
      "HANDSHAKE_SSL_ERROR",
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ];

    const shouldFallback =
      sslErrorCodes.includes(
        error.code
      );

    if (!shouldFallback) {
      throw error;
    }

    /* In production we never silently downgrade to unverified TLS. The CA may
       be misconfigured or the supplied certificate chain is untrusted — surface
       a clear configuration error instead of connecting insecurely. */
    if (isProduction()) {
      throw missingCaError(
        "Verified TLS connection failed with a certificate/TLS error (" +
          error.code +
          "), but the environment is production. " +
          "Refusing to fall back to unverified TLS. Check that DB_SSL_CA / DB_SSL_CA_FILE " +
          "contains the correct CA certificate chain for the database host."
      );
    }

    console.warn(
      "[database] Falling back to encrypted TLS without certificate verification (development only)..."
    );
  }

  /* -------------------------------------------------------
     FALLBACK TLS CONNECTION
  ------------------------------------------------------- */

  const fallbackConfig =
    getConnectionConfig(false);

  console.log(
    "[database] Creating fallback SSL connection."
  );

  testPool = withTransientRetry(
    mysql.createPool(
      fallbackConfig
    )
  );

  try {
    const connection =
      await testPool.getConnection();

    try {
      await connection.query(
        "SELECT 1 AS connection_test"
      );

      console.log(
        "[database] Successfully connected using fallback TLS."
      );
    } finally {
      connection.release();
    }

    return testPool;
  } catch (error) {
    try {
      await testPool.end();
    } catch { }

    console.error(
      "[database] Fallback SSL connection also failed:"
    );

    console.error(
      "Code:",
      error.code
    );

    console.error(
      "Message:",
      error.message
    );

    throw error;
  }
}

/* =========================================================
   PASSWORD HASHING
========================================================= */

function hashPassword(password) {
  if (
    password === undefined ||
    password === null ||
    String(password).length === 0
  ) {
    throw new Error(
      "Password is required."
    );
  }

  const salt =
    crypto
      .randomBytes(16)
      .toString("hex");

  const hash =
    crypto
      .pbkdf2Sync(
        String(password),
        salt,
        100000,
        64,
        "sha512"
      )
      .toString("hex");

  return `${salt}$${hash}`;
}

/* =========================================================
   PASSWORD VERIFICATION
========================================================= */

function verifyPassword(
  password,
  storedPassword
) {
  if (
    password === undefined ||
    password === null ||
    !storedPassword
  ) {
    return false;
  }

  const stored =
    String(storedPassword);

  if (!stored.includes("$")) {
    return false;
  }

  const parts =
    stored.split("$");

  if (parts.length !== 2) {
    return false;
  }

  const salt =
    parts[0];

  const storedHash =
    parts[1];

  if (
    !salt ||
    !storedHash
  ) {
    return false;
  }

  const candidateHash =
    crypto
      .pbkdf2Sync(
        String(password),
        salt,
        100000,
        64,
        "sha512"
      )
      .toString("hex");

  try {
    const candidateBuffer =
      Buffer.from(
        candidateHash,
        "hex"
      );

    const storedBuffer =
      Buffer.from(
        storedHash,
        "hex"
      );

    if (
      candidateBuffer.length !==
      storedBuffer.length
    ) {
      return false;
    }

    return crypto.timingSafeEqual(
      candidateBuffer,
      storedBuffer
    );
  } catch {
    return false;
  }
}

/* =========================================================
   SAFE ALTER
========================================================= */

async function safeAlter(
  label,
  sql
) {
  try {
    await pool.query(sql);

    console.log(
      `[migration] ${label}: OK`
    );
  } catch (error) {
    console.error(
      `[migration] ${label} FAILED:`,
      error.message
    );
  }
}

/* =========================================================
   COLUMN EXISTS
========================================================= */

async function columnExists(
  table,
  column
) {
  const [rows] =
    await pool.query(
      `
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
      `,
      [
        dbName,
        table,
        column,
      ]
    );

  return rows.length > 0;
}

/* =========================================================
   DEFAULT ADMIN
========================================================= */

async function ensureDefaultAdmin() {
  /* No hard-coded default accounts. An initial admin is only created when the
     operator explicitly supplies ADMIN_EMAIL / ADMIN_PASSWORD in the .env. */
  const email = String(
    process.env.ADMIN_EMAIL || ""
  ).trim();

  const password =
    process.env.ADMIN_PASSWORD || "";

  if (!email || !password) {
    console.log(
      "[admin] Skipping default admin creation: no ADMIN_EMAIL / ADMIN_PASSWORD configured."
    );

    return;
  }

  const name =
    process.env.ADMIN_NAME ||
    "Admin";

  const phone =
    process.env.ADMIN_PHONE ||
    "";

  try {
    const [rows] =
      await pool.query(
        `
          SELECT id
          FROM admins
          WHERE email = ?
          LIMIT 1
        `,
        [email]
      );

    if (rows.length > 0) {
      console.log(
        `[admin] Initial admin already exists: ${email}`
      );

      return;
    }

    const hashedPassword =
      hashPassword(password);

    await pool.execute(
      `
        INSERT INTO admins
        (
          full_name,
          email,
          phone,
          password,
          authToken,
          resetToken,
          resetExpires
        )
        VALUES (?, ?, ?, ?, NULL, NULL, NULL)
      `,
      [
        name,
        email,
        phone,
        hashedPassword,
      ]
    );

    console.log(
      `[admin] Initial admin created: ${email}`
    );
  } catch (error) {
    console.error(
      "[admin] Failed to create initial admin:",
      error.message
    );
  }
}

/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

async function init() {
  if (pool) {
    return pool;
  }

  console.log(
    "[database] Initializing database..."
  );

  /* -------------------------------------------------------
     CREATE CONNECTION
  ------------------------------------------------------- */

  pool =
    await createDatabasePool();

  /* =======================================================
     POSTS
  ======================================================= */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      slug VARCHAR(500) NULL UNIQUE,
      category VARCHAR(100) NOT NULL,
      description TEXT NOT NULL,
      image VARCHAR(500) DEFAULT NULL,
      images MEDIUMTEXT DEFAULT NULL,
      content_blocks MEDIUMTEXT DEFAULT NULL,
      createdDate DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      youtube_url VARCHAR(500) DEFAULT NULL,
      Author VARCHAR(150) DEFAULT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      approved_by VARCHAR(150) DEFAULT NULL,
      approved_at DATETIME DEFAULT NULL,
      rejection_reason TEXT DEFAULT NULL
    )
  `);

  console.log(
    "[database] posts table ready."
  );

  /* =======================================================
     ADMINS
  ======================================================= */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      full_name VARCHAR(100) NOT NULL,
      email VARCHAR(150) NOT NULL UNIQUE,
      phone VARCHAR(20) DEFAULT NULL,
      password VARCHAR(255) NOT NULL,
      status VARCHAR(20) DEFAULT 'active',
      authToken VARCHAR(128) DEFAULT NULL,
      resetToken VARCHAR(128) DEFAULT NULL,
      resetExpires DATETIME DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log(
    "[database] admins table ready."
  );

  /* =======================================================
     CHIEF EDITORS
  ======================================================= */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chief_editors(
    id INT AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL UNIQUE,
    phone VARCHAR(20) DEFAULT NULL,
    password VARCHAR(255) NOT NULL,
    status VARCHAR(20) DEFAULT 'active',
    authToken VARCHAR(128) DEFAULT NULL,
    resetToken VARCHAR(128) DEFAULT NULL,
    resetExpires DATETIME DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
    `);

  console.log(
    "[database] chief_editors table ready."
  );

  /* =======================================================
     EMPLOYEES
  ======================================================= */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees(
      id INT AUTO_INCREMENT PRIMARY KEY,
      full_name VARCHAR(100) NOT NULL,
      email VARCHAR(150) NOT NULL UNIQUE,
      phone VARCHAR(20) DEFAULT NULL,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(100) DEFAULT 'reporter',
      status VARCHAR(20) DEFAULT 'active',
      authToken VARCHAR(128) DEFAULT NULL,
      resetToken VARCHAR(128) DEFAULT NULL,
      resetExpires DATETIME DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    `);

  console.log(
    "[database] employees table ready."
  );

  /* =======================================================
     COMMENTS
  ======================================================= */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS comments(
      id INT AUTO_INCREMENT PRIMARY KEY,
      post_id INT NOT NULL,
      name VARCHAR(100) NOT NULL,
      comment TEXT NOT NULL,
      parent_id INT DEFAULT NULL,
      likes INT DEFAULT 0,
      dislikes INT DEFAULT 0,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT fk_comments_post
      FOREIGN KEY(post_id)
      REFERENCES posts(id)
      ON DELETE CASCADE
    )
    `);

  console.log(
    "[database] comments table ready."
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS comment_reactions(
      id INT AUTO_INCREMENT PRIMARY KEY,
      comment_id INT NOT NULL,
      device_id VARCHAR(64) NOT NULL,
      reaction ENUM('like','dislike') DEFAULT 'like',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

      UNIQUE KEY uq_comment_device (comment_id, device_id),

      CONSTRAINT fk_reaction_comment
      FOREIGN KEY(comment_id)
      REFERENCES comments(id)
      ON DELETE CASCADE
    )
  `);

  console.log(
    "[database] comment_reactions table ready."
  );

  /* =======================================================
     ADVERTISEMENTS
  ======================================================= */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS advertisements(
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      image VARCHAR(500) DEFAULT NULL,
      link VARCHAR(500) DEFAULT NULL,
      position VARCHAR(50) DEFAULT 'sidebar',
      start_date DATE DEFAULT NULL,
      end_date DATE DEFAULT NULL,
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      description TEXT DEFAULT NULL,
      target_url VARCHAR(500) DEFAULT NULL
    )
    `);

  console.log(
    "[database] advertisements table ready."
  );

  /* =======================================================
     TRANSLATIONS (persistent translation cache)
  ======================================================= */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS translations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      source_hash CHAR(64) NOT NULL,
      source_text MEDIUMTEXT NOT NULL,
      source_lang VARCHAR(10) DEFAULT 'rw',
      target_lang VARCHAR(10) NOT NULL,
      translated_text MEDIUMTEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_translation (source_hash, source_lang, target_lang)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  console.log(
    "[database] translations table ready."
  );

  /* =======================================================
     POSTS MIGRATIONS
  ======================================================= */

  const postColumns = [
    [
      "content_blocks",
      "MEDIUMTEXT DEFAULT NULL",
    ],
    [
      "images",
      "MEDIUMTEXT DEFAULT NULL",
    ],
    [
      "slug",
      "VARCHAR(500) NULL UNIQUE",
    ],
    [
      "createdDate",
      "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP",
    ],
    [
      "youtube_url",
      "VARCHAR(500) DEFAULT NULL",
    ],
    [
      "Author",
      "VARCHAR(150) DEFAULT NULL",
    ],
    [
      "status",
      "VARCHAR(20) NOT NULL DEFAULT 'pending'",
    ],
    [
      "approved_by",
      "VARCHAR(150) DEFAULT NULL",
    ],
    [
      "approved_at",
      "DATETIME DEFAULT NULL",
    ],
    [
      "rejection_reason",
      "TEXT DEFAULT NULL",
    ],
  ];

  for (
    const [
      column,
      definition,
    ] of postColumns
  ) {
    if (
      !(await columnExists(
        "posts",
        column
      ))
    ) {
      await safeAlter(
        `posts.${column}`,
        `
          ALTER TABLE posts
          ADD COLUMN \`${column}\`
          ${definition}
        `
      );
    }
  }

  /* =======================================================
     EMPLOYEE MIGRATIONS
  ======================================================= */

  const adminColumns = [
    [
      "status",
      "VARCHAR(20) DEFAULT 'active'",
    ],
  ];

  for (
    const [
      column,
      definition,
    ] of adminColumns
  ) {
    if (
      !(await columnExists(
        "admins",
        column
      ))
    ) {
      await safeAlter(
        `admins.${column}`,
        `
          ALTER TABLE admins
          ADD COLUMN \`${column}\`
          ${definition}
        `
      );
    }
  }

  /* =======================================================
     EMPLOYEE MIGRATIONS
  ======================================================= */

  const employeeColumns = [
    [
      "role",
      "VARCHAR(100) DEFAULT 'reporter'",
    ],
    [
      "status",
      "VARCHAR(20) DEFAULT 'active'",
    ],
    [
      "authToken",
      "VARCHAR(128) DEFAULT NULL",
    ],
    [
      "resetToken",
      "VARCHAR(128) DEFAULT NULL",
    ],
    [
      "resetExpires",
      "DATETIME DEFAULT NULL",
    ],
  ];

  for (
    const [
      column,
      definition,
    ] of employeeColumns
  ) {
    if (
      !(await columnExists(
        "employees",
        column
      ))
    ) {
      await safeAlter(
        `employees.${column}`,
        `
          ALTER TABLE employees
          ADD COLUMN \`${column}\`
          ${definition}
        `
      );
    }
  }

  /* =======================================================
     CHIEF EDITOR MIGRATIONS
  ======================================================= */

  const chiefEditorColumns = [
    [
      "status",
      "VARCHAR(20) DEFAULT 'active'",
    ],
    [
      "authToken",
      "VARCHAR(128) DEFAULT NULL",
    ],
    [
      "resetToken",
      "VARCHAR(128) DEFAULT NULL",
    ],
    [
      "resetExpires",
      "DATETIME DEFAULT NULL",
    ],
  ];

  for (
    const [
      column,
      definition,
    ] of chiefEditorColumns
  ) {
    if (
      !(await columnExists(
        "chief_editors",
        column
      ))
    ) {
      await safeAlter(
        `chief_editors.${column}`,
        `
          ALTER TABLE chief_editors
          ADD COLUMN \`${column}\`
          ${definition}
        `
      );
    }
  }

  /* =======================================================
     COMMENT MIGRATIONS
  ======================================================= */

  const commentColumns = [
    [
      "parent_id",
      "INT DEFAULT NULL",
    ],
    [
      "likes",
      "INT DEFAULT 0",
    ],
    [
      "dislikes",
      "INT DEFAULT 0",
    ],
    [
      "status",
      "VARCHAR(20) DEFAULT 'pending'",
    ],
  ];

  for (
    const [
      column,
      definition,
    ] of commentColumns
  ) {
    if (
      !(await columnExists(
        "comments",
        column
      ))
    ) {
      await safeAlter(
        `comments.${column}`,
        `
          ALTER TABLE comments
          ADD COLUMN \`${column}\`
          ${definition}
        `
      );
    }
  }

  /* =======================================================
     ADVERTISEMENT MIGRATIONS
  ======================================================= */

  const adColumns = [
    [
      "image",
      "VARCHAR(500) DEFAULT NULL",
    ],
    [
      "link",
      "VARCHAR(500) DEFAULT NULL",
    ],
    [
      "position",
      "VARCHAR(50) DEFAULT 'sidebar'",
    ],
    [
      "start_date",
      "DATE DEFAULT NULL",
    ],
    [
      "end_date",
      "DATE DEFAULT NULL",
    ],
    [
      "status",
      "VARCHAR(20) DEFAULT 'active'",
    ],
    [
      "description",
      "TEXT DEFAULT NULL",
    ],
    [
      "target_url",
      "VARCHAR(500) DEFAULT NULL",
    ],
  ];

  for (
    const [
      column,
      definition,
    ] of adColumns
  ) {
    if (
      !(await columnExists(
        "advertisements",
        column
      ))
    ) {
      await safeAlter(
        `advertisements.${column}`,
        `
          ALTER TABLE advertisements
          ADD COLUMN \`${column}\`
          ${definition}
        `
      );
    }
  }

  /* =======================================================
     NORMALIZE EMPLOYEE DATA
  ======================================================= */

  try {
    await pool.query(`
      UPDATE employees
      SET role = 'reporter'
      WHERE role IS NULL
         OR role = ''
         OR role = 'employee'
         OR role = 'Staff'
    `);
  } catch (error) {
    console.error(
      "[migration] Employee role normalization failed:",
      error.message
    );
  }

  /* =======================================================
     NORMALIZE POST STATUS
  ======================================================= */

  try {
    await pool.query(`
      UPDATE posts
      SET status = 'approved'
      WHERE status IS NULL
         OR status = ''
    `);
  } catch (error) {
    console.error(
      "[migration] Post status normalization failed:",
      error.message
    );
  }

  /* =======================================================
     NORMALIZE POST SLUGS
  ======================================================= */

  try {
    const [postRows] = await pool.query(`
      SELECT id, title, slug
      FROM posts
      ORDER BY id ASC
    `);

    for (const post of postRows) {
      const base = String(post.title || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9\s-]/g, " ")
        .trim()
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

      let slug = base || `post-${post.id}`;
      let candidate = slug;
      let counter = 2;

      while (true) {
        const [existing] = await pool.query(
          `
            SELECT id
            FROM posts
            WHERE slug = ?
              AND id != ?
            LIMIT 1
          `,
          [candidate, post.id]
        );

        if (!existing.length) {
          break;
        }

        candidate = `${slug}-${counter}`;
        counter += 1;
      }

      if (post.slug !== candidate) {
        await pool.query(
          `
            UPDATE posts
            SET slug = ?
            WHERE id = ?
          `,
          [candidate, post.id]
        );
      }
    }

    console.log("[database] Post slugs normalized.");
  } catch (error) {
    console.error(
      "[migration] Post slug normalization failed:",
      error.message
    );
  }

  /* =======================================================
     INDEXES
  ======================================================= */

  const indexes = [
    [
      "idx_posts_status",
      "CREATE INDEX idx_posts_status ON posts(status)",
    ],
    [
      "idx_posts_author",
      "CREATE INDEX idx_posts_author ON posts(Author)",
    ],
    [
      "idx_posts_created",
      "CREATE INDEX idx_posts_created ON posts(createdDate)",
    ],
    [
      "idx_posts_status_created",
      "CREATE INDEX idx_posts_status_created ON posts(status, createdDate)",
    ],
    [
      "idx_comments_post_id",
      "CREATE INDEX idx_comments_post_id ON comments(post_id)",
    ],
    [
      "idx_comments_parent",
      "CREATE INDEX idx_comments_parent ON comments(parent_id)",
    ],
    [
      "idx_auth_token_admins",
      "CREATE INDEX idx_auth_token_admins ON admins(authToken)",
    ],
    [
      "idx_auth_token_chief",
      "CREATE INDEX idx_auth_token_chief ON chief_editors(authToken)",
    ],
    [
      "idx_auth_token_emp",
      "CREATE INDEX idx_auth_token_emp ON employees(authToken)",
    ],
    [
      "idx_ads_status",
      "CREATE INDEX idx_ads_status ON advertisements(status)",
    ],
  ];

  for (
    const [
      indexName,
      sql,
    ] of indexes
  ) {
    try {
      await pool.query(sql);

      console.log(
        `[database] Index ${indexName}: OK`
      );
    } catch (error) {
      if (
        error.code ===
        "ER_DUP_KEYNAME"
      ) {
        console.log(
          `[database] Index ${indexName} already exists.`
        );
      } else {
        console.error(
          `[database] Index ${indexName} FAILED:`,
          error.message
        );
      }
    }
  }

  console.log(
    "[database] Performance indexes ready."
  );

  /* =======================================================
     DEFAULT ADMIN
  ======================================================= */

  await ensureDefaultAdmin();

  /* =======================================================
     COMPLETE
  ======================================================= */

  console.log(
    "[database] Database initialization completed successfully."
  );

  return pool;
}

/* =========================================================
   GET POOL
========================================================= */

function getPool() {
  if (!pool) {
    throw new Error(
      "Database pool is not initialized. Call init() first."
    );
  }

  return pool;
}

/* =========================================================
   CLOSE DATABASE
========================================================= */

async function closePool() {
  if (!pool) {
    return;
  }

  try {
    await pool.end();

    console.log(
      "[database] Database pool closed."
    );
  } catch (error) {
    console.error(
      "[database] Failed to close database pool:",
      error.message
    );
  } finally {
    pool = null;
  }
}

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

async function shutdownDatabase() {
  try {
    await closePool();
  } catch { }
}

process.once(
  "SIGTERM",
  shutdownDatabase
);

process.once(
  "SIGINT",
  shutdownDatabase
);

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  init,
  getPool,
  closePool,
  hashPassword,
  verifyPassword,
};
