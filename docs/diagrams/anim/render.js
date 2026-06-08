// Renderiza scene.html em frames determinísticos e codifica um GIF.
// Pipeline 100% JS (sem ffmpeg): puppeteer -> canvas.toDataURL -> pngjs -> gifenc.
const puppeteer = require('/tmp/node_modules/puppeteer');
const { PNG } = require('/tmp/node_modules/pngjs');
const { GIFEncoder, quantize, applyPalette } = require('/tmp/node_modules/gifenc');
const fs = require('fs');
const path = require('path');

const W = 1200, H = 675;
const FRAMES = 90;                // mantém o tamanho do arquivo
const SECONDS = 15;               // duração do loop (maior = mais lento)
const DELAY = Math.round(SECONDS * 1000 / FRAMES);  // ms por frame (~167ms)
const OUT = process.argv[2] || '/tmp/showpass-anim/showpass.gif';

function dataURLtoRGBA(durl) {
  const b64 = durl.split(',')[1];
  const buf = Buffer.from(b64, 'base64');
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

(async () => {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const url = 'file://' + path.resolve(__dirname, 'scene.html');
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts && document.fonts.ready);

  const gif = GIFEncoder();
  console.log(`Capturando ${FRAMES} frames...`);

  for (let f = 0; f < FRAMES; f++) {
    const t = f / FRAMES; // [0,1)
    const durl = await page.evaluate((tt) => {
      window.__draw(tt);
      return document.getElementById('c').toDataURL('image/png');
    }, t);

    const { data, width, height } = dataURLtoRGBA(durl);
    // quantiza para paleta de 256 cores (design flat comprime muito bem)
    const palette = quantize(data, 128, { format: 'rgb565' });
    const index = applyPalette(data, palette, 'rgb565');
    gif.writeFrame(index, width, height, { palette, delay: DELAY });

    if (f % 12 === 0) process.stdout.write(`  frame ${f}/${FRAMES}\r`);
  }

  gif.finish();
  fs.writeFileSync(OUT, Buffer.from(gif.bytes()));
  await browser.close();

  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`\nGIF gerado: ${OUT} (${kb} KB, ${FRAMES} frames, loop ${SECONDS}s, ${DELAY}ms/frame)`);
})();
