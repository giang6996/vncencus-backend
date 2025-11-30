const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();

// ⬇️ Reuse your existing pg pool / db helper
const { Pool } = require('pg');
const pool = new Pool({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT) || 6868,
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'giang',
    database: process.env.PGDATABASE || 'vietcensus',
  });

// JWT config (demo)
const JWT_SECRET = process.env.JWT_SECRET || 'vietcensus-dev-secret';
const JWT_EXPIRES_IN = '7d';

// Helper: create JWT token for a mock VNeID account
function createToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * POST /api/vneid/login
 * Body: { citizenNumber: string, password: string }
 *
 * Steps:
 * - Find citizen_ids by citizenNumber
 * - Find mock_vneid_accounts by citizen_id_id
 * - bcrypt.compare(password, password_hash)
 * - Return JWT + basic profile
 */
router.post('/login', async (req, res) => {
  const { citizenNumber, password } = req.body || {};

  if (!citizenNumber || !password) {
    return res.status(400).json({ error: 'Thiếu số CCCD hoặc mật khẩu.' });
  }

  try {
    // 1. Find citizen_ids row
    const citizenResult = await pool.query(
      'SELECT id, citizen_number FROM citizen_ids WHERE citizen_number = $1',
      [citizenNumber]
    );

    if (citizenResult.rowCount === 0) {
      return res.status(401).json({ error: 'Tài khoản không tồn tại hoặc CCCD không đúng.' });
    }

    const citizen = citizenResult.rows[0];

    // 2. Find mock VNeID account
    const accountResult = await pool.query(
      'SELECT id, password_hash FROM mock_vneid_accounts WHERE citizen_id_id = $1',
      [citizen.id]
    );

    if (accountResult.rowCount === 0) {
      return res.status(401).json({ error: 'Tài khoản không tồn tại hoặc chưa được kích hoạt.' });
    }

    const account = accountResult.rows[0];

    // 3. Compare password using bcrypt
    const ok = await bcrypt.compare(password, account.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Mật khẩu không chính xác.' });
    }

    // 4. (Optional) Look up linked person + household info for this citizen
    // Adjust field names to match your actual schema
    const profileResult = await pool.query(
      `
      SELECT
        p.id AS person_id,
        p.full_name,
        p.sex,
        p.date_of_birth,
        p.relationship_to_head,
        h.id AS household_id,
        h.household_code,
        h.province_code,
        h.district_id,
        h.ward_id
      FROM persons p
      LEFT JOIN households h ON p.household_id = h.id
      WHERE p.citizen_id_id = $1
      ORDER BY p.id
      LIMIT 1
      `,
      [citizen.id]
    );

    const profile = profileResult.rows[0] || null;

    // 5. Create JWT
    const token = createToken({
      sub: account.id,
      citizenIdId: citizen.id,
      citizenNumber: citizen.citizen_number,
      role: 'citizen',
    });

    return res.json({
      token,
      account: {
        id: account.id,
        citizenIdId: citizen.id,
        citizenNumber: citizen.citizen_number,
      },
      profile, // can be null if you haven't linked persons yet
    });
  } catch (err) {
    console.error('Error in /api/vneid/login', err);
    return res.status(500).json({ error: 'Lỗi hệ thống khi đăng nhập.' });
  }
});

/**
 * Middleware: verify JWT from Authorization: Bearer <token>
 */
function authCitizen(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const [type, token] = authHeader.split(' ');

  if (type !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Thiếu token hoặc định dạng không hợp lệ.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.citizenAuth = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn.' });
  }
}

/**
 * GET /api/vneid/me
 * Use JWT to return current citizen profile info.
 */
router.get('/me', authCitizen, async (req, res) => {
  const { citizenIdId, citizenNumber } = req.citizenAuth;

  try {
    const profileResult = await pool.query(
      `
      SELECT
        p.id AS person_id,
        p.full_name,
        p.sex,
        p.date_of_birth,
        p.relationship_to_head,
        h.id AS household_id,
        h.household_code,
        h.province_code,
        h.district_id,
        h.ward_id
      FROM persons p
      LEFT JOIN households h ON p.household_id = h.id
      WHERE p.citizen_id_id = $1
      ORDER BY p.id
      LIMIT 1
      `,
      [citizenIdId]
    );

    const profile = profileResult.rows[0] || null;

    return res.json({
      citizenNumber,
      profile,
    });
  } catch (err) {
    console.error('Error in /api/vneid/me', err);
    return res.status(500).json({ error: 'Lỗi hệ thống khi lấy thông tin tài khoản.' });
  }
});

module.exports = router;
