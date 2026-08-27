require('dotenv').config();

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const cloudinary = require('./config/cloudinary');
const { Readable } = require('stream');

const {
  getPool,
  hashPassword,
  verifyPassword,
  init
} = require('./database/db');

const app = express();

const port = Number(process.env.PORT) || 5000;

/* =========================================================
   BASIC MIDDLEWARE
========================================================= */

app.disable('x-powered-by');

app.use(compression());

app.use(
  cors({
    origin: true,
    credentials: true
  })
);

app.use(
  express.json({
    limit: '5mb'
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: '5mb'
  })
);

/* =========================================================
   REQUEST LOGGER
========================================================= */

app.use((req, res, next) => {
  console.log(
    `[request] ${req.method} ${req.originalUrl}`
  );

  next();
});

/* =========================================================
   UPLOADS DIRECTORY
========================================================= */

const uploadsDir = path.resolve(
  __dirname,
  'uploads'
);

try {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, {
      recursive: true
    });

    console.log(
      `[uploads] Created directory: ${uploadsDir}`
    );
  } else {
    console.log(
      `[uploads] Directory exists: ${uploadsDir}`
    );
  }
} catch (error) {
  console.error(
    '[uploads] Failed to create uploads directory:',
    error
  );

  process.exit(1);
}

/* =========================================================
   UPLOAD CACHE HEADERS
========================================================= */

app.use(
  '/uploads',
  (req, res, next) => {
    res.set(
      'Cache-Control',
      'public, max-age=604800, immutable'
    );

    next();
  }
);

/* =========================================================
   STATIC UPLOADS
========================================================= */

app.use(
  '/uploads',
  express.static(uploadsDir, {
    fallthrough: true,

    index: false,

    dotfiles: 'deny',

    etag: true,

    maxAge: '7d',

    setHeaders: (res) => {
      res.set(
        'Cache-Control',
        'public, max-age=604800, immutable'
      );
    }
  })
);

/* =========================================================
   UPLOAD FILE TYPES
========================================================= */

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

/* =========================================================
   MULTER STORAGE (Memory)
========================================================= */

const storage = multer.memoryStorage();

/* =========================================================
   IMAGE FILTER
========================================================= */

function imageFileFilter(req, file, cb) {
  const extension = path
    .extname(file.originalname || '')
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

/* =========================================================
   MULTER UPLOAD
========================================================= */

const upload = multer({
  storage,

  fileFilter: imageFileFilter,

  limits: {
    fileSize: 10 * 1024 * 1024,

    files: 1
  }
});

/* =========================================================
   CLOUDINARY UPLOAD HELPER
========================================================= */

function uploadToCloudinary(buffer, folder = 'rubavu-today') {
  console.log('[cloudinary] BEFORE upload UTC:', new Date().toISOString());
  console.log('[cloudinary] BEFORE upload epoch:', Math.floor(Date.now() / 1000));
  console.log('[cloudinary] SDK version:', require('cloudinary/package.json').version);
  console.log('[cloudinary] cloud_name:', cloudinary.config().cloud_name);

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'image'
      },
      (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      }
    );

    Readable.from(buffer).pipe(stream);
  });
}

/* =========================================================
   TOKEN
========================================================= */

function generateToken() {
  return crypto
    .randomBytes(32)
    .toString('hex');
}

/* =========================================================
   AUTHENTICATION
========================================================= */

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

    [rows] = await pool.query(
      `
        SELECT *
        FROM (
          SELECT
            id,
            full_name,
            email,
            phone,
            password,
            authToken,
            resetToken,
            resetExpires,
            created_at,
            NULL AS role,
            status,
            'admin' AS role_type
          FROM admins
          WHERE authToken = ?

          UNION ALL

          SELECT
            id,
            full_name,
            email,
            phone,
            password,
            authToken,
            resetToken,
            resetExpires,
            created_at,
            NULL AS role,
            status,
            'chief_editor' AS role_type
          FROM chief_editors
          WHERE authToken = ?

          UNION ALL

          SELECT
            id,
            full_name,
            email,
            phone,
            password,
            authToken,
            resetToken,
            resetExpires,
            created_at,
            role,
            status,
            'employee' AS role_type
          FROM employees
          WHERE authToken = ?
        ) AS users
        LIMIT 1
      `,
      [
        token,
        token,
        token
      ]
    );

    if (!rows.length) {
      return res.status(401).json({
        error:
          'Invalid or expired token.'
      });
    }

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

