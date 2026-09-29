// Bloqueo de anuncios cosidos (SSAI) de Twitch, inspirado en la técnica de VAFT.
//
// Se ejecuta en el "main world" de la página en document_start:
//  1. Envuelve el constructor Worker para inyectar código en el worker del reproductor.
//  2. Dentro del worker, envuelve fetch() para interceptar las playlists HLS.
//  3. Cuando una playlist de vídeo contiene marcadores de anuncio ("twitch-stitched-ad"),
//     se obtiene un token de reproducción con otro player_type (embed, popout, ...) y se
//     devuelve al reproductor la playlist de esa variante, que no lleva anuncios.
//  4. Si ningún respaldo está disponible, se eliminan los segmentos de anuncio de la playlist.
(function () {
  'use strict';

  if (window.__tapAdblockInstalled) return;
  window.__tapAdblockInstalled = true;

  const MESSAGE_SOURCE = 'twitch-auto-pip';

  // ==========================================================================
  // Código compartido con el worker (se serializa con Function.toString)
  // ==========================================================================
  function declareOptions(scope) {
    scope.TAP_LOG = '[Twitch Auto PiP · adblock]';
    scope.AdSignifier = 'stitched';
    scope.LiveSegmentSignifier = ',live';
    scope.ClientID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
    scope.ClientVersion = null;
    scope.ClientSession = null;
    scope.ClientIntegrityHeader = null;
    scope.AuthorizationHeader = null;
    scope.GQLDeviceID = null;
    // Orden de preferencia: primero los que conservan la calidad completa.
    scope.BackupPlayerTypes = ['embed', 'popout', 'picture-by-picture', 'autoplay'];
    scope.StreamInfos = {};       // canal -> info
    scope.StreamInfosByUrl = {};  // url de playlist de vídeo -> info
    scope.CurrentChannelName = null;
  }

  function tapParseMasterPlaylist(text) {
    const lines = text.split('\n');
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
      let url = null;
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j].trim();
        if (candidate && !candidate.startsWith('#')) { url = candidate; break; }
      }
      if (!url) continue;
      const res = /RESOLUTION=(\d+)x(\d+)/.exec(line);
      const fps = /FRAME-RATE=([\d.]+)/.exec(line);
      const bw = /BANDWIDTH=(\d+)/.exec(line);
      variants.push({
        url,
        width: res ? Number(res[1]) : 0,
        height: res ? Number(res[2]) : 0,
        frameRate: fps ? Number(fps[1]) : 0,
        bandwidth: bw ? Number(bw[1]) : 0,
      });
    }
    return variants;
  }

  function tapPickVariant(variants, current) {
    if (!variants.length) return null;
    const sorted = variants.slice().sort((a, b) => (b.height - a.height) || (b.frameRate - a.frameRate) || (b.bandwidth - a.bandwidth));
    if (!current || !current.height) return sorted[0];
    // Misma resolución (y a ser posible mismos fps)
    const same = sorted.filter((v) => v.height === current.height);
    if (same.length) {
      const sameFps = same.find((v) => Math.round(v.frameRate) === Math.round(current.frameRate));
      return sameFps || same[0];
    }
    // La mayor que no supere la actual; si no hay, la más baja disponible
    const lower = sorted.find((v) => v.height < current.height);
    return lower || sorted[sorted.length - 1];
  }

  function tapStripAdSegments(text) {
    const lines = text.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-DATERANGE') && line.includes(AdSignifier)) continue;
      if (line.startsWith('#EXT-X-DATERANGE') && /CLASS="twitch-(ad-quartile|stream-source|trigger)"/.test(line)) continue;
      if (line.startsWith('#EXT-X-TWITCH-PREFETCH')) continue;
      if (line.startsWith('#EXTINF') && !line.includes(LiveSegmentSignifier)) {
        // Segmento de anuncio: saltar EXTINF + URL (y la discontinuidad previa)
        while (i + 1 < lines.length && lines[i + 1].startsWith('#')) i++;
        i++;
        if (out.length && out[out.length - 1].startsWith('#EXT-X-DISCONTINUITY')) out.pop();
        continue;
      }
      out.push(line);
    }
    return out.join('\n');
  }

  function tapRandomId(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  function tapGqlRequest(body, realFetch) {
    if (!GQLDeviceID) GQLDeviceID = tapRandomId(32);
    const headers = {
      'Client-ID': ClientID,
      'Content-Type': 'text/plain;charset=UTF-8',
      'Device-ID': GQLDeviceID,
      'X-Device-Id': GQLDeviceID,
    };
    if (ClientIntegrityHeader) headers['Client-Integrity'] = ClientIntegrityHeader;
    if (ClientVersion) headers['Client-Version'] = ClientVersion;
    if (ClientSession) headers['Client-Session-Id'] = ClientSession;
    if (AuthorizationHeader) headers['Authorization'] = AuthorizationHeader;
    return realFetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      body: JSON.stringify(body),
      headers,
    });
  }

  function tapGetAccessToken(channelName, playerType, realFetch) {
    const query = 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {' +
      '  streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {    value    signature    __typename  }' +
      '  videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {    value    signature    __typename  }}';
    return tapGqlRequest({
      operationName: 'PlaybackAccessToken_Template',
      query,
      variables: { isLive: true, login: channelName, isVod: false, vodID: '', playerType },
    }, realFetch);
  }

  function tapHandleMasterPlaylist(url, text) {
    const match = /\/hls\/([^./?]+)\.m3u8/.exec(url);
    if (!match) return;
    const channelName = match[1].toLowerCase();
    let usherParams = '';
    try { usherParams = new URL(url).search; } catch (_) { /* ignorar */ }

    const info = {
      ChannelName: channelName,
      UsherParams: usherParams,
      Urls: {},
      IsShowingAd: false,
      Backups: {},
    };
    for (const variant of tapParseMasterPlaylist(text)) {
      info.Urls[variant.url] = variant;
      StreamInfosByUrl[variant.url] = info;
    }
    StreamInfos[channelName] = info;
    CurrentChannelName = channelName;
  }

  async function tapGetBackupPlaylist(streamInfo, playerType, current, realFetch) {
    let cache = streamInfo.Backups[playerType];
    if (cache && cache.disabledUntil && cache.disabledUntil > Date.now()) return null;

    if (!cache || !cache.variants) {
      const tokenResponse = await tapGetAccessToken(streamInfo.ChannelName, playerType, realFetch);
      if (!tokenResponse.ok) throw new Error('token HTTP ' + tokenResponse.status);
      const json = await tokenResponse.json();
      const token = json && json.data && json.data.streamPlaybackAccessToken;
      if (!token || !token.value || !token.signature) throw new Error('sin token para ' + playerType);

      const usherUrl = new URL('https://usher.ttvnw.net/api/channel/hls/' + streamInfo.ChannelName + '.m3u8' + streamInfo.UsherParams);
      usherUrl.searchParams.set('sig', token.signature);
      usherUrl.searchParams.set('token', token.value);
      usherUrl.searchParams.set('play_session_id', tapRandomId(32));
      // Sesión independiente de la del reproductor principal (que ya tiene el anuncio asignado)
      usherUrl.searchParams.set('p', String(Math.floor(Math.random() * 1e7)));

      const encodingsResponse = await realFetch(usherUrl.href);
      if (!encodingsResponse.ok) throw new Error('usher HTTP ' + encodingsResponse.status);
      const variants = tapParseMasterPlaylist(await encodingsResponse.text());
      if (!variants.length) throw new Error('master sin variantes');
      cache = streamInfo.Backups[playerType] = { variants, fetchedAt: Date.now() };
    }

    const variant = tapPickVariant(cache.variants, current);
    if (!variant) return null;
    const response = await realFetch(variant.url);
    if (!response.ok) {
      // Token caducado o variante muerta: rehacer en el siguiente intento
      delete streamInfo.Backups[playerType];
      return null;
    }
    const text = await response.text();
    if (!text || text.includes(AdSignifier)) {
      // Este player_type también recibe anuncios: no insistir durante un rato
      cache.disabledUntil = Date.now() + 60 * 1000;
      return null;
    }
    return { text, variant, playerType };
  }

  async function tapProcessM3U8(url, text, realFetch) {
    if (!text) return text;
    const streamInfo = StreamInfosByUrl[url] || (CurrentChannelName && StreamInfos[CurrentChannelName]);
    if (!streamInfo) return text;

    const hasAds = text.includes(AdSignifier);
    if (!hasAds) {
      if (streamInfo.IsShowingAd) {
        streamInfo.IsShowingAd = false;
        streamInfo.Backups = {};
        self.postMessage({ key: 'TapAdEnded', channel: streamInfo.ChannelName });
      }
      return text;
    }

    const isMidroll = /X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL"/i.test(text);
    if (!streamInfo.IsShowingAd) {
      streamInfo.IsShowingAd = true;
      self.postMessage({ key: 'TapAdStarted', channel: streamInfo.ChannelName, isMidroll });
    }

    const current = streamInfo.Urls[url] || null;
    for (const playerType of BackupPlayerTypes) {
      try {
        const backup = await tapGetBackupPlaylist(streamInfo, playerType, current, realFetch);
        if (backup) {
          if (streamInfo.LastBackupType !== playerType) {
            streamInfo.LastBackupType = playerType;
            self.postMessage({
              key: 'TapAdBackup',
              channel: streamInfo.ChannelName,
              playerType,
              height: backup.variant.height,
              originalHeight: current ? current.height : 0,
            });
          }
          return backup.text;
        }
      } catch (err) {
        console.warn(TAP_LOG, 'respaldo', playerType, 'falló:', err && err.message);
        const cache = streamInfo.Backups[playerType] || (streamInfo.Backups[playerType] = {});
        cache.disabledUntil = Date.now() + 30 * 1000;
      }
    }

    // Sin respaldo: al menos quitar los segmentos de anuncio
    return tapStripAdSegments(text);
  }

  function tapHookWorkerFetch() {
    const realFetch = self.fetch.bind(self);
    self.fetch = async function (input, init) {
      let url = '';
      if (typeof input === 'string') url = input;
      else if (input && typeof input.url === 'string') url = input.url;

      if (url.includes('usher.ttvnw.net/api/channel/hls/') && url.includes('.m3u8')) {
        const response = await realFetch(input, init);
        if (response.status === 200) {
          const text = await response.text();
          try { tapHandleMasterPlaylist(url, text); } catch (err) { console.warn(TAP_LOG, err); }
          return new Response(text, { status: 200, statusText: response.statusText, headers: response.headers });
        }
        return response;
      }

      if (url.includes('.m3u8') && (StreamInfosByUrl[url] || url.includes('.hls.ttvnw.net/') || url.includes('.playlist.ttvnw.net/'))) {
        const response = await realFetch(input, init);
        if (response.status === 200) {
          const text = await response.text();
          let processed = text;
          try { processed = await tapProcessM3U8(url, text, realFetch); } catch (err) { console.warn(TAP_LOG, err); }
          return new Response(processed, { status: 200, statusText: response.statusText, headers: response.headers });
        }
        return response;
      }

      return realFetch(input, init);
    };
  }

  function tapWorkerMessageHandler(scope) {
    scope.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || typeof data !== 'object' || data.tapKey === undefined) return;
      switch (data.tapKey) {
        case 'UpdateClientIntegrityHeader': scope.ClientIntegrityHeader = data.value; break;
        case 'UpdateAuthorizationHeader': scope.AuthorizationHeader = data.value; break;
        case 'UpdateClientVersion': scope.ClientVersion = data.value; break;
        case 'UpdateClientSession': scope.ClientSession = data.value; break;
        case 'UpdateDeviceId': scope.GQLDeviceID = data.value; break;
      }
    });
  }

  // ==========================================================================
  // Hilo principal
  // ==========================================================================
  const workers = [];
  let adsBlocked = 0;
  const gqlHeaders = {
    ClientIntegrityHeader: null,
    AuthorizationHeader: null,
    ClientVersion: null,
    ClientSession: null,
    GQLDeviceID: null,
  };

  function buildWorkerPrelude() {
    return [
      declareOptions.toString(),
      tapParseMasterPlaylist.toString(),
      tapPickVariant.toString(),
      tapStripAdSegments.toString(),
      tapRandomId.toString(),
      tapGqlRequest.toString(),
      tapGetAccessToken.toString(),
      tapHandleMasterPlaylist.toString(),
      tapGetBackupPlaylist.toString(),
      tapProcessM3U8.toString(),
      tapHookWorkerFetch.toString(),
      tapWorkerMessageHandler.toString(),
      'declareOptions(self);',
      'self.ClientIntegrityHeader = ' + JSON.stringify(gqlHeaders.ClientIntegrityHeader) + ';',
      'self.AuthorizationHeader = ' + JSON.stringify(gqlHeaders.AuthorizationHeader) + ';',
      'self.ClientVersion = ' + JSON.stringify(gqlHeaders.ClientVersion) + ';',
      'self.ClientSession = ' + JSON.stringify(gqlHeaders.ClientSession) + ';',
      'self.GQLDeviceID = ' + JSON.stringify(gqlHeaders.GQLDeviceID) + ';',
      'tapWorkerMessageHandler(self);',
      'tapHookWorkerFetch();',
    ].join('\n');
  }

  function fetchScriptSync(url) {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.overrideMimeType('text/javascript');
      xhr.send();
      if (xhr.status === 200 || (xhr.status === 0 && xhr.responseText)) return xhr.responseText;
    } catch (_) { /* cross-origin u otro fallo */ }
    return null;
  }

  function isTwitchWorkerUrl(url) {
    try {
      const origin = new URL(url, location.href).origin;
      return origin.endsWith('twitch.tv') || origin.endsWith('twitchcdn.net') || origin.endsWith('jtvnw.net');
    } catch (_) {
      return false;
    }
  }

  function broadcastToWorkers(tapKey, value) {
    for (const worker of workers) {
      try { worker.postMessage({ tapKey, value }); } catch (_) { /* worker terminado */ }
    }
  }

  function notifyPage(payload) {
    try {
      window.postMessage(Object.assign({ source: MESSAGE_SOURCE }, payload), location.origin);
    } catch (_) { /* ignorar */ }
  }

  function hookWorker() {
    const RealWorker = window.Worker;
    if (!RealWorker) return;

    class TapWorker extends RealWorker {
      constructor(scriptUrl, options) {
        const urlString = String(scriptUrl);
        const isModule = options && options.type === 'module';
        if (!isTwitchWorkerUrl(urlString) || isModule) {
          super(scriptUrl, options);
          return;
        }

        const workerSource = fetchScriptSync(urlString);
        const body = workerSource !== null
          ? workerSource
          : 'importScripts(' + JSON.stringify(urlString) + ');';
        const blob = new Blob([buildWorkerPrelude() + '\n' + body], { type: 'text/javascript' });
        super(URL.createObjectURL(blob), options);

        workers.push(this);
        notifyPage({ type: 'worker-hooked' });
        this.addEventListener('message', (event) => {
          const data = event.data;
          if (!data || typeof data !== 'object' || typeof data.key !== 'string' || !data.key.startsWith('Tap')) return;
          switch (data.key) {
            case 'TapAdStarted':
              adsBlocked++;
              notifyPage({ type: 'ad-started', channel: data.channel, isMidroll: !!data.isMidroll, count: adsBlocked });
              break;
            case 'TapAdBackup':
              notifyPage({ type: 'ad-backup', channel: data.channel, playerType: data.playerType, height: data.height, originalHeight: data.originalHeight });
              break;
            case 'TapAdEnded':
              notifyPage({ type: 'ad-ended', channel: data.channel });
              break;
          }
        });
      }
    }

    window.Worker = TapWorker;
  }

  function headerValue(headers, name) {
    if (!headers) return null;
    if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(name);
    if (Array.isArray(headers)) {
      const entry = headers.find(([k]) => String(k).toLowerCase() === name.toLowerCase());
      return entry ? entry[1] : null;
    }
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : null;
  }

  function captureGqlHeaders(init) {
    const headers = init && init.headers;
    if (!headers) return;
    const pairs = [
      ['ClientIntegrityHeader', 'Client-Integrity', 'UpdateClientIntegrityHeader'],
      ['AuthorizationHeader', 'Authorization', 'UpdateAuthorizationHeader'],
      ['ClientVersion', 'Client-Version', 'UpdateClientVersion'],
      ['ClientSession', 'Client-Session-Id', 'UpdateClientSession'],
      ['GQLDeviceID', 'X-Device-Id', 'UpdateDeviceId'],
    ];
    for (const [field, header, tapKey] of pairs) {
      const value = headerValue(headers, header) || (header === 'X-Device-Id' ? headerValue(headers, 'Device-ID') : null);
      if (value && gqlHeaders[field] !== value) {
        gqlHeaders[field] = value;
        broadcastToWorkers(tapKey, value);
      }
    }
  }

  function hookFetch() {
    const realFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (typeof url === 'string' && url.includes('gql.twitch.tv')) captureGqlHeaders(init);
      } catch (_) { /* nunca romper la petición original */ }
      return realFetch.apply(this, arguments);
    };
  }

  // content.js puede cargar después que nosotros; si pregunta, le devolvemos el estado
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== MESSAGE_SOURCE || data.type !== 'query-state') return;
    notifyPage({ type: 'adblock-armed', hooked: workers.length > 0, count: adsBlocked });
  });

  hookWorker();
  hookFetch();
  notifyPage({ type: 'adblock-armed', hooked: false, count: 0 });
})();
