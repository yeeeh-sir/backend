const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { getPool, hashPassword, verifyPassword, init } = require('./database/db');

const app = express();
const port = process.env.PORT || 5000; 

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ================= FILE UPLOAD CONFIG =================

const storage = multer.diskStorage({ 
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'uploads'));
  },
  filename: (req, file, cb) => {
    const fileExt = path.extname(file.originalname); 
    const fileName = `${Date.now()}-${file.fieldname}${fileExt}`;
    cb(null, fileName);
  },
});

const upload = multer({ storage });

// ================= AUTH HELPER & MIDDLEWARE =================

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  try {
    const pool = getPool();
    
    // Check admins table first
    let [rows] = await pool.query('SELECT *, "admin" AS role_type FROM admins WHERE authToken = ? LIMIT 1', [token]);
    
    // If not found in admins, check employees table
    if (!rows.length) {
      [rows] = await pool.query('SELECT *, "employee" AS role_type FROM employees WHERE authToken = ? LIMIT 1', [token]);
    }

    if (!rows.length) {
      return res.status(401).json({ error: 'Invalid token.' });
    }

    req.user = rows[0];
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Auth validation failed.' });
  }
}

// ================= POSTS ROUTES =================

app.get('/api/posts', async (req, res) => {
  try {
    const [rows] = await getPool().query('SELECT * FROM posts ORDER BY id DESC');
    res.json(rows);
  } catch (error) {
    console.error('Fetch posts error:', error);
    res.status(500).json({ error: 'Unable to fetch posts.' });
  }
});