/* =========================================================
   ROLE MIDDLEWARE
========================================================= */

function requireAdmin(
  req,
  res,
  next
) {
  if (
    !req.user ||
    req.user.role_type !== 'admin'
  ) {
    return res.status(403).json({
      error:
        'Admin permission required.'
    });
  }

  next();
}

function requireChiefEditor(
  req,
  res,
  next
) {
  if (
    !req.user ||
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

function requirePostManagement(
  req,
  res,
  next
) {
  if (
    !req.user ||
    (
      req.user.role_type !== 'admin' &&
      req.user.role_type !== 'chief_editor'
    )
  ) {
    return res.status(403).json({
      error:
        'Admin or Chief Editor permission required.'
    });
  }

  next();
}

/* =========================================================
   ROOT ROUTE
========================================================= */

app.get(
  '/',
  (req, res) => {
    res.status(200).json({
      success: true,
      message:
        'Rubavu Today backend is running.',
      service:
        'rubavu-today-backend',
      version:
        '1.0.0'
    });
  }
);

app.head(
  '/',
  (req, res) => {
    res.status(200).end();
  }
);

/* =========================================================
   UPLOAD TEST ROUTE
========================================================= */

app.get(
  '/api/uploads',
  (req, res) => {
    try {
      const files =
        fs.readdirSync(
          uploadsDir
        );

      res.json({
        success: true,
        directory:
          uploadsDir,
        count:
          files.length,
        files
      });

    } catch (error) {
      console.error(
        'List uploads error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to list uploaded files.'
      });
    }
  }
);

function slugifyTitle(value) {
  if (value === undefined || value === null) {
    return '';
  }

  const normalized = String(value)
    .replace(/&/g, ' and ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/[\s_]+/g, ' ')
    .trim();

  if (!normalized) {
    return '';
  }

  return normalized
    .split(' ')
    .filter(Boolean)
    .join('-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function ensureUniqueSlug(title, fallbackId = null) {
  const base = slugifyTitle(title) || `post-${fallbackId || Date.now()}`;
  let slug = base;
  let counter = 2;

  while (true) {
    const [rows] = await getPool().query(
      `
        SELECT id
        FROM posts
        WHERE slug = ?
          AND (? IS NULL OR id != ?)
        LIMIT 1
      `,
      [slug, fallbackId, fallbackId]
    );

    if (!rows.length) {
      return slug;
    }

    slug = `${base}-${counter}`;
    counter += 1;
  }
}

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

app.get(
  '/sitemap.xml',
  async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `
          SELECT slug, createdDate
          FROM posts
          WHERE status = 'approved'
            AND slug IS NOT NULL
            AND slug != ''
          ORDER BY createdDate DESC, id DESC
        `
      );

      const urls = [
        `  <url>\n    <loc>https://rubavutoday.com/</loc>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>`,
        ...rows.map((post) => {
          const loc = `https://rubavutoday.com/${post.slug}.html`;
          const lastmod = post.createdDate
            ? `\n    <lastmod>${new Date(post.createdDate).toISOString()}</lastmod>`
            : '';

          return `  <url>\n    <loc>${escapeXml(loc)}</loc>${lastmod}\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>`;
        }),
      ];

      const sitemap = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        urls.join('\n'),
        '</urlset>',
      ].join('\n');

      res.set({
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      });

      return res.send(sitemap);
    } catch (error) {
      console.error('Sitemap generation error:', error);
      return res.status(500).type('application/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?><error>Sitemap unavailable</error>'
      );
    }
  }
);

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
          [
            req.params.id
          ]
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

app.get(
  '/api/posts/slug/:slug',
  async (req, res) => {
    try {
      const normalizedSlug = String(req.params.slug || '').replace(/\.html$/i, '');

      const [rows] = await getPool().query(
        `
          SELECT *
          FROM posts
          WHERE slug = ?
            AND status = 'approved'
          LIMIT 1
        `,
        [normalizedSlug]
      );

      if (!rows.length) {
        return res.status(404).json({
          error: 'Post not found.'
        });
      }

      res.json(rows[0]);
    } catch (error) {
      console.error('Fetch post by slug error:', error);
      res.status(500).json({
        error: 'Unable to fetch post.'
      });
    }
  }
);

