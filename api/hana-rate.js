if (!process.env.AWS_LAMBDA_JS_RUNTIME) {
  process.env.AWS_LAMBDA_JS_RUNTIME = 'nodejs20.x';
}

const path = require('path');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const HANA_URL = 'https://www.kebhana.com/cont/mall/mall15/mall1501/index.jsp';
const HANA_HISTORY_URL = 'https://biz.kebhana.com/foex/rate/index.do?menuItemId=wcfxd740_201i';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function collectAllFrameText(page){
  const frames = page.frames();
  const texts = [];
  for (const f of frames) {
    try {
      const t = await f.evaluate(() => document.body ? document.body.innerText : '');
      if (t) texts.push(t);
    } catch (e) { /* cross-origin or detached frame; skip */ }
  }
  return texts.join('\n---FRAME---\n');
}

// Extracts the 매매기준율 (last plausible number) from the first 10 numbers
// following a "USD" marker in the given text.
function extractUsdBasicRate(bodyText){
  const usdIndices = [];
  let searchFrom = 0;
  while (true) {
    const idx = bodyText.indexOf('USD', searchFrom);
    if (idx === -1) break;
    usdIndices.push(idx);
    searchFrom = idx + 3;
  }
  for (const usdIdx of usdIndices) {
    const window = bodyText.slice(usdIdx, usdIdx + 400);
    const numbers = [...window.matchAll(/(\d{1,3}(?:,\d{3})*\.\d{1,2})/g)]
      .slice(0, 10)
      .map((m) => parseFloat(m[1].replace(/,/g, '')));
    const plausible = numbers.filter((n) => n > 800 && n < 3000);
    if (plausible.length > 0) {
      return { rate: plausible[plausible.length - 1], raw_snippet: window.slice(0, 150) };
    }
  }
  return null;
}

// Finds every "HH:MM 시각 + 환율" pair in a daily-history-style table and
// returns the one closest to targetHour:targetMinute.
function findClosestTimedRate(bodyText, targetHour, targetMinute){
  const targetTotalMin = targetHour * 60 + targetMinute;
  const rows = [...bodyText.matchAll(/(\d{1,2}):(\d{2})[^\d]{0,40}?(\d{1,3}(?:,\d{3})*\.\d{1,2})/g)];
  let best = null;
  let bestDiff = Infinity;
  for (const m of rows) {
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const rate = parseFloat(m[3].replace(/,/g, ''));
    if (h > 23 || min > 59 || rate < 800 || rate > 3000) continue;
    const totalMin = h * 60 + min;
    const diff = Math.abs(totalMin - targetTotalMin);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = { rate, matchedTime: `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`, raw: m[0] };
    }
  }
  return best;
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const timeParam = (req.query && req.query.time) || 'now';

  let browser = null;
  try {
    if (typeof chromium.setGraphicsMode === 'function') {
      chromium.setGraphicsMode(false);
    } else {
      chromium.setGraphicsMode = false;
    }

    const executablePath = await chromium.executablePath();
    process.env.LD_LIBRARY_PATH = [path.dirname(executablePath), process.env.LD_LIBRARY_PATH]
      .filter(Boolean)
      .join(':');

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'
    );

    const result = { rate: null, raw_snippet: null, note: null, matched_time: null, mode: timeParam };

    if (timeParam === 'now') {
      await page.goto(HANA_URL, { waitUntil: 'networkidle2', timeout: 25000 });
      await page.waitForFunction(
        () => /USD/.test(document.body.innerText),
        { timeout: 8000 }
      ).catch(() => {});
      await new Promise((r) => setTimeout(r, 2000));
      const bodyText = await collectAllFrameText(page);
      const found = extractUsdBasicRate(bodyText);

      if (!found) {
        res.status(200).json({
          success: false,
          error: 'USD 환율 텍스트를 찾지 못했어요. 페이지 구조가 바뀌었을 수 있어요.',
          page_text_sample: bodyText.slice(0, 800),
        });
        return;
      }
      result.rate = found.rate;
      result.raw_snippet = found.raw_snippet;
      result.source = HANA_URL;
    } else {
      // '0900' or '1400': look up the historical rate closest to that time today
      const targetHour = parseInt(timeParam.slice(0, 2), 10);
      const targetMinute = parseInt(timeParam.slice(2, 4), 10);

      await page.goto(HANA_HISTORY_URL, { waitUntil: 'networkidle2', timeout: 25000 });

      // Try to trigger a search if the page needs a currency selection + submit
      await page.evaluate(() => {
        const selects = Array.from(document.querySelectorAll('select'));
        for (const s of selects) {
          const usdOpt = Array.from(s.options).find(o => /USD|미국/.test(o.textContent));
          if (usdOpt) { s.value = usdOpt.value; s.dispatchEvent(new Event('change', { bubbles: true })); }
        }
        const buttons = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
        const searchBtn = buttons.find(b => /조회/.test(b.textContent || b.value || ''));
        if (searchBtn) searchBtn.click();
      }).catch(() => {});

      await new Promise((r) => setTimeout(r, 2500));
      const bodyText = await collectAllFrameText(page);
      const closest = findClosestTimedRate(bodyText, targetHour, targetMinute);

      if (!closest) {
        res.status(200).json({
          success: false,
          error: '시각별 환율 표를 찾지 못했어요. 페이지 구조가 바뀌었을 수 있어요.',
          page_text_sample: bodyText.slice(0, 1000),
        });
        return;
      }
      result.rate = closest.rate;
      result.matched_time = closest.matchedTime;
      result.raw_snippet = closest.raw;
      result.source = HANA_HISTORY_URL;
      result.note = `요청 시각(${timeParam.slice(0,2)}:${timeParam.slice(2,4)})과 가장 가까운 고시 시각(${closest.matchedTime}) 값이에요.`;
    }

    res.status(200).json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err && err.message ? err.message : err) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
};
