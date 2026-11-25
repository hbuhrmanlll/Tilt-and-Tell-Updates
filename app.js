/* Tilt & Tell — game logic. Made by Third Heaven Studios.
   No tracking. Everything is stored on the device. The only network call is the
   update check, which reads the public version.json. */
(function () {
  "use strict";

  const VERSION = "1.6.0";
  // Present only inside the Android app (see android/…/MainActivity.java)
  const APP = typeof window.TTApp !== "undefined" ? window.TTApp : null;
  const UPDATES_BASE = "https://hbuhrmanlll.github.io/Tilt-and-Tell-Updates/";
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
    tiltFlip: false, swipeSwap: false, ctlWave: false, turnMusic: true, golden: true, sens: "med", oneWord: true, mute: false, sfxVol: 80, musicVol: 35, haptics: true
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
    "fairy-tales": 35, "fantasy": 35, "body": 40, "states": 40, "impressions": 40, "phrases": 40,
    "breakfast": 10, "bugs-birds": 10, "farm-pets": 10, "plants": 15, "bible-books": 15, "house": 15,
    "clothes": 20, "summer": 20, "winter": 20, "fall": 20, "spring-easter": 20, "tools": 25, "space": 25, "town": 25,
    "crafts": 30, "history": 35
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
    let ctx = null, master = null, sfxBus = null, musicBus = null, musicTimer = null, musicOn = false, nextBeat = 0, beatIdx = 0, mode = "menu", level = 0;
    // Recorded turn music (from Suno): "turn" plays during a turn, "rush" takes over for the last 10 seconds.
    // If the files can't load, the built-in synth music plays instead.
    let trackBus = null, tracksOn = false, trackStatus = "loading"; const bufs = {}, srcs = {}, gains = {};
    // Start downloading the music right away, so it's ready before the first turn
    const raw = {};
    function getRaw(n) {
      return fetch("music/" + n + ".mp3").then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error("HTTP " + r.status)));
    }
    ["turn", "rush"].forEach(n => { raw[n] = getRaw(n); raw[n].catch(() => {}); });
    function ensure() {
      if (ctx) { if (ctx.state === "suspended") ctx.resume(); return true; }
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false;
      ctx = new AC(); master = ctx.createGain();
      // A gentle limiter keeps louder music and effects from crackling on phone speakers
      const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 6; comp.attack.value = 0.004; comp.release.value = 0.2;
      master.connect(comp); comp.connect(ctx.destination);
      sfxBus = ctx.createGain(); sfxBus.connect(master);
      musicBus = ctx.createGain(); musicBus.connect(master);
      trackBus = ctx.createGain(); trackBus.connect(master);
      applyVolumes(); loadTracks(); return true;
    }
    function applyVolumes() {
      if (!ctx) return;
      master.gain.value = settings.mute ? 0 : 1;
      sfxBus.gain.value = (settings.sfxVol / 100) * 0.9;
      musicBus.gain.value = musicLevel();
      trackBus.gain.value = trackLevel();
    }
    // Recorded music level: quieter when voice control is on so the phone can still hear you
    // Menus play the same track softly in the background
    function trackLevel() {
      const base = Math.min(1, (settings.musicVol / 100) * 1.6);
      return mode === "menu" ? base * 0.45 : base * (settings.ctlVoice ? 0.55 : 1) * [1, 1.12, 1.25][level];
    }
    function decode(a) { return new Promise((res, rej) => { const pr = ctx.decodeAudioData(a, res, rej); if (pr && pr.catch) pr.catch(rej); }); }
    function loadTracks() {
      Promise.all(["turn", "rush"].map(n =>
        raw[n].catch(() => getRaw(n)) // one retry if the first download failed
          .then(decode)
          .then(b => { bufs[n] = b; if (musicOn) startMusic(mode); /* swap the backup beat for the real music */ })
      )).then(() => { trackStatus = "ready"; }, e => { trackStatus = "failed: " + ((e && (e.message || e.name)) || "unknown"); });
    }
    function startTrack(n, at, fadeIn) {
      stopTrack(n, at, 0.03);
      const src = ctx.createBufferSource(), g = ctx.createGain();
      src.buffer = bufs[n]; src.loop = true;
      if (n === "rush" && level === 2) src.playbackRate.value = 1.06;
      g.gain.setValueAtTime(0.0001, at); g.gain.linearRampToValueAtTime(1, at + fadeIn);
      src.connect(g); g.connect(trackBus); src.start(at);
      srcs[n] = src; gains[n] = g;
    }
    function stopTrack(n, at, fade) {
      const src = srcs[n], g = gains[n]; if (!src) return;
      g.gain.cancelScheduledValues(at); g.gain.setValueAtTime(g.gain.value, at); g.gain.linearRampToValueAtTime(0.0001, at + fade);
      try { src.stop(at + fade + 0.05); } catch (e) { /* already stopped */ }
      srcs[n] = null;
    }
    // Turn music is a bit quieter, and quieter still when voice is on so the phone can hear you
    function musicLevel() { return (settings.musicVol / 100) * 0.32 * (mode === "turn" ? (settings.ctlVoice ? 1.3 : 2.4) * [1, 1.35, 1.6][level] : 1); }
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
      correct(streak) {
        // each answer in a streak rings a little higher
        const t = ctx.currentTime, k = Math.pow(2, Math.min(streak || 0, 8) / 24);
        tone(784 * k, t, 0.12, { type: "triangle", vol: 0.32 }); tone(1175 * k, t + 0.08, 0.22, { type: "triangle", vol: 0.32 }); tone(1568 * k, t + 0.16, 0.28, { type: "sine", vol: 0.18 });
      },
      golden() { const t = ctx.currentTime; [1047, 1319, 1568, 2093, 2637].forEach((f, i) => tone(f, t + i * 0.05, 0.3, { type: "sine", vol: 0.16 })); noise(t + 0.1, 0.25, 0.05, 6000); },
      streak() { const t = ctx.currentTime; tone(523, t, 0.1, { type: "square", vol: 0.1, filter: 2400 }); tone(784, t + 0.07, 0.1, { type: "square", vol: 0.1, filter: 2400 }); tone(1047, t + 0.14, 0.22, { type: "square", vol: 0.12, filter: 2400 }); },

      pass() { const t = ctx.currentTime; tone(330, t, 0.28, { type: "sawtooth", vol: 0.18, slideTo: 196, filter: 1400 }); },
      tick(urgent) { const t = ctx.currentTime; tone(urgent ? 1400 : 1000, t, 0.05, { type: "square", vol: urgent ? 0.1 : 0.06, filter: 3000 }); noise(t, 0.02, 0.05, 4000); },
      count(n) { const t = ctx.currentTime; tone(n > 0 ? 660 : 990, t, n > 0 ? 0.16 : 0.4, { type: "triangle", vol: 0.3 }); if (n === 0) tone(1320, t, 0.4, { type: "sine", vol: 0.15 }); },
      timeup() { const t = ctx.currentTime; tone(440, t, 0.3, { type: "square", vol: 0.16, filter: 1800 }); tone(349, t + 0.28, 0.5, { type: "square", vol: 0.16, filter: 1800 }); },
      win() { const t = ctx.currentTime; [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, t + i * 0.12, i === 5 ? 0.6 : 0.16, { type: "triangle", vol: 0.28 })); noise(t + 0.7, 0.4, 0.06, 5000); }
    };
    function play(name, arg) { if (settings.mute || !settings.sfxVol) return; if (!ensure()) return; try { sfx[name](arg); } catch (e) {} }

    /* Music: one bouncy four-chord loop.
       Menu: relaxed, 96 BPM.
       Turn: 116 BPM with a light kick and hi-hat.
       Last 10 seconds: speeds up, jumps up a key, and the drums get busier.
       Last 3 seconds: faster again with a rising synth pulse. */
    const CHORDS = [[261.6, 329.6, 392.0], [220.0, 261.6, 329.6], [174.6, 220.0, 261.6], [196.0, 246.9, 293.7]];
    const BASS = [130.8, 110.0, 87.3, 98.0];
    const MELODY = [784, 0, 659, 0, 587, 659, 0, 523, 659, 0, 523, 0, 440, 523, 0, 0, 698, 0, 659, 0, 587, 523, 0, 440, 587, 0, 494, 0, 523, 0, 0, 0];
    const bpm = () => mode === "menu" ? 96 : [112, 150, 176][level];
    const key = () => mode === "menu" ? 1 : [1, Math.pow(2, 3 / 12), Math.pow(2, 5 / 12)][level];
    // Rush arpeggio (replaces the relaxed tune in the last 10 seconds): fast up-and-down notes
    const RUSH = [0, 4, 7, 12, 7, 4, 0, 7];
    function hat(t, vol) {
      const len = Math.floor(ctx.sampleRate * 0.03), b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ctx.createBufferSource(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      f.type = "highpass"; f.frequency.value = 6000; g.gain.value = vol; src.buffer = b; src.connect(f); f.connect(g); g.connect(musicBus); src.start(t);
    }
    function kick(t, vol) { tone(140, t, 0.16, { type: "sine", vol, slideTo: 45, bus: musicBus }); tone(900, t, 0.02, { type: "triangle", vol: vol * 0.35, slideTo: 300, bus: musicBus }); }
    function schedule() {
      while (nextBeat < ctx.currentTime + 0.25) {
        const STEP = 60 / bpm() / 2, k = key(); // eighth notes
        const bar = Math.floor(beatIdx / 8) % 4, step = beatIdx % 8, t = nextBeat;
        if (step === 0 || step === 4) CHORDS[bar].forEach(f => tone(f * k, t, STEP * 3.6, { type: "triangle", vol: 0.05, attack: 0.03, bus: musicBus, filter: 1500 }));
        if (step % 2 === 0) tone(BASS[bar] * k, t, STEP * 1.6, { type: "sine", vol: 0.2, bus: musicBus });
        if (mode === "turn" && step % 2 === 0) tone(BASS[bar] * k * 2, t, STEP * 1.4, { type: "triangle", vol: 0.12, bus: musicBus, filter: 1200 });
        if (mode === "turn" && level > 0) {
          // two fast arpeggio notes per beat step, like an alarm-y "hurry up" riff
          const root = CHORDS[bar][0] * 2 * k;
          [0, 1].forEach(h => tone(root * Math.pow(2, RUSH[(beatIdx * 2 + h) % 8] / 12), t + h * STEP / 2, STEP * 0.42, { type: "square", vol: level === 2 ? 0.07 : 0.055, bus: musicBus, filter: 3200 }));
        } else {
          const m = MELODY[beatIdx % 32]; if (m) tone(m * k, t, STEP * 0.9, { type: mode === "turn" ? "triangle" : "sine", vol: mode === "turn" ? 0.09 : 0.06, bus: musicBus });
        }
        if (mode === "menu") { if (step % 2 === 1) hat(t, 0.05); }
        else {
          if (step === 0 || step === 4 || (level > 0 && step % 2 === 0)) kick(t, level ? 0.3 : 0.22);
          hat(t, step % 2 ? 0.07 : 0.04);
          if (level > 0) hat(t + STEP / 2, 0.04);
          if (level > 0 && (step === 2 || step === 6)) { /* clap on the backbeat */
            const len = Math.floor(ctx.sampleRate * 0.08), b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
            for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
            const src = ctx.createBufferSource(), g = ctx.createGain(), f = ctx.createBiquadFilter();
            f.type = "bandpass"; f.frequency.value = 1500; g.gain.value = 0.18; src.buffer = b; src.connect(f); f.connect(g); g.connect(musicBus); src.start(t);
          }
          if (level === 2) tone(BASS[bar] * k * 4 * (1 + (beatIdx % 8) / 16), t, STEP * 0.7, { type: "square", vol: 0.035, bus: musicBus, filter: 2200 });
        }
        nextBeat += STEP; beatIdx++;
      }
    }
    function startMusic(m) {
      const want = m === "turn" ? "turn" : "menu";
      if (settings.mute || !settings.musicVol) return;
      if (!ensure()) return;
      const now = ctx.currentTime;
      if (want === "turn" ? (bufs.turn && bufs.rush) : bufs.turn) {
        if (tracksOn && mode === want) return;
        // hand over from the backup synth beat to the recorded music
        if (musicOn) { musicOn = false; clearInterval(musicTimer); musicBus.gain.cancelScheduledValues(now); musicBus.gain.setTargetAtTime(0.0001, now, 0.1); }
        stopTrack("turn", now, 0.25); stopTrack("rush", now, 0.25);
        mode = want; if (want === "menu") level = 0; tracksOn = true;
        trackBus.gain.cancelScheduledValues(now); trackBus.gain.setValueAtTime(trackLevel(), now);
        startTrack(want === "turn" && level > 0 ? "rush" : "turn", now + 0.02, want === "turn" ? 0.3 : 1.2);
        return;
      }
      if (tracksOn) { tracksOn = false; stopTrack("turn", now, 0.4); stopTrack("rush", now, 0.4); }
      if (musicOn && mode === want) return;
      mode = want; if (want === "menu") level = 0;
      musicBus.gain.cancelScheduledValues(ctx.currentTime);
      musicBus.gain.setValueAtTime(0.0001, ctx.currentTime);
      musicBus.gain.linearRampToValueAtTime(musicLevel(), ctx.currentTime + (want === "turn" ? 0.4 : 1.2));
      if (musicOn) return;
      musicOn = true; nextBeat = ctx.currentTime + 0.1; beatIdx = 0;
      musicTimer = setInterval(schedule, 90); schedule();
    }
    function setLevel(n) {
      const nl = Math.max(0, Math.min(2, n | 0));
      if (nl === level) return;
      const up = nl > level; level = nl;
      if (!ctx || mode !== "turn" || !(musicOn || tracksOn)) return;
      // Louder in the rush, plus a "whoosh" riser so everyone hears the change
      const now = ctx.currentTime, bus = tracksOn ? trackBus : musicBus;
      if (tracksOn) {
        trackBus.gain.cancelScheduledValues(now); trackBus.gain.setTargetAtTime(trackLevel(), now, 0.08);
        if (level >= 1 && !srcs.rush) { stopTrack("turn", now, 0.35); startTrack("rush", now, 0.12); }
        else if (level === 0 && !srcs.turn) { stopTrack("rush", now, 0.3); startTrack("turn", now, 0.3); }
        // last 3 seconds: the rush track speeds up a little
        if (srcs.rush) srcs.rush.playbackRate.setTargetAtTime(level === 2 ? 1.06 : 1, now, 0.05);
      } else {
        musicBus.gain.cancelScheduledValues(now);
        musicBus.gain.setTargetAtTime(musicLevel(), now, 0.08);
      }
      if (up) {
        tone(220 * level, now, 0.7, { type: "sawtooth", vol: 0.12, slideTo: 1760, bus, filter: 2600 });
        const len = Math.floor(ctx.sampleRate * 0.7), b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (i / len);
        const src = ctx.createBufferSource(), g = ctx.createGain(), f = ctx.createBiquadFilter();
        f.type = "bandpass"; f.frequency.setValueAtTime(600, now); f.frequency.exponentialRampToValueAtTime(7000, now + 0.7);
        g.gain.value = 0.25; src.buffer = b; src.connect(f); f.connect(g); g.connect(bus); src.start(now);
      }
    }
    function stopMusic() {
      if (tracksOn && ctx) { tracksOn = false; stopTrack("turn", ctx.currentTime, 0.3); stopTrack("rush", ctx.currentTime, 0.3); }
      if (!musicOn) return; musicOn = false; clearInterval(musicTimer);
      if (ctx) { musicBus.gain.cancelScheduledValues(ctx.currentTime); musicBus.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.15); }
    }
    return { ensure, play, startMusic, stopMusic, setLevel, applyVolumes, get musicOn() { return musicOn || tracksOn; }, get tracksReady() { return !!(bufs.turn && bufs.rush); }, get tracksOn() { return tracksOn; }, get trackStatus() { return trackStatus; } };
  })();

  function buzz(pattern) {
    if (!settings.haptics) return;
    if (APP) { try { APP.vibrate([].concat(pattern)[0] || 20); } catch (e) {} return; }
    if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) {} }
  }

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
    if ($("#toast").classList.contains("show")) requestAnimationFrame(placeToast);
  }
  function back() { const p = history.pop() || "home"; show(p, { push: false }); }
  const onShow = {};

  document.addEventListener("click", e => {
    const nav = e.target.closest("[data-nav]"); if (nav) { Audio.play("tap"); show(nav.dataset.nav); return; }
    if (e.target.closest("[data-back]")) { Audio.play("tap"); back(); }
  });

  // Keep the toast just above the current screen's bottom buttons so it never covers them
  function placeToast() {
    const t = $("#toast"), dock = document.querySelector(".screen.is-active .dock");
    const top = dock && dock.offsetParent ? dock.getBoundingClientRect().top : 0;
    t.style.setProperty("--toast-b", top > 0 ? (window.innerHeight - top + 12) + "px" : "");
  }
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; placeToast();
    // measure again after any screen change in the same tap has laid out
    requestAnimationFrame(() => requestAnimationFrame(placeToast));
    t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2200); }

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
    persistSetup(); show("cats"); askPickMode();
  });

  /* ---------------- Categories ---------------- */
  const LOCK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  const NEW_DECKS = new Set(["fruits-veggies", "sweets", "breakfast", "bugs-birds", "farm-pets", "plants", "bible-books", "faith-words", "house", "clothes", "tools", "superpowers", "space", "summer", "winter", "fall", "spring-easter", "crafts", "dances", "animal-acts", "town", "history", "colors-shapes", "baby-animals"]);
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
    let shown = 0; const jumps = [];
    groups.forEach(g => {
      const inGroup = cats.filter(c => c.group === g); if (!inGroup.length) return;
      const h = document.createElement("h3"); h.className = "cat-group-title"; h.textContent = GROUP_LABEL[g] || g; h.id = "grp-" + g.replace(/\W+/g, "-"); list.appendChild(h);
      jumps.push([g, h.id]);
      const grid = document.createElement("div"); grid.className = "cat-grid";
      inGroup.forEach(c => {
        const b = document.createElement("button"); b.className = "cat-tile"; b.style.setProperty("--h", c.hue);
        const locked = !isUnlocked(c), n = itemsFor(c).length;
        b.setAttribute("aria-pressed", String(game.cats.has(c.id)));
        if (locked) b.classList.add("is-locked");
        if (NEW_DECKS.has(c.id)) { const nw = document.createElement("span"); nw.className = "cat-new"; nw.textContent = "NEW"; b.append(nw); }
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
          if (pickMode === "one") { pickOne(c, b); return; }
          if (game.cats.has(c.id)) game.cats.delete(c.id); else game.cats.add(c.id);
          b.setAttribute("aria-pressed", String(game.cats.has(c.id))); store.set("cats", Array.from(game.cats)); updateCatsGo();
        });
        grid.appendChild(b); shown++;
      });
      list.appendChild(grid);
    });
    $("#cat-empty").hidden = shown > 0;
    // Jump chips: one tap to a section, since there are lots of decks now
    const jb = $("#cat-jumps"); jb.textContent = "";
    if (!q && jumps.length > 2) jumps.forEach(([g, id]) => {
      const j = document.createElement("button"); j.textContent = GROUP_LABEL[g] || g;
      j.addEventListener("click", () => { Audio.play("tap"); const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); });
      jb.appendChild(j);
    });
    jb.hidden = !jb.children.length;
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
  /* One deck or a mix? Asked each time you get to the category screen. */
  let pickMode = store.get("pickMode", "one");
  function syncPickUi() {
    setChecked("pick-chips", "data-pick", pickMode);
    $("#cats-title").textContent = pickMode === "one" ? "Pick a category" : "Pick categories";
    $("#screen-cats").classList.toggle("is-one", pickMode === "one");
  }
  function setPickMode(m) {
    pickMode = m === "mix" ? "mix" : "one"; store.set("pickMode", pickMode);
    if (pickMode === "one" && game.cats.size > 1) { game.cats.clear(); store.set("cats", []); }
    syncPickUi(); renderCats();
  }
  function askPickMode() {
    modal("How do you want to play?", "Play one category, or mix a few together for a wild round.", [
      { label: "🎯 One category", kind: "btn-primary", fn: () => setPickMode("one") },
      { label: "🎲 Mix several", kind: "btn-ghost", fn: () => setPickMode("mix") }
    ]);
  }
  function pickOne(c, b) {
    game.cats.clear(); game.cats.add(c.id); store.set("cats", [c.id]);
    $$("#cat-list .cat-tile").forEach(t => t.setAttribute("aria-pressed", "false"));
    b.setAttribute("aria-pressed", "true"); b.classList.add("is-chosen"); buzz(25);
    setTimeout(() => { b.classList.toggle("is-chosen", false); if (current === "cats") startGame(); }, 380);
  }
  $("#pick-chips").addEventListener("click", e => { const x = e.target.closest("[data-pick]"); if (!x) return; Audio.play("tap"); setPickMode(x.dataset.pick); });
  function updateCatsGo() {
    const n = game.cats.size, btn = $("#cats-go");
    const words = Array.from(game.cats).reduce((s, id) => { const c = catById(id); return s + (c ? itemsFor(c).length : 0); }, 0);
    btn.disabled = n === 0;
    btn.textContent = n === 0 ? "Pick at least one" : n === 1 ? `Play ${catById(Array.from(game.cats)[0]).name}` : `Play ${n} categories (${words} words)`;
  }
  onShow.cats = () => { syncPickUi(); renderCats(); };
  $("#cat-search").addEventListener("input", renderCats);
  $("#cats-surprise").addEventListener("click", () => {
    Audio.play("tap"); game.cats.clear();
    const pool = shuffle(BUILT_IN.filter(c => c.group !== "Easy" && playable(c)).slice()); const k = pickMode === "one" ? 1 : 3; pool.slice(0, k).forEach(c => game.cats.add(c.id));
    store.set("cats", Array.from(game.cats)); $("#cat-search").value = ""; renderCats();
    toast("Picked: " + pool.slice(0, k).map(c => c.name).join(", "));
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
    let tip = tips[0];
    if (settings.ctlWave && Wave.supported) tip += ` Wave a hand across the camera: ${settings.swipeSwap ? "side to side for Got it, up or down to Pass" : "up or down for Got it, side to side to Pass"}.`;
    $("#ready-tip").textContent = tip;
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
  const turn = { deck: [], idx: 0, results: [], left: 0, running: false, paused: false, lock: false, timer: null, endAt: 0, wordShownAt: 0, waitTimer: null, streak: 0, lastOutcome: "" };

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
    turn.idx = 0; turn.results = []; turn.left = game.time; turn.running = false; turn.paused = false; turn.lock = true; turn.streak = 0; turn.lastOutcome = "";
    turn.deck.forEach(d => { d.golden = false; });
    $("#hud-streak").hidden = true; $("#play-stage").classList.remove("is-hurry", "is-golden");
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
    Tilt.start(); Wave.start();
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
    Audio.setLevel(0); if (settings.turnMusic) Audio.startMusic("turn");
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
    $("#play-stage").classList.toggle("is-hurry", turn.running && whole <= 10 && whole > 0);
    if (turn.running) Audio.setLevel(whole <= 3 ? 2 : whole <= 10 ? 1 : 0);
  }

  function nextWord() {
    if (turn.idx >= turn.deck.length) { // ran out: reshuffle everything
      turn.deck = turn.deck.concat(shuffle(turn.deck.slice())); }
    const item = turn.deck[turn.idx];
    const hue = item.cat.hue;
    $("#play-stage").style.setProperty("--ph", hue);
    $("#play-wait").style.setProperty("--ph", hue);
    $("#play-cat").textContent = (game.mode === "quick" ? "" : currentPlayer().name + " · ") + item.cat.name;
    // About one card in seven is a golden card worth double (never the first card)
    item.golden = !!(settings.golden && turn.idx > 0 && randInt(7) === 0);
    $("#play-stage").classList.toggle("is-golden", item.golden);
    $("#play-golden").hidden = !item.golden;
    $("#play-emoji").textContent = item.cat.emoji || "";
    $("#play-stage").scrollTop = 0;
    const w = $("#play-word"); w.textContent = item.word;
    w.classList.remove("pop", "pop-up", "pop-side"); void w.offsetWidth;
    w.classList.add(turn.lastOutcome === "got" ? "pop-up" : turn.lastOutcome === "pass" ? "pop-side" : "pop");
    if (item.golden) Audio.play("golden");
    if (APP && APP.setSpeechHint) { try { APP.setSpeechHint(item.word); } catch (e) {} }
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

  /* Points: golden cards count double */
  const pointsOf = r => r.got ? (r.golden ? 2 : 1) : 0;
  const turnPoints = list => list.reduce((n, r) => n + pointsOf(r), 0);
  /* Little burst of sparks behind "Got it!" */
  function burst(gold) {
    const box = $("#po-burst"); box.textContent = "";
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const n = gold ? 16 : 10;
    for (let i = 0; i < n; i++) {
      const d = document.createElement("i"), a = (i / n) * Math.PI * 2 + Math.random() * 0.4, r = 120 + Math.random() * 120;
      d.style.setProperty("--dx", Math.cos(a) * r + "px"); d.style.setProperty("--dy", Math.sin(a) * r + "px");
      d.style.setProperty("--s", (0.6 + Math.random() * 0.8).toFixed(2));
      box.appendChild(d);
    }
  }
  /* Stats for one turn's results */
  function turnStats(list) {
    let best = 0, run = 0, fastest = null, golden = 0;
    list.forEach(r => { if (r.got) { run++; best = Math.max(best, run); if (r.ms && (fastest === null || r.ms < fastest)) fastest = r.ms; if (r.golden) golden++; } else run = 0; });
    return { points: turnPoints(list), got: list.filter(r => r.got).length, passes: list.filter(r => !r.got).length, seen: list.length, best, fastest, golden };
  }

  /* outcome: "got" or "pass"; source used for feedback text */
  function score(outcome, source) {
    if (!turn.running || turn.paused || turn.lock) return;
    if (source !== "button" && source !== "key" && performance.now() - turn.wordShownAt < 250) return; // ignore accidental double triggers
    turn.lock = true;
    const item = turn.deck[turn.idx], isGot = outcome === "got";
    turn.results.push({ word: item.word, cat: item.cat, got: isGot, golden: !!item.golden, ms: Math.round(performance.now() - turn.wordShownAt) });
    markSeen(item.cat, item.word);
    turn.streak = isGot ? turn.streak + 1 : 0; turn.lastOutcome = outcome;
    $("#play-score").textContent = String(turnPoints(turn.results));
    const chip = $("#hud-streak"); chip.hidden = turn.streak < 3; chip.textContent = `🔥 ${turn.streak}`;
    const ov = $("#play-overlay");
    ov.className = "play-overlay show " + (isGot ? (item.golden ? "good gold" : "good") : "bad");
    $("#po-big").textContent = isGot ? (item.golden ? "Double!" : "Got it!") : "Pass";
    let small = item.word + (source === "voice-answer" ? " (heard it)" : "");
    if (isGot && turn.streak >= 3) small += ` · 🔥 ${turn.streak} in a row`;
    $("#po-small").textContent = small;
    if (isGot) burst(item.golden);
    Audio.play(isGot ? "correct" : "pass", turn.streak);
    if (isGot && turn.streak > 0 && turn.streak % 5 === 0) Audio.play("streak");
    buzz(isGot ? (item.golden ? [30, 40, 30] : 35) : 70);
    setTimeout(() => {
      ov.className = "play-overlay";
      if (!turn.running) return;
      turn.idx++; nextWord(); turn.lock = false;
    }, 200);
  }

  function timeUp() {
    if (!turn.running) return;
    turn.running = false; clearInterval(turn.timer); Voice.stop(); Tilt.stop(); Wave.stop(); Audio.stopMusic();
    turn.left = 0; updateTimer(); $("#play-stage").classList.remove("is-hurry");
    // the word on screen when time ran out counts as a pass only if it was never answered
    const ov = $("#play-overlay"); ov.className = "play-overlay show time";
    $("#po-big").textContent = "Time's up!"; $("#po-small").textContent = "Flip the phone over to see how you did";
    Audio.play("timeup"); buzz([200, 80, 200]);
    setTimeout(() => { ov.className = "play-overlay"; exitFullscreen(); showResults(); }, 1600);
  }

  function pauseTurn() {
    if (!turn.running || turn.paused) return;
    turn.paused = true; turn.left = Math.max(0, (turn.endAt - performance.now()) / 1000); Voice.stop(); Wave.stop(); Audio.stopMusic();
    modal("Paused", `${Math.ceil(turn.left)} seconds left.`, [
      { label: "Resume", kind: "btn-primary", fn: resumeTurn },
      { label: "End this turn", kind: "btn-ghost", fn: () => { turn.paused = false; turn.endAt = performance.now(); tickTimer(); } },
      { label: "Quit game", kind: "btn-danger", fn: () => { endPlaySession(); history.length = 0; show("home", { push: false }); } }
    ]);
  }
  function resumeTurn() { turn.paused = false; turn.endAt = performance.now() + turn.left * 1000; turn.wordShownAt = performance.now(); Voice.start(); Wave.start(); if (settings.turnMusic) Audio.startMusic("turn"); }
  function endPlaySession() {
    turn.running = false; turn.paused = false; clearInterval(turn.timer); clearTimeout(turn.waitTimer); turn.countingDown = false;
    Voice.stop(); Tilt.stop(); Wave.stop(); Audio.stopMusic(); exitFullscreen(); releaseAwake(); $("#play-wait").classList.remove("show"); $("#play-overlay").className = "play-overlay";
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
    // Fires as soon as the finger has moved far enough, so a quick flick counts even if the
    // phone cancels the touch before the finger lifts.
    const stage = $("#play-stage"); let sx = 0, sy = 0, st = 0, active = false, pid = null;
    function check(x, y, final) {
      if (!active) return;
      const dx = x - sx, dy = y - sy, dt = performance.now() - st, dist = Math.hypot(dx, dy);
      if (dt > 1200) { active = false; return; }
      if (dist < (final ? 40 : 70)) { if (final) active = false; return; }
      active = false; if (!settings.ctlSwipe) return;
      const vertical = Math.abs(dy) > Math.abs(dx);
      score(vertical !== settings.swipeSwap ? "got" : "pass", "swipe");
    }
    stage.addEventListener("pointerdown", e => {
      if (e.target.closest("button")) return;
      active = true; pid = e.pointerId; sx = e.clientX; sy = e.clientY; st = performance.now();
      try { stage.setPointerCapture(e.pointerId); } catch (err) {}
    });
    stage.addEventListener("pointermove", e => { if (e.pointerId === pid) check(e.clientX, e.clientY, false); });
    stage.addEventListener("pointerup", e => { if (e.pointerId === pid) check(e.clientX, e.clientY, true); });
    stage.addEventListener("pointercancel", e => { if (e.pointerId === pid) check(e.clientX, e.clientY, true); });
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

  /* ---------------- Hand wave (front camera) ----------------
     With the phone on your forehead, wave a hand across the front camera.
     Up or down = Got it, side to side = Pass (or flipped with the swipe/wave flip switch).
     The camera picture is shrunk to a tiny 48 x 36 grid and compared frame to frame on the phone.
     Nothing is shown, saved or sent anywhere. The camera is only on while you're playing. */
  const Wave = (() => {
    let stream = null, video = null, cv = null, ctx = null, loop = 0, prev = null, track = [], hold = 0, starting = false, warned = false;
    const supported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    function stopTracks() { if (stream) stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); stream = null; }
    function chip(state) { const c = $("#hud-wave"); if (!c) return; c.hidden = !state; c.classList.toggle("hit", state === "hit"); }
    async function start() {
      if (!settings.ctlWave || stream || starting) { if (stream) chip(true); return; }
      if (!supported) { if (!warned) { warned = true; toast("This device can't use the camera for hand waves."); } return; }
      starting = true;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user", width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 20 } } });
      } catch (e) {
        starting = false; stream = null;
        if (!warned) { warned = true; toast("Hand waves are off. Camera access wasn't allowed."); }
        return;
      }
      starting = false;
      if (current !== "play" || !settings.ctlWave) { stopTracks(); return; }
      video = document.createElement("video"); video.muted = true; video.playsInline = true; video.setAttribute("playsinline", "");
      video.srcObject = stream;
      try { await video.play(); } catch (e) {}
      cv = document.createElement("canvas"); ctx = cv.getContext("2d", { willReadFrequently: true });
      prev = null; track = []; hold = 0;
      clearInterval(loop); loop = setInterval(frame, 50);
      chip(true);
    }
    function stop() {
      clearInterval(loop); loop = 0; stopTracks();
      if (video) { try { video.pause(); video.srcObject = null; } catch (e) {} } video = null; prev = null; track = [];
      chip(false);
    }
    function frame() {
      if (!video || video.readyState < 2) return;
      const vw = video.videoWidth, vh = video.videoHeight; if (!vw || !vh) return;
      const w = vw >= vh ? 48 : 36, h = vw >= vh ? 36 : 48;
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; prev = null; }
      ctx.drawImage(video, 0, 0, w, h);
      const px = ctx.getImageData(0, 0, w, h).data, n = w * h, g = new Float32Array(n);
      let mean = 0;
      for (let i = 0; i < n; i++) { const v = px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11; g[i] = v; mean += v; }
      mean /= n;
      for (let i = 0; i < n; i++) g[i] -= mean; // ignore the camera brightening or darkening the whole picture
      const last = prev; prev = g;
      if (!last) return;
      const now = performance.now();
      if (!turn.running || turn.paused || turn.lock || now < hold) { track = []; return; }
      // Moving pixels: big change since the last frame
      let cnt = 0, sx = 0, sy = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (Math.abs(g[i] - last[i]) > 34) { cnt++; sx += x; sy += y; }
      }
      const frac = cnt / n;
      // Almost the whole picture changed: the phone itself moved (a tilt or a bump), not a hand
      if (frac > 0.6) { track = []; hold = now + 350; return; }
      // The phone is tilted (someone is using tilt right now): stay out of the way
      const up = Tilt.lastUp; if (up !== null && Math.abs(up) > 0.45) { track = []; return; }
      if (frac > 0.04) {
        // Screen is sideways but the camera picture is upright (or the other way round): swap the axes
        const swap = (vw < vh) !== (window.innerWidth < window.innerHeight);
        let cx = sx / cnt / w, cy = sy / cnt / h; if (swap) { const t = cx; cx = cy; cy = t; }
        track.push({ t: now, cx, cy });
        if (now - track[0].t > 1100) track.shift();
        decide(false);
      } else if (track.length) decide(true);
    }
    function decide(ended) {
      if (track.length < 4) { if (ended) track = []; return; }
      let minX = 1, maxX = 0, minY = 1, maxY = 0;
      track.forEach(p => { minX = Math.min(minX, p.cx); maxX = Math.max(maxX, p.cx); minY = Math.min(minY, p.cy); maxY = Math.max(maxY, p.cy); });
      const a = track[0], b = track[track.length - 1];
      const dx = Math.abs(b.cx - a.cx), dy = Math.abs(b.cy - a.cy);
      const spanX = maxX - minX, spanY = maxY - minY;
      const need = ended ? 0.36 : 0.5; // fire early on a big sweep, otherwise when the hand leaves
      let dir = null;
      if (Math.max(dy, spanY * 0.8) > need && dy > dx * 1.6) dir = "vertical";
      else if (Math.max(dx, spanX * 0.8) > need && dx > dy * 1.6) dir = "side";
      if (dir) {
        track = []; hold = performance.now() + 1100;
        const c = $("#hud-wave"); if (c) { c.classList.remove("hit"); void c.offsetWidth; c.classList.add("hit"); }
        score((dir === "vertical") !== settings.swipeSwap ? "got" : "pass", "wave");
      } else if (ended) track = [];
    }
    return { start, stop, get supported() { return supported; }, get on() { return !!stream; } };
  })();

  /* ---------------- Voice ---------------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const NATIVE_SR = !!(APP && (() => { try { return APP.speechAvailable(); } catch (e) { return false; } })());
  const Voice = (() => {
    let rec = null, want = false, windowText = "", cooldownUntil = 0, failed = false;
    const norm = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    const STOP = new Set(["the", "a", "an", "of", "and", "to", "in", "on", "at", "your", "my", "for", "with"]);
    const GOT = /\b(got it|gotcha|got that|i got it|we got it|correct|that's it|thats it)\b/;
    const PASS = /\b(pass|skip|next one)\b/;
    // Edit distance, so "hulk buster", "hulkbusters" or a near-miss like "hulkbustor" still count
    function lev(a, b) {
      if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
      let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
      for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
      }
      return prev[b.length];
    }
    // Short words must match exactly; longer words may be off by one (6+ letters) or two (9+ letters)
    function close(heardWord, target) {
      if (heardWord === target || heardWord === target + "s" || heardWord + "s" === target || heardWord === target + "es") return true;
      const L = target.length; if (L < 6) return false;
      return Math.abs(heardWord.length - L) <= 2 && lev(heardWord, target) <= (L >= 9 ? 2 : 1);
    }
    function answerHeard(text) {
      if (!settings.voiceAnswer) return false;
      const item = turn.deck[turn.idx]; if (!item) return false;
      const words = norm(item.word).split(" ").filter(w => w && !STOP.has(w));
      if (!words.length) return false;
      const toks = text.split(" ").filter(Boolean);
      // 1) joined: "hulk buster" -> "hulkbuster", "t rex" -> "trex", "spider man" -> "spiderman"
      const target = words.join("");
      for (let i = 0; i < toks.length; i++) {
        let joined = "";
        for (let n = 0; n < 4 && i + n < toks.length; n++) { joined += toks[i + n]; if (close(joined, target)) return true; }
      }
      // 2) every word of a multi-word answer heard somewhere
      return words.length > 1 && words.every(w => toks.some(t => close(t, w)));
    }
    function onResult(e) {
      let latest = "";
      for (let i = e.resultIndex; i < e.results.length; i++) latest += " " + e.results[i][0].transcript;
      heard(latest);
    }
    function heard(raw) {
      if (!turn.running || turn.paused || turn.lock) return;
      if (performance.now() < cooldownUntil) return;
      const latest = norm(raw); if (!latest) return;
      windowText = (windowText + " " + latest).slice(-160);
      if (answerHeard(latest)) { fire("got", "voice-answer"); return; }
      if (GOT.test(latest)) { fire("got", "voice"); return; }
      if (PASS.test(latest)) { fire("pass", "voice"); return; }
    }
    function fire(o, src) { cooldownUntil = performance.now() + 600; windowText = ""; score(o, src); }
    function denied() { failed = true; want = false; toast("Voice is off. Microphone access wasn't allowed."); $("#hud-mic").hidden = true; }
    // Android app: results come from the phone's own speech recognizer
    window.__ttSpeech = (text) => { if (want) heard(String(text || "")); };
    window.__ttSpeechError = (code) => { if (code === "not-allowed") denied(); };
    function create() {
      const r = new SR(); r.continuous = true; r.interimResults = true; r.lang = navigator.language || "en-US"; r.maxAlternatives = 1;
      r.onresult = onResult;
      r.onerror = ev => { if (ev.error === "not-allowed" || ev.error === "service-not-allowed") denied(); };
      r.onend = () => { if (want && !failed) { try { r.start(); } catch (e) {} } else $("#hud-mic").hidden = true; };
      return r;
    }
    return {
      supported: NATIVE_SR || !!SR,
      start() {
        if (!settings.ctlVoice || failed) return;
        if (NATIVE_SR) { want = true; try { APP.startListening(); } catch (e) {} $("#hud-mic").hidden = false; return; }
        if (!SR) return;
        want = true; if (!rec) rec = create();
        try { rec.start(); } catch (e) { /* already running */ }
        $("#hud-mic").hidden = false;
      },
      stop() {
        want = false;
        if (NATIVE_SR) { try { APP.stopListening(); } catch (e) {} }
        if (rec) { try { rec.stop(); } catch (e) {} }
        $("#hud-mic").hidden = true;
      },
      resetWindow() { windowText = ""; cooldownUntil = Math.max(cooldownUntil, performance.now() + 500); }
    };
  })();

  /* ---------------- Results ---------------- */
  const MARK_GOOD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const MARK_BAD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 7 7 17M7 7l10 10"/></svg>';
  function showResults() {
    releaseAwake(); $("#rotate-hint").classList.remove("show");
    renderResults(true);
    const last = game.mode === "quick" || game.turn + 1 >= game.totalTurns;
    $("#res-next").textContent = game.mode === "quick" ? "Done" : last ? "See who won" : "Save and continue";
    $("#res-kicker").textContent = game.mode === "quick" ? "Time's up" : `${currentPlayer().name}`;
    show("results", { push: false });
  }
  function countUp(el, to) {
    const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || to <= 0) { el.textContent = String(to); return; }
    const t0 = performance.now(), dur = Math.min(900, 250 + to * 60);
    (function f(t) { const k = Math.min(1, (t - t0) / dur); el.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3)))); if (k < 1) requestAnimationFrame(f); })(t0);
  }
  function renderStats() {
    const st = turnStats(turn.results), box = $("#res-stats"); box.textContent = "";
    const chips = [];
    if (st.best >= 2) chips.push(["🔥", `Best streak ${st.best}`]);
    if (st.fastest !== null) chips.push(["⚡", `Fastest ${(st.fastest / 1000).toFixed(1)}s`]);
    if (st.golden) chips.push(["🌟", `${st.golden} golden ${st.golden === 1 ? "card" : "cards"}`]);
    chips.forEach(([e, t]) => { const c = document.createElement("span"); c.className = "stat-chip"; c.textContent = `${e} ${t}`; box.appendChild(c); });
    box.hidden = !chips.length;
  }
  function renderResults(animate) {
    const ul = $("#res-list"); ul.textContent = "";
    const pts = turnPoints(turn.results);
    if (animate) countUp($("#res-score"), pts); else $("#res-score").textContent = String(pts);
    $("#res-unit").textContent = pts === 1 ? "point" : "points";
    renderStats();
    $("#res-empty").hidden = turn.results.length > 0;
    turn.results.forEach((r, i) => {
      const li = document.createElement("li");
      const b = document.createElement("button"); b.className = "res-item " + (r.got ? "good" : "bad");
      b.setAttribute("aria-label", `${r.word}, ${r.got ? "got it" : "passed"}. Tap to change.`);
      const mk = document.createElement("span"); mk.className = "ri-mark"; mk.innerHTML = r.got ? MARK_GOOD : MARK_BAD;
      const wd = document.createElement("span"); wd.className = "ri-word"; wd.textContent = r.word;
      const stt = document.createElement("span"); stt.className = "ri-state"; stt.textContent = r.got ? (r.golden ? "Got it ×2" : "Got it") : "Passed";
      if (r.golden) b.classList.add("is-golden");
      if (animate) { li.classList.add("li-in"); li.style.setProperty("--i", String(Math.min(i, 14))); }
      b.append(mk, wd, stt);
      b.addEventListener("click", () => { Audio.play("tap"); turn.results[i].got = !turn.results[i].got; renderResults(); });
      li.appendChild(b); ul.appendChild(li);
    });
  }
  $("#res-next").addEventListener("click", () => {
    Audio.play("tap");
    const got = turnPoints(turn.results);
    addStars(got);
    if (got > 0) toast(`+${got} ⭐ ${got === 1 ? "star" : "stars"}. ${nextUnlockHint()}`.trim());
    if (game.mode === "quick") {
      modal(`You scored ${got}!`, "Play another quick round?", [
        { label: "Play again", kind: "btn-primary", fn: () => { game.turn = 0; showReady(); } },
        { label: "Change categories", kind: "btn-ghost", fn: () => { history.length = 0; history.push("home"); show("cats", { push: false }); askPickMode(); } },
        { label: "Back to home", kind: "btn-ghost", fn: () => { history.length = 0; show("home", { push: false }); } }
      ]);
      return;
    }
    const p = currentPlayer(), st = turnStats(turn.results); p.score += got; p.turns++;
    p.best = Math.max(p.best || 0, st.best); p.golden = (p.golden || 0) + st.golden; p.seen = (p.seen || 0) + st.seen;
    if (st.fastest !== null) p.fastest = p.fastest ? Math.min(p.fastest, st.fastest) : st.fastest;
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
    $("#win-score").textContent = winners.length > 1 ? winners.map(w => w.name).join(" and ") + ` with ${top} each` : `${top} ${top === 1 ? "point" : "points"}`;
    rankList($("#win-list"));
    renderAwards();
    endPlaySession();
    show("win", { push: false });
    Audio.stopMusic(); Audio.play("win"); buzz([60, 60, 60, 60, 200]);
    setTimeout(() => { if (current === "win") Audio.startMusic(); }, 1800);
    confetti();
  }
  $("#win-again").addEventListener("click", () => { Audio.play("tap"); startGame(); });
  $("#win-home").addEventListener("click", () => { Audio.play("tap"); history.length = 0; show("home", { push: false }); });

  /* Fun awards at the end of a game (only with 2 or more players or teams) */
  function renderAwards() {
    const box = $("#win-awards"); box.textContent = "";
    const r = game.roster; if (r.length < 2) { box.hidden = true; return; }
    const pick = (fn, better) => { let best = null; r.forEach(p => { const v = fn(p); if (v == null || v === 0) return; if (!best || better(v, fn(best))) best = p; }); return best; };
    const awards = [];
    const fast = pick(p => p.fastest || null, (a, b) => a < b);
    if (fast) awards.push(["⚡", "Lightning Brain", fast.name, `Fastest guess: ${(fast.fastest / 1000).toFixed(1)}s`]);
    const hot = pick(p => p.best || 0, (a, b) => a > b);
    if (hot && hot.best >= 2) awards.push(["🔥", "On Fire", hot.name, `${hot.best} in a row`]);
    const gold = pick(p => p.golden || 0, (a, b) => a > b);
    if (gold) awards.push(["🌟", "Golden Touch", gold.name, `${gold.golden} golden ${gold.golden === 1 ? "card" : "cards"}`]);
    const brave = pick(p => p.seen || 0, (a, b) => a > b);
    if (brave) awards.push(["🧭", "Word Explorer", brave.name, `Saw ${brave.seen} words`]);
    awards.forEach(([e, t, n, d], i) => {
      const c = document.createElement("div"); c.className = "award"; c.style.setProperty("--i", String(i));
      const em = document.createElement("span"); em.className = "aw-emoji"; em.textContent = e;
      const tx = document.createElement("span"); tx.className = "aw-text";
      const tt = document.createElement("strong"); tt.textContent = t;
      const nm = document.createElement("span"); nm.className = "aw-name"; nm.textContent = n;
      const dd = document.createElement("small"); dd.textContent = d;
      tx.append(tt, nm, dd); c.append(em, tx); box.appendChild(c);
    });
    box.hidden = !awards.length;
  }

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
    const ms = Audio.trackStatus;
    $("#music-status").textContent = ms === "ready" ? "Game music is loaded ✓" : ms === "loading" ? "Game music is loading..." : "Game music couldn't load (" + ms.slice(8) + "), so the backup beat plays.";
    if (!Wave.supported) { $("#wave-support").textContent = "This device can't use the camera for hand waves."; $('[data-set="ctlWave"]').disabled = true; }
  }
  onShow.settings = renderSettings;
  $$("[data-set]").forEach(el => {
    el.addEventListener(el.type === "range" ? "input" : "change", () => {
      const k = el.dataset.set;
      settings[k] = el.type === "checkbox" ? el.checked : Number(el.value);
      if (k === "ctlTilt" || k === "ctlSwipe" || k === "ctlButtons" || k === "ctlWave") {
        if (!settings.ctlTilt && !settings.ctlSwipe && !settings.ctlButtons && !settings.ctlVoice && !settings.ctlWave) { settings.ctlButtons = true; toast("Kept the on-screen buttons on so you can still play."); }
      }
      saveSettings(); Audio.applyVolumes();
      if (k === "ctlWave" && settings.ctlWave && Wave.supported) {
        // Ask for the camera now, not in the middle of a turn
        navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false })
          .then(st => { st.getTracks().forEach(t => t.stop()); toast("Hand waves are on. Wave across the camera while you play."); })
          .catch(() => { settings.ctlWave = false; saveSettings(); renderSettings(); toast("Camera access wasn't allowed, so hand waves stay off."); });
      }
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
  function handleBack() {
    if (!$("#modal").hidden) { closeModal(); if (current === "play" && turn.paused) resumeTurn(); return true; }
    if (current === "play") { pauseTurn(); return true; }
    if (["ready", "board", "results"].includes(current)) { confirmQuit(); return true; }
    if (current !== "home") { back(); return true; }
    return false;
  }
  if (APP) {
    // Android back button: return false on the home screen so the app can close
    window.onAppBack = handleBack;
    window.onAppPause = () => { if (current === "play" && turn.running && !turn.paused) pauseTurn(); };
  } else {
    try {
      window.history.pushState({ tt: 1 }, "");
      window.addEventListener("popstate", () => { window.history.pushState({ tt: 1 }, ""); handleBack(); });
    } catch (e) {}
  }

  /* ---------------- Updates ----------------
     The release workflow publishes version.json to the public Tilt-and-Tell-Updates repo:
     { "version": "1.2.0", "notes": "...", "apk": { "url": ".../TiltAndTell-1.2.0.apk", "sha256": "..." } }
     Android app: "Update" downloads the signed APK and opens Android's installer.
     Web: "Update" loads the new files and reloads the page. */
  const Updates = (() => {
    let swReg = null, busy = false;
    const newer = (a, b) => {
      const pa = String(a).split(".").map(n => parseInt(n, 10) || 0), pb = String(b).split(".").map(n => parseInt(n, 10) || 0);
      for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
      return false;
    };
    function setStatus(msg, state) {
      const el = $("#update-status"); if (el) el.textContent = msg;
      const row = $("#check-updates"); if (row) row.dataset.state = state || "";
      const bar = $("#update-bar"); if (bar) bar.hidden = state !== "downloading";
    }
    window.onUpdateStatus = msg => setStatus(msg, busy ? "downloading" : "");
    window.onUpdateProgress = p => { const f = $("#update-fill"); if (f) f.style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + "%"; };
    window.onUpdateFailed = () => { busy = false; setStatus("The update didn't finish. Tap to try again.", "error"); };

    async function fetchLatest() {
      const url = (APP ? UPDATES_BASE : "") + "version.json";
      const r = await fetch(url + "?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const v = await r.json();
      if (!v || typeof v.version !== "string") throw new Error("bad version.json");
      return v;
    }
    function apply(v) {
      if (APP) {
        if (!v.apk || !v.apk.url) { setStatus("This update isn't ready for Android yet. Try again later.", "error"); return; }
        busy = true; setStatus("Downloading the update...", "downloading"); window.onUpdateProgress(0);
        try { APP.downloadAndInstall(String(v.apk.url), String(v.apk.sha256 || "")); }
        catch (e) { busy = false; setStatus("The update didn't start. Tap to try again.", "error"); }
        return;
      }
      setStatus("Updating...", "downloading");
      const reload = () => location.reload();
      if (swReg) {
        navigator.serviceWorker.addEventListener("controllerchange", reload, { once: true });
        swReg.update().catch(reload);
        setTimeout(reload, 4000);
      } else reload();
    }
    function offer(v) {
      const notes = v.notes ? String(v.notes) : "A fresh version of Tilt & Tell.";
      modal(`Version ${v.version} is ready`, notes, [
        { label: "Update", kind: "btn-primary", fn: () => apply(v) },
        { label: "Later", kind: "btn-ghost", fn: () => store.set("skipVersion", v.version) }
      ]);
    }
    async function check(manual) {
      if (busy) return;
      if (manual) setStatus("Checking for updates...", "checking");
      try {
        const v = await fetchLatest();
        if (newer(v.version, VERSION)) {
          setStatus(`Version ${v.version} is ready. Tap to update.`, "available");
          if (manual || (["home", "splash"].includes(current) && store.get("skipVersion", "") !== v.version)) offer(v);
        } else setStatus(`You have the latest version (${VERSION}).`, "ok");
      } catch (e) {
        setStatus(manual ? "Couldn't check right now. Check your internet and tap to try again." : "Tap to check for updates.", manual ? "error" : "");
      }
    }
    return { check, set reg(r) { swReg = r; } };
  })();
  $("#check-updates").addEventListener("click", () => { Audio.play("tap"); Updates.check(true); });

  if (!APP && "serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").then(reg => { Updates.reg = reg; }).catch(() => {}).finally(() => setTimeout(() => Updates.check(false), 2500));
    });
  } else if (APP) {
    setTimeout(() => Updates.check(false), 2500);
  }

  // Expose a tiny hook for automated tests only (no secrets, read-only state)
  window.__TT = { game, turn, settings, buildDeck, Tilt, Updates, score: (o) => score(o, "test") };
})();