app.get(
  '/post/:id',
  async (req, res) => {
    try {
      const postId = parseInt(req.params.id, 10);

      if (!postId || postId <= 0) {
        return res.status(404).send('Article not found');
      }

      const [rows] = await getPool().query(
        `
          SELECT *
          FROM posts
          WHERE id = ?
            AND status = 'approved'
          LIMIT 1
        `,
        [postId]
      );

      if (!rows.length) {
        return res.status(404).send('Article not found');
      }

      const post = rows[0];

      const appUrl = process.env.PUBLIC_URL || process.env.FRONTEND_URL || 'https://rubavutoday.com';
      const backendUrl = process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`;

      const title = post.title || 'Rubavu Today';
      const description = getArticleDescription(post, title);
      const ogImage = getArticleImageUrl(post.image, backendUrl);

      const canonicalUrl = `${appUrl}/post/${post.id}`;

      const postDate = post.createdDate || post.created_at || post.createdAt || post.date;
      const publishedTime = postDate ? new Date(postDate).toISOString() : '';

      const escaped = {
        title: escapeHtml(title),
        description: escapeHtml(description),
        ogImage: escapeHtml(ogImage),
        canonicalUrl: escapeHtml(canonicalUrl),
        author: escapeHtml(post.Author || 'Rubavu Today'),
        category: escapeHtml(post.category || ''),
        publishedTime: escapeHtml(publishedTime),
      };

      const metaTags = [
        `<title>${escaped.title} | Rubavu Today</title>`,
        `<meta name="description" content="${escaped.description}" />`,
        `<meta name="robots" content="index, follow" />`,
        `<link rel="canonical" href="${escaped.canonicalUrl}" />`,

        `<meta property="og:type" content="article" />`,
        `<meta property="og:title" content="${escaped.title}" />`,
        `<meta property="og:description" content="${escaped.description}" />`,
        `<meta property="og:image" content="${escaped.ogImage}" />`,
        `<meta property="og:image:alt" content="${escaped.title}" />`,
        `<meta property="og:url" content="${escaped.canonicalUrl}" />`,
        `<meta property="og:site_name" content="Rubavu Today" />`,

        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:title" content="${escaped.title}" />`,
        `<meta name="twitter:description" content="${escaped.description}" />`,
        `<meta name="twitter:image" content="${escaped.ogImage}" />`,
      ];

      if (escaped.publishedTime) {
        metaTags.push(`<meta property="article:published_time" content="${escaped.publishedTime}" />`);
      }

      if (escaped.author) {
        metaTags.push(`<meta property="article:author" content="${escaped.author}" />`);
      }

      if (escaped.category) {
        metaTags.push(`<meta property="article:section" content="${escaped.category}" />`);
      }

      const frontendUrl = `${appUrl}/post/${post.id}`;

      const html = `<!DOCTYPE html>
<html lang="rw">
<head>
<meta charset="utf-8" />
${metaTags.join('\n')}
</head>
<body>
<p>Redirecting to article...</p>
<script>window.location.href=${JSON.stringify(frontendUrl)};</script>
<noscript><meta http-equiv="refresh" content="0;url=${frontendUrl}" /></noscript>
</body>
</html>`;

      res.set({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'Link': `<${canonicalUrl}>; rel="canonical"`,
      });

      return res.send(html);
    } catch (error) {
      console.error('Post SEO page error:', error);
      return res.status(500).send('Unable to load article');
    }
  }
);

