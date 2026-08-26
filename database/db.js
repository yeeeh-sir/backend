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

/* =========================================================
   DATABASE CONNECTION CONFIG
========================================================= */

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

  const ca =
    getCaCertificate();

  const rejectUnauthorizedValue =
    String(
      process.env.DB_SSL_REJECT_UNAUTHORIZED ?? "true"
    )
      .trim()
      .toLowerCase();

  const allowUnverifiedTls =
    ["0", "false", "no", "off"].includes(
      rejectUnauthorizedValue
    );

  if (
    useVerifiedSsl &&
    ca &&
    !allowUnverifiedTls
  ) {
    config.ssl = {
      ca,
      rejectUnauthorized: true,
    };

    console.log(
      "[database] Remote database detected: SSL enabled with certificate verification using the Aiven CA."
    );

    return config;
  }

  if (ca) {
    config.ssl = {
      ca,
      rejectUnauthorized: false,
    };

    console.warn(
      "[database] Remote database TLS is enabled, but certificate verification is disabled. This usually means the Aiven certificate chain is not trusted by the Node.js runtime (for example, a self-signed CA or incomplete certificate chain). The connection remains encrypted, but verification is intentionally off."
    );

    return config;
  }

  config.ssl = {
    rejectUnauthorized: false,
  };

  console.warn(
    "[database] Remote database TLS is enabled, but no valid DB_SSL_CA was provided. The connection will use encrypted TLS without certificate verification."
  );

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

  let testPool =
    mysql.createPool(
      verifiedConfig
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

    console.warn(
      "[database] Falling back to encrypted TLS without certificate verification..."
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

  testPool =
    mysql.createPool(
      fallbackConfig
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
  try {
    const email =
      process.env.ADMIN_EMAIL ||
      "papainnocent2026@gmail.com";

    const password =
      process.env.ADMIN_PASSWORD ||
      "papainnocent@@2026";

    const name =
      process.env.ADMIN_NAME ||
      "Admin";

    const phone =
      process.env.ADMIN_PHONE ||
      "";

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
        `[admin] Default admin already exists: ${email}`
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
      `[admin] Default admin created: ${email}`
    );
  } catch (error) {
    console.error(
      "[admin] Failed to create default admin:",
      error.message
    );
  }
}

/* =========================================================
   DEFAULT CHIEF EDITOR
========================================================= */

async function ensureDefaultChiefEditor() {
  try {
    const email =
      process.env.CHIEF_EDITOR_EMAIL ||
      "editor@rubavu.today";

    const password =
      process.env.CHIEF_EDITOR_PASSWORD ||
      "Editor@123";

    const name =
      process.env.CHIEF_EDITOR_NAME ||
      "Chief Editor";

    const phone =
      process.env.CHIEF_EDITOR_PHONE ||
      "";

    const [rows] =
      await pool.query(
        `
          SELECT id
          FROM chief_editors
          WHERE email = ?
          LIMIT 1
        `,
        [email]
      );

    if (rows.length > 0) {
      console.log(
        `[chief-editor] Default Chief Editor already exists: ${email}`
      );

      return;
    }

    const hashedPassword =
      hashPassword(password);

    await pool.execute(
      `
        INSERT INTO chief_editors
        (
          full_name,
          email,
          phone,
          password,
          status,
          authToken,
          resetToken,
          resetExpires
        )
        VALUES (?, ?, ?, ?, 'active', NULL, NULL, NULL)
      `,
      [
        name,
        email,
        phone,
        hashedPassword,
      ]
    );

    console.log(
      `[chief-editor] Default Chief Editor created: ${email}`
    );
  } catch (error) {
    console.error(
      "[chief-editor] Failed to create default Chief Editor:",
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
      category VARCHAR(100) NOT NULL,
      description TEXT NOT NULL,
      image VARCHAR(500) DEFAULT NULL,
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
    CREATE TABLE IF NOT EXISTS chief_editors (
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
    CREATE TABLE IF NOT EXISTS employees (
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
    CREATE TABLE IF NOT EXISTS comments (
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
      FOREIGN KEY (post_id)
      REFERENCES posts(id)
      ON DELETE CASCADE
    )
  `);

  console.log(
    "[database] comments table ready."
  );

  /* =======================================================
     ADVERTISEMENTS
  ======================================================= */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS advertisements (
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
     POSTS MIGRATIONS
  ======================================================= */

  const postColumns = [
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
     DEFAULT CHIEF EDITOR
  ======================================================= */

  await ensureDefaultChiefEditor();

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
