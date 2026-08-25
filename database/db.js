const mysql = require("mysql2/promise");
const crypto = require("crypto");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({
  path: path.resolve(__dirname, "..", ".env"),
});

const dbName =
  (process.env.DB_NAME || "rubavu_today").trim();

let pool = null;

function getConnectionConfig() {
  const host =
    (process.env.DB_HOST || "127.0.0.1").trim();

  const port =
    Number(
      String(process.env.DB_PORT || "3306").trim()
    );

  const user =
    (process.env.DB_USER || "root").trim();

  // Do NOT trim the password automatically.
  // Passwords can legitimately contain spaces.
  const password =
    process.env.DB_PASSWORD || "";

  return {
    host,
    port,
    user,
    password,

    connectTimeout: 10000,

    multipleStatements: false,
  };
}

function hashPassword(password) {
  if (!password) {
    throw new Error(
      "Password is required."
    );
  }

  const salt =
    crypto.randomBytes(16).toString("hex");

  const hash = crypto
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

function verifyPassword(
  password,
  storedPassword
) {
  if (!password || !storedPassword) {
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

  const candidateHash = crypto
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
  } catch (error) {
    return false;
  }
}

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

async function init() {
  if (pool) {
    return pool;
  }

  const connectionConfig =
    getConnectionConfig();

  console.log(
    `[database] Connecting to ${connectionConfig.host}:${connectionConfig.port}`
  );

  const connection =
    await mysql.createConnection(
      connectionConfig
    );

  try {
    await connection.query(
      `
      CREATE DATABASE IF NOT EXISTS \`${dbName}\`
      CHARACTER SET utf8mb4
      COLLATE utf8mb4_unicode_ci
      `
    );

    console.log(
      `[database] Database "${dbName}" is ready.`
    );
  } finally {
    await connection.end();
  }

  pool = mysql.createPool({
    ...connectionConfig,

    database: dbName,

    waitForConnections: true,

    connectionLimit: 10,

    queueLimit: 0,

    charset: "utf8mb4",
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id INT AUTO_INCREMENT PRIMARY KEY,

      title VARCHAR(255) NOT NULL,

      category VARCHAR(100) NOT NULL,

      description TEXT NOT NULL,

      image VARCHAR(500) DEFAULT NULL,

      createdDate DATETIME
        NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      youtube_url VARCHAR(500)
        DEFAULT NULL,

      Author VARCHAR(150)
        DEFAULT NULL,

      status VARCHAR(20)
        NOT NULL
        DEFAULT 'pending',

      approved_by VARCHAR(150)
        DEFAULT NULL,

      approved_at DATETIME
        DEFAULT NULL,

      rejection_reason TEXT
        DEFAULT NULL
    )
  `);

  console.log(
    "[database] posts table ready."
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id INT AUTO_INCREMENT PRIMARY KEY,

      full_name VARCHAR(100) NOT NULL,

      email VARCHAR(150) NOT NULL UNIQUE,

      phone VARCHAR(20) DEFAULT NULL,

      password VARCHAR(255) NOT NULL,

      authToken VARCHAR(128)
        DEFAULT NULL,

      resetToken VARCHAR(128)
        DEFAULT NULL,

      resetExpires DATETIME
        DEFAULT NULL,

      created_at TIMESTAMP
        DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log(
    "[database] admins table ready."
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chief_editors (
      id INT AUTO_INCREMENT PRIMARY KEY,

      full_name VARCHAR(100) NOT NULL,

      email VARCHAR(150) NOT NULL UNIQUE,

      phone VARCHAR(20) DEFAULT NULL,

      password VARCHAR(255) NOT NULL,

      status VARCHAR(20)
        DEFAULT 'active',

      authToken VARCHAR(128)
        DEFAULT NULL,

      resetToken VARCHAR(128)
        DEFAULT NULL,

      resetExpires DATETIME
        DEFAULT NULL,

      created_at TIMESTAMP
        DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log(
    "[database] chief_editors table ready."
  );

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id INT AUTO_INCREMENT PRIMARY KEY,

      full_name VARCHAR(100) NOT NULL,

      email VARCHAR(150) NOT NULL UNIQUE,

      phone VARCHAR(20) DEFAULT NULL,

      password VARCHAR(255) NOT NULL,

      role VARCHAR(100)
        DEFAULT 'reporter',

      status VARCHAR(20)
        DEFAULT 'active',

      authToken VARCHAR(128)
        DEFAULT NULL,

      resetToken VARCHAR(128)
        DEFAULT NULL,

      resetExpires DATETIME
        DEFAULT NULL,

      created_at TIMESTAMP
        DEFAULT CURRENT_TIMESTAMP
    )
  `);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id INT AUTO_INCREMENT PRIMARY KEY,

      post_id INT NOT NULL,

      name VARCHAR(100) NOT NULL,

      comment TEXT NOT NULL,

      parent_id INT DEFAULT NULL,

      likes INT DEFAULT 0,

      dislikes INT DEFAULT 0,

      status VARCHAR(20)
        DEFAULT 'pending',

      created_at TIMESTAMP
        DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT fk_comments_post
      FOREIGN KEY (post_id)
      REFERENCES posts(id)
      ON DELETE CASCADE
    )
  `);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS advertisements (
      id INT AUTO_INCREMENT PRIMARY KEY,

      title VARCHAR(255) NOT NULL,

      image VARCHAR(500)
        DEFAULT NULL,

      link VARCHAR(500)
        DEFAULT NULL,

      position VARCHAR(50)
        DEFAULT 'sidebar',

      start_date DATE
        DEFAULT NULL,

      end_date DATE
        DEFAULT NULL,

      status VARCHAR(20)
        DEFAULT 'active',

      created_at TIMESTAMP
        DEFAULT CURRENT_TIMESTAMP,

      description TEXT
        DEFAULT NULL,

      target_url VARCHAR(500)
        DEFAULT NULL
    )
  `);

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

  await ensureDefaultAdmin();

  await ensureDefaultChiefEditor();

  console.log(
    "[database] Database initialization completed successfully."
  );

  return pool;
}

function getPool() {
  if (!pool) {
    throw new Error(
      "Database pool is not initialized. Call init() first."
    );
  }

  return pool;
}

module.exports = {
  init,
  getPool,
  hashPassword,
  verifyPassword,
};
