const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const {
  getPool,
  hashPassword,
  verifyPassword,
  init
} = require('./database/db');

const app = express();
const port = Number(process.env.PORT) || 5000;

// =====================================================
// BASIC CONFIGURATION
// =====================================================

app.use(cors());

app.use(express.json());

app.use(
  express.urlencoded({
    extended: true
  })
);

// =====================================================
// REQUEST LOGGER
// =====================================================

app.use((req, res, next) => {
  console.log(
    `[request] ${req.method} ${req.originalUrl}`
  );

  next();
});

// =====================================================
// UPLOADS
// =====================================================

const uploadsDir = path.join(
  __dirname,
  'uploads'
);

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, {
    recursive: true
  });

  console.log(
    'Created uploads directory: ' +
      uploadsDir
  );
}

app.use(
  '/uploads',
  express.static(uploadsDir)
);

// =====================================================
// MULTER
// =====================================================

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
]);

const ALLOWED_IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif'
]);

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },

  filename: function (req, file, cb) {
    const extension = path
      .extname(file.originalname)
      .toLowerCase();

    const filename =
      Date.now() +
      '-' +
      file.fieldname +
      extension;

    cb(null, filename);
  }
});

function imageFileFilter(req, file, cb) {
  const extension = path
    .extname(file.originalname)
    .toLowerCase();

  const mimeOk =
    ALLOWED_IMAGE_MIME_TYPES.has(
      file.mimetype
    );

  const extOk =
    ALLOWED_IMAGE_EXTENSIONS.has(
      extension
    );

  if (!mimeOk || !extOk) {
    return cb(
      new Error(
        'Only JPG, PNG, WEBP, and GIF image files are allowed.'
      )
    );
  }

  cb(null, true);
}

const upload = multer({
  storage,

  fileFilter: imageFileFilter,

  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

// =====================================================
// TOKEN
// =====================================================

function generateToken() {
  return crypto
    .randomBytes(32)
    .toString('hex');
}

// =====================================================
// AUTHENTICATION
// =====================================================

async function requireAuth(
  req,
  res,
  next
) {
  try {
    const authHeader =
      req.headers.authorization || '';

    const token =
      authHeader
        .replace(/^Bearer\s+/i, '')
        .trim();

    if (!token) {
      return res.status(401).json({
        error:
          'Authentication required.'
      });
    }

    const pool = getPool();

    let rows = [];

    // -------------------------------------------------
    // ADMIN
    // -------------------------------------------------

    [rows] = await pool.query(
      `
      SELECT *,
             'admin' AS role_type
      FROM admins
      WHERE authToken = ?
      LIMIT 1
      `,
      [token]
    );

    // -------------------------------------------------
    // CHIEF EDITOR
    // -------------------------------------------------

    if (!rows.length) {
      [rows] = await pool.query(
        `
        SELECT *,
               'chief_editor' AS role_type
        FROM chief_editors
        WHERE authToken = ?
        LIMIT 1
        `,
        [token]
      );
    }

    // -------------------------------------------------
    // EMPLOYEE / REPORTER
    // -------------------------------------------------

    if (!rows.length) {
      [rows] = await pool.query(
        `
        SELECT *,
               'employee' AS role_type
        FROM employees
        WHERE authToken = ?
        LIMIT 1
        `,
        [token]
      );
    }

    if (!rows.length) {
      return res.status(401).json({
        error:
          'Invalid or expired token.'
      });
    }

    // -------------------------------------------------
    // ACCOUNT STATUS
    // -------------------------------------------------

    if (
      rows[0].status &&
      rows[0].status !== 'active'
    ) {
      return res.status(403).json({
        error:
          'Your account is not active.'
      });
    }

    req.user = rows[0];

    next();
  } catch (error) {
    console.error(
      'Authentication error:',
      error
    );

    return res.status(500).json({
      error:
        'Authentication validation failed.'
    });
  }
}

// =====================================================
// ADMIN ONLY
// =====================================================

function requireAdmin(
  req,
  res,
  next
) {
  if (
    req.user.role_type !==
    'admin'
  ) {
    return res.status(403).json({
      error:
        'Admin permission required.'
    });
  }

  next();
}

// =====================================================
// CHIEF EDITOR ONLY
// =====================================================

function requireChiefEditor(
  req,
  res,
  next
) {
  if (
    req.user.role_type !==
    'chief_editor'
  ) {
    return res.status(403).json({
      error:
        'Chief Editor permission required.'
    });
  }

  next();
}

// =====================================================
// ADMIN + CHIEF EDITOR
// =====================================================

function requirePostManagement(
  req,
  res,
  next
) {
  if (
    req.user.role_type !== 'admin' &&
    req.user.role_type !== 'chief_editor'
  ) {
    return res.status(403).json({
      error:
        'Admin or Chief Editor permission required.'
    });
  }

  next();
}

// =====================================================
// PUBLIC POSTS
// =====================================================

app.get(
  '/api/posts',
  async (req, res) => {
    try {
      const [rows] =
        await getPool().query(
          `
          SELECT *
          FROM posts
          WHERE status = 'approved'
          ORDER BY id DESC
          `
        );

      res.json(rows);
    } catch (error) {
      console.error(
        'Fetch public posts error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to fetch posts.'
      });
    }
  }
);

// =====================================================
// PUBLIC SINGLE POST
// =====================================================

app.get(
  '/api/posts/:id',
  async (req, res) => {
    try {
      const [rows] =
        await getPool().query(
          `
          SELECT *
          FROM posts
          WHERE id = ?
          AND status = 'approved'
          `,
          [req.params.id]
        );

      if (!rows.length) {
        return res.status(404).json({
          error:
            'Post not found.'
        });
      }

      res.json(rows[0]);
    } catch (error) {
      console.error(
        'Fetch post error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to fetch post.'
      });
    }
  }
);

// =====================================================
// ADMIN + CHIEF EDITOR DASHBOARD
// =====================================================
//
// THIS IS THE ROUTE THAT WAS MISSING.
//
// GET:
// /api/chief-editor/dashboard
//
// Returns:
// - totalPosts
// - pendingReview
// - approved
// - rejected
// - pendingPosts
//
// Both Admin and Chief Editor are allowed.
//

