// Run once to generate PWA icons: node generate-icons.js
// Requires: npm install sharp
const sharp = require('sharp');
const path = require('path');

const sizes = [192, 512];
const src = path.join(__dirname, 'public', 'icon.svg');

(async () => {
  for (const size of sizes) {
    await sharp(src)
      .resize(size, size)
      .png()
      .toFile(path.join(__dirname, 'public', `icon-${size}.png`));
    console.log(`Generated icon-${size}.png`);
  }
  console.log('Done.');
})();
