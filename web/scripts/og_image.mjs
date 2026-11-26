// Render the older map-only social preview (1200x630). The live web/public/og-image.png is the logo-pack version;
// running this script replaces it.
// usage: node scripts/og_image.mjs [baseUrl=https://seaflooratlas.org/] [out=public/og-image.png]
// The page is loaded with the UI hidden, the "what's actually measured" veil on, and a title card drawn on top.
// Then shrink it below 300 KB (Telegram / WhatsApp drop larger previews; test/assets.test.ts checks): a 256-colour
// Floyd-Steinberg palette is visually identical here (472 KB -> 158 KB, PSNR 41.6 dB, 2026-11-24):
//   ../.venv/bin/python -c "from PIL import Image as I; i=I.open('public/og-image.png').convert('RGB'); \
//     i.quantize(palette=i.quantize(256, method=I.Quantize.FASTOCTREE), dither=I.Dither.FLOYDSTEINBERG).save('public/og-image.png', optimize=True)"
import { chromium } from 'playwright-core';

const [,, base = 'https://seaflooratlas.org/', out = 'public/og-image.png'] = process.argv;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(base, { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForFunction(() => window.__seafloor, null, { timeout: 60000 });
await page.evaluate(() => window.__seafloor.setVeil(true));
await page.addStyleTag({ content: `
  /* visibility, not display: the app derives the map padding from the UI boxes, so they must keep their size */
  body > *:not(#map):not(#og-card) { visibility: hidden !important; }
  .maplibregl-control-container, .maplibregl-marker, .maplibregl-popup { visibility: hidden !important; }
  #og-card { position: fixed; left: 48px; top: 50%; transform: translateY(-50%); width: 400px; padding: 30px 32px 26px;
    background: rgba(8,16,30,0.92); border: 1px solid rgba(160,200,230,0.18); border-radius: 18px; color: #e8f0f7;
    font-family: Georgia, 'Times New Roman', serif; box-shadow: 0 20px 60px rgba(0,0,0,0.45); z-index: 10; }
  #og-card h1 { font-size: 44px; line-height: 1.05; margin: 0 0 14px; font-weight: 500; letter-spacing: -0.01em; }
  #og-card p { font: 400 19px/1.4 -apple-system, 'Helvetica Neue', Arial, sans-serif; margin: 0 0 18px; color: #c4d3e0; }
  #og-card .big { font: 600 54px/1 -apple-system, 'Helvetica Neue', Arial, sans-serif; color: #9fe3c8; margin: 4px 0 6px; }
  #og-card .key { display: flex; gap: 16px; font: 400 15px/1.3 -apple-system, 'Helvetica Neue', Arial, sans-serif; color: #c4d3e0; margin: 0 0 18px; }
  #og-card .sw { display: inline-block; width: 14px; height: 14px; border-radius: 3px; vertical-align: -2px; margin-right: 6px; }
  #og-card .url { font: 600 17px/1 ui-monospace, 'SF Mono', Menlo, monospace; color: #9fe3c8; }
` });
await page.evaluate(() => {
  const c = document.createElement('div');
  c.id = 'og-card';
  c.innerHTML = `<h1>Seafloor Atlas</h1>
    <p>An interactive globe of the whole ocean floor, and how much of it ships have actually measured.</p>
    <div class="big">30.8 %</div>
    <p style="margin-top:0">of the seafloor is directly measured (GEBCO 2026)</p>
    <div class="key"><span><i class="sw" style="background:#6fb6d6"></i>measured by ships</span><span><i class="sw" style="background:#1b2a44;border:1px solid #3a4f6e"></i>estimated</span></div>
    <div class="url">seaflooratlas.org</div>`;
  document.body.appendChild(c);
});
await page.evaluate(() => {
  const m = window.__seafloor.map;
  m.jumpTo({ center: [-38, 12], zoom: 1.78, pitch: 0, bearing: 0, padding: { left: 470, top: 20, right: 20, bottom: 20 } });
});
await page.evaluate(() => window.__seafloor.idle());
await page.waitForTimeout(2500);
await page.evaluate(() => window.__seafloor.idle());
await page.waitForTimeout(500);
await page.screenshot({ path: out });
console.log('wrote', out);
await browser.close();
