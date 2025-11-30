const express = require('express');
const router = express.Router();
const { requireAuth } = require('./auth');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = 'gpt-4.1'; // adjust to mini during testing

if (!OPENAI_API_KEY) {
  console.warn('OPENAI_API_KEY not set — /ai-internet-report will fail until provided.');
}

/**
 * Aggregate internet access by province rows
 * rows: [{ province_code, province_name, household_count, households_with_internet, internet_rate_pct }]
 */
function aggregateInternetAccess(rows = []) {
  let totalHH = 0;
  let totalWithNet = 0;

  const withRate = rows.map((r) => {
    const hh = Number(r.household_count || 0);
    const withNet = Number(r.households_with_internet || 0);
    let rate = Number(r.internet_rate_pct);
    if (!isFinite(rate) || rate <= 0) {
      rate = hh ? (withNet / hh) * 100 : 0;
    }
    totalHH += hh;
    totalWithNet += withNet;

    return {
      province_code: r.province_code,
      province_name: r.province_name,
      household_count: hh,
      households_with_internet: withNet,
      internet_rate_pct: rate,
    };
  });

  const sortedByRateDesc = [...withRate].sort(
    (a, b) => b.internet_rate_pct - a.internet_rate_pct
  );
  const sortedByRateAsc = [...withRate].sort(
    (a, b) => a.internet_rate_pct - b.internet_rate_pct
  );

  const top5 = sortedByRateDesc.slice(0, 5);
  const bottom5 = sortedByRateAsc.slice(0, 5);

  const overallRate = totalHH ? (totalWithNet / totalHH) * 100 : 0;

  return {
    totals: {
      households: totalHH,
      households_with_internet: totalWithNet,
      internet_rate_pct: overallRate,
    },
    rows: withRate,
    top5,
    bottom5,
  };
}

/**
 * From internet trend rows, infer a simple direction & growth
 * rows: [{ census_year, household_count, households_with_internet, internet_rate_pct }]
 */
function summarizeTrend(trend = []) {
  if (!Array.isArray(trend) || trend.length < 2) {
    return null;
  }

  const sorted = [...trend].sort(
    (a, b) => Number(a.census_year) - Number(b.census_year)
  );
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const firstRate =
    Number(first.internet_rate_pct) ||
    (first.household_count
      ? (100 * Number(first.households_with_internet || 0)) /
        Number(first.household_count)
      : 0);

  const lastRate =
    Number(last.internet_rate_pct) ||
    (last.household_count
      ? (100 * Number(last.households_with_internet || 0)) /
        Number(last.household_count)
      : 0);

  const delta = lastRate - firstRate;
  let direction = 'ổn định';
  if (delta > 5) direction = 'tăng mạnh';
  else if (delta > 1) direction = 'tăng nhẹ';
  else if (delta < -5) direction = 'giảm mạnh';
  else if (delta < -1) direction = 'giảm nhẹ';

  const years = sorted.length > 1 ? sorted.length - 1 : 1;
  const avgPerYear = delta / years;

  return {
    first_year: first.census_year,
    last_year: last.census_year,
    first_rate: firstRate,
    last_rate: lastRate,
    change: delta,
    avg_change_per_year: avgPerYear,
    direction,
  };
}

/**
 * Build AI prompt for Internet access
 */
