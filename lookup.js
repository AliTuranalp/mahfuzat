/* Dictionary lookup: fills a word's meaning and an example sentence.
   Source: Google Translate's free web endpoint (no key, allows calls from the browser).
   It is unofficial, so every caller treats "no answer" as normal: the word is still saved. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VocabLookup = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ENDPOINT = 'https://translate.googleapis.com/translate_a/single' +
    '?client=gtx&sl=en&tl=tr&hl=en&dt=t&dt=bd&dt=md&dt=ex&dj=1&q=';

  function clean(s) {
    return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }

  function sentence(s) {
    s = clean(s);
    if (!s) return '';
    s = s.charAt(0).toUpperCase() + s.slice(1);
    return /[.!?…"”]$/.test(s) ? s : s + '.';
  }

  // Pure: Google response JSON -> { meaning, example, tr } or null. tr = Turkish translation.
  function parse(data, word) {
    if (!data || typeof data !== 'object') return null;
    var meaning = '', example = '', tr = '';
    var sents = data.sentences || [];
    if (sents.length && sents[0].trans) {
      tr = clean(sents[0].trans);
      if (word && tr.toLowerCase() === clean(word).toLowerCase()) tr = ''; // untranslated echo
    }
    var groups = data.definitions || [];
    for (var g = 0; g < groups.length && !meaning; g++) {
      var entries = groups[g].entry || [];
      for (var e = 0; e < entries.length; e++) {
        if (entries[e].gloss) {
          meaning = sentence(entries[e].gloss);
          if (entries[e].example) example = sentence(entries[e].example);
          break;
        }
      }
    }
    if (!example) {
      var ex = (data.examples && data.examples.example) || [];
      if (ex.length) example = sentence(ex[0].text);
    }
    // Every sense, like a dictionary page: Turkish equivalents and English definitions by part of speech.
    var senses = { tr: [], en: [] };
    (data.dict || []).forEach(function (b) {
      var terms = (b.terms || []).map(clean).filter(Boolean).slice(0, 15);
      if (terms.length) senses.tr.push({ pos: clean(b.pos), terms: terms });
    });
    groups.forEach(function (g) {
      var defs = (g.entry || []).filter(function (x) { return x.gloss; }).slice(0, 8).map(function (x) {
        var d = { gloss: sentence(x.gloss) };
        if (x.example) d.example = sentence(x.example);
        return d;
      });
      if (defs.length) senses.en.push({ pos: clean(g.pos), defs: defs });
    });
    if (!tr && senses.tr.length) tr = senses.tr[0].terms[0];
    if (!meaning && !example && !tr) return null;
    var out = { meaning: meaning, example: example, tr: tr };
    if (senses.tr.length || senses.en.length) out.senses = senses;
    return out;
  }

  function getJSON(url, ms) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, ms) : null;
    return fetch(url, ctrl ? { signal: ctrl.signal, cache: 'no-store' } : { cache: 'no-store' })
      .then(function (r) {
        if (timer) clearTimeout(timer);
        if (r.status === 404) return null;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }, function (e) {
        if (timer) clearTimeout(timer);
        throw new Error(e && e.name === 'AbortError' ? 'timeout' : 'network');
      });
  }

  // Backup when Google fails: English senses from dictionaryapi.dev, Turkish from MyMemory.
  function parseBackup(dict, mem, word) {
    var senses = { tr: [], en: [] }, meaning = '', example = '', tr = '';
    (Array.isArray(dict) ? dict : []).forEach(function (entry) {
      (entry.meanings || []).forEach(function (m) {
        var defs = (m.definitions || []).filter(function (d) { return d.definition; }).slice(0, 8).map(function (d) {
          var o = { gloss: sentence(d.definition) };
          if (d.example) o.example = sentence(d.example);
          return o;
        });
        if (defs.length) senses.en.push({ pos: clean(m.partOfSpeech), defs: defs });
      });
    });
    senses.en.forEach(function (g) {
      g.defs.forEach(function (d) {
        if (!meaning) meaning = d.gloss;
        if (!example && d.example) example = d.example;
      });
    });
    var t = mem && mem.responseData && clean(mem.responseData.translatedText).replace(/[.!?]+$/, '');
    if (t && t.toLowerCase() !== clean(word).toLowerCase() && !/MYMEMORY|INVALID|QUERY/i.test(t)) {
      tr = t.charAt(0).toLowerCase() + t.slice(1);
      senses.tr.push({ pos: '', terms: [tr] });
    }
    if (!meaning && !example && !tr) return null;
    var out = { meaning: meaning, example: example, tr: tr, source: 'backup' };
    if (senses.en.length) out.senses = senses;
    return out;
  }

  var api = { parse: parse, parseBackup: parseBackup, lastError: '' };

  // Resolves to { meaning, example, tr, senses } or null. Google first (tried twice), then the backups.
  // On failure api.lastError says why ('' = the word simply was not found).
  function lookup(word) {
    word = clean(word);
    api.lastError = '';
    if (!word || typeof fetch !== 'function') return Promise.resolve(null);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { api.lastError = 'offline'; return Promise.resolve(null); }
    var errs = [];
    function google() {
      return getJSON(ENDPOINT + encodeURIComponent(word), 8000)
        .then(function (d) { return parse(d, word); }, function (e) { errs.push('Google ' + e.message); return undefined; });
    }
    return google()
      .then(function (r) { return r === undefined ? new Promise(function (ok) { setTimeout(ok, 700); }).then(google) : r; })
      .then(function (r) {
        if (r) return r;
        return Promise.all([
          getJSON('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word), 8000).catch(function (e) { errs.push('dictionary ' + e.message); return null; }),
          getJSON('https://api.mymemory.translated.net/get?langpair=en%7Ctr&q=' + encodeURIComponent(word), 8000).catch(function (e) { errs.push('translation ' + e.message); return null; })
        ]).then(function (b) {
          var res = parseBackup(b[0], b[1], word);
          if (!res && errs.length) api.lastError = errs.join(', ');
          return res;
        });
      });
  }
  api.lookup = lookup;

  return api;
}));