app.get('/api/posts/:id', async (req, res) => {
  try {
    const [rows] = await getPool().query('SELECT * FROM posts WHERE id = ?', [req.params.id]);
    if (!rows.length) {
      return res.status(404).json({ error: 'Post not found.' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error('Fetch post error:', error);
    res.status(500).json({ error: 'Unable to fetch post.' });
  }
});

app.post('/api/posts', requireAuth, upload.single('image'), async (req, res) => {
  try {
    const { title, category, description, youtube_url, author } = req.body;
    if (!title || !category || !description) {
      return res.status(400).json({ error: 'Title, category, and description are required.' });
    }

    const imageUrl = req.file ? `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}` : null;
    const createdDate = new Date();
    
    // Use submitted author name from frontend, otherwise default to authenticated user's name 
    const authorName = (author && author.trim() !== '') ? author.trim() : (req.user.full_name || req.user.email || 'Admin');

    const [result] = await getPool().execute(
      'INSERT INTO posts (title, category, description, image, createdDate, youtube_url, Author) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [title, category, description, imageUrl, createdDate, youtube_url || null, authorName]
    );

    const [rows] = await getPool().query('SELECT * FROM posts WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Save post error:', error);
    res.status(500).json({ error: 'Unable to save post.' });
  }
});

app.put('/api/posts/:id', requireAuth, upload.single('image'), async (req, res) => {
  try {
    const { title, category, description, youtube_url, author } = req.body;
    const { id } = req.params;

    const [existing] = await getPool().query('SELECT * FROM posts WHERE id = ?', [id]);
    if (!existing.length) {
      return res.status(404).json({ error: 'Post not found.' });
    }

    const imageUrl = req.file ? `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}` : existing[0].image;
    const updatedYoutubeUrl = youtube_url !== undefined ? (youtube_url || null) : existing[0].youtube_url;
    const updatedAuthor = (author !== undefined && author.trim() !== '') ? author.trim() : existing[0].Author;

    await getPool().execute(
      'UPDATE posts SET title = ?, category = ?, description = ?, image = ?, youtube_url = ?, Author = ? WHERE id = ?',
      [
        title || existing[0].title,
        category || existing[0].category,
        description || existing[0].description,
        imageUrl,
        updatedYoutubeUrl,
        updatedAuthor,
        id
      ]
    );

    const [rows] = await getPool().query('SELECT * FROM posts WHERE id = ?', [id]);
    res.json(rows[0]);
  } catch (error) {
    console.error('Update post error:', error);
    res.status(500).json({ error: 'Unable to update post.' });
  }
});

app.delete('/api/posts/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const [existing] = await getPool().query('SELECT id FROM posts WHERE id = ?', [id]);
    if (!existing.length) {
      return res.status(404).json({ error: 'Post not found.' });
    }

    await getPool().execute('DELETE FROM posts WHERE id = ?', [id]);
    res.json({ message: 'Post deleted successfully.' });
  } catch (error) {
    console.error('Delete post error:', error);
    res.status(500).json({ error: 'Unable to delete post.' });
  }
});

// ================= EMPLOYEE MANAGEMENT ROUTES =================

app.get('/api/employees', requireAuth, async (req, res) => { 
  try {
    const [rows] = await getPool().query(
      'SELECT id, full_name, email, phone, role FROM employees ORDER BY id DESC'
    );
    res.json(rows);
  } catch (error) {
    console.error('Fetch employees error:', error); 
    res.status(500).json({ error: 'Unable to fetch employees.' });
  }
});

app.post('/api/employees', requireAuth, async (req, res) => {
  try {
    console.log("Request Body:", req.body);

    const { full_name, email, phone, password, role } = req.body;

    if (!full_name || !email || !password) {
      return res.status(400).json({
        error: "Full name, email and password are required."
      });
    }

    const pool = getPool();

    const [existing] = await pool.query(
      "SELECT id FROM employees WHERE email = ?",
      [email]
    );

    if (existing.length) {
      return res.status(400).json({
        error: "Email is already registered."
      });
    }

    const hashedPassword = hashPassword(password);

    const [result] = await pool.execute(
      `INSERT INTO employees
      (full_name, email, phone, password, role)
      VALUES (?, ?, ?, ?, ?)`,
      [
        full_name,
        email,
        phone || null,
        hashedPassword,
        role || "Reporter"
      ]
    );

    const [rows] = await pool.query(
      `SELECT id, full_name, email, phone, role
       FROM employees
       WHERE id = ?`,
      [result.insertId]
    );

    res.status(201).json(rows[0]);

  } catch (error) {
    console.error("Add employee error:", error);

    res.status(500).json({
      error: error.message,
      code: error.code,
      sqlMessage: error.sqlMessage
    });
  }
});

app.put('/api/employees/:id', requireAuth, async (req, res) => {
  try {
    const { full_name, email, phone, role, password } = req.body;
    const { id } = req.params;
    const pool = getPool();

    const [existing] = await pool.query('SELECT * FROM employees WHERE id = ?', [id]);
    if (!existing.length) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    let updatedPassword = existing[0].password;
    if (password && password.trim() !== '') {
      updatedPassword = hashPassword(password);
    }

    await pool.execute(
      'UPDATE employees SET full_name = ?, email = ?, phone = ?, role = ?, password = ? WHERE id = ?',
      [
        full_name || existing[0].full_name,
        email || existing[0].email,
        phone || existing[0].phone,
        role || existing[0].role,
        updatedPassword,
        id
      ]
    );

    const [updated] = await pool.query(
      'SELECT id, full_name, email, phone, role FROM employees WHERE id = ?',
      [id]
    );
    res.json(updated[0]);
  } catch (error) {
    console.error('Update employee error:', error);
    res.status(500).json({ error: 'Unable to update employee.' });
  }
});

app.delete('/api/employees/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const pool = getPool();

    if (req.user.role_type === 'employee' && req.user.id === parseInt(id, 10)) {
      return res.status(400).json({ error: 'You cannot delete your own account.' });
    }

    const [existing] = await pool.query('SELECT id FROM employees WHERE id = ?', [id]);
    if (!existing.length) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    await pool.execute('DELETE FROM employees WHERE id = ?', [id]);
    res.json({ message: 'Employee deleted successfully.' });
  } catch (error) {
    console.error('Delete employee error:', error);
    res.status(500).json({ error: 'Unable to delete employee.' });
  }
});

// ================= COMMENTS & REPLIES ROUTES =================