function buildPromptFromInternetData({ year, province, agg, trendSummary }) {
  const { totals, top5, bottom5 } = agg;

  const lines = [];
  lines.push(
    'Bạn là chuyên gia thống kê về hạ tầng và phổ cập Internet tại Việt Nam.'
  );
  lines.push(
    'Nhiệm vụ: dựa trên dữ liệu về số hộ gia đình và số hộ có Internet, hãy viết một đoạn tóm tắt (5–8 câu) về mức độ phổ cập Internet, sự khác biệt giữa các địa phương, và xu hướng thay đổi theo thời gian.'
  );

  if (province) {
    lines.push(
      `Phạm vi chính: một tỉnh/thành có mã "${province}". Nếu có tên tỉnh trong dữ liệu, hãy sử dụng tên đó khi viết báo cáo.`
    );
  } else {
    lines.push('Phạm vi chính: toàn quốc (so sánh giữa các tỉnh/thành).');
  }

  lines.push('');
  lines.push(`Dữ liệu tổng hợp hiện tại (năm ${year}):`);
  lines.push(
    `- Tổng số hộ gia đình: ${totals.households.toLocaleString(
      'vi-VN'
    )} hộ; trong đó có Internet: ${totals.households_with_internet.toLocaleString(
      'vi-VN'
    )} hộ (~${totals.internet_rate_pct.toFixed(2)}%).`
  );

  if (top5.length) {
    const descTop = top5
      .map((r) => {
        const name = r.province_name || r.province_code || 'Không rõ';
        return `${name}: ${r.internet_rate_pct.toFixed(2)}%`;
      })
      .join('; ');
    lines.push(`- Nhóm tỉnh có tỷ lệ hộ có Internet cao: ${descTop}.`);
  }

  if (bottom5.length) {
    const descBottom = bottom5
      .map((r) => {
        const name = r.province_name || r.province_code || 'Không rõ';
        return `${name}: ${r.internet_rate_pct.toFixed(2)}%`;
      })
      .join('; ');
    lines.push(
      `- Nhóm tỉnh có tỷ lệ hộ có Internet thấp (cần quan tâm): ${descBottom}.`
    );
  }

  if (trendSummary) {
    lines.push('');
    lines.push(
      'Thông tin xu hướng (dựa trên dữ liệu nhiều kỳ điều tra, toàn quốc hoặc cấp tỉnh):'
    );
    lines.push(
      `- Giai đoạn từ ${trendSummary.first_year} đến ${
        trendSummary.last_year
      }, tỷ lệ hộ có Internet thay đổi từ ${trendSummary.first_rate.toFixed(
        2
      )}% lên ${trendSummary.last_rate.toFixed(2)}% (thay đổi ${
        trendSummary.change >= 0 ? '+' : ''
      }${trendSummary.change.toFixed(2)} điểm phần trăm, trung bình ${
        trendSummary.avg_change_per_year >= 0 ? '+' : ''
      }${trendSummary.avg_change_per_year.toFixed(
        2
      )} điểm phần trăm mỗi năm, xu hướng được đánh giá là "${trendSummary.direction}").`
    );
  }

  lines.push('');
  lines.push('Yêu cầu đầu ra:');
  lines.push('Trả lời DUY NHẤT bằng JSON hợp lệ với cấu trúc sau:');
  lines.push('{');
  lines.push('  "summary": "Chuỗi 5–8 câu mô tả bằng tiếng Việt",');
  lines.push('  "highlights": ["3–5 câu ngắn nêu các điểm nổi bật"],');
  lines.push('  "insights": {');
  lines.push('    "current_rate_pct": số,');
  lines.push('    "max_rate_pct": số,');
  lines.push('    "min_rate_pct": số,');
  lines.push('    "top_provinces": ["Tên/tỉnh có tỷ lệ cao"],');
  lines.push('    "bottom_provinces": ["Tên/tỉnh có tỷ lệ thấp"],');
  lines.push(
    '    "trend_direction": "tăng mạnh" | "tăng nhẹ" | "giảm" | "ổn định" | "không rõ"'
  );
  lines.push('  }');
  lines.push('}');
  lines.push('');
  lines.push(
    'KHÔNG dùng markdown, KHÔNG dùng ``` và KHÔNG kèm bất kỳ giải thích nào ngoài JSON.'
  );

  return lines.join('\n');
}

router.post('/ai-internet-report', requireAuth, async (req, res) => {
  try {
    const { year, province = null, datasets = null } = req.body || {};

    if (!year) {
      return res
        .status(400)
        .json({ error: 'Thiếu tham số year trong request body.' });
    }

    // Expect frontend to send datasets.internet_access & datasets.internet_trend
    let accessRows = [];
    let trendRows = [];

    if (datasets) {
      if (Array.isArray(datasets.internet_access)) {
        accessRows = datasets.internet_access;
      }
      if (Array.isArray(datasets.internet_trend)) {
        trendRows = datasets.internet_trend;
      }
    }

    if (!accessRows.length) {
      return res.status(400).json({
        error:
          'Thiếu datasets.internet_access trong body. Vui lòng gửi dữ liệu Internet access hiện tại từ frontend.',
      });
    }

    const agg = aggregateInternetAccess(accessRows);
    const trendSummary = summarizeTrend(trendRows);

    const prompt = buildPromptFromInternetData({
      year,
      province,
      agg,
      trendSummary,
    });

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
            'Bạn là trợ lý AI giúp phân tích dữ liệu hạ tầng và phổ cập Internet và viết báo cáo ngắn gọn bằng tiếng Việt.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
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
      console.error('OpenAI error (internet):', oResp.status, txt);
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
      // Fallback wrap
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
    console.error('ai-internet-report error:', err);
    return res.status(500).json({
      error: 'Internal server error in ai-internet-report',
      details: err.message || String(err),
    });
  }
});

module.exports = router;
