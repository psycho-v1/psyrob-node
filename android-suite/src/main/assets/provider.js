// PSYROB Suite in-app browser: an EIP-1193 / EIP-6963 provider (window.ethereum), MetaMask-compatible.
// Every request goes to the native wallet, which asks the user before connecting, sending or signing.
(function () {
  if (window.ethereum && window.ethereum.isPSYROB) return;
  var bridge = window.PSYProvider;
  if (!bridge) return;
  var seq = 0, pending = {}, listeners = {};
  var state = { chainId: '__CHAIN__', accounts: __ACCOUNTS__ };

  function emit(ev, data) {
    (listeners[ev] || []).slice().forEach(function (f) { try { f(data); } catch (e) { setTimeout(function () { throw e; }); } });
  }
  window.__psyrobReply = function (id, err, res) {
    var p = pending[id];
    if (!p) return;
    delete pending[id];
    if (err) { var e = new Error(err.message); e.code = err.code; if (err.data !== undefined) e.data = err.data; p.reject(e); }
    else p.resolve(res);
  };
  window.__psyrobEmit = function (ev, data) {
    if (ev === 'chainChanged') { if (state.chainId === data) return; state.chainId = data; }
    if (ev === 'accountsChanged') { if (JSON.stringify(state.accounts) === JSON.stringify(data)) return; state.accounts = data; }
    emit(ev, data);
    if (ev === 'chainChanged') emit('networkChanged', String(parseInt(data, 16)));
  };

  function request(args) {
    if (!args || typeof args !== 'object' || typeof args.method !== 'string') {
      return Promise.reject(Object.assign(new Error('Expected a single, non-array, object argument.'), { code: -32600 }));
    }
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      bridge.request(id, JSON.stringify({ method: args.method, params: args.params === undefined ? [] : args.params }));
    }).then(function (r) {
      if (args.method === 'eth_requestAccounts' || args.method === 'eth_accounts') window.__psyrobEmit('accountsChanged', r);
      if (args.method === 'eth_chainId') state.chainId = r;
      return r;
    });
  }

  var provider = {
    isMetaMask: true, isPSYROB: true, isPSYROBSuite: true,
    _metamask: { isUnlocked: function () { return Promise.resolve(true); } },
    get chainId() { return state.chainId; },
    get networkVersion() { return String(parseInt(state.chainId, 16)); },
    get selectedAddress() { return state.accounts[0] || null; },
    isConnected: function () { return true; },
    request: request,
    enable: function () { return request({ method: 'eth_requestAccounts' }); },
    on: function (ev, f) { (listeners[ev] = listeners[ev] || []).push(f); return provider; },
    once: function (ev, f) { var g = function (d) { provider.removeListener(ev, g); f(d); }; return provider.on(ev, g); },
    removeListener: function (ev, f) { listeners[ev] = (listeners[ev] || []).filter(function (x) { return x !== f; }); return provider; },
    removeAllListeners: function (ev) { if (ev) delete listeners[ev]; else listeners = {}; return provider; },
    listenerCount: function (ev) { return (listeners[ev] || []).length; },
    sendAsync: function (payload, cb) {
      if (Array.isArray(payload)) {
        Promise.all(payload.map(function (p) { return request(p).then(function (r) { return { id: p.id, jsonrpc: '2.0', result: r }; }, function (e) { return { id: p.id, jsonrpc: '2.0', error: { code: e.code, message: e.message } }; }); }))
          .then(function (rs) { cb(null, rs); });
        return;
      }
      request(payload).then(function (r) { cb(null, { id: payload.id, jsonrpc: '2.0', result: r }); },
        function (e) { cb(e, { id: payload.id, jsonrpc: '2.0', error: { code: e.code, message: e.message } }); });
    },
    send: function (a, b) {
      if (typeof a === 'string') return request({ method: a, params: b });
      if (typeof b === 'function') return provider.sendAsync(a, b);
      var r = a.method === 'eth_accounts' ? state.accounts : a.method === 'eth_coinbase' ? (state.accounts[0] || null)
        : a.method === 'net_version' ? String(parseInt(state.chainId, 16)) : a.method === 'eth_chainId' ? state.chainId : undefined;
      if (r === undefined) throw new Error('Synchronous ' + a.method + ' is not supported; use request()');
      return { id: a.id, jsonrpc: '2.0', result: r };
    },
  };
  provider.addListener = provider.on;
  provider.off = provider.removeListener;

  try { Object.defineProperty(window, 'ethereum', { value: provider, configurable: true, writable: true }); } catch (e) { window.ethereum = provider; }
  if (!window.web3) window.web3 = { currentProvider: provider };

  var info = Object.freeze({ uuid: '__UUID__', name: 'PSYROB Suite', icon: '__ICON__', rdns: 'com.psyrob.suite' });
  function announce() { window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: info, provider: provider }) })); }
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
  window.dispatchEvent(new Event('ethereum#initialized'));
  setTimeout(function () { emit('connect', { chainId: state.chainId }); }, 0);
})();
