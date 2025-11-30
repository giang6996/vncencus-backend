const express = require('express');
const router = express.Router();
const { requireAuth } = require('./auth');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.warn('OPENAI_API_KEY not set — AI endpoint will fail until provided.');
}

const OPENAI_MODEL = 'gpt-4.1'; // adjust to mini during testing

/* ---------- helpers ---------- */

/**
 * computeProjection
 * - accepts population trend: [{ census_year: 2014, population: 12345 }, ...]
 * - returns linear projection for `projectionYears` into the future from last available year.
 * Simple implementation: compute annual growth rate from earliest->latest (or linear regression).
 */
function computeProjection(trend = [], projectionYears = 5) {
  if (!Array.isArray(trend) || trend.length < 2) return null;

  // Sort by census_year ascending
  const t = [...trend].sort((a, b) => Number(a.census_year) - Number(b.census_year));
  const n = t.length;
  const first = Number(t[0].population || 0);
  const last = Number(t[n - 1].population || 0);
  const yearsSpan = Number(t[n - 1].census_year) - Number(t[0].census_year) || 1;
  const annualGrowthRate = first > 0 ? Math.pow(last / first, 1 / yearsSpan) - 1 : 0;

  const baseYear = Number(t[n - 1].census_year);
  const projections = [];
  let prev = last;

  for (let i = 1; i <= projectionYears; i++) {
    const year = baseYear + i;
    const projected = Math.round(prev * (1 + annualGrowthRate));
    projections.push({ year, projected });
    prev = projected;
  }

  const projected_population = projections.length ? projections[projections.length - 1].projected : null;

  return {
    base_year: baseYear,
    projection_years: projectionYears,
    annual_growth_rate: annualGrowthRate,
    projected_population,
    series: projections,
  };
}

/**
 * safeFetchServerReports
 * - If datasets not provided, use internal server endpoints to fetch them.
 * - We assume this server is reachable at the same host: use absolute or relative calls.
 */
async function safeFetchServerReports(baseUrl, year, province) {
  // baseUrl: e.g. http://localhost:4000 (or empty string if using relative fetch)
  const prefix = baseUrl || ''; // if blank, fetch to same origin
  const qsYear = year ? `?year=${encodeURIComponent(year)}` : '';
  const qsProvince = province ? `&province=${encodeURIComponent(province)}` : '';

  const results = {};

  try {
    const [byProvRes, trendRes, agesRes, sexesRes] = await Promise.all([
      fetch(`${prefix}/api/reports/population-by-province${qsYear}`),
      fetch(`${prefix}/api/reports/population-trend${province ? `?province=${encodeURIComponent(province)}` : ''}`),
      fetch(`${prefix}/api/reports/age-structure?year=${encodeURIComponent(year)}${province ? `&province=${encodeURIComponent(province)}` : ''}`),
      fetch(`${prefix}/api/reports/sex-ratio?year=${encodeURIComponent(year)}${province ? `&province=${encodeURIComponent(province)}` : ''}`),
    ]);

    if (byProvRes.ok) results.population_by_province = await byProvRes.json();
    if (trendRes.ok) results.population_trend = await trendRes.json();
    if (agesRes.ok) results.age_structure = await agesRes.json();
    if (sexesRes.ok) results.sex_ratio = await sexesRes.json();

    return results;
  } catch (err) {
    console.warn('safeFetchServerReports error', err);
    return results; // might be partial
  }
}

/**
 * buildPromptFromData
 * - Builds a Vietnamese language instruction to the model summarizing the key numbers.
 * - Keep prompt concise but include top facts from the supplied datasets.
 */
