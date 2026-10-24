// The rail of the newest chain blocks under the page header (all explorer pages). Polls /api/summary.
(function () {
  var rail = document.getElementById('block-rail');
  if (!rail) return;
  var mark = '<svg viewBox="0 0 64 64" aria-hidden="true"><polygon points="32,12 52,22 32,32 12,22" fill="#3ee0d6" fill-opacity="0.15" stroke="#3ee0d6" stroke-width="2"/><polygon points="32,24 52,34 32,44 12,34" fill="none" stroke="#3ee0d6" stroke-width="2"/></svg>';
  function draw(blocks) {
    rail.innerHTML = (blocks || []).map(function (b) { return '<a class="block-node" href="/block/' + b.height + '">' + mark + '<span>#' + b.height + '</span></a>'; }).join('');
  }
  function refresh() {
    fetch('/api/summary', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) { draw(d.blocks); }).catch(function () {});
  }
  refresh();
  setInterval(refresh, 5000);
})();
