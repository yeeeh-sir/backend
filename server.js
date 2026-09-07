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
const https = require('https');

const { chatWithGemini, chatSirGPT } = require('./services/geminiService');

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
   AI WEBSITE ASSISTANT — Google Gemini
========================================================= */

app.post('/api/ai/chat', async (req, res) => {
  const question = String(req.body?.question || '').trim();
  const history = Array.isArray(req.body?.history)
    ? req.body.history.slice(-8)
    : [];

  if (!question) {
    return res.status(400).json({ error: 'Question is required.' });
  }

  if (question.length > 1000) {
    return res.status(400).json({ error: 'Question is too long. Maximum 1000 characters.' });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({
      error: 'AI model is not configured.',
      code: 'AI_NOT_CONFIGURED'
    });
  }

  try {
    const result = await chatWithGemini({ question, history });
    return res.json(result);
  } catch (error) {
    console.error('[ai] Gemini request failed:', error.message || error);
    return res.status(502).json({
      error: 'Mbabarira, serivisi ya AI ntabwo iri kuboneka ubu. Ongera ugerageze nyuma.'
    });
  }
});

/* =========================================================
   SIR GPT — GENERAL-PURPOSE AI (Gemini)
========================================================= */

app.post('/api/sir-gpt', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({
        error: 'AI model is not configured.',
        code: 'AI_NOT_CONFIGURED'
      });
    }

    const reply = await chatSirGPT(message);

    if (!reply) {
      return res.status(502).json({ error: 'AI returned an empty response' });
    }

    res.json({ reply });

  } catch (error) {
    console.error('[sir-gpt] Error:', error.message || error);
    res.status(500).json({ error: 'Failed to get response from Sir GPT' });
  }
});

/* =========================================================
   UPLOADS DIRECTORY
========================================================= */

const uploadsDir = path.resolve(
  __dirname,
  'uploads'
);

const profileUploadsDir = path.join(
  uploadsDir,
  'profiles'
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

  if (!fs.existsSync(profileUploadsDir)) {
    fs.mkdirSync(profileUploadsDir, {
      recursive: true
    });
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
    fileSize: 15 * 1024 * 1024,

    files: 12
  }
});

const profileUpload = multer({
  storage: multer.diskStorage({
    destination: profileUploadsDir,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname || '').toLowerCase();
      callback(null, `profile-${req.user.id}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${extension}`);
    }
  }),
  fileFilter: imageFileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1
  }
});

/* =========================================================
   CLOUDINARY CLOCK SKEW
========================================================= */

/* Cloudinary signs every upload with a UNIX timestamp. If the host clock is
   skewed from real time (common on virtual machines without NTP), Cloudinary
   rejects the signature and the upload fails with the generic "Failed to
   upload image to Cloudinary." We measure the offset once against an external
   time source and pass a corrected `timestamp` on every upload.

   The measurement is best-effort: if it fails we keep skew = 0 and uploads
   behave exactly as before (rely on the OS clock being correct). */

let cloudinarySkewMs = 0;
let skewMeasurementStarted = false;

function measureCloudinarySkew() {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: 'www.google.com',
        path: '/',
        method: 'HEAD',
        timeout: 8000,
      },
      (res) => {
        const dateHeader = res.headers['date'];
        res.resume();

        if (dateHeader) {
          const realMs = Date.parse(dateHeader);
          if (!Number.isNaN(realMs)) {
            const skew = realMs - Date.now();

            /* Sanity guard: ignore measurements outside a sane window so a
               proxy/bad response can never corrupt uploads. */
            if (Math.abs(skew) < 24 * 60 * 60 * 1000) {
              cloudinarySkewMs = skew;
              console.log('[cloudinary] measured clock skew (ms):', cloudinarySkewMs);
            }
          }
        }

        resolve();
      }
    );

    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });

    req.end();
  });
}

function ensureCloudinaryClockSkewMeasured() {
  if (skewMeasurementStarted) return;
  skewMeasurementStarted = true;
  measureCloudinarySkew();
}

