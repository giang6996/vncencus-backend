// routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');          // or 'bcryptjs'
const jwt = require('jsonwebtoken');
const { pool } = require('../db');            // adjust path if your db.js is elsewhere

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES_IN = '2h';

/**
 * Helper: generate JWT token
 */
function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * POST /api/auth/register
 * Body: { username, email, password }
 */
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'username và password là bắt buộc.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Mật khẩu phải từ 6 ký tự trở lên.' });
    }

    // Check if username or email already exists
    const checkSql = `
      SELECT id FROM report_users
      WHERE username = $1 OR (email IS NOT NULL AND email = $2)
      LIMIT 1;
    `;
    const { rows: existing } = await pool.query(checkSql, [username, email || null]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Tên đăng nhập hoặc email đã tồn tại.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const insertSql = `
      INSERT INTO report_users (username, email, password_hash)
      VALUES ($1, $2, $3)
      RETURNING id, username, email, role, created_at;
    `;
    const { rows } = await pool.query(insertSql, [username, email || null, passwordHash]);
    const user = rows[0];

    const token = signToken(user);

    res.status(201).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    console.error('auth/register error', err);
    res.status(500).json({ error: 'Không thể đăng ký tài khoản.' });
  }
});

/**
 * POST /api/auth/login
 * Body: { usernameOrEmail, password }
 */
router.post('/login', async (req, res) => {
  try {
    const { usernameOrEmail, password } = req.body || {};
    if (!usernameOrEmail || !password) {
      return res.status(400).json({ error: 'Thiếu tài khoản hoặc mật khẩu.' });
    }

    const sql = `
      SELECT id, username, email, password_hash, role
      FROM report_users
      WHERE username = $1 OR email = $1
      LIMIT 1;
    `;
    const { rows } = await pool.query(sql, [usernameOrEmail]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu.' });
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu.' });
    }

    const token = signToken(user);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    console.error('auth/login error', err);
    res.status(500).json({ error: 'Không thể đăng nhập.' });
  }
});

/**
 * Middleware: require auth (for /me or future protected routes)
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'Thiếu token xác thực.' });
  }

  const token = match[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { id, username, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn.' });
  }
}

/**
 * GET /api/auth/me
 * Header: Authorization: Bearer <token>
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    const sql = `
      SELECT id, username, email, role, created_at
      FROM report_users
      WHERE id = $1
      LIMIT 1;
    `;
    const { rows } = await pool.query(sql, [req.user.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Không tìm thấy người dùng.' });
    }
    const user = rows[0];
    res.json({ user });
  } catch (err) {
    console.error('auth/me error', err);
    res.status(500).json({ error: 'Không thể lấy thông tin người dùng.' });
  }
});

module.exports = {
    router,
    requireAuth
  };
