/**
 * ScoreKeeper Pro — app.js
 * Application PWA complète : Dame de Pique, Magic, Jeu de 500, Générique
 * Architecture modulaire vanilla JS + IndexedDB
 */

'use strict';

const APP_VERSION = '2.6';
const DEFAULT_MASTER_PASSWORD = 'yco302302';

const PASSWORD_SETTING_KEYS = {
  master: 'password.master',
  manualAdjust: 'password.manualAdjust',
  statsReset: 'password.statsReset',
  dataReset: 'password.dataReset',
};

/* ================================================================
   SECTION 1 : BASE DE DONNÉES (IndexedDB)
   ================================================================ */

const DB = {
  name: 'ScoreKeeperProDB',
  version: 1,
  db: null,

  /** Initialise la base de données IndexedDB */
  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB.name, DB.version);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        // Store des parties actives
        if (!db.objectStoreNames.contains('games')) {
          const gs = db.createObjectStore('games', { keyPath: 'id' });
          gs.createIndex('type', 'type', { unique: false });
          gs.createIndex('status', 'status', { unique: false });
        }
        // Store des entrées de journal
        if (!db.objectStoreNames.contains('logs')) {
          const ls = db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
          ls.createIndex('gameId', 'gameId', { unique: false });
        }
        // Store des paramètres
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      req.onsuccess = (e) => {
        DB.db = e.target.result;
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  },

  /** Exécute une transaction IDB */
  async tx(stores, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = DB.db.transaction(stores, mode);
      const result = fn(tx);
      tx.oncomplete = () => resolve(result instanceof Promise ? result : undefined);
      tx.onerror   = () => reject(tx.error);
      if (result instanceof Promise) {
        result.then(resolve).catch(reject);
      }
    });
  },

  /** Sauvegarde un objet dans un store */
  async save(store, obj) {
    return new Promise((resolve, reject) => {
      const tx  = DB.db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(obj);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  },

  /** Récupère un objet par clé */
  async get(store, key) {
    return new Promise((resolve, reject) => {
      const tx  = DB.db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  },

  /** Récupère tous les objets d'un store */
  async getAll(store) {
    return new Promise((resolve, reject) => {
      const tx  = DB.db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  },

  /** Récupère tous les éléments via un index */
  async getByIndex(store, indexName, value) {
    return new Promise((resolve, reject) => {
      const tx    = DB.db.transaction(store, 'readonly');
      const idx   = tx.objectStore(store).index(indexName);
      const req   = idx.getAll(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  },

  /** Supprime un objet */
  async delete(store, key) {
    return new Promise((resolve, reject) => {
      const tx  = DB.db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).delete(key);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  },

  /** Vide complètement un store IndexedDB. */
  async clear(store) {
    return new Promise((resolve, reject) => {
      const tx  = DB.db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).clear();
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  },

  /** Ajoute une entrée de journal */
  async log(gameId, player, oldValue, delta, newValue, extra = {}) {
    const entry = {
      gameId,
      timestamp: new Date().toISOString(),
      player,
      oldValue,
      delta,
      newValue,
      ...extra
    };
    return DB.save('logs', entry);
  },

  /** Récupère les logs d'une partie */
  async getLogs(gameId) {
    return DB.getByIndex('logs', 'gameId', gameId);
  },

  /** Paramètres */
  async getSetting(key, def = null) {
    const r = await DB.get('settings', key);
    return r ? r.value : def;
  },
  async setSetting(key, value) {
    return DB.save('settings', { key, value });
  }
};

/* ================================================================
   SÉCURITÉ / MOTS DE PASSE
   ================================================================ */

const Security = {
  /** Crée physiquement les mots de passe par défaut dans les paramètres. */
  async ensureDefaults() {
    for (const key of Object.values(PASSWORD_SETTING_KEYS)) {
      const existing = await DB.get('settings', key);
      if (!existing) await DB.setSetting(key, DEFAULT_MASTER_PASSWORD);
    }
  },

  async get(kind) {
    const key = PASSWORD_SETTING_KEYS[kind];
    if (!key) throw new Error(`Type de mot de passe inconnu: ${kind}`);
    return DB.getSetting(key, DEFAULT_MASTER_PASSWORD);
  },

  async set(kind, value) {
    const key = PASSWORD_SETTING_KEYS[kind];
    if (!key) throw new Error(`Type de mot de passe inconnu: ${kind}`);
    return DB.setSetting(key, value);
  },

  /** Demande et valide un mot de passe enregistré. */
  async require(kind, message) {
    const entered = prompt(message);
    if (entered === null) return false;
    const expected = await this.get(kind);
    if (entered !== expected) {
      Utils.toast('Mot de passe incorrect', 'error', 3200);
      return false;
    }
    return true;
  },
};

/* ================================================================
   SECTION 2 : ÉTAT GLOBAL
   ================================================================ */

const State = {
  currentGame: null,   // partie active complète
  currentScreen: 'home',
  deferredInstallPrompt: null,
};

/* ================================================================
   SECTION 3 : UTILITAIRES
   ================================================================ */

const Utils = {
  /** Génère un identifiant unique */
  uid: () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,

  /** Formate une date ISO en lisible */
  formatDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('fr-CA') + ' ' + d.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' });
  },

  /** Formate un nombre signé */
  signed(n) { return n > 0 ? `+${n}` : `${n}`; },

  /** Clamp un nombre entre min et max */
  clamp: (v, min, max) => Math.min(max, Math.max(min, v)),

  /** Retourne une copie mélangée aléatoirement (Fisher-Yates). */
  shuffle(items) {
    const arr = [...items];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  },

  /** Choisit un index aléatoire valide. */
  randomIndex(length) {
    return length > 0 ? Math.floor(Math.random() * length) : 0;
  },

  /** Échappe le HTML */
  esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  /** Affiche un toast temporaire */
  toast(msg, type = 'info', duration = 2800) {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => { el.remove(); }, duration);
  },

  /** Formate une durée en h:mm:ss ou mm:ss. */
  formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  },

  /** Exporte les données en JSON et propose le téléchargement */
  downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
};

/* ================================================================
   CHRONOMÈTRES DE PARTIE
   ================================================================ */

const GameTimer = {
  nowIso() { return new Date().toISOString(); },

  /** Initialise le chrono d'une nouvelle partie sans écraser un chrono existant. */
  initialize(game, startedAt = this.nowIso()) {
    if (!game) return game;
    if (!game.timing || !game.timing.startedAt) {
      game.timing = { startedAt, endedAt: null, durationMs: null };
    }
    if (game.type === 'fiveHundred' && game.mode === 'teams') {
      if (!game.series) game.series = {};
      if (!game.series.currentSetStartedAt && !game.series.finished) {
        game.series.currentSetStartedAt = startedAt;
      }
    }
    return game;
  },

  /** Migration douce : ne fabrique pas de durée pour une ancienne partie déjà terminée. */
  migrate(game) {
    if (!game) return game;
    if (game.status === 'active') this.initialize(game);
    return game;
  },

  currentStartedAt(game) {
    if (!game) return null;
    if (game.type === 'fiveHundred' && game.mode === 'teams') {
      if (game.series?.finished) {
        const last = game.series?.games?.[game.series.games.length - 1];
        return last?.timerStartedAt || game.timing?.startedAt || null;
      }
      return game.series?.currentSetStartedAt || game.timing?.startedAt || null;
    }
    return game.timing?.startedAt || null;
  },

  elapsedMs(game, nowMs = Date.now()) {
    if (!game) return 0;
    const startedAt = this.currentStartedAt(game);
    if (!startedAt) return 0;

    let endedAt = null;
    if (game.type === 'fiveHundred' && game.mode === 'teams' && game.series?.finished) {
      const last = game.series?.games?.[game.series.games.length - 1];
      endedAt = last?.timerEndedAt || last?.finishedAt || game.finishedAt || null;
    } else {
      endedAt = game.timing?.endedAt || null;
    }
    const startMs = new Date(startedAt).getTime();
    const endMs = endedAt ? new Date(endedAt).getTime() : nowMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
    return Math.max(0, endMs - startMs);
  },

  /** Termine et journalise la partie courante d'une série de 500. */
  finishSet(game, finishedAt = this.nowIso(), gameNumber = null, interrupted = false) {
    if (!game || game.type !== 'fiveHundred' || game.mode !== 'teams') return null;
    this.initialize(game, finishedAt);
    const series = game.series;
    const startedAt = series.currentSetStartedAt || game.timing?.startedAt || finishedAt;
    const startMs = new Date(startedAt).getTime();
    const endMs = new Date(finishedAt).getTime();
    const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
    const number = gameNumber || series.gameNumber || ((series.games?.length || 0) + 1);

    game.history = game.history || [];
    game.history.push({
      kind: 'timer',
      scope: 'set',
      seriesGameNumber: number,
      startedAt,
      endedAt: finishedAt,
      durationMs,
      interrupted: !!interrupted,
      timestamp: finishedAt,
    });
    series.currentSetStartedAt = null;
    return { startedAt, endedAt: finishedAt, durationMs, interrupted: !!interrupted };
  },

  startNextSet(game, startedAt = this.nowIso()) {
    if (!game || game.type !== 'fiveHundred' || game.mode !== 'teams') return;
    this.initialize(game, startedAt);
    game.series.currentSetStartedAt = startedAt;
  },

  /** Termine le chrono global d'une partie. */
  finishGame(game, finishedAt = this.nowIso(), journal = true) {
    if (!game) return null;
    this.initialize(game, finishedAt);
    if (game.timing.endedAt) return game.timing;
    const startedAt = game.timing.startedAt;
    const startMs = new Date(startedAt).getTime();
    const endMs = new Date(finishedAt).getTime();
    const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
    game.timing.endedAt = finishedAt;
    game.timing.durationMs = durationMs;

    if (journal) {
      game.history = game.history || [];
      game.history.push({
        kind: 'timer',
        scope: 'game',
        startedAt,
        endedAt: finishedAt,
        durationMs,
        timestamp: finishedAt,
      });
    }
    return game.timing;
  },
};

/* ================================================================
   SECTION 4 : ROUTEUR (navigation entre écrans)
   ================================================================ */

const Router = {
  /** Navigue vers un écran donné */
  go(screenId, data = {}) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(`screen-${screenId}`);
    if (target) {
      target.classList.add('active');
      State.currentScreen = screenId;
      // Synchronise le rail de navigation (visible tablette/desktop)
      document.querySelectorAll('.rail-link[data-screen]').forEach(b => {
        b.classList.toggle('active', b.dataset.screen === screenId);
      });
      // Appelé au changement d'écran pour rendre le contenu dynamique
      Screens.render(screenId, data);
    }
  }
};

/* ================================================================
   SECTION 5 : TABLES DE POINTAGE — JEU DE 500
   ================================================================ */

// Barème du 500 en équipes. La mise de 10 (« la partie ») vaut au minimum
// 1040 points à pique afin d'assurer une victoire même depuis -480, puis
// conserve la progression de 20 points entre les couleurs.
const FIVE_HUNDRED_TEAM_SCORES = {
  '7♠':  140, '7♣': 160, '7♦': 180, '7♥': 200, '7NT': 220,
  '8♠':  240, '8♣': 260, '8♦': 280, '8♥': 300, '8NT': 320,
  '9♠':  340, '9♣': 360, '9♦': 380, '9♥': 400, '9NT': 420,
  '10♠': 1040, '10♣': 1060, '10♦': 1080, '10♥': 1100, '10NT': 1120,
};

// Enchères ouvertes en équipes : le nombre de levées est annoncé avant le minou,
// mais l'atout n'est choisi qu'après avoir pris le minou. Le pointage reste celui
// de l'enchère ouverte, donc inférieur à l'annonce immédiate à pique du même niveau.
const FIVE_HUNDRED_OPEN_TEAM_SCORES = {
  '7O': 130,
  '8O': 230,
  '9O': 330,
};

// Contrat spécial v2.6. Le Mulot est réservé au mode équipes :
// 0 levée, sans minou ni atout. Réussite = 325 points; échec = 325 points aux adversaires.
const FIVE_HUNDRED_MULOT = {
  key: 'MULOT',
  points: 325,
  failedOpponentPoints: 325,
};

// Barèmes individuels selon le nombre de joueurs.
// À 2 joueurs, le barème est identique au 500 en équipes.
// À 3 joueurs, la valeur est intermédiaire. À 4 joueurs, le miseur est davantage récompensé.
// La mise de 10 (« Partie ») conserve 1040 à pique puis +20 et gagne immédiatement.
const FIVE_HUNDRED_INDIVIDUAL_SCORES_BY_PLAYERS = {
  2: {
    '7♠':  140, '7♣': 160, '7♦': 180, '7♥': 200, '7NT': 220,
    '8♠':  240, '8♣': 260, '8♦': 280, '8♥': 300, '8NT': 320,
    '9♠':  340, '9♣': 360, '9♦': 380, '9♥': 400, '9NT': 420,
    '10♠': 1040, '10♣': 1060, '10♦': 1080, '10♥': 1100, '10NT': 1120,
  },
  3: {
    '7♠':  190, '7♣': 210, '7♦': 230, '7♥': 250, '7NT': 270,
    '8♠':  340, '8♣': 360, '8♦': 380, '8♥': 400, '8NT': 420,
    '9♠':  490, '9♣': 510, '9♦': 530, '9♥': 550, '9NT': 570,
    '10♠': 1040, '10♣': 1060, '10♦': 1080, '10♥': 1100, '10NT': 1120,
  },
  4: {
    '7♠':  240, '7♣': 260, '7♦': 280, '7♥': 300, '7NT': 320,
    '8♠':  440, '8♣': 460, '8♦': 480, '8♥': 500, '8NT': 520,
    '9♠':  640, '9♣': 660, '9♦': 680, '9♥': 700, '9NT': 720,
    '10♠': 1040, '10♣': 1060, '10♦': 1080, '10♥': 1100, '10NT': 1120,
  },
};

const FIVE_HUNDRED_INDIVIDUAL_OPPONENT_POOL_RATIO = {
  2: 1.00,
  3: 0.85,
  4: 0.70,
};

const SUITS = ['♠','♣','♦','♥','NT'];
const SUIT_LABELS = {
  '♠':  '♠ Pique',
  '♣':  '♣ Trèfle',
  '♦':  '♦ Carreau',
  '♥':  '♥ Cœur',
  'NT': '⬛ Sans atout',
};

/* ================================================================
   SECTION 6 : MOTEURS DE JEU
   ================================================================ */

const Games = {
  /* ─── Dame de Pique / Hearts ─── */
  hearts: {
    create(players) {
      return {
        id: Utils.uid(),
        type: 'hearts',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        players: players.map(name => ({ name, score: 0 })),
        round: 0,
        history: [], // [{round, scores:[{player,points}], total}]
      };
    },

    /** Valide et enregistre un round */
    submitRound(game, deltas) {
      const expectedTotal = (game.round + 1) * 25;
      const actualDelta   = deltas.reduce((s, d) => s + d, 0);
      const currentTotal  = game.players.reduce((s, p) => s + p.score, 0);
      const newTotal      = currentTotal + actualDelta;

      if (newTotal !== expectedTotal) {
        return { ok: false, msg: `Total doit être ${expectedTotal} (actuellement ${newTotal})` };
      }

      const round = game.round + 1;
      const snapshot = game.players.map((p, i) => {
        const old = p.score;
        p.score += deltas[i];
        return { player: p.name, oldValue: old, delta: deltas[i], newValue: p.score };
      });

      game.round = round;
      game.history.push({ round, scores: snapshot, total: newTotal });
      game.updatedAt = new Date().toISOString();
      return { ok: true, snapshot, round };
    },

    winner(game) {
      // La partie se termine conventionnellement à un seuil (souvent 100 ou décision group)
      return null; // Hearts est sans fin prédéfinie ici, on l'affiche juste
    }
  },

  /* ─── Magic: The Gathering ─── */
  magic: {
    create(players, startingLife = 20) {
      return {
        id: Utils.uid(),
        type: 'magic',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startingLife,
        players: players.map(name => ({ name, life: startingLife, dead: false })),
        history: [],
      };
    },

    /** Modifie les points de vie d'un joueur */
    changeLife(game, playerIdx, delta) {
      const p = game.players[playerIdx];
      const old = p.life;
      p.life = old + delta;

      if (p.life <= 0 && !p.dead) {
        p.dead = true;
        p.life = Math.min(p.life, 0);
      } else if (p.life > 0 && p.dead) {
        p.dead = false;
      }

      game.history.push({
        timestamp: new Date().toISOString(),
        player: p.name,
        oldValue: old,
        delta,
        newValue: p.life,
      });
      game.updatedAt = new Date().toISOString();
      return { old, newValue: p.life };
    },

    alivePlayers(game) {
      return game.players.filter(p => !p.dead);
    }
  },

  /* ─── Jeu de 500 ─── */
  fiveHundred: {
    createTeams(team0Name, team1Name, tablePlayerNames = [], seriesBestOf = 3) {
      const defaults = ['Yannick', 'Lily-Rose', 'Victor', 'Julie'];
      const enteredNames = Array.from({length: 4}, (_, i) => tablePlayerNames[i] || defaults[i]);
      const shuffledNames = Utils.shuffle(enteredNames);
      // Le joueur qui commence doit toujours apparaître en premier dans l'ordre affiché.
      const starterOffset = Utils.randomIndex(shuffledNames.length);
      const names = shuffledNames.slice(starterOffset).concat(shuffledNames.slice(0, starterOffset));
      const firstBidderIdx = 0;
      const bestOf = [1, 3, 5, 7].includes(parseInt(seriesBestOf, 10)) ? parseInt(seriesBestOf, 10) : 3;
      const winsNeeded = Math.floor(bestOf / 2) + 1;
      const team0AutoName = `${names[0]} & ${names[2]}`;
      const team1AutoName = `${names[1]} & ${names[3]}`;
      return {
        id: Utils.uid(),
        type: 'fiveHundred',
        mode: 'teams',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        teams: [
          { name: team0AutoName, score: 0 },
          { name: team1AutoName, score: 0 },
        ],
        // Les partenaires sont les positions 1+3 et 2+4 dans l'ordre aléatoire affiché.
        tablePlayers: names.map((name, i) => ({ name, seatIdx: i, teamIdx: i % 2 })),
        nextBidderIdx: firstBidderIdx,
        scoreLimit: 1000,
        series: {
          bestOf,
          winsNeeded,
          wins: [0, 0],
          gameNumber: 1,
          games: [],
          finished: false,
          winnerTeamIdx: null,
        },
        history: [],
      };
    },

    createIndividual(players) {
      const shuffledPlayers = Utils.shuffle(players);
      // Comme en équipes, le premier nom affiché est toujours le premier miseur.
      const starterOffset = Utils.randomIndex(shuffledPlayers.length);
      const orderedPlayers = shuffledPlayers.slice(starterOffset).concat(shuffledPlayers.slice(0, starterOffset));
      const firstBidderIdx = 0;
      return {
        id: Utils.uid(),
        type: 'fiveHundred',
        mode: 'individual',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // L'ordre affiché est tiré au hasard à chaque début de partie.
        players: orderedPlayers.map(name => ({ name, score: 0 })),
        scoreLimit: 1000,
        // Le premier joueur affiché commence à miser.
        nextBidderIdx: firstBidderIdx,
        history: [],
      };
    },

    /** Compatibilité avec les anciennes créations d'une partie par équipes. */
    create(team0Name, team1Name) {
      return this.createTeams(team0Name, team1Name);
    },

    entities(game) {
      return game.mode === 'individual' ? game.players : game.teams;
    },

    scoreLimit(game) {
      return 1000;
    },

    /** Joueurs dans l'ordre d'affichage autour de la table. */
    tablePlayers(game) {
      if (game.mode === 'individual') {
        return (game.players || []).map((p, i) => ({ name: p.name, seatIdx: i, teamIdx: null }));
      }
      if (!Array.isArray(game.tablePlayers) || game.tablePlayers.length !== 4) {
        game.tablePlayers = Array.from({length: 4}, (_, i) => ({
          name: `Joueur ${i + 1}`,
          seatIdx: i,
          teamIdx: i % 2,
        }));
      }
      return game.tablePlayers;
    },


    ensureTableSetup(game) {
      const seats = this.tablePlayers(game);
      const count = seats.length || 1;
      if (!Number.isInteger(game.nextBidderIdx)) game.nextBidderIdx = 0;
      game.nextBidderIdx = ((game.nextBidderIdx % count) + count) % count;
      if (game.mode === 'teams' && seats.length === 4 && Array.isArray(game.teams) && game.teams.length >= 2) {
        game.teams[0].name = `${seats[0].name} & ${seats[2].name}`;
        game.teams[1].name = `${seats[1].name} & ${seats[3].name}`;
      }
      return seats;
    },

    nextBidder(game) {
      const seats = this.ensureTableSetup(game);
      const seatIdx = game.nextBidderIdx;
      const player = seats[seatIdx];
      return {
        ...player,
        seatIdx,
      };
    },

    /** Après chaque contrat, le premier enchérisseur passe au joueur suivant dans l'ordre d'affichage. */
    advanceNextBidder(game) {
      const seats = this.ensureTableSetup(game);
      game.nextBidderIdx = (game.nextBidderIdx + 1) % seats.length;
      return this.nextBidder(game);
    },

    contractPoints(game, contractKey) {
      if (game?.mode === 'individual') {
        const playerCount = Utils.clamp(game.players?.length || 2, 2, 4);
        const table = FIVE_HUNDRED_INDIVIDUAL_SCORES_BY_PLAYERS[playerCount];
        return table?.[contractKey] || 0;
      }
      if (contractKey === FIVE_HUNDRED_MULOT.key) return FIVE_HUNDRED_MULOT.points;
      if (Object.prototype.hasOwnProperty.call(FIVE_HUNDRED_OPEN_TEAM_SCORES, contractKey)) {
        return FIVE_HUNDRED_OPEN_TEAM_SCORES[contractKey];
      }
      return FIVE_HUNDRED_TEAM_SCORES[contractKey] || 0;
    },

    isMulotContract(contractKey) {
      return contractKey === FIVE_HUNDRED_MULOT.key;
    },

    isOpenContract(contractKey) {
      return Object.prototype.hasOwnProperty.call(FIVE_HUNDRED_OPEN_TEAM_SCORES, contractKey);
    },

    contractLabel(contractKey) {
      if (this.isMulotContract(contractKey)) return 'Mulot';
      if (this.isOpenContract(contractKey)) return `${parseInt(contractKey, 10)} ouvert`;
      return contractKey;
    },

    /** Points accordés aux adversaires lorsque le contrat est chuté en équipes. */
    failedTeamContractPoints(game, contractKey) {
      if (this.isMulotContract(contractKey)) return FIVE_HUNDRED_MULOT.failedOpponentPoints;
      const pts = this.contractPoints(game, contractKey);
      if (this.isGameContract(contractKey)) return Math.floor(pts / 2);
      return pts;
    },

    opponentPoolRatio(game) {
      if (game?.mode !== 'individual') return 1;
      const playerCount = Utils.clamp(game.players?.length || 2, 2, 4);
      return FIVE_HUNDRED_INDIVIDUAL_OPPONENT_POOL_RATIO[playerCount] || 1;
    },

    opponentPointsPool(game, contractKey) {
      const contractPoints = this.contractPoints(game, contractKey);
      const ratio = this.opponentPoolRatio(game);
      return Math.ceil((contractPoints * ratio) / 20) * 20;
    },

    isGameContract(contractKey) {
      return !this.isMulotContract(contractKey) && parseInt(contractKey, 10) === 10;
    },

    teamMembers(game, teamIdx) {
      return this.tablePlayers(game).filter(p => p.teamIdx === teamIdx).map(p => p.name);
    },

    ensureSeries(game) {
      if (game.mode !== 'teams') return null;
      if (!game.series) {
        game.series = { bestOf: 1, winsNeeded: 1, wins: [0, 0], gameNumber: 1, games: [], finished: false, winnerTeamIdx: null };
      }
      if (!Array.isArray(game.series.wins)) game.series.wins = [0, 0];
      if (!Array.isArray(game.series.games)) game.series.games = [];
      (game.teams || []).forEach(t => { t.score = Math.max(0, Number(t.score) || 0); });
      game.scoreLimit = 1000;
      return game.series;
    },

    /** Enregistre la partie de 500 en équipes et prépare la suivante si la série continue. */
    completeTeamGame(game, winnerTeamIdx) {
      const series = this.ensureSeries(game);
      const finishedAt = new Date().toISOString();
      const gameNumber = series.gameNumber || (series.games.length + 1);
      const setTiming = GameTimer.finishSet(game, finishedAt, gameNumber, false);
      const teamsSnapshot = game.teams.map((team, idx) => ({
        name: team.name,
        members: this.teamMembers(game, idx),
        score: team.score,
      }));
      const result = {
        gameNumber,
        finishedAt,
        winnerTeamIdx,
        winnerTeamName: game.teams[winnerTeamIdx].name,
        winnerMembers: this.teamMembers(game, winnerTeamIdx),
        teams: teamsSnapshot,
        finalScores: game.teams.map(t => t.score),
        timerStartedAt: setTiming?.startedAt || null,
        timerEndedAt: setTiming?.endedAt || finishedAt,
        durationMs: setTiming?.durationMs ?? 0,
      };
      series.games.push(result);
      series.wins[winnerTeamIdx] = (series.wins[winnerTeamIdx] || 0) + 1;

      const seriesWon = series.wins[winnerTeamIdx] >= series.winsNeeded;
      if (seriesWon) {
        series.finished = true;
        series.winnerTeamIdx = winnerTeamIdx;
        game.status = 'finished';
        game.winnerName = game.teams[winnerTeamIdx].name;
        game.winnerMembers = this.teamMembers(game, winnerTeamIdx);
        game.finishedAt = finishedAt;
        game.winReason = 'series';
        GameTimer.finishGame(game, finishedAt, false);
      } else {
        game.teams.forEach(t => { t.score = 0; });
        series.gameNumber = gameNumber + 1;
        GameTimer.startNextSet(game, finishedAt);
        delete game.winnerName;
        delete game.winnerMembers;
        delete game.winReason;
        game.status = 'active';
      }
      return { result, seriesWon, seriesWinner: seriesWon ? game.teams[winnerTeamIdx] : null };
    },

    /** Applique un résultat de contrat en mode équipes.
     * Contrat normal chuté : valeur complète aux adversaires.
     * Partie chutée : 50 % de la valeur aux adversaires.
     * Mulot chuté : 325 points aux adversaires.
     * Une partie est gagnée dès qu'une équipe atteint 1000 points.
     */
    applyContract(game, teamIdx, contractKey, success) {
      this.ensureSeries(game);
      const pts = this.contractPoints(game, contractKey);
      const awardedPoints = success ? pts : this.failedTeamContractPoints(game, contractKey);
      const opponentIdx = teamIdx === 0 ? 1 : 0;
      const awardedIdx = success ? teamIdx : opponentIdx;
      const awardedTeam = game.teams[awardedIdx];
      const biddingTeam = game.teams[teamIdx];
      const oldAwarded = awardedTeam.score;
      awardedTeam.score = Math.max(0, oldAwarded + awardedPoints);

      game.history.push({
        kind: 'contract',
        timestamp: new Date().toISOString(),
        team: biddingTeam.name,
        biddingTeamIdx: teamIdx,
        awardedTeam: awardedTeam.name,
        awardedTeamIdx: awardedIdx,
        contract: contractKey,
        points: pts,
        awardedPoints,
        success,
        lossRule: success ? null : (this.isMulotContract(contractKey) ? 'mulot-325' : (this.isGameContract(contractKey) ? 'partie-half' : 'full')),
        oldValue: oldAwarded,
        delta: awardedPoints,
        newValue: awardedTeam.score,
        seriesGameNumber: game.series.gameNumber,
      });
      const lastHistory = game.history[game.history.length - 1];
      game.updatedAt = new Date().toISOString();

      let winner = game.teams.find(t => t.score >= 1000) || null;
      let gameCompletion = null;
      if (winner) {
        const winnerIdx = game.teams.indexOf(winner);
        gameCompletion = this.completeTeamGame(game, winnerIdx);
      }

      let nextBidder = null;
      if (!gameCompletion?.seriesWon) {
        nextBidder = this.advanceNextBidder(game);
        lastHistory.nextBidder = nextBidder.name;
      }
      return {
        delta: awardedPoints,
        contractPoints: pts,
        awardedPoints,
        awardedTeam,
        awardedTeamIdx: awardedIdx,
        newValue: awardedTeam.score,
        winner,
        gameCompletion,
        nextBidder,
      };
    },

    /** Attribution directe des points en mode équipes, conservée pour compatibilité. */
    applyAwardedContract(game, awardedIdx, contractKey) {
      this.ensureSeries(game);
      const pts = this.contractPoints(game, contractKey);
      const awardedTeam = game.teams[awardedIdx];
      const oldAwarded = awardedTeam.score;
      awardedTeam.score = Math.max(0, oldAwarded + pts);

      game.history.push({
        kind: 'contract',
        timestamp: new Date().toISOString(),
        team: awardedTeam.name,
        awardedTeam: awardedTeam.name,
        awardedTeamIdx: awardedIdx,
        contract: contractKey,
        points: pts,
        success: true,
        directAward: true,
        oldValue: oldAwarded,
        delta: pts,
        newValue: awardedTeam.score,
        seriesGameNumber: game.series.gameNumber,
      });
      const lastHistory = game.history[game.history.length - 1];
      game.updatedAt = new Date().toISOString();

      let winner = game.teams.find(t => t.score >= 1000) || null;
      let gameCompletion = null;
      if (winner) {
        const winnerIdx = game.teams.indexOf(winner);
        gameCompletion = this.completeTeamGame(game, winnerIdx);
      }

      let nextBidder = null;
      if (!gameCompletion?.seriesWon) {
        nextBidder = this.advanceNextBidder(game);
        lastHistory.nextBidder = nextBidder.name;
      }
      return {
        delta: pts,
        awardedTeam,
        awardedTeamIdx: awardedIdx,
        newValue: awardedTeam.score,
        winner,
        gameCompletion,
        nextBidder,
      };
    },

    /** Partie nulle en équipes : bonus aux deux équipes sauf si ce bonus ferait gagner l'une d'elles. */
    applyNullDeal(game, configuredPoints = 50) {
      this.ensureSeries(game);
      const points = Math.max(0, parseInt(configuredPoints, 10) || 0);
      const blockedTeams = game.teams.filter(t => (Number(t.score) || 0) + points >= 1000);
      const appliedPoints = blockedTeams.length ? 0 : points;
      const before = game.teams.map(t => Number(t.score) || 0);
      if (appliedPoints > 0) {
        game.teams.forEach(t => { t.score = Math.max(0, (Number(t.score) || 0) + appliedPoints); });
      }
      const nextBidder = this.advanceNextBidder(game);
      game.history.push({
        kind: 'nullDeal',
        timestamp: new Date().toISOString(),
        configuredPoints: points,
        appliedPoints,
        blockedBy: blockedTeams.map(t => t.name),
        before,
        after: game.teams.map(t => t.score),
        seriesGameNumber: game.series?.gameNumber || 1,
        nextBidder: nextBidder.name,
      });
      game.updatedAt = new Date().toISOString();
      return { configuredPoints: points, appliedPoints, blockedTeams, nextBidder };
    },

    /**
     * Mode individuel :
     * - le barème du miseur dépend du nombre de joueurs;
     * - s'il gagne, lui seul reçoit la valeur complète du contrat;
     * - s'il perd, on saisit uniquement les levées des adversaires;
     * - le bassin distribué vaut 100 % du contrat à 2 joueurs, 85 % à 3 et 70 % à 4;
     * - ce bassin est arrondi au 20 supérieur, puis réparti selon les levées adverses;
     * - aucun score ne devient négatif.
     */
    applyIndividualRound(game, bidderIdx, contractKey, success, opponentTricks = []) {
      const contractPoints = this.contractPoints(game, contractKey);
      const opponentPoolRatio = this.opponentPoolRatio(game);
      const opponentPointsPool = success ? 0 : this.opponentPointsPool(game, contractKey);
      const snapshots = [];
      let pointsPerOpposingTrick = 0;

      if (success) {
        game.players.forEach((p, i) => {
          const old = p.score;
          const delta = i === bidderIdx ? contractPoints : 0;
          p.score = Math.max(0, old + delta);
          snapshots.push({ player: p.name, tricks: null, oldValue: old, delta, newValue: p.score });
        });
      } else {
        const opposingTricks = game.players.reduce((sum, _, i) => {
          return sum + (i === bidderIdx ? 0 : (parseInt(opponentTricks[i], 10) || 0));
        }, 0);
        pointsPerOpposingTrick = opposingTricks > 0 ? Math.ceil(opponentPointsPool / opposingTricks) : 0;

        game.players.forEach((p, i) => {
          const old = p.score;
          const tricks = i === bidderIdx ? null : (parseInt(opponentTricks[i], 10) || 0);
          const delta = i === bidderIdx ? 0 : tricks * pointsPerOpposingTrick;
          p.score = Math.max(0, old + delta);
          snapshots.push({ player: p.name, tricks, oldValue: old, delta, newValue: p.score });
        });
      }

      game.history.push({
        kind: 'individualRound',
        timestamp: new Date().toISOString(),
        bidder: game.players[bidderIdx].name,
        bidderIdx,
        contract: contractKey,
        contractPoints,
        success,
        opponentTricks: success ? [] : [...opponentTricks],
        opponentPoolRatio,
        opponentPointsPool,
        pointsPerOpposingTrick,
        scores: snapshots,
      });
      const nextBidder = this.advanceNextBidder(game);
      const lastHistory = game.history[game.history.length - 1];
      lastHistory.nextBidder = nextBidder.name;
      lastHistory.nextBidderSeat = nextBidder.clock;
      game.updatedAt = new Date().toISOString();

      let winner = null;
      if (success && this.isGameContract(contractKey)) {
        // Une mise de 10 réussie gagne immédiatement, quel que soit le score précédent.
        winner = game.players[bidderIdx];
        game.status = 'finished';
        game.winnerName = winner.name;
        game.winReason = 'contract10';
        game.finishedAt = new Date().toISOString();
        GameTimer.finishGame(game, game.finishedAt, true);
      } else {
        winner = game.players.find(p => p.score >= 1000) || null;
        if (winner) {
          game.status = 'finished';
          game.winnerName = winner.name;
          game.winReason = 'score';
          game.finishedAt = new Date().toISOString();
          GameTimer.finishGame(game, game.finishedAt, true);
        }
      }
      return { success, contractPoints, opponentPoolRatio, opponentPointsPool, pointsPerOpposingTrick, snapshots, winner };
    },

    /** Ajustement manuel, utilisé notamment pour les pénalités. */
    adjustScore(game, entityIdx, delta) {
      const list = this.entities(game);
      const entity = list[entityIdx];
      const old = entity.score;
      // Tous les modes 500 sont maintenant sans score négatif.
      entity.score = Math.max(0, old + delta);
      const appliedDelta = entity.score - old;

      game.history.push({
        kind: 'manual',
        timestamp: new Date().toISOString(),
        player: game.mode === 'individual' ? entity.name : undefined,
        team: game.mode === 'individual' ? undefined : entity.name,
        oldValue: old,
        delta: appliedDelta,
        newValue: entity.score,
      });
      game.updatedAt = new Date().toISOString();

      let winner = list.find(e => e.score >= 1000) || null;
      let gameCompletion = null;
      if (winner) {
        if (game.mode === 'teams') {
          gameCompletion = this.completeTeamGame(game, list.indexOf(winner));
        } else {
          game.status = 'finished';
          game.winnerName = winner.name;
          game.finishedAt = new Date().toISOString();
          game.winReason = 'score';
          GameTimer.finishGame(game, game.finishedAt, true);
        }
      }
      return { old, delta: appliedDelta, newValue: entity.score, winner, gameCompletion };
    }

  },

  /* ─── Générique ─── */
  generic: {
    create(players, scoreLimit = null) {
      return {
        id: Utils.uid(),
        type: 'generic',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        players: players.map(name => ({ name, score: 0 })),
        scoreLimit,
        history: [],
      };
    },

    changeScore(game, playerIdx, delta) {
      const p = game.players[playerIdx];
      const old = p.score;
      p.score += delta;

      game.history.push({
        timestamp: new Date().toISOString(),
        player: p.name,
        oldValue: old,
        delta,
        newValue: p.score,
      });
      game.updatedAt = new Date().toISOString();

      const winner = game.scoreLimit !== null && p.score >= game.scoreLimit ? p : null;
      if (winner) {
        game.status = 'finished';
        game.winnerName = winner.name;
        game.finishedAt = new Date().toISOString();
        GameTimer.finishGame(game, game.finishedAt, true);
      }

      return { old, newValue: p.score, winner };
    }
  }
};

/* ================================================================
   STATISTIQUES : normalisation des parties terminées
   ================================================================ */

const Stats = {
  gameLabel(type) {
    return ({ hearts: 'Dame de Pique', magic: 'Magic', fiveHundred: '500', generic: 'Générique' })[type] || type;
  },

  nameKey(name) { return String(name || '').trim().toLocaleLowerCase('fr-CA'); },

  teamKey(members) {
    return (members || []).map(n => this.nameKey(n)).sort().join('|');
  },

  teamLabel(members) {
    return [...(members || [])].sort((a,b) => a.localeCompare(b, 'fr-CA')).join(' - ');
  },

  inferWinnerName(game) {
    if (game.winnerName) return game.winnerName;
    const players = game.players || [];
    if (!players.length) return null;
    if (game.type === 'hearts') {
      const min = Math.min(...players.map(p => p.score));
      const tied = players.filter(p => p.score === min);
      return tied.length === 1 ? tied[0].name : null;
    }
    if (game.type === 'magic') {
      const alive = players.filter(p => !p.dead && p.life > 0);
      return alive.length === 1 ? alive[0].name : null;
    }
    if (game.type === 'generic') {
      const max = Math.max(...players.map(p => p.score));
      const tied = players.filter(p => p.score === max);
      return tied.length === 1 ? tied[0].name : null;
    }
    return null;
  },

  recordsFromGame(game) {
    const records = [];
    if (game.type === 'fiveHundred' && (game.mode || 'teams') === 'teams' && game.series?.games?.length) {
      game.series.games.forEach((sg, idx) => {
        const teams = (sg.teams || game.teams.map((t, ti) => ({
          name: t.name,
          members: Games.fiveHundred.teamMembers(game, ti),
        }))).map((t, ti) => ({
          name: t.name,
          members: t.members || Games.fiveHundred.teamMembers(game, ti),
          key: this.teamKey(t.members || Games.fiveHundred.teamMembers(game, ti)),
        }));
        const winnerTeamIdx = Number.isInteger(sg.winnerTeamIdx) ? sg.winnerTeamIdx : 0;
        records.push({
          id: `${game.id}:series:${sg.gameNumber || idx + 1}`,
          date: sg.finishedAt || game.updatedAt || game.createdAt,
          gameType: 'fiveHundred', gameLabel: '500', mode: 'teams',
          players: teams.flatMap(t => t.members),
          teams,
          winnerPlayers: teams[winnerTeamIdx]?.members || [],
          winnerTeamKey: teams[winnerTeamIdx]?.key || null,
        });
      });
      return records;
    }

    if (game.status !== 'finished') return records;
    if (game.type === 'fiveHundred' && (game.mode || 'teams') === 'teams') {
      const teams = (game.teams || []).map((t, ti) => {
        const members = Games.fiveHundred.teamMembers(game, ti);
        return { name: t.name, members, key: this.teamKey(members) };
      });
      const winnerIdx = teams.findIndex(t => t.name === game.winnerName);
      records.push({
        id: game.id, date: game.finishedAt || game.updatedAt || game.createdAt,
        gameType: 'fiveHundred', gameLabel: '500', mode: 'teams',
        players: teams.flatMap(t => t.members), teams,
        winnerPlayers: winnerIdx >= 0 ? teams[winnerIdx].members : [],
        winnerTeamKey: winnerIdx >= 0 ? teams[winnerIdx].key : null,
      });
      return records;
    }

    const players = (game.players || []).map(p => p.name);
    const winnerName = this.inferWinnerName(game);
    records.push({
      id: game.id,
      date: game.finishedAt || game.updatedAt || game.createdAt,
      gameType: game.type,
      gameLabel: this.gameLabel(game.type),
      mode: 'individual',
      players,
      teams: [],
      winnerPlayers: winnerName ? [winnerName] : [],
      winnerTeamKey: null,
    });
    return records;
  },

  records(games) { return (games || []).flatMap(g => this.recordsFromGame(g)); },

  pct(wins, games) { return games ? (wins * 100 / games) : 0; },
};

/* ================================================================
   SECTION 7 : RENDU DES ÉCRANS
   ================================================================ */

const Screens = {
  /** Dispatch selon l'écran actif */
  render(screenId, data) {
    const fn = this[`render_${screenId.replace(/-/g,'_')}`];
    if (fn) fn.call(this, data);
  },

  /* ─── Accueil ─── */
  async render_home() {
    // Vérifier s'il y a une partie en cours à reprendre
    const games = await DB.getAll('games');
    const active = games
      .filter(g => g.status === 'active')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const banner = document.getElementById('resume-banner');
    if (active.length > 0) {
      const g = active[0];
      const typeLabel = { hearts: '♠ Dame de Pique', magic: '🔮 Magic', fiveHundred: '🃏 Jeu de 500', generic: '🎮 Générique' };
      banner.innerHTML = `
        <div class="resume-banner-icon">▶️</div>
        <div class="resume-banner-text">
          <div class="resume-banner-title">Reprendre la partie</div>
          <div class="resume-banner-sub">${Utils.esc(typeLabel[g.type] || g.type)} · ${Utils.formatDate(g.updatedAt)}</div>
        </div>
        <div class="resume-banner-arrow">›</div>
      `;
      banner.style.display = 'flex';
      banner.onclick = () => UI.resumeGame(g);
    } else {
      banner.style.display = 'none';
    }

    // Gestion bouton installation PWA
    const installBanner = document.getElementById('install-banner');
    if (State.deferredInstallPrompt) {
      installBanner.style.display = 'flex';
    } else {
      installBanner.style.display = 'none';
    }
  },

  /* ─── Création de partie ─── */
  render_new_game(data) {
    const { type } = data;
    const titles = {
      hearts:      '♠ Dame de Pique',
      magic:       '🔮 Magic: The Gathering',
      fiveHundred: '🃏 Jeu de 500',
      generic:     '🎮 Jeu Générique',
    };
    document.getElementById('new-game-title').textContent = titles[type] || 'Nouvelle partie';
    document.getElementById('new-game-type').value = type;

    const container = document.getElementById('new-game-options');
    container.innerHTML = '';

    if (type === 'fiveHundred') {
      const savedNames = JSON.parse(localStorage.getItem('savedPlayerNames') || '[]');
      container.innerHTML = `
        <div class="card">
          <div class="card-title">Mode de jeu</div>
          <div class="tabs">
            <button class="tab-btn active" id="fh-mode-teams" onclick="UI.setNewFhMode('teams')">Équipes</button>
            <button class="tab-btn" id="fh-mode-individual" onclick="UI.setNewFhMode('individual')">Individuel</button>
          </div>
          <input type="hidden" id="fh-new-mode" value="teams">
        </div>

        <div class="card" id="fh-new-teams">
          <div class="card-title">500 en équipes</div>
          <div class="setting-sub" style="margin-bottom:12px">Les noms d'équipes sont générés automatiquement à partir des deux partenaires après le tirage de l'ordre, par exemple « Yannick & Julie ».</div>

          <div class="form-group">
            <label class="form-label">Format de la série</label>
            <select class="form-select" id="fh-series-bestof">
              <option value="1">1 partie</option>
              <option value="3" selected>2 de 3</option>
              <option value="5">3 de 5</option>
              <option value="7">4 de 7</option>
            </select>
          </div>

          <div class="divider"></div>
          <div class="card-title">Joueurs autour de la table</div>
          <div class="setting-sub" style="margin-bottom:12px">Les 4 noms seront mélangés au hasard au démarrage. Dans l'ordre obtenu, les joueurs 1 et 3 seront partenaires; les joueurs 2 et 4 seront partenaires.</div>
          <div id="fh-team-player-inputs" class="player-inputs">
            ${['Yannick','Lily-Rose','Victor','Julie'].map((name, i) => `
              <div class="player-input-row fh-team-player-row">
                <div class="player-input-num">${i + 1}</div>
                <input class="form-input" type="text" value="${name}" maxlength="16" data-team-player="${i}">
              </div>
            `).join('')}
          </div>
          <div class="setting-sub" style="margin-top:12px"><strong>Équipes déterminées automatiquement après le tirage.</strong><br>Les positions 1+3 affronteront les positions 2+4.</div>
          <div class="setting-sub" style="margin-top:10px">500 en équipes : aucun score négatif. Un contrat normal chuté donne sa valeur aux adversaires. Une Partie chutée donne seulement 50 % de sa valeur aux adversaires. Les enchères ouvertes valent 130 / 230 / 330 points pour 7 / 8 / 9. Un Mulot vaut 325 points, réussi ou chuté. Une partie est gagnée à 1000 points; la série se poursuit jusqu'au nombre de victoires choisi.</div>
        </div>

        <div class="card" id="fh-new-individual" style="display:none">
          <div class="card-title">Joueurs</div>
          <div class="form-group">
            <label class="form-label">Nombre de joueurs</label>
            <select class="form-select" id="fh-player-count" onchange="UI.renderNewFhPlayerInputs()">
              <option value="2">2 joueurs</option>
              <option value="3" selected>3 joueurs</option>
              <option value="4">4 joueurs</option>
            </select>
          </div>
          <div id="fh-player-name-inputs" class="player-inputs"></div>
          <div class="setting-sub" style="margin-top:12px">L'ordre des joueurs est tiré au hasard au démarrage; le joueur affiché en premier commence à miser. Victoire à 1000 points. Le barème augmente avec le nombre de joueurs. En cas de chute, les adversaires se partagent un bassin de 100 % du contrat à 2 joueurs, 85 % à 3 et 70 % à 4.</div>
        </div>
      `;
      UI._newFhSavedNames = ['Yannick', 'Lily-Rose', 'Victor', 'Julie'];
      UI.renderNewFhPlayerInputs();
    } else {
      const defaultCount = type === 'magic' ? 4 : type === 'hearts' ? 4 : 2;
      const minCount     = type === 'magic' ? 2 : 2;
      const maxCount     = type === 'magic' ? 6 : 8;

      let extraHtml = '';
      if (type === 'magic') {
        extraHtml = `
          <div class="form-group">
            <label class="form-label">Points de vie de départ</label>
            <select class="form-select" id="magic-start-life">
              <option value="20" selected>20 (Standard)</option>
              <option value="30">30</option>
              <option value="40">40 (Commander)</option>
            </select>
          </div>
        `;
      }
      if (type === 'generic') {
        extraHtml = `
          <div class="form-group">
            <label class="form-label">Limite de score (optionnel, 0 = aucune)</label>
            <input class="form-input" id="score-limit" type="number" value="0" min="0">
          </div>
        `;
      }

      container.innerHTML = `
        ${extraHtml}
        <div class="card">
          <div class="card-title">Joueurs</div>
          <div class="form-group">
            <label class="form-label">Nombre de joueurs</label>
            <select class="form-select" id="player-count">
              ${Array.from({length: maxCount - minCount + 1}, (_,i) => {
                const n = i + minCount;
                return `<option value="${n}" ${n === defaultCount ? 'selected' : ''}>${n} joueurs</option>`;
              }).join('')}
            </select>
          </div>
          <div id="player-name-inputs" class="player-inputs"></div>
        </div>
      `;

      // Préremplir les noms
      const savedNames = JSON.parse(localStorage.getItem('savedPlayerNames') || '[]');
      const updateInputs = () => {
        const count = parseInt(document.getElementById('player-count').value);
        const inputs = document.getElementById('player-name-inputs');
        inputs.innerHTML = Array.from({length: count}, (_, i) => `
          <div class="player-input-row">
            <div class="player-input-num">${i+1}</div>
            <input class="form-input" type="text" placeholder="Joueur ${i+1}"
              value="${Utils.esc(savedNames[i] || '')}" maxlength="16" data-player="${i}">
          </div>
        `).join('');
      };

      document.getElementById('player-count').addEventListener('change', updateInputs);
      updateInputs();
    }
  },

  /* ─── Hearts ─── */
  render_hearts(data) {
    if (!State.currentGame || State.currentGame.type !== 'hearts') return;
    const game = State.currentGame;

    document.getElementById('hearts-round-num').textContent  = `Round ${game.round}`;
    document.getElementById('hearts-total-val').textContent  = game.players.reduce((s,p) => s+p.score, 0);
    document.getElementById('hearts-expected').textContent   = `Attendu : ${game.round * 25}`;

    // Scores
    const scoresEl = document.getElementById('hearts-scores');
    const minScore = Math.min(...game.players.map(p => p.score));
    scoresEl.innerHTML = game.players.map((p, i) => `
      <div class="score-row ${p.score === minScore ? 'leader' : ''}">
        <div class="score-player-name">${Utils.esc(p.name)}</div>
        <div class="score-value">${p.score}</div>
      </div>
    `).join('');

    // Formulaire de saisie du round
    const entryEl = document.getElementById('hearts-round-entry');
    entryEl.innerHTML = game.players.map((p, i) => `
      <div class="round-entry-player">
        <div class="rep-name">${Utils.esc(p.name)}</div>
        <div class="rep-controls">
          <button class="rep-btn" onclick="UI.heartsAdjust(${i}, -1)">−</button>
          <input class="rep-input" type="number" id="hearts-delta-${i}" value="0" min="0" max="26"
            oninput="UI.heartsUpdateTotal()">
          <button class="rep-btn" onclick="UI.heartsAdjust(${i}, 1)">+</button>
        </div>
      </div>
    `).join('');

    UI.heartsUpdateTotal();
  },

  /* ─── Magic ─── */
  render_magic() {
    if (!State.currentGame || State.currentGame.type !== 'magic') return;
    const game = State.currentGame;

    const grid = document.getElementById('magic-players-grid');
    grid.innerHTML = game.players.map((p, i) => {
      const pct = p.life / game.startingLife;
      const hpClass = pct > 0.5 ? 'high' : pct > 0.25 ? 'mid' : 'low';
      return `
        <div class="magic-player-card ${p.dead ? 'dead' : ''}" id="magic-card-${i}">
          ${p.dead ? '<div class="magic-dead-overlay">💀</div>' : ''}
          <div class="magic-player-name">${Utils.esc(p.name)}</div>
          <div class="magic-hp ${hpClass}" id="magic-hp-${i}">${p.life}</div>
          <div class="magic-controls">
            <button class="magic-btn magic-btn-minus" onclick="UI.magicChange(${i}, -1)">−</button>
            <button class="magic-btn magic-btn-plus"  onclick="UI.magicChange(${i}, +1)">+</button>
          </div>
          <div class="magic-delta" id="magic-delta-${i}"></div>
        </div>
      `;
    }).join('');
  },

  /* ─── Jeu de 500 ─── */
  render_five_hundred() {
    if (!State.currentGame || State.currentGame.type !== 'fiveHundred') return;
    const game = State.currentGame;
    if (!game.mode) game.mode = 'teams';
    Games.fiveHundred.ensureTableSetup(game);

    const list = game.mode === 'individual' ? game.players : game.teams;
    if (game.mode === 'teams') Games.fiveHundred.ensureSeries(game);
    let winner = game.winnerName ? list.find(e => e.name === game.winnerName) : null;
    if (!winner && game.mode === 'individual') winner = list.find(e => e.score >= 1000) || null;

    document.getElementById('fh-screen-title').textContent = game.mode === 'individual' ? '🃏 500 individuel' : '🃏 Jeu de 500';
    if (game.mode === 'individual') {
      document.getElementById('fh-mode-badge').textContent = 'Individuel · 1000 pts';
    } else {
      const series = game.series;
      const label = series.bestOf === 1 ? '1 partie' : `${series.winsNeeded} de ${series.bestOf}`;
      document.getElementById('fh-mode-badge').textContent = `Équipes · 1000 pts · ${label}`;
    }

    const teamsEl = document.getElementById('fh-teams');
    teamsEl.classList.toggle('individual', game.mode === 'individual');
    teamsEl.innerHTML = list.map((t, i) => `
      <div class="team-card ${winner === t ? 'winner' : ''}">
        <div class="team-name">${Utils.esc(t.name)}</div>
        <div class="team-score ${t.score < 0 ? 'negative' : 'positive'}">${t.score}</div>
        ${game.mode === 'teams' ? `<div class="score-badge">Victoires série : ${game.series?.wins?.[i] || 0}/${game.series?.winsNeeded || 1}</div>` : ''}
      </div>
    `).join('');

    const victBanner = document.getElementById('fh-victory');
    if (winner) {
      victBanner.style.display = 'block';
      document.getElementById('fh-winner-name').textContent = winner.name;
      document.getElementById('fh-winner-score').textContent = winner.score;
    } else {
      victBanner.style.display = 'none';
    }

    const next = Games.fiveHundred.nextBidder(game);
    const nextBanner = document.getElementById('fh-next-bidder-banner');
    if (nextBanner) {
      nextBanner.innerHTML = `<span>Première mise de la prochaine donne</span><strong>${Utils.esc(next.name)}</strong>`;
    }
    const nullDealBtn = document.getElementById('fh-null-deal-btn');
    if (nullDealBtn) nullDealBtn.style.display = game.mode === 'teams' ? 'flex' : 'none';
    const compact = document.getElementById('fh-series-inline');
    if (compact) {
      if (game.mode === 'teams') {
        compact.innerHTML = `<strong>Partie ${game.series?.gameNumber || 1}</strong> · Série ${game.series?.wins?.[0] || 0}-${game.series?.wins?.[1] || 0}`;
      } else {
        compact.innerHTML = `<strong>${game.players.length}</strong> joueur(s) · rotation des mises active`;
      }
    }

    UI._selectedContract = null;
    UI._selectedTeam = null;
    UI.resetFhIndividualFlow();
    UI.updateGameTimerDisplay();
  },

  /* ─── Générique ─── */
  render_generic() {
    if (!State.currentGame || State.currentGame.type !== 'generic') return;
    const game = State.currentGame;

    const container = document.getElementById('generic-players');
    const winner = game.players.find(p => game.scoreLimit && p.score >= game.scoreLimit);
    container.innerHTML = game.players.map((p, i) => `
      <div class="generic-player-row">
        <div class="generic-player-top">
          <div class="generic-player-name-score">
            <span class="name">${Utils.esc(p.name)}</span>
            <span class="score ${p.score < 0 ? 'negative' : ''}" id="generic-score-${i}">${p.score}</span>
          </div>
          ${game.scoreLimit ? `<span class="badge badge-accent">${game.scoreLimit} pts</span>` : ''}
        </div>
        <div class="generic-input-row">
          <input class="generic-delta-input" type="number" id="generic-delta-${i}"
            placeholder="±points" value="0">
          <button class="btn btn-success btn-icon" onclick="UI.genericApply(${i}, 1)">+</button>
          <button class="btn btn-danger  btn-icon" onclick="UI.genericApply(${i}, -1)">−</button>
        </div>
      </div>
    `).join('');

    if (winner) {
      document.getElementById('generic-victory').style.display = 'block';
      document.getElementById('generic-winner-name').textContent = winner.name;
    } else {
      document.getElementById('generic-victory').style.display = 'none';
    }
  },

  /* ─── Paramètres ─── */
  async render_settings() {
    UI._passwordSettingsUnlocked = false;
    const editor = document.getElementById('password-settings-editor');
    const unlock = document.getElementById('password-settings-unlock');
    if (editor) editor.style.display = 'none';
    if (unlock) unlock.style.display = 'flex';
    ['pwd-master','pwd-manual','pwd-stats','pwd-data'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const nullPointsEl = document.getElementById('fh-null-points-setting');
    if (nullPointsEl) nullPointsEl.value = await DB.getSetting('fiveHundredNullPoints', 50);
  },

  /* ─── Statistiques globales ─── */
  async render_stats() {
    const games = await DB.getAll('games');
    const statsResetAt = await DB.getSetting('statsResetAt', null);
    const resetTimestamp = statsResetAt ? new Date(statsResetAt).getTime() : null;
    const allRecords = Stats.records(games).filter(r => {
      if (!resetTimestamp) return true;
      const recordTimestamp = new Date(r.date).getTime();
      return Number.isFinite(recordTimestamp) && recordTimestamp >= resetTimestamp;
    });
    const gameFilter = document.getElementById('stats-game-filter')?.value || 'all';
    const modeFilter = document.getElementById('stats-mode-filter')?.value || 'all';
    const periodFilter = document.getElementById('stats-period-filter')?.value || 'all';
    const playerFilter = document.getElementById('stats-player-filter')?.value || 'all';
    const teamFilter = document.getElementById('stats-team-filter')?.value || 'all';

    const allPlayers = new Map();
    const allTeams = new Map();
    allRecords.forEach(r => {
      r.players.forEach(n => { const k = Stats.nameKey(n); if (!allPlayers.has(k)) allPlayers.set(k, n); });
      r.teams.forEach(t => { if (t.key && !allTeams.has(t.key)) allTeams.set(t.key, Stats.teamLabel(t.members)); });
    });

    const fillSelect = (id, entries, allLabel, current) => {
      const el = document.getElementById(id); if (!el) return;
      el.innerHTML = `<option value="all">${allLabel}</option>` + entries.map(([v,l]) => `<option value="${Utils.esc(v)}">${Utils.esc(l)}</option>`).join('');
      el.value = entries.some(([v]) => v === current) ? current : 'all';
    };
    fillSelect('stats-player-filter', [...allPlayers.entries()].sort((a,b)=>a[1].localeCompare(b[1],'fr-CA')), 'Tous les joueurs', playerFilter);
    fillSelect('stats-team-filter', [...allTeams.entries()].sort((a,b)=>a[1].localeCompare(b[1],'fr-CA')), 'Toutes les équipes', teamFilter);

    const now = Date.now();
    const days = periodFilter === '30' ? 30 : periodFilter === '90' ? 90 : periodFilter === '365' ? 365 : null;
    let records = allRecords.filter(r => {
      if (gameFilter !== 'all' && r.gameType !== gameFilter) return false;
      if (modeFilter !== 'all' && r.mode !== modeFilter) return false;
      if (days && (now - new Date(r.date).getTime()) > days * 86400000) return false;
      if (playerFilter !== 'all' && !r.players.some(n => Stats.nameKey(n) === playerFilter)) return false;
      if (teamFilter !== 'all' && !r.teams.some(t => t.key === teamFilter)) return false;
      return true;
    });

    const playerMap = new Map();
    records.forEach(r => r.players.forEach(name => {
      const key = Stats.nameKey(name);
      if (playerFilter !== 'all' && key !== playerFilter) return;
      const x = playerMap.get(key) || { name, games:0, wins:0 };
      x.games++;
      if (r.winnerPlayers.some(w => Stats.nameKey(w) === key)) x.wins++;
      playerMap.set(key, x);
    }));

    const teamMap = new Map();
    records.filter(r => r.mode === 'teams').forEach(r => r.teams.forEach(t => {
      if (teamFilter !== 'all' && t.key !== teamFilter) return;
      const x = teamMap.get(t.key) || { name: Stats.teamLabel(t.members), games:0, wins:0 };
      x.games++;
      if (r.winnerTeamKey === t.key) x.wins++;
      teamMap.set(t.key, x);
    }));

    const detailMap = new Map();
    records.forEach(r => r.players.forEach(name => {
      const keyName = Stats.nameKey(name);
      if (playerFilter !== 'all' && keyName !== playerFilter) return;
      const key = `${keyName}|${r.gameType}|${r.mode}`;
      const x = detailMap.get(key) || { name, game:r.gameLabel, mode:r.mode, games:0, wins:0 };
      x.games++;
      if (r.winnerPlayers.some(w => Stats.nameKey(w) === keyName)) x.wins++;
      detailMap.set(key, x);
    }));

    const rowHtml = (x, extra='') => `<div class="stats-row"><div class="stats-main"><strong>${Utils.esc(x.name)}</strong>${extra}</div><div>${x.wins}/${x.games}</div><div class="stats-pct">${Stats.pct(x.wins,x.games).toFixed(1)} %</div></div>`;
    const playersEl = document.getElementById('stats-player-results');
    const teamsEl = document.getElementById('stats-team-results');
    const detailEl = document.getElementById('stats-detail-results');
    const summaryEl = document.getElementById('stats-summary');
    if (summaryEl) {
      const resetInfo = statsResetAt
        ? `<div class="stats-reset-info">Statistiques réinitialisées le ${Utils.esc(Utils.formatDate(statsResetAt))}</div>`
        : '';
      summaryEl.innerHTML = `<strong>${records.length}</strong> partie(s) terminée(s) correspondant aux filtres${resetInfo}`;
    }
    if (playersEl) {
      const rows = [...playerMap.values()].sort((a,b)=>b.games-a.games || Stats.pct(b.wins,b.games)-Stats.pct(a.wins,a.games));
      playersEl.innerHTML = rows.length ? rows.map(x=>rowHtml(x)).join('') : '<div class="empty-state-text">Aucune statistique individuelle</div>';
    }
    if (teamsEl) {
      const rows = [...teamMap.values()].sort((a,b)=>b.games-a.games || Stats.pct(b.wins,b.games)-Stats.pct(a.wins,a.games));
      teamsEl.innerHTML = rows.length ? rows.map(x=>rowHtml(x)).join('') : '<div class="empty-state-text">Aucune statistique d’équipe</div>';
    }
    if (detailEl) {
      const rows = [...detailMap.values()].sort((a,b)=>a.name.localeCompare(b.name,'fr-CA') || a.game.localeCompare(b.game,'fr-CA'));
      detailEl.innerHTML = rows.length ? rows.map(x=>rowHtml(x, `<span class="stats-sub">${Utils.esc(x.game)} · ${x.mode === 'teams' ? 'Équipe' : 'Individuel'}</span>`)).join('') : '<div class="empty-state-text">Aucun détail</div>';
    }
  },

  /* ─── Historique ─── */
  async render_history() {
    if (!State.currentGame) return;
    const game = State.currentGame;
    const el   = document.getElementById('history-list');

    const entries = [...game.history].reverse();
    if (!entries.length) {
      el.innerHTML = `<div class="empty-state">
        <div class="empty-state-icon">📋</div>
        <div class="empty-state-text">Aucune action enregistrée</div>
      </div>`;
      return;
    }

    el.innerHTML = entries.map(e => {
      if (e.kind === 'timer') {
        const label = e.scope === 'set'
          ? `⏱ Partie ${e.seriesGameNumber || ''}`.trim()
          : '⏱ Temps de partie';
        const suffix = e.interrupted ? ' · interrompue' : '';
        return `
          <div class="history-entry history-timer-entry">
            <div class="history-header">
              <span class="history-player">${label}${suffix}</span>
              <span class="history-time">${Utils.formatDate(e.endedAt || e.timestamp)}</span>
            </div>
            <div class="history-detail"><strong>${Utils.formatDuration(e.durationMs)}</strong> · début ${Utils.formatDate(e.startedAt)} · fin ${Utils.formatDate(e.endedAt || e.timestamp)}</div>
          </div>
        `;
      }
      if (game.type === 'hearts') {
        return `
          <div class="history-round-marker">— Round ${e.round} · Total ${e.total} pts —</div>
          ${e.scores.map(s => `
            <div class="history-entry">
              <div class="history-header">
                <span class="history-player">${Utils.esc(s.player)}</span>
                <span class="history-time">R${e.round}</span>
              </div>
              <div class="history-detail">
                ${s.oldValue} <span class="${s.delta >= 0 ? 'history-delta-pos' : 'history-delta-neg'}">${Utils.signed(s.delta)}</span> → ${s.newValue}
              </div>
            </div>
          `).join('')}
        `;
      } else if (game.type === 'fiveHundred') {
        if (e.kind === 'individualRound') {
          const perTrick = e.success ? '' : ` · bassin ${e.opponentPointsPool ?? '?'} pts · ${e.pointsPerOpposingTrick} pts/levée`;
          const scoreLines = e.scores.map(sc => {
            const trickText = sc.tricks === null || sc.tricks === undefined ? '' : `${sc.tricks} levée(s), `;
            return `<div class="history-detail">${Utils.esc(sc.player)} : ${trickText}${Utils.signed(sc.delta)} pts → ${sc.newValue}</div>`;
          }).join('');
          return `
            <div class="history-entry">
              <div class="history-header">
                <span class="history-player">${Utils.esc(e.bidder)} · ${e.contract}</span>
                <span class="history-time">${Utils.formatDate(e.timestamp)}</span>
              </div>
              <div class="history-detail">${e.success ? '✅ Contrat réussi' : '❌ Contrat chuté'}${perTrick}</div>
              ${scoreLines}
              ${e.nextBidder ? `<div class="history-detail">Prochaine mise : ${Utils.esc(e.nextBidder)}${e.nextBidderSeat ? ` · ${Utils.esc(e.nextBidderSeat)}` : ''}</div>` : ''}
            </div>
          `;
        }
        if (e.kind === 'nullDeal') {
          const blockText = e.appliedPoints > 0
            ? `+${e.appliedPoints} points aux deux équipes`
            : `0 point ajouté${e.blockedBy?.length ? ` (seuil 1000 : ${Utils.esc(e.blockedBy.join(' / '))})` : ''}`;
          return `
            <div class="history-entry">
              <div class="history-header">
                <span class="history-player">Partie nulle</span>
                <span class="history-time">${Utils.formatDate(e.timestamp)}</span>
              </div>
              <div class="history-detail">${blockText}</div>
              ${e.nextBidder ? `<div class="history-detail">Prochaine mise : ${Utils.esc(e.nextBidder)}</div>` : ''}
            </div>
          `;
        }
        if (e.kind === 'manual') {
          return `
            <div class="history-entry">
              <div class="history-header">
                <span class="history-player">${Utils.esc(e.player || e.team || '')} · Ajustement manuel</span>
                <span class="history-time">${Utils.formatDate(e.timestamp)}</span>
              </div>
              <div class="history-detail">${e.oldValue} <span class="${e.delta >= 0 ? 'history-delta-pos' : 'history-delta-neg'}">${Utils.signed(e.delta)}</span> → ${e.newValue}</div>
            </div>
          `;
        }
        const contractLabel = Games.fiveHundred.contractLabel(e.contract);
        const awardedPoints = e.awardedPoints ?? e.delta ?? e.points ?? 0;
        const ruleText = e.lossRule === 'partie-half'
          ? ' · pénalité 50 %'
          : (e.lossRule === 'mulot-325' ? ' · pénalité Mulot 325'
            : (e.lossRule === 'mulot-330' ? ' · pénalité Mulot 330'
              : (e.lossRule === 'mulot-250' ? ' · pénalité Mulot 250' : '')));
        // Compatibilité avec le premier build 2.4 qui journalisait encore une case « enchère ouverte ».
        const openText = e.openBid ? ' · enchère ouverte' : '';
        return `
          <div class="history-entry">
            <div class="history-header">
              <span class="history-player">${Utils.esc(e.team)} · ${contractLabel}${openText}</span>
              <span class="history-time">${Utils.formatDate(e.timestamp)}</span>
            </div>
            <div class="history-detail">${e.directAward ? '✅ Points accordés' : (e.success ? '✅ Contrat réussi' : '❌ Contrat chuté')} · ${awardedPoints} pts à ${Utils.esc(e.awardedTeam || e.team)}${ruleText}</div>
            <div class="history-detail">${Utils.esc(e.awardedTeam || e.team)} : ${e.oldValue} +${e.delta} → ${e.newValue}</div>
            ${e.seriesGameNumber ? `<div class="history-detail">Partie ${e.seriesGameNumber} de la série</div>` : ''}
            ${e.nextBidder ? `<div class="history-detail">Prochaine mise : ${Utils.esc(e.nextBidder)}</div>` : ''}
          </div>
        `;
      } else {
        return `
          <div class="history-entry">
            <div class="history-header">
              <span class="history-player">${Utils.esc(e.player || e.team || '')}</span>
              <span class="history-time">${Utils.formatDate(e.timestamp)}</span>
            </div>
            <div class="history-detail">
              ${e.oldValue} <span class="${e.delta >= 0 ? 'history-delta-pos' : 'history-delta-neg'}">${Utils.signed(e.delta)}</span> → ${e.newValue}
            </div>
          </div>
        `;
      }
    }).join('');
  },
};

/* ================================================================
   SECTION 8 : CONTRÔLEUR UI
   ================================================================ */

const UI = {
  _magicDelta: 1,       // valeur par défaut pour +/- en Magic
  _selectedContract: null,  // contrat sélectionné en jeu de 500
  _selectedTeam: null,      // équipe/joueur sélectionné en jeu de 500
  _newFhSavedNames: [],
  _fhOpponentOrder: [],
  _fhOpponentStep: 0,
  _fhOpponentTricks: [],
  _fhAudioContext: null,
  _fhSoundReady: false,
  _fhStarterTimer: null,
  _passwordSettingsUnlocked: false,
  _gameTimerInterval: null,

  timerLabel(game) {
    if (!game) return 'Temps';
    if (game.type === 'fiveHundred' && game.mode === 'teams') {
      return `Partie ${game.series?.gameNumber || 1}`;
    }
    return 'Temps de partie';
  },

  updateGameTimerDisplay() {
    const game = State.currentGame;
    const elapsed = GameTimer.elapsedMs(game);
    document.querySelectorAll('[data-game-timer-value]').forEach(el => {
      el.textContent = Utils.formatDuration(elapsed);
    });
    document.querySelectorAll('[data-game-timer-label]').forEach(el => {
      el.textContent = this.timerLabel(game);
    });
  },

  startGameTimerTicker() {
    clearInterval(UI._gameTimerInterval);
    this.updateGameTimerDisplay();
    UI._gameTimerInterval = setInterval(() => this.updateGameTimerDisplay(), 1000);
  },

  closeModalFromBackdrop(event) {
    if (event.target === event.currentTarget) this.closeAppModal();
  },

  closeAppModal() {
    const overlay = document.getElementById('app-modal-overlay');
    const title = document.getElementById('app-modal-title');
    const body = document.getElementById('app-modal-body');
    if (overlay) overlay.style.display = 'none';
    if (title) title.textContent = '';
    if (body) body.innerHTML = '';
    UI._selectedContract = null;
    UI._selectedTeam = null;
    UI.resetFhIndividualFlow();
  },

  openAppModal(title, bodyHtml) {
    const overlay = document.getElementById('app-modal-overlay');
    const titleEl = document.getElementById('app-modal-title');
    const bodyEl = document.getElementById('app-modal-body');
    if (!overlay || !titleEl || !bodyEl) return;
    titleEl.textContent = title;
    bodyEl.innerHTML = bodyHtml;
    overlay.style.display = 'flex';
  },

  fhContractTableHtml(interactive = false) {
    const game = State.currentGame;
    const bids = ['7','8','9','10'];
    const hasOpenContracts = game?.mode === 'teams';
    const suitClass = (suit) => suit === '♥' ? 'suit-heart' : suit === '♦' ? 'suit-diamond' : suit === 'NT' ? 'suit-nt' : 'suit-black';

    const contractCell = (key, labelHtml, pts, extraClass = '') => {
      if (interactive) {
        return `<button class="contract-btn ${extraClass} ${UI._selectedContract === key ? 'selected' : ''}" onclick="UI.selectContract('${key}')" data-key="${key}">${labelHtml}<small>${pts}</small></button>`;
      }
      return `<div class="fh-contract-value-cell ${extraClass}">${labelHtml}<strong>${pts}</strong></div>`;
    };

    const mulotHtml = game?.mode === 'teams'
      ? (interactive
        ? `<button class="contract-btn fh-mulot-contract fh-mulot-between-row ${UI._selectedContract === FIVE_HUNDRED_MULOT.key ? 'selected' : ''}" onclick="UI.selectContract('${FIVE_HUNDRED_MULOT.key}')" data-key="${FIVE_HUNDRED_MULOT.key}"><span class="contract-inline-label"><span class="bid-text">MULOT</span></span><small>325 / échec 325</small></button>`
        : `<div class="fh-contract-value-cell fh-mulot-contract fh-mulot-between-row"><span class="contract-inline-label"><span class="bid-text">MULOT</span></span><strong>325</strong><small>échec : 325</small></div>`)
      : '';

    const rows = bids.map((bid) => {
      let row = '';
      if (hasOpenContracts) {
        if (bid === '10') {
          row += `<div class="fh-contract-open-empty" title="La Partie doit préciser l'atout"><span>—</span></div>`;
        } else {
          const key = `${bid}O`;
          const pts = Games.fiveHundred.contractPoints(game, key);
          const labelHtml = `<span class="contract-inline-label"><span class="bid-text">${bid}</span><span class="open-contract-marker">O</span></span>`;
          row += contractCell(key, labelHtml, pts, 'fh-open-contract');
        }
      }

      row += SUITS.map((suit) => {
        const key = `${bid}${suit}`;
        const pts = Games.fiveHundred.contractPoints(game, key);
        const bidLabel = bid === '10' ? '★' : bid;
        const suitLabel = suit === 'NT' ? 'S' : suit;
        const labelHtml = `<span class="contract-inline-label"><span class="bid-text">${bidLabel}</span><span class="suit-inline ${suitClass(suit)}">${suitLabel}</span></span>`;
        return contractCell(key, labelHtml, pts);
      }).join('');

      if (bid === '8' && mulotHtml) row += mulotHtml;
      return row;
    }).join('');

    return `
      <div class="fh-contract-table ${interactive ? 'interactive' : 'readonly'} ${hasOpenContracts ? 'with-open-contracts' : ''}">
        ${hasOpenContracts ? `<div class="fh-open-contract-legend"><strong>O = ouvert avant le minou</strong><span>7 = 130 · 8 = 230 · 9 = 330</span></div>` : ''}
        <div class="fh-contract-head ${hasOpenContracts ? 'with-open' : ''}">${hasOpenContracts ? '<div title="Enchère ouverte">O</div>' : ''}<div>♠</div><div>♣</div><div>♦</div><div>♥</div><div>S</div></div>
        <div class="fh-contract-grid ${hasOpenContracts ? 'with-open' : ''}">
          ${rows}
        </div>
      </div>`;
  },

  openFhInfoModal() {
    const game = State.currentGame;
    if (!game || game.type !== 'fiveHundred') return;
    const seats = Games.fiveHundred.ensureTableSetup(game);
    const next = Games.fiveHundred.nextBidder(game);
    const teamsBlock = game.mode === 'teams'
      ? `<div class="fh-info-group"><div class="card-title">Équipes</div>${game.teams.map((team, teamIdx) => `<div class="setting-sub"><strong>${Utils.esc(team.name)}</strong> : ${seats.filter(p => p.teamIdx === teamIdx).map(p => Utils.esc(p.name)).join(' + ')}</div>`).join('')}</div>`
      : '';
    const html = `
      <div class="fh-info-group">
        <div class="card-title">Ordre autour de la table</div>
        <div class="setting-sub" style="margin-bottom:10px">L’ordre affiché correspond au placement autour de la table. Le premier nom commence la série. Ensuite, les mises tournent dans cet ordre après chaque contrat.</div>
        <div class="fh-player-order">
          ${seats.map((player, i) => {
            const team = game.mode === 'teams' ? game.teams[player.teamIdx] : null;
            return `<div class="fh-order-row ${i === next.seatIdx ? 'fh-starter-active' : ''}" data-seat-idx="${i}"><span class="fh-order-num">${i + 1}</span><strong>${Utils.esc(player.name)}</strong>${team ? `<span class="badge badge-accent">${Utils.esc(team.name)}</span>` : ''}</div>`;
          }).join('')}
        </div>
      </div>
      ${teamsBlock}
      <div class="fh-info-group">
        <div class="card-title">Prochaine mise</div>
        <div class="fh-next-bidder"><span>Premier joueur à miser</span><strong>${Utils.esc(next.name)}</strong></div>
      </div>
      <div class="fh-info-group">
        <div class="card-title">Valeur des contrats</div>
        ${this.fhContractTableHtml(false)}
      </div>
      ${game.mode === 'teams' ? `
      <div class="fh-info-group fh-v24-rules">
        <div class="card-title">Règles 500 adaptées v2.6</div>
        <div class="setting-sub"><strong>Enchère ouverte :</strong> 7, 8 ou 9 peuvent être annoncés sans nommer l'atout avant le minou. Après avoir pris le minou, le gagnant choisit ♠, ♣, ♦, ♥ ou S, mais conserve le pointage fixe de l'enchère ouverte : 7 = 130, 8 = 230, 9 = 330. Le risque est moindre, donc le contrat rapporte moins qu'une couleur annoncée immédiatement.</div>
        <div class="setting-sub" style="margin-top:8px"><strong>Surenchère :</strong> un joueur encore actif peut remonter sa propre enchère lors d'un tour suivant. Ordre clé : 7S (220) &lt; 8 ouvert (230) &lt; 8♠ (240), puis 8S (320) &lt; Mulot (325) &lt; 9 ouvert (330) &lt; 9♠ (340).</div>
        <div class="setting-sub" style="margin-top:8px"><strong>Partie chutée :</strong> les adversaires reçoivent 50 % de la valeur du contrat final. Exemples : Partie ♠ = 520, Partie ♥ = 550, Partie S = 560.</div>
        <div class="setting-sub" style="margin-top:8px"><strong>Mulot :</strong> le miseur joue seul et doit faire 0 levée sur 10. Son partenaire ne joue pas. Le minou de 6 cartes reste face cachée et n'est pas consulté. Il n'y a pas d'atout. Les deux jokers deviennent les deux cartes les plus faibles et ne permettent pas d'éviter l'obligation de fournir la couleur. Réussite : +325. Échec dès la première levée remportée : +325 aux adversaires.</div>
      </div>` : ''}
    `;
    this.openAppModal('Informations du 500', html);
  },

  openFhManualAdjustModal() {
    const game = State.currentGame;
    if (!game || game.type !== 'fiveHundred') return;
    const html = `
      <div class="setting-sub" style="margin-bottom:12px">Le mot de passe d’ajustement manuel sera demandé avant la modification.</div>
      <div class="form-group">
        <label class="form-label">Équipe ou joueur</label>
        <select class="form-select" id="fh-modal-adjust-entity"></select>
      </div>
      <div class="generic-input-row">
        <input class="generic-delta-input" type="number" id="fh-modal-adjust-value" min="0" value="0" placeholder="Points">
        <button class="btn btn-success btn-icon" onclick="UI.fhManualAdjust(1)" title="Ajouter">+</button>
        <button class="btn btn-danger btn-icon" onclick="UI.fhManualAdjust(-1)" title="Retirer">−</button>
      </div>
    `;
    this.openAppModal('Ajustement manuel / pénalité', html);
    this.renderFhManualAdjust();
  },

  openFhResultModal() {
    const game = State.currentGame;
    if (!game || game.type !== 'fiveHundred') return;
    UI._selectedContract = null;
    UI._selectedTeam = null;
    UI.resetFhIndividualFlow();
    const isIndividual = game.mode === 'individual';
    const html = isIndividual
      ? `
        <div class="setting-sub" style="margin-bottom:12px">Sélectionnez le contrat, puis le joueur qui a misé.</div>
        ${this.fhContractTableHtml(true)}
        <div class="card-title" style="margin-top:14px">Joueur qui mise</div>
        <div class="team-select-row" id="fh-modal-bidder-buttons"></div>
        <div class="result-btns" style="margin-top:14px">
          <button class="btn btn-success" id="fh-modal-btn-bidder-win" onclick="UI.fhIndividualResult(true)" disabled>✅ Mise gagnée</button>
          <button class="btn btn-danger" id="fh-modal-btn-bidder-lose" onclick="UI.fhIndividualResult(false)" disabled>❌ Mise perdue</button>
        </div>
        <div id="fh-modal-opponent-tricks-panel" style="display:none"></div>
      `
      : `
        <div class="setting-sub" style="margin-bottom:12px">Sélectionnez le contrat final, puis l'équipe qui a remporté les enchères. Pour une enchère ouverte, choisissez 7 O, 8 O ou 9 O : le pointage demeure 130, 230 ou 330 même après le choix de l'atout. La pénalité réduite d'une Partie et le pointage du Mulot sont appliqués automatiquement.</div>
        ${this.fhContractTableHtml(true)}
        <div class="card-title" style="margin-top:14px">Équipe qui a misé</div>
        <div class="team-select-row" id="fh-modal-bidder-buttons"></div>
        <div class="result-btns" style="margin-top:14px">
          <button class="btn btn-success" id="fh-modal-btn-team-win" onclick="UI.fhApplyResult(true)" disabled>✅ Mise gagnée</button>
          <button class="btn btn-danger" id="fh-modal-btn-team-lose" onclick="UI.fhApplyResult(false)" disabled>❌ Mise perdue</button>
        </div>
        <div class="setting-sub fh-team-result-hint" id="fh-team-result-hint"></div>
      `;
    this.openAppModal('Partie terminée', html);
    this.renderFhEntityButtons();
    this.updateFhSubmitBtn();
  },

  async saveFhNullPointsSetting() {
    const input = document.getElementById('fh-null-points-setting');
    const value = Math.max(0, parseInt(input?.value || '50', 10) || 0);
    await DB.setSetting('fiveHundredNullPoints', value);
    if (input) input.value = value;
    Utils.toast(`Partie nulle : ${value} points configurés`, 'success', 3000);
  },

  openSettings() {
    Router.go('settings');
  },

  async unlockPasswordSettings() {
    const ok = await Security.require('master', 'Mot de passe maître requis pour modifier les mots de passe :');
    if (!ok) return;

    UI._passwordSettingsUnlocked = true;
    const values = await Promise.all([
      Security.get('master'),
      Security.get('manualAdjust'),
      Security.get('statsReset'),
      Security.get('dataReset'),
    ]);
    const ids = ['pwd-master','pwd-manual','pwd-stats','pwd-data'];
    ids.forEach((id, i) => {
      const el = document.getElementById(id);
      if (el) el.value = values[i];
    });
    const editor = document.getElementById('password-settings-editor');
    const unlock = document.getElementById('password-settings-unlock');
    if (editor) editor.style.display = 'block';
    if (unlock) unlock.style.display = 'none';
  },

  async savePasswordSettings() {
    if (!UI._passwordSettingsUnlocked) {
      Utils.toast('Déverrouillez d’abord les paramètres avec le mot de passe maître', 'error');
      return;
    }

    const values = {
      master: document.getElementById('pwd-master')?.value ?? '',
      manualAdjust: document.getElementById('pwd-manual')?.value ?? '',
      statsReset: document.getElementById('pwd-stats')?.value ?? '',
      dataReset: document.getElementById('pwd-data')?.value ?? '',
    };
    if (Object.values(values).some(v => !v.length)) {
      Utils.toast('Aucun mot de passe ne peut être vide', 'error');
      return;
    }

    await Promise.all(Object.entries(values).map(([kind, value]) => Security.set(kind, value)));
    UI._passwordSettingsUnlocked = false;
    Screens.render_settings();
    Utils.toast('Mots de passe enregistrés', 'success', 3500);
  },

  /** Active le contexte audio à partir d'un geste utilisateur. */
  unlockFhSound() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!UI._fhAudioContext) UI._fhAudioContext = new AudioCtx();
      if (UI._fhAudioContext.state === 'suspended') UI._fhAudioContext.resume();
      UI._fhSoundReady = true;
    } catch (err) {
      console.warn('[500] Audio non disponible', err);
    }
  },

  /** Petit double carillon pour signaler le premier miseur. */
  playFhStarterSound() {
    try {
      this.unlockFhSound();
      const ctx = UI._fhAudioContext;
      if (!ctx || ctx.state !== 'running') return;
      const now = ctx.currentTime;
      [
        { freq: 659.25, start: 0.00, duration: 0.13, gain: 0.12 },
        { freq: 880.00, start: 0.16, duration: 0.22, gain: 0.16 },
      ].forEach((note) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(note.freq, now + note.start);
        gain.gain.setValueAtTime(0.0001, now + note.start);
        gain.gain.exponentialRampToValueAtTime(note.gain, now + note.start + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + note.start + note.duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + note.start);
        osc.stop(now + note.start + note.duration + 0.02);
      });
    } catch (err) {
      console.warn('[500] Son de départ impossible', err);
    }
  },

  /** Met fortement en évidence le joueur qui ouvrira les mises. */
  announceFhStarter(playSound = true) {
    const game = State.currentGame;
    if (!game || game.type !== 'fiveHundred' || game.status === 'finished') return;
    const next = Games.fiveHundred.nextBidder(game);
    const row = document.querySelector(`.fh-order-row[data-seat-idx="${next.seatIdx}"]`);
    const banner = document.getElementById('fh-next-bidder-banner');
    const callout = document.getElementById('fh-starter-callout');
    const calloutName = document.getElementById('fh-starter-callout-name');

    document.querySelectorAll('.fh-order-row.fh-starter-active').forEach(el => el.classList.remove('fh-starter-active'));
    if (banner) banner.classList.remove('fh-starter-flash');
    if (callout) callout.classList.remove('active');
    void document.body.offsetWidth;

    if (row) row.classList.add('fh-starter-active');
    if (banner) banner.classList.add('fh-starter-flash');
    if (calloutName) calloutName.textContent = next.name;
    if (callout) callout.classList.add('active');
    if (playSound) this.playFhStarterSound();
    if (navigator.vibrate) navigator.vibrate([80, 45, 120]);

    clearTimeout(UI._fhStarterTimer);
    UI._fhStarterTimer = setTimeout(() => {
      if (row) row.classList.remove('fh-starter-active');
      if (banner) banner.classList.remove('fh-starter-flash');
      if (callout) callout.classList.remove('active');
    }, 2300);
  },

  /** Démarre la création d'une partie */
  startNewGame(type) {
    Router.go('new-game', { type });
  },

  setNewFhMode(mode) {
    document.getElementById('fh-new-mode').value = mode;
    document.getElementById('fh-new-teams').style.display = mode === 'teams' ? 'block' : 'none';
    document.getElementById('fh-new-individual').style.display = mode === 'individual' ? 'block' : 'none';
    document.getElementById('fh-mode-teams').classList.toggle('active', mode === 'teams');
    document.getElementById('fh-mode-individual').classList.toggle('active', mode === 'individual');
  },

  updateNewFhTeamLabels() {
    const teamNames = [
      document.getElementById('team0-name')?.value.trim() || 'Équipe 1',
      document.getElementById('team1-name')?.value.trim() || 'Équipe 2',
    ];
    const s0 = document.getElementById('fh-new-team-summary-0');
    const s1 = document.getElementById('fh-new-team-summary-1');
    if (s0) s0.textContent = `${teamNames[0]} : positions 1 + 3 après tirage`;
    if (s1) s1.textContent = `${teamNames[1]} : positions 2 + 4 après tirage`;
  },

  renderNewFhPlayerInputs() {
    const countEl = document.getElementById('fh-player-count');
    const inputs = document.getElementById('fh-player-name-inputs');
    if (!countEl || !inputs) return;
    const count = parseInt(countEl.value, 10);
    inputs.innerHTML = Array.from({length: count}, (_, i) => `
      <div class="player-input-row">
        <div class="player-input-num">${i+1}</div>
        <input class="form-input" type="text" placeholder="Joueur ${i+1}"
          value="${Utils.esc(UI._newFhSavedNames[i] || '')}" maxlength="16" data-player="${i}">
      </div>
    `).join('');
  },

  /** Reprend une partie existante. Les anciennes parties actives démarrent leur chrono à la première reprise après mise à jour. */
  async resumeGame(game) {
    GameTimer.migrate(game);
    State.currentGame = game;
    await DB.save('games', game);
    const screenMap = {
      hearts:      'hearts',
      magic:       'magic',
      fiveHundred: 'five-hundred',
      generic:     'generic',
    };
    Router.go(screenMap[game.type] || 'home');
    this.updateGameTimerDisplay();
  },

  /** Crée la partie à partir du formulaire */
  async createGame() {
    const type = document.getElementById('new-game-type').value;
    if (type === 'fiveHundred') this.unlockFhSound();

    try {
      let game;

      if (type === 'fiveHundred') {
        const mode = document.getElementById('fh-new-mode')?.value || 'teams';
        if (mode === 'individual') {
          const inputs = document.querySelectorAll('#fh-player-name-inputs input');
          const names = Array.from(inputs).map((inp, i) => inp.value.trim() || `Joueur ${i+1}`);
          localStorage.setItem('savedPlayerNames', JSON.stringify(names));
          game = Games.fiveHundred.createIndividual(names);
        } else {
          const teamPlayerInputs = document.querySelectorAll('#fh-team-player-inputs input');
          const tablePlayerNames = Array.from(teamPlayerInputs).map((inp, i) => inp.value.trim() || `Joueur ${i + 1}`);
          const seriesBestOf = parseInt(document.getElementById('fh-series-bestof')?.value || '3', 10);
          game = Games.fiveHundred.createTeams(null, null, tablePlayerNames, seriesBestOf);
        }

      } else {
        const count = parseInt(document.getElementById('player-count').value);
        const nameInputs = document.querySelectorAll('#player-name-inputs input');
        const names = Array.from(nameInputs).map((inp, i) => inp.value.trim() || `Joueur ${i+1}`);

        // Sauvegarder les noms pour la prochaine fois
        localStorage.setItem('savedPlayerNames', JSON.stringify(names));

        if (type === 'magic') {
          const life = parseInt(document.getElementById('magic-start-life').value);
          game = Games.magic.create(names, life);
        } else if (type === 'generic') {
          const limitVal = parseInt(document.getElementById('score-limit').value) || 0;
          game = Games.generic.create(names, limitVal > 0 ? limitVal : null);
        } else {
          game = Games.hearts.create(names);
        }
      }

      GameTimer.initialize(game);
      State.currentGame = game;
      await DB.save('games', game);
      Utils.toast('Partie créée !', 'success');

      const screenMap = { hearts: 'hearts', magic: 'magic', fiveHundred: 'five-hundred', generic: 'generic' };
      Router.go(screenMap[type] || 'home');
      if (type === 'fiveHundred') setTimeout(() => UI.announceFhStarter(true), 180);

    } catch (err) {
      console.error(err);
      Utils.toast('Erreur lors de la création', 'error');
    }
  },

  /** Retour à l'accueil */
  goHome() {
    Router.go('home');
  },

  /** Va à l'écran historique */
  goHistory() {
    Router.go('history');
  },

  /* ─── HEARTS ─── */
  heartsAdjust(playerIdx, dir) {
    const input = document.getElementById(`hearts-delta-${playerIdx}`);
    input.value = Math.max(0, parseInt(input.value || 0) + dir);
    this.heartsUpdateTotal();
  },

  heartsUpdateTotal() {
    const game = State.currentGame;
    const deltas = game.players.map((_, i) => parseInt(document.getElementById(`hearts-delta-${i}`)?.value || 0));
    const current = game.players.reduce((s, p) => s + p.score, 0);
    const roundTotal = deltas.reduce((s, d) => s + d, 0);
    const newTotal  = current + roundTotal;
    const expected  = (game.round + 1) * 25;

    const numEl = document.getElementById('hearts-round-total');
    const valid = newTotal === expected;
    numEl.textContent = `${roundTotal} pts → Total : ${newTotal}`;
    numEl.className = `round-total-num ${valid ? 'valid' : 'invalid'}`;

    document.getElementById('hearts-expected-total').textContent = `Attendu : ${expected} pts`;
    document.getElementById('hearts-submit').disabled = !valid;
  },

  async heartsSubmitRound() {
    const game = State.currentGame;
    const deltas = game.players.map((_, i) => parseInt(document.getElementById(`hearts-delta-${i}`)?.value || 0));
    const result = Games.hearts.submitRound(game, deltas);

    if (!result.ok) {
      Utils.toast(result.msg, 'error');
      return;
    }

    await DB.save('games', game);
    Utils.toast(`Round ${result.round} validé !`, 'success');
    Screens.render_hearts();
  },

  /* ─── MAGIC ─── */
  setMagicDelta(val) {
    UI._magicDelta = val;
    document.querySelectorAll('.magic-quick-btn').forEach(btn => {
      btn.classList.toggle('selected', parseInt(btn.dataset.val) === val);
    });
  },

  async magicChange(playerIdx, sign) {
    const game  = State.currentGame;
    const delta = sign * UI._magicDelta;
    const result = Games.magic.changeLife(game, playerIdx, delta);
    await DB.save('games', game);

    // Animation du HP
    const hpEl = document.getElementById(`magic-hp-${playerIdx}`);
    const card  = document.getElementById(`magic-card-${playerIdx}`);
    if (hpEl) {
      const p = game.players[playerIdx];
      const pct = p.life / game.startingLife;
      hpEl.textContent = p.life;
      hpEl.className = `magic-hp ${pct > 0.5 ? 'high' : pct > 0.25 ? 'mid' : 'low'}`;
      card.className  = `magic-player-card ${p.dead ? 'dead' : ''}`;

      // Delta flash
      const dEl = document.getElementById(`magic-delta-${playerIdx}`);
      if (dEl) {
        const actualDelta = result.newValue - result.old;
        dEl.textContent = Utils.signed(actualDelta);
        dEl.style.color = actualDelta > 0 ? 'var(--success)' : 'var(--danger)';
        setTimeout(() => { dEl.textContent = ''; }, 1500);
      }
    }

    // Vérifier s'il reste un seul joueur vivant
    const alive = Games.magic.alivePlayers(game);
    if (alive.length === 1) {
      Utils.toast(`🏆 ${alive[0].name} remporte la partie !`, 'success', 4000);
    } else if (alive.length === 0) {
      Utils.toast('💀 Tous les joueurs sont morts !', 'error', 3000);
    }
  },

  /* ─── JEU DE 500 ─── */
  renderFhTableInfo() {
    const game = State.currentGame;
    const wrap = document.getElementById('fh-table-info');
    if (!game || !wrap) return;

    const seats = Games.fiveHundred.ensureTableSetup(game);
    const next = Games.fiveHundred.nextBidder(game);
    const teamSummary = game.mode === 'teams'
      ? `<div class="fh-team-summary">
          ${game.teams.map((team, teamIdx) => {
            const members = seats.filter(p => p.teamIdx === teamIdx).map(p => Utils.esc(p.name)).join(' + ');
            return `<div><strong>${Utils.esc(team.name)}</strong> : ${members}</div>`;
          }).join('')}
          <div class="divider"></div>
          <div><strong>Partie ${game.series?.gameNumber || 1}</strong> · Série ${game.series?.wins?.[0] || 0}-${game.series?.wins?.[1] || 0} · ${game.series?.winsNeeded || 1} victoire(s) requise(s)</div>
        </div>`
      : '';

    wrap.innerHTML = `
      <div class="card-title">Ordre autour de la table</div>
      <div class="setting-sub" style="margin-bottom:10px">Ordre tiré au hasard au début de la série. Le joueur 1 est celui qui commence à miser. Placez ensuite les joueurs autour de la table dans l'ordre affiché. En équipes, les joueurs 1 et 3 sont partenaires, tout comme les joueurs 2 et 4.</div>
      <div class="fh-player-order">
        ${seats.map((player, i) => {
          const team = game.mode === 'teams' ? game.teams[player.teamIdx] : null;
          return `<div class="fh-order-row" data-seat-idx="${i}">
            <span class="fh-order-num">${i + 1}</span>
            <strong>${Utils.esc(player.name)}</strong>
            ${team ? `<span class="badge badge-accent">${Utils.esc(team.name)}</span>` : ''}
          </div>`;
        }).join('')}
      </div>
      ${teamSummary}
      <div class="fh-next-bidder" id="fh-next-bidder-banner"><span>Première mise de la prochaine donne</span><strong>${Utils.esc(next.name)}</strong></div>
      <div class="fh-starter-callout" id="fh-starter-callout" aria-live="polite">
        <span>À TOI DE COMMENCER</span>
        <strong id="fh-starter-callout-name">${Utils.esc(next.name)}</strong>
      </div>
    `;
  },

  renderContractPicker() {
    // La grille des contrats est maintenant rendue directement dans les modals.
  },

  renderFhEntityButtons() {
    const game = State.currentGame;
    if (!game) return;
    const list = game.mode === 'individual' ? game.players : game.teams;
    ['fh-bidder-buttons', 'fh-modal-bidder-buttons'].forEach((id) => {
      const wrap = document.getElementById(id);
      if (!wrap) return;
      wrap.innerHTML = list.map((entity, i) => `
        <button class="team-select-btn ${UI._selectedTeam === i ? `selected team-${i % 2}` : ''}"
          onclick="UI.selectFhTeam(${i})">${Utils.esc(entity.name)}</button>
      `).join('');
    });
  },

  selectContract(key) {
    if (State.currentGame?.mode === 'individual') this.resetFhIndividualFlow();
    UI._selectedContract = key;
    document.querySelectorAll('.contract-btn').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.key === key);
    });
    this.updateFhSubmitBtn();
  },

  selectFhTeam(idx) {
    if (State.currentGame?.mode === 'individual') this.resetFhIndividualFlow();
    UI._selectedTeam = idx;
    this.renderFhEntityButtons();
    this.updateFhSubmitBtn();
  },

  resetFhIndividualFlow() {
    UI._fhOpponentOrder = [];
    UI._fhOpponentStep = 0;
    UI._fhOpponentTricks = [];
    const panel = document.getElementById('fh-modal-opponent-tricks-panel') || document.getElementById('fh-opponent-tricks-panel');
    if (panel) {
      panel.style.display = 'none';
      panel.innerHTML = '';
    }
    this.updateFhSubmitBtn();
  },

  fhIndividualResult(success) {
    const game = State.currentGame;
    if (!game || game.mode !== 'individual' || UI._selectedContract === null || UI._selectedTeam === null) return;

    if (success) {
      this.fhApplyIndividualSuccess();
      return;
    }

    UI._fhOpponentOrder = game.players.map((_, i) => i).filter(i => i !== UI._selectedTeam);
    UI._fhOpponentStep = 0;
    UI._fhOpponentTricks = Array(game.players.length).fill(null);
    this.renderFhOpponentTrickStep();
  },

  renderFhOpponentTrickStep() {
    const game = State.currentGame;
    const panel = document.getElementById('fh-modal-opponent-tricks-panel') || document.getElementById('fh-opponent-tricks-panel');
    if (!game || game.mode !== 'individual' || !panel || !UI._fhOpponentOrder.length) return;

    const playerIdx = UI._fhOpponentOrder[UI._fhOpponentStep];
    const player = game.players[playerIdx];
    const ordinal = UI._fhOpponentStep + 1;
    const totalOpponents = UI._fhOpponentOrder.length;
    const isLast = UI._fhOpponentStep === totalOpponents - 1;
    const saved = UI._fhOpponentTricks[playerIdx] ?? 0;

    panel.style.display = 'block';
    panel.innerHTML = `
      <div class="divider"></div>
      <div class="card-title">Joueur adverse ${ordinal}${totalOpponents > 1 ? ` sur ${totalOpponents}` : ''}</div>
      <div class="round-entry-player">
        <div class="rep-name">${Utils.esc(player.name)}</div>
        <div class="rep-controls">
          <button class="rep-btn" onclick="UI.fhAdjustOpponentTrick(-1)">−</button>
          <input class="rep-input" type="number" id="fh-opponent-tricks-current" value="${saved}" min="0" max="10">
          <button class="rep-btn" onclick="UI.fhAdjustOpponentTrick(1)">+</button>
        </div>
      </div>
      <div class="setting-sub" style="margin:10px 0 12px">Combien de levées ${Utils.esc(player.name)} a-t-il remportées ?</div>
      <button class="btn btn-primary" onclick="UI.fhOpponentTrickNext()">${isLast ? '✓ Calculer les points' : 'Suivant'}</button>
    `;
  },

  fhAdjustOpponentTrick(delta) {
    const input = document.getElementById('fh-opponent-tricks-current');
    if (!input) return;
    input.value = Utils.clamp((parseInt(input.value, 10) || 0) + delta, 0, 10);
  },

  async fhOpponentTrickNext() {
    this.unlockFhSound();
    const game = State.currentGame;
    if (!game || game.mode !== 'individual' || !UI._fhOpponentOrder.length) return;

    const input = document.getElementById('fh-opponent-tricks-current');
    const value = Utils.clamp(parseInt(input?.value || 0, 10) || 0, 0, 10);
    const playerIdx = UI._fhOpponentOrder[UI._fhOpponentStep];
    UI._fhOpponentTricks[playerIdx] = value;

    if (UI._fhOpponentStep < UI._fhOpponentOrder.length - 1) {
      UI._fhOpponentStep += 1;
      this.renderFhOpponentTrickStep();
      return;
    }

    const opposingTotal = UI._fhOpponentOrder.reduce((sum, i) => sum + (UI._fhOpponentTricks[i] || 0), 0);
    const bidTricks = parseInt(UI._selectedContract, 10);
    const minimumOpposingTricks = 11 - bidTricks;

    if (opposingTotal < minimumOpposingTricks) {
      Utils.toast(`Contrat ${bidTricks} chuté : les adversaires doivent avoir au moins ${minimumOpposingTricks} levée(s)`, 'error', 4000);
      return;
    }
    if (opposingTotal > 10) {
      Utils.toast('Le total des levées adverses ne peut pas dépasser 10', 'error');
      return;
    }

    const result = Games.fiveHundred.applyIndividualRound(
      game, UI._selectedTeam, UI._selectedContract, false, UI._fhOpponentTricks
    );
    await DB.save('games', game);
    const next = game.status === 'finished' ? null : Games.fiveHundred.nextBidder(game);
    Utils.toast(
      next
        ? `❌ Mise perdue : bassin ${result.opponentPointsPool} pts · ${result.pointsPerOpposingTrick} pts/levée · Prochaine mise : ${next.name}`
        : `🏆 ${game.winnerName} remporte la partie`,
      next ? 'info' : 'success',
      5000
    );

    this.closeAppModal();
    Screens.render_five_hundred();
    if (game.status !== 'finished') setTimeout(() => UI.announceFhStarter(true), 120);
  },

  updateFhSubmitBtn() {
    const game = State.currentGame;
    const hasSelection = UI._selectedContract !== null && UI._selectedTeam !== null;
    ['fh-btn-success','fh-btn-fail','fh-modal-btn-apply-team'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = !hasSelection;
    });

    ['fh-modal-btn-team-win','fh-modal-btn-team-lose'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = !(game?.mode === 'teams' && hasSelection);
    });

    ['fh-btn-bidder-win','fh-btn-bidder-lose','fh-modal-btn-bidder-win','fh-modal-btn-bidder-lose'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = !(game?.mode === 'individual' && hasSelection);
    });

    const hint = document.getElementById('fh-team-result-hint');
    if (hint && game?.mode === 'teams' && UI._selectedContract) {
      const full = Games.fiveHundred.contractPoints(game, UI._selectedContract);
      const failed = Games.fiveHundred.failedTeamContractPoints(game, UI._selectedContract);
      if (Games.fiveHundred.isMulotContract(UI._selectedContract)) {
        hint.innerHTML = `<strong>Mulot :</strong> réussite +${full}; échec +${failed} aux adversaires.`;
      } else if (Games.fiveHundred.isOpenContract(UI._selectedContract)) {
        hint.innerHTML = `<strong>${Games.fiveHundred.contractLabel(UI._selectedContract)} :</strong> réussite +${full}; échec +${failed} aux adversaires. L'atout choisi après le minou ne change pas cette valeur.`;
      } else if (Games.fiveHundred.isGameContract(UI._selectedContract)) {
        hint.innerHTML = `<strong>Partie :</strong> réussite +${full}; échec +${failed} aux adversaires (50 %).`;
      } else {
        hint.innerHTML = `Réussite +${full}; échec +${failed} aux adversaires.`;
      }
    }
  },

  async fhApplyResult(success) {
    if (UI._selectedContract === null || UI._selectedTeam === null) return;
    this.unlockFhSound();
    const game = State.currentGame;
    if (game.mode === 'individual') return;
    const contract = UI._selectedContract;
    const biddingTeamName = game.teams[UI._selectedTeam].name;
    const result = Games.fiveHundred.applyContract(game, UI._selectedTeam, contract, success);
    await DB.save('games', game);

    const next = result.nextBidder;
    const awarded = result.awardedTeam?.name || '';
    const isSeriesFinished = !!result.gameCompletion?.seriesWon;
    Utils.toast(
      isSeriesFinished
        ? `🏆 Série terminée : ${result.gameCompletion.seriesWinner.name} gagne ${game.series.wins[0]}-${game.series.wins[1]}`
        : success
          ? `✅ ${biddingTeamName} +${result.awardedPoints} pts · Prochaine mise : ${next.name}`
          : `❌ ${Games.fiveHundred.isMulotContract(contract) ? 'Mulot' : (Games.fiveHundred.isGameContract(contract) ? 'Partie' : Games.fiveHundred.contractLabel(contract))} chuté : +${result.awardedPoints} pts à ${awarded} · Prochaine mise : ${next.name}`,
      isSeriesFinished ? 'success' : (success ? 'success' : 'info'),
      5000
    );

    UI._selectedContract = null;
    UI._selectedTeam = null;

    if (result.gameCompletion) {
      const gc = result.gameCompletion;
      const series = game.series;
      if (gc.seriesWon) {
        await DB.save('games', game);
        alert(`Série gagnée par ${gc.seriesWinner.name} ! Résultat : ${series.wins[0]} - ${series.wins[1]}.`);
      } else {
        alert(`Partie ${gc.result.gameNumber} gagnée par ${gc.result.winnerTeamName}. Série : ${series.wins[0]} - ${series.wins[1]}. Les scores repartent à 0 pour la prochaine partie.`);
      }
    }

    this.closeAppModal();
    Screens.render_five_hundred();
    if (game.status !== 'finished') setTimeout(() => UI.announceFhStarter(true), 120);
  },

  async fhNullDeal() {
    this.unlockFhSound();
    const game = State.currentGame;
    if (!game || game.mode !== 'teams' || game.status === 'finished') return;
    const configuredPoints = await DB.getSetting('fiveHundredNullPoints', 50);
    const result = Games.fiveHundred.applyNullDeal(game, configuredPoints);
    await DB.save('games', game);

    if (result.appliedPoints > 0) {
      Utils.toast(`Partie nulle : +${result.appliedPoints} aux deux équipes · Prochaine mise : ${result.nextBidder.name}`, 'info', 4500);
    } else {
      const blocked = result.blockedTeams.map(t => t.name).join(' / ');
      Utils.toast(`Partie nulle : aucun point ajouté, car ${blocked} atteindrait 1000. Prochaine mise : ${result.nextBidder.name}`, 'info', 5200);
    }
    Screens.render_five_hundred();
    setTimeout(() => UI.announceFhStarter(true), 120);
  },

  async fhApplyTeamAward() {
    if (UI._selectedContract === null || UI._selectedTeam === null) return;
    this.unlockFhSound();
    const game = State.currentGame;
    if (!game || game.mode !== 'teams') return;
    const contract = UI._selectedContract;
    const result = Games.fiveHundred.applyAwardedContract(game, UI._selectedTeam, contract);
    await DB.save('games', game);

    const next = result.nextBidder;
    const awarded = result.awardedTeam?.name || '';
    const isSeriesFinished = !!result.gameCompletion?.seriesWon;
    Utils.toast(
      isSeriesFinished
        ? `🏆 Série terminée : ${result.gameCompletion.seriesWinner.name} gagne ${game.series.wins[0]}-${game.series.wins[1]}`
        : `✅ ${awarded} +${Games.fiveHundred.contractPoints(game, contract)} pts · Prochaine mise : ${next.name}`,
      'success',
      5000
    );

    if (result.gameCompletion) {
      const gc = result.gameCompletion;
      const series = game.series;
      if (gc.seriesWon) {
        await DB.save('games', game);
        alert(`Série gagnée par ${gc.seriesWinner.name} ! Résultat : ${series.wins[0]} - ${series.wins[1]}.`);
      } else {
        alert(`Partie ${gc.result.gameNumber} gagnée par ${gc.result.winnerTeamName}. Série : ${series.wins[0]} - ${series.wins[1]}. Les scores repartent à 0 pour la prochaine partie.`);
      }
    }

    this.closeAppModal();
    Screens.render_five_hundred();
    if (game.status !== 'finished') setTimeout(() => UI.announceFhStarter(true), 120);
  },

  async fhApplyIndividualSuccess() {
    this.unlockFhSound();
    const game = State.currentGame;
    if (!game || game.mode !== 'individual' || UI._selectedContract === null || UI._selectedTeam === null) return;

    const result = Games.fiveHundred.applyIndividualRound(game, UI._selectedTeam, UI._selectedContract, true, []);
    await DB.save('games', game);
    const next = game.status === 'finished' ? null : Games.fiveHundred.nextBidder(game);
    Utils.toast(
      next ? `✅ Mise gagnée : +${result.contractPoints} pts · Prochaine mise : ${next.name}` : `🏆 ${game.winnerName} remporte la partie`,
      'success',
      4200
    );

    this.closeAppModal();
    Screens.render_five_hundred();
    if (game.status !== 'finished') setTimeout(() => UI.announceFhStarter(true), 120);
  },

  renderFhManualAdjust() {
    const game = State.currentGame;
    if (!game) return;
    const list = game.mode === 'individual' ? game.players : game.teams;
    ['fh-adjust-entity','fh-modal-adjust-entity'].forEach((id) => {
      const sel = document.getElementById(id);
      if (sel) sel.innerHTML = list.map((e, i) => `<option value="${i}">${Utils.esc(e.name)}</option>`).join('');
    });
  },

  async fhManualAdjust(sign) {
    const game = State.currentGame;
    const idx = parseInt((document.getElementById('fh-modal-adjust-entity')?.value ?? document.getElementById('fh-adjust-entity')?.value ?? 0), 10);
    const raw = Math.abs(parseInt((document.getElementById('fh-modal-adjust-value')?.value ?? document.getElementById('fh-adjust-value')?.value ?? 0), 10));
    if (!raw) {
      Utils.toast('Entrez un nombre de points', 'error');
      return;
    }
    const authorized = await Security.require('manualAdjust', 'Mot de passe requis pour l’ajustement manuel / pénalité :');
    if (!authorized) return;
    const result = Games.fiveHundred.adjustScore(game, idx, raw * sign);
    await DB.save('games', game);
    Utils.toast(`Ajustement ${Utils.signed(result.delta)} pts`, result.delta < 0 ? 'error' : 'success');
    const input = document.getElementById('fh-modal-adjust-value') || document.getElementById('fh-adjust-value');
    if (input) input.value = 0;
    this.closeAppModal();
    Screens.render_five_hundred();
  },

  /* ─── GÉNÉRIQUE ─── */
  async genericApply(playerIdx, sign) {
    const deltaInput = document.getElementById(`generic-delta-${playerIdx}`);
    const raw  = parseInt(deltaInput?.value || 0);
    if (raw === 0 || isNaN(raw)) { Utils.toast('Entrez un nombre', 'error'); return; }
    const delta = Math.abs(raw) * sign;

    const game   = State.currentGame;
    const result = Games.generic.changeScore(game, playerIdx, delta);
    await DB.save('games', game);

    const scoreEl = document.getElementById(`generic-score-${playerIdx}`);
    if (scoreEl) {
      scoreEl.textContent = result.newValue;
      scoreEl.className   = `score ${result.newValue < 0 ? 'negative' : ''}`;
    }

    Utils.toast(`${game.players[playerIdx].name} : ${Utils.signed(delta)} pts`, 'success');
    deltaInput.value = 0;

    if (result.winner) {
      Utils.toast(`🏆 ${result.winner.name} remporte la partie !`, 'success', 4000);
      Screens.render_generic();
    }
  },

  /* ─── EXPORT / IMPORT ─── */
  getLocalPreferences() {
    const values = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null) values[key] = localStorage.getItem(key);
    }
    return values;
  },

  restoreLocalPreferences(values = {}) {
    localStorage.clear();
    Object.entries(values || {}).forEach(([key, value]) => {
      if (value !== null && value !== undefined) localStorage.setItem(key, String(value));
    });
  },

  async exportData() {
    const [games, settings, logs] = await Promise.all([
      DB.getAll('games'),
      DB.getAll('settings'),
      DB.getAll('logs'),
    ]);

    const data = {
      format: 'scorekeeper-pro-full-backup',
      formatVersion: 3,
      version: APP_VERSION,
      timersIncluded: true,
      exportedAt: new Date().toISOString(),
      data: {
        games,
        settings,
        logs,
        localStorage: this.getLocalPreferences(),
      },
      // Conserver ces champs au premier niveau pour compatibilité avec les anciennes versions.
      games,
      settings,
      logs,
      localStorage: this.getLocalPreferences(),
    };

    Utils.downloadJSON(data, `scorekeeper-backup-${new Date().toISOString().slice(0,10)}.json`);
    Utils.toast(`Sauvegarde complète : ${games.length} partie(s)`, 'success', 3500);
  },

  async exportCurrentGame() {
    if (!State.currentGame) return;
    const game = State.currentGame;
    Utils.downloadJSON({
      version: APP_VERSION,
      timersIncluded: true,
      exportedAt: new Date().toISOString(),
      game,
    }, `partie-${game.type}-${new Date().toISOString().slice(0,10)}.json`);
    Utils.toast('Partie exportée !', 'success');
  },

  importData() {
    const input = document.createElement('input');
    input.type  = 'file';
    input.accept = '.json,application/json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      try {
        const text = await file.text();
        const raw = JSON.parse(text);

        if (raw.game) {
          // Import d'une seule partie : conserver le comportement historique de fusion.
          GameTimer.migrate(raw.game);
          await DB.save('games', raw.game);
          Utils.toast('Partie importée !', 'success');
          await Screens.render_home();
          return;
        }

        const payload = raw.data && typeof raw.data === 'object' ? raw.data : raw;
        if (!Array.isArray(payload.games)) throw new Error('Aucune partie dans la sauvegarde');

        const isFullBackup = raw.format === 'scorekeeper-pro-full-backup' ||
          Array.isArray(payload.settings) || Array.isArray(payload.logs) || payload.localStorage;

        if (isFullBackup) {
          const confirmed = confirm(
            `Restaurer cette sauvegarde complète ?\n\n` +
            `${payload.games.length} partie(s) seront restaurée(s). ` +
            `Les données actuellement présentes sur cet appareil seront remplacées.`
          );
          if (!confirmed) return;

          // Remplacement complet : garantit qu'un nouvel appareil reproduit la sauvegarde
          // sans conserver de données résiduelles d'une installation précédente.
          await Promise.all([DB.clear('games'), DB.clear('settings'), DB.clear('logs')]);

          for (const g of payload.games || []) { GameTimer.migrate(g); await DB.save('games', g); }
          for (const setting of payload.settings || []) await DB.save('settings', setting);
          for (const log of payload.logs || []) await DB.save('logs', log);
          // Les anciennes sauvegardes ne contiennent pas nécessairement les mots de passe.
          // Dans ce cas, recréer les valeurs par défaut dans les paramètres.
          await Security.ensureDefaults();
          // Les sauvegardes v1.35+ contiennent les préférences locales.
          // Un ancien export qui n'en contient pas ne doit pas effacer celles de l'appareil.
          if (payload.localStorage && typeof payload.localStorage === 'object') {
            this.restoreLocalPreferences(payload.localStorage);
          }

          State.currentGame = null;
          Utils.toast(
            `Restauration complète : ${payload.games.length} partie(s), paramètres et préférences`,
            'success',
            4500
          );
          Router.go('home');
          return;
        }

        // Ancien export ne contenant que les parties : fusion non destructive.
        for (const g of payload.games) { GameTimer.migrate(g); await DB.save('games', g); }
        Utils.toast(`${payload.games.length} partie(s) importée(s)`, 'success');
        await Screens.render_home();
      } catch (err) {
        console.error('[Import]', err);
        Utils.toast('Fichier de sauvegarde invalide', 'error');
      } finally {
        input.value = '';
      }
    };
    input.click();
  },

  refreshStats() { Screens.render_stats(); },

  async resetAllStats() {
    const authorized = await Security.require('statsReset', 'Mot de passe requis pour réinitialiser toutes les statistiques :');
    if (!authorized) return;

    const confirmed = confirm(
      'Réinitialiser toutes les statistiques ?\n\n' +
      'Les statistiques repartiront de 0 dès maintenant. Les parties archivées, historiques et sauvegardes ne seront pas supprimés.'
    );
    if (!confirmed) return;

    const resetAt = new Date().toISOString();
    await DB.setSetting('statsResetAt', resetAt);
    await Screens.render_stats();
    Utils.toast('Toutes les statistiques ont été réinitialisées', 'success', 4000);
  },

  async resetAllData() {
    const authorized = await Security.require('dataReset', 'Mot de passe requis pour réinitialiser toutes les données :');
    if (!authorized) return;

    const confirmed = confirm(
      'RÉINITIALISER TOUTES LES DONNÉES ?\n\n' +
      'Cette action supprimera définitivement toutes les parties, tous les historiques, toutes les statistiques et toutes les préférences enregistrées sur cet appareil.\n\n' +
      'Les valeurs par défaut de ScoreKeeper Pro seront conservées. Cette action est irréversible sauf si vous possédez une sauvegarde JSON.'
    );
    if (!confirmed) return;

    await Promise.all([
      DB.clear('games'),
      DB.clear('logs'),
      DB.clear('settings'),
    ]);

    // Les préférences personnalisées sont supprimées afin que les valeurs
    // codées par défaut dans l'application redeviennent effectives.
    localStorage.clear();
    await Security.ensureDefaults();
    State.currentGame = null;

    Utils.toast('Toutes les données ont été réinitialisées', 'success', 4200);
    Router.go('home');
  },

  /** Garantit qu'une partie archivée possède un gagnant exploitable par les statistiques. */
  resolveWinnerBeforeArchive(game) {
    if (game.winnerName) return true;
    const inferred = Stats.inferWinnerName(game);
    if (inferred) { game.winnerName = inferred; return true; }

    const candidates = game.mode === 'teams'
      ? (game.teams || []).map(t => t.name)
      : (game.players || []).map(p => p.name);
    if (!candidates.length) return true;
    const answer = prompt(`Qui a gagné ?\n${candidates.map((n,i)=>`${i+1}. ${n}`).join('\n')}\n\nEntrez le numéro du gagnant.`);
    if (answer === null) return confirm('Archiver sans gagnant ? Cette partie ne comptera pas comme victoire dans les statistiques.');
    const idx = parseInt(answer, 10) - 1;
    if (idx < 0 || idx >= candidates.length) {
      Utils.toast('Gagnant invalide', 'error');
      return false;
    }
    game.winnerName = candidates[idx];
    return true;
  },

  /* ─── FIN DE PARTIE ─── */
  async endGame() {
    if (!State.currentGame) return;
    const game = State.currentGame;
    const isUnfinishedSeries = game.type === 'fiveHundred' && game.mode === 'teams' && game.series && !game.series.finished && game.series.games.length > 0;
    const msg = isUnfinishedSeries
      ? `La série n'est pas terminée (${game.series.wins[0]}-${game.series.wins[1]}). Archiver quand même ? Les parties déjà complétées resteront dans les statistiques.`
      : 'Terminer la partie ? Elle sera archivée.';
    if (!confirm(msg)) return;

    if (!(game.type === 'fiveHundred' && game.mode === 'teams' && game.series?.games?.length)) {
      if (!this.resolveWinnerBeforeArchive(game)) return;
    }
    const timerEndedAt = game.finishedAt || new Date().toISOString();
    if (game.type === 'fiveHundred' && game.mode === 'teams') {
      if (!game.series?.finished && game.series?.currentSetStartedAt) {
        GameTimer.finishSet(game, timerEndedAt, game.series?.gameNumber || 1, true);
      }
      GameTimer.finishGame(game, timerEndedAt, false);
    } else {
      GameTimer.finishGame(game, timerEndedAt, true);
    }
    game.status = 'finished';
    game.finishedAt = timerEndedAt;
    await DB.save('games', game);
    State.currentGame = null;
    Utils.toast('Partie terminée et statistiques mises à jour', 'info');
    Router.go('home');
  },

  /* ─── RETOUR DEPUIS HISTORIQUE ─── */
  _historyBack() {
    if (!State.currentGame) { Router.go('home'); return; }
    const screenMap = {
      hearts: 'hearts', magic: 'magic',
      fiveHundred: 'five-hundred', generic: 'generic',
    };
    Router.go(screenMap[State.currentGame.type] || 'home');
  },

  /* ─── INSTALLATION PWA ─── */
  async installPWA() {
    if (!State.deferredInstallPrompt) return;
    State.deferredInstallPrompt.prompt();
    const { outcome } = await State.deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      State.deferredInstallPrompt = null;
      document.getElementById('install-banner').style.display = 'none';
      Utils.toast('Application installée !', 'success');
    }
  },
};

