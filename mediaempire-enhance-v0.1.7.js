/**
 * mediaempire-enhance v0.1.7
 * Clean CyTube chat enhancement for https://cytu.be/r/mediaempire
 *
 * Scope (selected):
 *  - Emote Tools 1.4 functionality (autocomplete, multi-word, @mentions, Tab cycling,
 *    docked panel, optional cache) — ported, not loaded remotely
 *  - Click posted channel-emote → insert code into #chatline (no send)
 *  - Preview button (left of chat controls) + region above chat box
 *  - Shared EffectEngine for documented Render syntax (Preview path first)
 *  - Safe, idempotent init
 *
 * Deferred: saved presets, one-click generators, full lightbox, auto video thumbs/PiP
 *
 * Design: improve the existing syntax culture; Preview is an inspector, not a toy.
 */
(function () {
  'use strict';
  if (window.__mediaempireEnhanceLoaded) return;
  window.__mediaempireEnhanceLoaded = true;

  var VERSION = '0.1.7';
  var NS = 'mee'; // mediaempire-enhance

  /* --------------------------------------------------------------------------
   * Config
   * -------------------------------------------------------------------------- */
  var CFG = {
    // Emote Tools defaults (verified useful in 1.4)
    preloadAll: true,
    startDelayMs: 3000,
    concurrency: 4,
    maxBytes: 120 * 1024 * 1024,
    persist: true,
    maxAgeDays: 14,
    maxDiskBytes: 400 * 1024 * 1024,
    primaryCount: 3,
    secondaryCount: 3,
    thumbMax: 56,
    maxQueryLen: 40,
    clickToInsert: true,
    dockMode: 'inline', // 'inline' | 'fixed' | 'float'
    mentions: true,
    mentionCount: 8,
    includeSelf: false,
    debug: false,

    // Preview
    previewEnabled: true
  };

  function log() {
    if (CFG.debug && window.console) {
      console.log.apply(console, ['[' + NS + ']'].concat([].slice.call(arguments)));
    }
  }

  /* --------------------------------------------------------------------------
   * Effect inventory (from Render notes + observed CSS classes)
   * Used by EffectEngine for Preview. Live chat still uses channel filters/CSS.
   * -------------------------------------------------------------------------- */
  var SLASH_TEXT = {
    sr:  { kind: 'scroll', dir: 'right', speed: 'normal' },
    srf: { kind: 'scroll', dir: 'right', speed: 'fast' },
    srh: { kind: 'scroll', dir: 'right', speed: 'hyper' },
    sl:  { kind: 'scroll', dir: 'left',  speed: 'normal' },
    slf: { kind: 'scroll', dir: 'left',  speed: 'fast' },
    slh: { kind: 'scroll', dir: 'left',  speed: 'hyper' },
    rb:  { kind: 'rainbow' },
    fl:  { kind: 'flashy' },
    lg:  { kind: 'size', size: 'lg' },
    smol:{ kind: 'size', size: 'smol' },
    b:   { kind: 'bold' },
    sp:  { kind: 'spoiler' },
    say: { kind: 'say', admin: true },
    me:  { kind: 'me' },
    hig: { kind: 'hig' },
    blr: { kind: 'blur' },
    g:   { kind: 'glow' },
    glow:{ kind: 'glow' },
    code:{ kind: 'code' },
    hooves: { kind: 'keyword', word: 'HOOVES' },
    plot:   { kind: 'keyword', word: 'PLOT SPOTTED' }
  };

  var SLASH_COLOR = {
    bl: 'blue', blue: 'blue',
    or: 'orange', orange: 'orange',
    rd: 'red', red: 'red',
    yl: 'yellow', yellow: 'yellow',
    pr: 'purple', purple: 'purple',
    gn: 'green', green: 'green',
    pk: 'pink', pink: 'pink',
    wh: 'white', white: 'white'
  };

  // Image URL suffixes → CSS class / behaviour (best-effort from notes + CSS)
  var IMG_SUFFIX = {
    pic:  { size: 'small' },
    mid:  { size: 'mid' },
    big:  { size: 'big' },
    ant:  { size: 'ant' },
    sh:   { size: 'small', className: 'image-shake' },
    sp:   { spoiler: true },
    blr:  { className: 'image-blur' },
    sr:   { slide: 'right' },
    sl:   { slide: 'left' },
    up:   { slide: 'up' },
    dw:   { slide: 'down' },
    rb:   { className: 'hued' },
    wew:  { className: 'new_wew' },
    uma:  { className: 'u_mad' },
    cop:  { className: 'cop' },
    owl:  { className: 'rotate_owl' },
    hap:  { className: 'happening' },
    ree:  { className: 'ree' },
    peek: { className: 'peek_up' },
    bw:   { className: 'noir' },
    jail: { className: 'jail' },
    blkd: { className: 'blkd' },
    invt: { className: 'invt' },
    braz: { className: 'brazr' },
    lk:   { className: 'look' },
    fine: { className: 'fine' },
    gay:  { spoiler: true, label: 'gay' },
    no:   { overlay: 'no' },
    ok:   { overlay: 'ok' },
    sad:  { className: 'sad' },
    cum:  { className: 'cum' },
    owo:  { className: 'owo' },
    v:    { className: 'v' },
    gun:  { className: 'gun' },
    msk:  { className: 'msk' },
    yuge: { size: 'yuge' },
    nu:   { size: 'small', nien: true }
  };

  var WRAPPERS = {
    shake:        { className: 'image-shake' },
    flip:         { className: 'mirror-x' },
    mirror:       { className: 'mirror-y' },
    flop:         { className: 'mirror-y' },
    'tilt-forward': { className: 'tilt-f' },
    'tilt-reverse': { className: 'tilt-r' },
    blur:         { className: 'image-blur' },
    brodyquest:   { className: 'brody' },
    bw:           { className: 'noir' }
  };

  /* --------------------------------------------------------------------------
   * EffectEngine — parse → structured nodes → safe DOM for Preview
   * Does not mutate live chat. Live chat continues to use channel filters/CSS.
   * -------------------------------------------------------------------------- */
  var EffectEngine = (function () {
    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function isSafeUrl(u) {
      try {
        var x = new URL(u, location.href);
        return x.protocol === 'http:' || x.protocol === 'https:';
      } catch (e) {
        return false;
      }
    }

    /**
     * Parse a chat message string into a simple node list.
     * Nodes: {type:'text', value}, {type:'slash', cmd, body, meta},
     *        {type:'img', url, suffix, meta}, {type:'wrap', name, body}
     */
    function parse(raw) {
      var text = String(raw || '');
      var nodes = [];
      // Very lightweight sequential parse. Not a full recursive grammar.
      // Priority: wrappers first (pair), then leading slash commands, then image URLs + suffix.

      // 1) Extract wrappers [name]...[/name]
      var wrapRe = /\[(shake|flip|mirror|flop|tilt-forward|tilt-reverse|blur|brodyquest|bw)\]([\s\S]*?)\[\/\1\]/gi;
      var last = 0;
      var m;
      var parts = [];
      while ((m = wrapRe.exec(text)) !== null) {
        if (m.index > last) parts.push({ type: 'raw', value: text.slice(last, m.index) });
        parts.push({ type: 'wrap', name: m[1].toLowerCase(), body: m[2] });
        last = m.index + m[0].length;
      }
      if (last < text.length) parts.push({ type: 'raw', value: text.slice(last) });
      if (!parts.length) parts = [{ type: 'raw', value: text }];

      parts.forEach(function (p) {
        if (p.type === 'wrap') {
          nodes.push(p);
          return;
        }
        // 2) Slash commands at start of a segment (can stack: /sr /rb text)
        var seg = p.value;
        var slashCmds = [];
        var rest = seg;
        var slashRe = /^\/([a-zA-Z]+)(?:\s+|$)/;
        while (true) {
          var sm = rest.match(slashRe);
          if (!sm) break;
          var cmd = sm[1].toLowerCase();
          if (SLASH_TEXT[cmd] || SLASH_COLOR[cmd]) {
            slashCmds.push(cmd);
            rest = rest.slice(sm[0].length);
          } else break;
        }
        // 3) Image URL + optional suffix
        var urlRe = /(https?:\/\/[^\s<>"']+?)(\.(pic|mid|big|ant|sh|sp|blr|sr|sl|up|dw|rb|wew|uma|cop|owl|hap|ree|peek|bw|jail|blkd|invt|braz|lk|fine|gay|no|ok|sad|cum|owo|v|gun|msk|yuge|nu))?(?=[\s<>"']|$)/gi;
        var uLast = 0;
        var um;
        var sub = [];
        while ((um = urlRe.exec(rest)) !== null) {
          if (um.index > uLast) sub.push({ type: 'text', value: rest.slice(uLast, um.index) });
          var suffix = um[3] ? um[3].toLowerCase() : null;
          sub.push({
            type: 'img',
            url: um[1],
            suffix: suffix,
            meta: suffix ? (IMG_SUFFIX[suffix] || {}) : {}
          });
          uLast = um.index + um[0].length;
        }
        if (uLast < rest.length) sub.push({ type: 'text', value: rest.slice(uLast) });
        if (!sub.length) sub = [{ type: 'text', value: rest }];

        if (slashCmds.length) {
          nodes.push({ type: 'slash', cmds: slashCmds, children: sub });
        } else {
          sub.forEach(function (n) { nodes.push(n); });
        }
      });
      return nodes;
    }

    function sizeStyle(size) {
      if (size === 'small' || size === 'pic') return 'max-height:80px;max-width:120px;';
      if (size === 'mid') return 'max-height:160px;max-width:240px;';
      if (size === 'big') return 'max-height:280px;max-width:400px;';
      if (size === 'ant') return 'max-height:24px;max-width:40px;';
      if (size === 'yuge') return 'max-height:480px;max-width:100%;';
      return 'max-height:120px;max-width:200px;';
    }

    function renderNodes(nodes) {
      var frag = document.createDocumentFragment();
      nodes.forEach(function (n) {
        if (n.type === 'text') {
          frag.appendChild(document.createTextNode(n.value));
          return;
        }
        if (n.type === 'wrap') {
          var wMeta = WRAPPERS[n.name] || {};
          var span = document.createElement('span');
          if (wMeta.className) span.className = wMeta.className;
          span.appendChild(renderNodes(parse(n.body))); // re-parse body lightly
          frag.appendChild(span);
          return;
        }
        if (n.type === 'slash') {
          var wrap = document.createElement('span');
          var classes = [];
          var color = null;
          var styleBits = [];
          n.cmds.forEach(function (c) {
            if (SLASH_COLOR[c]) {
              color = SLASH_COLOR[c];
              return;
            }
            var t = SLASH_TEXT[c];
            if (!t) return;
            if (t.kind === 'bold') styleBits.push('font-weight:700');
            if (t.kind === 'size' && t.size === 'lg') styleBits.push('font-size:1.4em;font-weight:300');
            if (t.kind === 'size' && t.size === 'smol') styleBits.push('font-size:0.7em');
            if (t.kind === 'rainbow') classes.push('dankestMeme');
            if (t.kind === 'flashy') classes.push('flashy');
            if (t.kind === 'glow') styleBits.push('color:#0f0;text-shadow:0 0 6px #0f0');
            if (t.kind === 'blur') classes.push('image-blur');
            if (t.kind === 'spoiler') classes.push('spoiler');
            if (t.kind === 'scroll') {
              classes.push('mee-scroll-' + t.dir + (t.speed !== 'normal' ? '-' + t.speed : ''));
            }
          });
          if (color) styleBits.push('color:' + color);
          if (classes.length) wrap.className = classes.join(' ');
          if (styleBits.length) wrap.setAttribute('style', styleBits.join(';'));
          wrap.appendChild(renderNodes(n.children || []));
          frag.appendChild(wrap);
          return;
        }
        if (n.type === 'img') {
          if (!isSafeUrl(n.url)) {
            frag.appendChild(document.createTextNode(n.url + (n.suffix ? '.' + n.suffix : '')));
            return;
          }
          var meta = n.meta || {};
          var holder = document.createElement('span');
          holder.className = 'mee-img-preview';
          if (meta.className) holder.classList.add(meta.className);
          if (meta.spoiler) holder.classList.add('mee-spoiler');

          var img = document.createElement('img');
          img.src = n.url;
          img.alt = '';
          img.loading = 'lazy';
          img.setAttribute('style', sizeStyle(meta.size) + 'vertical-align:middle;');
          if (meta.spoiler) {
            img.style.filter = 'blur(12px)';
            img.title = 'Click to reveal';
            img.addEventListener('click', function () {
              img.style.filter = '';
            });
          }
          holder.appendChild(img);

          var link = document.createElement('a');
          link.href = n.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = ' ↗';
          link.style.fontSize = '0.75em';
          link.style.marginLeft = '2px';
          holder.appendChild(link);

          frag.appendChild(holder);
          return;
        }
      });
      return frag;
    }

    function renderToElement(raw, targetEl) {
      targetEl.innerHTML = '';
      var nodes = parse(raw);
      targetEl.appendChild(renderNodes(nodes));
    }

    return {
      parse: parse,
      renderToElement: renderToElement,
      escapeHtml: escapeHtml
    };
  })();

  /* --------------------------------------------------------------------------
   * ChatPreview — button left of chat area, preview region above chat box
   * -------------------------------------------------------------------------- */
  var ChatPreview = (function () {
    var btn = null;
    var region = null;
    var chatline = null;

    function ensureUI() {
      chatline = document.getElementById('chatline');
      if (!chatline) return false;
      if (document.getElementById(NS + '-preview-btn')) return true;

      // Preview region directly above the chat input area
      region = document.createElement('div');
      region.id = NS + '-preview-region';
      region.setAttribute('style',
        'display:none;padding:6px 8px;margin:0 0 4px 0;border:1px solid rgba(255,255,255,0.15);' +
        'border-radius:3px;background:rgba(0,0,0,0.35);max-height:180px;overflow:auto;' +
        'font-size:inherit;line-height:1.35;word-break:break-word;');
      region.setAttribute('aria-live', 'polite');

      // Button — left side of chat controls. Place before #chatline if possible.
      btn = document.createElement('button');
      btn.id = NS + '-preview-btn';
      btn.type = 'button';
      btn.textContent = 'Preview';
      btn.title = 'Render current message with effects (does not send)';
      btn.className = 'btn btn-xs btn-default';
      btn.setAttribute('style', 'margin:0 4px 0 0;vertical-align:middle;');

      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var val = chatline.value || '';
        if (!val.trim()) {
          region.style.display = 'none';
          region.innerHTML = '';
          return;
        }
        EffectEngine.renderToElement(val, region);
        region.style.display = 'block';
      });

      // Insert region above chatline's parent row if possible
      var wrap = document.getElementById('chatwrap') || chatline.parentElement;
      if (wrap && chatline.parentElement) {
        chatline.parentElement.insertBefore(region, chatline);
      } else if (wrap) {
        wrap.insertBefore(region, wrap.firstChild);
      }

      // Put button to the left of the chatline
      if (chatline.parentElement) {
        chatline.parentElement.insertBefore(btn, chatline);
      }

      // Dismiss on Escape when focused in chat
      chatline.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && region.style.display !== 'none') {
          region.style.display = 'none';
        }
      });

      return true;
    }

    return { ensureUI: ensureUI };
  })();

  /* --------------------------------------------------------------------------
   * Click posted emote → insert (distinct from autocomplete)
   * -------------------------------------------------------------------------- */
  function bindPostedEmoteClick() {
    var buf = document.getElementById('messagebuffer');
    if (!buf || buf.__meeEmoteClick) return;
    buf.__meeEmoteClick = true;
    buf.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || t.tagName !== 'IMG') return;
      if (!t.classList.contains('channel-emote')) return;
      var code = t.title || t.getAttribute('title') || '';
      if (!code) return;
      e.preventDefault();
      e.stopPropagation();
      var input = document.getElementById('chatline');
      if (!input) return;
      input.focus();
      var v = input.value || '';
      var needsSpace = v.length && !/\s$/.test(v);
      input.value = v + (needsSpace ? ' ' : '') + code;
      // Move caret to end
      try {
        input.selectionStart = input.selectionEnd = input.value.length;
      } catch (err) {}
    }, true);
  }

  /* --------------------------------------------------------------------------
   * Emote Tools 1.4 — ported core (cache + discovery + mentions)
   * Adapted to share the same IIFE and avoid double-load.
   * -------------------------------------------------------------------------- */
  var EmoteIntegration = (function () {
    var DISK_NAME = 'cytube-emote-tools-v1';
    var DAY = 86400000;

    var byName = new Map();
    var sorted = [];
    var urlSet = new Set();
    var triggerChars = new Set();
    var lastArr = null, lastLen = -1;
    var coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

    function abs(u) {
      try { return new URL(u, location.href).href; } catch (e) { return ''; }
    }

    function syncEmotes() {
      var arr = window.CHANNEL && window.CHANNEL.emotes;
      if (!arr || (arr === lastArr && arr.length === lastLen)) return;
      lastArr = arr; lastLen = arr.length;
      byName.clear(); urlSet.clear(); triggerChars.clear();
      sorted = [];
      arr.forEach(function (e) {
        if (!e || !e.name || !e.image) return;
        var u = abs(e.image);
        if (!u) return;
        e._abs = u;
        e._lc = String(e.name).toLowerCase();
        e._words = e._lc.split(/[^a-z0-9]+/).filter(Boolean);
        byName.set(e._lc, e);
        urlSet.add(u);
        sorted.push(e);
        var c = e._lc.charAt(0);
        if (!/[a-z0-9]/.test(c)) triggerChars.add(c);
      });
      sorted.sort(function (a, b) { return coll.compare(a._lc, b._lc); });
      log('emotes synced:', byName.size);
    }

    /* Cache layer (same behaviour as 1.4) */
    var diskP = null, diskUsed = 0;
    function diskOK() { return CFG.persist && typeof window.caches !== 'undefined'; }
    function disk() {
      if (!diskOK()) return Promise.resolve(null);
      if (!diskP) {
        diskP = window.caches.open(DISK_NAME).catch(function () { return null; });
        try {
          if (navigator.storage && navigator.storage.estimate) {
            navigator.storage.estimate().then(function (e) { diskUsed = (e && e.usage) || 0; });
          }
        } catch (e) {}
      }
      return diskP;
    }
    function diskGet(url) {
      return disk().then(function (c) {
        if (!c) return null;
        return c.match(url).then(function (r) {
          if (!r) return null;
          var t = +r.headers.get('x-et-time') || 0;
          if (!t || Date.now() - t > CFG.maxAgeDays * DAY) return null;
          return r.blob();
        });
      }).catch(function () { return null; });
    }
    function diskPut(url, blob) {
      return disk().then(function (c) {
        if (!c || diskUsed + blob.size > CFG.maxDiskBytes) return;
        diskUsed += blob.size;
        var h = new Headers({
          'x-et-time': String(Date.now()),
          'content-type': blob.type || 'application/octet-stream'
        });
        return c.put(url, new Response(blob, { headers: h }));
      }).catch(function () {});
    }

    var cache = new Map();
    var queue = [], active = 0, totalBytes = 0;
    var stat = { fromDisk: 0, fromNet: 0, fallback: 0 };

    function finish(rec, blob, source) {
      if (source === 'disk') stat.fromDisk++;
      else if (source === 'net') stat.fromNet++;
      try {
        rec.objUrl = URL.createObjectURL(blob);
        rec.state = 'blob';
        rec.bytes = blob.size || 0;
        totalBytes += rec.bytes;
      } catch (e) {
        rec.state = 'fail';
      }
    }

    function enqueue(url, priority) {
      if (cache.has(url)) return;
      var rec = { state: 'queued' };
      cache.set(url, rec);
      if (priority) queue.unshift(url); else queue.push(url);
      pump();
    }

    function pump() {
      while (active < CFG.concurrency && queue.length) {
        if (totalBytes >= CFG.maxBytes) { queue.length = 0; break; }
        var url = queue.shift();
        load(url);
      }
    }

    function load(url) {
      var rec = cache.get(url);
      if (!rec || rec.state === 'blob') return;
      active++;
      rec.state = 'loading';
      diskGet(url)
        .then(function (b) {
          if (b) return { b: b, src: 'disk' };
          return fetch(url, { mode: 'cors', credentials: 'omit' })
            .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.blob(); })
            .then(function (b2) { diskPut(url, b2); return { b: b2, src: 'net' }; });
        })
        .then(function (x) { finish(rec, x.b, x.src); })
        .catch(function () {
          stat.fallback++;
          rec.state = 'fail';
        })
        .then(function () { active--; pump(); });
    }

    function srcFor(emote) {
      var rec = cache.get(emote._abs);
      if (rec && rec.state === 'blob') return rec.objUrl;
      enqueue(emote._abs, true);
      return emote._abs;
    }

    function handleImg(img) {
      var src = img.src;
      if (!src || src.indexOf('blob:') === 0 || !urlSet.has(src)) return;
      var rec = cache.get(src);
      if (rec && rec.state === 'blob') img.src = rec.objUrl;
      else if (!rec) enqueue(src, true);
    }

    function startObserver() {
      new MutationObserver(function (muts) {
        syncEmotes();
        muts.forEach(function (m) {
          if (m.type === 'attributes') {
            if (m.target.tagName === 'IMG') handleImg(m.target);
            return;
          }
          m.addedNodes.forEach(function (n) {
            if (n.nodeType !== 1) return;
            if (n.tagName === 'IMG') handleImg(n);
            else if (n.querySelectorAll) n.querySelectorAll('img').forEach(handleImg);
          });
        });
      }).observe(document.body, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['src']
      });
    }

    function startPreload() {
      setTimeout(function () {
        syncEmotes();
        if (CFG.preloadAll) {
          sorted.forEach(function (e) { enqueue(e._abs, false); });
        }
      }, CFG.startDelayMs);
    }

    /* Search (exact / starts-with / related) */
    function search(q) {
      var exact = byName.get(q) || null;
      var t1 = exact ? [exact] : [];
      var t2 = [], t3 = [];
      var body = q.replace(/^[^a-z0-9]+/, '');
      var allowT2 = body.length >= 1;
      var allowT3 = body.length >= 2;
      for (var i = 0; i < sorted.length; i++) {
        var e = sorted[i];
        if (e === exact) continue;
        if (e._lc.indexOf(q) === 0) {
          if (t1.length < CFG.primaryCount) t1.push(e);
        } else if (allowT2 && t2.length < CFG.secondaryCount &&
                   e._words.some(function (w) { return w.indexOf(body) === 0; })) {
          t2.push(e);
        } else if (allowT3 && t3.length < CFG.secondaryCount && e._lc.indexOf(body) !== -1) {
          t3.push(e);
        }
        if (t1.length >= CFG.primaryCount && t2.length >= CFG.secondaryCount &&
            t3.length >= CFG.secondaryCount) break;
      }
      return {
        primary: t1,
        secondary: t2.concat(t3).slice(0, CFG.secondaryCount),
        exact: exact
      };
    }

    function searchTrim(q) {
      q = q.toLowerCase();
      var r = search(q);
      if (!r.primary.length && !r.secondary.length && /\s$/.test(q)) {
        r = search(q.replace(/\s+$/, ''));
      }
      return r;
    }

    function findQuery(before, afterTab) {
      if (afterTab) before = before.replace(/\s$/, '');
      var len = before.length;
      var lo = Math.max(0, len - CFG.maxQueryLen);
      var useTrigger = triggerChars.size > 0;
      var starts = [];
      for (var i = lo; i < len; i++) {
        if (i > 0 && !/\s/.test(before.charAt(i - 1))) continue;
        var ch = before.charAt(i);
        if (/\s/.test(ch)) continue;
        if (useTrigger ? triggerChars.has(ch) : true) starts.push(i);
      }
      if (!starts.length) return null;
      for (var s = 0; s < starts.length; s++) {
        var q = before.slice(starts[s]);
        if (!useTrigger && q.replace(/\s+$/, '').length < 2) continue;
        var r = searchTrim(q);
        if (r.primary.length) return { start: starts[s], res: r };
      }
      var last = starts[starts.length - 1];
      var q2 = before.slice(last);
      if (!useTrigger && q2.replace(/\s+$/, '').length < 2) return null;
      var r2 = searchTrim(q2);
      if (r2.secondary.length) return { start: last, res: r2 };
      return null;
    }

    /* @mentions */
    function getUsers() {
      var out = [], seen = new Set();
      var el = document.getElementById('userlist');
      if (!el) return out;
      var me = ((window.CLIENT && window.CLIENT.name) || '').toLowerCase();
      for (var i = 0; i < el.children.length; i++) {
        var item = el.children[i];
        var name = (item.getAttribute('data-name') || (item.querySelector('.userlist_item') && item.textContent) || item.textContent || '').trim();
        // CyTube userlist items usually have the name in a child or data
        var nm = item.querySelector('.userlist_item, .username, span');
        if (nm) name = (nm.textContent || '').trim();
        // Fallback: first text node-ish
        if (!name) name = (item.textContent || '').replace(/\s+/g, ' ').trim().split(' ')[0];
        if (!name) continue;
        var lc = name.toLowerCase();
        if (seen.has(lc)) continue;
        if (!CFG.includeSelf && lc === me) continue;
        seen.add(lc);
        out.push({ name: name, lc: lc });
      }
      return out;
    }

    function matchUsers(prefix) {
      var list = getUsers();
      var p = (prefix || '').toLowerCase();
      var hits = list.filter(function (u) { return !p || u.lc.indexOf(p) === 0; });
      return { list: hits.slice(0, CFG.mentionCount) };
    }

    /* Panel UI */
    var box = null, chat = null, mctx = null, tabFlag = false;

    function buildBox() {
      if (box) return;
      box = document.createElement('div');
      box.id = NS + '-emote-panel';
      box.setAttribute('style',
        'display:none;position:relative;z-index:20;padding:4px 6px;margin:0 0 2px 0;' +
        'background:rgba(0,0,0,0.55);border:1px solid rgba(255,255,255,0.12);border-radius:3px;' +
        'max-height:120px;overflow:auto;font-size:12px;line-height:1.2;');
      var host = document.getElementById('chatwrap') || (chat && chat.parentElement);
      if (host && chat) {
        if (CFG.dockMode === 'inline') {
          chat.parentElement.insertBefore(box, chat);
        } else {
          host.appendChild(box);
        }
      }
    }

    function hide() {
      if (box) box.style.display = 'none';
      mctx = null;
    }

    function showChips(items, mode) {
      if (!box) return;
      box.innerHTML = '';
      if (!items.length) { hide(); return; }
      items.forEach(function (it) {
        var chip = document.createElement('span');
        chip.setAttribute('style',
          'display:inline-flex;align-items:center;gap:4px;margin:2px 4px 2px 0;padding:2px 6px;' +
          'background:rgba(255,255,255,0.08);border-radius:3px;cursor:pointer;vertical-align:middle;');
        if (mode === 'emote' && it.image) {
          var im = document.createElement('img');
          im.src = srcFor(it);
          im.alt = '';
          im.width = CFG.thumbMax;
          im.height = CFG.thumbMax;
          im.style.objectFit = 'contain';
          im.style.maxWidth = CFG.thumbMax + 'px';
          im.style.maxHeight = CFG.thumbMax + 'px';
          chip.appendChild(im);
        }
        var lab = document.createElement('span');
        lab.textContent = mode === 'user' ? ('@' + it.name) : it.name;
        chip.appendChild(lab);
        chip.addEventListener('mousedown', function (ev) {
          ev.preventDefault(); // keep focus on chatline
          insertCompletion(mode === 'user' ? ('@' + it.name + ' ') : (it.name + ' '), mode);
        });
        box.appendChild(chip);
      });
      box.style.display = 'block';
    }

    function insertCompletion(text, mode) {
      if (!chat) return;
      var start = chat.selectionStart || 0;
      var val = chat.value || '';
      var before = val.slice(0, start);
      var after = val.slice(start);
      var qinfo = null;
      if (mode === 'user') {
        var at = before.lastIndexOf('@');
        if (at >= 0) {
          before = before.slice(0, at);
        }
      } else {
        qinfo = findQuery(before, false);
        if (qinfo) before = before.slice(0, qinfo.start);
      }
      chat.value = before + text + after;
      var pos = (before + text).length;
      try { chat.selectionStart = chat.selectionEnd = pos; } catch (e) {}
      chat.focus();
      hide();
    }

    function update(afterTab) {
      if (!chat) return;
      var start = chat.selectionStart || 0;
      var before = (chat.value || '').slice(0, start);
      // Mention?
      if (CFG.mentions) {
        var atMatch = before.match(/@([a-zA-Z0-9_]{0,20})$/);
        if (atMatch) {
          var ur = matchUsers(atMatch[1]);
          mctx = { type: 'user', prefix: atMatch[1], list: ur.list, idx: 0 };
          showChips(ur.list, 'user');
          return;
        }
      }
      var qinfo = findQuery(before, afterTab);
      if (!qinfo) { hide(); return; }
      var list = qinfo.res.primary.concat(qinfo.res.secondary);
      mctx = { type: 'emote', list: list, idx: 0, start: qinfo.start };
      showChips(list, 'emote');
    }

    function bindChat() {
      chat = document.getElementById('chatline');
      if (!chat || chat.__meeBound) return;
      chat.__meeBound = true;
      buildBox();

      chat.addEventListener('keydown', function (ev) {
        if (ev.key === 'Tab' && mctx && mctx.list && mctx.list.length) {
          ev.preventDefault();
          tabFlag = true;
          var dir = ev.shiftKey ? -1 : 1;
          mctx.idx = (mctx.idx + dir + mctx.list.length) % mctx.list.length;
          var it = mctx.list[mctx.idx];
          if (mctx.type === 'user') {
            insertCompletion('@' + it.name + ' ', 'user');
          } else {
            insertCompletion(it.name + ' ', 'emote');
          }
          return;
        }
        if (ev.key === 'Escape') hide();
        if (ev.key !== 'Shift' && ev.key !== 'Control' && ev.key !== 'Alt' && ev.key !== 'Meta') mctx = null;
      });
      chat.addEventListener('keyup', function (ev) {
        if (ev.key === 'Enter' || ev.key === 'Escape') return;
        var t = tabFlag; tabFlag = false;
        setTimeout(function () { update(t); }, 0);
      });
      chat.addEventListener('input', function () { mctx = null; update(false); });
      chat.addEventListener('click', function () { update(false); });
      chat.addEventListener('blur', function () { tabFlag = false; setTimeout(hide, 250); });
    }

    function boot() {
      var tries = 0;
      var iv = setInterval(function () {
        tries++;
        chat = document.getElementById('chatline');
        if (window.CHANNEL && window.CHANNEL.emotes && chat && document.body) {
          clearInterval(iv);
          syncEmotes();
          buildBox();
          bindChat();
          startObserver();
          startPreload();
          log('EmoteIntegration ready');
        } else if (tries > 120) {
          clearInterval(iv);
          log('gave up waiting for CHANNEL/#chatline');
        }
      }, 500);
    }

    // Public diagnostics (compatible with EmoteTools.*)
    window.EmoteTools = window.EmoteTools || {
      cfg: CFG,
      stats: function () {
        var blobs = 0, imgs = 0;
        cache.forEach(function (r) {
          if (r.state === 'blob') blobs++;
          else if (r.state === 'img') imgs++;
        });
        return {
          emotes: byName.size, inMemory: blobs, fallbackImgOnly: imgs,
          loadedFromDisk: stat.fromDisk, loadedFromNetwork: stat.fromNet,
          queued: queue.length, active: active,
          memoryMB: +(totalBytes / 1048576).toFixed(1),
          persistent: diskOK()
        };
      },
      find: function (q) {
        syncEmotes();
        var r = searchTrim(q);
        return {
          primary: r.primary.map(function (e) { return e.name; }),
          secondary: r.secondary.map(function (e) { return e.name; })
        };
      },
      users: function (prefix) {
        return matchUsers(prefix || '').list.map(function (u) { return u.name; });
      },
      clearDisk: function () {
        return diskOK()
          ? window.caches.delete(DISK_NAME).then(function (ok) { diskP = null; diskUsed = 0; return ok; })
          : Promise.resolve(false);
      }
    };

    return { boot: boot, syncEmotes: syncEmotes };
  })();

  /* --------------------------------------------------------------------------
   * Inject effect CSS so Preview (and optional live post-process) works on
   * channels that do not import mediaempire/pink.horse stylesheets.
   * -------------------------------------------------------------------------- */
  function injectEffectCSS() {
    if (document.getElementById(NS + '-fx-css')) return;
    // Google fonts for /in and /sega approximations
    if (!document.getElementById(NS + '-fonts')) {
      var link = document.createElement('link');
      link.id = NS + '-fonts';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Press+Start+2P&family=Russo+One&display=swap';
      (document.head || document.documentElement).appendChild(link);
    }
    if (!document.getElementById(NS + '-nisesega')) {
      var ff = document.createElement('style');
      ff.id = NS + '-nisesega';
      ff.textContent = '@font-face{font-family:"NiseSega";src:url("https://cdn.jsdelivr.net/gh/duckwerks/userscripts@main/fonts/NiseSega.ttf") format("truetype");font-weight:normal;font-style:normal;font-display:swap}';
      (document.head || document.documentElement).appendChild(ff);
    }
    var css = [
      /* rainbow hue — strong enough to show on near-grayscale art */
      '@keyframes mee-hue{',
      '0%{filter:hue-rotate(0deg) saturate(3) contrast(1.15) brightness(1.05)}',
      '100%{filter:hue-rotate(360deg) saturate(3) contrast(1.15) brightness(1.05)}}',
      'img.hued,.hued,.dankestMeme img{animation:mee-hue .55s linear infinite!important;display:inline-block;vertical-align:middle}',

      /* shake */
      '@keyframes mee-shake{',
      '0%{transform:translate(2px,1px) rotate(0)}10%{transform:translate(-1px,-2px) rotate(-1deg)}',
      '20%{transform:translate(-3px,0) rotate(1deg)}30%{transform:translate(0,2px)}',
      '40%{transform:translate(1px,-1px) rotate(1deg)}50%{transform:translate(-1px,2px) rotate(-1deg)}',
      '60%{transform:translate(-3px,1px)}70%{transform:translate(2px,1px) rotate(-1deg)}',
      '80%{transform:translate(-1px,-1px) rotate(1deg)}90%{transform:translate(2px,2px)}',
      '100%{transform:translate(1px,-2px) rotate(-1deg)}}',
      '.image-shake{display:inline-block;animation:mee-shake .8s linear infinite;transform-origin:50% 50%}',

      /* continuous one-way full-width slide for .sr/.sl suffixes on images */
      '@keyframes mee-run-right{0%{transform:translateX(-120%)}100%{transform:translateX(120%)}}',
      '@keyframes mee-run-left{0%{transform:translateX(120%)}100%{transform:translateX(-120%)}}',
      '.slide-right,.slide-left,.slide-up,.slide-down{display:inline-block;vertical-align:middle}',
      /* wrapper makes room so animation crosses the chat row */
      'span.slide-right,span.slide-left{display:block;width:100%;overflow:hidden}',
      'span.slide-right>img,img.slide-right{animation:mee-run-right 6s linear infinite}',
      'span.slide-left>img,img.slide-left{animation:mee-run-left 6s linear infinite}',
      '@keyframes mee-run-up{0%{transform:translateY(80%)}100%{transform:translateY(-80%)}}',
      '@keyframes mee-run-down{0%{transform:translateY(-80%)}100%{transform:translateY(80%)}}',
      'img.slide-up{animation:mee-run-up 4s linear infinite}',
      'img.slide-down{animation:mee-run-down 4s linear infinite}',

      /* peek: crop to top band, bob up/down */
      '@keyframes mee-peek{',
      '0%,100%{transform:translateY(55%);opacity:1}',
      '40%,60%{transform:translateY(10%);opacity:1}}',
      '.peek_up{display:inline-block;max-width:200px;max-height:100px!important;',
      'overflow:hidden;object-fit:cover;object-position:top;vertical-align:middle;',
      'animation:mee-peek 2.2s ease-in-out infinite}',

      /* chat-width marquee for /sr /sl text commands */
      '#messagebuffer .mee-scroll-right,#messagebuffer .mee-scroll-right-fast,#messagebuffer .mee-scroll-right-hyper,',
      '#messagebuffer .mee-scroll-left,#messagebuffer .mee-scroll-left-fast,#messagebuffer .mee-scroll-left-hyper{',
      'display:block!important;width:100%!important;max-width:100%!important;overflow:hidden!important}',
      '@keyframes mee-marquee-right{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}',
      '@keyframes mee-marquee-left{0%{transform:translateX(100%)}100%{transform:translateX(-100%)}}',
      '#messagebuffer .mee-scroll-right .mee-scroll-inner,#messagebuffer .mee-scroll-right-fast .mee-scroll-inner,',
      '#messagebuffer .mee-scroll-right-hyper .mee-scroll-inner{display:inline-block;animation:mee-marquee-right 8s linear infinite}',
      '#messagebuffer .mee-scroll-right-fast .mee-scroll-inner{animation-duration:4s}',
      '#messagebuffer .mee-scroll-right-hyper .mee-scroll-inner{animation-duration:1.5s}',
      '#messagebuffer .mee-scroll-left .mee-scroll-inner,#messagebuffer .mee-scroll-left-fast .mee-scroll-inner,',
      '#messagebuffer .mee-scroll-left-hyper .mee-scroll-inner{display:inline-block;animation:mee-marquee-left 8s linear infinite}',
      '#messagebuffer .mee-scroll-left-fast .mee-scroll-inner{animation-duration:4s}',
      '#messagebuffer .mee-scroll-left-hyper .mee-scroll-inner{animation-duration:1.5s}',

      /* other */
      '.image-blur{transition:filter 1s;filter:blur(5px)}.image-blur:hover{filter:blur(0)}',
      '.tilt-f{display:inline-block;transform:rotate(-45deg)}.tilt-r{display:inline-block;transform:rotate(45deg)}',
      '.mirror-x{display:inline-block;transform:scaleX(-1)}.mirror-y{display:inline-block;transform:scaleY(-1)}',
      '.noir{filter:grayscale(100%)}',
      '@keyframes mee-owl{to{transform:rotate(360deg)}}.rotate_owl{display:inline-block;animation:mee-owl 1.2s linear infinite}',
      '.dankestMeme{font-weight:700;animation:mee-rainbow .3s alternate infinite}',
      '@keyframes mee-rainbow{0%{color:#009}25%{color:#090}50%{color:#F60}75%{color:#906}100%{color:#009}}',

      /* Nintendo pill / race-stripe logo look for /in */
      '.hig-nintendo{',
      'display:inline-block;font-family:"Press Start 2P",monospace!important;',
      'font-size:11px;line-height:1.4;letter-spacing:1px;text-transform:uppercase;',
      'color:#fff!important;background:#e60012;padding:4px 14px;',
      'border-radius:999px;border:3px solid #fff;',
      'box-shadow:0 0 0 3px #e60012,2px 2px 0 #000;',
      'text-shadow:none}',

      /* Sega — NiseSega from userscripts repo */
      '.sega-font{',
      'display:inline-block;font-family:"NiseSega","Russo One",Impact,sans-serif!important;',
      'font-size:1.5em;letter-spacing:.06em;text-transform:uppercase;line-height:1.15;',
      'color:#1a8cff!important;background:none;-webkit-text-fill-color:unset;',
      'text-shadow:0 1px 0 #001a44,0 0 6px rgba(0,140,255,.35)}',

      'img.mee-pic{max-height:80px!important;max-width:120px!important}',
      'img.mee-mid{max-height:160px!important;max-width:240px!important}',
      'img.mee-big{max-height:280px!important;max-width:400px!important}',
      'img.mee-ant{max-height:24px!important;max-width:40px!important}',
      'img.mee-yuge{max-height:480px!important;max-width:100%!important}',
      '.channel-image,img.channel-emote{vertical-align:middle;max-height:200px;max-width:100%}'
    ].join('');
    var style = document.createElement('style');
    style.id = NS + '-fx-css';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
    log('effect CSS injected (v0.1.7)');
  }


  /* --------------------------------------------------------------------------
   * Chat post-process: rainbow mask on images/emotes, bare image embed
   * Runs after CyTube paints a message (filters + emote expansion).
   * -------------------------------------------------------------------------- */


  var ChatPostProcess = (function () {
    var SIZE = { pic: 'mee-pic', mid: 'mee-mid', big: 'mee-big', ant: 'mee-ant', yuge: 'mee-yuge', sh: 'mee-pic' };
    var FX = {
      rb: 'hued', owl: 'rotate_owl', bw: 'noir', blr: 'image-blur', sh: 'image-shake',
      peek: 'peek_up', sl: 'slide-left', sr: 'slide-right', up: 'slide-up', dw: 'slide-down',
      sp: 'image-blur', wew: 'hued', uma: 'hued', cop: 'happening', hap: 'happening',
      ree: 'ree', jail: 'jail', blkd: 'blkd', invt: 'invt'
    };
    // suffixes we strip from URLs (longest first when matching)
    var SUFFIXES = Object.keys(SIZE).concat(Object.keys(FX));
    SUFFIXES.sort(function (a, b) { return b.length - a.length; });
    var SUFFIX_ALT = SUFFIXES.join('|');
    var URL_RE = /(https?:\/\/[^\s<>"']+\.(?:gif|png|jpe?g|webp|bmp))((?:\.(?:pic|mid|big|ant|yuge|sh|rb|owl|bw|blr|peek|sl|sr|up|dw|sp|wew|uma|cop|hap|ree|jail|blkd|invt))*)/gi;

    function emoteListSorted() {
      var list = (window.CHANNEL && window.CHANNEL.emotes) || [];
      // longest names first so "/bane mouse" wins over "/bane"
      return list.slice().filter(function (e) { return e && e.name && e.image; })
        .sort(function (a, b) { return b.name.length - a.name.length; });
    }

    function makeEmoteImg(em) {
      var img = document.createElement('img');
      img.className = 'channel-emote';
      img.src = em.image;
      img.title = em.name;
      img.alt = em.name;
      return img;
    }

    function makeUrlImg(url, suffixStr) {
      var img = document.createElement('img');
      img.className = 'channel-image';
      img.src = url;
      img.alt = '';
      img.loading = 'lazy';
      var parts = (suffixStr || '').split('.').filter(Boolean);
      var hasSize = false;
      parts.forEach(function (p) {
        p = p.toLowerCase();
        if (SIZE[p]) { img.classList.add(SIZE[p]); hasSize = true; }
        if (FX[p]) img.classList.add(FX[p]);
      });
      if (!hasSize) {
        img.style.maxHeight = '200px';
        img.style.maxWidth = '100%';
      }
      img.style.verticalAlign = 'middle';
      return img;
    }

    function expandEmotesInElement(el) {
      if (!el || el.nodeType !== 1) return;
      if (el.tagName === 'IMG' || el.tagName === 'CODE') return;
      var list = emoteListSorted();
      if (!list.length) return;

      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      var nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);

      nodes.forEach(function (textNode) {
        var text = textNode.nodeValue;
        if (!text || text.indexOf('/') === -1) return;

        // Build one regex of all emote names (escaped), longest already first in alternation
        var alts = [];
        list.forEach(function (em) {
          // match name as whole token; allow multi-word
          alts.push(em.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        });
        if (!alts.length) return;
        var re = new RegExp('(' + alts.join('|') + ')', 'i');
        if (!re.test(text)) return;
        re.lastIndex = 0;

        var frag = document.createDocumentFragment();
        var remaining = text;
        var safety = 0;
        while (remaining && safety++ < 50) {
          var m = re.exec(remaining);
          if (!m) {
            frag.appendChild(document.createTextNode(remaining));
            break;
          }
          if (m.index > 0) frag.appendChild(document.createTextNode(remaining.slice(0, m.index)));
          var name = m[1];
          var em = null;
          for (var i = 0; i < list.length; i++) {
            if (list[i].name.toLowerCase() === name.toLowerCase()) { em = list[i]; break; }
          }
          if (em) frag.appendChild(makeEmoteImg(em));
          else frag.appendChild(document.createTextNode(name));
          remaining = remaining.slice(m.index + name.length);
          re.lastIndex = 0;
        }
        textNode.parentNode.replaceChild(frag, textNode);
      });
    }

    function expandUrlsInElement(el) {
      if (!el || el.nodeType !== 1) return;
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      var nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach(function (textNode) {
        var text = textNode.nodeValue;
        if (!text || text.indexOf('http') === -1) return;
        URL_RE.lastIndex = 0;
        if (!URL_RE.test(text)) return;
        URL_RE.lastIndex = 0;
        var frag = document.createDocumentFragment();
        var last = 0, m;
        while ((m = URL_RE.exec(text))) {
          if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
          frag.appendChild(makeUrlImg(m[1], m[2] || ''));
          last = m.index + m[0].length;
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        textNode.parentNode.replaceChild(frag, textNode);
      });
      el.querySelectorAll && el.querySelectorAll('a[href]').forEach(function (a) {
        var href = a.getAttribute('href') || '';
        var base = href.split('?')[0];
        if (!/\.(gif|png|jpe?g|webp|bmp)$/i.test(base)) return;
        if (a.querySelector('img')) return;
        a.parentNode.replaceChild(makeUrlImg(href, ''), a);
      });
    }

    function applyRainbow(el) {
      if (!el || !el.querySelectorAll) return;
      el.querySelectorAll('.dankestMeme img').forEach(function (img) {
        img.classList.add('hued');
      });
    }

    function ensureScrollInner(el) {
      if (!el || !el.querySelectorAll) return;
      el.querySelectorAll('.mee-scroll-right, .mee-scroll-right-fast, .mee-scroll-right-hyper, .mee-scroll-left, .mee-scroll-left-fast, .mee-scroll-left-hyper').forEach(function (outer) {
        if (outer.querySelector(':scope > .mee-scroll-inner')) return;
        var inner = document.createElement('span');
        inner.className = 'mee-scroll-inner';
        while (outer.firstChild) inner.appendChild(outer.firstChild);
        outer.appendChild(inner);
      });
    }


    function wrapSlideImages(el) {
      if (!el || !el.querySelectorAll) return;
      el.querySelectorAll('img.slide-right, img.slide-left').forEach(function (img) {
        if (img.parentElement && img.parentElement.classList &&
            (img.parentElement.classList.contains('slide-right') ||
             img.parentElement.classList.contains('slide-left'))) return;
        var dir = img.classList.contains('slide-left') ? 'slide-left' : 'slide-right';
        var wrap = document.createElement('span');
        wrap.className = dir;
        img.parentNode.insertBefore(wrap, img);
        wrap.appendChild(img);
      });
    }
    function processNode(node) {
      if (!node || node.nodeType !== 1) return;
      if (node.classList && node.classList.contains('server-msg-reconnect')) return;
      ensureScrollInner(node);
      expandUrlsInElement(node);
      expandEmotesInElement(node);
      applyRainbow(node);
      wrapSlideImages(node);
    }

    function processBuffer() {
      var buf = document.getElementById('messagebuffer');
      if (!buf) return;
      Array.prototype.forEach.call(buf.children, processNode);
    }

    function start() {
      var buf = document.getElementById('messagebuffer');
      if (!buf || buf.__meePostProcess14) return;
      buf.__meePostProcess14 = true;
      processBuffer();
      new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          m.addedNodes.forEach(function (n) {
            if (n.nodeType === 1) setTimeout(function () { processNode(n); }, 0);
          });
        });
      }).observe(buf, { childList: true, subtree: false });
      log('ChatPostProcess v0.1.5 active (multi-word emotes + full suffixes)');
    }

    return { start: start, processBuffer: processBuffer };
  })();



  /* --------------------------------------------------------------------------
   * Boot
   * -------------------------------------------------------------------------- */
  function bootAll() {
    injectEffectCSS();
    bindPostedEmoteClick();
    EmoteIntegration.boot();
    ChatPostProcess.start();
    log('mediaempire-enhance v' + VERSION + ' started');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootAll);
  } else {
    bootAll();
  }

  // Re-ensure UI after CyTube layout changes
  setTimeout(function () {
    bindPostedEmoteClick();
  }, 2000);

  window.MediaEmpireEnhance = {
    version: VERSION,
    cfg: CFG,
    EffectEngine: EffectEngine,
  };
})();
