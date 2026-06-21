// Content script injetado no YouTube. Só age após receber um papel
// (host/participant) do background — respeitando "não iniciar automaticamente".
// - host: observa o player e envia ações ao servidor.
// - participant: aplica as ações recebidas no player.
// - anúncios: detectados em qualquer papel e reportados ao servidor.

(function () {
  // Evita execução dupla (manifest + injeção sob demanda via scripting).
  if (self.__yousyncLoaded) return;
  self.__yousyncLoaded = true;

  const PROTO = self.YOUSYNC_PROTOCOL;
  if (!PROTO) {
    console.error('[YouSync][content] protocol.js não carregou — verifique a ordem em content_scripts');
    return;
  }
  const { INTERNAL } = PROTO;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log('%c[YouSync][content]', 'color:#ff0033', ...a);

  const SEEK_TOLERANCE = 0.75; // segundos de drift tolerado
  const POLL_MS = 1000;

  let role = 'idle';
  let applyingRemote = false; // evita eco quando aplicamos ação remota
  let adShowing = false;
  let adPausedByRoom = false; // sala pausada por anúncio (não dar play)
  let lastVideoId = currentVideoId();
  let pollTimer = null;
  let hostAttached = false;
  let currentVideoEl = null; // referência ao <video> em que os listeners estão

  log('carregado em', location.href);

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
    log('-> evento', payload.event, payload);
    chrome.runtime.sendMessage({ type: INTERNAL.CONTENT_EVENT, payload }).catch((e) => {
      log('falha ao enviar evento ao background', e);
    });
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

  function detachHostListeners() {
    if (currentVideoEl && hostAttached) {
      currentVideoEl.removeEventListener('play', onPlay);
      currentVideoEl.removeEventListener('pause', onPause);
      currentVideoEl.removeEventListener('seeked', onSeeked);
      currentVideoEl.removeEventListener('ratechange', onRateChange);
      log('host listeners desanexados');
    }
    hostAttached = false;
  }

  // Garante que os listeners do host estejam no <video> atual.
  // Reanexa se o elemento foi trocado pela navegação SPA do YouTube.
  function ensureHostListeners() {
    if (role !== 'host') return;
    const v = getVideo();
    if (!v) {
      log('host: <video> ainda não disponível, tentará novamente no próximo poll');
      return;
    }
    if (v === currentVideoEl && hostAttached) return;
    detachHostListeners();
    currentVideoEl = v;
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('ratechange', onRateChange);
    hostAttached = true;
    log('host listeners anexados ao <video>');
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
      log('seek', v.currentTime.toFixed(2), '->', t.toFixed(2));
      v.currentTime = t;
    }
  }

  function applyPlayback(payload) {
    const v = getVideo();
    if (!v) { log('applyPlayback: sem <video>'); return; }
    log('<- aplicar playback', payload.action, payload);
    withRemote(() => {
      const t = compensatedTime(payload);
      if (payload.action === 'seek') {
        applySeekIfNeeded(v, t);
      } else if (payload.action === 'play') {
        applySeekIfNeeded(v, t);
        if (!adPausedByRoom) v.play().catch((e) => log('play() bloqueado', e));
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
    if (!v) { log('applySync: sem <video>'); return; }
    log('<- aplicar sync', payload);
    withRemote(() => {
      const t = compensatedTime(payload);
      applySeekIfNeeded(v, t);
      if (typeof payload.rate === 'number') v.playbackRate = payload.rate;
      if (adPausedByRoom) return;
      if (payload.paused) v.pause();
      else v.play().catch((e) => log('play() bloqueado', e));
    });
  }

  // ---------- detecção de anúncio + troca de vídeo + reanexo (poll) ----------

  function poll() {
    ensureHostListeners();

    const player = getPlayer();
    const nowAd = !!player && player.classList.contains('ad-showing');
    if (nowAd !== adShowing) {
      adShowing = nowAd;
      log('estado de anúncio mudou ->', nowAd ? 'ANÚNCIO' : 'sem anúncio');
      sendEvent({ event: nowAd ? 'ad_started' : 'ad_ended' });
    }

    if (role === 'host') {
      const vid = currentVideoId();
      if (vid && vid !== lastVideoId) {
        log('host trocou de vídeo ->', vid);
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
    log('poll iniciado');
  }
  function stopPoll() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // ---------- aplicação do papel ----------

  function setRole(newRole) {
    log('papel definido ->', newRole);
    role = newRole;
    detachHostListeners();
    currentVideoEl = null;
    if (role === 'idle') {
      stopPoll();
      adPausedByRoom = false;
      return;
    }
    startPoll();
    if (role === 'host') ensureHostListeners();
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
          log('<- AD_PAUSE: pausando localmente');
          adPausedByRoom = true;
          withRemote(() => { const v = getVideo(); if (v) v.pause(); });
          break;
        case 'ad_resume':
          log('<- AD_RESUME');
          adPausedByRoom = false;
          break;
      }
    }
  });

  // Diagnóstico rápido: yousyncDebug() no console da aba
  self.yousyncDebug = () => ({
    role, hostAttached, adShowing, adPausedByRoom,
    hasVideo: !!getVideo(), videoId: currentVideoId(), polling: !!pollTimer,
  });
})();
