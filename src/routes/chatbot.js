// routes/chatbot.js
const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const { requireAuth } = require('./auth');
const jwt = require('jsonwebtoken');

// Mock token for model to run query with authorization
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// update or use env var
const API_BASE = process.env.API_BASE || 'http://localhost:4000/api';

const VERBOSE = process.env.VERBOSE === 'true';
function vLog(...args) {
  if (VERBOSE) {
    console.log('[CHATBOT]', ...args);
  }
}

const PROVINCES = [
    { code: '01', alias: ['hà nội', 'ha noi', 'hanoi', 'hn'] },
    { code: '79', alias: ['hồ chí minh', 'ho chi minh', 'hcm', 'sài gòn', 'sai gon'] },
    { code: '48', alias: ['đà nẵng', 'da nang', 'danang'] },
    { code: '31', alias: ['hải phòng', 'hai phong', 'haiphong'] },
    { code: '92', alias: ['cần thơ', 'can tho', 'cantho'] },
];

/**
 * POST /api/chatbot
 * Body: { messages: [{ role: 'user'|'assistant'|'system', content: string }] }
 * Returns: { reply: string, topic: string, year: number }
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const messages = req.body?.messages || [];
    const lastUser = [...messages].reverse().find(m => m.role === 'user');

    vLog('\n===== /api/chatbot called =====');
    vLog('Incoming messages count:', messages.length);
    vLog('Last user message:', lastUser?.content);

    if (!lastUser) {
      vLog('No user message found: 400');
      return res.status(400).json({ error: 'No user message provided' });
    }

    const question = String(lastUser.content || '');
    const year = detectYear(question, 2024);
    const topic = detectTopic(question);
    const province = detectProvince(question);
    
    vLog('Detected parameters:', { question, year, topic, province });

    // 1) Load data from existing /reports endpoints
    const datasets = await loadDatasetsForTopic(topic, year, province);

    vLog(
      'Datasets loaded for topic:',
      topic,
      'keys =',
      Object.keys(datasets)
    );

    // 2) Build prompt for AI answer
    const prompt = buildAnswerPrompt({ question, topic, year, datasets, province });
    vLog('Prompt length (chars):', prompt.length);

    const gptMessages = [
        {
          role: 'system',
          content: 
          'Bạn là trợ lý phân tích dữ liệu dân số Việt Nam. ' +
          'Nhiệm vụ của bạn gồm hai phần:' +
          '\n1) Trả lời dựa trên dữ liệu JSON được cung cấp từ hệ thống VietCensus.' +
          '\n2) Khi người dùng hỏi về chính sách, giải pháp, hoặc gợi ý cải thiện (ví dụ: mất cân bằng giới tính, tăng kết nối Internet, nâng cao dân trí, đô thị hoá...), bạn phải đưa ra các chính sách khả thi, phù hợp bối cảnh Việt Nam, dựa trên kiến thức thực tế (giáo dục, kinh tế, xã hội, hạ tầng). ' +
          '\nCác gợi ý có thể bao gồm: chính sách nhà nước, khuyến nghị phát triển, chính sách dân số – kế hoạch hoá gia đình, đầu tư hạ tầng, chuyển đổi số, thúc đẩy bình đẳng giới, giảm bất bình đẳng vùng miền...' +
          '\nHãy trả lời ngắn gọn (5–8 câu), dễ hiểu cho người không chuyên. ' +
          '\nNếu dữ liệu VietCensus không đủ để trả lời một phần, hãy kết hợp kiến thức chung và giải thích rõ.' 
        },
        {
          role: 'user',
          content: prompt         
        }
      ];
      
      vLog('Existing chat history size:', messages.length);

      // Merge them with chat history
      for (const m of messages) {
        gptMessages.push({ role: m.role, content: m.content });
      }

    vLog('Calling OpenAI chat.completions.create...');
    // 3) Ask OpenAI to generate Vietnamese answer
    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1',
      messages: gptMessages,
      temperature: 0.3
    });

    const reply = completion.choices[0]?.message?.content?.trim() ||
      'Xin lỗi, tôi chưa có câu trả lời phù hợp.';
    
    vLog('OpenAI reply length:', reply.length);

    return res.json({ reply, topic, year });
  } catch (err) {
    console.error('chatbot error', err);
    return res.status(500).json({ error: 'Chatbot backend error' });
  }
});

module.exports = router;

/* ----------------- Helpers ------------------ */

