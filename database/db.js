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
   READ AIVEN CA CERTIFICATE
========================================================= */

function getCaCertificate() {
  let ca = process.env.DB_SSL_CA || "";

  if (!ca) {
    return null;
  }

  // Remove accidental surrounding quotes first
  ca = String(ca).trim();

  if (
    (ca.startsWith('"') && ca.endsWith('"')) ||
    (ca.startsWith("'") && ca.endsWith("'"))
  ) {
    ca = ca.slice(1, -1).trim();
  }

  // Convert escaped newlines into real newlines
  ca = ca.replace(/\\n/g, "\n");

  /*
   * Some environments may provide the certificate URL encoded.
   * Decode only if it actually looks URL encoded.
   */
  if (
    ca.includes("%0A") ||
    ca.includes("%2B") ||
    ca.includes("%2F") ||
    ca.includes("%3D") ||
    ca.includes("%20")
  ) {
    try {
      ca = decodeURIComponent(ca);
    } catch (error) {
      console.warn(
        "[database] Could not URL-decode DB_SSL_CA."
      );
    }
  }

  ca = ca.trim();

  // Validate certificate format
  if (
    !ca.includes("-----BEGIN CERTIFICATE-----") ||
    !ca.includes("-----END CERTIFICATE-----")
  ) {
    console.warn(
      "[database] DB_SSL_CA does not appear to be a valid PEM certificate."
    );
  }

  return ca;
}

/* =========================================================
   DATABASE CONNECTION CONFIG
========================================================= */

