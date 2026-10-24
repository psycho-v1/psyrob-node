// Header band of the new explorer pages: the transfer map's backdrop (E6) as a static, low-opacity band.
// Same geometry and palette as drawBackdrop() in public/home-map.js: twelve spokes, three
// twelve-sided guide rings at 0.5, 0.74 and 1.0 of the radius, a radial glow and a still
// particle field. Drawn once (again only if the window is resized); no animation.
(function () {
  var css = getComputedStyle(document.documentElement);
  var tok = function (n, d) { return (css.getPropertyValue(n) || d).trim(); };
  var COL = { field: tok('--field', '#081216'), line: tok('--line', '#1c3336'), accent: tok('--cyan', '#3ee0d6'), muted: tok('--mute', '#8aa8a6') };
  var rgba = function (hex, a) { var n = parseInt(hex.slice(1), 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; };
  function draw(cv) {
    var box = cv.parentElement.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    var W = Math.round(box.width), H = Math.round(box.height);
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    var ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // centre to the right, so the heading on the left stays clear
    var cx = W > 700 ? W * 0.74 : W * 0.62, cy = H * 0.55, rx = Math.min(W * 0.46, 420), ry = H * 0.95;
    ctx.fillStyle = COL.field; ctx.fillRect(0, 0, W, H);
    var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry) * 1.05);
    g.addColorStop(0, rgba(COL.accent, 0.10)); g.addColorStop(0.5, rgba(COL.accent, 0.025)); g.addColorStop(1, rgba(COL.accent, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = 1; ctx.strokeStyle = rgba(COL.line, 0.75);
    [0.5, 0.74, 1].forEach(function (k) {
      ctx.beginPath();
      for (var i = 0; i <= 12; i++) {
        var a = i * Math.PI / 6 - Math.PI / 2, x = cx + Math.cos(a) * rx * k, y = cy + Math.sin(a) * ry * k;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke();
    });
    ctx.strokeStyle = rgba(COL.line, 0.5); ctx.beginPath();
    for (var i = 0; i < 12; i++) {
      var a = i * Math.PI / 6 - Math.PI / 2;
      ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * rx * 1.14, cy + Math.sin(a) * ry * 1.14);
    }
    ctx.stroke();
    var seed = 7, rnd = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (var p = 0; p < Math.round(W * H / 2600); p++) {
      ctx.globalAlpha = 0.25 + rnd() * 0.45; ctx.fillStyle = rnd() < 0.3 ? COL.accent : COL.muted;
      var s = rnd() < 0.85 ? 1 : 2; ctx.fillRect(rnd() * W, rnd() * H, s, s);
    }
    ctx.globalAlpha = 1;
  }
  var all = function () { document.querySelectorAll('canvas.web-band').forEach(draw); };
  all(); window.addEventListener('resize', all);
})();