app.get(
  '/api/chief-editor/dashboard',
  requireAuth,
  requirePostManagement,
  async (req, res) => {
    try {
      const pool = getPool();

      // -------------------------------------------------
      // TOTAL POSTS
      // -------------------------------------------------

      const [[totalResult]] =
        await pool.query(`
          SELECT COUNT(*) AS total
          FROM posts
        `);

      // -------------------------------------------------
      // PENDING POSTS
      // -------------------------------------------------

      const [[pendingResult]] =
        await pool.query(`
          SELECT COUNT(*) AS total
          FROM posts
          WHERE status = 'pending'
        `);

      // -------------------------------------------------
      // APPROVED POSTS
      // -------------------------------------------------

      const [[approvedResult]] =
        await pool.query(`
          SELECT COUNT(*) AS total
          FROM posts
          WHERE status = 'approved'
        `);

      // -------------------------------------------------
      // REJECTED POSTS
      // -------------------------------------------------

      const [[rejectedResult]] =
        await pool.query(`
          SELECT COUNT(*) AS total
          FROM posts
          WHERE status = 'rejected'
        `);

      // -------------------------------------------------
      // POSTS WAITING FOR REVIEW
      // -------------------------------------------------

      const [pendingPosts] =
        await pool.query(`
          SELECT
            p.*,
            p.Author AS author_name
          FROM posts p
          WHERE p.status = 'pending'
          ORDER BY p.id DESC
        `);

      // -------------------------------------------------
      // RESPONSE
      // -------------------------------------------------

      res.json({
        totalPosts:
          Number(totalResult.total),

        pendingReview:
          Number(pendingResult.total),

        approved:
          Number(approvedResult.total),

        rejected:
          Number(rejectedResult.total),

        pendingPosts
      });

    } catch (error) {
      console.error(
        'Chief Editor dashboard error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to fetch dashboard data.'
      });
    }
  }
);

// =====================================================
// ADMIN + CHIEF EDITOR - ALL POSTS
// =====================================================

app.get(
  '/api/admin/posts',
  requireAuth,
  requirePostManagement,
  async (req, res) => {
    try {
      const [rows] =
        await getPool().query(
          `
          SELECT
            p.*,
            p.Author AS author_name
          FROM posts p
          ORDER BY
            CASE
              WHEN p.status = 'pending'
                THEN 1
              WHEN p.status = 'approved'
                THEN 2
              WHEN p.status = 'rejected'
                THEN 3
              ELSE 4
            END,
            p.id DESC
          `
        );

      res.json(rows);
    } catch (error) {
      console.error(
        'Admin/Chief Editor fetch all posts error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to fetch posts.'
      });
    }
  }
);

// =====================================================
// ADMIN + CHIEF EDITOR - PENDING POSTS
// =====================================================

app.get(
  '/api/admin/posts/pending',
  requireAuth,
  requirePostManagement,
  async (req, res) => {
    try {
      const [rows] =
        await getPool().query(
          `
          SELECT
            p.*,
            p.Author AS author_name
          FROM posts p
          WHERE p.status = 'pending'
          ORDER BY p.id DESC
          `
        );

      res.json(rows);
    } catch (error) {
      console.error(
        'Admin/Chief Editor pending posts error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to fetch pending posts.'
      });
    }
  }
);

// =====================================================
// CHIEF EDITOR - ALL POSTS
// =====================================================

app.get(
  '/api/chief-editor/posts',
  requireAuth,
  requirePostManagement,
  async (req, res) => {
    try {
      const [rows] =
        await getPool().query(
          `
          SELECT
            p.*,
            p.Author AS author_name
          FROM posts p
          ORDER BY
            CASE
              WHEN p.status = 'pending'
                THEN 1
              WHEN p.status = 'approved'
                THEN 2
              WHEN p.status = 'rejected'
                THEN 3
              ELSE 4
            END,
            p.id DESC
          `
        );

      res.json(rows);
    } catch (error) {
      console.error(
        'Chief Editor/Admin fetch posts error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to fetch posts.'
      });
    }
  }
);

// =====================================================
// CHIEF EDITOR - PENDING POSTS
// =====================================================

app.get(
  '/api/chief-editor/posts/pending',
  requireAuth,
  requirePostManagement,
  async (req, res) => {
    try {
      const [rows] =
        await getPool().query(
          `
          SELECT
            p.*,
            p.Author AS author_name
          FROM posts p
          WHERE p.status = 'pending'
          ORDER BY p.id DESC
          `
        );

      res.json(rows);
    } catch (error) {
      console.error(
        'Chief Editor/Admin pending posts error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to fetch pending posts.'
      });
    }
  }
);

// =====================================================
// APPROVE POST
// =====================================================

app.put(
  '/api/chief-editor/posts/:id/approve',
  requireAuth,
  requirePostManagement,
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const pool = getPool();

      const [existingRows] =
        await pool.query(
          `
          SELECT *
          FROM posts
          WHERE id = ?
          LIMIT 1
          `,
          [id]
        );

      if (!existingRows.length) {
        return res.status(404).json({
          error:
            'Post not found.'
        });
      }

      const existing =
        existingRows[0];

      if (
        existing.status ===
        'approved'
      ) {
        return res.status(400).json({
          error:
            'This post is already approved.'
        });
      }

      const approverName =
        req.user.full_name ||
        req.user.email ||
        (
          req.user.role_type ===
          'admin'
            ? 'Admin'
            : 'Chief Editor'
        );

      await pool.execute(
        `
        UPDATE posts
        SET
          status = 'approved',
          rejection_reason = NULL,
          approved_by = ?,
          approved_at = NOW()
        WHERE id = ?
        `,
        [
          approverName,
          id
        ]
      );

      const [rows] =
        await pool.query(
          `
          SELECT *
          FROM posts
          WHERE id = ?
          `,
          [id]
        );

      res.json({
        message:
          'Post approved successfully.',
        post:
          rows[0]
      });

    } catch (error) {
      console.error(
        'Approve post error:',
        error
      );

      res.status(500).json({
        error:
          error.message ||
          'Unable to approve post.'
      });
    }
  }
);

