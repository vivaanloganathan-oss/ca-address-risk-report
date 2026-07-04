/* Calibration helper — opens a REAL, visible browser window and runs the
 * exact same steps server.js will run headlessly, so you can watch it and
 * fix selectors in sites.config.js if something doesn't work.
 *
 * Usage:
 *   node calibrate.js <factorId> "<zip-or-address>"
 * Example:
 *   node calibrate.js 6 "94582"
 *
 * The window stays open until you press Enter in the terminal, so you can
 * poke around devtools to find the right selector if the search box wasn't
 * found automatically.
 */
import { chromium } from 'playwright';
import { SITES } from './sites.config.js';
import readline from 'readline';

const factorId = Number(process.argv[2]);
const query = process.argv[3];
const site = SITES[factorId];

if (!site || !query) {
  console.error('Usage: node calibrate.js <factorId> "<zip-or-address>"');
  console.error('Known factor IDs:', Object.keys(SITES).join(', '));
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 150 });
  const page = await browser.newPage({ viewport: { width: site.viewport?.w || 1400, height: site.viewport?.h || 900 } });
  console.log(`Opening ${site.url} ...`);
  await page.goto(site.url, { waitUntil: 'networkidle', timeout: 45000 });

  let input = null, usedSel = null;
  for (const sel of site.searchSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) { input = loc; usedSel = sel; break; }
  }
  if (!input) {
    console.log('❌ No selector matched. Open devtools in the window, inspect the search box, and add its selector to sites.config.js searchSelectors.');
  } else {
    console.log(`✓ Found search box with selector: ${usedSel}`);
    await input.click();
    await input.fill('').catch(() => {});
    await input.type(query, { delay: 60 });
    await page.waitForTimeout(site.suggestDelayMs ?? 900);

    if (site.submit === 'firstSuggestion') {
      const sug = page.locator(site.suggestionSelector).first();
      if (await sug.count().catch(() => 0)) { console.log('✓ Clicking first suggestion.'); await sug.click(); }
      else { console.log('⚠ No suggestion matched selector — check suggestionSelector. Pressing Enter instead.'); await page.keyboard.press('Enter'); }
    } else if (site.submit === 'button') {
      await page.locator(site.submitButtonSelector).first().click();
    } else {
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(site.settleDelayMs ?? 3500);
    console.log('✓ Done. Check the window — does it look zoomed to the right place?');
  }

  console.log('\nPress Enter in this terminal to close the browser...');
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    rl.question('', () => { rl.close(); resolve(); });
  });
  await browser.close();
})();
