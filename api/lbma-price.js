// Vercel's Node.js runtime doesn't set this env var the way AWS Lambda does,
// but @sparticuz/chromium reads it to pick the right shared-library bundle
// (Amazon Linux 2 vs 2023). Set a sane fallback before chromium is touched.
if (!process.env.AWS_LAMBDA_JS_RUNTIME) {
  process.env.AWS_LAMBDA_JS_RUNTIME = 'nodejs20.x';
}

const path = require('path');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const LBMA_URL = 'https://www.lbma.org.uk/prices-and-data/lbma-precious-metal-prices';

// Generic fallback: any dollar-looking number on the page
const GENERIC_PRICE = /\$?\s*([\d]{1,2},\d{3}\.\d{2})/;

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
    // Make sure the dynamic linker can find libnss3.so etc. alongside the binary
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

    await page.goto(LBMA_URL, { waitUntil: 'networkidle2', timeout: 25000 });

    // The price is rendered client-side by a chart widget, so wait until
    // *some* dollar-amount-looking text appears in the page.
    await page.waitForFunction(
      () => /\$?\s*\d{1,2},\d{3}\.\d{2}/.test(document.body.innerText),
      { timeout: 15000 }
    ).catch(() => {});

    // The page shows only one of AM/PM at a time via a toggle tab.
    // Click each tab in turn and read whatever price follows it.
    async function clickTabByText(label) {
      return page.evaluate((label) => {
        const els = Array.from(document.querySelectorAll('button, a, div, span'));
        const el = els.find((e) => e.children.length === 0 && e.textContent.trim() === label);
        if (el) { el.click(); return true; }
        return false;
      }, label);
    }

    function extractPriceAfterLabel(text, label) {
      const re = new RegExp(label + '[^\\d$]{0,15}\\$?\\s*([\\d,]+\\.\\d{1,2})', 'i');
      const m = text.match(re);
      return m ? parseFloat(m[1].replace(/,/g, '')) : null;
    }

    function extractDate(text) {
      const iso = text.match(/(\d{4}-\d{2}-\d{2})/);
      if (iso) return iso[1];
      // date often sits right after the price with no separating whitespace
      // (e.g. "4,091.1027/07"), so don't require a leading word boundary
      const short = text.match(/(\d{2}\/\d{2})(?!\d)/);
      return short ? short[1] : null;
    }

    await clickTabByText('AM');
    await new Promise((r) => setTimeout(r, 1500));
    const amText = await page.evaluate(() => document.body.innerText);

    await clickTabByText('PM');
    await new Promise((r) => setTimeout(r, 1500));
    const pmText = await page.evaluate(() => document.body.innerText);

    const result = {
      date: extractDate(amText) || extractDate(pmText),
      am: extractPriceAfterLabel(amText, 'AM'),
      pm: extractPriceAfterLabel(pmText, 'PM'),
      raw_snippet: null,
      note: null,
    };

    if (!result.am && !result.pm) {
      // Fallback: grab the first dollar-amount-looking number on the page
      const generic = amText.match(GENERIC_PRICE);
      if (generic) {
        result.am = parseFloat(generic[1].replace(/,/g, ''));
        result.note = 'AM/PM 탭 클릭 방식이 실패해서 페이지의 첫 번째 금액을 대신 사용했어요. 값을 꼭 확인하세요.';
      }
    }

    const anchor = amText.search(GENERIC_PRICE);
    if (anchor >= 0) result.raw_snippet = amText.slice(Math.max(0, anchor - 60), anchor + 60);

    if (!result.am && !result.pm) {
      res.status(200).json({
        success: false,
        error: '페이지에서 가격 형식의 텍스트를 찾지 못했어요. LBMA 페이지 구조가 바뀌었을 수 있어요.',
        page_text_sample: amText.slice(0, 500),
      });
      return;
    }

    res.status(200).json({ success: true, source: LBMA_URL, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err && err.message ? err.message : err) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
};
