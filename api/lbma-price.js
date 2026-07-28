const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const LBMA_URL = 'https://www.lbma.org.uk/prices-and-data/lbma-precious-metal-prices';

// Matches things like "AM $4,051.85" / "오전 4,051.85달러" / "PM  4,090.10"
const PRICE_PATTERNS = [
  /AM[^\d$]{0,15}\$?\s*([\d,]+\.\d{1,2})/i,
  /PM[^\d$]{0,15}\$?\s*([\d,]+\.\d{1,2})/i,
  /오전[^\d]{0,10}([\d,]+\.\d{1,2})/,
  /오후[^\d]{0,10}([\d,]+\.\d{1,2})/,
];
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
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
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
    ).catch(() => {}); // fall through even if this times out; we'll report what we found

    const bodyText = await page.evaluate(() => document.body.innerText);

    const result = { date: null, am: null, pm: null, raw_snippet: null, note: null };

    const amMatch = bodyText.match(PRICE_PATTERNS[0]) || bodyText.match(PRICE_PATTERNS[2]);
    const pmMatch = bodyText.match(PRICE_PATTERNS[1]) || bodyText.match(PRICE_PATTERNS[3]);

    if (amMatch) result.am = parseFloat(amMatch[1].replace(/,/g, ''));
    if (pmMatch) result.pm = parseFloat(pmMatch[1].replace(/,/g, ''));

    if (!result.am && !result.pm) {
      // Fallback: grab the first dollar-amount-looking number on the page
      const generic = bodyText.match(GENERIC_PRICE);
      if (generic) {
        result.am = parseFloat(generic[1].replace(/,/g, ''));
        result.note = 'AM/PM 라벨을 못 찾아 페이지의 첫 번째 금액을 사용했어요. 값을 꼭 확인하세요.';
      }
    }

    // try to find a date like "24/07" or "2026-07-24" near the price
    const dateMatch = bodyText.match(/\b(\d{4}-\d{2}-\d{2})\b/) || bodyText.match(/\b(\d{2}\/\d{2})\b/);
    if (dateMatch) result.date = dateMatch[1];

    // include a short snippet of raw text around any match for debugging
    const anchor = bodyText.search(GENERIC_PRICE);
    if (anchor >= 0) result.raw_snippet = bodyText.slice(Math.max(0, anchor - 60), anchor + 60);

    if (!result.am && !result.pm) {
      res.status(200).json({
        success: false,
        error: '페이지에서 가격 형식의 텍스트를 찾지 못했어요. LBMA 페이지 구조가 바뀌었을 수 있어요.',
        page_text_sample: bodyText.slice(0, 500),
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