/* =========================================================
   CLOUDINARY UPLOAD HELPER
========================================================= */

function validateCloudinaryConfig() {
  const config = cloudinary.config();
  const missing = [];

  if (!config.cloud_name) missing.push('CLOUDINARY_CLOUD_NAME');
  if (!config.api_key) missing.push('CLOUDINARY_API_KEY');
  if (!config.api_secret) missing.push('CLOUDINARY_API_SECRET');

  if (missing.length > 0) {
    throw new Error(`Cloudinary configuration is missing: ${missing.join(', ')}`);
  }

  return config;
}

function uploadToCloudinary(buffer, folder = 'rubavu-today') {
  console.log('[cloudinary] BEFORE upload UTC:', new Date().toISOString());
  console.log('[cloudinary] BEFORE upload epoch:', Math.floor(Date.now() / 1000));
  console.log('[cloudinary] SDK version:', require('cloudinary/package.json').version);

  /* Kick off (once) a lazily triggered clock-skew measurement if the startup
     measurement did not run yet. */
  ensureCloudinaryClockSkewMeasured();

  try {
    const config = validateCloudinaryConfig();
    console.log('[cloudinary] cloud_name:', config.cloud_name);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    /* Corrected UNIX timestamp (seconds) so Cloudinary's signature check
       passes even when the host clock is behind/ahead of real time. */
    const correctedEpoch = Math.floor((Date.now() + cloudinarySkewMs) / 1000);

    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'image',
        timestamp: correctedEpoch,
      },
      (error, result) => {
        if (error) {
          console.error('[cloudinary] upload_stream error:', error && error.message || error);
          reject(error);
        } else {
          resolve(result);
        }
      }
    );

    Readable.from(buffer).pipe(stream);
  });
}

function uploadImagesToCloudinary(files, folder = 'rubavu-today/posts') {
  const list = Array.isArray(files) ? files : [];

  return Promise.all(
    list.map(async (file) => {
      if (!file || !file.buffer) {
        return null;
      }

      const result = await uploadToCloudinary(file.buffer, folder);

      return result && result.secure_url
        ? result.secure_url
        : null;
    })
  ).then((urls) =>
    urls.filter(Boolean)
  );
}

function normalizeProfileImageValue(value) {
  if (typeof value !== 'string') {
    return value || null;
  }

  const trimmed = value.trim();

  return trimmed || null;
}

const ALLOWED_IMAGE_POSITIONS = new Set([
  'header',
  'full',
  'center',
  'left',
  'right',
  'inline',
  'gallery',
]);

const ALLOWED_BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'image',
  'quote',
  'divider',
  'video',
]);

function sanitizeBlock(block) {
  if (!block || typeof block !== 'object') {
    return null;
  }

  if (!ALLOWED_BLOCK_TYPES.has(block.type)) {
    return null;
  }

  const clean = {
    type: block.type,
  };

  if (block.type === 'paragraph') {
    clean.text = String(block.text || '').trim().slice(0, 50000);

    if (!clean.text) {
      return null;
    }
  }

  if (block.type === 'heading') {
    clean.text = String(block.text || '').trim().slice(0, 500);

    if (!clean.text) {
      return null;
    }
  }

  if (block.type === 'quote') {
    clean.text = String(block.text || '').trim().slice(0, 5000);

    if (!clean.text) {
      return null;
    }
  }

  if (block.type === 'divider') {
    return { type: 'divider' };
  }

  if (block.type === 'video') {
    clean.url = String(block.url || '').trim().slice(0, 2000);

    if (!clean.url) {
      return null;
    }
  }

  if (block.type === 'image') {
    clean.url = String(block.url || '').trim().slice(0, 2000);
    clean.position = ALLOWED_IMAGE_POSITIONS.has(block.position)
      ? block.position
      : 'center';
    clean.caption = String(block.caption || '').slice(0, 3000).trim();
    clean.alt = String(block.alt || '').slice(0, 500).trim();
    clean.fileKey = String(block.fileKey || '').slice(0, 20);
    clean.uploadIndex =
      Number.isInteger(block.uploadIndex) && block.uploadIndex >= 0
        ? block.uploadIndex
        : null;
  }

  return clean;
}