// =====================================================
// REJECT POST
// =====================================================

app.put(
  '/api/chief-editor/posts/:id/reject',
  requireAuth,
  requirePostManagement,
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const { reason } =
        req.body;

      const pool = getPool();

      const [existingRows] =
        await pool.query(
          `
          SELECT *
          FROM posts
          WHERE id = ?
          LIMIT 1
          `,
          [id]
        );

      if (!existingRows.length) {
        return res.status(404).json({
          error:
            'Post not found.'
        });
      }

      const rejectionReason =
        reason &&
        String(reason).trim()
          ? String(reason).trim()
          : `Post rejected by ${
              req.user.role_type ===
              'admin'
                ? 'Admin'
                : 'Chief Editor'
            }.`;

      await pool.execute(
        `
        UPDATE posts
        SET
          status = 'rejected',
          rejection_reason = ?,
          approved_by = NULL,
          approved_at = NULL
        WHERE id = ?
        `,
        [
          rejectionReason,
          id
        ]
      );

      const [rows] =
        await pool.query(
          `
          SELECT *
          FROM posts
          WHERE id = ?
          `,
          [id]
        );

      res.json({
        message:
          'Post rejected successfully.',
        post:
          rows[0]
      });

    } catch (error) {
      console.error(
        'Reject post error:',
        error
      );

      res.status(500).json({
        error:
          error.message ||
          'Unable to reject post.'
      });
    }
  }
);

// =====================================================
// RETURN REJECTED POST TO PENDING
// =====================================================

app.put(
  '/api/chief-editor/posts/:id/review',
  requireAuth,
  requirePostManagement,
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const [existingRows] =
        await getPool().query(
          `
          SELECT id
          FROM posts
          WHERE id = ?
          LIMIT 1
          `,
          [id]
        );

      if (!existingRows.length) {
        return res.status(404).json({
          error:
            'Post not found.'
        });
      }

      await getPool().execute(
        `
        UPDATE posts
        SET
          status = 'pending',
          rejection_reason = NULL,
          approved_by = NULL,
          approved_at = NULL
        WHERE id = ?
        `,
        [id]
      );

      const [rows] =
        await getPool().query(
          `
          SELECT *
          FROM posts
          WHERE id = ?
          `,
          [id]
        );

      res.json({
        message:
          'Post returned to pending review.',
        post:
          rows[0]
      });

    } catch (error) {
      console.error(
        'Return post to review error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to return post to review.'
      });
    }
  }
);

// =====================================================
// CREATE POST
// =====================================================

app.post(
  '/api/posts',
  requireAuth,
  upload.single('image'),
  async (req, res) => {
    try {
      const {
        title,
        category,
        description,
        youtube_url,
        author
      } = req.body;

      if (
        !title ||
        !category ||
        !description
      ) {
        return res.status(400).json({
          error:
            'Title, category, and description are required.'
        });
      }

      const imageUrl =
        req.file
          ? `${req.protocol}://${req.get(
              'host'
            )}/uploads/${req.file.filename}`
          : null;

      const authorName =
        author &&
        String(author).trim()
          ? String(author).trim()
          : req.user.full_name ||
            req.user.email ||
            'Admin';

      let postStatus =
        'pending';

      if (
        req.user.role_type ===
          'admin' ||
        req.user.role_type ===
          'chief_editor'
      ) {
        postStatus =
          'approved';
      }

      const approvedBy =
        postStatus === 'approved'
          ? req.user.full_name ||
            req.user.email ||
            null
          : null;

      const approvedAt =
        postStatus === 'approved'
          ? new Date()
          : null;

      const [result] =
        await getPool().execute(
          `
          INSERT INTO posts
          (
            title,
            category,
            description,
            image,
            createdDate,
            youtube_url,
            Author,
            status,
            rejection_reason,
            approved_by,
            approved_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
          `,
          [
            String(title).trim(),
            String(category).trim(),
            description,
            imageUrl,
            new Date(),
            youtube_url || null,
            authorName,
            postStatus,
            approvedBy,
            approvedAt
          ]
        );

      const [rows] =
        await getPool().query(
          `
          SELECT *
          FROM posts
          WHERE id = ?
          `,
          [result.insertId]
        );

      res.status(201).json({
        message:
          postStatus === 'pending'
            ? 'Post submitted successfully and is waiting for Admin or Chief Editor approval.'
            : 'Post published successfully.',
        post:
          rows[0]
      });

    } catch (error) {
      console.error(
        'Create post error:',
        error
      );

      res.status(500).json({
        error:
          error.message ||
          'Unable to create post.'
      });
    }
  }
);

// =====================================================
// UPDATE POST
// =====================================================