app.get(
  '/:slug.html',
  async (req, res) => {
    const slug = String(req.params.slug || '').replace(/\.html$/i, '');

    if (!slug) {
      return res.status(404).send('Article not found');
    }

    try {
      const [rows] = await getPool().query(
        `
          SELECT *
          FROM posts
          WHERE slug = ?
          LIMIT 1
        `,
        [slug]
      );

      if (!rows.length) {
        return res.status(404).send('Article not found');
      }

      if (rows[0].status !== 'approved') {
        return res.status(404).send('Article not found');
      }

      const post = rows[0];
      const appUrl = process.env.PUBLIC_URL || process.env.FRONTEND_URL || 'https://rubavutoday.com';
      const backendUrl = process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`;
      const canonical = new URL(`/${slug}.html`, appUrl).toString();

      const ogImage = getArticleImageUrl(post.image, backendUrl);

      const title = escapeHtml(post.title || 'Rubavu Today');
      const description = escapeHtml(getArticleDescription(post, post.title || 'Rubavu Today'));
      const ogImageEscaped = escapeHtml(ogImage);
      const author = escapeHtml(post.Author || 'Rubavu Today');
      const category = escapeHtml(post.category || '');
      const postDate = post.createdDate || post.created_at || post.createdAt || post.date;
      const publishedTime = postDate ? new Date(postDate).toISOString() : '';
      const frontendUrl = `${appUrl}/${slug}.html`;

      const metaTags = [
        `<title>${title} | Rubavu Today</title>`,
        `<meta name="description" content="${description}" />`,
        `<meta name="robots" content="index, follow" />`,
        `<link rel="canonical" href="${escapeHtml(canonical)}" />`,
        `<meta property="og:type" content="article" />`,
        `<meta property="og:title" content="${title}" />`,
        `<meta property="og:description" content="${description}" />`,
        `<meta property="og:image" content="${ogImageEscaped}" />`,
        `<meta property="og:image:alt" content="${title}" />`,
        `<meta property="og:url" content="${escapeHtml(canonical)}" />`,
        `<meta property="og:site_name" content="Rubavu Today" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:title" content="${title}" />`,
        `<meta name="twitter:description" content="${description}" />`,
        `<meta name="twitter:image" content="${ogImageEscaped}" />`,
      ];

      if (publishedTime) {
        metaTags.push(`<meta property="article:published_time" content="${escapeHtml(publishedTime)}" />`);
      }
      if (author) {
        metaTags.push(`<meta property="article:author" content="${author}" />`);
      }
      if (category) {
        metaTags.push(`<meta property="article:section" content="${category}" />`);
      }

      const html = `<!DOCTYPE html>
<html lang="rw">
<head>
<meta charset="utf-8" />
${metaTags.join('\n')}
</head>
<body>
<p>Redirecting to article...</p>
<script>window.location.href=${JSON.stringify(frontendUrl)};</script>
<noscript><meta http-equiv="refresh" content="0;url=${frontendUrl}" /></noscript>
</body>
</html>`;

      res.set({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'Link': `<${canonical}>; rel="canonical"`,
      });

      res.send(html);
    } catch (error) {
      console.error('Slug page error:', error);
      res.status(500).send('Unable to load article');
    }
  }
);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getArticleDescription(post, title) {
  const rawDescription = String(post.description || post.summary || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return rawDescription.slice(0, 200) || title;
}

function getArticleImageUrl(image, backendUrl) {
  const value = String(image || '').trim();

  if (!value) {
    return 'https://rubavutoday.com/Rubavu.jpeg';
  }

  if (/^https?:\/\//i.test(value)) {
    return value.replace(/^http:\/\//i, 'https://');
  }

  return `${backendUrl}${value.startsWith('/') ? '' : '/'}${value}`;
}

/* =========================================================
   CHIEF EDITOR DASHBOARD
========================================================= */

app.get(
  '/api/chief-editor/dashboard',
  requireAuth,
  requirePostManagement,
  async (req, res) => {
    try {
      const pool = getPool();

      const [[totalResult]] =
        await pool.query(
          `
            SELECT COUNT(*) AS total
            FROM posts
          `
        );

      const [[pendingResult]] =
        await pool.query(
          `
            SELECT COUNT(*) AS total
            FROM posts
            WHERE status = 'pending'
          `
        );

      const [[approvedResult]] =
        await pool.query(
          `
            SELECT COUNT(*) AS total
            FROM posts
            WHERE status = 'approved'
          `
        );

      const [[rejectedResult]] =
        await pool.query(
          `
            SELECT COUNT(*) AS total
            FROM posts
            WHERE status = 'rejected'
          `
        );

      const [pendingPosts] =
        await pool.query(
          `
            SELECT
              p.*,
              p.Author AS author_name
            FROM posts p
            WHERE p.status = 'pending'
            ORDER BY p.id DESC
          `
        );

      res.json({
        totalPosts:
          Number(
            totalResult.total
          ),

        pendingReview:
          Number(
            pendingResult.total
          ),

        approved:
          Number(
            approvedResult.total
          ),

        rejected:
          Number(
            rejectedResult.total
          ),

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

/* =========================================================
   ADMIN POSTS
========================================================= */

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

/* =========================================================
   CHIEF EDITOR POSTS
========================================================= */

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

/* =========================================================
   APPROVE POST
========================================================= */

app.put(
  '/api/chief-editor/posts/:id/approve',
  requireAuth,
  requirePostManagement,
  async (req, res) => {
    try {
      const {
        id
      } = req.params;

      const pool =
        getPool();

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

/* =========================================================
   REJECT POST
========================================================= */

app.put(
  '/api/chief-editor/posts/:id/reject',
  requireAuth,
  requirePostManagement,
  async (req, res) => {
    try {
      const {
        id
      } = req.params;

      const {
        reason
      } = req.body;

      const pool =
        getPool();

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
          : `Post rejected by ${req.user.role_type ===
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

/* =========================================================
   RETURN POST TO REVIEW
========================================================= */

app.put(
  '/api/chief-editor/posts/:id/review',
  requireAuth,
  requirePostManagement,
  async (req, res) => {
    try {
      const {
        id
      } = req.params;

      const pool =
        getPool();

      const [existingRows] =
        await pool.query(
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

      await pool.execute(
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

/* =========================================================
   CREATE POST
========================================================= */

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

      let imageUrl = null;

      if (req.file) {
        try {
          const result = await uploadToCloudinary(
            req.file.buffer,
            'rubavu-today/posts'
          );

          imageUrl = result.secure_url;

          console.log(
            `[cloudinary] Post image uploaded: ${imageUrl}`
          );

        } catch (uploadError) {
          console.error(
            '[cloudinary] Post image upload failed:',
            uploadError
          );

          return res.status(500).json({
            error:
              'Failed to upload image to Cloudinary.'
          });
        }
      }

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
        postStatus ===
          'approved'
          ? req.user.full_name ||
          req.user.email ||
          null
          : null;

      const approvedAt =
        postStatus ===
          'approved'
          ? new Date()
          : null;

      const [result] =
        await getPool().execute(
          `
            INSERT INTO posts
            (
              title,
              slug,
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
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
          `,
          [
            String(title).trim(),
            '',
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

      const generatedSlug = await ensureUniqueSlug(String(title).trim(), result.insertId);

      await getPool().execute(
        `
          UPDATE posts
          SET slug = ?
          WHERE id = ?
        `,
        [generatedSlug, result.insertId]
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
          postStatus ===
            'pending'
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

/* =========================================================
   UPDATE POST
========================================================= */

app.put(
  '/api/posts/:id',
  requireAuth,
  upload.single('image'),
  async (req, res) => {
    try {
      const {
        id
      } = req.params;

      const {
        title,
        category,
        description,
        youtube_url,
        author
      } = req.body;

      const pool =
        getPool();

      const [existingRows] =
        await pool.query(
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

      let imageUrl =
        existing.image;

      if (req.file) {
        try {
          const result = await uploadToCloudinary(
            req.file.buffer,
            'rubavu-today/posts'
          );

          imageUrl = result.secure_url;

          console.log(
            `[cloudinary] Updated post image: ${imageUrl}`
          );

        } catch (uploadError) {
          console.error(
            '[cloudinary] Post image upload failed:',
            uploadError
          );

          return res.status(500).json({
            error:
              'Failed to upload image to Cloudinary.'
          });
        }
      }

      const updatedYoutubeUrl =
        youtube_url !==
          undefined
          ? youtube_url || null
          : existing.youtube_url;

      const updatedAuthor =
        author !==
          undefined &&
          String(author).trim()
          ? String(author).trim()
          : existing.Author;

      let updatedStatus =
        existing.status;

      let approvedBy =
        existing.approved_by;

      let approvedAt =
        existing.approved_at;

      let rejectionReason =
        existing.rejection_reason;

      if (
        req.user.role_type ===
        'employee'
      ) {
        updatedStatus =
          'pending';

        approvedBy =
          null;

        approvedAt =
          null;

        rejectionReason =
          null;
      }

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

      const incomingTitle = title !== undefined && String(title).trim()
        ? String(title).trim()
        : existing.title;

      const nextSlug = existing.slug || await ensureUniqueSlug(incomingTitle, Number(id));
      const normalizedUpdatedSlug = String(incomingTitle).trim()
        ? await ensureUniqueSlug(incomingTitle, Number(id))
        : nextSlug;

      await pool.execute(
        `
          UPDATE posts
          SET
            title = ?,
            slug = ?,
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
          incomingTitle,
          normalizedUpdatedSlug,

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

/* =========================================================
   DELETE POST
========================================================= */

app.delete(
  '/api/posts/:id',
  requireAuth,
  requirePostManagement,
  async (req, res) => {
    try {
      const {
        id
      } = req.params;

      const pool =
        getPool();

      const [existing] =
        await pool.query(
          `
            SELECT id, image
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

      await pool.execute(
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

/* =========================================================
   MY POSTS
========================================================= */

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

/* =========================================================
   COMMENTS
========================================================= */

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

app.delete(
  '/api/comments/:id',
  requireAuth,
  requirePostManagement,
  async (req, res) => {
    try {
      const {
        id
      } = req.params;

      const pool =
        getPool();

      const [existing] =
        await pool.query(
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

      await pool.execute(
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

/* =========================================================
   ADVERTISEMENTS
========================================================= */

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

      let imageUrl = null;

      if (req.file) {
        try {
          const result = await uploadToCloudinary(
            req.file.buffer,
            'rubavu-today/advertisements'
          );

          imageUrl = result.secure_url;

          console.log(
            `[cloudinary] Advertisement image uploaded: ${imageUrl}`
          );

        } catch (uploadError) {
          console.error(
            '[cloudinary] Advertisement image upload failed:',
            uploadError
          );

          return res.status(500).json({
            error:
              'Failed to upload image to Cloudinary.'
          });
        }
      }

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

app.put(
  '/api/advertisements/:id',
  requireAuth,
  requireAdmin,
  upload.single('image'),
  async (req, res) => {
    try {
      const {
        id
      } = req.params;

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

      const pool =
        getPool();

      const [existingRows] =
        await pool.query(
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

      let imageUrl =
        existing.image;

      if (req.file) {
        try {
          const result = await uploadToCloudinary(
            req.file.buffer,
            'rubavu-today/advertisements'
          );

          imageUrl = result.secure_url;

          console.log(
            `[cloudinary] Updated advertisement image: ${imageUrl}`
          );

        } catch (uploadError) {
          console.error(
            '[cloudinary] Advertisement image upload failed:',
            uploadError
          );

          return res.status(500).json({
            error:
              'Failed to upload image to Cloudinary.'
          });
        }
      }

      let finalLink =
        existing.target_url ||
        existing.link ||
        null;

      if (
        target_url !==
        undefined
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
          ? position || 'sidebar'
          : existing.position ||
          'sidebar';

      const finalStatus =
        status !== undefined
          ? status || 'active'
          : existing.status ||
          'active';

      const finalStartDate =
        start_date !==
          undefined
          ? start_date || null
          : existing.start_date;

      const finalEndDate =
        end_date !==
          undefined
          ? end_date || null
          : existing.end_date;

      const finalDescription =
        description !==
          undefined
          ? description
          : existing.description;

      const finalTitle =
        title !== undefined &&
          String(title).trim()
          ? String(title).trim()
          : existing.title;

      await pool.execute(
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
        await pool.query(
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

app.delete(
  '/api/advertisements/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        id
      } = req.params;

      const pool =
        getPool();

      const [existing] =
        await pool.query(
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

      await pool.execute(
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

/* =========================================================
   EMPLOYEES
========================================================= */

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

app.put(
  '/api/employees/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        id
      } = req.params;

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
        full_name !==
          undefined &&
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

app.delete(
  '/api/employees/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        id
      } = req.params;

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

/* =========================================================
   CHIEF EDITORS
========================================================= */

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

app.put(
  '/api/chief-editors/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        id
      } = req.params;

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

app.delete(
  '/api/chief-editors/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        id
      } = req.params;

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

/* =========================================================
   AUTH LOGIN
========================================================= */

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
      }

      if (!validPassword) {
        return res.status(401).json({
          error:
            'Invalid credentials.'
        });
      }

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

/* =========================================================
   AUTH ME
========================================================= */

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

/* =========================================================
   CHANGE PASSWORD
========================================================= */

app.put(
  '/api/auth/change-password',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        current_password,
        new_password
      } = req.body;

      if (
        !current_password ||
        !new_password
      ) {
        return res.status(400).json({
          error:
            'Current password and new password are required.'
        });
      }

      if (
        String(new_password).length <
        6
      ) {
        return res.status(400).json({
          error:
            'New password must be at least 6 characters.'
        });
      }

      if (
        !verifyPassword(
          current_password,
          req.user.password
        )
      ) {
        return res.status(401).json({
          error:
            'Current password is incorrect.'
        });
      }

      await getPool().execute(
        `
          UPDATE admins
          SET password = ?
          WHERE id = ?
        `,
        [
          hashPassword(
            new_password
          ),
          req.user.id
        ]
      );

      res.json({
        message:
          'Password changed successfully.'
      });

    } catch (error) {
      console.error(
        'Change admin password error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to change password.'
      });
    }
  }
);

/* =========================================================
   CHANGE EMAIL
========================================================= */

app.put(
  '/api/auth/change-email',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        new_email,
        current_password
      } = req.body;

      const cleanEmail =
        String(
          new_email || ''
        )
          .trim()
          .toLowerCase();

      if (
        !cleanEmail ||
        !current_password
      ) {
        return res.status(400).json({
          error:
            'New email and current password are required.'
        });
      }

      if (
        !/^\S+@\S+\.\S+$/.test(
          cleanEmail
        )
      ) {
        return res.status(400).json({
          error:
            'Please provide a valid email address.'
        });
      }

      if (
        !verifyPassword(
          current_password,
          req.user.password
        )
      ) {
        return res.status(401).json({
          error:
            'Current password is incorrect.'
        });
      }

      const [existing] =
        await getPool().query(
          `
            SELECT id
            FROM admins
            WHERE email = ?
            AND id <> ?
            LIMIT 1
          `,
          [
            cleanEmail,
            req.user.id
          ]
        );

      if (existing.length) {
        return res.status(409).json({
          error:
            'That email is already used by another admin.'
        });
      }

      await getPool().execute(
        `
          UPDATE admins
          SET email = ?
          WHERE id = ?
        `,
        [
          cleanEmail,
          req.user.id
        ]
      );

      res.json({
        message:
          'Email changed successfully.',

        user: {
          id:
            req.user.id,

          email:
            cleanEmail,

          full_name:
            req.user.full_name,

          phone:
            req.user.phone ||
            null,

          role:
            'admin',

          role_type:
            'admin'
        }
      });

    } catch (error) {
      console.error(
        'Change admin email error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to change email.'
      });
    }
  }
);

/* =========================================================
   LOGOUT
========================================================= */

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
        [
          req.user.id
        ]
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

/* =========================================================
   HEALTH
========================================================= */

app.get(
  '/api/health',
  (req, res) => {
    res.status(200).json({
      success:
        true,

      message:
        'Rubavu Today backend is running.',

      time:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   404 HANDLER
========================================================= */

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

/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

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

    return res.status(500).json({
      error:
        error.message ||
        'Internal server error.'
    });
  }
);

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {
  try {
    console.log(
      '[server] Initializing database...'
    );

    await init();

    console.log(
      '[server] Database initialization completed.'
    );

    console.log(
      `[server] Upload directory: ${uploadsDir}`
    );

    const server =
      app.listen(
        port,
        '0.0.0.0',
        () => {
          console.log(
            `Backend server is running on port ${port}`
          );

          console.log(
            `Uploads directory: ${uploadsDir}`
          );

          console.log(
            `Health endpoint: /api/health`
          );

          console.log(
            `Uploads endpoint: /uploads/`
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
            `[FATAL] Port ${port} is already in use.`
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
