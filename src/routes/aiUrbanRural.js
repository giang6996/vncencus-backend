const express = require('express');
const router = express.Router();
const { requireAuth } = require('./auth');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = 'gpt-4.1'; // adjust to mini during testing

if (!OPENAI_API_KEY) {
  console.warn('OPENAI_API_KEY not set — /ai-urban-rural-report will fail until provided.');
}

/**
 * Aggregate raw urban/rural rows:
 * rows: [{ area_type, population, household_count, ... }]
 */
function aggregateUrbanRural(rows = []) {
  const groups = {};
  let totalPop = 0;
  let totalHH = 0;

  for (const row of rows) {
    const key = row.area_type || 'Khác';
    const pop = Number(row.population || 0);
    const hh = Number(row.household_count || 0);

    if (!groups[key]) {
      groups[key] = {
        area_type: key,
        population: 0,
        household_count: 0,
      };
    }

    groups[key].population += pop;
    groups[key].household_count += hh;

    totalPop += pop;
    totalHH += hh;
  }

  const items = Object.values(groups).map((g) => ({
    area_type: g.area_type,
    population: g.population,
    household_count: g.household_count,
    population_percent: totalPop ? (g.population / totalPop) * 100 : 0,
    household_percent: totalHH ? (g.household_count / totalHH) * 100 : 0,
  }));

  return {
    totals: { population: totalPop, households: totalHH },
    items,
  };
}

/**
 * If datasets not provided, fetch data from existing report endpoint:
 * GET /api/reports/urban-rural?year=...&province=...
 */
async function fetchUrbanRuralFromServer(baseUrl, year, province) {
  const prefix = baseUrl || '';
  const qs = `?year=${encodeURIComponent(year)}${
    province ? `&province=${encodeURIComponent(province)}` : ''
  }`;

  try {
    const res = await fetch(`${prefix}/api/reports/urban-rural${qs}`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } catch (err) {
    console.warn('fetchUrbanRuralFromServer error:', err);
    return [];
  }
}

/**
 * Build prompt specifically for urban/rural split.
 * NOTE: JSON output, no special character.
 */
function buildPromptFromUrbanRuralData({ year, province, agg }) {
  const { totals, items } = agg;
  const lines = [];

  lines.push(
    'Bạn là chuyên gia thống kê dân số, chuyên phân tích sự khác biệt giữa khu vực đô thị và nông thôn.'
  );
  lines.push(
    `Nhiệm vụ: dựa vào dữ liệu dân số và hộ gia đình theo khu vực Đô thị / Nông thôn bên dưới, hãy viết một đoạn tóm tắt (5–8 câu), liệt kê 3 điểm nổi bật và đưa ra nhận định ngắn về xu hướng đô thị hóa.`
  );

  if (province) {
    lines.push(
      `Phạm vi báo cáo: một tỉnh/thành cụ thể (mã "${province}"). Nếu có tên tỉnh trong dữ liệu, hãy dùng tên đó trong phần tóm tắt.`
    );
  } else {
    lines.push('Phạm vi báo cáo: toàn quốc.');
  }

  lines.push('');
  lines.push(`Dữ liệu được cung cấp (đã tổng hợp):`);
  lines.push(
    `- Tổng dân số: ${totals.population.toLocaleString('vi-VN')} người.`
  );
  lines.push(
    `- Tổng số hộ gia đình: ${totals.households.toLocaleString('vi-VN')} hộ.`
  );

  if (items.length) {
    const desc = items
      .map((i) => {
        const area = i.area_type;
        const pop = i.population.toLocaleString('vi-VN');
        const hh = i.household_count.toLocaleString('vi-VN');
        const popPct = i.population_percent.toFixed(1);
        const hhPct = i.household_percent.toFixed(1);
        return `${area}: dân số ${pop} (${popPct}%), hộ gia đình ${hh} (${hhPct}%)`;
      })
      .join('; ');
    lines.push(`- Cơ cấu theo khu vực: ${desc}.`);
  } else {
    lines.push('- Không có dữ liệu chi tiết theo khu vực.');
  }

  lines.push('');
  lines.push('Yêu cầu đầu ra:');
  lines.push('Trả lời duy nhất dưới dạng JSON hợp lệ với cấu trúc sau:');
  lines.push('{');
  lines.push('  "summary": "Chuỗi mô tả 5–8 câu bằng tiếng Việt",');
  lines.push('  "highlights": ["3 câu ngắn nêu điểm nổi bật"],');
  lines.push('  "insights": {');
  lines.push('    "urban_population_share": số,');
  lines.push('    "rural_population_share": số,');
  lines.push('    "urban_household_share": số,');
  lines.push('    "rural_household_share": số,');
  lines.push('    "dominant_area_population": "Đô thị" hoặc "Nông thôn" hoặc "Không rõ",');
  lines.push('    "dominant_area_household": "Đô thị" hoặc "Nông thôn" hoặc "Không rõ"');
  lines.push('  }');
  lines.push('}');
  lines.push('');
  lines.push(
    'CHỈ trả về JSON. Không được dùng markdown, không dùng dấu ``` và không kèm giải thích thêm.'
  );

  return lines.join('\n');
}

router.post('/ai-urban-rural-report', requireAuth, async (req, res) => {
  try {
    const { year, province = null, datasets = null } = req.body || {};

    if (!year) {
      return res
        .status(400)
        .json({ error: 'Thiếu tham số year trong request body.' });
    }

    // 1) Get raw rows
    let rows;
    if (datasets && Array.isArray(datasets.urban_rural)) {
      rows = datasets.urban_rural;
    } else {
      rows = await fetchUrbanRuralFromServer('', year, province);
    }

    // 2) Aggregate
    const agg = aggregateUrbanRural(rows || []);

    // 3) Build prompt
    const prompt = buildPromptFromUrbanRuralData({ year, province, agg });

    if (!OPENAI_API_KEY) {
      return res
        .status(500)
        .json({ error: 'OPENAI_API_KEY chưa được cấu hình trên server.' });
    }

    const payload = {
      model: OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'Bạn là trợ lý AI giúp phân tích dữ liệu dân số đô thị / nông thôn và viết báo cáo ngắn gọn bằng tiếng Việt.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.15,
      max_tokens: 700,
    };

    const oResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!oResp.ok) {
      const txt = await oResp.text();
      console.error('OpenAI error (urban-rural):', oResp.status, txt);
      return res
        .status(502)
        .json({ error: 'OpenAI API error', details: txt });
    }

    const oJson = await oResp.json();
    const content = oJson?.choices?.[0]?.message?.content || '';

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      // Fallback: wrap raw text
      parsed = {
        summary: content,
        highlights: [],
        insights: {},
      };
    }

    if (!parsed.insights) parsed.insights = {};
    if (!parsed.summary) parsed.summary = '';
    if (!parsed.highlights) parsed.highlights = [];

    parsed.raw_prompt = prompt;

    return res.json(parsed);
  } catch (err) {
    console.error('ai-urban-rural-report error:', err);
    return res.status(500).json({
      error: 'Internal server error in ai-urban-rural-report',
      details: err.message || String(err),
    });
  }
});

module.exports = router;
