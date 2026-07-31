const mysql = require('mysql2/promise');
const crypto = require('crypto');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const dbName = process.env.DB_NAME || 'rubavu_today';
let pool;

function getConnectionConfig() {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    connectTimeout: 10000, 
  };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .pbkdf2Sync(password, salt, 100000, 64, 'sha512')
    .toString('hex');

  return `${salt}$${hash}`;
}

function verifyPassword(password, storedPassword) {
  if (!storedPassword || !storedPassword.includes('$')) {
    return false;
  }

  const [salt, hash] = storedPassword.split('$');

  const candidate = crypto
    .pbkdf2Sync(password, salt, 100000, 64, 'sha512')
    .toString('hex');

  return candidate === hash;
}

async function ensureDefaultAdmin() {
  const email = process.env.ADMIN_EMAIL || 'admin@rubavu.today';
  const password = process.env.ADMIN_PASSWORD || 'Admin@123';
  const name = process.env.ADMIN_NAME || 'Admin';
  const phone = process.env.ADMIN_PHONE || '';

  const [rows] = await pool.query(
    'SELECT id FROM admins WHERE email = ? LIMIT 1',
    [email]
  );

  if (rows.length === 0) {
    const hashedPassword = hashPassword(password);

    await pool.execute(
      `INSERT INTO admins
      (full_name, email, phone, password, created_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [name, email, phone, hashedPassword]
    );

    console.log(`Default admin created: ${email}`);
  }
}

async function init() {
  if (pool) return pool;

  const connectionConfig = getConnectionConfig();
  const connection = await mysql.createConnection(connectionConfig);

  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\``
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
    charset: 'utf8mb4',
  });

  // POSTS TABLE
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      category VARCHAR(100) NOT NULL,
      description TEXT NOT NULL,
      image VARCHAR(500),
      createdDate DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ADMINS TABLE
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      full_name VARCHAR(100) NOT NULL,
      email VARCHAR(150) NOT NULL UNIQUE,
      phone VARCHAR(20),
      password VARCHAR(255) NOT NULL,
      authToken VARCHAR(128),
      resetToken VARCHAR(128),
      resetExpires DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // EMPLOYEES TABLE
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id INT AUTO_INCREMENT PRIMARY KEY,
      full_name VARCHAR(100) NOT NULL,
      email VARCHAR(150) NOT NULL UNIQUE,
      phone VARCHAR(20),
      position VARCHAR(100) DEFAULT 'Staff',
      password VARCHAR(255) NOT NULL,
      authToken VARCHAR(128),
      resetToken VARCHAR(128),
      resetExpires DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // COMMENTS TABLE
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      post_id INT NOT NULL,
      name VARCHAR(100) NOT NULL,
      comment TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_comments_post
        FOREIGN KEY (post_id)
        REFERENCES posts(id)
        ON DELETE CASCADE
    )
  `);

  // VERIFY & MIGRATE ADMIN COLUMNS
  const [adminColumns] = await pool.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ?
     AND TABLE_NAME = ?`,
    [dbName, 'admins']
  );
  const adminColumnNames = adminColumns.map((c) => c.COLUMN_NAME.toLowerCase());

  if (!adminColumnNames.includes('authtoken')) {
    await pool.query(`ALTER TABLE admins ADD COLUMN authToken VARCHAR(128)`);
  }
  if (!adminColumnNames.includes('resettoken')) {
    await pool.query(`ALTER TABLE admins ADD COLUMN resetToken VARCHAR(128)`);
  }
  if (!adminColumnNames.includes('resetexpires')) {
    await pool.query(`ALTER TABLE admins ADD COLUMN resetExpires DATETIME`);
  }

  // VERIFY & MIGRATE EMPLOYEE COLUMNS
  const [empColumns] = await pool.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ?
     AND TABLE_NAME = ?`,
    [dbName, 'employees']
  );
  const empColumnNames = empColumns.map((c) => c.COLUMN_NAME.toLowerCase());

  if (!empColumnNames.includes('authtoken')) {
    await pool.query(`ALTER TABLE employees ADD COLUMN authToken VARCHAR(128)`);
  }
  if (!empColumnNames.includes('resettoken')) {
    await pool.query(`ALTER TABLE employees ADD COLUMN resetToken VARCHAR(128)`);
  }
  if (!empColumnNames.includes('resetexpires')) {
    await pool.query(`ALTER TABLE employees ADD COLUMN resetExpires DATETIME`);
  }

  // VERIFY & MIGRATE POST COLUMNS
  const [columns] = await pool.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ?
     AND TABLE_NAME = ?
     AND COLUMN_NAME = ?`,
    [dbName, 'posts', 'createdDate']
  );

  if (columns.length === 0) {
    await pool.query(`
      ALTER TABLE posts
      ADD COLUMN createdDate DATETIME
      NOT NULL DEFAULT CURRENT_TIMESTAMP
      AFTER image
    `);
  }

  await ensureDefaultAdmin();
}

function getPool() {
  if (!pool) {
    throw new Error(
      'Database pool is not initialized. Call init() first.'
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