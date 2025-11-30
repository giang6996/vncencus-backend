// src/routes/reports.js
const express = require('express');
const { pool } = require('../db');
const OpenAI = require('openai');
const { requireAuth } = require('./auth');

const router = express.Router();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Helpers
 */
function parseYear(q) {
  if (!q) return null;
  const y = parseInt(q, 10);
  return Number.isNaN(y) ? null : y;
}

// small helper to compute simple projection from trend rows
function simpleProjection(trendRows, yearsAhead = 5) {
  if (!trendRows || trendRows.length < 2) return null;

  const sorted = [...trendRows].sort(
    (a, b) => Number(a.census_year) - Number(b.census_year)
  );

  const last = sorted[sorted.length - 1];
  const prev = sorted[sorted.length - 2];

  const y1 = Number(prev.census_year);
  const y2 = Number(last.census_year);
  const p1 = Number(prev.population);
  const p2 = Number(last.population);

  const deltaYears = y2 - y1 || 1;
  const growthPerYear = (p2 - p1) / deltaYears;

  const targetYear = y2 + yearsAhead;
  const projected = Math.round(p2 + growthPerYear * yearsAhead);

  return {
    base_year: y2,
    target_year: targetYear,
    projected_population: projected,
    growth_per_year: Math.round(growthPerYear),
  };
}

/**
 * 1. Population by province (for bar chart)
 * GET /api/reports/population-by-province?year=2024
 */
router.get('/population-by-province', requireAuth, async (req, res) => {
  const year = parseYear(req.query.year);
  if (!year) {
    return res.status(400).json({ error: 'Missing or invalid ?year=' });
  }

  const sql = `
    SELECT
      p.census_year,
      pr.province_code,
      pr.name_vi AS province_name,
      COUNT(*) AS population
    FROM persons p
    JOIN households h ON h.id = p.household_id
    JOIN provinces pr ON pr.province_code = h.province_code
    WHERE p.census_year = $1
    GROUP BY p.census_year, pr.province_code, pr.name_vi
    ORDER BY pr.province_code;
  `;

  try {
    const { rows } = await pool.query(sql, [year]);
    res.json(rows);
  } catch (err) {
    console.error('population-by-province error', err);
    res.status(500).json({ error: 'Failed to load population by province' });
  }
});

/**
 * 2. Age structure by province & age group
 * GET /api/reports/age-structure?year=2024&province=01
 * uses query #2
 */
router.get('/age-structure', requireAuth, async (req, res) => {
  const year = parseYear(req.query.year);
  const province = req.query.province || null;

  if (!year) {
    return res.status(400).json({ error: 'Missing or invalid ?year=' });
  }

  const params = [year];
  let provinceFilter = '';

  if (province) {
    params.push(province);
    provinceFilter = 'AND pr.province_code = $2';
  }

  const sql = `
    SELECT
      p.census_year,
      pr.province_code,
      pr.name_vi AS province_name,
      CASE
        WHEN age_years < 15 THEN '0-14'
        WHEN age_years BETWEEN 15 AND 24 THEN '15-24'
        WHEN age_years BETWEEN 25 AND 44 THEN '25-44'
        WHEN age_years BETWEEN 45 AND 59 THEN '45-59'
        ELSE '60+'
      END AS age_group,
      COUNT(*) AS population
    FROM (
      SELECT
        p.*,
        (p.census_year - EXTRACT(YEAR FROM p.date_of_birth)::INT) AS age_years
      FROM persons p
    ) p
    JOIN households h ON h.id = p.household_id
    JOIN provinces pr ON pr.province_code = h.province_code
    WHERE p.census_year = $1
      ${provinceFilter}
    GROUP BY
      p.census_year,
      pr.province_code,
      pr.name_vi,
      CASE
        WHEN age_years < 15 THEN '0-14'
        WHEN age_years BETWEEN 15 AND 24 THEN '15-24'
        WHEN age_years BETWEEN 25 AND 44 THEN '25-44'
        WHEN age_years BETWEEN 45 AND 59 THEN '45-59'
        ELSE '60+'
      END
    ORDER BY pr.province_code, age_group;
  `;

  try {
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('age-structure error', err);
    res.status(500).json({ error: 'Failed to load age structure' });
  }
});

/**
 * 3. Sex ratio by province
 * GET /api/reports/sex-ratio?year=2024&province=01
 * uses query #3
 */
router.get('/sex-ratio', requireAuth, async (req, res) => {
  const year = parseYear(req.query.year);
  const province = req.query.province || null;

  if (!year) {
    return res.status(400).json({ error: 'Missing or invalid ?year=' });
  }

  const params = [year];
  let provinceFilter = '';

  if (province) {
    params.push(province);
    provinceFilter = 'AND pr.province_code = $2';
  }

  const sql = `
    SELECT
      p.census_year,
      pr.province_code,
      pr.name_vi AS province_name,
      p.sex,
      COUNT(*) AS population
    FROM persons p
    JOIN households h ON h.id = p.household_id
    JOIN provinces pr ON pr.province_code = h.province_code
    WHERE p.census_year = $1
      ${provinceFilter}
    GROUP BY p.census_year, pr.province_code, pr.name_vi, p.sex
    ORDER BY pr.province_code, p.sex;
  `;

  try {
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('sex-ratio error', err);
    res.status(500).json({ error: 'Failed to load sex ratio data' });
  }
});

/**
 * 4. Internet access rate by province
 * GET /api/reports/internet-access?year=2024
 * uses query #6
 */