app.put(
  '/api/posts/:id',
  requireAuth,
  upload.single('image'),
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const {
        title,
        category,
        description,
        youtube_url,
        author
      } = req.body;

      const [existingRows] =
        await getPool().query(
          `
          SELECT *
          FROM posts
          WHERE id = ?
          `,
          [id]
        );

      if (!existingRows.length) {
        return res.status(404).json({
          error:
            'Post not found.'
        });
      }

      const existing =
        existingRows[0];

      // -------------------------------------------------
      // EMPLOYEE OWNERSHIP CHECK
      // -------------------------------------------------

      if (
        req.user.role_type ===
        'employee'
      ) {
        const employeeName =
          req.user.full_name ||
          req.user.email;

        if (
          existing.Author !==
          employeeName
        ) {
          return res.status(403).json({
            error:
              'You can only edit your own posts.'
          });
        }
      }

      // -------------------------------------------------
      // IMAGE
      // -------------------------------------------------

      const imageUrl =
        req.file
          ? `${req.protocol}://${req.get(
              'host'
            )}/uploads/${req.file.filename}`
          : existing.image;

      // -------------------------------------------------
      // YOUTUBE
      // -------------------------------------------------

      const updatedYoutubeUrl =
        youtube_url !== undefined
          ? youtube_url || null
          : existing.youtube_url;

      // -------------------------------------------------
      // AUTHOR
      // -------------------------------------------------

      const updatedAuthor =
        author !== undefined &&
        String(author).trim()
          ? String(author).trim()
          : existing.Author;

      // -------------------------------------------------
      // STATUS
      // -------------------------------------------------

      let updatedStatus =
        existing.status;

      let approvedBy =
        existing.approved_by;

      let approvedAt =
        existing.approved_at;

      let rejectionReason =
        existing.rejection_reason;

      // Employee edits always require review again.

      if (
        req.user.role_type ===
        'employee'
      ) {
        updatedStatus =
          'pending';

        approvedBy = null;

        approvedAt = null;

        rejectionReason = null;
      }

      // Admin or Chief Editor edits remain approved
      // when the existing post is approved.

      if (
        req.user.role_type ===
          'admin' ||
        req.user.role_type ===
          'chief_editor'
      ) {
        if (
          existing.status ===
          'approved'
        ) {
          updatedStatus =
            'approved';

          approvedBy =
            req.user.full_name ||
            req.user.email;

          approvedAt =
            existing.approved_at ||
            new Date();

          rejectionReason =
            null;
        }
      }

      await getPool().execute(
        `
        UPDATE posts
        SET
          title = ?,
          category = ?,
          description = ?,
          image = ?,
          youtube_url = ?,
          Author = ?,
          status = ?,
          rejection_reason = ?,
          approved_by = ?,
          approved_at = ?
        WHERE id = ?
        `,
        [
          title !== undefined &&
          String(title).trim()
            ? String(title).trim()
            : existing.title,

          category !== undefined &&
          String(category).trim()
            ? String(category).trim()
            : existing.category,

          description !== undefined
            ? description
            : existing.description,

          imageUrl,

          updatedYoutubeUrl,

          updatedAuthor,

          updatedStatus,

          rejectionReason,

          approvedBy,

          approvedAt,

          id
        ]
      );

      const [rows] =
        await getPool().query(
          `
          SELECT *
          FROM posts
          WHERE id = ?
          `,
          [id]
        );

      res.json({
        message:
          req.user.role_type ===
          'employee'
            ? 'Post updated and sent back for Admin or Chief Editor approval.'
            : 'Post updated successfully.',
        post:
          rows[0]
      });

    } catch (error) {
      console.error(
        'Update post error:',
        error
      );

      res.status(500).json({
        error:
          error.message ||
          'Unable to update post.'
      });
    }
  }
);

// =====================================================
// DELETE POST
// =====================================================

app.delete(
  '/api/posts/:id',
  requireAuth,
  requirePostManagement,
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const [existing] =
        await getPool().query(
          `
          SELECT id
          FROM posts
          WHERE id = ?
          `,
          [id]
        );

      if (!existing.length) {
        return res.status(404).json({
          error:
            'Post not found.'
        });
      }

      await getPool().execute(
        `
        DELETE FROM posts
        WHERE id = ?
        `,
        [id]
      );

      res.json({
        message:
          'Post deleted successfully.'
      });

    } catch (error) {
      console.error(
        'Delete post error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to delete post.'
      });
    }
  }
);

// =====================================================
// EMPLOYEE - MY POSTS
// =====================================================

app.get(
  '/api/my-posts',
  requireAuth,
  async (req, res) => {
    try {
      if (
        req.user.role_type !==
        'employee'
      ) {
        return res.status(403).json({
          error:
            'Employee permission required.'
        });
      }

      const authorName =
        req.user.full_name ||
        req.user.email;

      const [rows] =
        await getPool().query(
          `
          SELECT *
          FROM posts
          WHERE Author = ?
          ORDER BY id DESC
          `,
          [authorName]
        );

      res.json(rows);

    } catch (error) {
      console.error(
        'Fetch employee posts error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to fetch your posts.'
      });
    }
  }
);

// =====================================================
// COMMENTS
// =====================================================

app.get(
  '/api/comments/:postId',
  async (req, res) => {
    try {
      const [rows] =
        await getPool().query(
          `
          SELECT *
          FROM comments
          WHERE post_id = ?
          ORDER BY created_at ASC
          `,
          [req.params.postId]
        );

      res.json(rows);

    } catch (error) {
      console.error(
        'Fetch comments error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to fetch comments.'
      });
    }
  }
);

app.post(
  '/api/comments',
  async (req, res) => {
    try {
      const {
        post_id,
        name,
        comment,
        parent_id
      } = req.body;

      if (
        !post_id ||
        !name ||
        !comment
      ) {
        return res.status(400).json({
          error:
            'Missing fields.'
        });
      }

      const [result] =
        await getPool().execute(
          `
          INSERT INTO comments
          (
            post_id,
            name,
            comment,
            parent_id,
            likes,
            dislikes
          )
          VALUES (?, ?, ?, ?, 0, 0)
          `,
          [
            post_id,
            String(name).trim(),
            String(comment).trim(),
            parent_id || null
          ]
        );

      const [rows] =
        await getPool().query(
          `
          SELECT *
          FROM comments
          WHERE id = ?
          `,
          [result.insertId]
        );

      res.status(201).json(
        rows[0]
      );

    } catch (error) {
      console.error(
        'Create comment error:',
        error
      );

      res.status(500).json({
        error:
          error.message ||
          'Unable to create comment.'
      });
    }
  }
);

// =====================================================
// DELETE COMMENT
// =====================================================

app.delete(
  '/api/comments/:id',
  requireAuth,
  requirePostManagement,
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const [existing] =
        await getPool().query(
          `
          SELECT id
          FROM comments
          WHERE id = ?
          `,
          [id]
        );

      if (!existing.length) {
        return res.status(404).json({
          error:
            'Comment not found.'
        });
      }

      await getPool().execute(
        `
        DELETE FROM comments
        WHERE id = ?
        `,
        [id]
      );

      res.json({
        message:
          'Comment deleted successfully.'
      });

    } catch (error) {
      console.error(
        'Delete comment error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to delete comment.'
      });
    }
  }
);

// =====================================================
// ADVERTISEMENTS
// =====================================================