/* ================================================================
   SECTION 9 : HTML DES ÉCRANS (injection dynamique)
   ================================================================ */

function buildScreenHTML() {
  document.getElementById('app').innerHTML = `
    <!-- Toast container -->
    <div class="toast-container" id="toast-container"></div>

    <div class="app-shell">
      <!-- Rail de navigation (tablette et plus) -->
      <nav class="side-rail" aria-label="Navigation principale">
        <div class="rail-brand">
          <span class="rail-logo">🂡</span>
          <span class="rail-title">ScoreKeeper <em>Pro</em></span>
        </div>
        <button class="rail-link active" data-screen="home" onclick="Router.go('home')">
          <span class="rail-icon">🏠</span><span>Accueil</span>
        </button>
        <button class="rail-link" data-screen="stats" onclick="Router.go('stats')">
          <span class="rail-icon">📊</span><span>Statistiques</span>
        </button>
        <button class="rail-link" data-screen="settings" onclick="UI.openSettings()">
          <span class="rail-icon">⚙</span><span>Paramètres</span>
        </button>

        <div class="rail-divider"></div>
        <div class="rail-section-label">Nouvelle partie</div>
        <button class="rail-link" onclick="UI.startNewGame('hearts')">
          <span class="rail-icon">♠</span><span>Dame de Pique</span>
        </button>
        <button class="rail-link" onclick="UI.startNewGame('magic')">
          <span class="rail-icon">🔮</span><span>Magic</span>
        </button>
        <button class="rail-link" onclick="UI.startNewGame('fiveHundred')">
          <span class="rail-icon">🃏</span><span>Jeu de 500</span>
        </button>
        <button class="rail-link" onclick="UI.startNewGame('generic')">
          <span class="rail-icon">🎮</span><span>Générique</span>
        </button>

        <div class="rail-spacer"></div>
        <div class="rail-version">ScoreKeeper Pro · v${APP_VERSION}</div>
      </nav>

      <div class="screens-wrap">

    <!-- ══ ACCUEIL ══ -->
    <div class="screen active" id="screen-home">
      <div class="home-hero">
        <div class="home-logo">🂡</div>
        <div class="home-title">ScoreKeeper Pro</div>
        <div class="home-subtitle">Gardez le score. Partout. Hors ligne.</div>
      </div>

      <div id="resume-banner" class="resume-banner" style="display:none"></div>

      <div id="install-banner" class="install-banner" style="display:none">
        <div class="install-banner-icon">📲</div>
        <div class="install-banner-text">Installer l'application sur cet appareil pour un accès rapide</div>
        <button class="btn btn-primary btn-sm" onclick="UI.installPWA()">Installer</button>
      </div>

      <div class="games-grid">
        <div class="game-card hearts" onclick="UI.startNewGame('hearts')">
          <span class="game-card-icon">♠</span>
          <div class="game-card-name">Dame de Pique</div>
          <div class="game-card-desc">Hearts · 25 pts par manche</div>
        </div>
        <div class="game-card magic" onclick="UI.startNewGame('magic')">
          <span class="game-card-icon">🔮</span>
          <div class="game-card-name">Magic</div>
          <div class="game-card-desc">The Gathering · Points de vie</div>
        </div>
        <div class="game-card fiveh" onclick="UI.startNewGame('fiveHundred')">
          <span class="game-card-icon">🃏</span>
          <div class="game-card-name">Jeu de 500</div>
          <div class="game-card-desc">Équipes ou individuel · enchères ouvertes + Mulot</div>
        </div>
        <div class="game-card generic" onclick="UI.startNewGame('generic')">
          <span class="game-card-icon">🎮</span>
          <div class="game-card-name">Générique</div>
          <div class="game-card-desc">Tout type de jeu</div>
        </div>
      </div>

      <div class="btn-row">
        <button class="btn btn-secondary" onclick="Router.go('stats')">📊 Statistiques</button>
        <button class="btn btn-secondary" onclick="UI.openSettings()">⚙ Paramètres</button>
      </div>

      <div class="card">
        <div class="card-title">Données</div>
        <div class="btn-row">
          <button class="btn btn-secondary btn-sm" onclick="UI.exportData()">📤 Sauvegarde complète</button>
          <button class="btn btn-secondary btn-sm" onclick="UI.importData()">📥 Restaurer</button>
        </div>
        <div style="height:10px"></div>
        <button class="btn btn-danger btn-sm" onclick="UI.resetAllData()">♻ Réinitialiser toutes les données</button>
      </div>

      <div class="home-version">Version ${APP_VERSION}</div>
      <div class="bottom-safe"></div>
    </div>

    <!-- ══ NOUVELLE PARTIE ══ -->
    <div class="screen" id="screen-new-game">
      <div class="app-header">
        <button class="btn-back" onclick="Router.go('home')">‹</button>
        <div class="header-title" id="new-game-title">Nouvelle partie</div>
      </div>

      <input type="hidden" id="new-game-type">
      <div id="new-game-options"></div>

      <button class="btn btn-primary" onclick="UI.createGame()">▶ Démarrer la partie</button>
      <div class="bottom-safe"></div>
    </div>

    <!-- ══ DAME DE PIQUE ══ -->
    <div class="screen" id="screen-hearts">
      <div class="app-header">
        <button class="btn-back" onclick="Router.go('home')">‹</button>
        <div class="header-title">♠ Dame de Pique</div>
        <div class="header-actions">
          <button class="btn-back" onclick="UI.goHistory()" title="Historique">📋</button>
          <button class="btn-back" onclick="UI.exportCurrentGame()" title="Exporter">📤</button>
        </div>
      </div>

      <div class="game-timer-bar"><span>⏱ <span data-game-timer-label>Temps de partie</span></span><strong data-game-timer-value>00:00</strong></div>

      <div class="round-bar">
        <div>
          <div class="round-label">Manche en cours</div>
          <div class="round-value" id="hearts-round-num">Round 0</div>
        </div>
        <div class="total-badge">
          Total : <strong id="hearts-total-val">0</strong>
          <div id="hearts-expected" style="font-size:11px;color:var(--text-secondary)"></div>
        </div>
      </div>

      <div class="scoreboard" id="hearts-scores"></div>

      <div class="card">
        <div class="card-title">Saisir la manche</div>
        <div class="round-entry-grid" id="hearts-round-entry"></div>
        <div style="height:12px"></div>
        <div class="round-total-display">
          <div>
            <div class="round-total-label">Variation de cette manche</div>
            <div id="hearts-expected-total" class="round-total-expected"></div>
          </div>
          <div class="round-total-num" id="hearts-round-total">0</div>
        </div>
      </div>

      <button class="btn btn-primary" id="hearts-submit" onclick="UI.heartsSubmitRound()" disabled>
        ✓ Valider la manche
      </button>

      <button class="btn btn-secondary btn-sm" onclick="UI.endGame()">Terminer la partie</button>
      <div class="bottom-safe"></div>
    </div>

    <!-- ══ MAGIC ══ -->
    <div class="screen" id="screen-magic">
      <div class="app-header">
        <button class="btn-back" onclick="Router.go('home')">‹</button>
        <div class="header-title">🔮 Magic: The Gathering</div>
        <div class="header-actions">
          <button class="btn-back" onclick="UI.goHistory()" title="Historique">📋</button>
          <button class="btn-back" onclick="UI.exportCurrentGame()" title="Exporter">📤</button>
        </div>
      </div>

      <div class="game-timer-bar"><span>⏱ <span data-game-timer-label>Temps de partie</span></span><strong data-game-timer-value>00:00</strong></div>

      <!-- Quick amount selector -->
      <div class="card" style="padding:12px 18px">
        <div class="card-title" style="margin-bottom:8px">Valeur du bouton +/−</div>
        <div class="magic-quick-amounts">
          ${[1,2,3,5,10,15,20].map(v => `
            <button class="magic-quick-btn ${v===1?'selected':''}" data-val="${v}"
              onclick="UI.setMagicDelta(${v})">${v}</button>
          `).join('')}
        </div>
      </div>

      <div class="magic-grid" id="magic-players-grid"></div>

      <button class="btn btn-secondary btn-sm" onclick="UI.goHistory()">📋 Historique</button>
      <button class="btn btn-secondary btn-sm" onclick="UI.endGame()">Terminer la partie</button>
      <div class="bottom-safe"></div>
    </div>

    <!-- ══ JEU DE 500 ══ -->
    <div class="screen" id="screen-five-hundred">
      <div class="app-header">
        <button class="btn-back" onclick="Router.go('home')">‹</button>
        <div class="header-title" id="fh-screen-title">🃏 Jeu de 500</div>
        <div class="header-actions">
          <button class="btn-back" onclick="UI.openFhInfoModal()" title="Infos">ℹ️</button>
          <button class="btn-back" onclick="UI.goHistory()" title="Historique">📋</button>
          <button class="btn-back" onclick="UI.exportCurrentGame()" title="Exporter">📤</button>
        </div>
      </div>

      <div class="game-timer-bar"><span>⏱ <span data-game-timer-label>Partie 1</span></span><strong data-game-timer-value>00:00</strong></div>

      <div class="total-badge" id="fh-mode-badge" style="align-self:flex-start">Équipes · 1000 pts</div>
      <div class="fh-next-bidder" id="fh-next-bidder-banner"><span>Première mise de la prochaine donne</span><strong>—</strong></div>
      <div class="fh-series-inline" id="fh-series-inline"></div>
      <div class="five-hundred-teams" id="fh-teams"></div>

      <div id="fh-victory" class="victory-banner" style="display:none">
        <div class="victory-trophy">🏆</div>
        <div class="victory-title">Victoire !</div>
        <div class="victory-sub" id="fh-winner-name"></div>
        <div class="victory-sub"><strong id="fh-winner-score"></strong> points</div>
        <div style="height:12px"></div>
        <button class="btn btn-primary btn-sm" onclick="UI.endGame()">Terminer</button>
      </div>

      <div class="fh-action-row">
        <button class="btn btn-primary" onclick="UI.openFhResultModal()">✓ Partie terminée</button>
        <button class="btn btn-secondary" id="fh-null-deal-btn" onclick="UI.fhNullDeal()">∅ Partie nulle</button>
        <button class="btn btn-secondary" onclick="UI.openFhManualAdjustModal()">± Ajustement manuel</button>
      </div>

      <div class="fh-end-series-zone">
        <button class="btn btn-danger btn-sm" onclick="UI.endGame()">■ Terminer la série</button>
      </div>
      <div class="fh-starter-callout" id="fh-starter-callout" aria-live="polite">
        <span>À TOI DE COMMENCER</span>
        <strong id="fh-starter-callout-name">—</strong>
      </div>
      <div class="app-modal-overlay" id="app-modal-overlay" onclick="UI.closeModalFromBackdrop(event)" style="display:none">
        <div class="app-modal-card" id="app-modal-card">
          <div class="app-modal-header">
            <div class="app-modal-title" id="app-modal-title"></div>
            <button class="btn-back" onclick="UI.closeAppModal()">✕</button>
          </div>
          <div class="app-modal-body" id="app-modal-body"></div>
        </div>
      </div>
      <div class="bottom-safe"></div>
    </div>

    <!-- ══ GÉNÉRIQUE ══ -->
    <div class="screen" id="screen-generic">
      <div class="app-header">
        <button class="btn-back" onclick="Router.go('home')">‹</button>
        <div class="header-title">🎮 Jeu Générique</div>
        <div class="header-actions">
          <button class="btn-back" onclick="UI.goHistory()" title="Historique">📋</button>
          <button class="btn-back" onclick="UI.exportCurrentGame()" title="Exporter">📤</button>
        </div>
      </div>

      <div class="game-timer-bar"><span>⏱ <span data-game-timer-label>Temps de partie</span></span><strong data-game-timer-value>00:00</strong></div>

      <div id="generic-victory" class="victory-banner" style="display:none">
        <div class="victory-trophy">🏆</div>
        <div class="victory-title">Victoire !</div>
        <div class="victory-sub" id="generic-winner-name"></div>
        <div style="height:12px"></div>
        <button class="btn btn-primary btn-sm" onclick="UI.endGame()">Terminer</button>
      </div>

      <div id="generic-players" class="generic-score-players"></div>

      <button class="btn btn-secondary btn-sm" onclick="UI.endGame()">Terminer la partie</button>
      <div class="bottom-safe"></div>
    </div>

    <!-- ══ PARAMÈTRES ══ -->
    <div class="screen" id="screen-settings">
      <div class="app-header">
        <button class="btn-back" onclick="Router.go('home')">‹</button>
        <div class="header-title">⚙ Paramètres</div>
      </div>

      <div class="card">
        <div class="card-title">Mots de passe</div>
        <div class="setting-sub" style="margin-bottom:14px">
          Les mots de passe sont conservés dans les paramètres de l’application et inclus dans la sauvegarde JSON complète. Sur une installation neuve, ils valent tous le mot de passe maître par défaut.
        </div>

        <div id="password-settings-unlock" style="display:flex">
          <button class="btn btn-primary" onclick="UI.unlockPasswordSettings()">🔐 Modifier les mots de passe</button>
        </div>

        <div id="password-settings-editor" style="display:none">
          <div class="form-group">
            <label class="form-label">Mot de passe maître</label>
            <input class="form-input" id="pwd-master" type="password" autocomplete="new-password">
            <div class="setting-sub">Exigé avant toute modification des mots de passe.</div>
          </div>
          <div class="form-group">
            <label class="form-label">Ajustement manuel / pénalité</label>
            <input class="form-input" id="pwd-manual" type="password" autocomplete="new-password">
          </div>
          <div class="form-group">
            <label class="form-label">Réinitialisation des statistiques</label>
            <input class="form-input" id="pwd-stats" type="password" autocomplete="new-password">
          </div>
          <div class="form-group">
            <label class="form-label">Réinitialisation de toutes les données</label>
            <input class="form-input" id="pwd-data" type="password" autocomplete="new-password">
          </div>
          <button class="btn btn-success" onclick="UI.savePasswordSettings()">✓ Enregistrer les mots de passe</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">500 en équipes</div>
        <div class="form-group">
          <label class="form-label">Points pour une partie nulle</label>
          <input class="form-input" id="fh-null-points-setting" type="number" min="0" step="10" value="50">
          <div class="setting-sub">Ajoutés aux deux équipes lorsqu’il y a jeu blanc ou aucune mise. Si ce bonus ferait atteindre 1000 points à une équipe, aucun point n’est attribué aux deux équipes.</div>
        </div>
        <button class="btn btn-success btn-sm" onclick="UI.saveFhNullPointsSetting()">✓ Enregistrer</button>
      </div>

      <div class="card">
        <div class="card-title">Valeurs par défaut</div>
        <div class="setting-sub">À l’installation ou après une réinitialisation complète, les quatre protections sont initialisées avec le mot de passe maître par défaut. Le bonus de partie nulle revient à 50 points.</div>
      </div>
      <div class="bottom-safe"></div>
    </div>

    <!-- ══ STATISTIQUES ══ -->
    <div class="screen" id="screen-stats">
      <div class="app-header">
        <button class="btn-back" onclick="Router.go('home')">‹</button>
        <div class="header-title">📊 Statistiques</div>
      </div>

      <div class="card stats-filters">
        <div class="card-title">Filtres</div>
        <div class="stats-filter-grid">
          <div class="form-group"><label class="form-label">Jeu</label><select class="form-select" id="stats-game-filter" onchange="UI.refreshStats()"><option value="all">Tous les jeux</option><option value="fiveHundred">500</option><option value="hearts">Dame de Pique</option><option value="magic">Magic</option><option value="generic">Générique</option></select></div>
          <div class="form-group"><label class="form-label">Mode</label><select class="form-select" id="stats-mode-filter" onchange="UI.refreshStats()"><option value="all">Tous</option><option value="individual">Solo seulement (exclut les équipes)</option><option value="teams">Équipe seulement</option></select></div>
          <div class="form-group"><label class="form-label">Joueur</label><select class="form-select" id="stats-player-filter" onchange="UI.refreshStats()"><option value="all">Tous les joueurs</option></select></div>
          <div class="form-group"><label class="form-label">Équipe</label><select class="form-select" id="stats-team-filter" onchange="UI.refreshStats()"><option value="all">Toutes les équipes</option></select></div>
          <div class="form-group"><label class="form-label">Période</label><select class="form-select" id="stats-period-filter" onchange="UI.refreshStats()"><option value="all">Depuis toujours</option><option value="30">30 derniers jours</option><option value="90">90 derniers jours</option><option value="365">12 derniers mois</option></select></div>
        </div>
      </div>

      <div class="card"><div class="card-title">Résumé</div><div id="stats-summary" class="stats-summary"></div></div>
      <div class="card"><div class="card-title">Victoires par joueur</div><div class="stats-header"><span>Joueur</span><span>V/G</span><span>%</span></div><div id="stats-player-results" class="stats-list"></div></div>
      <div class="card"><div class="card-title">Victoires par équipe</div><div class="stats-header"><span>Équipe</span><span>V/G</span><span>%</span></div><div id="stats-team-results" class="stats-list"></div></div>
      <div class="card"><div class="card-title">Détail joueur par jeu</div><div class="stats-header"><span>Joueur / jeu</span><span>V/G</span><span>%</span></div><div id="stats-detail-results" class="stats-list"></div></div>

      <div class="card stats-reset-card">
        <div class="card-title">Réinitialisation</div>
        <div class="setting-sub" style="margin-bottom:12px">Réinitialise tous les compteurs de statistiques à partir de maintenant. Les parties et leurs historiques sont conservés.</div>
        <button class="btn btn-danger btn-sm" onclick="UI.resetAllStats()">♻ Réinitialiser toutes les stats</button>
      </div>
      <div class="bottom-safe"></div>
    </div>

    <!-- ══ HISTORIQUE ══ -->
    <div class="screen" id="screen-history">
      <div class="app-header">
        <button class="btn-back" onclick="UI._historyBack()">‹</button>
        <div class="header-title">📋 Historique</div>
        <div class="header-actions">
          <button class="btn-back" onclick="UI.exportCurrentGame()">📤</button>
        </div>
      </div>

      <div class="card">
        <div class="history-list" id="history-list">
          <div class="spinner"></div>
        </div>
      </div>

      <div class="bottom-safe"></div>
    </div>

      </div><!-- /.screens-wrap -->
    </div><!-- /.app-shell -->
  `;
}

