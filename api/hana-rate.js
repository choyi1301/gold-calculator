if (!process.env.AWS_LAMBDA_JS_RUNTIME) {
  process.env.AWS_LAMBDA_JS_RUNTIME = 'nodejs20.x';
}

const path = require('path');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const HANA_URL = 'https://www.kebhana.com/cont/mall/mall15/mall1501/index.jsp';
const SNAPSHOT_RAW_URL = 'https://raw.githubusercontent.com/choyi1301/gold-calculator/main/data/hana-snapshots.json';

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

function todayKST(){
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

// Reads the saved 09:00 / 14:00 snapshot for today (or the most recent day
// that has one, if today's hasn't been captured yet).
async function readSnapshot(slot){
  const res = await fetch(SNAPSHOT_RAW_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('저장된 스냅샷 파일을 찾지 못했어요 (아직 한 번도 저장되지 않았을 수 있어요).');
  const data = await res.json();

  const today = todayKST();
  if (data[today] && data[today][slot]) {
    return { rate: data[today][slot].rate, date: today, stale: false };
  }
  // fall back to the most recent earlier date that has this slot
  const dates = Object.keys(data).sort().reverse();
  for (const d of dates) {
    if (data[d] && data[d][slot]) {
      return { rate: data[d][slot].rate, date: d, stale: true };
    }
  }
  throw new Error('아직 저장된 ' + slot + ' 스냅샷이 없어요.');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const timeParam = (req.query && req.query.time) || 'now';

  // '0900' or '1400': just read the stored snapshot, no browser needed at all
  if (timeParam !== 'now') {
    try {
      const snap = await readSnapshot(timeParam);
      res.status(200).json({
        success: true,
        rate: snap.rate,
        matched_time: timeParam,
        source: SNAPSHOT_RAW_URL,
        note: snap.stale
          ? `오늘자 값이 아직 없어서 ${snap.date} 기준 값으로 대신 보여드려요.`
          : `${snap.date} 기준`,
      });
    } catch (err) {
      res.status(200).json({ success: false, error: String(err && err.message ? err.message : err) });
    }
    return;
  }

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

    res.status(200).json({ success: true, rate: found.rate, raw_snippet: found.raw_snippet, source: HANA_URL });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err && err.message ? err.message : err) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
};
