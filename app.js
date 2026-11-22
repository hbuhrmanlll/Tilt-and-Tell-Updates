/* Tilt & Tell — game logic. Made by Third Heaven Studios.
   No network calls, no tracking. Everything is stored on the device. */
(function () {
  "use strict";

  const VERSION = "1.1.0";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ---------------- Storage (safe) ---------------- */
  const store = {
    get(k, fallback) {
      try { const v = localStorage.getItem("tt." + k); return v == null ? fallback : JSON.parse(v); }
      catch (e) { return fallback; }
    },
    set(k, v) { try { localStorage.setItem("tt." + k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
    del(k) { try { localStorage.removeItem("tt." + k); } catch (e) {} }
  };

  /* ---------------- Settings ---------------- */
  const DEFAULTS = {
    ctlTilt: true, ctlSwipe: true, ctlButtons: true, ctlVoice: false, voiceAnswer: true,
    tiltFlip: false, sens: "med", oneWord: true, mute: false, sfxVol: 80, musicVol: 35, haptics: true
  };
  const settings = Object.assign({}, DEFAULTS, store.get("settings", {}));
  const saveSettings = () => store.set("settings", settings);

  /* ---------------- Random helpers ---------------- */
  function randInt(n) {
    if (window.crypto && crypto.getRandomValues) {
      const a = new Uint32Array(1); const lim = Math.floor(0x100000000 / n) * n;
      do { crypto.getRandomValues(a); } while (a[0] >= lim);
      return a[0] % n;
    }
    return Math.floor(Math.random() * n);
  }
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) { const j = randInt(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  }

  /* ---------------- Categories ---------------- */
  const BUILT_IN = (window.TT_CATEGORIES || []).map(c => ({
    id: c.id, name: c.name, emoji: c.emoji, group: c.group, hue: c.hue, desc: c.desc, phrases: !!c.phrases,
    items: Array.from(new Set(c.items.split("|").map(s => s.trim()).filter(Boolean)))
  }));
  const GROUP_ORDER = ["Characters", "Faith", "Acting", "Pop Culture", "Nature", "Stuff", "Food", "People", "Places", "World", "Activities", "Seasons", "Smart", "Easy"];
  const GROUP_LABEL = { "Characters": "Characters", "Faith": "Faith and church", "Acting": "Act and talk", "Pop Culture": "Movies, shows, and games", "Nature": "Animals and nature", "Stuff": "Things", "Food": "Food", "People": "People", "Places": "School and camp", "World": "Around the world", "Activities": "Sports, music, and toys", "Seasons": "Holidays", "Smart": "Brainy", "Easy": "For little kids", "Mine": "My decks" };

  function loadCustom() {
    const raw = store.get("custom", []);
    if (!Array.isArray(raw)) return [];
    return raw.filter(d => d && typeof d.id === "string" && typeof d.name === "string" && Array.isArray(d.items))
      .map(d => ({ id: d.id, name: d.name.slice(0, 40), emoji: "⭐", group: "Mine", hue: 45, desc: "Your deck", custom: true,
        items: d.items.filter(x => typeof x === "string").map(x => x.slice(0, 60)).slice(0, 500) }));
  }
  let customDecks = loadCustom();
  const allCats = () => customDecks.concat(BUILT_IN);
  const catById = id => allCats().find(c => c.id === id);

  /* One word per card: hide anything with a space (hyphenated names like Spider-Man count as one word).
     Your own decks always keep every card. Phrase-only decks are hidden in one-word mode. */
  const isOneWord = w => !/\s/.test(w);
  const itemsFor = cat => (settings.oneWord && !cat.custom) ? cat.items.filter(isOneWord) : cat.items;
  const isVisible = cat => !(settings.oneWord && cat.phrases);

  /* Unlockable decks: earn 1 star for every word you get right, then spend stars to open new decks. */
  const UNLOCK_COST = {
    "ocean": 10, "dinos": 10, "kitchen": 10, "church": 15, "bible-stories": 15, "tv": 15,
    "games": 20, "jobs": 20, "places": 20, "sports": 20, "music": 25, "vehicles": 25, "school": 25, "outdoors": 25,
    "holidays": 30, "christmas": 30, "seasons-weather": 30, "science": 30, "inventions": 35, "toys": 35,
    "fairy-tales": 35, "fantasy": 35, "body": 40, "states": 40, "impressions": 40, "phrases": 40
  };
  const progress = { stars: Math.max(0, Number(store.get("stars", 0)) || 0), unlocked: new Set(store.get("unlocked", [])) };
  const saveProgress = () => { store.set("stars", progress.stars); store.set("unlocked", Array.from(progress.unlocked)); };
  const costOf = cat => (cat.custom ? 0 : (UNLOCK_COST[cat.id] || 0));
  const isUnlocked = cat => costOf(cat) === 0 || progress.unlocked.has(cat.id);
  const playable = cat => isVisible(cat) && isUnlocked(cat);
  function addStars(n) { if (n > 0) { progress.stars += n; saveProgress(); } }
  function nextUnlockHint() {
    const locked = BUILT_IN.filter(c => isVisible(c) && !isUnlocked(c)).sort((a, b) => costOf(a) - costOf(b));
    if (!locked.length) return "";
    const c = locked[0];
    return progress.stars >= costOf(c) ? `You can unlock ${c.name} now!` : `${costOf(c) - progress.stars} more to unlock ${c.name}`;
  }

  /* Shuffle bag with memory: a word won't repeat until every word in that category has come up. */
  function getSeen(id) { const s = store.get("seen." + id, []); return Array.isArray(s) ? s : []; }
  function markSeen(cat, word) {
    let seen = getSeen(cat.id);
    if (!seen.includes(word)) seen.push(word);
    if (seen.length >= itemsFor(cat).length) seen = [word]; // full cycle done: start over, but keep the last one out
    store.set("seen." + cat.id, seen);
  }
  function buildDeck(catIds) {
    const fresh = [], used = [];
    catIds.forEach(id => {
      const cat = catById(id); if (!cat) return;
      const seen = new Set(getSeen(id));
      itemsFor(cat).forEach(w => (seen.has(w) ? used : fresh).push({ word: w, cat }));
    });
    return shuffle(fresh).concat(shuffle(used));
  }

  /* ---------------- Audio (all made in code) ---------------- */
  const Audio = (() => {
    let ctx = null, master = null, sfxBus = null, musicBus = null, musicTimer = null, musicOn = false, nextBeat = 0, beatIdx = 0;
    function ensure() {
      if (ctx) { if (ctx.state === "suspended") ctx.resume(); return true; }
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false;
      ctx = new AC(); master = ctx.createGain(); master.connect(ctx.destination);
      sfxBus = ctx.createGain(); sfxBus.connect(master);
      musicBus = ctx.createGain(); musicBus.connect(master);
      applyVolumes(); return true;
    }
    function applyVolumes() {
      if (!ctx) return;
      master.gain.value = settings.mute ? 0 : 1;
      sfxBus.gain.value = (settings.sfxVol / 100) * 0.9;
      musicBus.gain.value = (settings.musicVol / 100) * 0.32;
    }
    function tone(freq, start, dur, { type = "sine", vol = 0.3, attack = 0.005, bus = sfxBus, slideTo = null, filter = null } = {}) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, start);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(vol, start + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      let node = o;
      if (filter) { const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = filter; o.connect(f); node = f; }
      node.connect(g); g.connect(bus); o.start(start); o.stop(start + dur + 0.05);
    }
    function noise(start, dur, vol, hp) {
      const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const s = ctx.createBufferSource(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      f.type = "highpass"; f.frequency.value = hp || 2000; s.buffer = buf; g.gain.value = vol;
      s.connect(f); f.connect(g); g.connect(sfxBus); s.start(start);
    }
    const sfx = {
      tap() { const t = ctx.currentTime; tone(880, t, 0.06, { type: "triangle", vol: 0.12 }); },
      correct() { const t = ctx.currentTime; tone(784, t, 0.12, { type: "triangle", vol: 0.32 }); tone(1175, t + 0.08, 0.22, { type: "triangle", vol: 0.32 }); tone(1568, t + 0.16, 0.28, { type: "sine", vol: 0.18 }); },
      pass() { const t = ctx.currentTime; tone(330, t, 0.28, { type: "sawtooth", vol: 0.18, slideTo: 196, filter: 1400 }); },
      tick(urgent) { const t = ctx.currentTime; tone(urgent ? 1400 : 1000, t, 0.05, { type: "square", vol: urgent ? 0.1 : 0.06, filter: 3000 }); noise(t, 0.02, 0.05, 4000); },
      count(n) { const t = ctx.currentTime; tone(n > 0 ? 660 : 990, t, n > 0 ? 0.16 : 0.4, { type: "triangle", vol: 0.3 }); if (n === 0) tone(1320, t, 0.4, { type: "sine", vol: 0.15 }); },
      timeup() { const t = ctx.currentTime; tone(440, t, 0.3, { type: "square", vol: 0.16, filter: 1800 }); tone(349, t + 0.28, 0.5, { type: "square", vol: 0.16, filter: 1800 }); },
      win() { const t = ctx.currentTime; [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, t + i * 0.12, i === 5 ? 0.6 : 0.16, { type: "triangle", vol: 0.28 })); noise(t + 0.7, 0.4, 0.06, 5000); }
    };
    function play(name, arg) { if (settings.mute || !settings.sfxVol) return; if (!ensure()) return; try { sfx[name](arg); } catch (e) {} }

    /* Menu music: a relaxed, bouncy four-chord loop at 96 BPM. Quiet on purpose. */
    const BPM = 96, STEP = 60 / BPM / 2; // eighth notes
    const CHORDS = [[261.6, 329.6, 392.0], [220.0, 261.6, 329.6], [174.6, 220.0, 261.6], [196.0, 246.9, 293.7]];
    const BASS = [130.8, 110.0, 87.3, 98.0];
    const MELODY = [784, 0, 659, 0, 587, 659, 0, 523, 659, 0, 523, 0, 440, 523, 0, 0, 698, 0, 659, 0, 587, 523, 0, 440, 587, 0, 494, 0, 523, 0, 0, 0];
    function schedule() {
      while (nextBeat < ctx.currentTime + 0.25) {
        const bar = Math.floor(beatIdx / 8) % 4, step = beatIdx % 8, t = nextBeat;
        if (step === 0 || step === 4) CHORDS[bar].forEach(f => tone(f, t, STEP * 3.6, { type: "triangle", vol: 0.05, attack: 0.03, bus: musicBus, filter: 1500 }));
        if (step % 2 === 0) tone(BASS[bar], t, STEP * 1.6, { type: "sine", vol: 0.2, bus: musicBus });
        const m = MELODY[beatIdx % 32]; if (m) tone(m, t, STEP * 0.9, { type: "sine", vol: 0.06, bus: musicBus });
        if (step % 2 === 1) { /* soft shaker */
          const len = Math.floor(ctx.sampleRate * 0.03), b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
          for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
          const s = ctx.createBufferSource(), g = ctx.createGain(), f = ctx.createBiquadFilter();
          f.type = "highpass"; f.frequency.value = 6000; g.gain.value = 0.05; s.buffer = b; s.connect(f); f.connect(g); g.connect(musicBus); s.start(t);
        }
        nextBeat += STEP; beatIdx++;
      }
    }
    function startMusic() {
      if (musicOn || settings.mute || !settings.musicVol) return;
      if (!ensure()) return;
      musicOn = true; nextBeat = ctx.currentTime + 0.1; beatIdx = 0;
      musicBus.gain.cancelScheduledValues(ctx.currentTime);
      musicBus.gain.setValueAtTime(0.0001, ctx.currentTime);
      musicBus.gain.linearRampToValueAtTime((settings.musicVol / 100) * 0.32, ctx.currentTime + 1.2);
      musicTimer = setInterval(schedule, 90); schedule();
    }
    function stopMusic() {
      if (!musicOn) return; musicOn = false; clearInterval(musicTimer);
      if (ctx) { musicBus.gain.cancelScheduledValues(ctx.currentTime); musicBus.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.15); }
    }
    return { ensure, play, startMusic, stopMusic, applyVolumes, get musicOn() { return musicOn; } };
  })();

  function buzz(pattern) { if (settings.haptics && navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) {} } }

  /* ---------------- Screens / navigation ---------------- */
  const history = [];
  let current = "splash";
  const MUSIC_SCREENS = new Set(["home", "howto", "setup", "cats", "settings", "decks", "deck-edit", "about", "board", "win"]);
  function show(name, { push = true } = {}) {
    const prev = $("#screen-" + current); const next = $("#screen-" + name);
    if (!next) return;
    if (prev) prev.classList.remove("is-active");
    if (push && current !== name && current !== "splash") history.push(current);
    current = name; next.classList.add("is-active");
    const sc = next.querySelector(".scroll"); if (sc) sc.scrollTop = 0;
    if (MUSIC_SCREENS.has(name)) Audio.startMusic(); else Audio.stopMusic();
    if (onShow[name]) onShow[name]();
  }
  function back() { const p = history.pop() || "home"; show(p, { push: false }); }
  const onShow = {};

  document.addEventListener("click", e => {
    const nav = e.target.closest("[data-nav]"); if (nav) { Audio.play("tap"); show(nav.dataset.nav); return; }
    if (e.target.closest("[data-back]")) { Audio.play("tap"); back(); }
  });

  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2200); }

  /* Modal dialog. actions: [{label, kind, fn}] */
  function modal(title, text, actions) {
    const m = $("#modal"); $("#modal-title").textContent = title; $("#modal-text").textContent = text || "";
    const box = $("#modal-actions"); box.textContent = "";
    actions.forEach(a => {
      const b = document.createElement("button"); b.className = "btn " + (a.kind || "btn-ghost"); b.textContent = a.label;
      b.addEventListener("click", () => { closeModal(); Audio.play("tap"); if (a.fn) a.fn(); }); box.appendChild(b);
    });
    m.hidden = false; const first = box.querySelector("button"); if (first) first.focus();
  }
  function closeModal() { $("#modal").hidden = true; }

  /* ---------------- Splash + home ---------------- */
  function leaveSplash() { if (current === "splash") show("home", { push: false }); }
  $("#splash-skip").addEventListener("click", () => { Audio.ensure(); leaveSplash(); });
  setTimeout(leaveSplash, 1700);

  const HERO_WORDS = ["Penguin", "Noah", "Pizza", "Moonwalk", "Spider-Man", "Snowman", "Pirate", "Volcano", "Tuba", "Giraffe"];
  let heroIdx = 0;
  setInterval(() => {
    if (current !== "home") return;
    const el = $("#hero-word"); el.style.opacity = "0";
    setTimeout(() => { heroIdx = (heroIdx + 1) % HERO_WORDS.length; el.textContent = HERO_WORDS[heroIdx]; el.style.opacity = "1"; }, 250);
  }, 2600);

  // first touch anywhere unlocks audio on iPhone
  document.addEventListener("pointerdown", function unlock() { Audio.ensure(); if (MUSIC_SCREENS.has(current)) Audio.startMusic(); document.removeEventListener("pointerdown", unlock); }, { once: true });

  /* ---------------- Setup ---------------- */
  const SWATCHES = [350, 205, 140, 45, 280, 20, 175, 320];
  const TEAM_NAMES = ["Red Team", "Blue Team", "Green Team", "Gold Team", "Purple Team", "Orange Team"];
  const game = {
    mode: store.get("mode", "players"),
    players: store.get("players", ["Player 1", "Player 2"]),
    teams: store.get("teams", ["Red Team", "Blue Team"]),
    time: store.get("time", 60),
    rounds: store.get("rounds", 2),
    cats: new Set(store.get("cats", [])),
    roster: [], turn: 0, totalTurns: 0
  };
  if (!Array.isArray(game.players) || !game.players.length) game.players = ["Player 1", "Player 2"];
  if (!Array.isArray(game.teams) || game.teams.length < 2) game.teams = ["Red Team", "Blue Team"];

  const MODE_NOTES = {
    players: "Everyone plays for themselves. Pass the phone around and each person keeps their own score.",
    teams: "Split into teams. One person from the team guesses while their teammates give clues.",
    quick: "One turn, no names, no score keeping. Great for a quick warm-up."
  };
  function setChecked(group, attr, val) { $$(`#${group} [${attr}]`).forEach(b => b.setAttribute("aria-checked", String(b.getAttribute(attr) === String(val)))); }

  function renderSetup() {
    setChecked("mode-seg", "data-mode", game.mode);
    $("#mode-note").textContent = MODE_NOTES[game.mode];
    setChecked("time-chips", "data-time", game.time);
    setChecked("round-chips", "data-rounds", game.rounds);
    const quick = game.mode === "quick";
    $("#roster-wrap").hidden = quick; $("#rounds-wrap").hidden = quick;
    $("#setup-title").textContent = quick ? "Quick play" : "Who's playing?";
    const list = game.mode === "teams" ? game.teams : game.players;
    const ul = $("#roster"); ul.textContent = "";
    ul.setAttribute("aria-label", game.mode === "teams" ? "Teams" : "Players");
    list.forEach((name, i) => {
      const li = document.createElement("li");
      const sw = document.createElement("span"); sw.className = "swatch"; sw.style.background = `hsl(${SWATCHES[i % SWATCHES.length]} 75% 62%)`; sw.textContent = String(i + 1);
      const inp = document.createElement("input"); inp.type = "text"; inp.value = name; inp.maxLength = 24; inp.autocomplete = "off";
      inp.setAttribute("aria-label", (game.mode === "teams" ? "Team " : "Player ") + (i + 1) + " name");
      inp.addEventListener("input", () => { list[i] = inp.value; persistSetup(); });
      inp.addEventListener("focus", () => inp.select());
      const rm = document.createElement("button"); rm.className = "rm"; rm.setAttribute("aria-label", "Remove " + (name || "this one"));
      rm.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      const min = game.mode === "teams" ? 2 : 1;
      rm.disabled = list.length <= min; rm.style.opacity = list.length <= min ? ".3" : "1";
      rm.addEventListener("click", () => { if (list.length <= min) return; list.splice(i, 1); persistSetup(); renderSetup(); });
      li.append(sw, inp, rm); ul.appendChild(li);
    });
    const max = game.mode === "teams" ? 6 : 12;
    const add = $("#add-roster"); add.textContent = game.mode === "teams" ? "+ Add team" : "+ Add player";
    add.disabled = list.length >= max; add.style.opacity = list.length >= max ? ".4" : "1";
  }
  function persistSetup() {
    store.set("mode", game.mode); store.set("players", game.players); store.set("teams", game.teams);
    store.set("time", game.time); store.set("rounds", game.rounds);
  }
  onShow.setup = renderSetup;
  $("#mode-seg").addEventListener("click", e => { const b = e.target.closest("[data-mode]"); if (!b) return; Audio.play("tap"); game.mode = b.dataset.mode; persistSetup(); renderSetup(); });
  $("#time-chips").addEventListener("click", e => { const b = e.target.closest("[data-time]"); if (!b) return; Audio.play("tap"); game.time = +b.dataset.time; persistSetup(); renderSetup(); });
  $("#round-chips").addEventListener("click", e => { const b = e.target.closest("[data-rounds]"); if (!b) return; Audio.play("tap"); game.rounds = +b.dataset.rounds; persistSetup(); renderSetup(); });
  $("#add-roster").addEventListener("click", () => {
    Audio.play("tap");
    const list = game.mode === "teams" ? game.teams : game.players;
    const max = game.mode === "teams" ? 6 : 12; if (list.length >= max) return;
    if (game.mode === "teams") { const n = TEAM_NAMES.find(t => !list.includes(t)) || "Team " + (list.length + 1); list.push(n); }
    else list.push("Player " + (list.length + 1));
    persistSetup(); renderSetup();
    const inputs = $$("#roster input"); const last = inputs[inputs.length - 1]; if (last) last.focus();
  });
  $("#to-categories").addEventListener("click", () => {
    Audio.play("tap");
    const list = game.mode === "teams" ? game.teams : game.players;
    list.forEach((n, i) => { if (!String(n).trim()) list[i] = (game.mode === "teams" ? "Team " : "Player ") + (i + 1); });
    persistSetup(); show("cats");
  });

  /* ---------------- Categories ---------------- */
  const LOCK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  function renderCats() {
    const q = $("#cat-search").value.trim().toLowerCase();
    const list = $("#cat-list"); list.textContent = "";
    // drop selections for decks that no longer exist
    Array.from(game.cats).forEach(id => { const c = catById(id); if (!c || !playable(c)) game.cats.delete(id); });
    store.set("cats", Array.from(game.cats));
    $("#star-count").textContent = String(progress.stars);
    $("#star-hint").textContent = nextUnlockHint() || "Every deck is unlocked.";
    const hiddenPhrases = allCats().filter(c => !isVisible(c)).length;
    $("#cat-oneword-note").hidden = !hiddenPhrases;
    const cats = allCats().filter(isVisible).filter(c => !q || c.name.toLowerCase().includes(q) || (c.desc || "").toLowerCase().includes(q));
    const groups = ["Mine"].concat(GROUP_ORDER);
    let shown = 0;
    groups.forEach(g => {
      const inGroup = cats.filter(c => c.group === g); if (!inGroup.length) return;
      const h = document.createElement("h3"); h.className = "cat-group-title"; h.textContent = GROUP_LABEL[g] || g; list.appendChild(h);
      const grid = document.createElement("div"); grid.className = "cat-grid";
      inGroup.forEach(c => {
        const b = document.createElement("button"); b.className = "cat-tile"; b.style.setProperty("--h", c.hue);
        const locked = !isUnlocked(c), n = itemsFor(c).length;
        b.setAttribute("aria-pressed", String(game.cats.has(c.id)));
        if (locked) b.classList.add("is-locked");
        b.setAttribute("aria-label", locked ? `${c.name}, locked, ${costOf(c)} stars to unlock` : `${c.name}, ${n} words`);
        const em = document.createElement("span"); em.className = "cat-emoji"; em.textContent = c.emoji; em.setAttribute("aria-hidden", "true");
        const wrap = document.createElement("span");
        const nm = document.createElement("span"); nm.className = "cat-name"; nm.textContent = c.name; nm.style.display = "block";
        const ct = document.createElement("span"); ct.className = "cat-count"; ct.textContent = locked ? `⭐ ${costOf(c)} to unlock` : `${n} words`;
        wrap.append(nm, ct);
        const ck = document.createElement("span"); ck.className = "cat-check"; ck.innerHTML = CHECK_SVG;
        if (locked) { const lk = document.createElement("span"); lk.className = "cat-lock"; lk.setAttribute("aria-hidden", "true"); lk.innerHTML = LOCK_SVG; b.append(lk); }
        b.append(ck, em, wrap);
        b.addEventListener("click", () => {
          Audio.play("tap");
          if (!isUnlocked(c)) { askUnlock(c); return; }
          if (game.cats.has(c.id)) game.cats.delete(c.id); else game.cats.add(c.id);
          b.setAttribute("aria-pressed", String(game.cats.has(c.id))); store.set("cats", Array.from(game.cats)); updateCatsGo();
        });
        grid.appendChild(b); shown++;
      });
      list.appendChild(grid);
    });
    $("#cat-empty").hidden = shown > 0;
    updateCatsGo();
  }
  function askUnlock(c) {
    const cost = costOf(c);
    if (progress.stars >= cost) {
      modal(`Unlock ${c.name}?`, `This uses ${cost} of your ${progress.stars} stars. You'll get ${itemsFor(c).length} new words.`, [
        { label: `Unlock for ⭐ ${cost}`, kind: "btn-primary", fn: () => {
          progress.stars -= cost; progress.unlocked.add(c.id); saveProgress();
          game.cats.add(c.id); store.set("cats", Array.from(game.cats));
          Audio.play("win"); buzz([40, 40, 80]); renderCats(); toast(`${c.name} unlocked!`);
        } },
        { label: "Not now", kind: "btn-ghost" }
      ]);
    } else {
      modal(`${c.name} is locked`, `You need ${cost - progress.stars} more stars. You earn a star for every word you get right, so keep playing!`, [
        { label: "OK", kind: "btn-primary" }
      ]);
    }
  }
  function updateCatsGo() {
    const n = game.cats.size, btn = $("#cats-go");
    const words = Array.from(game.cats).reduce((s, id) => { const c = catById(id); return s + (c ? itemsFor(c).length : 0); }, 0);
    btn.disabled = n === 0;
    btn.textContent = n === 0 ? "Pick at least one" : n === 1 ? `Play ${catById(Array.from(game.cats)[0]).name}` : `Play ${n} categories (${words} words)`;
  }
  onShow.cats = renderCats;
  $("#cat-search").addEventListener("input", renderCats);
  $("#cats-surprise").addEventListener("click", () => {
    Audio.play("tap"); game.cats.clear();
    const pool = shuffle(BUILT_IN.filter(c => c.group !== "Easy" && playable(c)).slice()); pool.slice(0, 3).forEach(c => game.cats.add(c.id));
    store.set("cats", Array.from(game.cats)); $("#cat-search").value = ""; renderCats();
    toast("Picked: " + pool.slice(0, 3).map(c => c.name).join(", "));
  });
  $("#cats-go").addEventListener("click", () => { if (!game.cats.size) return; Audio.play("tap"); startGame(); });

  /* ---------------- Game flow ---------------- */
  function startGame() {
    if (game.mode === "quick") { game.roster = [{ name: "You", score: 0, turns: 0, hue: 45 }]; game.totalTurns = 1; }
    else {
      const names = (game.mode === "teams" ? game.teams : game.players).map(n => String(n).trim().slice(0, 24) || "Player");
      game.roster = names.map((name, i) => ({ name, score: 0, turns: 0, hue: SWATCHES[i % SWATCHES.length] }));
      game.totalTurns = game.roster.length * game.rounds;
    }
    game.turn = 0; history.length = 0; history.push("home");
    showReady();
  }
  const currentPlayer = () => game.roster[game.turn % game.roster.length];

  function catSummary() {
    const names = Array.from(game.cats).map(id => (catById(id) || {}).name).filter(Boolean);
    return names.length <= 3 ? names.join(", ") : names.slice(0, 2).join(", ") + ` and ${names.length - 2} more`;
  }
  function showReady() {
    const p = currentPlayer();
    if (game.mode === "quick") { $("#ready-kicker").textContent = "Quick play"; $("#ready-name").textContent = "Ready?"; $("#ready-meta").textContent = ""; }
    else {
      $("#ready-kicker").textContent = game.mode === "teams" ? "Up next" : "Your turn";
      $("#ready-name").textContent = p.name;
      $("#ready-meta").textContent = `Turn ${game.turn + 1} of ${game.totalTurns}`;
    }
    $("#ready-cats").textContent = catSummary() + `, ${game.time} seconds`;
    const tips = [];
    if (game.mode === "teams") tips.push(`One person from ${p.name} holds the phone on their forehead, screen facing out.`);
    else tips.push("Hold the phone sideways on your forehead, screen facing out.");
    $("#ready-tip").textContent = tips[0];
    show("ready", { push: false });
  }
  $("#ready-quit").addEventListener("click", confirmQuit);
  $("#board-quit").addEventListener("click", confirmQuit);
  function confirmQuit() {
    Audio.play("tap");
    modal("Quit this game?", "Scores for this game will be lost.", [
      { label: "Quit game", kind: "btn-danger", fn: () => { endPlaySession(); history.length = 0; show("home", { push: false }); } },
      { label: "Keep playing", kind: "btn-primary" }
    ]);
  }

  /* ---------------- Turn ---------------- */
  const turn = { deck: [], idx: 0, results: [], left: 0, running: false, paused: false, lock: false, timer: null, endAt: 0, wordShownAt: 0, waitTimer: null };

  async function requestMotion() {
    if (!settings.ctlTilt) return false;
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) return false;
    if (typeof DOE.requestPermission === "function") {
      try { const r = await DOE.requestPermission(); return r === "granted"; } catch (e) { return false; }
    }
    return true;
  }
  let wakeLock = null;
  async function keepAwake() { try { if ("wakeLock" in navigator) { wakeLock = await navigator.wakeLock.request("screen"); } } catch (e) {} }
  function releaseAwake() { try { if (wakeLock) wakeLock.release(); } catch (e) {} wakeLock = null; }
  async function goFullscreen() {
    const el = document.documentElement;
    try { if (!document.fullscreenElement && el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" }); } catch (e) {}
    try { if (screen.orientation && screen.orientation.lock) await screen.orientation.lock("landscape"); } catch (e) {}
  }
  function exitFullscreen() {
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
    try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); } catch (e) {}
  }

  let motionOK = false;
  $("#ready-go").addEventListener("click", async () => {
    Audio.ensure(); Audio.play("tap");
    motionOK = await requestMotion();
    if (settings.ctlTilt && !motionOK) toast("Tilt is off. Motion access wasn't allowed, so use swipes or buttons.");
    await goFullscreen(); keepAwake();
    beginTurn();
  });

  function beginTurn() {
    turn.deck = buildDeck(Array.from(game.cats));
    turn.idx = 0; turn.results = []; turn.left = game.time; turn.running = false; turn.paused = false; turn.lock = true;
    const p = currentPlayer();
    $("#screen-play").style.setProperty("--ph", 265);
    $("#play-stage").style.setProperty("--ph", 265);
    $("#play-wait").style.setProperty("--ph", 265);
    $("#play-score").textContent = "0";
    $("#play-buttons").hidden = !settings.ctlButtons;
    $("#play-word").textContent = "";
    $("#play-cat").textContent = game.mode === "quick" ? "" : p.name;
    updateTimer();
    show("play", { push: false });
    // waiting for forehead
    const wait = $("#play-wait"); wait.classList.add("show");
    $("#pw-count").textContent = ""; $("#pw-start").hidden = false;
    $("#pw-msg").textContent = motionOK ? "Put the phone on your forehead" : "Tap Start when the phone is on your forehead";
    Tilt.start();
    checkRotateHint();
  }
  $("#pw-start").addEventListener("click", () => { Audio.ensure(); startCountdown(); });

  function startCountdown() {
    if (turn.countingDown) return; turn.countingDown = true;
    $("#pw-start").hidden = true; let n = 3;
    const el = $("#pw-count"), msg = $("#pw-msg");
    msg.textContent = "Get ready";
    const step = () => {
      if (current !== "play") { turn.countingDown = false; return; }
      if (n > 0) { el.textContent = String(n); el.classList.remove("tick"); void el.offsetWidth; el.classList.add("tick"); Audio.play("count", n); buzz(30); n--; turn.waitTimer = setTimeout(step, 800); }
      else { Audio.play("count", 0); buzz(60); el.textContent = ""; $("#play-wait").classList.remove("show"); turn.countingDown = false; runTurn(); }
    };
    step();
  }

  function runTurn() {
    turn.running = true; turn.lock = false; turn.endAt = performance.now() + turn.left * 1000;
    nextWord();
    Tilt.arm();
    clearInterval(turn.timer); turn.timer = setInterval(tickTimer, 100);
    Voice.start();
  }
  let lastWhole = null;
  function tickTimer() {
    if (!turn.running || turn.paused) return;
    const ms = Math.max(0, turn.endAt - performance.now());
    turn.left = ms / 1000;
    const whole = Math.ceil(turn.left);
    if (whole !== lastWhole) { lastWhole = whole; if (whole <= 10 && whole > 0) Audio.play("tick", whole <= 3); }
    updateTimer();
    if (ms <= 0) timeUp();
  }
  function updateTimer() {
    const whole = Math.ceil(turn.left);
    $("#timer-num").textContent = String(whole);
    const frac = game.time ? turn.left / game.time : 0;
    $("#timer-ring").style.strokeDashoffset = String(119.4 * (1 - frac));
    $("#play-timer").classList.toggle("is-low", whole <= 10);
  }

  function nextWord() {
    if (turn.idx >= turn.deck.length) { // ran out: reshuffle everything
      turn.deck = turn.deck.concat(shuffle(turn.deck.slice())); }
    const item = turn.deck[turn.idx];
    const hue = item.cat.hue;
    $("#play-stage").style.setProperty("--ph", hue);
    $("#play-wait").style.setProperty("--ph", hue);
    $("#play-cat").textContent = (game.mode === "quick" ? "" : currentPlayer().name + " · ") + item.cat.name;
    const w = $("#play-word"); w.textContent = item.word; w.classList.remove("pop"); void w.offsetWidth; w.classList.add("pop");
    fitWord();
    turn.wordShownAt = performance.now();
    Voice.resetWindow();
  }
  function fitWord() {
    const w = $("#play-word"), box = w.parentElement;
    const maxW = box.clientWidth * 0.96, maxH = box.clientHeight * 0.94;
    let size = Math.min(box.clientWidth * 0.2, box.clientHeight * 0.62, 220);
    w.style.fontSize = size + "px";
    let guard = 0;
    while ((w.scrollWidth > maxW || w.scrollHeight > maxH) && size > 18 && guard++ < 60) { size *= 0.92; w.style.fontSize = size + "px"; }
  }
  window.addEventListener("resize", () => { if (current === "play") fitWord(); checkRotateHint(); });
  function checkRotateHint() {
    const portrait = window.innerHeight > window.innerWidth;
    $("#rotate-hint").classList.toggle("show", current === "play" && portrait && window.innerWidth < 600);
  }

  /* outcome: "got" or "pass"; source used for feedback text */
  function score(outcome, source) {
    if (!turn.running || turn.paused || turn.lock) return;
    if (source !== "button" && source !== "key" && performance.now() - turn.wordShownAt < 250) return; // ignore accidental double triggers
    turn.lock = true;
    const item = turn.deck[turn.idx];
    turn.results.push({ word: item.word, cat: item.cat, got: outcome === "got" });
    markSeen(item.cat, item.word);
    const got = turn.results.filter(r => r.got).length;
    $("#play-score").textContent = String(got);
    const ov = $("#play-overlay");
    ov.className = "play-overlay show " + (outcome === "got" ? "good" : "bad");
    $("#po-big").textContent = outcome === "got" ? "Got it!" : "Pass";
    $("#po-small").textContent = item.word + (source === "voice-answer" ? " (heard it)" : "");
    Audio.play(outcome === "got" ? "correct" : "pass");
    buzz(outcome === "got" ? 35 : 70);
    setTimeout(() => {
      ov.className = "play-overlay";
      if (!turn.running) return;
      turn.idx++; nextWord(); turn.lock = false;
    }, 200);
  }

  function timeUp() {
    if (!turn.running) return;
    turn.running = false; clearInterval(turn.timer); Voice.stop(); Tilt.stop();
    turn.left = 0; updateTimer();
    // the word on screen when time ran out counts as a pass only if it was never answered
    const ov = $("#play-overlay"); ov.className = "play-overlay show time";
    $("#po-big").textContent = "Time's up!"; $("#po-small").textContent = "Flip the phone over to see how you did";
    Audio.play("timeup"); buzz([200, 80, 200]);
    setTimeout(() => { ov.className = "play-overlay"; exitFullscreen(); showResults(); }, 1600);
  }

  function pauseTurn() {
    if (!turn.running || turn.paused) return;
    turn.paused = true; turn.left = Math.max(0, (turn.endAt - performance.now()) / 1000); Voice.stop();
    modal("Paused", `${Math.ceil(turn.left)} seconds left.`, [
      { label: "Resume", kind: "btn-primary", fn: resumeTurn },
      { label: "End this turn", kind: "btn-ghost", fn: () => { turn.paused = false; turn.endAt = performance.now(); tickTimer(); } },
      { label: "Quit game", kind: "btn-danger", fn: () => { endPlaySession(); history.length = 0; show("home", { push: false }); } }
    ]);
  }
  function resumeTurn() { turn.paused = false; turn.endAt = performance.now() + turn.left * 1000; turn.wordShownAt = performance.now(); Voice.start(); }
  function endPlaySession() {
    turn.running = false; turn.paused = false; clearInterval(turn.timer); clearTimeout(turn.waitTimer); turn.countingDown = false;
    Voice.stop(); Tilt.stop(); exitFullscreen(); releaseAwake(); $("#play-wait").classList.remove("show"); $("#play-overlay").className = "play-overlay";
    $("#rotate-hint").classList.remove("show");
  }
  $("#play-pause").addEventListener("click", e => { e.stopPropagation(); Audio.play("tap"); pauseTurn(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && current === "play") {
      if (turn.running) pauseTurn();
      else if (turn.countingDown) { clearTimeout(turn.waitTimer); turn.countingDown = false; $("#pw-start").hidden = false; $("#pw-count").textContent = ""; $("#pw-msg").textContent = "Tap Start when you're ready"; }
    }
    if (!document.hidden && current === "play" && turn.running) keepAwake();
  });

  /* Buttons */
  $("#btn-got").addEventListener("pointerdown", e => { e.stopPropagation(); score("got", "button"); });
  $("#btn-pass").addEventListener("pointerdown", e => { e.stopPropagation(); score("pass", "button"); });

  /* Swipe */
  (function swipe() {
    const stage = $("#play-stage"); let sx = 0, sy = 0, st = 0, active = false;
    stage.addEventListener("pointerdown", e => { if (e.target.closest("button")) return; active = true; sx = e.clientX; sy = e.clientY; st = performance.now(); });
    stage.addEventListener("pointerup", e => {
      if (!active) return; active = false; if (!settings.ctlSwipe) return;
      const dx = e.clientX - sx, dy = e.clientY - sy, dt = performance.now() - st;
      const dist = Math.hypot(dx, dy); if (dist < 50 || dt > 900) return;
      if (Math.abs(dy) > Math.abs(dx)) score("got", "swipe"); else score("pass", "swipe");
    });
    stage.addEventListener("pointercancel", () => { active = false; });
  })();

  /* Keyboard (handy on a laptop or with a Bluetooth remote) */
  document.addEventListener("keydown", e => {
    if (current !== "play") return;
    if (["ArrowUp", "ArrowDown", "Enter"].includes(e.key)) { e.preventDefault(); score("got", "key"); }
    else if (["ArrowLeft", "ArrowRight", "Backspace"].includes(e.key)) { e.preventDefault(); score("pass", "key"); }
    else if (e.key === "Escape" || e.key === "p") { pauseTurn(); }
    else if (e.key === " " && !turn.running && !turn.countingDown) { e.preventDefault(); startCountdown(); }
  });

  /* ---------------- Tilt ----------------
     We measure how much the screen faces the sky: up = cos(beta) * cos(gamma).
     On a forehead the screen faces straight out, so up ≈ 0.
     Tilt the head down: screen faces the floor (up < 0) → Got it.
     Tilt the head back: screen faces the ceiling (up > 0) → Pass.
     This works the same in portrait or landscape and on iPhone and Android. */
  const Tilt = (() => {
    const TH = { low: 0.72, med: 0.58, high: 0.44 };
    let on = false, armed = false, neutralSince = 0, lastUp = null, firing = null, firingSince = 0;
    function handler(e) {
      if (e.beta == null || e.gamma == null) return;
      const b = e.beta * Math.PI / 180, g = e.gamma * Math.PI / 180;
      const up = Math.cos(b) * Math.cos(g); lastUp = up;
      const now = performance.now(), th = TH[settings.sens] || TH.med;
      const neutral = Math.abs(up) < 0.32;
      // Waiting screen: start the countdown once the phone has been held steady on the forehead
      if (current === "play" && !turn.running && !turn.countingDown && $("#play-wait").classList.contains("show")) {
        if (neutral) { if (!neutralSince) neutralSince = now; if (now - neutralSince > 700) { neutralSince = 0; startCountdown(); } }
        else neutralSince = 0;
        return;
      }
      if (!turn.running || turn.paused) return;
      if (neutral) { armed = true; firing = null; return; }
      if (!armed || turn.lock) return;
      const dir = up < -th ? "down" : up > th ? "up" : null;
      if (!dir) { firing = null; return; }
      if (firing !== dir) { firing = dir; firingSince = now; return; }
      if (now - firingSince >= 90) { // short hold filters out bumps
        armed = false; firing = null;
        const gotDir = settings.tiltFlip ? "up" : "down";
        score(dir === gotDir ? "got" : "pass", "tilt");
      }
    }
    return {
      start() { if (on || !settings.ctlTilt || !motionOK) return; on = true; armed = false; neutralSince = 0; window.addEventListener("deviceorientation", handler); },
      stop() { if (!on) return; on = false; window.removeEventListener("deviceorientation", handler); },
      arm() { armed = lastUp !== null && Math.abs(lastUp) < 0.32; },
      get lastUp() { return lastUp; }
    };
  })();

  /* ---------------- Voice ---------------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const Voice = (() => {
    let rec = null, want = false, windowText = "", cooldownUntil = 0, failed = false;
    const norm = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    const STOP = new Set(["the", "a", "an", "of", "and", "to", "in", "on", "at", "your", "my", "for", "with"]);
    const GOT = /\b(got it|gotcha|got that|i got it|we got it|correct|that's it|thats it)\b/;
    const PASS = /\b(pass|skip|next one)\b/;
    function answerHeard(text) {
      if (!settings.voiceAnswer) return false;
      const item = turn.deck[turn.idx]; if (!item) return false;
      const words = norm(item.word).split(" ").filter(w => w && !STOP.has(w));
      if (!words.length) return false;
      const heard = " " + text + " ";
      return words.every(w => heard.includes(" " + w + " ") || heard.includes(" " + w + "s ") || (w.endsWith("s") && heard.includes(" " + w.slice(0, -1) + " ")));
    }
    function onResult(e) {
      if (!turn.running || turn.paused || turn.lock) return;
      if (performance.now() < cooldownUntil) return;
      let latest = "";
      for (let i = e.resultIndex; i < e.results.length; i++) latest += " " + e.results[i][0].transcript;
      latest = norm(latest); if (!latest) return;
      windowText = (windowText + " " + latest).slice(-160);
      if (answerHeard(latest)) { fire("got", "voice-answer"); return; }
      if (GOT.test(latest)) { fire("got", "voice"); return; }
      if (PASS.test(latest)) { fire("pass", "voice"); return; }
    }
    function fire(o, src) { cooldownUntil = performance.now() + 600; windowText = ""; score(o, src); }
    function create() {
      const r = new SR(); r.continuous = true; r.interimResults = true; r.lang = navigator.language || "en-US"; r.maxAlternatives = 1;
      r.onresult = onResult;
      r.onerror = ev => { if (ev.error === "not-allowed" || ev.error === "service-not-allowed") { failed = true; want = false; toast("Voice is off. Microphone access wasn't allowed."); $("#hud-mic").hidden = true; } };
      r.onend = () => { if (want && !failed) { try { r.start(); } catch (e) {} } else $("#hud-mic").hidden = true; };
      return r;
    }
    return {
      supported: !!SR,
      start() {
        if (!SR || !settings.ctlVoice || failed) return;
        want = true; if (!rec) rec = create();
        try { rec.start(); } catch (e) { /* already running */ }
        $("#hud-mic").hidden = false;
      },
      stop() { want = false; if (rec) { try { rec.stop(); } catch (e) {} } $("#hud-mic").hidden = true; },
      resetWindow() { windowText = ""; cooldownUntil = Math.max(cooldownUntil, performance.now() + 500); }
    };
  })();

  /* ---------------- Results ---------------- */
  const MARK_GOOD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const MARK_BAD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 7 7 17M7 7l10 10"/></svg>';
  function showResults() {
    releaseAwake(); $("#rotate-hint").classList.remove("show");
    renderResults();
    const last = game.mode === "quick" || game.turn + 1 >= game.totalTurns;
    $("#res-next").textContent = game.mode === "quick" ? "Done" : last ? "See who won" : "Save and continue";
    $("#res-kicker").textContent = game.mode === "quick" ? "Time's up" : `${currentPlayer().name}`;
    show("results", { push: false });
  }
  function renderResults() {
    const ul = $("#res-list"); ul.textContent = "";
    const got = turn.results.filter(r => r.got).length;
    $("#res-score").textContent = String(got);
    $("#res-unit").textContent = got === 1 ? "correct" : "correct";
    $("#res-empty").hidden = turn.results.length > 0;
    turn.results.forEach((r, i) => {
      const li = document.createElement("li");
      const b = document.createElement("button"); b.className = "res-item " + (r.got ? "good" : "bad");
      b.setAttribute("aria-label", `${r.word}, ${r.got ? "got it" : "passed"}. Tap to change.`);
      const mk = document.createElement("span"); mk.className = "ri-mark"; mk.innerHTML = r.got ? MARK_GOOD : MARK_BAD;
      const wd = document.createElement("span"); wd.className = "ri-word"; wd.textContent = r.word;
      const stt = document.createElement("span"); stt.className = "ri-state"; stt.textContent = r.got ? "Got it" : "Passed";
      b.append(mk, wd, stt);
      b.addEventListener("click", () => { Audio.play("tap"); turn.results[i].got = !turn.results[i].got; renderResults(); });
      li.appendChild(b); ul.appendChild(li);
    });
  }
  $("#res-next").addEventListener("click", () => {
    Audio.play("tap");
    const got = turn.results.filter(r => r.got).length;
    addStars(got);
    if (got > 0) toast(`+${got} ⭐ ${got === 1 ? "star" : "stars"}. ${nextUnlockHint()}`.trim());
    if (game.mode === "quick") {
      modal(`You got ${got}!`, "Play another quick round?", [
        { label: "Play again", kind: "btn-primary", fn: () => { game.turn = 0; showReady(); } },
        { label: "Change categories", kind: "btn-ghost", fn: () => { history.length = 0; history.push("home"); show("cats", { push: false }); } },
        { label: "Back to home", kind: "btn-ghost", fn: () => { history.length = 0; show("home", { push: false }); } }
      ]);
      return;
    }
    const p = currentPlayer(); p.score += got; p.turns++;
    game.turn++;
    if (game.turn >= game.totalTurns) showWinner(); else showBoard();
  });

  /* ---------------- Scoreboard ---------------- */
  function rankList(container, { highlightNext = false } = {}) {
    const ol = container; ol.textContent = "";
    const next = highlightNext ? currentPlayer() : null;
    const sorted = game.roster.slice().sort((a, b) => b.score - a.score);
    const top = sorted[0] ? sorted[0].score : 0;
    let rank = 0, prev = null;
    sorted.forEach((p, i) => {
      if (p.score !== prev) { rank = i + 1; prev = p.score; }
      const li = document.createElement("li"); if (p === next) li.classList.add("is-next"); if (p.score === top && top > 0) li.classList.add("lead");
      const r = document.createElement("span"); r.className = "b-rank"; r.textContent = String(rank); r.style.background = `hsl(${p.hue} 75% 62%)`;
      const n = document.createElement("span"); n.className = "b-name"; n.textContent = p.name;
      if (p === next) { const nx = document.createElement("span"); nx.className = "b-next"; nx.textContent = "Up next"; n.appendChild(nx); }
      const s = document.createElement("span"); s.className = "b-score"; s.textContent = String(p.score);
      li.append(r, n, s); ol.appendChild(li);
    });
  }
  function showBoard() {
    const round = Math.floor(game.turn / game.roster.length) + 1;
    $("#board-progress").textContent = `Round ${round} of ${game.rounds} · ${game.totalTurns - game.turn} turns left`;
    rankList($("#board-list"), { highlightNext: true });
    $("#board-next").textContent = `Start ${currentPlayer().name}'s turn`;
    show("board", { push: false });
  }
  $("#board-next").addEventListener("click", () => { Audio.play("tap"); showReady(); });
  $("#board-end").addEventListener("click", () => {
    Audio.play("tap");
    modal("End the game now?", "We'll crown the winner with the scores so far.", [
      { label: "End and see winner", kind: "btn-primary", fn: showWinner },
      { label: "Keep playing", kind: "btn-ghost" }
    ]);
  });

  /* ---------------- Winner ---------------- */
  function showWinner() {
    const sorted = game.roster.slice().sort((a, b) => b.score - a.score);
    const top = sorted[0].score; const winners = sorted.filter(p => p.score === top);
    $("#win-title").textContent = winners.length > 1 ? "It's a tie!" : winners[0].name;
    $("#win-score").textContent = winners.length > 1 ? winners.map(w => w.name).join(" and ") + ` with ${top} each` : `${top} correct`;
    rankList($("#win-list"));
    endPlaySession();
    show("win", { push: false });
    Audio.stopMusic(); Audio.play("win"); buzz([60, 60, 60, 60, 200]);
    setTimeout(() => { if (current === "win") Audio.startMusic(); }, 1800);
    confetti();
  }
  $("#win-again").addEventListener("click", () => { Audio.play("tap"); startGame(); });
  $("#win-home").addEventListener("click", () => { Audio.play("tap"); history.length = 0; show("home", { push: false }); });

  function confetti() {
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const c = $("#confetti"), ctx = c.getContext("2d"); if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr; ctx.scale(dpr, dpr);
    const W = c.clientWidth, H = c.clientHeight, colors = ["#f5c451", "#2fd18b", "#ff6a55", "#7a52cc", "#fff4dc", "#4cc3ff"];
    const bits = Array.from({ length: 140 }, () => ({ x: Math.random() * W, y: -20 - Math.random() * H * 0.6, w: 6 + Math.random() * 6, h: 10 + Math.random() * 8,
      vy: 2 + Math.random() * 3, vx: -1.5 + Math.random() * 3, r: Math.random() * 6, vr: -0.15 + Math.random() * 0.3, col: colors[randInt(colors.length)] }));
    const t0 = performance.now();
    (function frame(t) {
      if (current !== "win" || t - t0 > 6000) { ctx.clearRect(0, 0, W, H); return; }
      ctx.clearRect(0, 0, W, H);
      bits.forEach(b => { b.x += b.vx; b.y += b.vy; b.r += b.vr; b.vx += Math.sin((t + b.y) / 400) * 0.03;
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.col; ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h * Math.abs(Math.cos(b.r))); ctx.restore(); });
      requestAnimationFrame(frame);
    })(t0);
  }

  /* ---------------- Settings ---------------- */
  function renderSettings() {
    $$("[data-set]").forEach(el => {
      const k = el.dataset.set;
      if (el.type === "checkbox") el.checked = !!settings[k]; else el.value = settings[k];
    });
    setChecked("sens-chips", "data-sens", settings.sens);
    const vs = $("#voice-support");
    if (!Voice.supported) { vs.textContent = "This browser doesn't support voice. Try Chrome on Android or Safari on iPhone."; $('[data-set="ctlVoice"]').disabled = true; }
    $('[data-set="voiceAnswer"]').disabled = !settings.ctlVoice;
  }
  onShow.settings = renderSettings;
  $$("[data-set]").forEach(el => {
    el.addEventListener(el.type === "range" ? "input" : "change", () => {
      const k = el.dataset.set;
      settings[k] = el.type === "checkbox" ? el.checked : Number(el.value);
      if (k === "ctlTilt" || k === "ctlSwipe" || k === "ctlButtons") {
        if (!settings.ctlTilt && !settings.ctlSwipe && !settings.ctlButtons && !settings.ctlVoice) { settings.ctlButtons = true; toast("Kept the on-screen buttons on so you can still play."); }
      }
      saveSettings(); Audio.applyVolumes();
      if (k === "mute" || k === "musicVol") { if (settings.mute || !settings.musicVol) Audio.stopMusic(); else Audio.startMusic(); }
      if (k === "sfxVol" && el.type === "range") Audio.play("tap");
      renderSettings();
    });
  });
  $("#sens-chips").addEventListener("click", e => { const b = e.target.closest("[data-sens]"); if (!b) return; Audio.play("tap"); settings.sens = b.dataset.sens; saveSettings(); renderSettings(); });
  $("#unlock-all").addEventListener("click", () => {
    modal("Unlock every deck?", "Good for leaders running a big game night. Stars you've earned stay the same.", [
      { label: "Unlock all decks", kind: "btn-primary", fn: () => { BUILT_IN.forEach(c => { if (costOf(c)) progress.unlocked.add(c.id); }); saveProgress(); Audio.play("win"); toast("Every deck is unlocked"); } },
      { label: "Cancel", kind: "btn-ghost" }
    ]);
  });
  $("#reset-history").addEventListener("click", () => {
    modal("Reset word history?", "Words you've already seen may show up again sooner.", [
      { label: "Reset", kind: "btn-danger", fn: () => { allCats().forEach(c => store.del("seen." + c.id)); toast("Word history reset"); } },
      { label: "Cancel", kind: "btn-ghost" }
    ]);
  });

  /* ---------------- Custom decks ---------------- */
  let editingId = null;
  function saveCustom() { store.set("custom", customDecks.map(d => ({ id: d.id, name: d.name, items: d.items }))); }
  function renderDecks() {
    const ul = $("#deck-list"); ul.textContent = "";
    customDecks.forEach(d => {
      const li = document.createElement("li"); const b = document.createElement("button");
      const n = document.createElement("span"); n.className = "d-name"; n.textContent = d.name;
      const c = document.createElement("span"); c.className = "d-count"; c.textContent = `${d.items.length} words`;
      b.append(n, c); b.addEventListener("click", () => openDeck(d.id)); li.appendChild(b); ul.appendChild(li);
    });
    $("#deck-empty").hidden = customDecks.length > 0;
  }
  onShow.decks = renderDecks;
  function parseItems(text) { return Array.from(new Set(text.split(/\r?\n/).map(s => s.replace(/\s+/g, " ").trim().slice(0, 60)).filter(Boolean))).slice(0, 500); }
  function openDeck(id) {
    Audio.play("tap"); editingId = id;
    const d = id ? customDecks.find(x => x.id === id) : null;
    $("#deck-edit-title").textContent = d ? "Edit deck" : "New deck";
    $("#deck-name").value = d ? d.name : ""; $("#deck-items").value = d ? d.items.join("\n") : "";
    $("#deck-delete").hidden = !d; $("#deck-error").hidden = true; updateDeckCount();
    show("deck-edit");
  }
  function updateDeckCount() { const n = parseItems($("#deck-items").value).length; $("#deck-count").textContent = `${n} ${n === 1 ? "word" : "words"}`; }
  $("#deck-items").addEventListener("input", updateDeckCount);
  $("#deck-new").addEventListener("click", () => openDeck(null));
  $("#deck-save").addEventListener("click", () => {
    const name = $("#deck-name").value.replace(/\s+/g, " ").trim().slice(0, 40), items = parseItems($("#deck-items").value);
    const err = $("#deck-error");
    if (!name) { err.textContent = "Give your deck a name."; err.hidden = false; return; }
    if (items.length < 5) { err.textContent = "Add at least 5 words, one per line."; err.hidden = false; return; }
    if (editingId) { const d = customDecks.find(x => x.id === editingId); d.name = name; d.items = items; store.del("seen." + d.id); }
    else customDecks.unshift({ id: "custom-" + Date.now().toString(36) + randInt(1e6).toString(36), name, emoji: "⭐", group: "Mine", hue: 45, desc: "Your deck", custom: true, items });
    saveCustom(); customDecks = loadCustom(); Audio.play("correct"); toast(`Saved “${name}”`); back();
  });
  $("#deck-delete").addEventListener("click", () => {
    const d = customDecks.find(x => x.id === editingId); if (!d) return;
    modal(`Delete “${d.name}”?`, "This can't be undone.", [
      { label: "Delete deck", kind: "btn-danger", fn: () => { customDecks = customDecks.filter(x => x.id !== d.id); game.cats.delete(d.id); store.del("seen." + d.id); saveCustom(); store.set("cats", Array.from(game.cats)); toast("Deck deleted"); back(); } },
      { label: "Keep it", kind: "btn-ghost" }
    ]);
  });

  /* ---------------- About ---------------- */
  $("#app-version").textContent = VERSION;
  $("#copy-year").textContent = String(new Date().getFullYear());

  /* Android back button / browser back: keep people inside the game */
  try {
    window.history.pushState({ tt: 1 }, "");
    window.addEventListener("popstate", () => {
      window.history.pushState({ tt: 1 }, "");
      if (!$("#modal").hidden) { closeModal(); if (current === "play" && turn.paused) resumeTurn(); return; }
      if (current === "play") pauseTurn();
      else if (["ready", "board", "results"].includes(current)) confirmQuit();
      else if (current !== "home") back();
    });
  } catch (e) {}

  /* Offline support + update check.
     version.json is published next to the game by the release workflow. */
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").then(reg => {
        fetch("version.json", { cache: "no-store" }).then(r => r.ok ? r.json() : null).then(v => {
          if (v && typeof v.version === "string" && v.version !== VERSION) {
            reg.update().catch(() => {});
            toast("A new version is ready. Close and reopen the game to update.");
          }
        }).catch(() => {});
      }).catch(() => {});
    });
  }

  // Expose a tiny hook for automated tests only (no secrets, read-only state)
  window.__TT = { game, turn, settings, buildDeck, Tilt, score: (o) => score(o, "test") };
})();
