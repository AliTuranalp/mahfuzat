/* Sync through a private (secret) GitHub Gist that holds one file, mahfuzat-words.json.
   Each device: download the file, merge it with local words (newest edit wins), upload the result.
   Pure helpers are exported for tests; `run` does the network calls. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VocabSync = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var API = 'https://api.github.com';
  var FILE = 'mahfuzat-words.json';
  var TOMBSTONE_DAYS = 120; // deletions are remembered this long so every device hears about them

  // What counts as "the word changed" between syncs.
  function sig(w) {
    return JSON.stringify([w.word, w.meaning || '', w.example || '', w.tr || '', !!w.learned, w.senses ? 1 : 0, (w.mine || []).map(function (m) { return m.id; }).join(',')]);
  }

  // A GitHub personal access token (classic ghp_… or fine-grained github_pat_…).
  function parseToken(text) {
    var s = String(text || '').trim();
    return /^(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})$/.test(s) ? s : null;
  }

  // Stamp changed words, list deletions. snapshot = { id: sig } from the last successful sync.
  function prepare(words, snapshot, now) {
    snapshot = snapshot || {};
    var present = {};
    var out = words.map(function (w) {
      present[w.id] = true;
      var c = Object.assign({}, w);
      if (snapshot[w.id] !== sig(w) || !c.updatedAt) c.updatedAt = now;
      delete c.lookupTried;
      return c;
    });
    var deleted = Object.keys(snapshot)
      .filter(function (id) { return !present[id]; })
      .map(function (id) { return { id: id, updatedAt: now }; });
    return { words: out, deleted: deleted };
  }

  function snapshotOf(words) {
    var s = {};
    words.forEach(function (w) { s[w.id] = sig(w); });
    return s;
  }

  function norm(s) { return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase(); }

  // stored: rows from the gist (may include {deleted:true} tombstones).
  // Newest edit wins per id. The same word added on two devices becomes one row:
  // empty fields are filled from the other copy and "learned" sticks.
  function mergeAll(stored, incoming, deleted) {
    var byId = {}, byWord = {};
    stored.forEach(function (r) {
      if (!r || !r.id) return;
      var c = Object.assign({}, r);
      byId[c.id] = c;
      if (!c.deleted) byWord[norm(c.word)] = c;
    });

    incoming.forEach(function (w) {
      if (!w || !w.id || !norm(w.word)) return;
      var inc = {
        id: String(w.id), word: String(w.word).trim(), meaning: String(w.meaning || ''), example: String(w.example || ''),
        learned: w.learned === true, createdAt: Number(w.createdAt) || Date.now(), updatedAt: Number(w.updatedAt) || 0
      };
      if (w.tr) inc.tr = String(w.tr);
      if (w.senses && typeof w.senses === 'object') inc.senses = w.senses;
      if (Array.isArray(w.mine) && w.mine.length) inc.mine = w.mine;
      var cur = byId[inc.id];
      if (cur) {
        if (inc.updatedAt > (cur.updatedAt || 0)) {
          if (byWord[norm(cur.word)] === cur) delete byWord[norm(cur.word)];
          byId[inc.id] = inc;
          if (!byWord[norm(inc.word)]) byWord[norm(inc.word)] = inc;
        }
        return;
      }
      var twin = byWord[norm(inc.word)];
      if (twin) {
        ['meaning', 'example', 'tr', 'senses'].forEach(function (f) { if (!twin[f] && inc[f]) twin[f] = inc[f]; });
        if (inc.learned) twin.learned = true;
        if (inc.mine) {
          var seen = {}; (twin.mine || []).forEach(function (m) { seen[m.id] = 1; });
          twin.mine = (twin.mine || []).concat(inc.mine.filter(function (m) { return !seen[m.id]; }));
        }
        twin.createdAt = Math.min(twin.createdAt || inc.createdAt, inc.createdAt);
        twin.updatedAt = Math.max(twin.updatedAt || 0, inc.updatedAt);
        return;
      }
      byId[inc.id] = inc;
      byWord[norm(inc.word)] = inc;
    });

    deleted.forEach(function (d) {
      var cur = d && byId[d.id];
      if (cur && !cur.deleted && (Number(d.updatedAt) || 0) >= (cur.updatedAt || 0)) {
        if (byWord[norm(cur.word)] === cur) delete byWord[norm(cur.word)];
        byId[d.id] = { id: cur.id, word: cur.word, deleted: true, updatedAt: Number(d.updatedAt) || cur.updatedAt };
      }
    });

    return Object.keys(byId).map(function (k) { return byId[k]; });
  }

  function live(rows) { return rows.filter(function (r) { return !r.deleted; }); }

  function prune(rows, now) {
    var limit = now - TOMBSTONE_DAYS * 864e5;
    return rows.filter(function (r) { return !r.deleted || (r.updatedAt || 0) > limit; });
  }

  /* ---------- network ---------- */

  function gh(token, path, opts) {
    opts = opts || {};
    return fetch(API + path, {
      method: opts.method || 'GET',
      cache: 'no-store',
      headers: Object.assign({
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28'
      }, opts.body ? { 'Content-Type': 'application/json' } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      if (r.status === 401) throw new Error('unauthorized');
      if (r.status === 403 || r.status === 404) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          throw new Error(r.status === 404 ? 'notfound' : (/rate limit/i.test(j.message || '') ? 'ratelimit' : 'forbidden'));
        });
      }
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });
  }

  function fileText(gist) {
    var f = gist && gist.files && gist.files[FILE];
    if (!f) return Promise.resolve(null);
    if (!f.truncated) return Promise.resolve(f.content);
    return fetch(f.raw_url, { cache: 'no-store' }).then(function (r) { return r.text(); });
  }

  function parseRows(text) {
    if (!text) return [];
    try { var j = JSON.parse(text); return Array.isArray(j.words) ? j.words : []; } catch (e) { return []; }
  }

  // Find the user's Mahfuzat gist, or create a secret one. Resolves to the gist object.
  function findOrCreate(token) {
    function page(n) {
      return gh(token, '/gists?per_page=100&page=' + n).then(function (list) {
        for (var i = 0; i < list.length; i++) if (list[i].files && list[i].files[FILE]) return gh(token, '/gists/' + list[i].id);
        if (list.length === 100 && n < 5) return page(n + 1);
        return gh(token, '/gists', { method: 'POST', body: {
          description: 'Mahfuzat — vocabulary sync (managed by the app)',
          public: false,
          files: (function () { var f = {}; f[FILE] = { content: JSON.stringify({ app: 'mahfuzat', version: 1, words: [] }) }; return f; }())
        } });
      });
    }
    return page(1);
  }

  // cfg: { token, gistId? }. Resolves to { words (live), gistId }.
  function run(cfg, payload, now) {
    now = now || Date.now();
    var token = cfg.token;
    var getGist = cfg.gistId
      ? gh(token, '/gists/' + cfg.gistId).catch(function (e) { if (e.message === 'notfound') return findOrCreate(token); throw e; })
      : findOrCreate(token);
    return getGist.then(function (gist) {
      return fileText(gist).then(function (text) {
        var merged = prune(mergeAll(parseRows(text), payload.words, payload.deleted), now);
        merged.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
        var files = {};
        files[FILE] = { content: JSON.stringify({ app: 'mahfuzat', version: 1, updatedAt: now, words: merged }, null, 1) };
        return gh(token, '/gists/' + gist.id, { method: 'PATCH', body: { files: files } }).then(function () {
          return { words: live(merged), gistId: gist.id };
        });
      });
    });
  }

  return {
    sig: sig, parseToken: parseToken, prepare: prepare, snapshotOf: snapshotOf,
    mergeAll: mergeAll, live: live, prune: prune, run: run, FILE: FILE
  };
}));
