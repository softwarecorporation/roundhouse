// SPDX-License-Identifier: MPL-2.0
// Install explicitly with async, data-site, and an HTTPS data-endpoint collect base.
(() => {
  const script = document.currentScript;
  const site = script?.dataset.site;
  const endpoint = script?.dataset.endpoint;
  const optedOut = () => navigator.doNotTrack === '1' || navigator.doNotTrack === 'yes' || navigator.globalPrivacyControl === true;
  if (!site || !/^[a-f0-9]{32}$/.test(site) || !endpoint || optedOut()) return;
  let base;
  try { base = new URL(endpoint, location.href); } catch { return; }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) return;
  const collect = `${base.href.replace(/\/$/, '')}/${site}`;
  let previous;
  function send(kind, name) {
    if (optedOut() || typeof name !== 'string' || !name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return;
    const event = { id: crypto.randomUUID(), kind, name, path: location.pathname, at: new Date().toISOString() };
    try {
      const ref = new URL(document.referrer);
      if (ref.protocol === 'https:') event.referrer = ref.origin;
    } catch { /* Empty or non-URL referrer. */ }
    fetch(collect, { method: 'POST', credentials: 'omit', mode: 'cors', keepalive: true,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) }).catch(() => {});
  }
  function pageview() {
    if (previous === location.pathname) return;
    previous = location.pathname;
    send('pageview', 'pageview');
  }
  const pushState = history.pushState;
  history.pushState = function (...args) { const result = pushState.apply(this, args); pageview(); return result; };
  addEventListener('popstate', pageview);
  window.roundhouse = { track: name => send('event', name) };
  pageview();
})();
