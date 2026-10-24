// The DAG page's graph: the newest blocks by blue score (x), stacked when parallel (y), with every parent link.
// Bright path: the selected chain. Polls /api/dag every 10 s. No libraries.
(function () {
  var cv = document.getElementById('dag-graph');
  if (!cv) return;
  var css = getComputedStyle(document.documentElement);
  var tok = function (n, d) { return (css.getPropertyValue(n) || d).trim(); };
  var C = { accent: tok('--cyan', '#3ee0d6'), line: tok('--line', '#1c3336'), muted: tok('--mute', '#8aa8a6'), ink: tok('--ink', '#e7f4f2'), field: '#081216', red: '#b97b7b' };
  var STEP = 46, LANE = 46, PAD = 30, nodes = [], pos = {};
  function layout(list) {
    var byScore = {}, min = Infinity, max = -Infinity;
    list.forEach(function (b) { (byScore[b.blueScore] = byScore[b.blueScore] || []).push(b); min = Math.min(min, b.blueScore); max = Math.max(max, b.blueScore); });
    var lanes = 1;
    Object.keys(byScore).forEach(function (s) {
      var col = byScore[s].sort(function (a, b) { return (b.onChain ? 1 : 0) - (a.onChain ? 1 : 0) || (a.hash < b.hash ? -1 : 1); });
      lanes = Math.max(lanes, col.length);
      col.forEach(function (b, i) { b.lane = i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2); });
    });
    var h = Math.max(160, (lanes + 1) * LANE + 2 * PAD);
    var w = Math.max(cv.parentElement.clientWidth, (max - min + 1) * STEP + 2 * PAD);
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + 'px'; cv.style.height = h + 'px';
    pos = {};
    list.forEach(function (b) { pos[b.hash] = { x: PAD + (b.blueScore - min) * STEP, y: h / 2 + b.lane * LANE, b: b }; });
    return dpr;
  }
  function draw(list) {
    var dpr = layout(list), ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.field; ctx.fillRect(0, 0, cv.width, cv.height);
    list.forEach(function (b) {
      var p = pos[b.hash];
      b.parents.forEach(function (ph) {
        var q = pos[ph];
        if (!q) return;
        var chainEdge = b.onChain && ph === b.selectedParent;
        ctx.strokeStyle = chainEdge ? C.accent : C.muted; ctx.globalAlpha = chainEdge ? 0.95 : 0.55; ctx.lineWidth = chainEdge ? 2.2 : 1.1;
        ctx.beginPath(); ctx.moveTo(p.x, p.y);
        ctx.bezierCurveTo(p.x - STEP / 2, p.y, q.x + STEP / 2, q.y, q.x, q.y); ctx.stroke();
      });
    });
    ctx.globalAlpha = 1;
    list.forEach(function (b) {
      var p = pos[b.hash], r = b.onChain ? 7 : 6;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.2832);
      ctx.fillStyle = C.field; ctx.fill();
      ctx.lineWidth = 1.6;
      if (b.colour === 'red') { ctx.strokeStyle = C.red; ctx.globalAlpha = 0.6; ctx.stroke(); ctx.globalAlpha = 1; }
      else if (b.colour === 'pending') { ctx.strokeStyle = C.ink; ctx.setLineDash([2, 2]); ctx.stroke(); ctx.setLineDash([]); }
      else { ctx.strokeStyle = C.accent; ctx.stroke(); ctx.fillStyle = C.accent; ctx.beginPath(); ctx.arc(p.x, p.y, b.onChain ? 3.2 : 2.4, 0, 6.2832); ctx.fill(); }
    });
    nodes = list;
    var box = cv.parentElement; box.scrollLeft = box.scrollWidth;
  }
  cv.addEventListener('click', function (ev) {
    var rect = cv.getBoundingClientRect(), x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    for (var h in pos) { var p = pos[h]; if (Math.hypot(p.x - x, p.y - y) < 10) { location.href = '/block/' + h; return; } }
  });
  function load() { fetch('/api/dag?n=120', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(draw).catch(function () {}); }
  load(); setInterval(load, 10000); window.addEventListener('resize', function () { if (nodes.length) draw(nodes); });
})();