// Very simple heuristic: pick 20xx in text, fallback to defaultYear
function detectYear(text, defaultYear) {
  const match = String(text).match(/20\d{2}/);
  const y = match ? Number(match[0]) : defaultYear;
  if (y < 2000 || y > 2100) return defaultYear;
  return y;
}

// Detect main topic by keywords
function detectTopic(text) {
  const t = text.toLowerCase();

  if (t.includes('internet') || t.includes('mạng') || t.includes('kết nối')) {
    return 'internet';
  }

  if (
    t.includes('thành thị') ||
    t.includes('đô thị') ||
    t.includes('nông thôn') ||
    t.includes('urban') ||
    t.includes('rural')
  ) {
    return 'urban_rural';
  }

  // default to population if no other topic can be found
  return 'population';
}


function detectProvince(text) {
    const t = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    for (const p of PROVINCES) {
      for (const alias of p.alias) {
        const normalizedAlias = alias
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "");
  
        if (t.includes(normalizedAlias)) {
          return p.code;
        }
      }
    }
  
    return null; // nationwide default
  }

// JSON fetch
async function fetchJson(url, options = {}) {
  // Internal JWT so chatbot can call protected /api/reports endpoints
  const internalToken = jwt.sign(
    { service: 'chatbot' },
    JWT_SECRET,
    { expiresIn: '1m' } // No more than 1 minute
  );

  vLog('fetchJson: ', url);

  const resp = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${internalToken}`, // 👈 key line
    },
  });
  if (!resp.ok) {
    const txt = await resp.text();
    vLog('fetchJson FAILED', resp.status, txt.slice(0, 200));
    throw new Error(`Fetch ${url} failed: ${resp.status} ${txt}`);
  }
  const json = await resp.json();
  vLog('fetchJson SUCCESS', url, 'sample:', JSON.stringify(json).slice(0, 150));
  return json;
}

// Load data from existing /reports endpoints depending on topic
async function loadDatasetsForTopic(topic, year, province) {
  const datasets = {};
  const qsProvince = province ? `&province=${province}` : '';
  const qsProvinceTrend = province ? `?province=${province}` : '';

  vLog('loadDatasetsForTopic:', { topic, year, province });

  if (topic === 'internet') {
    datasets.internet_access = await fetchJson(
      `${API_BASE}/reports/internet-access?year=${year}`
    );
    datasets.internet_trend = await fetchJson(
      `${API_BASE}/reports/internet-trend`
    );
  } else if (topic === 'urban_rural') {
    datasets.urban_rural_by_province = await fetchJson(
      `${API_BASE}/reports/urban-rural-by-province?year=${year}${qsProvince}`
    );
    datasets.urban_rural_summary = await fetchJson(
      `${API_BASE}/reports/urban-rural-summary?year=${year}${qsProvince}`
    );
  } else {
    // Population
    datasets.population_by_province = await fetchJson(
      `${API_BASE}/reports/population-by-province?year=${year}${qsProvince}`
    );
    datasets.population_trend = await fetchJson(
      `${API_BASE}/reports/population-trend${qsProvinceTrend}`
    );

    // Age structure & sex ratio
    datasets.age_structure = await fetchJson(
      `${API_BASE}/reports/age-structure?year=${year}${qsProvince}`
    );
    datasets.sex_ratio = await fetchJson(
      `${API_BASE}/reports/sex-ratio?year=${year}${qsProvince}`
    );
  }

  vLog(
    'loadDatasetsForTopic done. Dataset keys:',
    Object.keys(datasets)
  );

  return datasets;
}

// Build text prompt for the AI based on question + datasets
function buildAnswerPrompt({ question, topic, year, datasets, province }) {
  const lines = [];

  lines.push(
    `Người dùng hỏi (tiếng Việt): "${question}".`,
  );
  lines.push(
    `Chủ đề đã phân loại: ${topic}. Năm mặc định: ${year}.`
  );
  lines.push(
    `Dưới đây là dữ liệu JSON rút gọn từ các API /api/reports của hệ thống VietCensus. ` +
    `Hãy đọc kỹ và trả lời bằng tiếng Việt, 5–8 câu, dễ hiểu cho người không chuyên.`
  );

  if (province) {
    const pName = PROVINCES.find(p => p.code === province)?.alias[0] || province;
    lines.push(`Phạm vi: dữ liệu cho tỉnh/thành "${pName}" (mã ${province}).`);
  } else {
    lines.push(`Phạm vi: toàn quốc.`);
  }

  if (topic === 'internet') {
    lines.push('\n[1] Dữ liệu internet_access (tỷ lệ hộ có Internet theo tỉnh):');
    lines.push(JSON.stringify(datasets.internet_access).slice(0, 2000));

    lines.push('\n[2] Dữ liệu internet_trend (toàn quốc qua các kỳ điều tra):');
    lines.push(JSON.stringify(datasets.internet_trend).slice(0, 2000));

    lines.push(
      '\nNhiệm vụ: tóm tắt mức độ phổ cập Internet của hộ gia đình, nêu xu hướng theo thời gian, ' +
      'và chỉ ra nếu có tỉnh/thành nào nổi bật.'
    );
  } else if (topic === 'urban_rural') {
    lines.push('\n[1] Dữ liệu urban_rural_by_province:');
    lines.push(JSON.stringify(datasets.urban_rural_by_province).slice(0, 2000));

    lines.push('\n[2] Dữ liệu urban_rural_summary (toàn quốc):');
    lines.push(JSON.stringify(datasets.urban_rural_summary).slice(0, 2000));

    lines.push(
      '\nNhiệm vụ: so sánh quy mô hộ thành thị và nông thôn, nêu tỷ trọng mỗi khu vực, ' +
      'và nhận xét nếu có sự chênh lệch lớn giữa các tỉnh/thành.'
    );
} else {
    // population
    lines.push('\n[1] Dữ liệu population_by_province:');
    lines.push(JSON.stringify(datasets.population_by_province).slice(0, 2000));
  
    lines.push('\n[2] Dữ liệu population_trend (toàn quốc):');
    lines.push(JSON.stringify(datasets.population_trend).slice(0, 2000));
  
    // Age structure
    if (datasets.age_structure) {
      lines.push('\n[3] Dữ liệu age_structure (dân số theo nhóm tuổi):');
      lines.push(JSON.stringify(datasets.age_structure).slice(0, 2000));
    }
  
    // Sex ratio
    if (datasets.sex_ratio) {
      lines.push('\n[4] Dữ liệu sex_ratio (dân số theo giới tính):');
      lines.push(JSON.stringify(datasets.sex_ratio).slice(0, 2000));
    }
  
    lines.push(
      '\nNhiệm vụ: mô tả dân số theo tỉnh (top tỉnh đông dân), xu hướng dân số theo thời gian, ' +
      'nhận xét cơ cấu tuổi (dân số trẻ/già hoá) và phân bố giới tính (nam / nữ), ' +
      'và nếu có thể, nhận xét về sự tập trung dân số ở các đô thị lớn.'
    );
  }

  lines.push(
    '\nYêu cầu:\n' +
    '- Trả lời bằng tiếng Việt, 5–8 câu, có thể dùng gạch đầu dòng nếu phù hợp.\n' +
    '- Dẫn chiếu một vài con số cụ thể (ví dụ giá trị gần đúng, không cần chính xác tuyệt đối).\n' +
    '- Nếu dữ liệu không đủ để trả lời đúng ý câu hỏi, hãy nói rõ hạn chế đó.'
  );

  return lines.join('\n');
}
