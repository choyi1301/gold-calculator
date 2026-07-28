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
      { timeout: 15000 }
    ).catch(() => {});

    const bodyText = await page.evaluate(() => document.body.innerText);

    // Find the "USD" row, then look for KRW-rate-looking numbers (roughly 900~2500 range,
    // formatted like "1,459.50") within the next chunk of text after it.
    const usdIdx = bodyText.indexOf('USD');
    const result = { rate: null, raw_snippet: null, note: null };

    if (usdIdx >= 0) {
      const window = bodyText.slice(usdIdx, usdIdx + 300);
      const numbers = [...window.matchAll(/(\d{1,3}(?:,\d{3})*\.\d{1,2})/g)].map((m) => parseFloat(m[1].replace(/,/g, '')));
      const plausible = numbers.filter((n) => n > 800 && n < 3000);
      if (plausible.length > 0) {
        result.rate = plausible[0];
      }
      result.raw_snippet = window.slice(0, 250);
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
