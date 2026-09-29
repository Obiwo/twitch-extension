(function () {
  'use strict';

  const LOG = '[Twitch Auto PiP]';
  const VOLUME_STEP = 0.05;
  const CONTROLS_HIDE_MS = 2500;
  const HUD_HIDE_MS = 900;

  const state = {
    pipWindow: null,
    video: null,
    placeholder: null,
    originalStyle: null,
    originalParent: null,
    opening: false,
    cleanup: [],
    pipAdBadge: null,
  };

  // Estado del bloqueo de anuncios (lo alimenta adblock.js vía window.postMessage)
  const adState = { active: false, isMidroll: false, playerType: null, height: 0, originalHeight: 0 };

  // --------------------------------------------------------------------------
  // Estilos de la ventana flotante (estética Apple: redondeado, cristal, SF)
  // --------------------------------------------------------------------------
  const CSS = `
    :root { color-scheme: dark; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display",
        "Helvetica Neue", Inter, system-ui, sans-serif;
      color: #fff;
      -webkit-font-smoothing: antialiased;
      user-select: none;
      cursor: default;
    }
    body.hide-cursor { cursor: none; }

    .stage {
      position: absolute; inset: 0;
      border-radius: 18px; overflow: hidden;
      background: #000;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.08);
    }
    .stage video { width: 100%; height: 100%; object-fit: contain; display: block; }

    .overlay {
      position: absolute; inset: 0;
      opacity: 0; pointer-events: none;
      transition: opacity .35s cubic-bezier(.2,.8,.2,1);
    }
    body.show-controls .overlay { opacity: 1; }
    .overlay > * { pointer-events: auto; }
    .shade {
      position: absolute; inset: 0; pointer-events: none;
      background:
        linear-gradient(to top, rgba(0,0,0,.55), transparent 45%),
        linear-gradient(to bottom, rgba(0,0,0,.35), transparent 30%);
    }

    .glass {
      background: rgba(28,28,30,.55);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      backdrop-filter: blur(24px) saturate(180%);
      border: 1px solid rgba(255,255,255,.14);
      box-shadow: 0 8px 30px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.12);
    }

    .topbar {
      position: absolute; top: 12px; left: 12px;
      height: 28px; padding: 0 12px 0 10px;
      border-radius: 999px;
      display: flex; align-items: center; gap: 8px;
      font-size: 12px; font-weight: 600; letter-spacing: .01em;
      max-width: calc(100% - 24px);
    }
    .live-dot {
      width: 8px; height: 8px; border-radius: 50%; flex: none;
      background: #ff3b30;
      animation: pulse 1.6s ease-in-out infinite;
    }
    .channel { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .controls {
      position: absolute; left: 12px; right: 12px; bottom: 12px;
      height: 52px; border-radius: 20px;
      display: flex; align-items: center; gap: 6px; padding: 0 10px;
    }
    .btn {
      width: 38px; height: 38px; border-radius: 50%; flex: none;
      border: none; background: transparent; color: #fff;
      display: grid; place-items: center; cursor: pointer;
      transition: background .2s, transform .15s cubic-bezier(.2,.8,.2,1);
    }
    .btn:hover { background: rgba(255,255,255,.14); }
    .btn:active { transform: scale(.9); }
    .btn:focus-visible { outline: 2px solid rgba(255,255,255,.6); outline-offset: 2px; }
    .btn svg { width: 20px; height: 20px; fill: currentColor; }

    .volume { flex: 1; display: flex; align-items: center; gap: 10px; min-width: 0; padding-right: 4px; }
    input[type=range] {
      -webkit-appearance: none; appearance: none;
      flex: 1; min-width: 0; height: 5px; border-radius: 999px; outline: none; cursor: pointer;
      background: linear-gradient(to right, #fff var(--v, 50%), rgba(255,255,255,.28) var(--v, 50%));
    }
    input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 18px; height: 18px; border-radius: 50%; background: #fff;
      box-shadow: 0 1px 4px rgba(0,0,0,.35), 0 0 0 .5px rgba(0,0,0,.08);
      transition: transform .15s cubic-bezier(.2,.8,.2,1);
    }
    input[type=range]:hover::-webkit-slider-thumb,
    input[type=range]:active::-webkit-slider-thumb { transform: scale(1.15); }
    .vol-label {
      font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums;
      min-width: 34px; text-align: right; opacity: .85;
    }

    .hud {
      position: absolute; top: 50%; left: 50%;
      width: 120px; padding: 16px 0 14px; border-radius: 22px;
      display: flex; flex-direction: column; align-items: center; gap: 10px;
      opacity: 0; pointer-events: none;
      transform: translate(-50%,-50%) scale(.9);
      transition: opacity .25s, transform .25s cubic-bezier(.2,.8,.2,1);
    }
    .hud.visible { opacity: 1; transform: translate(-50%,-50%) scale(1); }
    .hud svg { width: 34px; height: 34px; fill: #fff; }
    .hud-bar { width: 80px; height: 5px; border-radius: 999px; background: rgba(255,255,255,.25); overflow: hidden; }
    .hud-fill { height: 100%; width: 50%; background: #fff; border-radius: 999px; transition: width .12s; }

    @keyframes pulse {
      0%, 100% { box-shadow: 0 0 0 3px rgba(255,59,48,.25); }
      50%      { box-shadow: 0 0 0 6px rgba(255,59,48,.06); }
    }
    .ad-badge {
      position: absolute; top: 12px; right: 12px;
      height: 28px; padding: 0 12px 0 9px; border-radius: 999px;
      display: flex; align-items: center; gap: 7px;
      font-size: 12px; font-weight: 600; letter-spacing: .01em;
      color: #fff; background: rgba(52,199,89,.28);
      border-color: rgba(52,199,89,.45);
      opacity: 0; transform: translateY(-6px); pointer-events: none;
      transition: opacity .3s, transform .3s cubic-bezier(.2,.8,.2,1);
    }
    .ad-badge.visible { opacity: 1; transform: none; }
    .ad-badge svg { width: 15px; height: 15px; fill: #fff; }

    @media (max-width: 320px) { .vol-label, .topbar, .ad-badge { display: none; } }
    @media (max-height: 200px) { .topbar { display: none; } }
  `;

  const ICONS = {
    play: 'M8 5v14l11-7z',
    pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
    volHigh: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z',
    volLow: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12z',
    shield: 'M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z',
    volMute: 'M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12a9 9 0 0 0-7-8.77v2.06A7 7 0 0 1 19 12zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.9 8.9 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z',
  };

  // --------------------------------------------------------------------------
  // Utilidades
  // --------------------------------------------------------------------------
  function getVideo() {
    return document.querySelector('video');
  }

  function getChannelName() {
    const seg = location.pathname.split('/').filter(Boolean)[0] || '';
    const reserved = ['directory', 'videos', 'settings', 'search', 'downloads', 'p', 'u', 'popout', 'moderator'];
    if (seg && /^[\w]+$/.test(seg) && !reserved.includes(seg.toLowerCase())) return seg;
    return document.title.replace(/\s*-\s*Twitch\s*$/i, '').trim() || 'Twitch';
  }

  function el(doc, tag, className, attrs) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  function svgIcon(doc, pathD) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS(ns, 'path');
    path.setAttribute('d', pathD);
    svg.appendChild(path);
    return svg;
  }

  function setIcon(button, pathD) {
    button.querySelector('path').setAttribute('d', pathD);
  }

  function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    state.cleanup.push(() => target.removeEventListener(type, handler, options));
  }

  // --------------------------------------------------------------------------
  // Ventana flotante personalizada (Document Picture-in-Picture)
  // --------------------------------------------------------------------------
  async function openDocumentPip(video) {
    const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
    const width = 520;
    const height = Math.round(width / aspect);

    const pipWindow = await window.documentPictureInPicture.requestWindow({ width, height });
    state.pipWindow = pipWindow;
    state.video = video;

    const doc = pipWindow.document;
    doc.documentElement.lang = 'es';
    doc.title = getChannelName();

    const style = doc.createElement('style');
    style.textContent = CSS;
    doc.head.appendChild(style);

    // Escenario del vídeo
    const stage = el(doc, 'div', 'stage');

    // Capa de controles
    const overlay = el(doc, 'div', 'overlay');
    overlay.appendChild(el(doc, 'div', 'shade'));

    const topbar = el(doc, 'div', 'topbar glass');
    topbar.appendChild(el(doc, 'span', 'live-dot'));
    const channel = el(doc, 'span', 'channel');
    channel.textContent = getChannelName();
    topbar.appendChild(channel);
    overlay.appendChild(topbar);

    // Badge de anuncio bloqueado (independiente del overlay para que siempre se vea)
    const adBadge = el(doc, 'div', 'ad-badge glass');
    adBadge.appendChild(svgIcon(doc, ICONS.shield));
    const adBadgeText = el(doc, 'span');
    adBadge.appendChild(adBadgeText);
    state.pipAdBadge = { root: adBadge, text: adBadgeText };

    const controls = el(doc, 'div', 'controls glass');

    const playBtn = el(doc, 'button', 'btn', { type: 'button', 'aria-label': 'Reproducir / Pausar' });
    playBtn.appendChild(svgIcon(doc, video.paused ? ICONS.play : ICONS.pause));

    const muteBtn = el(doc, 'button', 'btn', { type: 'button', 'aria-label': 'Silenciar' });
    muteBtn.appendChild(svgIcon(doc, ICONS.volHigh));

    const volumeWrap = el(doc, 'div', 'volume');
    const slider = el(doc, 'input', null, {
      type: 'range', min: '0', max: '100', step: '1', 'aria-label': 'Volumen',
    });
    const volLabel = el(doc, 'span', 'vol-label');
    volumeWrap.appendChild(slider);
    volumeWrap.appendChild(volLabel);

    controls.appendChild(playBtn);
    controls.appendChild(muteBtn);
    controls.appendChild(volumeWrap);
    overlay.appendChild(controls);

    // HUD central de volumen (estilo macOS)
    const hud = el(doc, 'div', 'hud glass');
    hud.appendChild(svgIcon(doc, ICONS.volHigh));
    const hudBar = el(doc, 'div', 'hud-bar');
    const hudFill = el(doc, 'div', 'hud-fill');
    hudBar.appendChild(hudFill);
    hud.appendChild(hudBar);

    doc.body.appendChild(stage);
    doc.body.appendChild(overlay);
    doc.body.appendChild(adBadge);
    doc.body.appendChild(hud);
    renderAdIndicators();

    // Mover el <video> real de Twitch a la ventana flotante (mantiene la reproducción)
    state.originalParent = video.parentNode;
    state.originalStyle = video.getAttribute('style');
    state.placeholder = document.createComment('twitch-auto-pip-placeholder');
    video.parentNode.insertBefore(state.placeholder, video);
    stage.appendChild(video);
    video.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
    video.play().catch(() => {});
    showPageNotice();
    updatePlayerButton();

    // ---- Estado de volumen / reproducción ----
    function effectiveVolume() {
      return video.muted ? 0 : video.volume;
    }

    function volumeIcon(v) {
      if (v === 0) return ICONS.volMute;
      if (v < 0.5) return ICONS.volLow;
      return ICONS.volHigh;
    }

    function syncVolumeUI() {
      const v = effectiveVolume();
      const pct = Math.round(v * 100);
      slider.value = String(pct);
      slider.style.setProperty('--v', pct + '%');
      volLabel.textContent = pct + '%';
      setIcon(muteBtn, volumeIcon(v));
      muteBtn.setAttribute('aria-label', video.muted ? 'Activar sonido' : 'Silenciar');
      hud.querySelector('path').setAttribute('d', volumeIcon(v));
      hudFill.style.width = pct + '%';
    }

    function syncPlayUI() {
      setIcon(playBtn, video.paused ? ICONS.play : ICONS.pause);
    }

    let hudTimer = 0;
    function showHud() {
      hud.classList.add('visible');
      pipWindow.clearTimeout(hudTimer);
      hudTimer = pipWindow.setTimeout(() => hud.classList.remove('visible'), HUD_HIDE_MS);
    }

    function setVolume(value, { hud: withHud = true } = {}) {
      const v = Math.min(1, Math.max(0, value));
      if (v > 0 && video.muted) video.muted = false;
      if (v === 0 && !video.muted) video.muted = true;
      video.volume = v;
      syncVolumeUI();
      if (withHud) showHud();
    }

    function toggleMute() {
      video.muted = !video.muted;
      if (!video.muted && video.volume === 0) video.volume = 0.5;
      syncVolumeUI();
      showHud();
    }

    function togglePlay() {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    }

    // ---- Auto-ocultar controles ----
    let controlsTimer = 0;
    function showControls() {
      doc.body.classList.add('show-controls');
      doc.body.classList.remove('hide-cursor');
      pipWindow.clearTimeout(controlsTimer);
      controlsTimer = pipWindow.setTimeout(() => {
        doc.body.classList.remove('show-controls');
        doc.body.classList.add('hide-cursor');
      }, CONTROLS_HIDE_MS);
    }

    // ---- Eventos ----
    on(playBtn, 'click', togglePlay);
    on(muteBtn, 'click', toggleMute);
    on(slider, 'input', () => setVolume(Number(slider.value) / 100, { hud: false }));
    on(stage, 'click', togglePlay);
    on(stage, 'dblclick', () => pipWindow.close());

    on(doc, 'mousemove', showControls);
    on(doc, 'mouseenter', showControls);
    on(doc, 'mouseleave', () => {
      pipWindow.clearTimeout(controlsTimer);
      doc.body.classList.remove('show-controls');
    });

    on(doc, 'wheel', (e) => {
      e.preventDefault();
      setVolume(effectiveVolume() + (e.deltaY < 0 ? VOLUME_STEP : -VOLUME_STEP));
    }, { passive: false });

    on(doc, 'keydown', (e) => {
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault(); setVolume(effectiveVolume() + VOLUME_STEP); break;
        case 'ArrowDown':
          e.preventDefault(); setVolume(effectiveVolume() - VOLUME_STEP); break;
        case 'm': case 'M':
          toggleMute(); break;
        case ' ': case 'k': case 'K':
          e.preventDefault(); togglePlay(); break;
        case 'Escape':
          pipWindow.close(); break;
      }
    });

    on(video, 'volumechange', syncVolumeUI);
    on(video, 'play', syncPlayUI);
    on(video, 'pause', syncPlayUI);

    // Al cerrar la ventana (X, "volver a la pestaña" o pipWindow.close()) devolvemos el vídeo
    on(pipWindow, 'pagehide', restoreVideo);

    syncVolumeUI();
    syncPlayUI();
    showControls();
  }

  function restoreVideo() {
    const { video, placeholder, originalParent, originalStyle } = state;

    for (const fn of state.cleanup.splice(0)) {
      try { fn(); } catch (_) { /* ignorar */ }
    }

    if (video) {
      try {
        if (placeholder && placeholder.parentNode) {
          placeholder.parentNode.replaceChild(video, placeholder);
        } else if (originalParent && originalParent.isConnected) {
          originalParent.appendChild(video);
        }
        if (originalStyle == null) video.removeAttribute('style');
        else video.setAttribute('style', originalStyle);
        video.play().catch(() => {});
      } catch (err) {
        console.error(LOG, 'No se pudo devolver el vídeo a la página:', err);
      }
    }
    if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
    hidePageNotice();

    state.pipWindow = null;
    state.video = null;
    state.placeholder = null;
    state.originalParent = null;
    state.originalStyle = null;
    state.pipAdBadge = null;
    updatePlayerButton();
  }

  // --------------------------------------------------------------------------
  // Indicadores de anuncio bloqueado (página + ventana PiP)
  // --------------------------------------------------------------------------
  function adLabel() {
    if (!adState.active) return '';
    if (adState.height && adState.originalHeight && adState.height < adState.originalHeight) {
      return 'Anuncio omitido · ' + adState.height + 'p durante el corte';
    }
    return 'Anuncio omitido';
  }

  function renderAdIndicators() {
    const label = adLabel();

    if (state.pipAdBadge) {
      state.pipAdBadge.text.textContent = label;
      state.pipAdBadge.root.classList.toggle('visible', adState.active);
    }

    if (adState.active) {
      ensurePageStyles();
      const video = state.video || getVideo();
      const host = state.originalParent || (video && video.parentElement);
      if (!host || !host.isConnected) return;
      if (!page.adToast || !page.adToast.isConnected || page.adToast.parentElement !== host) {
        hideAdToast();
        page.adToast = el(document, 'div', 'tap-ad-toast', { 'data-tap-ad-toast': '1' });
        page.adToast.appendChild(svgIcon(document, ICONS.shield));
        page.adToast.appendChild(el(document, 'span'));
        host.appendChild(page.adToast);
      }
      page.adToast.querySelector('span').textContent = label;
    } else {
      hideAdToast();
    }
  }

  function hideAdToast() {
    if (page.adToast && page.adToast.parentNode) page.adToast.parentNode.removeChild(page.adToast);
    page.adToast = null;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'twitch-auto-pip' || typeof data.type !== 'string') return;
    switch (data.type) {
      case 'ad-started':
        adState.active = true;
        adState.isMidroll = !!data.isMidroll;
        adState.playerType = null;
        adState.height = 0;
        adState.originalHeight = 0;
        break;
      case 'ad-backup':
        adState.active = true;
        adState.playerType = data.playerType || null;
        adState.height = Number(data.height) || 0;
        adState.originalHeight = Number(data.originalHeight) || 0;
        break;
      case 'ad-ended':
        adState.active = false;
        adState.playerType = null;
        adState.height = 0;
        adState.originalHeight = 0;
        break;
      default:
        return;
    }
    renderAdIndicators();
  });

  // --------------------------------------------------------------------------
  // Integración en la página de Twitch: botón en el reproductor, aviso y atajo
  // --------------------------------------------------------------------------
  const PAGE_CSS = `
    .tap-pip-button {
      display: inline-flex; align-items: center; justify-content: center;
      width: 3rem; height: 3rem; margin: 0; padding: 0;
      border: none; border-radius: 0.4rem; background: transparent; color: #fff;
      cursor: pointer; vertical-align: middle;
      transition: background .15s, transform .15s cubic-bezier(.2,.8,.2,1);
    }
    .tap-pip-button:hover { background: rgba(255,255,255,.15); }
    .tap-pip-button:active { transform: scale(.92); }
    .tap-pip-button:focus-visible { outline: 2px solid #fff; outline-offset: -2px; }
    .tap-pip-button svg { width: 2rem; height: 2rem; fill: currentColor; }
    .tap-pip-button[aria-pressed="true"] { color: #bf94ff; }

    .tap-pip-notice {
      position: absolute; inset: 0; z-index: 5;
      display: grid; place-items: center; pointer-events: none;
      background: radial-gradient(ellipse at center, rgba(0,0,0,.35), rgba(0,0,0,.75));
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Inter, system-ui, sans-serif;
      color: #fff; -webkit-font-smoothing: antialiased;
    }
    .tap-pip-notice__card {
      pointer-events: auto; cursor: pointer;
      display: flex; flex-direction: column; align-items: center; gap: 10px;
      padding: 22px 28px; border-radius: 22px;
      background: rgba(28,28,30,.55);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      backdrop-filter: blur(24px) saturate(180%);
      border: 1px solid rgba(255,255,255,.14);
      box-shadow: 0 8px 30px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.12);
      transition: transform .2s cubic-bezier(.2,.8,.2,1), background .2s;
    }
    .tap-pip-notice__card:hover { transform: scale(1.03); background: rgba(44,44,46,.6); }
    .tap-pip-notice__card svg { width: 36px; height: 36px; fill: #fff; opacity: .9; }
    .tap-pip-notice__title { font-size: 15px; font-weight: 600; letter-spacing: .01em; }
    .tap-pip-notice__hint { font-size: 12px; opacity: .7; }

    .tap-ad-toast {
      position: absolute; top: 14px; right: 14px; z-index: 6;
      height: 30px; padding: 0 13px 0 10px; border-radius: 999px;
      display: flex; align-items: center; gap: 7px; pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Inter, system-ui, sans-serif;
      font-size: 12.5px; font-weight: 600; letter-spacing: .01em; color: #fff;
      background: rgba(52,199,89,.28);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      backdrop-filter: blur(24px) saturate(180%);
      border: 1px solid rgba(52,199,89,.45);
      box-shadow: 0 8px 30px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.12);
      animation: tap-toast-in .3s cubic-bezier(.2,.8,.2,1);
    }
    .tap-ad-toast svg { width: 15px; height: 15px; fill: #fff; }
    @keyframes tap-toast-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
  `;

  const PIP_ICON = 'M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z';

  const page = { styles: null, button: null, notice: null, adToast: null, observer: null };

  function ensurePageStyles() {
    if (page.styles && page.styles.isConnected) return;
    page.styles = document.createElement('style');
    page.styles.textContent = PAGE_CSS;
    (document.head || document.documentElement).appendChild(page.styles);
  }

  function isPipOpen() {
    return !!(state.pipWindow || document.pictureInPictureElement);
  }

  function togglePip() {
    if (isPipOpen()) {
      closePip();
      return;
    }
    const video = getVideo();
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    openPip(video);
  }

  function updatePlayerButton() {
    if (!page.button) return;
    const open = isPipOpen();
    page.button.setAttribute('aria-pressed', open ? 'true' : 'false');
    const label = open ? 'Cerrar ventana flotante (Alt+P)' : 'Abrir en ventana flotante (Alt+P)';
    page.button.setAttribute('aria-label', label);
    page.button.setAttribute('title', label);
  }

  function findControlGroup() {
    return (
      document.querySelector('.player-controls__right-control-group') ||
      document.querySelector('[data-a-target="player-controls"] [class*="right-control-group"]')
    );
  }

  function injectPlayerButton() {
    const group = findControlGroup();
    if (!group) return;
    if (page.button && page.button.isConnected && group.contains(page.button)) return;

    ensurePageStyles();

    const button = el(document, 'button', 'tap-pip-button', {
      type: 'button',
      'data-tap-button': '1',
      'aria-pressed': 'false',
    });
    button.appendChild(svgIcon(document, PIP_ICON));
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePip();
    });

    // Colocarlo junto al botón de pantalla completa (mismo nivel que sus hermanos)
    const fullscreen = group.querySelector('[data-a-target="player-fullscreen-button"]');
    let anchor = fullscreen;
    while (anchor && anchor.parentElement !== group) anchor = anchor.parentElement;

    if (page.button && page.button.parentNode) page.button.parentNode.removeChild(page.button);
    page.button = button;
    if (anchor) group.insertBefore(button, anchor);
    else group.appendChild(button);
    updatePlayerButton();
  }

  function showPageNotice() {
    hidePageNotice();
    const parent = state.originalParent;
    if (!parent || !parent.isConnected) return;
    ensurePageStyles();

    const notice = el(document, 'div', 'tap-pip-notice', { 'data-tap-notice': '1' });
    const card = el(document, 'div', 'tap-pip-notice__card', { role: 'button', tabindex: '0' });
    card.appendChild(svgIcon(document, PIP_ICON));
    const title = el(document, 'div', 'tap-pip-notice__title');
    title.textContent = 'Reproduciendo en ventana flotante';
    const hint = el(document, 'div', 'tap-pip-notice__hint');
    hint.textContent = 'Haz clic para volver aquí';
    card.appendChild(title);
    card.appendChild(hint);
    notice.appendChild(card);

    const back = (e) => { e.preventDefault(); e.stopPropagation(); closePip(); };
    card.addEventListener('click', back);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') back(e); });

    parent.appendChild(notice);
    page.notice = notice;
  }

  function hidePageNotice() {
    if (page.notice && page.notice.parentNode) page.notice.parentNode.removeChild(page.notice);
    page.notice = null;
  }

  function isTypingTarget(target) {
    if (!target || !(target instanceof Element)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable ||
      !!target.closest('[contenteditable="true"], [role="textbox"]');
  }

  function startPlayerIntegration() {
    injectPlayerButton();

    // Twitch es una SPA: re-inyectar cuando React vuelva a pintar los controles
    let scheduled = false;
    page.observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        injectPlayerButton();
      });
    });
    page.observer.observe(document.documentElement, { childList: true, subtree: true });

    // Atajo de teclado: Alt+P (gesto de usuario → ventana personalizada garantizada)
    document.addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.code !== 'KeyP' && e.key.toLowerCase() !== 'p') return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      togglePip();
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startPlayerIntegration, { once: true });
  } else {
    startPlayerIntegration();
  }

  // --------------------------------------------------------------------------
  // Apertura / cierre con fallback al PiP nativo
  // --------------------------------------------------------------------------
  async function openPip(video) {
    if (state.opening || state.pipWindow || document.pictureInPictureElement) return;
    state.opening = true;
    try {
      if ('documentPictureInPicture' in window) {
        try {
          await openDocumentPip(video);
          return;
        } catch (err) {
          console.info(LOG, 'Ventana personalizada no disponible, usando PiP nativo:', err.message);
          if (state.pipWindow) { try { state.pipWindow.close(); } catch (_) {} }
          restoreVideo();
        }
      }
      await video.requestPictureInPicture();
      updatePlayerButton();
      video.addEventListener('leavepictureinpicture', updatePlayerButton, { once: true });
    } catch (err) {
      console.error(LOG, 'Error al activar Picture-in-Picture:', err);
    } finally {
      state.opening = false;
    }
  }

  async function closePip() {
    if (state.pipWindow) {
      try { state.pipWindow.close(); } catch (_) { restoreVideo(); }
    }
    if (document.pictureInPictureElement) {
      try {
        await document.exitPictureInPicture();
      } catch (err) {
        console.error(LOG, 'Error al salir de Picture-in-Picture:', err);
      }
    }
  }

  // Auto-PiP de Chrome (134+): permite abrir la ventana sin gesto del usuario
  // cuando se cambia de pestaña, si el sitio tiene el permiso "Imagen en imagen automática".
  if (navigator.mediaSession && typeof navigator.mediaSession.setActionHandler === 'function') {
    try {
      navigator.mediaSession.setActionHandler('enterpictureinpicture', () => {
        const video = getVideo();
        if (video && !video.paused) openPip(video);
      });
    } catch (_) {
      // Acción no soportada en esta versión de Chrome
    }
  }

  // Manejador del cambio de visibilidad de la pestaña
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      const video = getVideo();
      if (video && !video.paused) openPip(video);
    } else {
      closePip();
    }
  });
})();
