/*
 * Pure logic for the vocabulary app — no DOM, no storage.
 * Loaded in the browser as window.VocabLogic and in Node (tests) via require().
 */
(function (root) {
  'use strict';

  var MILESTONES = [10, 50, 100, 250, 500, 1000];
  var DAY_MS = 24 * 60 * 60 * 1000;

  /* ---------- words ---------- */

  // "  Serendipity " and "serendipity" are the same word.
  function normalize(text) {
    return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function makeId(now) {
    return now.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function createWord(word, meaning, example, now) {
    now = now || Date.now();
    return {
      id: makeId(now),
      word: String(word).trim().replace(/\s+/g, ' '),
      meaning: String(meaning || '').trim(),
      example: String(example || '').trim(),
      createdAt: now,
      learned: false
    };
  }

  // Returns the existing word object if `text` is already saved (ignoring case/spacing).
  function findDuplicate(words, text, exceptId) {
    var key = normalize(text);
    if (!key) return null;
    for (var i = 0; i < words.length; i++) {
      if (words[i].id !== exceptId && normalize(words[i].word) === key) return words[i];
    }
    return null;
  }

  // Validates input for add/edit. Returns { ok, reason, duplicate }.
  function validateWord(words, text, exceptId) {
    if (!normalize(text)) return { ok: false, reason: 'empty' };
    var dup = findDuplicate(words, text, exceptId);
    if (dup) return { ok: false, reason: 'duplicate', duplicate: dup };
    return { ok: true };
  }

  // order: 'newest' (default) or 'oldest'. Ties broken by id so ordering is stable.
  function sortWords(words, order) {
    var dir = order === 'oldest' ? 1 : -1;
    return words.slice().sort(function (a, b) {
      if (a.createdAt !== b.createdAt) return (a.createdAt - b.createdAt) * dir;
      return (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * dir;
    });
  }

  function searchWords(words, query) {
    var q = normalize(query);
    if (!q) return words.slice();
    return words.filter(function (w) {
      return normalize(w.word).indexOf(q) !== -1 ||
        normalize(w.meaning).indexOf(q) !== -1 ||
        normalize(w.example).indexOf(q) !== -1;
    });
  }

  /* ---------- study deck ---------- */

  // Fisher–Yates; rng injectable for tests.
  function shuffle(list, rng) {
    rng = rng || Math.random;
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // mode: 'newest' | 'random'. Returns an ordered array of word ids.
  // The deck is fixed for the session, so walking it front-to-back never repeats a card.
  function buildDeck(words, mode, unlearnedOnly, rng) {
    var pool = unlearnedOnly ? words.filter(function (w) { return !w.learned; }) : words;
    var ordered = mode === 'random' ? shuffle(pool, rng) : sortWords(pool, 'newest');
    return ordered.map(function (w) { return w.id; });
  }

  /* ---------- backup ---------- */

  function exportData(state, now) {
    return {
      app: 'vocab',
      version: 1,
      exportedAt: new Date(now || Date.now()).toISOString(),
      goal: state.goal,
      words: state.words
    };
  }

  // Accepts our export format or a bare array. Returns { words, added, skipped, invalid }.
  // Never overwrites an existing word; a duplicate only upgrades `learned` to true.
  function mergeImport(existing, data, now) {
    var incoming = Array.isArray(data) ? data : (data && Array.isArray(data.words) ? data.words : null);
    if (!incoming) throw new Error('This file does not look like a vocabulary backup.');

    now = now || Date.now();
    var result = existing.map(function (w) { return Object.assign({}, w); });
    var byKey = {};
    result.forEach(function (w) { byKey[normalize(w.word)] = w; });

    var added = 0, skipped = 0, invalid = 0;
    incoming.forEach(function (raw, i) {
      if (!raw || typeof raw.word !== 'string' || !normalize(raw.word)) { invalid++; return; }
      var key = normalize(raw.word);
      var hit = byKey[key];
      if (hit) {
        if (raw.learned === true) hit.learned = true;
        if (!hit.tr && typeof raw.tr === 'string' && raw.tr.trim()) hit.tr = raw.tr.trim();
        skipped++;
        return;
      }
      var createdAt = Number(raw.createdAt);
      if (!isFinite(createdAt) || createdAt <= 0) createdAt = now - (incoming.length - i); // keep file order
      var w = {
        id: typeof raw.id === 'string' && raw.id ? raw.id : makeId(createdAt) + i,
        word: String(raw.word).trim().replace(/\s+/g, ' '),
        meaning: String(raw.meaning || '').trim(),
        example: String(raw.example || '').trim(),
        createdAt: createdAt,
        learned: raw.learned === true
      };
      if (typeof raw.tr === 'string' && raw.tr.trim()) w.tr = raw.tr.trim();
      // Guard against an id clash with a different word.
      if (result.some(function (x) { return x.id === w.id; })) w.id = makeId(createdAt) + 'i' + i;
      result.push(w);
      byKey[key] = w;
      added++;
    });
    return { words: result, added: added, skipped: skipped, invalid: invalid };
  }

  /* ---------- streak & dates ---------- */

  // Local calendar day, e.g. "2026-11-10".
  function dayKey(date) {
    var d = date instanceof Date ? date : new Date(date);
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  function prevDay(key) {
    var p = key.split('-').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]); // local midnight; setDate handles month/DST edges
    d.setDate(d.getDate() - 1);
    return dayKey(d);
  }

  // Consecutive active days ending today — or yesterday, so the streak
  // survives until you skip a whole day.
  function streak(activeDays, today) {
    var set = {};
    (activeDays || []).forEach(function (k) { set[k] = true; });
    var cursor = dayKey(today || new Date());
    if (!set[cursor]) cursor = prevDay(cursor);
    var n = 0;
    while (set[cursor]) { n++; cursor = prevDay(cursor); }
    return n;
  }

  // Keeps the activity list small: unique, sorted, last 400 days.
  function recordActivity(activeDays, today) {
    var key = dayKey(today || new Date());
    var list = (activeDays || []).slice();
    if (list.indexOf(key) === -1) list.push(key);
    list.sort();
    return list.slice(-400);
  }

  /* ---------- motivation ---------- */

  // Returns the milestone crossed when going from prev to next words, or null.
  function milestoneCrossed(prevCount, nextCount) {
    for (var i = MILESTONES.length - 1; i >= 0; i--) {
      if (prevCount < MILESTONES[i] && nextCount >= MILESTONES[i]) return MILESTONES[i];
    }
    return null;
  }

  // Same quote all day, a new one tomorrow.
  function dailyIndex(date, length) {
    var d = date instanceof Date ? date : new Date(date);
    var days = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
    return ((days % length) + length) % length;
  }

  // Gentle backup nudge: 10+ words, and either never exported or
  // 14+ days and 5+ new words since the last export.
  function shouldRemindBackup(state, now) {
    now = now || Date.now();
    var count = state.words.length;
    if (count < 10) return false;
    if (!state.lastExportAt) return true;
    var since = count - (state.wordsAtLastExport || 0);
    return now - state.lastExportAt >= 14 * DAY_MS && since >= 5;
  }

  var api = {
    MILESTONES: MILESTONES,
    normalize: normalize,
    createWord: createWord,
    findDuplicate: findDuplicate,
    validateWord: validateWord,
    sortWords: sortWords,
    searchWords: searchWords,
    shuffle: shuffle,
    buildDeck: buildDeck,
    exportData: exportData,
    mergeImport: mergeImport,
    dayKey: dayKey,
    prevDay: prevDay,
    streak: streak,
    recordActivity: recordActivity,
    milestoneCrossed: milestoneCrossed,
    dailyIndex: dailyIndex,
    shouldRemindBackup: shouldRemindBackup
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VocabLogic = api;
})(this);
