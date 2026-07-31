const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '.env') });

async function main() {
  const dbName = process.env.DB_NAME || 'rubavu_today';
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: dbName,
  });

  try {
    const [columns] = await pool.query('SHOW COLUMNS FROM posts');
    console.log('columns:', JSON.stringify(columns, null, 2));
  } catch (err) {
    console.error('error:', err.message);
  } finally {
    await pool.end();
  }
}

main();