function buildPromptFromData({ year, province, datasets, projection }) {
  const lines = [];

  // --- Introduction ---
  lines.push(
    `Bạn là chuyên gia thống kê dân số, nhiệm vụ là tạo báo cáo ngắn gọn (5–8 câu) bằng tiếng Việt.`
  );
  lines.push(
    `Hãy dựa vào dữ liệu điều tra dân số bên dưới để viết tóm tắt, liệt kê điểm nổi bật, và đưa ra dự báo dân số trong ${
      projection ? projection.projection_years : 5
    } năm tới.`
  );

  // --- Scope ---
  if (province) {
    lines.push(
      `Phạm vi báo cáo: tỉnh/thành có mã "${province}". Nếu có tên trong dữ liệu thì sử dụng tên đó.`
    );
  } else {
    lines.push(`Phạm vi báo cáo: toàn quốc.`);
  }

  // --- Data summary header ---
  lines.push(`Dữ liệu cung cấp (tóm tắt):`);

  // === Population by province ===
  const pbp = Array.isArray(datasets.population_by_province)
    ? datasets.population_by_province
    : [];

  if (pbp.length) {
    const sorted = [...pbp].sort(
      (a, b) => Number(b.population || 0) - Number(a.population || 0)
    );
    const top = sorted
      .slice(0, 5)
      .map(
        (r) =>
          `${r.province_name || r.province_code}: ${Number(
            r.population || 0
          ).toLocaleString("vi-VN")}`
      )
      .join("; ");
    lines.push(`- Top 5 tỉnh/thành đông dân nhất: ${top}.`);
  } else {
    lines.push(`- Không có dữ liệu dân số theo tỉnh.`);
  }

  // === Trend ===
  const trend = Array.isArray(datasets.population_trend)
    ? datasets.population_trend
    : [];
  if (trend.length) {
    const tSorted = [...trend].sort(
      (a, b) => Number(a.census_year) - Number(b.census_year)
    );
    const first = tSorted[0];
    const last = tSorted[tSorted.length - 1];
    lines.push(
      `- Xu hướng dân số: từ năm ${first.census_year} (${Number(
        first.population || 0
      ).toLocaleString("vi-VN")}) đến năm ${last.census_year} (${Number(
        last.population || 0
      ).toLocaleString("vi-VN")}).`
    );
  } else {
    lines.push(`- Không có dữ liệu xu hướng dân số.`);
  }

  // === Age structure ===
  const ages = Array.isArray(datasets.age_structure)
    ? datasets.age_structure
    : [];
  if (ages.length) {
    const ageFmt = ages
      .slice(0, 6)
      .map(
        (r) =>
          `${r.age_group || "Không rõ"}: ${Number(
            r.population || 0
          ).toLocaleString("vi-VN")}`
      )
      .join("; ");
    lines.push(`- Cơ cấu tuổi: ${ageFmt}.`);
  } else {
    lines.push(`- Không có dữ liệu cơ cấu tuổi.`);
  }

  // === Sex ratio ===
  const sexes = Array.isArray(datasets.sex_ratio)
    ? datasets.sex_ratio
    : [];
  if (sexes.length) {
    const sexFmt = sexes
      .map((r) => {
        const label = r.sex === "M" ? "Nam" : r.sex === "F" ? "Nữ" : r.sex;
        return `${label}: ${Number(r.population || 0).toLocaleString(
          "vi-VN"
        )}`;
      })
      .join("; ");
    lines.push(`- Cơ cấu giới tính: ${sexFmt}.`);
  } else {
    lines.push(`- Không có dữ liệu giới tính.`);
  }

  // --- Output instructions ---
  lines.push(``);
  lines.push(`Yêu cầu định dạng đầu ra (bắt buộc):`);
  lines.push(`Trả lời dưới dạng JSON hợp lệ với cấu trúc sau:`);
  lines.push(`{`);
  lines.push(`  "summary": "Chuỗi mô tả 5–8 câu",`);
  lines.push(`  "highlights": ["3 câu ngắn nêu điểm nổi bật"],`);
  lines.push(`  "projection": {`);
  lines.push(`    "base_year": số,`);
  lines.push(`    "projection_years": số,`);
  lines.push(`    "annual_growth_rate": số,`);
  lines.push(`    "projected_population": số,`);
  lines.push(`    "series": [danh sách số]`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);
  lines.push(
    `CHỈ trả về JSON. Không được dùng markdown, không dùng dấu \`\`\`, không giải thích thêm.`
  );

  return lines.join("\n");
}


/* ---------- route ---------- */

router.post('/ai-population-report', requireAuth, async (req, res) => {
  try {
    const { year, province = null, projection_years = 5, datasets = null } = req.body || {};

    // If datasets not provided, try to fetch them from the server's report endpoints
    let data = datasets;
    if (!data) {
      // Use relative fetch (same server). If your server requires different base, set it in env or adjust.
      data = await safeFetchServerReports('', year, province);
    }

    // Defensive: ensure objects exist
    data.population_by_province = Array.isArray(data.population_by_province) ? data.population_by_province : [];
    data.population_trend = Array.isArray(data.population_trend) ? data.population_trend : [];
    data.age_structure = Array.isArray(data.age_structure) ? data.age_structure : [];
    data.sex_ratio = Array.isArray(data.sex_ratio) ? data.sex_ratio : [];

    // Compute projection server-side (simple approach)
    const projection = computeProjection(data.population_trend, projection_years);

    // Build prompt
    const prompt = buildPromptFromData({
      year,
      province,
      datasets: data,
      projection,
    });

    // Call OpenAI chat completions
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY not configured on server.' });
    }

    // Prepare request body for OpenAI chat completions
    const openAiPayload = {
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: 'You are an assistant that produces concise Vietnamese statistical reports in JSON.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 900, // adjust as needed
    };

    // Use global fetch (Node18+) or fallback to node-fetch if you installed it.
    const oResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(openAiPayload),
    });

    if (!oResp.ok) {
      const txt = await oResp.text();
      console.error('OpenAI error', oResp.status, txt);
      return res.status(502).json({ error: 'OpenAI API error', details: txt });
    }

    const oJson = await oResp.json();
    // Extract assistant reply (assume it's valid JSON - we'll try to parse)
    const assistant = oJson?.choices?.[0]?.message?.content || '';

    // Try to parse assistant response as JSON (the prompt asked for JSON only).
    let structured = null;
    try {
      structured = JSON.parse(assistant);
    } catch (err) {
      // If not valid JSON, return raw assistant content under summary
      structured = {
        summary: assistant,
        highlights: [],
        projection: projection || null,
        raw_prompt: prompt,
        openai_response: oJson,
      };
    }

    // Ensure projection included (if server computed)
    if (!structured.projection) structured.projection = projection || null;
    if (!structured.raw_prompt) structured.raw_prompt = prompt;

    return res.json(structured);
  } catch (err) {
    console.error('ai-population-report error', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message || String(err) });
  }
});

module.exports = router;
