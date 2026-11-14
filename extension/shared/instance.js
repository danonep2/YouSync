// Identificador deste navegador (instalação da extensão), para distinguir os
// logs/erros de cada navegador ao testar com vários ao mesmo tempo.
// Gerado uma vez e salvo em chrome.storage.local; renomeável pelo popup.
// Carregado no service worker, no content script e no popup.
(function (root) {
  const KEY = 'yousyncInstanceLabel';
  const listeners = [];
  const api = {
    label: '…',
    // Garante que exista um rótulo e o carrega. Retorna o rótulo.
    async init() {
      try {
        const data = await chrome.storage.local.get(KEY);
        let label = data[KEY];
        if (!label) {
          label = 'NAV-' + Math.random().toString(36).slice(2, 6).toUpperCase();
          await chrome.storage.local.set({ [KEY]: label });
        }
        api.label = label;
      } catch (_) {
        // Contexto da extensão inválido (script órfão): mantém o rótulo atual.
      }
      return api.label;
    },
    async set(label) {
      const clean = String(label || '').trim().slice(0, 24);
      if (!clean) return api.label;
      await chrome.storage.local.set({ [KEY]: clean });
      api.label = clean;
      return clean;
    },
    onChange(fn) { listeners.push(fn); },
  };

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY] && changes[KEY].newValue) {
        api.label = changes[KEY].newValue;
        listeners.forEach((fn) => { try { fn(api.label); } catch (_) {} });
      }
    });
  } catch (_) {}

  root.YOUSYNC_INSTANCE = api;
})(typeof self !== 'undefined' ? self : this);