/* ================================================================
   SECTION 10 : INITIALISATION
   ================================================================ */

async function init() {
  // Construire le HTML
  buildScreenHTML();

  // Initialiser IndexedDB
  await DB.init();
  await Security.ensureDefaults();
  UI.startGameTimerTicker();

  // Enregistrer le service worker et forcer la vérification des mises à jour.
  // updateViaCache:'none' évite qu'Android/Chrome réutilise une ancienne copie du SW.
  if ('serviceWorker' in navigator) {
    try {
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        window.location.reload();
      });

      const registration = await navigator.serviceWorker.register('./service-worker.js', {
        updateViaCache: 'none'
      });
      await registration.update();
      console.log('[App] Service Worker enregistré et mise à jour vérifiée');
    } catch (err) {
      console.warn('[App] SW non enregistré :', err);
    }
  }

  // Capturer l'événement d'installation PWA
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    State.deferredInstallPrompt = e;
    const banner = document.getElementById('install-banner');
    if (banner) banner.style.display = 'flex';
  });

  // Corriger le bouton retour natif Android
  window.addEventListener('popstate', () => {
    if (State.currentScreen !== 'home') {
      Router.go('home');
    }
  });
  history.pushState({}, '', location.href);

  // Autoriser le son du 500 dès la première interaction utilisateur (requis par Android/Chrome).
  document.addEventListener('pointerdown', () => UI.unlockFhSound(), { once: true, passive: true });

  // Rendre l'écran d'accueil
  await Screens.render_home();
}

// Démarrage
document.addEventListener('DOMContentLoaded', init);