router.get('/internet-access', requireAuth, async (req, res) => {
  const year = parseYear(req.query.year);
  if (!year) {
    return res.status(400).json({ error: 'Missing or invalid ?year=' });
  }

  const sql = `
    SELECT
      h.census_year,
      pr.province_code,
      pr.name_vi AS province_name,
      COUNT(*) AS household_count,
      COUNT(*) FILTER (WHERE h.has_internet) AS households_with_internet,
      ROUND(
        100.0 * COUNT(*) FILTER (WHERE h.has_internet) / NULLIF(COUNT(*), 0),
        2
      ) AS internet_rate_pct
    FROM households h
    JOIN provinces pr ON pr.province_code = h.province_code
    WHERE h.census_year = $1
    GROUP BY h.census_year, pr.province_code, pr.name_vi
    ORDER BY pr.province_code;
  `;

  try {
    const { rows } = await pool.query(sql, [year]);
    res.json(rows);
  } catch (err) {
    console.error('internet-access error', err);
    res.status(500).json({ error: 'Failed to load internet access data' });
  }
});

/**
 * 5. Urban vs rural breakdown
 * GET /api/reports/urban-rural?year=2024&province=01
 * uses query #7
 */
router.get('/urban-rural', requireAuth, async (req, res) => {
  const year = parseYear(req.query.year);
  const province = req.query.province || null;

  if (!year) {
    return res.status(400).json({ error: 'Missing or invalid ?year=' });
  }

  const params = [year];
  let provinceFilter = '';

  if (province) {
    params.push(province);
    provinceFilter = 'AND pr.province_code = $2';
  }

  const sql = `
    SELECT
      h.census_year,
      pr.province_code,
      pr.name_vi AS province_name,
      CASE WHEN h.is_urban THEN 'Đô thị' ELSE 'Nông thôn' END AS area_type,
      COUNT(DISTINCT h.id) AS household_count,
      COUNT(p.id) AS population
    FROM households h
    LEFT JOIN persons p ON p.household_id = h.id
    JOIN provinces pr ON pr.province_code = h.province_code
    WHERE h.census_year = $1
      ${provinceFilter}
    GROUP BY
      h.census_year,
      pr.province_code,
      pr.name_vi,
      CASE WHEN h.is_urban THEN 'Đô thị' ELSE 'Nông thôn' END
    ORDER BY pr.province_code, area_type;
  `;

  try {
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('urban-rural error', err);
    res.status(500).json({ error: 'Failed to load urban/rural data' });
  }
});

/**
 * 6. Population trend (all VN, or per province)
 * GET /api/reports/population-trend
 *      ?province=01   (optional)
 * uses queries #8 and #8b
 */
router.get('/population-trend', requireAuth, async (req, res) => {
  const province = req.query.province || null;

  if (!province) {
    // All Vietnam: query #8
    const sql = `
      SELECT
        census_year,
        COUNT(*) AS population
      FROM persons
      GROUP BY census_year
      ORDER BY census_year;
    `;

    try {
      const { rows } = await pool.query(sql);
      res.json(rows);
    } catch (err) {
      console.error('population-trend (VN) error', err);
      res.status(500).json({ error: 'Failed to load population trend' });
    }
  } else {
    // Per province: query #8b with filter
    const sql = `
      SELECT
        h.census_year,
        pr.province_code,
        pr.name_vi AS province_name,
        COUNT(p.id) AS population
      FROM persons p
      JOIN households h ON h.id = p.household_id
      JOIN provinces pr ON pr.province_code = h.province_code
      WHERE pr.province_code = $1
      GROUP BY h.census_year, pr.province_code, pr.name_vi
      ORDER BY h.census_year;
    `;

    try {
      const { rows } = await pool.query(sql, [province]);
      res.json(rows);
    } catch (err) {
      console.error('population-trend (province) error', err);
      res.status(500).json({ error: 'Failed to load population trend' });
    }
  }
});

/**
 * Internet usage trend (all VN, or per province)
 *
 * GET /api/reports/internet-trend
 */
router.get('/internet-trend', requireAuth, async (req, res) => {
  const province = req.query.province || null;

  if (!province) {
    // All Vietnam: group by census_year
    const sql = `
      SELECT
        h.census_year,
        COUNT(*) AS household_count,
        COUNT(*) FILTER (WHERE h.has_internet = TRUE) AS households_with_internet,
        CASE
          WHEN COUNT(*) = 0 THEN 0
          ELSE ROUND(
            100.0 * COUNT(*) FILTER (WHERE h.has_internet = TRUE) / COUNT(*),
            2
          )
        END AS internet_rate_pct
      FROM households h
      GROUP BY h.census_year
      ORDER BY h.census_year;
    `;

    try {
      const { rows } = await pool.query(sql);
      res.json(rows);
    } catch (err) {
      console.error('internet-trend (VN) error', err);
      res.status(500).json({ error: 'Failed to load internet trend' });
    }
  } else {
    // Per province: group by census_year + province
    const sql = `
      SELECT
        h.census_year,
        pr.province_code,
        pr.name_vi AS province_name,
        COUNT(*) AS household_count,
        COUNT(*) FILTER (WHERE h.has_internet = TRUE) AS households_with_internet,
        CASE
          WHEN COUNT(*) = 0 THEN 0
          ELSE ROUND(
            100.0 * COUNT(*) FILTER (WHERE h.has_internet = TRUE) / COUNT(*),
            2
          )
        END AS internet_rate_pct
      FROM households h
      JOIN provinces pr ON pr.province_code = h.province_code
      WHERE pr.province_code = $1
      GROUP BY h.census_year, pr.province_code, pr.name_vi
      ORDER BY h.census_year;
    `;

    try {
      const { rows } = await pool.query(sql, [province]);
      res.json(rows);
    } catch (err) {
      console.error('internet-trend (province) error', err);
      res.status(500).json({ error: 'Failed to load internet trend' });
    }
  }
});

module.exports = router;
