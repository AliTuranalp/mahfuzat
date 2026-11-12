/* UI + storage. All pure logic lives in logic.js (window.VocabLogic). */
(function () {
  'use strict';

  var L = window.VocabLogic;
  var C = window.VocabContent;
  var STORAGE_KEY = 'lexis.v1';
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- state & storage ---------- */

  var state = load();

  function defaults() {
    return {
      goal: 'Speak English fluently',
      words: [],
      activity: [],
      listOrder: 'newest',
      studyMode: 'newest',
      unlearnedOnly: false,
      lastExportAt: null,
      wordsAtLastExport: 0
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return Object.assign(defaults(), JSON.parse(raw));
    } catch (e) { /* fall through to defaults */ }
    return defaults();
  }

  // Saved immediately on every change.
  var changeCount = 0;
  function save() {
    changeCount++;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { note('add-note', 'Could not save — storage is full or blocked.', 'warn'); }
    if (window.MahfuzatScheduleSync) window.MahfuzatScheduleSync();
  }

  function markActive() {
    state.activity = L.recordActivity(state.activity, new Date());
  }

  // Ask the browser not to evict our data (helps on iOS).
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});

  /* ---------- helpers ---------- */

  var noteTimers = {};
  function note(id, text, kind, ms) {
    var el = $(id);
    el.textContent = text;
    el.className = 'note' + (kind ? ' is-' + kind : '');
    clearTimeout(noteTimers[id]);
    if (ms !== 0) noteTimers[id] = setTimeout(function () { el.textContent = ''; }, ms || 2600);
  }

  function byId(id) {
    for (var i = 0; i < state.words.length; i++) if (state.words[i].id === id) return state.words[i];
    return null;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function checkSvg() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5');
    svg.appendChild(p);
    return svg;
  }

  function formatDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /* ---------- tabs ---------- */

  var currentTab = 'add';
  function showTab(name) {
    currentTab = name;
    document.querySelectorAll('.view').forEach(function (v) {
      v.classList.toggle('is-active', v.id === 'view-' + name);
    });
    document.querySelectorAll('.tab').forEach(function (t) {
      var on = t.dataset.tab === name;
      t.classList.toggle('is-active', on);
      if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    if (name === 'list') renderList();
    if (name === 'study' && !session) renderStudySetup();
    if (name === 'add') renderAdd();
    window.scrollTo(0, 0);
  }

  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () { showTab(t.dataset.tab); });
  });

  /* ---------- add ---------- */

  function renderStats() {
    var total = state.words.length;
    $('stat-total').textContent = total;
    $('stat-total-label').textContent = total === 1 ? 'word' : 'words';
    $('stat-learned').textContent = state.words.filter(function (w) { return w.learned; }).length;
    $('stat-streak').textContent = L.streak(state.activity, new Date());
  }

  function renderAdd() {
    renderStats();
    $('backup-nudge').hidden = !L.shouldRemindBackup(state, Date.now());
  }


  $('add-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var wordEl = $('add-word');
    var check = L.validateWord(state.words, wordEl.value);
    if (!check.ok) {
      if (check.reason === 'empty') note('add-note', 'Type a word first.', 'warn');
      else note('add-note', '“' + check.duplicate.word + '” is already in your list.', 'warn', 3200);
      wordEl.focus();
      return;
    }
    var before = state.words.length;
    var created = L.createWord(wordEl.value, $('add-meaning').value, $('add-example').value, Date.now());
    var trTyped = $('add-tr').value.trim();
    if (trTyped) created.tr = trTyped;
    if (liveSenses && liveSenses.word === created.word) created.senses = liveSenses.senses;
    liveSenses = null; $('add-more').hidden = true;
    state.words.push(created);
    markActive();
    save();

    resetAddFields();
    wordEl.value = '';
    wordEl.focus();
    var m = L.milestoneCrossed(before, state.words.length);
    if (m) note('add-note', C.milestones[m], 'milestone', 6000);
    else if (created.meaning && created.example) note('add-note', 'Saved.');
    else note('add-note', 'Saved. Looking up “' + created.word + '”…', null, 0);
    renderAdd();

    // Fill whatever is still empty (fast Save, or offline) and say what arrived.
    fillMissing(created.id).then(function (changed) {
      if (m) return;
      var w = byId(created.id);
      if (!w) return;
      if (changed) {
        var bits = [w.tr, w.meaning].filter(Boolean).join(' · ');
        note('add-note', '“' + w.word + '”: ' + bits, 'filled', 7000);
      } else if (!w.meaning || !w.example) {
        note('add-note', navigator.onLine === false
          ? 'Saved offline. The meaning will be added when you are back online.'
          : LK.lastError ? 'Saved. Dictionary not reachable (' + LK.lastError + '); it will be filled in later.'
          : 'Saved. No dictionary entry found for “' + w.word + '”.', null, 6000);
      } else {
        note('add-note', 'Saved.');
      }
    });
  });

  /* ---------- automatic meaning + example ---------- */

  var LK = window.VocabLookup;
  var autoFields = [$('add-tr'), $('add-meaning'), $('add-example')];
  var lookupTimer = null;

  // A field the user typed in belongs to the user; only empty or auto-filled fields get filled.
  function grow(f) { f.style.height = 'auto'; f.style.height = f.scrollHeight + 'px'; }
  autoFields.forEach(function (f) {
    f.addEventListener('input', function () { f.dataset.auto = f.value ? 'user' : ''; grow(f); });
    // Enter saves, like the word field (no line breaks in a meaning).
    f.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('add-form').requestSubmit(); }
    });
  });

  function setLookingUp(on) {
    autoFields.forEach(function (f) { f.placeholder = on ? 'Looking up…' : 'Optional'; });
  }

  function resetAddFields() {
    clearTimeout(lookupTimer);
    setLookingUp(false);
    autoFields.forEach(function (f) { f.value = ''; f.dataset.auto = ''; grow(f); });
  }

  var liveSenses = null;
  function renderAddMore() {
    var b = $('add-more');
    var ok = liveSenses && liveSenses.word === $('add-word').value.trim();
    b.hidden = !ok;
    if (ok) b.textContent = moreLabel(liveSenses.senses);
  }
  $('add-more').addEventListener('click', function () { if (liveSenses) openSenses(liveSenses.word, liveSenses.senses); });

  $('add-word').addEventListener('input', function (e) {
    var typed = e.target.value.trim();
    liveSenses = null; renderAddMore();
    clearTimeout(lookupTimer);
    autoFields.forEach(function (f) { if (f.dataset.auto === 'filled') { f.value = ''; f.dataset.auto = ''; grow(f); } });
    setLookingUp(false);
    if (typed.length < 2) return;
    lookupTimer = setTimeout(function () {
      var open = autoFields.filter(function (f) { return f.dataset.auto !== 'user'; });
      if (!open.length) return;
      setLookingUp(true);
      LK.lookup(typed).then(function (res) {
        if ($('add-word').value.trim() !== typed) return; // the word changed meanwhile
        setLookingUp(false);
        if (!res) {
          note('add-note', LK.lastError === 'offline' ? 'Offline. Save it now; the meaning is added when you are back online.'
            : LK.lastError ? 'Dictionary not reachable (' + LK.lastError + '). Save it now; it is filled in later.'
            : 'No dictionary entry for “' + typed + '”.', 'warn', 6000);
          return;
        }
        liveSenses = res.senses ? { word: typed, senses: res.senses } : null;
        renderAddMore();
        [[$('add-tr'), res.tr], [$('add-meaning'), res.meaning], [$('add-example'), res.example]].forEach(function (p) {
          if (p[0].dataset.auto !== 'user' && p[1]) { p[0].value = p[1]; p[0].dataset.auto = 'filled'; grow(p[0]); }
        });
      });
    }, 600);
  });

  function needsLookup(w) { return !w.meaning || !w.example || !w.tr || !w.senses; }

  // Fill a saved word's empty meaning/example/Turkish from the dictionary; user text is never replaced.
  function fillMissing(id) {
    var w = byId(id);
    if (!w || !needsLookup(w)) return Promise.resolve(false);
    return LK.lookup(w.word).then(function (res) {
      var cur = byId(id);
      if (!res || !cur) return false;
      var changed = false;
      if (!cur.meaning && res.meaning) { cur.meaning = res.meaning; changed = true; }
      if (!cur.example && res.example) { cur.example = res.example; changed = true; }
      if (!cur.tr && res.tr) { cur.tr = res.tr; changed = true; }
      if (!cur.senses && res.senses) { cur.senses = res.senses; changed = true; }
      if (changed) {
        save();
        if (currentTab === 'list') renderList();
      }
      return changed;
    });
  }

  // Words saved offline get filled the next time the app opens online (a few per launch).
  function backfill() {
    var RETRY = 6 * 3600e3; // a failed lookup is tried again after 6 hours, never given up for good
    var todo = state.words.filter(function (w) {
      return needsLookup(w) && (typeof w.lookupTried !== 'number' || Date.now() - w.lookupTried > RETRY);
    }).slice(0, 15);
    todo.reduce(function (p, w) {
      return p.then(function () {
        return fillMissing(w.id).then(function (ok) {
          var cur = byId(w.id);
          if (cur && needsLookup(cur) && navigator.onLine !== false) { cur.lookupTried = Date.now(); save(); }
        });
      });
    }, Promise.resolve());
  }
  if (navigator.onLine !== false) setTimeout(backfill, 1500);
  window.addEventListener('online', backfill);

  /* ---------- sync (private GitHub Gist) ---------- */

  var SY = window.VocabSync;
  var SYNC_KEY = 'mahfuzat.sync';
  var sync = (function () {
    try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch (e) { return {}; }
  }());
  var syncTimer = null, syncBusy = false, syncAgain = false;

  function saveSync() { try { localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); } catch (e) {} }

  function ago(ts) {
    var s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return formatDate(ts);
  }

  function renderSync() {
    var st = $('sync-status');
    if (!sync.token) { st.textContent = 'Off. Words stay on this device.'; st.className = 'sync-status'; $('sync-setup').textContent = 'Set up'; return; }
    $('sync-setup').textContent = 'Change';
    if (syncBusy) { st.textContent = 'Syncing…'; st.className = 'sync-status is-on'; return; }
    if (sync.error) { st.textContent = sync.error; st.className = 'sync-status is-error'; return; }
    st.textContent = sync.lastAt ? 'Synced ' + ago(sync.lastAt) + '.' : 'On. Waiting for first sync.';
    st.className = 'sync-status is-on';
  }

  function syncNow() {
    if (!sync.token) return Promise.resolve();
    if (navigator.onLine === false) { sync.error = 'Offline. Will sync when back online.'; renderSync(); return Promise.resolve(); }
    if (syncBusy) { syncAgain = true; return Promise.resolve(); }
    syncBusy = true; renderSync();
    var startedAt = changeCount;
    var payload = SY.prepare(state.words, sync.snapshot, Date.now());
    return SY.run({ token: sync.token, gistId: sync.gistId }, payload).then(function (res) {
      sync.gistId = res.gistId;
      if (changeCount !== startedAt) { saveSync(); syncAgain = true; return; } // edited meanwhile: send again
      var words = res.words;
      state.words = words;
      sync.snapshot = SY.snapshotOf(words);
      sync.lastAt = Date.now();
      sync.error = '';
      saveSync();
      setTimeout(backfill, 500);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
      if (currentTab === 'list') renderList();
      else if (currentTab === 'add') renderStats();
      else if (currentTab === 'study' && !session) renderStudySetup();
    }, function (err) {
      var m = String(err && err.message);
      sync.error = m === 'unauthorized' ? 'GitHub did not accept the token. Paste a new one.'
        : m === 'forbidden' ? 'The token cannot use gists. Make one with the "gist" box ticked.'
        : m === 'ratelimit' ? 'GitHub is busy. Will retry shortly.'
        : 'Could not reach GitHub. Will retry.';
      saveSync();
    }).then(function () {
      syncBusy = false; renderSync();
      if (syncAgain) { syncAgain = false; scheduleSync(800); }
    });
  }

  function scheduleSync(ms) {
    if (!sync.token) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, ms == null ? 2500 : ms);
  }
  window.MahfuzatScheduleSync = scheduleSync;

  document.addEventListener('visibilitychange', function () { if (!document.hidden) scheduleSync(300); });
  window.addEventListener('online', function () { scheduleSync(300); });
  setTimeout(function () { renderSync(); scheduleSync(600); }, 0);

  $('sync-setup').addEventListener('click', function () {
    $('sync-link').value = sync.token || '';
    $('sync-note').textContent = '';
    $('sync-off').hidden = !sync.token;
    $('sync-dialog').showModal();
  });
  document.querySelector('#sync-dialog [data-close]').addEventListener('click', function () { $('sync-dialog').close(); });
  $('sync-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var token = SY.parseToken($('sync-link').value);
    if (!token) { note('sync-note', 'That does not look like a GitHub token. It starts with ghp_ or github_pat_.', 'warn', 5000); return; }
    if (token !== sync.token) { sync.snapshot = {}; sync.lastAt = 0; sync.gistId = ''; } // first sync merges, never deletes
    sync.token = token;
    sync.error = '';
    saveSync();
    $('sync-dialog').close();
    syncNow();
  });
  $('sync-off').addEventListener('click', function () {
    sync = {};
    saveSync();
    $('sync-dialog').close();
    renderSync();
  });

  /* ---------- all meanings (dictionary view) ---------- */

  function senseCount(sv) {
    var n = 0;
    (sv.tr || []).forEach(function (g) { n += g.terms.length; });
    (sv.en || []).forEach(function (g) { n += g.defs.length; });
    return n;
  }
  function moreLabel(sv) { return 'All meanings (' + senseCount(sv) + ')'; }

  function openSenses(word, sv) {
    $('senses-word').textContent = word;
    var body = $('senses-body');
    body.textContent = '';
    if (sv.tr && sv.tr.length) {
      body.appendChild(el('h3', '', 'Türkçe'));
      sv.tr.forEach(function (g) {
        var h = el('p', 'k pos', g.pos); body.appendChild(h);
        var ul = el('ul', 'sense-terms');
        g.terms.forEach(function (t) { ul.appendChild(el('li', '', t)); });
        body.appendChild(ul);
      });
    }
    if (sv.en && sv.en.length) {
      body.appendChild(el('h3', '', 'English'));
      sv.en.forEach(function (g) {
        body.appendChild(el('p', 'k pos', g.pos));
        var ol = el('ol', 'sense-defs');
        g.defs.forEach(function (d) {
          var li = el('li', '', d.gloss);
          if (d.example) li.appendChild(el('span', 'ex', d.example));
          ol.appendChild(li);
        });
        body.appendChild(ol);
      });
    }
    $('senses-dialog').showModal();
    $('senses-dialog').scrollTop = 0;
  }

  /* ---------- my own sentences ---------- */

  function xSvg() {
    var ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), p = document.createElementNS(ns, 'path');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    p.setAttribute('d', 'M6 6l12 12M18 6L6 18'); svg.appendChild(p);
    return svg;
  }

  // Renders the "My sentences" block for word w into container (list detail or study card back).
  function renderMine(box, w) {
    box.textContent = '';
    box.appendChild(el('span', 'k', 'My sentences'));
    var ul = el('ul', 'mine-list');
    (w.mine || []).forEach(function (m) {
      var li = el('li');
      li.appendChild(el('span', '', m.text));
      var x = el('button', 'mine-del'); x.type = 'button';
      x.setAttribute('aria-label', 'Delete this sentence'); x.appendChild(xSvg());
      x.addEventListener('click', function (e) {
        e.stopPropagation();
        var cur = byId(w.id); if (!cur) return;
        cur.mine = (cur.mine || []).filter(function (y) { return y.id !== m.id; });
        if (!cur.mine.length) delete cur.mine;
        save(); renderMine(box, cur);
      });
      li.appendChild(x);
      ul.appendChild(li);
    });
    if (ul.children.length) box.appendChild(ul);
    var row = el('div', 'mine-add');
    var inp = el('input'); inp.type = 'text'; inp.placeholder = 'Write a sentence with “' + w.word + '”';
    inp.setAttribute('enterkeyhint', 'done'); inp.setAttribute('aria-label', 'Your sentence');
    var add = el('button', '', 'Add'); add.type = 'button';
    function commit() {
      var text = inp.value.trim().replace(/\s+/g, ' ');
      if (!text) { inp.focus(); return; }
      var cur = byId(w.id); if (!cur) return;
      cur.mine = (cur.mine || []).concat([{ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: text, at: Date.now() }]);
      markActive(); save(); renderMine(box, cur);
      var again = box.querySelector('.mine-add input'); if (again) again.focus();
    }
    add.addEventListener('click', function (e) { e.stopPropagation(); commit(); });
    inp.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); commit(); }
    });
    inp.addEventListener('click', function (e) { e.stopPropagation(); });
    row.appendChild(inp); row.appendChild(add);
    box.appendChild(row);
  }

  /* ---------- list ---------- */

  var openId = null;

  function renderList() {
    var list = $('word-list');
    var query = $('search').value;
    var items = L.searchWords(L.sortWords(state.words, state.listOrder), query);

    $('list-count').textContent = state.words.length;
    $('sort-toggle').textContent = state.listOrder === 'newest' ? 'Newest first' : 'Oldest first';
    list.textContent = '';

    items.forEach(function (w) {
      var li = el('li', 'word-item' + (w.id === openId ? ' is-open' : ''));
      li.dataset.id = w.id;

      var row = el('div', 'word-row');
      var main = el('button', 'word-main');
      main.type = 'button';
      main.dataset.action = 'toggle';
      main.setAttribute('aria-expanded', w.id === openId ? 'true' : 'false');
      main.appendChild(el('span', 'word-title', w.word));
      if (w.meaning) main.appendChild(el('span', 'word-sub', w.meaning));

      var chk = el('button', 'check');
      chk.type = 'button';
      chk.dataset.action = 'learned';
      chk.setAttribute('aria-pressed', w.learned ? 'true' : 'false');
      chk.setAttribute('aria-label', w.learned ? 'Learned — tap to unmark' : 'Mark as learned');
      chk.appendChild(checkSvg());

      row.appendChild(main);
      row.appendChild(chk);
      li.appendChild(row);

      if (w.id === openId) {
        var d = el('div', 'word-detail');
        if (w.tr) d.appendChild(el('p', 'word-tr', w.tr));
        if (w.example) d.appendChild(el('p', 'word-example', w.example));
        if (w.senses) {
          var mb = el('button', 'more-btn', moreLabel(w.senses)); mb.type = 'button'; mb.dataset.action = 'senses';
          d.appendChild(mb);
        }
        var mw = el('div', 'mine-wrap'); renderMine(mw, w); d.appendChild(mw);
        d.appendChild(el('p', 'word-date', 'Added ' + formatDate(w.createdAt)));
        var acts = el('div', 'word-actions');
        var ed = el('button', '', 'Edit'); ed.type = 'button'; ed.dataset.action = 'edit';
        var del = el('button', 'del', 'Delete'); del.type = 'button'; del.dataset.action = 'delete';
        acts.appendChild(ed); acts.appendChild(del);
        d.appendChild(acts);
        li.appendChild(d);
      }
      list.appendChild(li);
    });

    var empty = $('list-empty');
    empty.hidden = items.length > 0;
    empty.textContent = state.words.length ? 'Nothing matches “' + query.trim() + '”.' : 'Your words will gather here.';

    $('backup-meta').textContent = state.lastExportAt
      ? 'Last export ' + formatDate(state.lastExportAt) + '.'
      : 'Not exported yet. Your words live only on this device.';
  }

  $('search').addEventListener('input', renderList);

  $('sort-toggle').addEventListener('click', function () {
    state.listOrder = state.listOrder === 'newest' ? 'oldest' : 'newest';
    save();
    renderList();
  });

  $('word-list').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var id = btn.closest('.word-item').dataset.id;
    var w = byId(id);
    if (!w) return;

    switch (btn.dataset.action) {
      case 'senses':
        openSenses(w.word, w.senses);
        break;
      case 'toggle':
        openId = openId === id ? null : id;
        renderList();
        break;
      case 'learned':
        w.learned = !w.learned;
        markActive();
        save();
        renderList();
        break;
      case 'edit':
        openEdit(w);
        break;
      case 'delete':
        confirmAction('Delete “' + w.word + '”? This cannot be undone.', function () {
          state.words = state.words.filter(function (x) { return x.id !== id; });
          openId = null;
          save();
          renderList();
        });
        break;
    }
  });

  /* ---------- edit & confirm sheets ---------- */

  var editingId = null;

  function openEdit(w) {
    editingId = w.id;
    $('edit-word').value = w.word;
    $('edit-tr').value = w.tr || '';
    $('edit-meaning').value = w.meaning;
    $('edit-example').value = w.example;
    $('edit-note').textContent = '';
    $('edit-dialog').showModal();
  }

  $('edit-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var w = byId(editingId);
    if (!w) { $('edit-dialog').close(); return; }
    var check = L.validateWord(state.words, $('edit-word').value, w.id);
    if (!check.ok) {
      note('edit-note', check.reason === 'empty' ? 'The word cannot be empty.'
        : '“' + check.duplicate.word + '” is already in your list.', 'warn', 3200);
      return;
    }
    var newWord = $('edit-word').value.trim().replace(/\s+/g, ' ');
    var renamed = newWord !== w.word;
    w.word = newWord;
    w.meaning = $('edit-meaning').value.trim();
    w.example = $('edit-example').value.trim();
    var trEdit = $('edit-tr').value.trim();
    var oldTr = w.tr || '';
    if (renamed && trEdit === oldTr) trEdit = ''; // renamed but Turkish untouched: it belonged to the old word
    if (trEdit) w.tr = trEdit; else delete w.tr;
    if (renamed) delete w.lookupTried;
    save();
    $('edit-dialog').close();
    renderList();
    if (renamed) fillMissing(w.id);
  });

  document.querySelector('#edit-dialog [data-close]').addEventListener('click', function () {
    $('edit-dialog').close();
  });

  // The callback runs on the Delete tap itself, so a stale close event can never swallow it.
  var confirmCb = null;
  function confirmAction(text, cb) {
    confirmCb = cb;
    $('confirm-text').textContent = text;
    $('confirm-dialog').showModal();
  }
  $('confirm-ok').addEventListener('click', function (e) {
    e.preventDefault();
    var cb = confirmCb;
    confirmCb = null;
    $('confirm-dialog').close('ok');
    if (cb) cb();
  });

  // Tap on the dim backdrop closes a sheet.
  document.querySelectorAll('dialog').forEach(function (d) {
    d.addEventListener('click', function (e) { if (e.target === d) d.close('cancel'); });
  });

  /* ---------- backup ---------- */

  function exportBackup() {
    var data = JSON.stringify(L.exportData(state, Date.now()), null, 2);
    var name = 'mahfuzat-backup-' + L.dayKey(new Date()) + '.json';
    var done = function () {
      state.lastExportAt = Date.now();
      state.wordsAtLastExport = state.words.length;
      save();
      renderAdd();
      if (currentTab === 'list') renderList();
    };

    // iPhone: the share sheet lets you "Save to Files". Desktop: plain download.
    var file;
    try { file = new File([data], name, { type: 'application/json' }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
      navigator.share({ files: [file], title: name }).then(done).catch(function () { /* cancelled */ });
      return;
    }
    var url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    done();
  }

  function importBackup(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var msg;
      try {
        var res = L.mergeImport(state.words, JSON.parse(reader.result), Date.now());
        state.words = res.words;
        save();
        msg = res.added + ' added, ' + res.skipped + ' already here' + (res.invalid ? ', ' + res.invalid + ' unreadable' : '') + '.';
      } catch (e) {
        msg = 'Could not read that file. ' + (e && e.message && e.message.indexOf('vocabulary') !== -1 ? e.message : 'Is it a JSON backup?');
      }
      renderList();
      $('backup-meta').textContent = msg;
    };
    reader.readAsText(file);
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-action="export"], [data-action="import"]');
    if (!b) return;
    if (b.dataset.action === 'export') exportBackup();
    else $('import-file').click();
  });

  $('import-file').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    if (f) importBackup(f);
    e.target.value = '';
  });

  /* ---------- study ---------- */

  var session = null; // { deck: [ids], index }

  function renderStudySetup() {
    $('study-setup').hidden = false;
    $('study-session').hidden = true;
    $('study-done').hidden = true;

    document.querySelectorAll('.segmented [data-mode]').forEach(function (b) {
      b.setAttribute('aria-checked', b.dataset.mode === state.studyMode ? 'true' : 'false');
    });
    $('unlearned-only').checked = !!state.unlearnedOnly;

    var n = L.buildDeck(state.words, 'newest', state.unlearnedOnly).length;
    $('deck-size').textContent = n === 0
      ? (state.words.length ? 'Every word is learned. Beautiful.' : 'Add a few words first.')
      : n + (n === 1 ? ' card' : ' cards');
    $('study-start').disabled = n === 0;
    $('study-start').style.opacity = n === 0 ? .35 : '';
  }

  document.querySelectorAll('.segmented [data-mode]').forEach(function (b) {
    b.addEventListener('click', function () { state.studyMode = b.dataset.mode; save(); renderStudySetup(); });
  });
  $('unlearned-only').addEventListener('change', function (e) {
    state.unlearnedOnly = e.target.checked; save(); renderStudySetup();
  });

  $('study-start').addEventListener('click', startSession);
  $('study-again').addEventListener('click', startSession);
  $('study-close').addEventListener('click', function () { session = null; renderStudySetup(); });

  function startSession() {
    var deck = L.buildDeck(state.words, state.studyMode, state.unlearnedOnly);
    if (!deck.length) { session = null; renderStudySetup(); return; }
    session = { deck: deck, index: 0 };
    markActive();
    save();
    $('study-setup').hidden = true;
    $('study-done').hidden = true;
    $('study-session').hidden = false;
    renderCard();
  }

  function renderCard() {
    var w = byId(session.deck[session.index]);
    if (!w) { // deleted mid-session
      session.deck.splice(session.index, 1);
      if (!session.deck.length) { session = null; renderStudySetup(); return; }
      if (session.index >= session.deck.length) session.index = session.deck.length - 1;
      return renderCard();
    }
    var card = $('card');
    card.classList.remove('is-flipped');
    $('card-word').textContent = w.word;
    $('card-word-small').textContent = w.word;
    $('card-meaning').textContent = w.meaning;
    $('card-example').textContent = w.example;
    $('card-tr').textContent = w.tr || '';
    $('card-more').hidden = !w.senses;
    if (w.senses) $('card-more').textContent = moreLabel(w.senses);
    renderMine($('card-mine'), w);
    card.querySelector('.card-back').scrollTop = 0;
    card.querySelector('.card-back').classList.toggle('is-bare', !w.meaning && !w.example);

    var total = session.deck.length, pos = session.index + 1;
    $('study-counter').textContent = pos + ' / ' + total;
    $('study-progress').style.width = (pos / total * 100) + '%';
    $('study-prev').disabled = session.index === 0;
    $('card-more').addEventListener('click', function () {
    var w = session && byId(session.deck[session.index]);
    if (w && w.senses) openSenses(w.word, w.senses);
  });

  $('study-learned').setAttribute('aria-pressed', w.learned ? 'true' : 'false');
  }

  function flip() { $('card').classList.toggle('is-flipped'); }

  function next() {
    if (!session) return;
    if (session.index < session.deck.length - 1) { session.index++; renderCard(); }
    else finishSession();
  }
  function prev() {
    if (session && session.index > 0) { session.index--; renderCard(); }
  }

  function finishSession() {
    var n = session.deck.length;
    session = null;
    $('study-session').hidden = true;
    $('study-done').hidden = false;
    $('done-sub').textContent = n + (n === 1 ? ' card' : ' cards') + ' reviewed.';
    var mark = $('done-mark');
    mark.classList.remove('pulse');
    void mark.offsetWidth; // restart animation
    mark.classList.add('pulse');
  }

  $('study-next').addEventListener('click', next);
  $('study-prev').addEventListener('click', prev);
  $('study-learned').addEventListener('click', function () {
    var w = session && byId(session.deck[session.index]);
    if (!w) return;
    w.learned = !w.learned;
    markActive();
    save();
    $('study-learned').setAttribute('aria-pressed', w.learned ? 'true' : 'false');
  });

  // Tap to flip, swipe left = next, swipe right = previous.
  (function () {
    var card = $('card'), x0 = null, y0 = null, moved = false;
    var INTERACTIVE = 'button, input, textarea, .mine-wrap';
    card.addEventListener('pointerdown', function (e) {
      if (e.target.closest(INTERACTIVE)) { x0 = null; return; } // buttons and typing on the back don't flip
      x0 = e.clientX; y0 = e.clientY; moved = false;
    });
    card.addEventListener('pointermove', function (e) {
      if (x0 !== null && Math.abs(e.clientX - x0) > 10) moved = true;
    });
    card.addEventListener('pointerup', function (e) {
      if (x0 === null) return;
      var dx = e.clientX - x0, dy = e.clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) { dx < 0 ? next() : prev(); return; }
      if (!moved) flip();
    });
    card.addEventListener('pointercancel', function () { x0 = null; });
    card.addEventListener('keydown', function (e) {
      if (e.target.closest(INTERACTIVE)) return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
    });
    document.addEventListener('keydown', function (e) {
      if (!session || currentTab !== 'study' || document.querySelector('dialog[open]')) return;
      if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') prev();
    });
  })();

  /* ---------- boot ---------- */

  renderAdd();

  // New day while the app stays open → refresh quote and streak.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && currentTab === 'add') renderAdd();
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