function sanitizeContentBlocks(raw) {
  if (!raw) {
    return null;
  }

  let list = null;

  try {
    list = JSON.parse(raw);
  } catch (e) {
    return null;
  }

  if (!Array.isArray(list)) {
    return null;
  }

  const cleaned = list
    .map(sanitizeBlock)
    .filter(Boolean)
    .slice(0, 200);

  return cleaned.length > 0 ? cleaned : null;
}

function resolveBlockImages(blocks, uploadedUrls) {
  let nextIndex = 0;

  return blocks.map((block) => {
    if (block.type !== 'image') {
      return block;
    }

    const resolved = { ...block };

    const fileIndex =
      typeof resolved.uploadIndex === 'number'
        ? resolved.uploadIndex
        : null;

    if (fileIndex !== null && uploadedUrls[fileIndex]) {
      resolved.url = uploadedUrls[fileIndex];
    }

    delete resolved.fileKey;
    delete resolved.uploadIndex;

    if (!resolved.url) {
      return null;
    }

    nextIndex += 1;

    return resolved;
  }).filter(Boolean);
}

function pickHeaderImage(blocks, fallbackUrl) {
  if (fallbackUrl) {
    return fallbackUrl;
  }

  const first = blocks.find(
    (block) =>
      block.type === 'image' &&
      block.position === 'header' &&
      block.url
  );

  if (first) {
    return first.url;
  }

  const anyImage = blocks.find(
    (block) =>
      block.type === 'image' &&
      block.url
  );

  return anyImage ? anyImage.url : null;
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
            profile_image,
            profile_image_url,
            profile_image_public_id,
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
            profile_image,
            profile_image_url,
            profile_image_public_id,
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
            profile_image,
            profile_image_url,
            profile_image_public_id,
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
    .replace(/[â€™'`]/g, '')
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

async function attachPostAuthors(posts) {
  const list = Array.isArray(posts) ? posts : [];
  const authorNames = [...new Set(
    list
      .map((post) => post?.Author || post?.author_name || '')
      .map((name) => String(name).trim())
      .filter(Boolean)
  )];

  const authorMap = new Map();

  if (authorNames.length) {
    const placeholders = authorNames.map(() => '?').join(', ');
    const [matches] = await getPool().query(
      `
        SELECT id, full_name, profile_image, profile_image_url, role_type
        FROM (
          SELECT id, full_name, profile_image, profile_image_url, 'admin' AS role_type
          FROM admins
          WHERE full_name IN (${placeholders})

          UNION ALL

          SELECT id, full_name, profile_image, profile_image_url, 'chief_editor' AS role_type
          FROM chief_editors
          WHERE full_name IN (${placeholders})

          UNION ALL

          SELECT id, full_name, profile_image, profile_image_url, 'employee' AS role_type
          FROM employees
          WHERE full_name IN (${placeholders})
        ) AS authors
        ORDER BY full_name, role_type
      `,
      [...authorNames, ...authorNames, ...authorNames]
    );

    for (const match of matches) {
      const name = String(match.full_name || '').trim();
      const existing = authorMap.get(name) || [];
      existing.push(match);
      authorMap.set(name, existing);
    }
  }

  return list.map((post) => {
    const name = String(
      post?.Author ||
      post?.author_name ||
      (typeof post?.author === 'string' ? post.author : '') ||
      'Rubavu Today'
    ).trim();
    const matches = authorMap.get(name) || [];
    const matchedAuthor = matches.length === 1 ? matches[0] : null;
    const existingImage =
      post?.author_profile_image_url ||
      post?.author_profile_image ||
      null;

    return {
      ...post,
      author: {
        id: matchedAuthor?.id || null,
        name,
        role: matchedAuthor?.role_type || 'unknown',
        profile_image:
          existingImage ||
          matchedAuthor?.profile_image_url ||
          matchedAuthor?.profile_image ||
          null,
      },
      author_profile_image:
        existingImage ||
        matchedAuthor?.profile_image_url ||
        matchedAuthor?.profile_image ||
        null,
    };
  });
}

app.get(
  '/api/posts',
  async (req, res) => {
    try {
      const [rows] =
        await getPool().query(
          `
            SELECT
              id,
              title,
              slug,
              category,
              image,
              createdDate,
              youtube_url,
              Author,
              author_profile_image,
              status,
              SUBSTRING(description, 1, 400) AS description
            FROM posts
            WHERE status = 'approved'
            ORDER BY id DESC
          `
        );

      res.json(await attachPostAuthors(rows));

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

      res.json((await attachPostAuthors(rows))[0]);

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

      res.json((await attachPostAuthors(rows))[0]);
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

      const rawTitle = post.title || 'Rubavu Today';
      const rawDescription = getArticleDescription(post, rawTitle);
      const ogImage = getArticleImageUrl(
        post.image || post.image_url || post.imageUrl || post.featured_image,
        backendUrl
      );

      const canonicalUrl = post.slug
        ? `${appUrl}/${post.slug}.html`
        : `${appUrl}/post/${post.id}`;

      // Serve metadata to social crawlers; redirect real human
      // visitors to the React SPA route so they never see the bot
      // page or hit a redirect loop on a proxied .html URL.
      if (!isSocialCrawler(req)) {
        return res.redirect(
          302,
          `${appUrl}/post/${post.id}`
        );
      }

      const postDate = post.createdDate || post.created_at || post.createdAt || post.date;
      const publishedTime = postDate ? new Date(postDate).toISOString() : '';

      const escaped = {
        title: escapeHtml(rawTitle),
        description: escapeHtml(rawDescription),
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
        `<link rel="icon" type="image/jpeg" href="https://rubavutoday.com/favicon.jpg" />`,
        `<link rel="apple-touch-icon" href="https://rubavutoday.com/favicon.jpg" />`,

        `<meta property="og:type" content="article" />`,
        `<meta property="og:title" content="${escaped.title}" />`,
        `<meta property="og:description" content="${escaped.description}" />`,
        `<meta property="og:image" content="${escaped.ogImage}" />`,
        `<meta property="og:image:secure_url" content="${escaped.ogImage}" />`,
        `<meta property="og:image:alt" content="${escaped.title}" />`,
        `<meta property="og:url" content="${escaped.canonicalUrl}" />`,
        `<meta property="og:site_name" content="Rubavu Today" />`,

        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:title" content="${escaped.title}" />`,
        `<meta name="twitter:description" content="${escaped.description}" />`,
        `<meta name="twitter:image" content="${escaped.ogImage}" />`,
        `<meta name="twitter:image:alt" content="${escaped.title}" />`,
      ];

      const articleLd = getArticleJsonLd(
        post,
        canonicalUrl,
        ogImage,
        rawTitle,
        rawDescription
      );

      if (escaped.publishedTime) {
        metaTags.push(`<meta property="article:published_time" content="${escaped.publishedTime}" />`);
      }

      if (escaped.author) {
        metaTags.push(`<meta property="article:author" content="${escaped.author}" />`);
      }

      if (escaped.category) {
        metaTags.push(`<meta property="article:section" content="${escaped.category}" />`);
      }

      const frontendUrl = post.slug
        ? `${appUrl}/${post.slug}.html`
        : `${appUrl}/post/${post.id}`;

      const html = `<!DOCTYPE html>
<html lang="rw">
<head>
<meta charset="utf-8" />
${metaTags.join('\n')}
<script type="application/ld+json">${articleLd}</script>
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

      // Serve the metadata page to social crawlers, but let real
      // human visitors reach the React app without hitting a redirect
      // loop (the frontend host proxies .html routes to this backend).
      if (!isSocialCrawler(req)) {
        return res.redirect(
          302,
          `${appUrl}/post/${post.id}`
        );
      }

      const ogImage = getArticleImageUrl(
        post.image || post.image_url || post.imageUrl || post.featured_image,
        backendUrl
      );

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
        `<link rel="icon" type="image/jpeg" href="https://rubavutoday.com/favicon.jpg" />`,
        `<link rel="apple-touch-icon" href="https://rubavutoday.com/favicon.jpg" />`,
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

      const articleLd = getArticleJsonLd(
        post,
        canonical,
        ogImage,
        post.title || 'Rubavu Today',
        getArticleDescription(post, post.title || 'Rubavu Today')
      );

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
<script type="application/ld+json">${articleLd}</script>
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

function isSocialCrawler(req) {
  const ua = String(
    req.headers['user-agent'] || ''
  );
  if (!ua) return false;

  return /(whatsapp|facebookexternalhit|facebot|twitterbot|telegrambot|slackbot|discordbot|linkedinbot|pinterest|tumblr|skypeuripreview|snapchat|line-poker|viber|wechat|applebot|redditbot|baiduspider|googlebot|bingbot|duckduckbot|yandex|msnbot|ia_archiver|curl|wget|python-requests)/i.test(
    ua
  );
}

function getArticleJsonLd(post, canonicalUrl, image, title, description) {
  const postDate = post.createdDate || post.created_at || post.createdAt || post.date;
  const modifiedDate = post.updatedDate || post.updated_at || post.updatedAt || postDate;
  const publishedTime = postDate ? new Date(postDate).toISOString() : undefined;
  const modifiedTime = modifiedDate ? new Date(modifiedDate).toISOString() : undefined;

  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: title,
    description,
    image: [image],
    url: canonicalUrl,
    ...(publishedTime ? { datePublished: publishedTime } : {}),
    ...(modifiedTime ? { dateModified: modifiedTime } : {}),
    author: {
      '@type': 'Person',
      name: post.Author || post.author || post.author_name || 'Rubavu Today',
    },
    publisher: {
      '@type': 'Organization',
      name: 'Rubavu Today',
      url: 'https://rubavutoday.com/',
      logo: {
        '@type': 'ImageObject',
        url: 'https://rubavutoday.com/Rubavu.jpeg',
      },
    },
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': canonicalUrl,
    },
  }).replace(/</g, '\\u003c');
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

app.get(
  '/api/admin/posts/:id',
  requireAuth,
  requirePostManagement,
  async (req, res) => {
    try {
      const [rows] =
        await getPool().query(
          `
            SELECT *
            FROM posts
            WHERE id = ?
          `,
          [req.params.id]
        );

      if (!rows.length) {
        return res.status(404).json({
          error: 'Post not found.'
        });
      }

      res.json(rows[0]);

    } catch (error) {
      console.error(
        'Admin fetch single post error:',
        error
      );

      res.status(500).json({
        error: 'Unable to fetch post.'
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
  upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'images', maxCount: 11 }
  ]),
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
      let images = [];

      const rawBlocks = sanitizeContentBlocks(req.body.content_blocks);
      let blocks = rawBlocks
        ? rawBlocks.map((block) => ({ ...block }))
        : null;

      const featuredFile =
        req.files &&
          req.files.image &&
          req.files.image[0]
          ? req.files.image[0]
          : null;

      const galleryFiles =
        req.files &&
          req.files.images
          ? req.files.images
          : [];

      if (featuredFile) {
        try {
          const result = await uploadToCloudinary(
            featuredFile.buffer,
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

      const uploadedUrls = [];

      if (galleryFiles.length > 0) {
        try {
          for (const file of galleryFiles) {
            try {
              const result = await uploadToCloudinary(
                file.buffer,
                'rubavu-today/posts'
              );

              uploadedUrls.push(result.secure_url);
            } catch (fileError) {
              console.error(
                '[cloudinary] One extra post image failed:',
                fileError
              );

              uploadedUrls.push(null);
            }
          }

          console.log(
            `[cloudinary] ${uploadedUrls.filter(Boolean).length} extra post images uploaded`
          );

        } catch (uploadError) {
          console.error(
            '[cloudinary] Extra post images upload failed:',
            uploadError
          );

          return res.status(500).json({
            error:
              'Failed to upload post images to Cloudinary.'
          });
        }
      }

      if (blocks) {
        blocks = resolveBlockImages(blocks, uploadedUrls);

        images = images.concat(
          blocks
            .filter((block) => block.type === 'image' && block.url)
            .map((block) => block.url)
        );

        if (!imageUrl) {
          imageUrl = pickHeaderImage(blocks, null);
        }
      } else {
        images = images.concat(uploadedUrls.filter(Boolean));

        if (!imageUrl && uploadedUrls.length > 0) {
          imageUrl = uploadedUrls[0];
        }
      }

      const imagesJson = images.length > 0
        ? JSON.stringify(images)
        : null;

      const blocksJson = blocks && blocks.length > 0
        ? JSON.stringify(blocks)
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

      const authorProfileImage =
        req.user.profile_image ||
        null;

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
              images,
              content_blocks,
              createdDate,
              youtube_url,
              Author,
              author_profile_image,
              status,
              rejection_reason,
              approved_by,
              approved_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
          `,
          [
            String(title).trim(),
            '',
            String(category).trim(),
            description,
            imageUrl,
            imagesJson,
            blocksJson,
            new Date(),
            youtube_url || null,
            authorName,
            authorProfileImage,
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
  upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'images', maxCount: 11 }
  ]),
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

      const userRole =
        String(
          req.user?.role_type || ''
        ).trim();

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
        userRole === 'employee'
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

      if (
        !['admin', 'chief_editor'].includes(userRole) &&
        userRole !== 'employee'
      ) {
        return res.status(403).json({
          error:
            'You are not allowed to edit posts.'
        });
      }

      let imageUrl =
        existing.image;

      let images = [];

      try {
        const parsed =
          existing.images
            ? JSON.parse(existing.images)
            : [];

        images = Array.isArray(parsed)
          ? parsed
          : [];
      } catch (e) {
        images = [];
      }

      let existingBlocks = null;

      try {
        const parsedBlocks =
          existing.content_blocks
            ? JSON.parse(existing.content_blocks)
            : null;

        existingBlocks = Array.isArray(parsedBlocks)
          ? parsedBlocks
          : null;
      } catch (e) {
        existingBlocks = null;
      }

      const incomingBlocks = sanitizeContentBlocks(req.body.content_blocks);
      const blocksChanged =
        req.body.content_blocks !== undefined &&
        req.body.content_blocks !== '';

      let blocks = blocksChanged ? incomingBlocks : existingBlocks;

      const featuredFile =
        req.files &&
          req.files.image &&
          req.files.image[0]
          ? req.files.image[0]
          : null;

      const galleryFiles =
        req.files &&
          req.files.images
          ? req.files.images
          : [];

      if (featuredFile) {
        try {
          const result = await uploadToCloudinary(
            featuredFile.buffer,
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

      const uploadedUrls = [];

      if (galleryFiles.length > 0) {
        try {
          for (const file of galleryFiles) {
            try {
              const result = await uploadToCloudinary(
                file.buffer,
                'rubavu-today/posts'
              );

              uploadedUrls.push(result.secure_url);
            } catch (fileError) {
              console.error(
                '[cloudinary] One extra post image failed:',
                fileError
              );

              uploadedUrls.push(null);
            }
          }

          console.log(
            `[cloudinary] ${uploadedUrls.filter(Boolean).length} extra post images uploaded`
          );

        } catch (uploadError) {
          console.error(
            '[cloudinary] Extra post images upload failed:',
            uploadError
          );

          return res.status(500).json({
            error:
              'Failed to upload post images to Cloudinary.'
          });
        }
      }

      if (blocks) {
        blocks = resolveBlockImages([...blocks], uploadedUrls);

        images = blocks
          .filter((block) => block.type === 'image' && block.url)
          .map((block) => block.url);

        if (!imageUrl) {
          imageUrl = pickHeaderImage(blocks, existing.image);
        }
      } else if (galleryFiles.length > 0) {
        images = images.concat(uploadedUrls.filter(Boolean));

        if (!imageUrl && uploadedUrls.length > 0) {
          imageUrl = uploadedUrls[0];
        }
      }

      const imagesJson = images.length > 0
        ? JSON.stringify(images)
        : null;

      const blocksJson = blocks && blocks.length > 0
        ? JSON.stringify(blocks)
        : null;

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
        const requestedStatus = String(
          req.body?.status || ''
        ).trim().toLowerCase();

        const validStatuses = [
          'approved',
          'pending',
          'rejected',
        ];

        let nextStatus = existing.status;

        if (validStatuses.includes(requestedStatus)) {
          nextStatus = requestedStatus;
        } else if (existing.status === 'approved') {
          nextStatus = 'approved';
        }

        updatedStatus = nextStatus;

        if (nextStatus === 'approved') {
          approvedBy =
            req.user.full_name ||
            req.user.email;

          approvedAt =
            existing.approved_at ||
            new Date();

          rejectionReason =
            null;
        } else if (nextStatus === 'rejected') {
          approvedBy = null;
          approvedAt = null;
          rejectionReason =
            existing.rejection_reason ||
            'Post was sent back for revision.';
        } else {
          approvedBy = null;
          approvedAt = null;
          rejectionReason = null;
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
            images = ?,
            content_blocks = ?,
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

          imagesJson,

          blocksJson,

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
      const deviceId =
        String(
          req.query.device_id ||
          ''
        ).slice(0, 64) || null;

      const [rows] =
        await getPool().query(
          `
            SELECT
              c.*,
              COUNT(
                CASE
                  WHEN r.reaction = 'like'
                  THEN 1
                END
              ) AS likes,
              COUNT(
                CASE
                  WHEN r.reaction =
                    'dislike'
                  THEN 1
                END
              ) AS dislikes,
              MAX(
                CASE
                  WHEN r.device_id = ?
                  THEN r.reaction
                END
              ) AS my_reaction
            FROM comments c
            LEFT JOIN comment_reactions r
              ON r.comment_id = c.id
            WHERE c.post_id = ?
            GROUP BY c.id
            ORDER BY c.created_at ASC
          `,
          [deviceId, req.params.postId]
        );

      res.set(
        'Cache-Control',
        'no-store, no-cache, must-revalidate'
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
  '/api/comments/:id/reaction',
  async (req, res) => {
    try {
      const {
        id
      } = req.params;

      const deviceId = String(
        req.body?.device_id || ''
      ).slice(0, 64);

      const action = String(
        req.body?.action || 'none'
      );

      if (!deviceId) {
        return res.status(400).json({
          error:
            'Device ID is required.'
        });
      }

      if (
        action !== 'like' &&
        action !== 'dislike' &&
        action !== 'none'
      ) {
        return res.status(400).json({
          error:
            'Invalid action.'
        });
      }

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

      if (action === 'none') {
        await pool.execute(
          `
            DELETE FROM comment_reactions
            WHERE comment_id = ?
              AND device_id = ?
          `,
          [id, deviceId]
        );
      } else {
        await pool.execute(
          `
            INSERT INTO comment_reactions
              (comment_id, device_id, reaction)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE
              reaction = VALUES(reaction)
          `,
          [id, deviceId, action]
        );
      }

      const [counts] =
        await pool.query(
          `
            SELECT
              COUNT(
                CASE
                  WHEN reaction = 'like'
                  THEN 1
                END
              ) AS likes,
              COUNT(
                CASE
                  WHEN reaction = 'dislike'
                  THEN 1
                END
              ) AS dislikes,
              MAX(
                CASE
                  WHEN device_id = ?
                  THEN reaction
                END
              ) AS my_reaction
            FROM comment_reactions
            WHERE comment_id = ?
          `,
          [deviceId, id]
        );

      res.json({
        likes: counts[0].likes || 0,
        dislikes: counts[0].dislikes || 0,
        my_reaction:
          counts[0].my_reaction || null
      });

    } catch (error) {
      console.error(
        'Set comment reaction error:',
        error
      );

      res.status(500).json({
        error:
          error.message ||
          'Unable to update reaction.'
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

/* List ALL comments across every post, with the related post title/slug and
   live like/dislike counts. Used by the Admin and Chief Editor dashboards so
   moderators can see every reader comment and delete any of them. Only the
   Admin / Chief Editor roles may access it (matches requirePostManagement). */
app.get(
  '/api/comments',
  requireAuth,
  requirePostManagement,
  async (req, res) => {
    try {
      const [rows] =
        await getPool().query(
          `
            SELECT
              c.*,
              p.title AS post_title,
              p.slug AS post_slug,
              COUNT(
                CASE
                  WHEN r.reaction = 'like'
                  THEN 1
                END
              ) AS like_count,
              COUNT(
                CASE
                  WHEN r.reaction = 'dislike'
                  THEN 1
                END
              ) AS dislike_count
            FROM comments c
            LEFT JOIN posts p
              ON p.id = c.post_id
            LEFT JOIN comment_reactions r
              ON r.comment_id = c.id
            GROUP BY c.id
            ORDER BY c.created_at DESC
          `
        );

      res.set(
        'Cache-Control',
        'no-store, no-cache, must-revalidate'
      );

      res.json(rows);

    } catch (error) {
      console.error(
        'Fetch all comments error:',
        error
      );

      res.status(500).json({
        error:
          'Unable to fetch all comments.'
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

          profile_image:
            user.profile_image ||
            user.profile_image_url ||
            null,

          profile_image_url:
            user.profile_image_url ||
            user.profile_image ||
            null,

          profile_image_public_id:
            user.profile_image_public_id ||
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

          profile_image:
            req.user.profile_image ||
            req.user.profile_image_url ||
            null,

          profile_image_url:
            req.user.profile_image_url ||
            req.user.profile_image ||
            null,

          profile_image_public_id:
            req.user.profile_image_public_id ||
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
   PROFILE IMAGE UPDATE
========================================================= */

app.put(
  '/api/profile/image',
  requireAuth,
  profileUpload.single('image'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: 'No image file was uploaded.'
        });
      }

      const table = req.user.role_type === 'admin'
        ? 'admins'
        : req.user.role_type === 'chief_editor'
          ? 'chief_editors'
          : 'employees';
      const profileImagePath = `/uploads/profiles/${req.file.filename}`;

      await getPool().execute(
        `
          UPDATE ${table}
          SET profile_image = ?, profile_image_url = ?
          WHERE id = ?
        `,
        [profileImagePath, profileImagePath, req.user.id]
      );

      return res.json({
        message: 'Profile image updated successfully.',
        profile_image: profileImagePath,
        profile_image_url: profileImagePath,
      });
    } catch (error) {
      console.error('Profile image update error:', error);
      return res.status(500).json({
        error: 'Unable to update profile image.'
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
      const message =
        error.code === 'LIMIT_FILE_SIZE'
          ? 'Image is too large. Maximum allowed size is 15 MB.'
          : 'File upload error: ' + error.message;

      return res.status(400).json({
        error: message
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

    /* ------------------------------------------
       Cloudinary startup diagnostics
    ------------------------------------------- */

    console.log(
      '[cloudinary] Cloud:',
      process.env.CLOUDINARY_CLOUD_NAME || 'MISSING'
    );

    console.log(
      '[cloudinary] API Key:',
      process.env.CLOUDINARY_API_KEY
        ? `${String(process.env.CLOUDINARY_API_KEY).slice(0, 4)}****`
        : 'MISSING'
    );

    console.log(
      '[cloudinary] API Secret:',
      process.env.CLOUDINARY_API_SECRET ? 'LOADED' : 'MISSING'
    );

    /* Measure host-clock skew so Cloudinary uploads use a corrected timestamp
       even if the machine clock is out of sync with real time. */
    ensureCloudinaryClockSkewMeasured();

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
