if (!process.env.AWS_LAMBDA_JS_RUNTIME) {
  process.env.AWS_LAMBDA_JS_RUNTIME = 'nodejs20.x';
}

const path = require('path');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const HANA_URL = 'https://www.kebhana.com/cont/mall/mall15/mall1501/index.jsp';

// Fixed repo location for the snapshot data file (public repo, so reads
// don't need auth — only writes here need the GH_TOKEN).
const GH_OWNER = 'choyi1301';
const GH_REPO = 'gold-calculator';
const GH_FILE_PATH = 'data/hana-snapshots.json';

function todayKST(){
  // en-CA locale gives YYYY-MM-DD directly
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

async function collectAllFrameText(page){
  const frames = page.frames();
  const texts = [];
  for (const f of frames) {
    try {
      const t = await f.evaluate(() => document.body ? document.body.innerText : '');
      if (t) texts.push(t);
    } catch (e) { /* skip */ }
  }
  return texts.join('\n---FRAME---\n');
}

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
    if (plausible.length > 0) return plausible[plausible.length - 1];
  }
  return null;
}

async function scrapeCurrentRate(){
  let browser = null;
  try {
    if (typeof chromium.setGraphicsMode === 'function') chromium.setGraphicsMode(false);
    else chromium.setGraphicsMode = false;

    const executablePath = await chromium.executablePath();
    process.env.LD_LIBRARY_PATH = [path.dirname(executablePath), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36');
    await page.goto(HANA_URL, { waitUntil: 'networkidle2', timeout: 25000 });
    await page.waitForFunction(() => /USD/.test(document.body.innerText), { timeout: 8000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));

    const bodyText = await collectAllFrameText(page);
    return extractUsdBasicRate(bodyText);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function githubGetFile(token){
  const res = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE_PATH}`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'gold-calculator-snapshot', Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) return { data: {}, sha: undefined };
  if (!res.ok) throw new Error('GitHub 파일 조회 실패 (' + res.status + ')');
  const json = await res.json();
  const data = JSON.parse(Buffer.from(json.content, 'base64').toString('utf8'));
  return { data, sha: json.sha };
}

async function githubPutFile(token, data, sha, message){
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const res = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE_PATH}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'gold-calculator-snapshot', 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' },
    body: JSON.stringify({ message, content, sha }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('GitHub 파일 저장 실패 (' + res.status + '): ' + t.slice(0, 200));
  }
}

module.exports = async (req, res) => {
  const slot = (req.query && req.query.slot) || 'manual';
  const token = process.env.GH_TOKEN;

  if (!token) {
    res.status(500).json({ success: false, error: 'GH_TOKEN 환경변수가 설정되지 않았어요.' });
    return;
  }

  try {
    const rate = await scrapeCurrentRate();
    if (!rate) throw new Error('환율 값을 읽지 못했어요.');

    const date = todayKST();
    const { data, sha } = await githubGetFile(token);
    if (!data[date]) data[date] = {};
    data[date][slot] = { rate, savedAtUtc: new Date().toISOString() };

    // keep only the most recent 60 days so the file doesn't grow forever
    const dates = Object.keys(data).sort();
    if (dates.length > 60) {
      for (const d of dates.slice(0, dates.length - 60)) delete data[d];
    }

    await githubPutFile(token, data, sha, `snapshot ${date} ${slot}: ${rate}`);

    res.status(200).json({ success: true, date, slot, rate });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err && err.message ? err.message : err) });
  }
};