app.get('/api/comments/:postId', async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT * FROM comments WHERE post_id = ? ORDER BY created_at ASC`,
      [req.params.postId]
    );
    res.json(rows);
  } catch (error) {
    console.error('Fetch comments error:', error);
    res.status(500).json({ error: 'Unable to fetch comments.' });
  }
});

app.post('/api/comments', async (req, res) => {
  try {
    const { post_id, name, comment, parent_id } = req.body;

    if (!post_id || !name || !comment) {
      return res.status(400).json({ error: 'Missing fields.' });
    }

    const [result] = await getPool().execute(
      `INSERT INTO comments (post_id, name, comment, parent_id, likes, dislikes)
       VALUES (?, ?, ?, ?, 0, 0)`,
      [post_id, name, comment, parent_id || null]
    );

    const [rows] = await getPool().query('SELECT * FROM comments WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Save comment error:', err);
    res.status(500).json({ error: 'Unable to save comment.' });
  }
});

app.post('/api/comments/:id/like', async (req, res) => {
  try {
    await getPool().execute(
      'UPDATE comments SET likes = COALESCE(likes, 0) + 1 WHERE id = ?',
      [req.params.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Like comment error:', error);
    res.status(500).json({ error: 'Unable to update like count.' });
  }
});

app.post('/api/comments/:id/dislike', async (req, res) => {
  try {
    await getPool().execute(
      'UPDATE comments SET dislikes = COALESCE(dislikes, 0) + 1 WHERE id = ?',
      [req.params.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Dislike comment error:', error);
    res.status(500).json({ error: 'Unable to update dislike count.' });
  }
});

app.put('/api/comments/:id', async (req, res) => {
  try {
    const { name, comment } = req.body;
    await getPool().execute(
      'UPDATE comments SET name = ?, comment = ? WHERE id = ?',
      [name, comment, req.params.id]
    );
    const [rows] = await getPool().query('SELECT * FROM comments WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (error) {
    console.error('Update comment error:', error);
    res.status(500).json({ error: 'Unable to update comment.' });
  }
});

// ================= AUTHENTICATION ROUTES =================

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const pool = getPool();
    let user = null;
    let userTable = '';

    // Check admin first
    const [adminRows] = await pool.query('SELECT * FROM admins WHERE email = ? LIMIT 1', [email]);
    if (adminRows.length) {
      user = adminRows[0];
      userTable = 'admins';
    } else {
      // Check employee second
      const [empRows] = await pool.query('SELECT * FROM employees WHERE email = ? LIMIT 1', [email]);
      if (empRows.length) {
        user = empRows[0];
        userTable = 'employees';
      }
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const valid = password === user.password || verifyPassword(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = generateToken();
    await pool.execute(`UPDATE ${userTable} SET authToken = ? WHERE id = ?`, [token, user.id]);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        phone: user.phone,
        role: userTable === 'admins' ? 'admin' : (user.role || 'Staff')
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Unable to log in.' });
  }
});

app.post('/api/auth/forgot', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const pool = getPool();
    let userTable = 'admins';
    let [rows] = await pool.query('SELECT * FROM admins WHERE email = ? LIMIT 1', [email]);

    if (!rows.length) {
      userTable = 'employees';
      [rows] = await pool.query('SELECT * FROM employees WHERE email = ? LIMIT 1', [email]);
    }

    if (!rows.length) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    const resetToken = generateToken();
    const resetExpires = new Date(Date.now() + 1000 * 60 * 60);
    await pool.execute(
      `UPDATE ${userTable} SET resetToken = ?, resetExpires = ? WHERE id = ?`,
      [resetToken, resetExpires, rows[0].id]
    );

    res.json({ message: 'Reset token created. Use this token to reset your password.', resetToken });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Unable to process forgot password.' });
  }
});

app.post('/api/auth/reset', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: 'Token and new password are required.' });
    }

    const pool = getPool();
    let userTable = 'admins';
    let [rows] = await pool.query('SELECT * FROM admins WHERE resetToken = ? LIMIT 1', [token]);

    if (!rows.length) {
      userTable = 'employees';
      [rows] = await pool.query('SELECT * FROM employees WHERE resetToken = ? LIMIT 1', [token]);
    }

    if (!rows.length) {
      return res.status(400).json({ error: 'Invalid reset token.' });
    }

    const user = rows[0];
    if (!user.resetExpires || new Date(user.resetExpires) < new Date()) {
      return res.status(400).json({ error: 'Reset token has expired.' });
    }

    const hashedPassword = hashPassword(password);
    await pool.execute(
      `UPDATE ${userTable} SET password = ?, resetToken = NULL, resetExpires = NULL WHERE id = ?`,
      [hashedPassword, user.id]
    );

    res.json({ message: 'Password has been reset successfully.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Unable to reset password.' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const pool = getPool();
    let [rows] = await pool.query(
      'SELECT id, email, full_name, phone, "admin" as role FROM admins WHERE authToken = ? LIMIT 1',
      [token]
    );

    if (!rows.length) {
      rows = (await pool.query(
        'SELECT id, email, full_name, phone, role FROM employees WHERE authToken = ? LIMIT 1',
        [token]
      ))[0];
    }

    if (!rows.length) {
      return res.status(401).json({ error: 'Invalid token.' });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error('Me auth error:', error);
    res.status(500).json({ error: 'Unable to verify user.' });
  }
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const table = req.user.role_type === 'admin' ? 'admins' : 'employees';
    await pool.execute(`UPDATE ${table} SET authToken = NULL WHERE id = ?`, [req.user.id]);
    res.json({ message: 'Logged out successfully.' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Unable to log out.' });
  }
});

// ================= SERVER INITIALIZATION =================

async function startServer() {
  try {
    await init();
    app.listen(port, () => {
      console.log(`Backend server is running on http://localhost:${port}`);
    });
  } catch (error) {
    console.error('Server startup failed:', error);
    process.exit(1);
  }
}

startServer();