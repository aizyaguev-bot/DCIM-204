// Account-mode compatibility for the standalone/embedded Twin. No credentials
// are persisted; the server checks the same session and roles as the React UI.
(() => {
  const originalFetch = window.fetch.bind(window);
  let csrf = null;
  window.DCIM_CAN_OPERATE = false;
  window.DCIM_ACCOUNT_PREFS = { confirm_power: true, refresh_seconds: 15 };
  window.DCIM_ACCOUNT_READY = (async () => {
    if (location.protocol === 'file:') { window.DCIM_CAN_OPERATE = true; return; }
    try {
      const response = await originalFetch('/api/auth/status', {cache:'no-store'});
      if (response.status === 404 || (response.ok && !response.headers.get('content-type')?.includes('application/json'))) { window.DCIM_CAN_OPERATE = true; return; }
      if (!response.ok) return;
      const auth = await response.json();
      if (auth.mode === 'legacy') { window.DCIM_CAN_OPERATE = true; return; }
      csrf = auth.csrf_token;
      window.DCIM_CAN_OPERATE = !!auth.user && ['Admin','Operator'].includes(auth.user.role) && !auth.user.must_change_password;
      window.DCIM_ACCOUNT_PREFS = {...window.DCIM_ACCOUNT_PREFS, ...auth.user?.preferences};
    } catch { /* A failed auth check leaves actions disabled. */ }
    finally {
      document.body.classList.toggle('account-viewer', !window.DCIM_CAN_OPERATE);
      if (!window.DCIM_CAN_OPERATE) {
        const style = document.createElement('style');
        style.textContent = '.account-viewer #btnEdit,.account-viewer #btnSave,.account-viewer [data-pw],.account-viewer [data-kvm]{display:none!important}';
        document.head.appendChild(style);
      }
    }
  })();
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.origin === location.origin && url.pathname.startsWith('/api/') && !['GET','HEAD','OPTIONS'].includes(method)) {
      await window.DCIM_ACCOUNT_READY;
      if (!window.DCIM_CAN_OPERATE) throw new Error('Viewer access: changes are disabled.');
      if (csrf) {
        const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : {}));
        headers.set('X-DCIM-CSRF', csrf); init = {...init,headers};
      }
    }
    return originalFetch(input, init);
  };
})();
