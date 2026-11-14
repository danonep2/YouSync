// Content script injetado no YouTube. Só age após receber um papel do background.
// - quem pode controlar (host, ou todos no modo "controles compartilhados"):
//   observa o player e envia ações de reprodução.
// - troca de vídeo: exclusiva do host.
// - participante: aplica as ações recebidas.
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
  const INSTANCE = self.YOUSYNC_INSTANCE || { label: '?', init: async () => '?' };
  const log = (...a) => DEBUG && console.log(`%c[YouSync][${INSTANCE.label}][content]`, 'color:#ff0033', ...a);
  INSTANCE.init();

  const SEEK_TOLERANCE = 0.75; // segundos de drift tolerado
  const POLL_MS = 1000;
  const READY_TIMEOUT_MS = 10000;

  let role = 'idle';
  let canControl = false; // pode emitir ações de reprodução?
  let applyingRemote = false; // evita eco quando aplicamos ação remota
  let adShowing = false; // este player está exibindo anúncio agora
  let adPausedByRoom = false; // sala pausada por anúncio de OUTRO usuário
  let lastVideoId = currentVideoId();
  let pollTimer = null;
  let listenersAttached = false;
  let currentVideoEl = null; // <video> em que os listeners estão

  INSTANCE.init().then(() => log('carregado em', location.href));

  function getVideo() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }
  function getPlayer() {
    return document.querySelector('.html5-video-player');
  }
  function currentVideoId() {
    try { return new URLSearchParams(location.search).get('v'); } catch { return null; }
  }
  // Verificação AO VIVO do anúncio (evita a latência do poll de 1s).
  function isAdActive() {
    const p = getPlayer();
    return !!p && p.classList.contains('ad-showing');
  }

  // Após recarregar/atualizar a extensão, este script fica "órfão" na aba:
  // os listeners do <video> continuam ativos, mas chrome.runtime some e
  // sendMessage lança "Extension context invalidated" (síncrono, fora do
  // .catch). Detectamos isso e desligamos o script velho.
  function extensionAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; }
  }
  let orphaned = false;
  function shutdownOrphan() {
    if (orphaned) return;
    orphaned = true;
    role = 'idle';
    canControl = false;
    detachListeners();
    stopPoll();
    clearTimeout(settleTimer);
    log('contexto da extensão invalidado — script antigo desligado');
  }

  function sendEvent(payload) {
    if (orphaned) return;
    if (!extensionAlive()) { shutdownOrphan(); return; }
    log('-> evento', payload.event, payload);
    try {
      chrome.runtime.sendMessage({ type: INTERNAL.CONTENT_EVENT, payload }).catch((e) => {
        log('falha ao enviar evento ao background', e);
      });
    } catch (e) {
      shutdownOrphan();
    }
  }

  // ---------- ouvir o player (quem pode controlar) ----------

  // Durante um anúncio (deste player), NÃO emitimos eventos de reprodução:
  // o YouTube dispara play/pause ao trocar para o anúncio e de volta, e isso
  // poluiria o estado da sala. Checamos adShowing (poll) E o DOM ao vivo.
  function adOrRemote() {
    return applyingRemote || adShowing || isAdActive();
  }
  function onPlay() {
    if (adOrRemote()) return;
    const v = getVideo();
    sendEvent({ event: 'play', time: v ? v.currentTime : 0 });
  }
  function onPause() {
    if (adOrRemote()) return;
    const v = getVideo();
    sendEvent({ event: 'pause', time: v ? v.currentTime : 0 });
  }
  function onSeeked() {
    if (adOrRemote()) return;
    const v = getVideo();
    sendEvent({ event: 'seek', time: v ? v.currentTime : 0 });
  }
  function onRateChange() {
    if (adOrRemote()) return;
    const v = getVideo();
    sendEvent({ event: 'rate', time: v ? v.currentTime : 0, rate: v ? v.playbackRate : 1 });
  }

  function detachListeners() {
    if (currentVideoEl && listenersAttached) {
      currentVideoEl.removeEventListener('play', onPlay);
      currentVideoEl.removeEventListener('pause', onPause);
      currentVideoEl.removeEventListener('seeked', onSeeked);
      currentVideoEl.removeEventListener('ratechange', onRateChange);
      log('listeners de controle desanexados');
    }
    listenersAttached = false;
  }

  // Garante listeners no <video> atual quando o usuário pode controlar.
  // Reanexa se o YouTube trocar o elemento <video> na navegação SPA.
  function ensureListeners() {
    if (!canControl) { detachListeners(); return; }
    const v = getVideo();
    if (!v) { log('controle: <video> ainda não disponível'); return; }
    if (v === currentVideoEl && listenersAttached) return;
    detachListeners();
    currentVideoEl = v;
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('ratechange', onRateChange);
    listenersAttached = true;
    log('listeners de controle anexados ao <video>');
  }

  // ---------- aplicar ações remotas ----------

  function withRemote(fn) {
    applyingRemote = true;
    try { fn(); } finally {
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

  // playing=true quando o vídeo deve seguir tocando após o seek: agenda um
  // ajuste fino, pois o player leva um tempo para bufferizar e fica atrás.
  function applySeekIfNeeded(v, t, playing = false) {
    if (t == null) return;
    if (Math.abs(v.currentTime - t) > SEEK_TOLERANCE) {
      log('seek', v.currentTime.toFixed(2), '->', t.toFixed(2));
      v.currentTime = t;
      if (playing) scheduleSettle(v, t);
    }
  }

  // Ajuste fino único após um seek em reprodução: compara a posição real com a
  // esperada (alvo + tempo decorrido) e corrige o atraso do buffering.
  const SETTLE_DELAY_MS = 1500;
  const SETTLE_TOLERANCE = 0.2;
  let settleTimer = null;
  function scheduleSettle(v, t) {
    const w0 = performance.now();
    clearTimeout(settleTimer);
    const check = (attempt) => {
      if (v !== getVideo() || v.paused || adPausedByRoom || isAdActive()) return;
      if (v.readyState < 3 && attempt < 3) { // ainda bufferizando
        settleTimer = setTimeout(() => check(attempt + 1), 500);
        return;
      }
      const expected = t + ((performance.now() - w0) / 1000) * (v.playbackRate || 1);
      const diff = expected - v.currentTime;
      if (Math.abs(diff) > SETTLE_TOLERANCE && Math.abs(diff) < 5) {
        log('ajuste fino', v.currentTime.toFixed(2), '->', expected.toFixed(2), `(${diff.toFixed(2)}s)`);
        withRemote(() => { v.currentTime = expected; });
      }
    };
    settleTimer = setTimeout(() => check(0), SETTLE_DELAY_MS);
  }

  function applyPlayback(payload) {
    const v = getVideo();
    if (!v) { log('applyPlayback: sem <video>'); return; }
    log('<- playback', payload.action, payload);
    withRemote(() => {
      const t = compensatedTime(payload);
      if (payload.action === 'seek') {
        applySeekIfNeeded(v, t, payload.paused === false && !adPausedByRoom);
      } else if (payload.action === 'play') {
        applySeekIfNeeded(v, t, !adPausedByRoom);
        if (!adPausedByRoom) v.play().catch((e) => log('play() bloqueado', e));
      } else if (payload.action === 'pause') {
        applySeekIfNeeded(v, t);
        v.pause();
      } else if (payload.action === 'rate') {
        if (typeof payload.rate === 'number') v.playbackRate = payload.rate;
      }
      // seek/rate não mudam play/pause, mas trazem o estado da sala: realinha
      // quem divergiu localmente (ex.: participante que pausou por conta própria).
      if ((payload.action === 'seek' || payload.action === 'rate') && typeof payload.paused === 'boolean') {
        if (payload.paused && !v.paused) v.pause();
        else if (!payload.paused && v.paused && !adPausedByRoom) {
          v.play().catch((e) => log('play() bloqueado', e));
        }
      }
    });
  }

  function applySync(payload) {
    const v = getVideo();
    if (!v) { log('applySync: sem <video>'); return; }
    log('<- sync', payload);
    withRemote(() => {
      const t = compensatedTime(payload);
      applySeekIfNeeded(v, t, !payload.paused && !adPausedByRoom);
      if (typeof payload.rate === 'number') v.playbackRate = payload.rate;
      if (adPausedByRoom) return;
      if (payload.paused) v.pause();
      else v.play().catch((e) => log('play() bloqueado', e));
    });
  }

  // ---------- carregamento sincronizado de vídeo ----------

  // Carrega o vídeo PAUSADO e avisa o servidor quando estiver pronto.
  function prepare(payload) {
    log('<- prepare (carregar pausado)', payload);
    const apply = () => {
      const v = getVideo();
      if (!v) { setTimeout(apply, 250); return; }
      withRemote(() => {
        applySeekIfNeeded(v, typeof payload.time === 'number' ? payload.time : 0);
        v.pause();
      });
      waitReady(payload.videoId, v);
    };
    apply();
  }

  function waitReady(videoId, v) {
    let done = false;
    const report = () => {
      if (done) return;
      done = true;
      v.removeEventListener('canplay', report);
      log('vídeo pronto, reportando ao servidor');
      sendEvent({ event: 'video_ready', videoId });
    };
    if (v.readyState >= 3) { report(); return; } // HAVE_FUTURE_DATA
    v.addEventListener('canplay', report);
    setTimeout(report, READY_TIMEOUT_MS); // fallback: não trava a sala
  }

  // Início simultâneo após todos estarem prontos.
  function start(payload) {
    const v = getVideo();
    if (!v) { log('start: sem <video>'); return; }
    log('<- start (play simultâneo)', payload);
    withRemote(() => {
      applySeekIfNeeded(v, compensatedTime({ ...payload, paused: false }), !adPausedByRoom);
      if (!adPausedByRoom) v.play().catch((e) => log('play() bloqueado', e));
    });
  }

  // ---------- detecção de anúncio + troca de vídeo + reanexo (poll) ----------

  function poll() {
    if (!extensionAlive()) { shutdownOrphan(); return; }
    ensureListeners();

    const player = getPlayer();
    const nowAd = !!player && player.classList.contains('ad-showing');
    if (nowAd !== adShowing) {
      adShowing = nowAd;
      log('anúncio local ->', nowAd ? 'ANÚNCIO' : 'sem anúncio');
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

  // ---------- papel ----------

  function setRole(payload) {
    role = payload.role;
    canControl = !!payload.canControl;
    log('papel ->', role, 'canControl=', canControl);
    detachListeners();
    currentVideoEl = null;
    if (role === 'idle') {
      stopPoll();
      adPausedByRoom = false;
      return;
    }
    startPoll();
    ensureListeners();
    if (role === 'host') reportHostState();
  }

  // Host informa o estado real do player ao assumir o papel: o vídeo pode já
  // estar tocando antes da sala existir, e aí nenhum evento 'play' é emitido.
  function reportHostState(attempt = 0) {
    if (role !== 'host') return;
    // Fora de /watch (ex.: página inicial com prévias) não há estado da sala a informar.
    if (!currentVideoId()) return;
    const v = getVideo();
    if (!v || adOrRemote()) {
      // Sem <video> ainda, ou em anúncio (tempo/estado seriam do anúncio).
      if (attempt < 20) setTimeout(() => reportHostState(attempt + 1), 500);
      return;
    }
    sendEvent({
      event: 'host_state',
      videoId: currentVideoId(),
      time: v.currentTime,
      paused: v.paused,
      rate: v.playbackRate,
    });
  }

  // ---------- mensagens do background ----------

  chrome.runtime.onMessage.addListener((message) => {
    const { type, payload = {} } = message || {};
    if (type === INTERNAL.CONTENT_SET_ROLE) {
      setRole(payload);
      return;
    }
    if (type === INTERNAL.CONTENT_APPLY) {
      switch (payload.kind) {
        case 'playback': applyPlayback(payload); break;
        case 'sync': applySync(payload); break;
        case 'prepare': prepare(payload); break;
        case 'start': start(payload); break;
        case 'ad_pause':
          // O servidor diz se o anúncio é MEU (isOwner). Se for, continuo
          // reproduzindo (assisto/pulo o anúncio); se for de outro, pauso.
          if (payload.isOwner) {
            adPausedByRoom = false;
            log('<- AD_PAUSE: o anúncio é meu, continuo reproduzindo');
          } else {
            adPausedByRoom = true;
            log('<- AD_PAUSE: pausando até o anúncio de outro terminar');
            withRemote(() => { const v = getVideo(); if (v) v.pause(); });
          }
          break;
        case 'ad_resume':
          log('<- AD_RESUME');
          adPausedByRoom = false;
          break;
      }
    }
  });

  // Diagnóstico: yousyncDebug() no console da aba
  self.yousyncDebug = () => ({
    role, canControl, listenersAttached, adShowing, adPausedByRoom,
    hasVideo: !!getVideo(), videoId: currentVideoId(), polling: !!pollTimer,
  });
})();
