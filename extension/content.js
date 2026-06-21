// Content script injetado no YouTube. Só age após receber um papel
// (host/participant) do background — respeitando "não iniciar automaticamente".
// - host: observa o player e envia ações ao servidor.
// - participant: aplica as ações recebidas no player.
// - anúncios: detectados em qualquer papel e reportados ao servidor.

(function () {
  const { INTERNAL } = self.YOUSYNC_PROTOCOL;

  const SEEK_TOLERANCE = 0.75; // segundos de drift tolerado
  const POLL_MS = 1000;

  let role = 'idle';
  let applyingRemote = false; // evita eco quando aplicamos ação remota
  let adShowing = false;
  let adPausedByRoom = false; // sala pausada por anúncio (não dar play)
  let lastVideoId = currentVideoId();
  let pollTimer = null;
  let hostAttached = false;

  function getVideo() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }

  function getPlayer() {
    return document.querySelector('.html5-video-player');
  }

  function currentVideoId() {
    try {
      return new URLSearchParams(location.search).get('v');
    } catch {
      return null;
    }
  }

  function sendEvent(payload) {
    chrome.runtime.sendMessage({ type: INTERNAL.CONTENT_EVENT, payload }).catch(() => {});
  }

  // ---------- host: ouvir o player ----------

  function onPlay() {
    if (applyingRemote || adShowing) return;
    const v = getVideo();
    sendEvent({ event: 'play', time: v ? v.currentTime : 0 });
  }
  function onPause() {
    if (applyingRemote || adShowing) return;
    const v = getVideo();
    sendEvent({ event: 'pause', time: v ? v.currentTime : 0 });
  }
  function onSeeked() {
    if (applyingRemote || adShowing) return;
    const v = getVideo();
    sendEvent({ event: 'seek', time: v ? v.currentTime : 0 });
  }
  function onRateChange() {
    if (applyingRemote || adShowing) return;
    const v = getVideo();
    sendEvent({ event: 'rate', time: v ? v.currentTime : 0, rate: v ? v.playbackRate : 1 });
  }

  function attachHostListeners() {
    const v = getVideo();
    if (!v || hostAttached) return;
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('ratechange', onRateChange);
    hostAttached = true;
  }

  function detachHostListeners() {
    const v = getVideo();
    if (v && hostAttached) {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('ratechange', onRateChange);
    }
    hostAttached = false;
  }

  // ---------- participante: aplicar ações remotas ----------

  function withRemote(fn) {
    applyingRemote = true;
    try { fn(); } finally {
      // libera no próximo tick para deixar os eventos do player passarem
      setTimeout(() => { applyingRemote = false; }, 80);
    }
  }

  function compensatedTime(payload) {
    let t = typeof payload.time === 'number' ? payload.time : null;
    if (t == null) return null;
    if (payload.serverTime && payload.paused === false) {
      t += Math.max(0, (Date.now() - payload.serverTime) / 1000);
    }
    return t;
  }

  function applySeekIfNeeded(v, t) {
    if (t == null) return;
    if (Math.abs(v.currentTime - t) > SEEK_TOLERANCE) {
      v.currentTime = t;
    }
  }

  function applyPlayback(payload) {
    const v = getVideo();
    if (!v) return;
    withRemote(() => {
      const t = compensatedTime(payload);
      if (payload.action === 'seek') {
        applySeekIfNeeded(v, t);
      } else if (payload.action === 'play') {
        applySeekIfNeeded(v, t);
        if (!adPausedByRoom) v.play().catch(() => {});
      } else if (payload.action === 'pause') {
        applySeekIfNeeded(v, t);
        v.pause();
      } else if (payload.action === 'rate') {
        if (typeof payload.rate === 'number') v.playbackRate = payload.rate;
      }
    });
  }

  function applySync(payload) {
    const v = getVideo();
    if (!v) return;
    withRemote(() => {
      const t = compensatedTime(payload);
      applySeekIfNeeded(v, t);
      if (typeof payload.rate === 'number') v.playbackRate = payload.rate;
      if (adPausedByRoom) return;
      if (payload.paused) v.pause();
      else v.play().catch(() => {});
    });
  }

  // ---------- detecção de anúncio + troca de vídeo (poll) ----------

  function poll() {
    const player = getPlayer();
    const nowAd = !!player && player.classList.contains('ad-showing');
    if (nowAd !== adShowing) {
      adShowing = nowAd;
      sendEvent({ event: nowAd ? 'ad_started' : 'ad_ended' });
    }

    if (role === 'host') {
      const vid = currentVideoId();
      if (vid && vid !== lastVideoId) {
        lastVideoId = vid;
        sendEvent({ event: 'video', videoId: vid, time: 0 });
      }
    } else {
      lastVideoId = currentVideoId();
    }
  }

  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(poll, POLL_MS);
  }
  function stopPoll() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // ---------- aplicação do papel ----------

  function setRole(newRole) {
    role = newRole;
    detachHostListeners();
    if (role === 'idle') {
      stopPoll();
      adPausedByRoom = false;
      return;
    }
    startPoll();
    if (role === 'host') attachHostListeners();
  }

  // ---------- mensagens do background ----------

  chrome.runtime.onMessage.addListener((message) => {
    const { type, payload = {} } = message || {};
    if (type === INTERNAL.CONTENT_SET_ROLE) {
      setRole(payload.role);
      return;
    }
    if (type === INTERNAL.CONTENT_APPLY) {
      switch (payload.kind) {
        case 'playback':
          applyPlayback(payload);
          break;
        case 'video':
          applySync({ ...payload, paused: false });
          break;
        case 'sync':
          applySync(payload);
          break;
        case 'ad_pause':
          adPausedByRoom = true;
          withRemote(() => { const v = getVideo(); if (v) v.pause(); });
          break;
        case 'ad_resume':
          adPausedByRoom = false;
          break;
      }
    }
  });
})();