app.get(
  '/api/advertisements',
  async (req, res) => {
    try {
      const [rows] =
        await getPool().query(
          `
          SELECT *
          FROM advertisements
          ORDER BY id DESC
          `
        );

      res.json(rows);

    } catch (error) {
      console.error(
        'Fetch advertisements error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to fetch advertisements.'
      });
    }
  }
);

// =====================================================
// CREATE ADVERTISEMENT
// =====================================================

app.post(
  '/api/advertisements',
  requireAuth,
  requireAdmin,
  upload.single('image'),
  async (req, res) => {
    try {
      const {
        title,
        description,
        target_url,
        link,
        position,
        start_date,
        end_date,
        status
      } = req.body;

      if (
        !title ||
        !String(title).trim()
      ) {
        return res.status(400).json({
          error:
            'Advertisement title is required.'
        });
      }

      const imageUrl =
        req.file
          ? `${req.protocol}://${req.get(
              'host'
            )}/uploads/${req.file.filename}`
          : null;

      const finalLink =
        target_url ||
        link ||
        null;

      const finalPosition =
        position ||
        'sidebar';

      const finalStatus =
        status ||
        'active';

      const [result] =
        await getPool().execute(
          `
          INSERT INTO advertisements
          (
            title,
            image,
            link,
            position,
            start_date,
            end_date,
            status,
            description,
            target_url
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            String(title).trim(),
            imageUrl,
            finalLink,
            finalPosition,
            start_date || null,
            end_date || null,
            finalStatus,
            description || null,
            finalLink
          ]
        );

      const [rows] =
        await getPool().query(
          `
          SELECT *
          FROM advertisements
          WHERE id = ?
          `,
          [result.insertId]
        );

      res.status(201).json(
        rows[0]
      );

    } catch (error) {
      console.error(
        'Create advertisement error:',
        error
      );

      res.status(500).json({
        error:
          error.message ||
          'Unable to create advertisement.'
      });
    }
  }
);

// =====================================================
// UPDATE ADVERTISEMENT
// =====================================================

app.put(
  '/api/advertisements/:id',
  requireAuth,
  requireAdmin,
  upload.single('image'),
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const {
        title,
        description,
        target_url,
        link,
        position,
        start_date,
        end_date,
        status
      } = req.body;

      const [existingRows] =
        await getPool().query(
          `
          SELECT *
          FROM advertisements
          WHERE id = ?
          `,
          [id]
        );

      if (!existingRows.length) {
        return res.status(404).json({
          error:
            'Advertisement not found.'
        });
      }

      const existing =
        existingRows[0];

      const imageUrl =
        req.file
          ? `${req.protocol}://${req.get(
              'host'
            )}/uploads/${req.file.filename}`
          : existing.image;

      let finalLink =
        existing.target_url ||
        existing.link ||
        null;

      if (
        target_url !== undefined
      ) {
        finalLink =
          target_url || null;
      } else if (
        link !== undefined
      ) {
        finalLink =
          link || null;
      }

      const finalPosition =
        position !== undefined
          ? position ||
            'sidebar'
          : existing.position ||
            'sidebar';

      const finalStatus =
        status !== undefined
          ? status ||
            'active'
          : existing.status ||
            'active';

      const finalStartDate =
        start_date !== undefined
          ? start_date || null
          : existing.start_date;

      const finalEndDate =
        end_date !== undefined
          ? end_date || null
          : existing.end_date;

      const finalDescription =
        description !== undefined
          ? description
          : existing.description;

      const finalTitle =
        title !== undefined &&
        String(title).trim()
          ? String(title).trim()
          : existing.title;

      await getPool().execute(
        `
        UPDATE advertisements
        SET
          title = ?,
          image = ?,
          link = ?,
          position = ?,
          start_date = ?,
          end_date = ?,
          status = ?,
          description = ?,
          target_url = ?
        WHERE id = ?
        `,
        [
          finalTitle,
          imageUrl,
          finalLink,
          finalPosition,
          finalStartDate,
          finalEndDate,
          finalStatus,
          finalDescription,
          finalLink,
          id
        ]
      );

      const [rows] =
        await getPool().query(
          `
          SELECT *
          FROM advertisements
          WHERE id = ?
          `,
          [id]
        );

      res.json(rows[0]);

    } catch (error) {
      console.error(
        'Update advertisement error:',
        error
      );

      res.status(500).json({
        error:
          error.message ||
          'Unable to update advertisement.'
      });
    }
  }
);

// =====================================================
// DELETE ADVERTISEMENT
// =====================================================

app.delete(
  '/api/advertisements/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const [existing] =
        await getPool().query(
          `
          SELECT id
          FROM advertisements
          WHERE id = ?
          `,
          [id]
        );

      if (!existing.length) {
        return res.status(404).json({
          error:
            'Advertisement not found.'
        });
      }

      await getPool().execute(
        `
        DELETE FROM advertisements
        WHERE id = ?
        `,
        [id]
      );

      res.json({
        message:
          'Advertisement deleted successfully.'
      });

    } catch (error) {
      console.error(
        'Delete advertisement error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to delete advertisement.'
      });
    }
  }
);

// =====================================================
// EMPLOYEES
// =====================================================

// GET EMPLOYEES

app.get(
  '/api/employees',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const [rows] =
        await getPool().query(
          `
          SELECT
            id,
            full_name,
            email,
            phone,
            role,
            created_at,
            status
          FROM employees
          ORDER BY id DESC
          `
        );

      res.json(rows);

    } catch (error) {
      console.error(
        'Fetch employees error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to fetch employees.'
      });
    }
  }
);

// CREATE EMPLOYEE

app.post(
  '/api/employees',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        full_name,
        email,
        phone,
        password,
        role,
        status
      } = req.body;

      if (
        !full_name ||
        !String(full_name).trim()
      ) {
        return res.status(400).json({
          error:
            'Full name is required.'
        });
      }

      if (
        !email ||
        !String(email).trim()
      ) {
        return res.status(400).json({
          error:
            'Email is required.'
        });
      }

      if (
        !password ||
        !String(password).trim()
      ) {
        return res.status(400).json({
          error:
            'Password is required.'
        });
      }

      const pool =
        getPool();

      const cleanName =
        String(full_name).trim();

      const cleanEmail =
        String(email)
          .trim()
          .toLowerCase();

      const cleanPhone =
        phone
          ? String(phone).trim()
          : null;

      const cleanRole =
        String(
          role || 'reporter'
        )
          .trim()
          .toLowerCase();

      const cleanStatus =
        String(
          status || 'active'
        )
          .trim()
          .toLowerCase();

      if (
        cleanRole !==
        'reporter'
      ) {
        return res.status(400).json({
          error:
            'Invalid employee role. Use reporter.'
        });
      }

      const [existing] =
        await pool.query(
          `
          SELECT id
          FROM employees
          WHERE email = ?
          LIMIT 1
          `,
          [cleanEmail]
        );

      if (existing.length) {
        return res.status(409).json({
          error:
            'Email is already registered as an employee.'
        });
      }

      const hashedPassword =
        hashPassword(
          String(password)
        );

      const [result] =
        await pool.execute(
          `
          INSERT INTO employees
          (
            full_name,
            email,
            phone,
            password,
            role,
            status,
            authToken
          )
          VALUES (?, ?, ?, ?, ?, ?, NULL)
          `,
          [
            cleanName,
            cleanEmail,
            cleanPhone,
            hashedPassword,
            cleanRole,
            cleanStatus
          ]
        );

      const [rows] =
        await pool.query(
          `
          SELECT
            id,
            full_name,
            email,
            phone,
            role,
            created_at,
            status
          FROM employees
          WHERE id = ?
          `,
          [result.insertId]
        );

      res.status(201).json({
        message:
          'Employee created successfully.',
        employee:
          rows[0]
      });

    } catch (error) {
      console.error(
        'Create employee error:',
        error
      );

      res.status(500).json({
        error:
          error.message ||
          'Unable to create employee.'
      });
    }
  }
);

// UPDATE EMPLOYEE

app.put(
  '/api/employees/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const {
        full_name,
        email,
        phone,
        password,
        role,
        status
      } = req.body;

      const pool =
        getPool();

      const [existingRows] =
        await pool.query(
          `
          SELECT *
          FROM employees
          WHERE id = ?
          `,
          [id]
        );

      if (!existingRows.length) {
        return res.status(404).json({
          error:
            'Employee not found.'
        });
      }

      const existing =
        existingRows[0];

      let updatedPassword =
        existing.password;

      if (
        password &&
        String(password).trim()
      ) {
        updatedPassword =
          hashPassword(
            String(password)
          );
      }

      const updatedName =
        full_name !== undefined &&
        String(full_name).trim()
          ? String(full_name).trim()
          : existing.full_name;

      const updatedEmail =
        email !== undefined &&
        String(email).trim()
          ? String(email)
              .trim()
              .toLowerCase()
          : existing.email;

      const updatedPhone =
        phone !== undefined
          ? phone
            ? String(phone).trim()
            : null
          : existing.phone;

      const updatedRole =
        role !== undefined &&
        String(role).trim()
          ? String(role)
              .trim()
              .toLowerCase()
          : existing.role ||
            'reporter';

      if (
        updatedRole !==
        'reporter'
      ) {
        return res.status(400).json({
          error:
            'Employee role must be reporter.'
        });
      }

      const updatedStatus =
        status !== undefined &&
        String(status).trim()
          ? String(status)
              .trim()
              .toLowerCase()
          : existing.status ||
            'active';

      const [duplicateEmail] =
        await pool.query(
          `
          SELECT id
          FROM employees
          WHERE email = ?
          AND id <> ?
          LIMIT 1
          `,
          [
            updatedEmail,
            id
          ]
        );

      if (
        duplicateEmail.length
      ) {
        return res.status(409).json({
          error:
            'Email is already registered to another employee.'
        });
      }

      await pool.execute(
        `
        UPDATE employees
        SET
          full_name = ?,
          email = ?,
          phone = ?,
          password = ?,
          role = ?,
          status = ?
        WHERE id = ?
        `,
        [
          updatedName,
          updatedEmail,
          updatedPhone,
          updatedPassword,
          updatedRole,
          updatedStatus,
          id
        ]
      );

      const [updatedRows] =
        await pool.query(
          `
          SELECT
            id,
            full_name,
            email,
            phone,
            role,
            created_at,
            status
          FROM employees
          WHERE id = ?
          `,
          [id]
        );

      res.json({
        message:
          'Employee updated successfully.',
        employee:
          updatedRows[0]
      });

    } catch (error) {
      console.error(
        'Update employee error:',
        error
      );

      res.status(500).json({
        error:
          error.message ||
          'Unable to update employee.'
      });
    }
  }
);

// DELETE EMPLOYEE

app.delete(
  '/api/employees/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const pool =
        getPool();

      const [existing] =
        await pool.query(
          `
          SELECT id
          FROM employees
          WHERE id = ?
          `,
          [id]
        );

      if (!existing.length) {
        return res.status(404).json({
          error:
            'Employee not found.'
        });
      }

      await pool.execute(
        `
        DELETE FROM employees
        WHERE id = ?
        `,
        [id]
      );

      res.json({
        message:
          'Employee deleted successfully.'
      });

    } catch (error) {
      console.error(
        'Delete employee error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to delete employee.'
      });
    }
  }
);

// =====================================================
// CHIEF EDITORS
// =====================================================

// GET CHIEF EDITORS

app.get(
  '/api/chief-editors',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const [rows] =
        await getPool().query(
          `
          SELECT
            id,
            full_name,
            email,
            phone,
            status,
            created_at
          FROM chief_editors
          ORDER BY id DESC
          `
        );

      res.json(rows);

    } catch (error) {
      console.error(
        'Fetch chief editors error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to fetch chief editors.'
      });
    }
  }
);

// CREATE CHIEF EDITOR

app.post(
  '/api/chief-editors',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        full_name,
        email,
        phone,
        password,
        status
      } = req.body;

      if (
        !full_name ||
        !String(full_name).trim()
      ) {
        return res.status(400).json({
          error:
            'Full name is required.'
        });
      }

      if (
        !email ||
        !String(email).trim()
      ) {
        return res.status(400).json({
          error:
            'Email is required.'
        });
      }

      if (
        !password ||
        !String(password).trim()
      ) {
        return res.status(400).json({
          error:
            'Password is required.'
        });
      }

      const pool =
        getPool();

      const cleanName =
        String(full_name).trim();

      const cleanEmail =
        String(email)
          .trim()
          .toLowerCase();

      const cleanPhone =
        phone
          ? String(phone).trim()
          : null;

      const cleanStatus =
        String(
          status || 'active'
        )
          .trim()
          .toLowerCase();

      const [existing] =
        await pool.query(
          `
          SELECT id
          FROM chief_editors
          WHERE email = ?
          LIMIT 1
          `,
          [cleanEmail]
        );

      if (existing.length) {
        return res.status(409).json({
          error:
            'Email is already registered as a Chief Editor.'
        });
      }

      const hashedPassword =
        hashPassword(
          String(password)
        );

      const [result] =
        await pool.execute(
          `
          INSERT INTO chief_editors
          (
            full_name,
            email,
            phone,
            password,
            status,
            authToken
          )
          VALUES (?, ?, ?, ?, ?, NULL)
          `,
          [
            cleanName,
            cleanEmail,
            cleanPhone,
            hashedPassword,
            cleanStatus
          ]
        );

      const [rows] =
        await pool.query(
          `
          SELECT
            id,
            full_name,
            email,
            phone,
            status,
            created_at
          FROM chief_editors
          WHERE id = ?
          `,
          [result.insertId]
        );

      res.status(201).json({
        message:
          'Chief Editor created successfully.',
        chiefEditor:
          rows[0]
      });

    } catch (error) {
      console.error(
        'Create chief editor error:',
        error
      );

      res.status(500).json({
        error:
          error.message ||
          'Unable to create chief editor.'
      });
    }
  }
);

// UPDATE CHIEF EDITOR

app.put(
  '/api/chief-editors/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const {
        full_name,
        email,
        phone,
        status,
        password
      } = req.body;

      const pool =
        getPool();

      const [existingRows] =
        await pool.query(
          `
          SELECT *
          FROM chief_editors
          WHERE id = ?
          `,
          [id]
        );

      if (!existingRows.length) {
        return res.status(404).json({
          error:
            'Chief Editor not found.'
        });
      }

      const existing =
        existingRows[0];

      let updatedPassword =
        existing.password;

      if (
        password &&
        String(password).trim()
      ) {
        updatedPassword =
          hashPassword(
            String(password)
          );
      }

      const updatedName =
        full_name !== undefined &&
        String(full_name).trim()
          ? String(full_name).trim()
          : existing.full_name;

      const updatedEmail =
        email !== undefined &&
        String(email).trim()
          ? String(email)
              .trim()
              .toLowerCase()
          : existing.email;

      const updatedPhone =
        phone !== undefined
          ? phone
            ? String(phone).trim()
            : null
          : existing.phone;

      const updatedStatus =
        status !== undefined &&
        String(status).trim()
          ? String(status)
              .trim()
              .toLowerCase()
          : existing.status ||
            'active';

      const [duplicate] =
        await pool.query(
          `
          SELECT id
          FROM chief_editors
          WHERE email = ?
          AND id <> ?
          LIMIT 1
          `,
          [
            updatedEmail,
            id
          ]
        );

      if (duplicate.length) {
        return res.status(409).json({
          error:
            'Email is already registered to another Chief Editor.'
        });
      }

      await pool.execute(
        `
        UPDATE chief_editors
        SET
          full_name = ?,
          email = ?,
          phone = ?,
          status = ?,
          password = ?
        WHERE id = ?
        `,
        [
          updatedName,
          updatedEmail,
          updatedPhone,
          updatedStatus,
          updatedPassword,
          id
        ]
      );

      const [updatedRows] =
        await pool.query(
          `
          SELECT
            id,
            full_name,
            email,
            phone,
            status,
            created_at
          FROM chief_editors
          WHERE id = ?
          `,
          [id]
        );

      res.json({
        message:
          'Chief Editor updated successfully.',
        chiefEditor:
          updatedRows[0]
      });

    } catch (error) {
      console.error(
        'Update chief editor error:',
        error
      );

      res.status(500).json({
        error:
          error.message ||
          'Unable to update chief editor.'
      });
    }
  }
);

// DELETE CHIEF EDITOR

app.delete(
  '/api/chief-editors/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const pool =
        getPool();

      const [existing] =
        await pool.query(
          `
          SELECT id
          FROM chief_editors
          WHERE id = ?
          `,
          [id]
        );

      if (!existing.length) {
        return res.status(404).json({
          error:
            'Chief Editor not found.'
        });
      }

      await pool.execute(
        `
        DELETE FROM chief_editors
        WHERE id = ?
        `,
        [id]
      );

      res.json({
        message:
          'Chief Editor deleted successfully.'
      });

    } catch (error) {
      console.error(
        'Delete chief editor error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to delete chief editor.'
      });
    }
  }
);

// =====================================================
// LOGIN
// =====================================================

app.post(
  '/api/auth/login',
  async (req, res) => {
    try {
      const {
        email,
        password
      } = req.body;

      if (
        !email ||
        !password
      ) {
        return res.status(400).json({
          error:
            'Email and password are required.'
        });
      }

      const pool =
        getPool();

      const cleanEmail =
        String(email)
          .trim()
          .toLowerCase();

      let user = null;

      let userTable = '';

      // -------------------------------------------------
      // ADMIN
      // -------------------------------------------------

      const [adminRows] =
        await pool.query(
          `
          SELECT *
          FROM admins
          WHERE email = ?
          LIMIT 1
          `,
          [cleanEmail]
        );

      if (adminRows.length) {
        user =
          adminRows[0];

        userTable =
          'admins';
      }

      // -------------------------------------------------
      // CHIEF EDITOR
      // -------------------------------------------------

      if (!user) {
        const [chiefRows] =
          await pool.query(
            `
            SELECT *
            FROM chief_editors
            WHERE email = ?
            LIMIT 1
            `,
            [cleanEmail]
          );

        if (chiefRows.length) {
          user =
            chiefRows[0];

          userTable =
            'chief_editors';
        }
      }

      // -------------------------------------------------
      // EMPLOYEE
      // -------------------------------------------------

      if (!user) {
        const [employeeRows] =
          await pool.query(
            `
            SELECT *
            FROM employees
            WHERE email = ?
            LIMIT 1
            `,
            [cleanEmail]
          );

        if (
          employeeRows.length
        ) {
          user =
            employeeRows[0];

          userTable =
            'employees';
        }
      }

      if (!user) {
        return res.status(401).json({
          error:
            'Invalid credentials.'
        });
      }

      if (
        user.status &&
        user.status !==
          'active'
      ) {
        return res.status(403).json({
          error:
            'Your account is not active.'
        });
      }

      // -------------------------------------------------
      // PASSWORD CHECK
      // -------------------------------------------------

      let validPassword =
        false;

      try {
        validPassword =
          verifyPassword(
            password,
            user.password
          );
      } catch (passwordError) {
        console.error(
          'Password verification error:',
          passwordError
        );

        validPassword =
          false;
      }

      if (!validPassword) {
        return res.status(401).json({
          error:
            'Invalid credentials.'
        });
      }

      // -------------------------------------------------
      // TOKEN
      // -------------------------------------------------

      const token =
        generateToken();

      await pool.execute(
        `
        UPDATE ${userTable}
        SET authToken = ?
        WHERE id = ?
        `,
        [
          token,
          user.id
        ]
      );

      // -------------------------------------------------
      // ROLE
      // -------------------------------------------------

      let userRole =
        'Staff';

      let roleType =
        'employee';

      if (
        userTable ===
        'admins'
      ) {
        userRole =
          'admin';

        roleType =
          'admin';

      } else if (
        userTable ===
        'chief_editors'
      ) {
        userRole =
          'Chief Editor';

        roleType =
          'chief_editor';

      } else if (
        userTable ===
        'employees'
      ) {
        userRole =
          user.role ||
          'reporter';

        roleType =
          'employee';
      }

      res.json({
        user: {
          id:
            user.id,

          email:
            user.email,

          full_name:
            user.full_name,

          phone:
            user.phone ||
            null,

          role:
            userRole,

          role_type:
            roleType
        },

        token
      });

    } catch (error) {
      console.error(
        'Login error:',
        error
      );

      res.status(500).json({
        error:
          error.message ||
          'Unable to log in.'
      });
    }
  }
);

// =====================================================
// CURRENT USER
// =====================================================

app.get(
  '/api/auth/me',
  requireAuth,
  async (req, res) => {
    try {
      let role =
        'Staff';

      if (
        req.user.role_type ===
        'admin'
      ) {
        role =
          'admin';

      } else if (
        req.user.role_type ===
        'chief_editor'
      ) {
        role =
          'Chief Editor';

      } else if (
        req.user.role_type ===
        'employee'
      ) {
        role =
          req.user.role ||
          'reporter';
      }

      res.json({
        user: {
          id:
            req.user.id,

          email:
            req.user.email,

          full_name:
            req.user.full_name,

          phone:
            req.user.phone ||
            null,

          role,

          role_type:
            req.user.role_type
        }
      });

    } catch (error) {
      console.error(
        'Current user error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to get current user.'
      });
    }
  }
);

// =====================================================
// LOGOUT
// =====================================================

app.post(
  '/api/auth/logout',
  requireAuth,
  async (req, res) => {
    try {
      const pool =
        getPool();

      let table =
        'employees';

      if (
        req.user.role_type ===
        'admin'
      ) {
        table =
          'admins';

      } else if (
        req.user.role_type ===
        'chief_editor'
      ) {
        table =
          'chief_editors';
      }

      await pool.execute(
        `
        UPDATE ${table}
        SET authToken = NULL
        WHERE id = ?
        `,
        [req.user.id]
      );

      res.json({
        message:
          'Logged out successfully.'
      });

    } catch (error) {
      console.error(
        'Logout error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to log out.'
      });
    }
  }
);

// =====================================================
// HEALTH CHECK
// =====================================================

app.get(
  '/api/health',
  (req, res) => {
    res.json({
      success: true,

      message:
        'Rubavu Today backend is running.',

      time:
        new Date().toISOString()
    });
  }
);

// =====================================================
// 404
// =====================================================

app.use(
  (req, res) => {
    console.log(
      `[404] No route matched: ${req.method} ${req.originalUrl}`
    );

    res.status(404).json({
      error:
        'API endpoint not found.'
    });
  }
);

// =====================================================
// GLOBAL ERROR HANDLER
// =====================================================

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      'Global server error:',
      error
    );

    if (
      error instanceof
      multer.MulterError
    ) {
      return res.status(400).json({
        error:
          'File upload error: ' +
          error.message
      });
    }

    if (
      error &&
      /image files are allowed/i.test(
        error.message || ''
      )
    ) {
      return res.status(400).json({
        error:
          error.message
      });
    }

    res.status(500).json({
      error:
        error.message ||
        'Internal server error.'
    });
  }
);

// =====================================================
// START SERVER
// =====================================================

async function startServer() {
  try {
    await init();

    const server =
      app.listen(
        port,
        () => {
          console.log(
            'Backend server is running on http://localhost:' +
              port
          );
        }
      );

    server.on(
      'error',
      (err) => {
        if (
          err.code ===
          'EADDRINUSE'
        ) {
          console.error(
            `\n[FATAL] Port ${port} is already in use.\n` +
              `Find and stop it with:\n` +
              `  netstat -ano | findstr :${port}\n` +
              `  taskkill /PID <PID> /F\n`
          );

          process.exit(1);

        } else {
          console.error(
            'Server failed to start:',
            err
          );

          process.exit(1);
        }
      }
    );

  } catch (error) {
    console.error(
      'Server startup failed:',
      error
    );

    process.exit(1);
  }
}

startServer();
