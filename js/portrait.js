// Character portraits: a small JPEG kept inside the build, so it travels with exports, the account and the GM screen.

const W = 320, H = 400;           // 4:5, about twice the size it is shown at
const MAX_LEN = 400000;           // anything bigger did not come from here

/** The portrait as an image src, or '' when there is none or it isn't a plain embedded image. */
export function portraitSrc(s) {
  return typeof s === 'string' && s.length < MAX_LEN && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(s) ? s : '';
}

/** Opens the device's picture chooser; resolves with the chosen file, or null. */
export function pickImage() {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.style.cssText = 'position:fixed;left:-9999px;opacity:0';
    document.body.appendChild(inp);
    inp.onchange = () => { const f = inp.files && inp.files[0]; inp.remove(); resolve(f || null); };
    inp.click();
  });
}

/** Crops a picture to 4:5 (keeping the top of tall pictures, where faces usually are) and shrinks it to a small JPEG. */
export async function makePortrait(file) {
  if (!file || !/^image\//.test(file.type || 'image/')) throw new Error('That file is not a picture.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('This picture could not be opened. Try a JPG or PNG.')); i.src = url; });
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) throw new Error('This picture could not be opened.');
    let sw = iw, sh = ih, sx = 0, sy = 0;
    if (iw / ih > W / H) { sw = ih * W / H; sx = (iw - sw) / 2; } else { sh = iw * H / W; sy = (ih - sh) * 0.2; }
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#1b2430'; g.fillRect(0, 0, W, H);   // behind transparent PNGs
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
    return c.toDataURL('image/jpeg', 0.84);
  } finally { URL.revokeObjectURL(url); }
}