function getConnectionConfig() {
  const host = String(
    process.env.DB_HOST || "127.0.0.1"
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
   * IMPORTANT:
   * Never trim the database password.
   */
  const password =
    process.env.DB_PASSWORD || "";

  if (
    !Number.isInteger(port) ||
    port <= 0 ||
    port > 65535
  ) {
    throw new Error(
      `Invalid DB_PORT: ${process.env.DB_PORT}`
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

    /*
     * Keep mysql2 handshake compatibility conservative.
     */
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  };

  /* =======================================================
     SSL / TLS
  ======================================================= */

  const isProduction =
    process.env.NODE_ENV === "production";

  const sslEnabled =
    isProduction ||
    String(
      process.env.DB_SSL || ""
    ).toLowerCase() === "true";

  const ca = getCaCertificate();

  if (sslEnabled) {
    if (ca) {
      config.ssl = {
        ca: ca,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
      };

      console.log(
        "[database] SSL: enabled with Aiven CA certificate"
      );
    } else {
      /*
       * TLS remains enabled, but certificate verification
       * is disabled if CA was not supplied.
       */
      config.ssl = {
        rejectUnauthorized: false,
        minVersion: "TLSv1.2",
      };

      console.warn(
        "[database] WARNING: SSL enabled but DB_SSL_CA is missing."
      );

      console.warn(
        "[database] Using TLS without CA verification."
      );
    }
  } else {
    console.log(
      "[database] SSL: disabled"
    );
  }

  return config;
}

/* =========================================================
   PASSWORD HASHING
========================================================= */

function hashPassword(password) {
  if (!password) {
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
    !password ||
    !storedPassword
  ) {
    return false;
  }

  if (
    !String(storedPassword).includes("$")
  ) {
    return false;
  }

  const parts =
    String(storedPassword).split("$");

  if (parts.length !== 2) {
    return false;
  }

  const salt = parts[0];
  const storedHash = parts[1];

  if (!salt || !storedHash) {
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
    return crypto.timingSafeEqual(
      Buffer.from(
        candidateHash,
        "hex"
      ),
      Buffer.from(
        storedHash,
        "hex"
      )
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
   GET COLUMN TYPE
========================================================= */

async function getColumnType(
  table,
  column
) {
  const [rows] =
    await pool.query(
      `
      SELECT DATA_TYPE
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

  return rows.length
    ? rows[0].DATA_TYPE
    : null;
}

/* =========================================================
   TABLE EXISTS
========================================================= */

async function tableExists(
  table
) {
  const [rows] =
    await pool.query(
      `
      SELECT TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
      `,
      [
        dbName,
        table,
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

    if (rows.length) {
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

    if (rows.length) {
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

  const connectionConfig =
    getConnectionConfig();

  console.log(
    `[database] Connecting to ${connectionConfig.host}:${connectionConfig.port}`
  );

  console.log(
    `[database] Database: ${dbName}`
  );

  console.log(
    `[database] User: ${connectionConfig.user}`
  );

  pool = mysql.createPool(
    connectionConfig
  );

  /* =======================================================
     TEST DATABASE CONNECTION
  ======================================================= */

  try {
    const connection =
      await pool.getConnection();

    try {
      await connection.query(
        "SELECT 1 AS connection_test"
      );

      console.log(
        `[database] Successfully connected to "${dbName}".`
      );

      if (connectionConfig.ssl) {
        try {
          const [sslRows] =
            await connection.query(`
              SHOW STATUS LIKE 'Ssl_cipher'
            `);

          console.log(
            "[database] TLS status:",
            sslRows
          );
        } catch (sslError) {
          console.warn(
            "[database] Could not read TLS status:",
            sslError.message
          );
        }
      }
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error(
      "[database] Connection failed:"
    );

    console.error(
      "Code:",
      error.code
    );

    console.error(
      "Message:",
      error.message
    );

    console.error(
      "Host:",
      connectionConfig.host
    );

    console.error(
      "Port:",
      connectionConfig.port
    );

    console.error(
      "Database:",
      dbName
    );

    console.error(
      "SSL:",
      connectionConfig.ssl
        ? "enabled"
        : "disabled"
    );

    try {
      await pool.end();
    } catch {}

    pool = null;

    throw error;
  }

  /* =======================================================
     POSTS TABLE
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
     ADMINS TABLE
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
     CHIEF EDITORS TABLE
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
     CHIEF EDITOR RESET TOKEN
  ======================================================= */

  if (
    !(await columnExists(
      "chief_editors",
      "resetToken"
    ))
  ) {
    await safeAlter(
      "chief_editors.resetToken",
      `
      ALTER TABLE chief_editors
      ADD COLUMN resetToken VARCHAR(128)
      DEFAULT NULL
      `
    );
  }

  /* =======================================================
     CHIEF EDITOR RESET EXPIRATION
  ======================================================= */

  if (
    !(await columnExists(
      "chief_editors",
      "resetExpires"
    ))
  ) {
    await safeAlter(
      "chief_editors.resetExpires",
      `
      ALTER TABLE chief_editors
      ADD COLUMN resetExpires DATETIME
      DEFAULT NULL
      `
    );
  }

  /* =======================================================
     EMPLOYEES TABLE
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

  /* =======================================================
     EMPLOYEE ROLE
  ======================================================= */

  if (
    !(await columnExists(
      "employees",
      "role"
    ))
  ) {
    await safeAlter(
      "employees.role",
      `
      ALTER TABLE employees
      ADD COLUMN role VARCHAR(100)
      DEFAULT 'reporter'
      AFTER password
      `
    );
  }

  /* =======================================================
     EMPLOYEE STATUS
  ======================================================= */

  if (
    !(await columnExists(
      "employees",
      "status"
    ))
  ) {
    await safeAlter(
      "employees.status",
      `
      ALTER TABLE employees
      ADD COLUMN status VARCHAR(20)
      DEFAULT 'active'
      `
    );
  }

  /* =======================================================
     EMPLOYEE AUTH TOKEN
  ======================================================= */

  if (
    !(await columnExists(
      "employees",
      "authToken"
    ))
  ) {
    await safeAlter(
      "employees.authToken",
      `
      ALTER TABLE employees
      ADD COLUMN authToken VARCHAR(128)
      DEFAULT NULL
      `
    );
  }

  /* =======================================================
     EMPLOYEE RESET TOKEN
  ======================================================= */

  if (
    !(await columnExists(
      "employees",
      "resetToken"
    ))
  ) {
    await safeAlter(
      "employees.resetToken",
      `
      ALTER TABLE employees
      ADD COLUMN resetToken VARCHAR(128)
      DEFAULT NULL
      `
    );
  }

  /* =======================================================
     EMPLOYEE RESET EXPIRATION
  ======================================================= */

  if (
    !(await columnExists(
      "employees",
      "resetExpires"
    ))
  ) {
    await safeAlter(
      "employees.resetExpires",
      `
      ALTER TABLE employees
      ADD COLUMN resetExpires DATETIME
      DEFAULT NULL
      `
    );
  }

  /* =======================================================
     NORMALIZE EMPLOYEE ROLES
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
      "[migration] Could not normalize employee roles:",
      error.message
    );
  }

  console.log(
    "[database] employees table ready."
  );

  /* =======================================================
     COMMENTS TABLE
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

  /* =======================================================
     COMMENTS PARENT ID
  ======================================================= */

  if (
    !(await columnExists(
      "comments",
      "parent_id"
    ))
  ) {
    await safeAlter(
      "comments.parent_id",
      `
      ALTER TABLE comments
      ADD COLUMN parent_id INT
      DEFAULT NULL
      `
    );
  }

  /* =======================================================
     COMMENTS LIKES
  ======================================================= */

  if (
    !(await columnExists(
      "comments",
      "likes"
    ))
  ) {
    await safeAlter(
      "comments.likes",
      `
      ALTER TABLE comments
      ADD COLUMN likes INT
      DEFAULT 0
      `
    );
  }

  /* =======================================================
     COMMENTS DISLIKES
  ======================================================= */

  if (
    !(await columnExists(
      "comments",
      "dislikes"
    ))
  ) {
    await safeAlter(
      "comments.dislikes",
      `
      ALTER TABLE comments
      ADD COLUMN dislikes INT
      DEFAULT 0
      `
    );
  }

  /* =======================================================
     COMMENTS STATUS
  ======================================================= */

  if (
    !(await columnExists(
      "comments",
      "status"
    ))
  ) {
    await safeAlter(
      "comments.status",
      `
      ALTER TABLE comments
      ADD COLUMN status VARCHAR(20)
      DEFAULT 'pending'
      `
    );
  }

  console.log(
    "[database] comments table ready."
  );

  /* =======================================================
     ADVERTISEMENTS TABLE
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

  console.log(
    "[database] advertisements table ready."
  );

  /* =======================================================
     POSTS CREATED DATE
  ======================================================= */

  if (
    !(await columnExists(
      "posts",
      "createdDate"
    ))
  ) {
    await safeAlter(
      "posts.createdDate",
      `
      ALTER TABLE posts
      ADD COLUMN createdDate DATETIME
      NOT NULL
      DEFAULT CURRENT_TIMESTAMP
      `
    );
  }

  /* =======================================================
     POSTS YOUTUBE URL
  ======================================================= */

  if (
    !(await columnExists(
      "posts",
      "youtube_url"
    ))
  ) {
    await safeAlter(
      "posts.youtube_url",
      `
      ALTER TABLE posts
      ADD COLUMN youtube_url VARCHAR(500)
      DEFAULT NULL
      `
    );
  }

  /* =======================================================
     POSTS AUTHOR
  ======================================================= */

  if (
    !(await columnExists(
      "posts",
      "Author"
    ))
  ) {
    await safeAlter(
      "posts.Author",
      `
      ALTER TABLE posts
      ADD COLUMN Author VARCHAR(150)
      DEFAULT NULL
      `
    );
  }

  /* =======================================================
     POSTS STATUS
  ======================================================= */

  if (
    !(await columnExists(
      "posts",
      "status"
    ))
  ) {
    await safeAlter(
      "posts.status",
      `
      ALTER TABLE posts
      ADD COLUMN status VARCHAR(20)
      NOT NULL
      DEFAULT 'pending'
      AFTER Author
      `
    );
  }

  /* =======================================================
     POSTS APPROVED BY
  ======================================================= */

  if (
    !(await columnExists(
      "posts",
      "approved_by"
    ))
  ) {
    await safeAlter(
      "posts.approved_by",
      `
      ALTER TABLE posts
      ADD COLUMN approved_by VARCHAR(150)
      DEFAULT NULL
      `
    );
  } else {
    const approvedByType =
      await getColumnType(
        "posts",
        "approved_by"
      );

    if (
      approvedByType &&
      approvedByType !== "varchar"
    ) {
      await safeAlter(
        "posts.approved_by (widen to VARCHAR)",
        `
        ALTER TABLE posts
        MODIFY COLUMN approved_by VARCHAR(150)
        DEFAULT NULL
        `
      );
    }
  }

  /* =======================================================
     POSTS APPROVED AT
  ======================================================= */

  if (
    !(await columnExists(
      "posts",
      "approved_at"
    ))
  ) {
    await safeAlter(
      "posts.approved_at",
      `
      ALTER TABLE posts
      ADD COLUMN approved_at DATETIME
      DEFAULT NULL
      `
    );
  }

  /* =======================================================
     POSTS REJECTION REASON
  ======================================================= */

  if (
    !(await columnExists(
      "posts",
      "rejection_reason"
    ))
  ) {
    await safeAlter(
      "posts.rejection_reason",
      `
      ALTER TABLE posts
      ADD COLUMN rejection_reason TEXT
      DEFAULT NULL
      `
    );
  }

  /* =======================================================
     NORMALIZE POST STATUSES
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
      "[migration] Could not normalize post statuses:",
      error.message
    );
  }

  console.log(
    "[database] Post approval fields ready."
  );

  /* =======================================================
     PERFORMANCE INDEXES
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
     INITIALIZATION COMPLETE
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
   EXPORTS
========================================================= */

module.exports = {
  init,
  getPool,
  hashPassword,
  verifyPassword,
};