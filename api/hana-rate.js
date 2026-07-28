if (!process.env.AWS_LAMBDA_JS_RUNTIME) {
  process.env.AWS_LAMBDA_JS_RUNTIME = 'nodejs20.x';
}

const path = require('path');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const HANA_URL = 'https://www.kebhana.com/cont/mall/mall15/mall1501/index.jsp';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

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

    // The rate table is often embedded in an iframe on Korean bank sites,
    // so collect text from every frame, not just the top-level document.
    async function collectAllFrameText(){
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

    // give iframes a moment to finish their own loading/rendering
    await new Promise((r) => setTimeout(r, 2000));
    const bodyText = await collectAllFrameText();

    // Find the "USD" occurrence that's actually followed by a plausible KRW rate
    // (there may be several "USD" mentions — nav links, other tables, etc.)
    const result = { rate: null, raw_snippet: null, note: null };
    const usdIndices = [];
    let searchFrom = 0;
    while (true) {
      const idx = bodyText.indexOf('USD', searchFrom);
      if (idx === -1) break;
      usdIndices.push(idx);
      searchFrom = idx + 3;
    }

    for (const usdIdx of usdIndices) {
      const window = bodyText.slice(usdIdx, usdIdx + 300);
      const numbers = [...window.matchAll(/(\d{1,3}(?:,\d{3})*\.\d{1,2})/g)].map((m) => parseFloat(m[1].replace(/,/g, '')));
      const plausible = numbers.filter((n) => n > 800 && n < 3000);
      if (plausible.length > 0) {
        // Row order is roughly: 현찰살때, 현찰파실때, 송금보낼때, 송금받으실때, ..., 매매기준율
        // The 매매기준율 (basic/standard rate) is the LAST plausible number in the row,
        // not the first (which is the cash-buy rate inflated by the bank's spread).
        result.rate = plausible[plausible.length - 1];
        result.raw_snippet = window.slice(0, 250);
        break;
      }
    }

    if (!result.rate) {
      res.status(200).json({
        success: false,
        error: 'USD 환율 텍스트를 찾지 못했어요. 페이지 구조가 바뀌었을 수 있어요.',
        page_text_sample: bodyText.slice(0, 800),
      });
      return;
    }

    res.status(200).json({ success: true, source: HANA_URL, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err && err.message ? err.message : err) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
};
