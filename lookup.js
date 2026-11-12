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

  // Resolves to { meaning, example, tr } or null (not found, offline, or the service failed).
  function lookup(word) {
    word = clean(word);
    if (!word || typeof fetch !== 'function') return Promise.resolve(null);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(null);
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 7000) : null;
    return fetch(ENDPOINT + encodeURIComponent(word), ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { return parse(data, word); })
      .catch(function () { return null; })
      .then(function (res) { if (timer) clearTimeout(timer); return res; });
  }

  return { parse: parse, lookup: lookup };
}));
