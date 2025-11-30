// src/routes/censusStatus.js
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'vietcensus-dev-secret';

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT) || 6868,
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'giang',
  database: process.env.PGDATABASE || 'vietcensus',
});

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
  } catch (e) {
    return res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn.' });
  }
}

// GET /api/census/status?year=2024
router.get('/status', authCitizen, async (req, res) => {
  const censusYear = Number(req.query.year) || 2024;
  const { citizenIdId } = req.citizenAuth; // from JWT

  try {
    const result = await pool.query(
      `
      SELECT
        p.id AS person_id,
        p.household_id,
        p.submission_date,
        h.household_code
      FROM persons p
      JOIN households h ON p.household_id = h.id
      WHERE p.citizen_id_id = $1
        AND p.census_year = $2
      ORDER BY p.submission_date DESC
      LIMIT 1
      `,
      [citizenIdId, censusYear]
    );

    if (result.rowCount > 0) {
      const row = result.rows[0];
      return res.json({
        eligible: false,
        alreadySubmitted: true,
        censusYear,
        submission: {
          personId: row.person_id,
          householdId: row.household_id,
          householdCode: row.household_code,
          submittedAt: row.submission_date,
        },
      });
    }

    // No record -> not yet submitted
    return res.json({
      eligible: true,
      alreadySubmitted: false,
      censusYear,
    });
  } catch (err) {
    console.error('Error in /api/census/status', err);
    return res.status(500).json({ error: 'Lỗi hệ thống khi kiểm tra trạng thái phiếu.' });
  }
});

module.exports = router;
