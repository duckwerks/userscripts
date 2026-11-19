/**
 * mediaempire-enhance v0.2.3
 * Clean CyTube chat enhancement for https://cytu.be/r/mediaempire
 *
 * Scope:
 *  - Emote Tools 1.4 functionality (autocomplete, multi-word, @mentions, Tab cycling,
 *    docked panel, optional cache) — ported, not loaded remotely
 *  - Click posted channel-emote → insert code into #chatline (no send)
 *  - Live chat effects: image suffixes (.sr .up .peek .sp .jail .ree .cop ...) and
 *    direct-video 🎬 popup preview
 *  - Safe, idempotent init
 *
 * (The old Preview button / EffectEngine was never switched on and was removed in v0.2.1.)
 *
 * Design: keep the existing room syntax culture.
 */
(function () {
  'use strict';
  if (window.__mediaempireEnhanceLoaded) return;
  window.__mediaempireEnhanceLoaded = true;

  var VERSION = '0.2.3';
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

    // Video link preview (🎬 button after direct video links)
    videoPreview: true,
    videoMaxWidth: 420
  };

  function log() {
    if (CFG.debug && window.console) {
      console.log.apply(console, ['[' + NS + ']'].concat([].slice.call(arguments)));
    }
  }

  /* --------------------------------------------------------------------------
   * Image FX assets (used by the .gun / .no / .fine / .ree suffixes)
   * -------------------------------------------------------------------------- */
  // Image-overlay assets. Per overlay:
  //   url    - the picture ('' turns that overlay off)
  //   fit    - CSS object-fit: 'contain' keeps proportions, 'fill' stretches, 'cover' crops
  //   pos    - CSS object-position (used when there is no anchor)
  //   anchor - pin the overlay to a corner of the image: 'top left', 'top right', 'bottom left',
  //            'bottom right' (scaled to fit inside its box, proportions kept)
  //   size   - overlay box as a % of the image (default 100). Use e.g. 40 for a small corner badge.
  var FX_ASSETS = {
    gun:  { url: 'https://resources.pink.horse/images/emotes/fx/gunpoint.png', fit: 'contain', anchor: 'bottom right', size: 100 },
    no:   { url: 'https://resources.pink.horse/images/emotes/fx/busters.png',  fit: 'contain', pos: 'center' },
    fine: { url: 'https://resources.pink.horse/images/emotes/fx/fire.gif',     fit: 'contain', pos: 'center bottom' },
    nuke: { url: 'https://gifdb.com/images/high/atomic-bomb-explosion-fysi5noay99evzj3.webp', fit: 'cover', pos: 'center' },
    sad:  { url: 'https://resources.pink.horse/images/emotes/fx/rain.gif', fit: 'cover', pos: 'center' },
    cum:  { url: 'https://i.ibb.co/yhn922G/ZR2d98b.gif', fit: 'contain', anchor: 'top left', size: 100 },
    braz: { url: 'https://resources.pink.horse/images/icons/brazzers.png', fit: 'contain', pos: 'center bottom' }, // drawn in a strip along the bottom 30%
    v:    { url: 'https://i.ibb.co/qMWW2ZGC/hazmattie-smoko.png', fit: 'contain', pos: 'center' }, // if this fails to load, a drawn hazmat suit is used instead
    blkd: { url: 'https://i.ibb.co/xKdGySVp/Borged.webp', fit: 'contain', anchor: 'top right', size: 100 }
  };

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
   * Inject effect CSS so the live chat effects work on
   * channels that do not import mediaempire/pink.horse stylesheets.
   * -------------------------------------------------------------------------- */
  function injectEffectCSS() {
    if (document.getElementById(NS + '-fx-css')) return;
    // Google fonts for /in and /sega approximations
    if (!document.getElementById(NS + '-fonts')) {
      var link = document.createElement('link');
      link.id = NS + '-fonts';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Press+Start+2P&family=Russo+One&family=Creepster&display=swap';
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
      /* v0.1.8: % in translateX is relative to the element's OWN width, so a small image only
         moved a few px. 100cqw = width of the nearest size container (the wrapper span below),
         so the image now starts fully off one edge and ends fully off the other. */
      '@keyframes mee-run-right{0%{transform:translateX(-100%)}100%{transform:translateX(100cqw)}}',
      '@keyframes mee-run-left{0%{transform:translateX(100cqw)}100%{transform:translateX(-100%)}}',
      '@supports not (width:1cqw){',
      '@keyframes mee-run-right{0%{transform:translateX(-120%)}100%{transform:translateX(120%)}}',
      '@keyframes mee-run-left{0%{transform:translateX(120%)}100%{transform:translateX(-120%)}}}',
      '.slide-right,.slide-left,.slide-up,.slide-down{display:inline-block;vertical-align:middle}',
      /* wrapper makes room so animation crosses the chat row */
      'span.slide-right,span.slide-left{display:block;width:100%;overflow:hidden;container-type:inline-size}',
      'span.slide-right>img,img.slide-right{animation:mee-run-right 6s linear infinite}',
      'span.slide-left>img,img.slide-left{animation:mee-run-left 6s linear infinite}',
      /* v0.1.9: .up/.dw/.peek images live in an image-sized clip box (span.mee-clip), so they rise/fall
         through their own message row and are hidden at the row edge. translateY % = the image's own
         height = the clip box height here, which is exactly what we want. */
      '@keyframes mee-rise{0%{transform:translateY(100%)}100%{transform:translateY(-100%)}}',
      '@keyframes mee-fall{0%{transform:translateY(-100%)}100%{transform:translateY(100%)}}',
      'span.mee-clip{display:inline-block;overflow:hidden;vertical-align:middle;line-height:0;max-width:100%}',
      'span.mee-clip>img{vertical-align:top}',
      'span.mee-clip>img.slide-up{animation:mee-rise 4s linear infinite}',
      'span.mee-clip>img.slide-down{animation:mee-fall 4s linear infinite}',

      /* peek (v0.1.9): image keeps its normal size; it pops up from the bottom of its clip box and hides again */
      '@keyframes mee-peek-v2{0%,100%{transform:translateY(100%)}35%,65%{transform:translateY(15%)}}',
      'span.mee-clip>img.peek_up{animation:mee-peek-v2 2.4s ease-in-out infinite;',
      'max-width:100%!important;max-height:200px!important;object-fit:fill!important}',

      /* video link preview */
      '.mee-vid-btn{cursor:pointer;margin-left:.3em;user-select:none;-webkit-user-select:none}',
      '.mee-vid-btn:hover{filter:brightness(1.3)}',

      /* chat-width marquee for /sr /sl text commands */
      '#messagebuffer .mee-scroll-right,#messagebuffer .mee-scroll-right-fast,#messagebuffer .mee-scroll-right-hyper,',
      '#messagebuffer .mee-scroll-left,#messagebuffer .mee-scroll-left-fast,#messagebuffer .mee-scroll-left-hyper{',
      'display:block!important;width:100%!important;max-width:100%!important;overflow:hidden!important;container-type:inline-size}',
      /* v0.1.8: full-width travel (100cqw = marquee box width), same fix as image slides */
      '@keyframes mee-marquee-right{0%{transform:translateX(-100%)}100%{transform:translateX(100cqw)}}',
      '@keyframes mee-marquee-left{0%{transform:translateX(100cqw)}100%{transform:translateX(-100%)}}',
      '@supports not (width:1cqw){',
      '@keyframes mee-marquee-right{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}',
      '@keyframes mee-marquee-left{0%{transform:translateX(100%)}100%{transform:translateX(-100%)}}}',
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

      /* /troma — Creepster (Google Fonts) in slime green */
      '.troma-font{',
      'font-family:"Creepster",Chiller,Impact,fantasy!important;',
      'font-size:2.1em;letter-spacing:.05em;color:#86e01a!important;',
      'text-shadow:0 2px 0 #2c5a00,0 0 8px rgba(134,224,26,.55)}',

      '/* v0.2.2 image FX: the script wraps the picture in span.mee-fx and adds overlay layers (span.mee-ov) */',
      'span.mee-fx{position:relative;display:inline-block;vertical-align:middle;line-height:0;max-width:100%}',
      'span.mee-fx>.mee-ov{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:hidden}',
      'span.mee-fx>.mee-ov>img{display:block;width:100%;height:100%;max-width:none!important;max-height:none!important}',
      'span.mee-fx>.mee-ov.mee-sp{background:#000;pointer-events:auto;cursor:pointer}',
      'span.mee-fx>.mee-ov.mee-sp>.mee-sp-bar{position:absolute;left:-25%;width:150%;top:50%;transform:translateY(-50%) rotate(-24deg);background:#d00;color:#fff;font:bold 14px/1.6 Arial,sans-serif;letter-spacing:.18em;text-align:center;border-top:2px solid #700;border-bottom:2px solid #700;text-shadow:0 1px 0 #600}',
      'span.mee-fx.mee-open>.mee-ov.mee-sp{display:none}',
      'span.mee-fx>.mee-ov.mee-jail{background:linear-gradient(180deg,#1c1c1c 0,#8a8a8a 3%,#1c1c1c 6%,transparent 6%,transparent 94%,#1c1c1c 94%,#8a8a8a 97%,#1c1c1c 100%),repeating-linear-gradient(90deg,transparent 0,transparent 14%,#1c1c1c 14%,#8a8a8a 16%,#d8d8d8 17%,#8a8a8a 18%,#1c1c1c 20%),rgba(0,0,0,.12)}',
      'span.mee-fx.mee-fx-ree{animation:mee-shake .25s linear infinite}',
      'span.mee-fx>.mee-ov.mee-ree-red{background:#f00;animation:mee-ree-pulse .7s ease-in-out infinite alternate}',
      'span.mee-fx>.mee-ov.mee-ree-nuke{background:#000;opacity:0;animation:mee-ree-nuke 10s linear infinite}',
      'span.mee-fx>.mee-ov.mee-ree-black{background:#000;opacity:0;animation:mee-ree-black 10s linear infinite}',
      '@keyframes mee-ree-pulse{0%{opacity:.1}100%{opacity:.6}}',
      '@keyframes mee-ree-nuke{0%,46%{opacity:0}58%,70%{opacity:1}76%,100%{opacity:0}}',
      '@keyframes mee-ree-black{0%,66%{opacity:0}74%,92%{opacity:1}100%{opacity:0}}',
      '/* cop (v0.2.2): the PICTURE ITSELF is tinted/glowed with a filter (so transparent areas stay transparent), in a',
      '   light-bar pattern: red double-flash, pause, blue double-flash, pause. Two 🚨 lamps (red / blue) flash in step. */',
      'span.mee-fx.mee-fx-cop{margin-top:1rem}',
      'span.mee-fx.mee-fx-cop>img,span.mee-fx.mee-fx-cop>span.mee-clip{animation:mee-cop-img 1.2s steps(1,end) infinite}',
      '@keyframes mee-cop-img{0%{filter:grayscale(1) brightness(.5) sepia(1) saturate(8) hue-rotate(-35deg) drop-shadow(0 0 6px #f00)}7%{filter:brightness(.85)}14%{filter:grayscale(1) brightness(.5) sepia(1) saturate(8) hue-rotate(-35deg) drop-shadow(0 0 6px #f00)}21%{filter:brightness(.85)}50%{filter:grayscale(1) brightness(.5) sepia(1) saturate(8) hue-rotate(200deg) drop-shadow(0 0 6px #08f)}57%{filter:brightness(.85)}64%{filter:grayscale(1) brightness(.5) sepia(1) saturate(8) hue-rotate(200deg) drop-shadow(0 0 6px #08f)}71%,100%{filter:brightness(.85)}}',
      'span.mee-fx>.mee-cop-siren{position:absolute;left:50%;top:0;transform:translate(-50%,-45%);font-size:1.7rem;line-height:1;z-index:2;pointer-events:none}',
      'span.mee-fx>.mee-cop-siren.r{filter:drop-shadow(0 0 5px #f00);animation:mee-cop-r 1.2s steps(1,end) infinite}',
      'span.mee-fx>.mee-cop-siren.b{filter:hue-rotate(220deg) brightness(1.15) drop-shadow(0 0 5px #08f);animation:mee-cop-b 1.2s steps(1,end) infinite}',
      '@keyframes mee-cop-r{0%{opacity:1}7%{opacity:.25}14%{opacity:1}21%{opacity:.25}50%,100%{opacity:0}}',
      '@keyframes mee-cop-b{0%{opacity:0}50%{opacity:1}57%{opacity:.25}64%{opacity:1}71%,100%{opacity:.25}}',
      'span.mee-fx>.mee-ov.mee-hap{background:#f00;animation:mee-hap 2.6s ease-in-out infinite}',
      '@keyframes mee-hap{0%,100%{opacity:0}50%{opacity:.55}}',
      'span.mee-fx>.mee-ov.mee-braz{top:auto;bottom:0;height:30%}',
      'span.mee-fx>.mee-ov.mee-v>svg{display:block;width:100%;height:100%}',
      'span.mee-fx>.mee-ov.mee-msk{pointer-events:auto;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}',
      'span.mee-fx.mee-fx-msk img{-webkit-user-drag:none;user-select:none}',

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
    log('effect CSS injected (v0.2.3)');
  }


  /* --------------------------------------------------------------------------
   * VideoLinks — direct video links get a 🎬 button; click = tiny muted, control-less popup.
   * Click the popup, click anywhere else, or press Esc to close. Nothing loads until clicked.
   * -------------------------------------------------------------------------- */
  var VideoLinks = (function () {
    var EXT = /\.(mp4|m4v|webm|ogv|mov)$/i;
    var TEXT_RE = /https?:\/\/[^\s<>"']+?\.(?:mp4|m4v|webm|ogv|mov)(?:\?[^\s<>"']*)?(?=[\s<>"']|$)/gi;
    var pop = null, owner = null, bound = false;

    function isVideoUrl(u) {
      try {
        var x = new URL(u, location.href);
        return (x.protocol === 'http:' || x.protocol === 'https:') && EXT.test(x.pathname);
      } catch (e) { return false; }
    }

    function makeBtn(url) {
      var b = document.createElement('span');
      b.className = 'mee-vid-btn';
      b.textContent = '\uD83C\uDFAC';
      b.title = 'Preview video (muted)';
      b.setAttribute('role', 'button');
      b.setAttribute('tabindex', '0');
      b.setAttribute('data-url', url);
      return b;
    }

    function place() {
      if (!pop || !owner) return;
      if (!document.body.contains(owner)) { close(); return; }
      var r = owner.getBoundingClientRect();
      var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      var w = pop.offsetWidth || CFG.videoMaxWidth, h = pop.offsetHeight || 240;
      var left = Math.min(Math.max(8, r.left), Math.max(8, vw - w - 8));
      var top = r.bottom + 6;
      if (top + h > vh - 8) top = Math.max(8, r.top - h - 6);
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';
    }

    function close() {
      if (pop) {
        try { pop.pause(); pop.removeAttribute('src'); pop.load(); } catch (e) {}
        if (pop.parentNode) pop.parentNode.removeChild(pop);
      }
      pop = null; owner = null;
    }

    function open(btn) {
      var url = btn.getAttribute('data-url');
      if (!url) return;
      close();
      var v = document.createElement('video');
      v.muted = true; v.defaultMuted = true; v.setAttribute('muted', '');
      v.autoplay = true; v.loop = true; v.controls = false;
      v.playsInline = true; v.setAttribute('playsinline', '');
      v.disablePictureInPicture = true;
      v.preload = 'auto';
      v.setAttribute('style',
        'position:fixed;z-index:2147483000;display:block;background:#000;cursor:pointer;' +
        'max-width:min(' + CFG.videoMaxWidth + 'px,calc(100vw - 16px));max-height:60vh;' +
        'border:1px solid rgba(255,255,255,.35);border-radius:4px;box-shadow:0 4px 18px rgba(0,0,0,.6)');
      v.addEventListener('loadedmetadata', place);
      v.addEventListener('error', function () {
        close();
        btn.textContent = '\uD83D\uDEAB';
        btn.title = 'This browser could not play that file';
      });
      v.addEventListener('click', function (e) { e.stopPropagation(); close(); });
      v.src = url;
      document.body.appendChild(v);
      pop = v; owner = btn;
      place();
      var pr = v.play();
      if (pr && pr.catch) pr.catch(function () {});
    }

    function bind() {
      if (bound) return;
      bound = true;
      var buf = document.getElementById('messagebuffer');
      if (buf) {
        buf.addEventListener('click', function (e) {
          var t = e.target && e.target.closest ? e.target.closest('.mee-vid-btn') : null;
          if (!t) return;
          e.preventDefault(); e.stopPropagation();
          if (pop && owner === t) close(); else open(t);
        }, true);
        buf.addEventListener('keydown', function (e) {
          var t = e.target && e.target.closest ? e.target.closest('.mee-vid-btn') : null;
          if (t && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            if (pop && owner === t) close(); else open(t);
          }
        }, true);
        buf.addEventListener('scroll', place, { passive: true });
      }
      document.addEventListener('pointerdown', function (e) {
        if (!pop) return;
        if (pop.contains(e.target)) return;
        if (e.target && e.target.closest && e.target.closest('.mee-vid-btn')) return; // its click handler toggles
        close();
      }, true);
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); }, true);
      window.addEventListener('resize', place);
    }

    function expand(el) {
      if (!el || el.nodeType !== 1 || !el.querySelectorAll) return;
      bind();
      // 1) linkified URLs: keep the full link, add the button right after it
      el.querySelectorAll('a[href]').forEach(function (a) {
        var n = a.nextSibling;
        if (n && n.nodeType === 1 && n.classList && n.classList.contains('mee-vid-btn')) return;
        if (a.querySelector('img')) return;
        var href = a.getAttribute('href') || '';
        if (!isVideoUrl(href)) return;
        a.parentNode.insertBefore(makeBtn(a.href), a.nextSibling);
      });
      // 2) plain-text URLs (channel not linkifying): leave the text, add the button after it
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      var nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach(function (tn) {
        var text = tn.nodeValue;
        if (!text || text.indexOf('http') === -1) return;
        var par = tn.parentElement;
        if (!par || par.closest('a, .mee-vid-btn, code')) return;
        TEXT_RE.lastIndex = 0;
        if (!TEXT_RE.test(text)) return;
        TEXT_RE.lastIndex = 0;
        var frag = document.createDocumentFragment();
        var last = 0, m;
        while ((m = TEXT_RE.exec(text))) {
          var end = m.index + m[0].length;
          frag.appendChild(document.createTextNode(text.slice(last, end)));
          if (isVideoUrl(m[0])) frag.appendChild(makeBtn(m[0]));
          last = end;
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        tn.parentNode.replaceChild(frag, tn);
      });
    }

    return { expand: expand, close: close };
  })();

  /* --------------------------------------------------------------------------
   * Chat post-process: rainbow mask on images/emotes, bare image embed
   * Runs after CyTube paints a message (filters + emote expansion).
   * -------------------------------------------------------------------------- */


  var ChatPostProcess = (function () {
    var SIZE = { pic: 'mee-pic', mid: 'mee-mid', big: 'mee-big', ant: 'mee-ant', yuge: 'mee-yuge', sh: 'mee-pic' };
    var FX = {
      rb: 'hued', owl: 'rotate_owl', bw: 'noir', blr: 'image-blur', sh: 'image-shake',
      peek: 'peek_up', sl: 'slide-left', sr: 'slide-right', up: 'slide-up', dw: 'slide-down',
      sp: 'mee-fx-sp', wew: 'hued', uma: 'hued', cop: 'mee-fx-cop', hap: 'mee-fx-hap',
      ree: 'mee-fx-ree', jail: 'mee-fx-jail', blkd: 'mee-fx-blkd', invt: 'invt',
      gun: 'mee-fx-gun', no: 'mee-fx-no', fine: 'mee-fx-fine', msk: 'mee-fx-msk',
      sad: 'mee-fx-sad', cum: 'mee-fx-cum', braz: 'mee-fx-braz', v: 'mee-fx-v'
    };
    // suffixes we strip from URLs (longest first when matching)
    var SUFFIXES = Object.keys(SIZE).concat(Object.keys(FX));
    SUFFIXES.sort(function (a, b) { return b.length - a.length; });
    var SUFFIX_ALT = SUFFIXES.join('|');
    // built from the suffix tables above so live chat and the tables can't drift apart;
    // each suffix must end at a non-word character so e.g. ".nope" is not read as ".no"
    var URL_RE = new RegExp('(https?:\\/\\/[^\\s<>"\']+\\.(?:gif|png|jpe?g|webp|bmp))((?:\\.(?:' + SUFFIX_ALT + ')(?![A-Za-z0-9_]))*)', 'gi');

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


    /* v0.2.0 image FX — overlay layers drawn over the picture inside span.mee-fx */
    function fxOverlay(cls) {
      var d = document.createElement('span');
      d.className = 'mee-ov ' + cls;
      return d;
    }
    function fxAssetOverlay(key, cls, onFail) {
      var a = FX_ASSETS[key];
      if (!a || !a.url) return null;
      var d = fxOverlay(cls);
      var im = document.createElement('img');
      im.alt = '';
      im.draggable = false;
      im.decoding = 'async';
      im.referrerPolicy = 'no-referrer';
      im.style.objectFit = a.fit || 'contain';
      var pos = a.pos || 'center';
      if (a.anchor) {
        var t = String(a.anchor).toLowerCase();
        var h = t.indexOf('right') >= 0 ? 'right' : (t.indexOf('left') >= 0 ? 'left' : 'center');
        var v = t.indexOf('bottom') >= 0 ? 'bottom' : (t.indexOf('top') >= 0 ? 'top' : 'center');
        pos = h + ' ' + v;
        var size = (a.size > 0 ? a.size : 100) + '%';
        d.style.width = size; d.style.height = size;
        if (h === 'right') { d.style.left = 'auto'; d.style.right = '0'; }
        if (v === 'bottom') { d.style.top = 'auto'; d.style.bottom = '0'; }
      }
      im.style.objectPosition = pos;
      im.addEventListener('error', function () {
        var p = d.parentNode;
        if (p) p.removeChild(d);
        if (p && onFail) onFail(p);
      });
      im.src = a.url;
      d.appendChild(im);
      return d;
    }
    // hazmat suit drawn as SVG (no ids/defs, so it keeps working when old chat lines are pruned);
    // the face opening is a real hole, so the picture shows through the visor
    function fxHazmat() {
      var stripes = '';
      for (var x = -10; x < 100; x += 10) stripes += '<path d="M' + x + ' 100 L' + (x + 5) + ' 100 L' + (x + 10) + ' 92 L' + (x + 5) + ' 92Z" fill="#111"/>';
      var hole = 'M23 46 A27 33 0 1 0 77 46 A27 33 0 1 0 23 46Z';
      var svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%">' +
        '<path fill-rule="evenodd" fill="#f5c518" d="M0 0H100V100H0Z ' + hole + '"/>' +
        '<ellipse cx="50" cy="46" rx="32" ry="39" fill="none" stroke="#c99600" stroke-width="1.4" vector-effect="non-scaling-stroke"/>' +
        '<path d="M50 0V7M50 85V92" stroke="#c99600" stroke-width="1.4" vector-effect="non-scaling-stroke"/>' +
        '<path d="M6 8L12 92M94 8L88 92" stroke="#d9a800" stroke-width="1" fill="none" vector-effect="non-scaling-stroke"/>' +
        '<rect x="0" y="92" width="100" height="8" fill="#f5c518"/>' + stripes +
        '<path d="' + hole + '" fill="rgba(150,215,255,.16)" stroke="#fff4b8" stroke-width="2.4" vector-effect="non-scaling-stroke"/>' +
        '<path d="M36 24L45 20L30 54L25 48Z" fill="rgba(255,255,255,.28)"/>' +
        '</svg>';
      var d = fxOverlay('mee-v');
      d.innerHTML = svg;
      return d;
    }
    var FX_BUILD = {
      'mee-fx-sp': function (wrap, img) {
        var c = fxOverlay('mee-sp');
        c.title = 'Spoiler \u2014 click to reveal';
        var bar = document.createElement('span');
        bar.className = 'mee-sp-bar';
        bar.textContent = 'SPOILER';
        c.appendChild(bar);
        var fit = function () {
          var w = img.clientWidth || img.naturalWidth || 120;
          bar.style.fontSize = Math.max(8, Math.min(26, Math.round(w * 0.13))) + 'px';
        };
        fit();
        img.addEventListener('load', fit);
        return [c];
      },
      'mee-fx-jail': function () { return [fxOverlay('mee-jail')]; },
      'mee-fx-ree': function () {
        return [fxOverlay('mee-ree-red'),
                fxAssetOverlay('nuke', 'mee-ree-nuke') || fxOverlay('mee-ree-nuke'),
                fxOverlay('mee-ree-black')];
      },
      'mee-fx-cop': function () {
        // two lamps (red / blue) that take turns, in step with the picture's filter animation
        return ['r', 'b'].map(function (k) {
          var l = document.createElement('span');
          l.className = 'mee-cop-siren ' + k;
          l.textContent = '\uD83D\uDEA8';
          return l;
        });
      },
      'mee-fx-hap': function () { return [fxOverlay('mee-hap')]; },
      'mee-fx-gun': function () { return [fxAssetOverlay('gun', 'mee-gun')]; },
      'mee-fx-no': function () { return [fxAssetOverlay('no', 'mee-no')]; },
      'mee-fx-fine': function () { return [fxAssetOverlay('fine', 'mee-fine')]; },
      'mee-fx-msk': function () { return [fxOverlay('mee-msk')]; },
      'mee-fx-sad': function () { return [fxAssetOverlay('sad', 'mee-sad')]; },
      'mee-fx-cum': function () { return [fxAssetOverlay('cum', 'mee-cum')]; },
      'mee-fx-braz': function () { return [fxAssetOverlay('braz', 'mee-braz')]; },
      'mee-fx-v': function () {
        return [fxAssetOverlay('v', 'mee-v', function (parent) { parent.appendChild(fxHazmat()); }) || fxHazmat()];
      },
      'mee-fx-blkd': function () { return [fxAssetOverlay('blkd', 'mee-blkd')]; }
    };
    function wrapFxImages(el) {
      if (!el || !el.querySelectorAll) return;
      el.querySelectorAll('img.channel-image').forEach(function (img) {
        var keys = [];
        Array.prototype.forEach.call(img.classList, function (c) { if (FX_BUILD[c]) keys.push(c); });
        if (!keys.length) return;
        // horizontal slides use a full-width size container; overlays can't share it (the box would collapse)
        if (img.classList.contains('slide-right') || img.classList.contains('slide-left')) return;
        if (img.closest('span.mee-fx')) return;
        var target = img;
        while (target.parentElement && target.parentElement.classList.contains('mee-clip')) target = target.parentElement;
        var wrap = document.createElement('span');
        wrap.className = 'mee-fx ' + keys.join(' ');
        target.parentNode.insertBefore(wrap, target);
        wrap.appendChild(target);
        keys.forEach(function (k) {
          (FX_BUILD[k](wrap, img) || []).forEach(function (n) { if (n) wrap.appendChild(n); });
        });
      });
    }
    function bindFxEvents(buf) {
      // spoiler: click the black cover to reveal (and don't follow the surrounding link)
      buf.addEventListener('click', function (e) {
        var t = e.target && e.target.closest ? e.target.closest('.mee-ov.mee-sp') : null;
        if (!t) return;
        e.preventDefault(); e.stopPropagation();
        var w = t.closest('span.mee-fx');
        if (w) w.classList.add('mee-open');
      }, true);
      // mask: the invisible layer swallows the right-click / long-press menu
      buf.addEventListener('contextmenu', function (e) {
        if (e.target && e.target.closest && e.target.closest('.mee-ov.mee-msk')) e.preventDefault();
      }, true);
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
    function wrapClipImages(el) {
      if (!el || !el.querySelectorAll) return;
      el.querySelectorAll('img.slide-up, img.slide-down, img.peek_up').forEach(function (img) {
        if (img.parentElement && img.parentElement.classList.contains('mee-clip')) return;
        var wrap = document.createElement('span');
        wrap.className = 'mee-clip';
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
      wrapClipImages(node);
      wrapFxImages(node);
      if (CFG.videoPreview) VideoLinks.expand(node);
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
      bindFxEvents(buf);
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
    VideoLinks: VideoLinks
  };
})();
