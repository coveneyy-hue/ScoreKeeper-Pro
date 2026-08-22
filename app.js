/**
 * ScoreKeeper Pro — app.js
 * Application PWA complète : Dame de Pique, Magic, Jeu de 500, Générique
 * Architecture modulaire vanilla JS + IndexedDB
 */

'use strict';

const APP_VERSION = '2.26';
const IMPACT_INDEX_FORMULA_VERSION = 1;
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

// Joueurs par défaut du 500 en équipes. Tant que ces quatre noms restent
// inchangés, les trois partenariats possibles sont utilisés à tour de rôle.
const FIVE_HUNDRED_DEFAULT_TEAM_PLAYERS = ['Yannick', 'Lily-Rose', 'Victor', 'Julie'];

// Les partenaires sont toujours assis aux positions 1+3 et 2+4.
// Chaque ordre ci-dessous représente donc l'un des trois partenariats uniques.
const FIVE_HUNDRED_DEFAULT_TEAM_PAIRINGS = [
  ['Yannick', 'Lily-Rose', 'Victor', 'Julie'],   // Yannick+Victor / Lily-Rose+Julie
  ['Yannick', 'Victor', 'Lily-Rose', 'Julie'],  // Yannick+Lily-Rose / Victor+Julie
  ['Yannick', 'Lily-Rose', 'Julie', 'Victor'],  // Yannick+Julie / Lily-Rose+Victor
];

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

// Contrats spéciaux en équipes.
// Mulot : 0 levée, sans minou ni atout. Réussite = 225 points; échec = 225 points aux adversaires.
const FIVE_HUNDRED_MULOT = {
  key: 'MULOT',
  points: 225,
  failedOpponentPoints: 225,
};

// Gros Mulot : même objectif de 0 levée, mais la main du miseur est exposée
// après la première levée. Réussite = 440 points; échec = 440 points aux adversaires.
const FIVE_HUNDRED_GROS_MULOT = {
  key: 'GROS_MULOT',
  points: 440,
  failedOpponentPoints: 440,
};

// Mulot Suprême : contrat extrême à 0 levée. Réussite = 1000 points;
// échec = 500 points aux adversaires. Disponible uniquement en équipes.
const FIVE_HUNDRED_MULOT_SUPREME = {
  key: 'MULOT_SUPREME',
  points: 1000,
  failedOpponentPoints: 500,
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
    createTeams(team0Name, team1Name, tablePlayerNames = [], seriesBestOf = 3, defaultRotation = null) {
      const enteredNames = Array.from({length: 4}, (_, i) => tablePlayerNames[i] || FIVE_HUNDRED_DEFAULT_TEAM_PLAYERS[i]);
      const defaultsUnchanged = enteredNames.every((name, i) => name === FIVE_HUNDRED_DEFAULT_TEAM_PLAYERS[i]);

      let names;
      let rotationMeta = null;
      if (defaultsUnchanged && defaultRotation && Number.isInteger(defaultRotation.pairingIndex)) {
        const pairingIndex = ((defaultRotation.pairingIndex % FIVE_HUNDRED_DEFAULT_TEAM_PAIRINGS.length) + FIVE_HUNDRED_DEFAULT_TEAM_PAIRINGS.length) % FIVE_HUNDRED_DEFAULT_TEAM_PAIRINGS.length;
        const baseOrder = [...FIVE_HUNDRED_DEFAULT_TEAM_PAIRINGS[pairingIndex]];
        // Faire aussi tourner le premier miseur sur les quatre joueurs. Une rotation circulaire
        // conserve les partenaires (positions 1+3 et 2+4) tout en équilibrant les départs.
        const starterOffset = ((Number(defaultRotation.starterOffset) || 0) % baseOrder.length + baseOrder.length) % baseOrder.length;
        names = baseOrder.slice(starterOffset).concat(baseOrder.slice(0, starterOffset));
        rotationMeta = {
          managed: true,
          pairingIndex,
          starterOffset,
          sequenceNumber: Math.max(1, Number(defaultRotation.sequenceNumber) || 1),
        };
      } else {
        const shuffledNames = Utils.shuffle(enteredNames);
        // Si les noms par défaut sont modifiés, conserver le comportement historique aléatoire.
        const starterOffset = Utils.randomIndex(shuffledNames.length);
        names = shuffledNames.slice(starterOffset).concat(shuffledNames.slice(0, starterOffset));
      }
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
        // Les partenaires sont toujours les positions 1+3 et 2+4 dans l'ordre affiché.
        tablePlayers: names.map((name, i) => ({ name, seatIdx: i, teamIdx: i % 2 })),
        defaultTeamRotation: rotationMeta,
        statsFormulaVersions: { impactIndex: IMPACT_INDEX_FORMULA_VERSION },
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
      if (contractKey === FIVE_HUNDRED_GROS_MULOT.key) return FIVE_HUNDRED_GROS_MULOT.points;
      if (contractKey === FIVE_HUNDRED_MULOT_SUPREME.key) return FIVE_HUNDRED_MULOT_SUPREME.points;
      if (Object.prototype.hasOwnProperty.call(FIVE_HUNDRED_OPEN_TEAM_SCORES, contractKey)) {
        return FIVE_HUNDRED_OPEN_TEAM_SCORES[contractKey];
      }
      return FIVE_HUNDRED_TEAM_SCORES[contractKey] || 0;
    },

    isMulotContract(contractKey) {
      return contractKey === FIVE_HUNDRED_MULOT.key;
    },

    isGrosMulotContract(contractKey) {
      return contractKey === FIVE_HUNDRED_GROS_MULOT.key;
    },

    isMulotSupremeContract(contractKey) {
      return contractKey === FIVE_HUNDRED_MULOT_SUPREME.key;
    },

    isAnyMulotContract(contractKey) {
      return this.isMulotContract(contractKey) || this.isGrosMulotContract(contractKey) || this.isMulotSupremeContract(contractKey);
    },

    isOpenContract(contractKey) {
      return Object.prototype.hasOwnProperty.call(FIVE_HUNDRED_OPEN_TEAM_SCORES, contractKey);
    },

    contractLabel(contractKey) {
      if (this.isMulotContract(contractKey)) return 'Mulot';
      if (this.isGrosMulotContract(contractKey)) return 'Gros Mulot';
      if (this.isMulotSupremeContract(contractKey)) return 'Mulot Suprême';
      if (this.isOpenContract(contractKey)) return `${parseInt(contractKey, 10)} ouvert`;
      return contractKey;
    },

    /** Points accordés aux adversaires lorsque le contrat est chuté en équipes. */
    failedTeamContractPoints(game, contractKey) {
      if (this.isMulotContract(contractKey)) return FIVE_HUNDRED_MULOT.failedOpponentPoints;
      if (this.isGrosMulotContract(contractKey)) return FIVE_HUNDRED_GROS_MULOT.failedOpponentPoints;
      if (this.isMulotSupremeContract(contractKey)) return FIVE_HUNDRED_MULOT_SUPREME.failedOpponentPoints;
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
      return !this.isAnyMulotContract(contractKey) && parseInt(contractKey, 10) === 10;
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
        statsFormulaVersions: { impactIndex: IMPACT_INDEX_FORMULA_VERSION },
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
     * Mulot chuté : 225 points aux adversaires.
     * Gros Mulot chuté : 440 points aux adversaires.
     * Mulot Suprême chuté : 500 points aux adversaires.
     * Une partie est gagnée dès qu'une équipe atteint 1000 points.
     */
    applyContract(game, teamIdx, contractKey, success, bidderSeatIdx = null) {
      this.ensureSeries(game);
      const seats = this.ensureTableSetup(game);
      const bidder = Number.isInteger(bidderSeatIdx) ? seats[bidderSeatIdx] : null;
      const openingBidderSeatIdx = Number.isInteger(game.nextBidderIdx) ? game.nextBidderIdx : 0;
      const openingBidder = seats[openingBidderSeatIdx] || null;
      const bidPosition = Number.isInteger(bidderSeatIdx)
        ? ((bidderSeatIdx - openingBidderSeatIdx + seats.length) % seats.length) + 1
        : null;
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
        bidder: bidder?.name || null,
        bidderSeatIdx: bidder?.seatIdx ?? bidderSeatIdx,
        bidderTeamIdx: bidder?.teamIdx ?? teamIdx,
        openingBidder: openingBidder?.name || null,
        openingBidderSeatIdx,
        bidPosition,
        impactFormulaVersion: IMPACT_INDEX_FORMULA_VERSION,
        awardedTeam: awardedTeam.name,
        awardedTeamIdx: awardedIdx,
        contract: contractKey,
        points: pts,
        awardedPoints,
        success,
        lossRule: success ? null : (this.isMulotContract(contractKey) ? 'mulot-225' : (this.isGrosMulotContract(contractKey) ? 'gros-mulot-440' : (this.isMulotSupremeContract(contractKey) ? 'mulot-supreme-500' : (this.isGameContract(contractKey) ? 'partie-half' : 'full')))),
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

      // La rotation du premier miseur est absolue : chaque résultat validé
      // fait avancer au joueur suivant, même si cette donne termine une partie
      // ou la série. Il n'y a aucune exception à cette rotation.
      const nextBidder = this.advanceNextBidder(game);
      lastHistory.nextBidder = nextBidder.name;
      lastHistory.nextBidderSeat = nextBidder.seatIdx;
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

      // Compatibilité : cette ancienne voie respecte la même rotation stricte.
      const nextBidder = this.advanceNextBidder(game);
      lastHistory.nextBidder = nextBidder.name;
      lastHistory.nextBidderSeat = nextBidder.seatIdx;
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
          sourceGameId: game.id,
          seriesGameNumber: sg.gameNumber || idx + 1,
          date: sg.finishedAt || game.updatedAt || game.createdAt,
          gameType: 'fiveHundred', gameLabel: '500', mode: 'teams',
          players: teams.flatMap(t => t.members),
          teams,
          winnerPlayers: teams[winnerTeamIdx]?.members || [],
          winnerTeamKey: teams[winnerTeamIdx]?.key || null,
          winnerTeamIdx,
          finalScores: Array.isArray(sg.finalScores) ? sg.finalScores.map(Number) : (sg.teams || []).map(t => Number(t.score) || 0),
          durationMs: Number(sg.durationMs) || 0,
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
        id: game.id, sourceGameId: game.id, seriesGameNumber: 1, date: game.finishedAt || game.updatedAt || game.createdAt,
        gameType: 'fiveHundred', gameLabel: '500', mode: 'teams',
        players: teams.flatMap(t => t.members), teams,
        winnerPlayers: winnerIdx >= 0 ? teams[winnerIdx].members : [],
        winnerTeamKey: winnerIdx >= 0 ? teams[winnerIdx].key : null,
        winnerTeamIdx: winnerIdx >= 0 ? winnerIdx : null,
        finalScores: (game.teams || []).map(t => Number(t.score) || 0),
        durationMs: Number(game.durationMs) || 0,
      });
      return records;
    }

    const players = (game.players || []).map(p => p.name);
    const winnerName = this.inferWinnerName(game);
    records.push({
      id: game.id,
      sourceGameId: game.id,
      seriesGameNumber: 1,
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

  contractRecordsFromGame(game) {
    if (!game || game.type !== 'fiveHundred') return [];
    const mode = game.mode || 'teams';
    const history = Array.isArray(game.history) ? game.history : [];

    if (mode === 'teams') {
      const seats = Games.fiveHundred.tablePlayers(game);
      const records = [];
      let openingSeatIdx = 0;

      const seatIndexByName = (name) => seats.findIndex(p => this.nameKey(p.name) === this.nameKey(name));
      const normalizeSeat = (idx) => Number.isInteger(idx) && seats.length ? ((idx % seats.length) + seats.length) % seats.length : null;

      history.forEach((e, idx) => {
        if (!e) return;

        // Le premier miseur progresse après chaque résultat, incluant une partie nulle.
        // Pour les anciennes données, on reconstruit donc la position de parole à partir
        // du prochain miseur enregistré ou, à défaut, par rotation simple.
        if (e.kind === 'contract' && e.bidder) {
          let bidderSeatIdx = Number.isInteger(e.bidderSeatIdx) ? normalizeSeat(e.bidderSeatIdx) : seatIndexByName(e.bidder);
          if (bidderSeatIdx < 0) bidderSeatIdx = null;
          const inferredOpening = Number.isInteger(e.openingBidderSeatIdx) ? normalizeSeat(e.openingBidderSeatIdx) : normalizeSeat(openingSeatIdx);
          const bidPosition = Number.isInteger(e.bidPosition)
            ? e.bidPosition
            : (bidderSeatIdx === null || inferredOpening === null ? null : ((bidderSeatIdx - inferredOpening + seats.length) % seats.length) + 1);
          const seat = bidderSeatIdx === null ? null : seats[bidderSeatIdx];
          const teamIdx = Number.isInteger(e.bidderTeamIdx) ? e.bidderTeamIdx : (seat?.teamIdx ?? null);
          const members = teamIdx === null ? [] : seats.filter(p => p.teamIdx === teamIdx).map(p => p.name);
          const team = teamIdx === null ? null : {
            name: game.teams?.[teamIdx]?.name || this.teamLabel(members),
            members,
            key: this.teamKey(members),
          };
          const contractPoints = Number(e.points) || Games.fiveHundred.contractPoints(game, e.contract) || 0;
          const awardedPoints = Number(e.awardedPoints ?? e.delta) || 0;
          const awardedTeamIdx = Number.isInteger(e.awardedTeamIdx) ? e.awardedTeamIdx : (e.success ? teamIdx : (teamIdx === null ? null : (teamIdx === 0 ? 1 : 0)));
          records.push({
            id: `${game.id}:contract:${e.timestamp || idx}:${idx}`,
            sourceGameId: game.id,
            date: e.timestamp || game.updatedAt || game.createdAt,
            gameType: 'fiveHundred',
            gameLabel: '500',
            mode: 'teams',
            player: e.bidder,
            playerKey: this.nameKey(e.bidder),
            team,
            teamIdx,
            contract: e.contract,
            contractPoints,
            awardedPoints,
            awardedTeamIdx,
            success: !!e.success,
            netImpact: e.success ? contractPoints : -awardedPoints,
            bidderSeatIdx,
            openingBidderSeatIdx: inferredOpening,
            openingBidder: e.openingBidder || (inferredOpening === null ? null : seats[inferredOpening]?.name || null),
            bidPosition,
            seriesGameNumber: e.seriesGameNumber || null,
            oldValue: Number(e.oldValue) || 0,
            newValue: Number(e.newValue) || 0,
          });
        }

        if (e.kind === 'contract' || e.kind === 'nullDeal') {
          let next = Number.isInteger(e.nextBidderSeat) ? normalizeSeat(e.nextBidderSeat) : seatIndexByName(e.nextBidder);
          if (next === null || next < 0) next = normalizeSeat((openingSeatIdx || 0) + 1);
          openingSeatIdx = next ?? 0;
        }
      });
      return records;
    }

    return history
      .filter(e => e?.kind === 'individualRound' && e.bidder)
      .map((e, idx) => ({
        id: `${game.id}:contract:${e.timestamp || idx}:${idx}`,
        sourceGameId: game.id,
        date: e.timestamp || game.updatedAt || game.createdAt,
        gameType: 'fiveHundred',
        gameLabel: '500',
        mode: 'individual',
        player: e.bidder,
        team: null,
        contract: e.contract,
        success: !!e.success,
        seriesGameNumber: null,
      }));
  },

  records(games) { return (games || []).flatMap(g => this.recordsFromGame(g)); },
  contractRecords(games) { return (games || []).flatMap(g => this.contractRecordsFromGame(g)); },

  contractDisplayLabel(contractKey) {
    if (!contractKey) return 'Contrat';
    if (Games.fiveHundred.isMulotContract(contractKey)) return 'Mulot';
    if (Games.fiveHundred.isGrosMulotContract(contractKey)) return 'Gros Mulot';
    if (Games.fiveHundred.isMulotSupremeContract(contractKey)) return 'Mulot Suprême';
    if (Games.fiveHundred.isOpenContract(contractKey)) return `${parseInt(contractKey, 10)} ouverte`;
    const m = String(contractKey).match(/^(7|8|9|10)(♠|♣|♦|♥|NT)$/);
    if (!m) return Games.fiveHundred.contractLabel(contractKey);
    const bid = m[1] === '10' ? 'Partie' : m[1];
    const suit = m[2] === 'NT' ? 'S' : m[2];
    return `${bid} ${suit}`;
  },

  impactIndex(bid = {}, imp = {}) {
    const winPct = this.pct(imp.wins || 0, imp.games || 0);
    const successPct = this.pct(bid.success || 0, bid.contracts || 0);
    const successPoints = Number(bid.successPoints) || 0;
    const failedCost = Number(bid.failedCost) || 0;
    const valueEfficiency = (successPoints + failedCost) > 0
      ? this.pct(successPoints, successPoints + failedCost) : 50;
    const contributionPct = this.pct(imp.winsWithSuccess || 0, imp.wins || 0);
    const finisherPct = this.pct(imp.decisiveWins || 0, imp.wins || 0);
    const raw = 0.35*winPct + 0.25*successPct + 0.20*valueEfficiency + 0.10*contributionPct + 0.10*finisherPct;
    return {
      version: IMPACT_INDEX_FORMULA_VERSION,
      score: raw / 10,
      winPct, successPct, valueEfficiency, contributionPct, finisherPct,
    };
  },

  sparklineSvg(values = []) {
    const nums = values.map(Number).filter(Number.isFinite);
    if (!nums.length) return '<div class="stats-spark-empty">Aucune donnée</div>';
    const width = 300, height = 72, padX = 4, padY = 7;
    const min = Math.min(...nums), max = Math.max(...nums);
    const span = Math.max(0.0001, max - min);
    const step = nums.length > 1 ? (width - 2*padX) / (nums.length - 1) : 0;
    const pts = nums.map((v,i) => {
      const x = padX + i*step;
      const y = height - padY - ((v-min)/span)*(height-2*padY);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const last = pts.split(' ').pop();
    return `<svg class="stats-sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><line x1="${padX}" y1="${height-padY}" x2="${width-padX}" y2="${height-padY}" class="stats-spark-base"/><polyline points="${pts}" class="stats-spark-line"/>${last ? `<circle cx="${last.split(',')[0]}" cy="${last.split(',')[1]}" r="3.2" class="stats-spark-dot"/>` : ''}</svg>`;
  },

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
          <div class="setting-sub" style="margin-bottom:12px">Les noms d'équipes sont générés automatiquement à partir des deux partenaires. Avec les 4 joueurs par défaut, les équipes alternent selon un historique pour que chacun joue avec chacun de façon équilibrée.</div>

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
          <div class="setting-sub" style="margin-bottom:12px">Avec les 4 noms par défaut inchangés, les 3 combinaisons de partenaires alternent automatiquement d'une nouvelle série à l'autre. Si un nom est modifié, l'ordre est tiré au hasard. Les joueurs 1 et 3 sont partenaires; les joueurs 2 et 4 sont partenaires.</div>
          <div id="fh-team-player-inputs" class="player-inputs">
            ${['Yannick','Lily-Rose','Victor','Julie'].map((name, i) => `
              <div class="player-input-row fh-team-player-row">
                <div class="player-input-num">${i + 1}</div>
                <input class="form-input" type="text" value="${name}" maxlength="16" data-team-player="${i}">
              </div>
            `).join('')}
          </div>
          <div class="setting-sub" style="margin-top:12px"><strong>Équipes déterminées automatiquement.</strong><br>Avec les joueurs par défaut, l'historique fait alterner les 3 partenariats possibles et le premier miseur. Les positions 1+3 affrontent les positions 2+4.</div>
          <div class="setting-sub" style="margin-top:10px">500 en équipes : aucun score négatif. Un contrat normal chuté donne sa valeur aux adversaires. Une Partie chutée donne seulement 50 % de sa valeur aux adversaires. Les enchères ouvertes valent 130 / 230 / 330 points pour 7 / 8 / 9. Un Mulot vaut 225 points, un Gros Mulot 440 points, et le Mulot Suprême vaut 1000 points avec 500 points aux adversaires en cas d'échec. Une partie est gagnée à 1000 points; la série se poursuit jusqu'au nombre de victoires choisi.</div>
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
      UI._newFhSavedNames = [...FIVE_HUNDRED_DEFAULT_TEAM_PLAYERS];
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
    const sinceReset = (r) => {
      if (!resetTimestamp) return true;
      const ts = new Date(r.date).getTime();
      return Number.isFinite(ts) && ts >= resetTimestamp;
    };
    const allRecords = Stats.records(games).filter(sinceReset);
    const allContractRecords = Stats.contractRecords(games).filter(sinceReset);

    const gameFilter = document.getElementById('stats-game-filter')?.value || 'all';
    const modeFilter = document.getElementById('stats-mode-filter')?.value || 'all';
    const periodFilter = document.getElementById('stats-period-filter')?.value || 'all';
    const playerFilter = document.getElementById('stats-player-filter')?.value || 'all';
    const teamFilter = document.getElementById('stats-team-filter')?.value || 'all';
    const minGamesFilter = document.getElementById('stats-min-games-filter')?.value || '3';
    const minGames = minGamesFilter === 'all' ? 0 : Math.max(0, parseInt(minGamesFilter, 10) || 3);

    const allPlayers = new Map();
    const allTeams = new Map();
    allRecords.forEach(r => {
      r.players.forEach(n => { const k = Stats.nameKey(n); if (!allPlayers.has(k)) allPlayers.set(k, n); });
      r.teams.forEach(t => { if (t.key && !allTeams.has(t.key)) allTeams.set(t.key, Stats.teamLabel(t.members)); });
    });
    allContractRecords.forEach(r => {
      const k = Stats.nameKey(r.player);
      if (r.player && !allPlayers.has(k)) allPlayers.set(k, r.player);
      if (r.team?.key && !allTeams.has(r.team.key)) allTeams.set(r.team.key, Stats.teamLabel(r.team.members));
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
    const inPeriod = (r) => !days || (now - new Date(r.date).getTime()) <= days * 86400000;

    const records = allRecords.filter(r => {
      if (gameFilter !== 'all' && r.gameType !== gameFilter) return false;
      if (modeFilter !== 'all' && r.mode !== modeFilter) return false;
      if (!inPeriod(r)) return false;
      if (playerFilter !== 'all' && !r.players.some(n => Stats.nameKey(n) === playerFilter)) return false;
      if (teamFilter !== 'all' && !r.teams.some(t => t.key === teamFilter)) return false;
      return true;
    });

    // Base des contrats selon jeu/mode/période/équipe. Le filtre joueur est appliqué
    // ensuite afin de conserver un dénominateur exact pour la part de contrats pris.
    const baseContractRecords = allContractRecords.filter(r => {
      if (gameFilter !== 'all' && gameFilter !== 'fiveHundred') return false;
      if (modeFilter !== 'all' && r.mode !== modeFilter) return false;
      if (!inPeriod(r)) return false;
      if (teamFilter !== 'all' && r.team?.key !== teamFilter) return false;
      return true;
    });
    const contractRecords = baseContractRecords.filter(r => playerFilter === 'all' || Stats.nameKey(r.player) === playerFilter);

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

    const rankRows = (values) => [...values]
      .filter(x => x.games >= minGames)
      .sort((a, b) => {
        const pctDiff = Stats.pct(b.wins, b.games) - Stats.pct(a.wins, a.games);
        if (Math.abs(pctDiff) > 1e-9) return pctDiff;
        if (b.games !== a.games) return b.games - a.games;
        if (b.wins !== a.wins) return b.wins - a.wins;
        return a.name.localeCompare(b.name, 'fr-CA');
      });
    const leaderPct = (rows) => rows.length ? Stats.pct(rows[0].wins, rows[0].games) : null;
    const isLeader = (x, bestPct) => bestPct !== null && Math.abs(Stats.pct(x.wins, x.games) - bestPct) < 1e-9;
    const rowHtml = (x, extra='', trophy=false) => `<div class="stats-row ${trophy ? 'stats-leader' : ''}"><div class="stats-main"><div class="stats-name-line">${trophy ? '<span class="stats-trophy" title="Meilleur pourcentage de victoires" aria-label="Meilleur pourcentage de victoires">🏆</span>' : ''}<strong>${Utils.esc(x.name)}</strong></div>${extra}</div><div>${x.wins}/${x.games}</div><div class="stats-pct">${Stats.pct(x.wins,x.games).toFixed(1)} %</div></div>`;

    const impactRankingEl = document.getElementById('stats-impact-ranking');
    const strengthsEl = document.getElementById('stats-player-strengths');
    const playersEl = document.getElementById('stats-player-results');
    const teamsEl = document.getElementById('stats-team-results');
    const advancedEl = document.getElementById('stats-advanced-results');
    const gameHistoryEl = document.getElementById('stats-game-history-results');
    const summaryEl = document.getElementById('stats-summary');

    if (impactRankingEl) {
      const rankingAvailable = (gameFilter === 'all' || gameFilter === 'fiveHundred') && modeFilter !== 'individual';
      if (!rankingAvailable) {
        impactRankingEl.innerHTML = `<div class="empty-state-text">Le classement par impact net est disponible pour le 500 en équipes.</div>`;
      } else {
        const impactPlayers = new Map();
        const rankingGames = records.filter(r => r.gameType === 'fiveHundred' && r.mode === 'teams');

        rankingGames.forEach(r => {
          let names = r.players || [];
          if (teamFilter !== 'all') {
            const selectedTeam = (r.teams || []).find(t => t.key === teamFilter);
            names = selectedTeam?.members || [];
          }
          names.forEach(name => {
            const key = Stats.nameKey(name);
            if (playerFilter !== 'all' && key !== playerFilter) return;
            const x = impactPlayers.get(key) || { name, games:0, wins:0, netImpact:0, contracts:0, success:0, failed:0, hands:0, decisiveWins:0, bold:0, boldSuccess:0, types:new Set() };
            x.games++;
            if ((r.winnerPlayers || []).some(w => Stats.nameKey(w) === key)) x.wins++;
            impactPlayers.set(key, x);
          });
        });

        const rankingGameKey = (r) => `${r.sourceGameId || ''}|${r.seriesGameNumber || 1}`;
        const rankingContractsByGame = new Map();
        baseContractRecords.forEach(r => {
          const gk = rankingGameKey(r);
          if (!rankingContractsByGame.has(gk)) rankingContractsByGame.set(gk, []);
          rankingContractsByGame.get(gk).push(r);

          const key = Stats.nameKey(r.player);
          if (playerFilter !== 'all' && key !== playerFilter) return;
          const x = impactPlayers.get(key);
          if (!x) return;
          x.contracts++;
          if (r.success) x.success++; else x.failed++;
          x.netImpact += Number(r.netImpact) || 0;
          x.types.add(r.contract);
          if (Games.fiveHundred.isAnyMulotContract(r.contract) || Games.fiveHundred.isGameContract(r.contract)) {
            x.bold++;
            if (r.success) x.boldSuccess++;
          }
        });
        rankingContractsByGame.forEach(arr => arr.sort((a,b) => new Date(a.date) - new Date(b.date)));
        rankingGames.forEach(gr => {
          const gc = rankingContractsByGame.get(rankingGameKey(gr)) || [];
          const finalContract = gc.length ? gc[gc.length - 1] : null;
          (gr.players || []).forEach(name => {
            const x = impactPlayers.get(Stats.nameKey(name));
            if (!x) return;
            x.hands += gc.length;
            if (finalContract?.success && Stats.nameKey(finalContract.player) === Stats.nameKey(name) &&
                (gr.winnerPlayers || []).some(w => Stats.nameKey(w) === Stats.nameKey(name))) x.decisiveWins++;
          });
        });

        const impactRows = [...impactPlayers.values()]
          .filter(x => x.games >= minGames)
          .sort((a,b) => b.netImpact-a.netImpact || Stats.pct(b.wins,b.games)-Stats.pct(a.wins,a.games) || b.games-a.games || a.name.localeCompare(b.name,'fr-CA'));
        const bestNetImpact = impactRows.length ? impactRows[0].netImpact : null;
        const rankingRowsHtml = impactRows.map((x, idx) => {
          const trophy = bestNetImpact !== null && Math.abs(x.netImpact - bestNetImpact) < 1e-9;
          const rankLabel = trophy ? '🏆' : `${idx + 1}`;
          const netClass = x.netImpact >= 0 ? 'stats-net-positive' : 'stats-net-negative';
          return `<div class="stats-impact-rank-row ${trophy ? 'is-leader' : ''}"><div class="stats-impact-rank-pos" title="${trophy ? 'Meilleur impact net' : `Rang ${idx+1}`}">${rankLabel}</div><div class="stats-impact-rank-player"><strong>${Utils.esc(x.name)}</strong><small>${x.games} partie(s) · ${x.wins} victoire(s) · ${Stats.pct(x.wins,x.games).toFixed(1)} % V</small></div><div class="stats-impact-rank-contracts"><strong>${x.success}/${x.failed}</strong><small>R/P</small></div><div class="stats-impact-rank-net ${netClass}"><strong>${Utils.signed(x.netImpact)}</strong><small>impact net</small></div></div>`;
        }).join('');
        const identifiedContracts = baseContractRecords.filter(r => impactPlayers.has(Stats.nameKey(r.player))).length;
        impactRankingEl.innerHTML = impactRows.length
          ? `<div class="stats-impact-ranking-note">Classement principal du 500 selon l'impact net des contrats. En cas d'égalité, le % de victoires puis le nombre de parties départagent l'ordre. ${identifiedContracts} contrat(s) avec preneur identifié dans les filtres actuels.</div><div class="stats-impact-ranking-list">${rankingRowsHtml}</div>`
          : `<div class="empty-state-text">${minGames ? `Aucun joueur avec au moins ${minGames} parties de 500 en équipes` : 'Aucune donnée de 500 en équipes'}</div>`;
      }
    }

    if (strengthsEl) {
      const strengthsAvailable = (gameFilter === 'all' || gameFilter === 'fiveHundred') && modeFilter !== 'individual';
      if (!strengthsAvailable) {
        strengthsEl.innerHTML = `<div class="empty-state-text">Les points forts sont disponibles pour le 500 en équipes.</div>`;
      } else {
        const sPlayers = new Map();
        const sGames = records.filter(r => r.gameType === 'fiveHundred' && r.mode === 'teams');
        sGames.forEach(gr => {
          let strengthNames = gr.players || [];
          if (teamFilter !== 'all') strengthNames = (gr.teams || []).find(t => t.key === teamFilter)?.members || [];
          strengthNames.forEach(name => {
          const pk = Stats.nameKey(name);
          if (playerFilter !== 'all' && pk !== playerFilter) return;
          const x = sPlayers.get(pk) || { name, games:0, wins:0, winsWithSuccess:0, contracts:0, success:0, failed:0, successPoints:0, failedCost:0, netImpact:0, hands:0, decisiveWins:0, bold:0, boldSuccess:0, types:new Set() };
          x.games++;
          if ((gr.winnerPlayers || []).some(w => Stats.nameKey(w) === pk)) x.wins++;
          sPlayers.set(pk,x);
          });
        });
        const sgk = r => `${r.sourceGameId || ''}|${r.seriesGameNumber || 1}`;
        const scbg = new Map();
        baseContractRecords.forEach(c => {
          const gk=sgk(c); if(!scbg.has(gk)) scbg.set(gk,[]); scbg.get(gk).push(c);
          const x=sPlayers.get(Stats.nameKey(c.player)); if(!x) return;
          x.contracts++;
          if(c.success) { x.success++; x.successPoints += Number(c.contractPoints)||0; }
          else { x.failed++; x.failedCost += Math.abs(Number(c.awardedPoints)||0); }
          x.netImpact += Number(c.netImpact)||0; x.types.add(c.contract);
          if (Games.fiveHundred.isAnyMulotContract(c.contract) || Games.fiveHundred.isGameContract(c.contract)) { x.bold++; if(c.success)x.boldSuccess++; }
        });
        scbg.forEach(a=>a.sort((a,b)=>new Date(a.date)-new Date(b.date)));
        sGames.forEach(gr=>{
          const gc=scbg.get(sgk(gr))||[]; const last=gc.length?gc[gc.length-1]:null;
          (gr.players||[]).forEach(name=>{ const x=sPlayers.get(Stats.nameKey(name)); if(!x)return; x.hands += gc.length;
            const pk = Stats.nameKey(name);
            const won = (gr.winnerPlayers||[]).some(w=>Stats.nameKey(w)===pk);
            if(won && gc.some(c=>c.success && Stats.nameKey(c.player)===pk)) x.winsWithSuccess++;
            if(last?.success && Stats.nameKey(last.player)===pk && won) x.decisiveWins++;
          });
        });
        const rows=[...sPlayers.values()].filter(x=>x.games>=minGames);
        const pctRank=(arr,val)=>{
          const nums=arr.filter(Number.isFinite).slice().sort((a,b)=>a-b); if(!nums.length)return 0;
          let below=0,equal=0; nums.forEach(n=>{if(n<val)below++; else if(Math.abs(n-val)<1e-9)equal++;});
          return (below + Math.max(0,equal-1)/2) / Math.max(1,nums.length-1);
        };
        rows.forEach(x => {
          const impact = Stats.impactIndex(
            { success:x.success, contracts:x.contracts, successPoints:x.successPoints, failedCost:x.failedCost },
            { games:x.games, wins:x.wins, winsWithSuccess:x.winsWithSuccess, decisiveWins:x.decisiveWins }
          );
          x.impactIndex = impact.score;
          x.impactBreakdown = impact;
          x.takeRate = Stats.pct(x.contracts, x.hands);
          x.boldSuccessRate = Stats.pct(x.boldSuccess, x.bold);
        });
        const bestNet = rows.length ? Math.max(...rows.map(x=>x.netImpact)) : null;
        const bestImpactIndex = rows.length ? Math.max(...rows.map(x=>x.impactIndex)) : null;
        const bestWinPct = rows.length ? Math.max(...rows.map(x=>Stats.pct(x.wins,x.games))) : null;
        const eligibleSuccess = rows.filter(x=>x.contracts>=3);
        const bestSuccessPct = eligibleSuccess.length ? Math.max(...eligibleSuccess.map(x=>Stats.pct(x.success,x.contracts))) : null;
        const eligibleTake = rows.filter(x=>x.hands>0);
        const bestTakeRate = eligibleTake.length ? Math.max(...eligibleTake.map(x=>Stats.pct(x.contracts,x.hands))) : null;
        const bestFinish = rows.length ? Math.max(...rows.map(x=>x.decisiveWins)) : null;
        const bestBoldSuccess = rows.length ? Math.max(...rows.map(x=>x.boldSuccess)) : null;
        const bestTypes = rows.length ? Math.max(...rows.map(x=>x.types.size)) : null;
        const same=(a,b)=>a!==null&&b!==null&&Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<1e-9;
        const chooseStrength=x=>{
          // Hiérarchie stricte : le premier critère où le joueur est meilleur gagne.
          // 1) impact net, 2) indice d’impact, 3) ratio V/D, 4) réussite contrats,
          // 5) fréquence de prise, 6) finisseur, 7) gros contrats réussis, 8) polyvalence.
          if(same(x.netImpact,bestNet)) {
            return {title:'Producteur de points',icon:'⚡',detail:`Impact net ${Utils.signed(x.netImpact)} pts : c’est le meilleur impact net parmi les joueurs admissibles dans les filtres actuels.`};
          }
          if(same(x.impactIndex,bestImpactIndex)) {
            return {title:'Meilleur indice d’impact',icon:'⭐',detail:`Indice d’impact ${x.impactIndex.toFixed(1)}/10 : c’est le meilleur score global, combinant victoires, réussite, efficacité en points, contribution aux victoires et contrats finisseurs.`};
          }
          const winPct=Stats.pct(x.wins,x.games);
          if(same(winPct,bestWinPct)) {
            return {title:'Gagnant régulier',icon:'🏆',detail:`${x.wins}/${x.games} victoires (${winPct.toFixed(1)} %) : c’est le meilleur ratio victoires/défaites parmi les joueurs admissibles dans les filtres actuels.`};
          }
          const successPct=x.contracts>=3?Stats.pct(x.success,x.contracts):null;
          if(x.contracts>=3 && same(successPct,bestSuccessPct)) {
            return {title:'Précis au contrat',icon:'🎯',detail:`${x.success}/${x.contracts} contrats réussis (${successPct.toFixed(1)} %) : c’est le meilleur taux de réussite des contrats parmi les joueurs admissibles.`};
          }
          const takeRate=x.hands>0?Stats.pct(x.contracts,x.hands):null;
          if(x.hands>0 && same(takeRate,bestTakeRate)) {
            return {title:'Meneur des enchères',icon:'📣',detail:`Il prend ${takeRate.toFixed(1)} % des contrats disponibles lorsqu'il joue : c’est la fréquence de prise la plus élevée parmi les joueurs admissibles.`};
          }
          if(x.decisiveWins>0 && same(x.decisiveWins,bestFinish)) {
            return {title:'Finisseur',icon:'🏁',detail:`${x.decisiveWins} contrat(s) réussi(s) ont directement terminé une partie gagnante pour son équipe : c’est le meilleur total de contrats finisseurs.`};
          }
          if(x.boldSuccess>0 && same(x.boldSuccess,bestBoldSuccess)) {
            return {title:'Audacieux efficace',icon:'🔥',detail:`${x.boldSuccess} gros contrat(s) Partie/Mulot réussi(s) : c’est le meilleur total sur les mises les plus ambitieuses.`};
          }
          if(x.types.size>=2 && same(x.types.size,bestTypes)) {
            return {title:'Polyvalent',icon:'🃏',detail:`${x.types.size} types de contrats différents tentés : c’est la plus grande diversité de contrats parmi les joueurs admissibles.`};
          }
          return {title:'Profil en construction',icon:'•',detail:'Pas encore assez de données distinctives pour isoler un point fort selon la hiérarchie actuelle.'};
        };
        const chooseRecommendation=x=>{
          const impact = x.impactBreakdown || Stats.impactIndex(
            { success:x.success, contracts:x.contracts, successPoints:x.successPoints, failedCost:x.failedCost },
            { games:x.games, wins:x.wins, winsWithSuccess:x.winsWithSuccess, decisiveWins:x.decisiveWins }
          );
          if (x.contracts === 0) {
            return {title:'Prendre quelques contrats calculés',detail:`Aucun contrat pris sur ${x.hands} occasion(s) enregistrée(s). Commencer par des mises à forte probabilité permettrait de mesurer puis d’augmenter sa contribution directe.`};
          }
          if (x.netImpact < 0) {
            return {title:'Ramener l’impact net dans le positif',detail:`Ses contrats ont produit ${x.successPoints} pts mais ont concédé ${x.failedCost} pts, pour un impact net de ${Utils.signed(x.netImpact)}. La priorité est de réduire les échecs coûteux, surtout sur les mises élevées.`};
          }
          if (x.bold >= 2 && x.boldSuccessRate < 50) {
            return {title:'Mieux sélectionner les gros contrats',detail:`${x.boldSuccess}/${x.bold} Partie/Mulot réussis (${x.boldSuccessRate.toFixed(1)} %). Une sélection plus stricte de ces contrats améliorerait rapidement l’impact net sans devoir miser moins souvent.`};
          }
          if (x.contracts < 3) {
            return {title:'Accumuler davantage de prises mesurées',detail:`Seulement ${x.contracts} contrat(s) pris. Quelques contrats supplémentaires, choisis dans des situations favorables, donneraient une base plus fiable pour cibler précisément le prochain levier d’amélioration.`};
          }
          const candidates = [
            {key:'win',loss:0.35*(100-impact.winPct),title:'Convertir davantage de parties en victoires',detail:`Taux de victoire ${impact.winPct.toFixed(1)} %. C’est actuellement la composante qui limite le plus sa performance globale : l’objectif est de transformer plus souvent ses bonnes contributions en victoire d’équipe.`},
            {key:'success',loss:0.25*(100-impact.successPct),title:'Être plus sélectif dans les contrats',detail:`${x.success}/${x.contracts} contrats réussis (${impact.successPct.toFixed(1)} %). Améliorer la sélection des mises augmenterait simultanément l’indice d’impact et l’impact net.`},
            {key:'value',loss:0.20*(100-impact.valueEfficiency),title:'Limiter le coût des contrats perdus',detail:`Efficacité en points ${impact.valueEfficiency.toFixed(1)} % : ${x.successPoints} pts produits contre ${x.failedCost} pts concédés. Réduire la valeur des échecs est son meilleur levier sur les points.`}
          ];
          if (x.wins >= 2) {
            candidates.push({key:'contribution',loss:0.10*(100-impact.contributionPct),title:'Être plus souvent moteur des victoires',detail:`Il réussit lui-même au moins un contrat dans ${impact.contributionPct.toFixed(1)} % de ses victoires. Augmenter cette contribution directe rendrait ses victoires moins dépendantes du partenaire.`});
            candidates.push({key:'finisher',loss:0.10*(100-impact.finisherPct),title:'Développer son rôle de finisseur',detail:`${x.decisiveWins} de ses ${x.wins} victoire(s) se terminent directement sur l’un de ses contrats (${impact.finisherPct.toFixed(1)} %). Identifier davantage les occasions de fermer une partie renforcerait son impact.`});
          }
          const best = candidates.sort((a,b)=>b.loss-a.loss)[0];
          return best || {title:'Consolider la régularité',detail:'Les indicateurs sont équilibrés. Le prochain gain viendra surtout de maintenir la réussite tout en évitant les contrats à faible valeur attendue.'};
        };
        strengthsEl.innerHTML = rows.length ? `<div class="stats-strengths-list">${rows
          .sort((a,b)=>b.netImpact-a.netImpact || Stats.pct(b.wins,b.games)-Stats.pct(a.wins,a.games))
          .map(x=>{const s=chooseStrength(x);const r=chooseRecommendation(x);return `<div class="stats-strength-row"><div class="stats-strength-icon">${s.icon}</div><div class="stats-strength-main"><strong>${Utils.esc(x.name)} · ${Utils.esc(s.title)}</strong><small>${Utils.esc(s.detail)}</small><div class="stats-recommendation"><span>À travailler</span><strong>${Utils.esc(r.title)}</strong><small>${Utils.esc(r.detail)}</small></div></div></div>`;}).join('')}</div>`
          : `<div class="empty-state-text">Aucun joueur ne satisfait le minimum de parties.</div>`;
      }
    }

    if (summaryEl) {
      const resetInfo = statsResetAt
        ? `<div class="stats-reset-info">Statistiques réinitialisées le ${Utils.esc(Utils.formatDate(statsResetAt))}</div>`
        : '';
      summaryEl.innerHTML = `<strong>${records.length}</strong> partie(s) terminée(s) correspondant aux filtres${resetInfo}`;
    }
    if (playersEl) {
      const rows = rankRows(playerMap.values());
      playersEl.innerHTML = rows.length
        ? rows.map(x => rowHtml(x)).join('')
        : `<div class="empty-state-text">${minGames ? `Aucun joueur avec au moins ${minGames} parties` : 'Aucune statistique individuelle'}</div>`;
    }
    if (teamsEl) {
      const rows = rankRows(teamMap.values());
      const bestPct = leaderPct(rows);
      teamsEl.innerHTML = rows.length
        ? rows.map(x => rowHtml(x, '', isLeader(x, bestPct))).join('')
        : `<div class="empty-state-text">${minGames ? `Aucune équipe avec au moins ${minGames} parties` : 'Aucune statistique d’équipe'}</div>`;
    }

    if (advancedEl) {
      const advancedAvailable = (gameFilter === 'all' || gameFilter === 'fiveHundred') && modeFilter !== 'individual';
      const teamContracts = contractRecords.filter(r => r.mode === 'teams');
      const allTeamContractsInPeriod = allContractRecords.filter(r => r.mode === 'teams' && inPeriod(r));
      const teamGames = records.filter(r => r.gameType === 'fiveHundred' && r.mode === 'teams');

      if (!advancedAvailable) {
        advancedEl.innerHTML = `<div class="empty-state-text">Les statistiques avancées de contrats sont disponibles pour le 500 en équipes.</div>`;
      } else if (!teamContracts.length) {
        advancedEl.innerHTML = `<div class="empty-state-text">Aucun contrat avec preneur identifié pour ces filtres. Les anciennes donnes enregistrées avant la v2.14 ne peuvent pas être attribuées rétroactivement à un joueur.</div>`;
      } else {
        const gameKey = (r) => `${r.sourceGameId || ''}|${r.seriesGameNumber || 1}`;
        const contractsByGame = new Map();
        allTeamContractsInPeriod.forEach(r => {
          const k = gameKey(r);
          if (!contractsByGame.has(k)) contractsByGame.set(k, []);
          contractsByGame.get(k).push(r);
        });
        contractsByGame.forEach(arr => arr.sort((a,b) => new Date(a.date) - new Date(b.date)));

        const contractGroups = new Map();
        teamContracts.forEach(r => {
          const key = r.contract || 'UNKNOWN';
          const g = contractGroups.get(key) || { key, label:Stats.contractDisplayLabel(key), attempts:0, success:0, failed:0, events:[], players:new Map() };
          g.attempts++;
          if (r.success) g.success++; else g.failed++;
          g.events.push(r);
          const pk = Stats.nameKey(r.player);
          const px = g.players.get(pk) || { name:r.player, attempts:0, success:0 };
          px.attempts++; if (r.success) px.success++;
          g.players.set(pk, px);
          contractGroups.set(key, g);
        });

        const bidderMap = new Map();
        teamContracts.forEach(r => {
          const key = Stats.nameKey(r.player);
          const gamesPlayed = playerMap.get(key)?.games || teamGames.filter(g => g.players.some(n => Stats.nameKey(n) === key)).length;
          const x = bidderMap.get(key) || {
            name:r.player, games:gamesPlayed, contracts:0, success:0, failed:0, types:new Set(), bold:0, boldSuccess:0,
            successPoints:0, failedCost:0, netImpact:0, positions:new Map(), contractCounts:new Map(), biggestSuccess:null,
          };
          x.games = gamesPlayed;
          x.contracts++;
          if (r.success) {
            x.success++;
            x.successPoints += Number(r.contractPoints) || 0;
            if (!x.biggestSuccess || (Number(r.contractPoints) || 0) > x.biggestSuccess.points) {
              x.biggestSuccess = { label:Stats.contractDisplayLabel(r.contract), points:Number(r.contractPoints) || 0, date:r.date };
            }
          } else {
            x.failed++;
            x.failedCost += Math.abs(Number(r.awardedPoints) || 0);
          }
          x.netImpact += Number(r.netImpact) || 0;
          x.types.add(r.contract);
          x.contractCounts.set(r.contract, (x.contractCounts.get(r.contract) || 0) + 1);
          if (Number.isInteger(r.bidPosition) && r.bidPosition >= 1 && r.bidPosition <= 4) {
            const pos = x.positions.get(r.bidPosition) || { attempts:0, success:0 };
            pos.attempts++; if (r.success) pos.success++;
            x.positions.set(r.bidPosition, pos);
          }
          if (Games.fiveHundred.isAnyMulotContract(r.contract) || Games.fiveHundred.isGameContract(r.contract)) {
            x.bold++;
            if (r.success) x.boldSuccess++;
          }
          bidderMap.set(key, x);
        });

        // Impact par partie terminée : participation, prises, contribution aux victoires,
        // finisseurs, partenaires, adversaires et séries de victoires.
        const impactMap = new Map();
        const chronologicalGames = teamGames.slice().sort((a,b) => new Date(a.date) - new Date(b.date));
        chronologicalGames.forEach(gr => {
          const gContracts = contractsByGame.get(gameKey(gr)) || [];
          const finalContract = gContracts.length ? gContracts[gContracts.length - 1] : null;
          gr.players.forEach(name => {
            const pk = Stats.nameKey(name);
            if (playerFilter !== 'all' && pk !== playerFilter) return;
            const x = impactMap.get(pk) || {
              name, games:0, wins:0, winsWithSuccess:0, decisiveWins:0, contracts:0, hands:0, noBidGames:0, success:0,
              bestStreak:0, currentStreak:0, runningStreak:0, partners:new Map(), opponents:new Map(), gameResults:[],
            };
            x.games++;
            const own = gContracts.filter(c => Stats.nameKey(c.player) === pk);
            x.contracts += own.length;
            x.hands += gContracts.length;
            if (!own.length) x.noBidGames++;
            x.success += own.filter(c => c.success).length;
            const won = gr.winnerPlayers.some(w => Stats.nameKey(w) === pk);
            if (won) {
              x.wins++;
              x.runningStreak++;
              x.bestStreak = Math.max(x.bestStreak, x.runningStreak);
              if (own.some(c => c.success)) x.winsWithSuccess++;
              if (finalContract && finalContract.success && Stats.nameKey(finalContract.player) === pk) x.decisiveWins++;
            } else {
              x.runningStreak = 0;
            }
            x.gameResults.push({ date:gr.date, won });

            const ownTeam = gr.teams.find(t => t.members.some(m => Stats.nameKey(m) === pk));
            if (ownTeam) {
              ownTeam.members.filter(m => Stats.nameKey(m) !== pk).forEach(partner => {
                const kk = Stats.nameKey(partner);
                const ps = x.partners.get(kk) || { name:partner, games:0, wins:0 };
                ps.games++; if (won) ps.wins++;
                x.partners.set(kk, ps);
              });
              gr.teams.filter(t => t.key !== ownTeam.key).flatMap(t => t.members).forEach(opponent => {
                const kk = Stats.nameKey(opponent);
                const os = x.opponents.get(kk) || { name:opponent, games:0, wins:0 };
                os.games++; if (won) os.wins++;
                x.opponents.set(kk, os);
              });
            }
            impactMap.set(pk, x);
          });
        });
        impactMap.forEach(x => {
          const latest = x.gameResults[x.gameResults.length - 1];
          if (!latest?.won) x.currentStreak = 0;
          else {
            let streak = 0;
            for (let i=x.gameResults.length-1; i>=0 && x.gameResults[i].won; i--) streak++;
            x.currentStreak = streak;
          }
        });

        // Partenariats : performance du duo et efficacité de ses contrats.
        const partnershipMap = new Map();
        teamGames.forEach(gr => {
          const gContracts = contractsByGame.get(gameKey(gr)) || [];
          gr.teams.forEach(t => {
            if (!t?.key || !Array.isArray(t.members) || !t.members.length) return;
            const x = partnershipMap.get(t.key) || { key:t.key, name:Stats.teamLabel(t.members), members:t.members, games:0, wins:0, contracts:0, success:0, netImpact:0 };
            x.games++;
            if (gr.winnerTeamKey === t.key) x.wins++;
            const ownContracts = gContracts.filter(c => c.team?.key === t.key);
            x.contracts += ownContracts.length;
            x.success += ownContracts.filter(c => c.success).length;
            x.netImpact += ownContracts.reduce((sum,c) => sum + (Number(c.netImpact) || 0), 0);
            partnershipMap.set(t.key, x);
          });
        });

        // Positions de parole : 1 = joueur qui ouvrait les enchères sur la donne.
        const positionMap = new Map([1,2,3,4].map(i => [i,{ position:i, attempts:0, success:0, players:new Map() }]));
        teamContracts.forEach(r => {
          const pos = Number(r.bidPosition);
          if (!positionMap.has(pos)) return;
          const x = positionMap.get(pos);
          x.attempts++; if (r.success) x.success++;
          const pk = Stats.nameKey(r.player);
          const px = x.players.get(pk) || { name:r.player, attempts:0, success:0 };
          px.attempts++; if (r.success) px.success++;
          x.players.set(pk,px);
        });

        const eligibleBidders = [...bidderMap.values()].filter(x => x.games >= minGames);
        const eligibleImpact = [...impactMap.values()].filter(x => x.games >= minGames && x.hands > 0);
        const eligiblePartnerships = [...partnershipMap.values()].filter(x => x.games >= minGames);
        const totalAttempts = teamContracts.length;
        const mostActive = eligibleBidders.slice().sort((a,b)=>b.contracts-a.contracts || Stats.pct(b.success,b.contracts)-Stats.pct(a.success,a.contracts))[0] || null;
        const bestEfficiency = eligibleBidders.filter(x=>x.contracts>=3).sort((a,b)=>Stats.pct(b.success,b.contracts)-Stats.pct(a.success,a.contracts) || b.contracts-a.contracts)[0] || null;
        const mostUseful = eligibleImpact.slice().sort((a,b)=>b.winsWithSuccess-a.winsWithSuccess || Stats.pct(b.winsWithSuccess,b.wins)-Stats.pct(a.winsWithSuccess,a.wins) || b.success-a.success)[0] || null;
        const mostSeated = eligibleImpact.slice().sort((a,b)=>Stats.pct(a.contracts,a.hands)-Stats.pct(b.contracts,b.hands) || b.noBidGames-a.noBidGames)[0] || null;
        const bestFinisher = eligibleImpact.slice().sort((a,b)=>b.decisiveWins-a.decisiveWins || b.winsWithSuccess-a.winsWithSuccess)[0] || null;
        const boldest = eligibleBidders.filter(x=>x.bold>0).sort((a,b)=>b.bold-a.bold || Stats.pct(b.boldSuccess,b.bold)-Stats.pct(a.boldSuccess,a.bold))[0] || null;
        const popular = [...contractGroups.values()].sort((a,b)=>b.attempts-a.attempts || b.success-a.success)[0] || null;
        const bestPair = eligiblePartnerships.slice().sort((a,b)=>Stats.pct(b.wins,b.games)-Stats.pct(a.wins,a.games) || b.games-a.games || b.wins-a.wins)[0] || null;
        const bestNet = eligibleBidders.slice().sort((a,b)=>b.netImpact-a.netImpact || b.successPoints-a.successPoints)[0] || null;

        // Indice d'impact 0-10, formule versionnée pour préserver la comparabilité historique.
        const impactIndex = (bid, imp) => Stats.impactIndex(bid, imp);

        const metricsForPlayerGames = (pk, name, gameSlice) => {
          const imp = { name, games:0, wins:0, winsWithSuccess:0, decisiveWins:0, contracts:0, hands:0, noBidGames:0 };
          const bid = { name, contracts:0, success:0, failed:0, successPoints:0, failedCost:0, netImpact:0, attemptedPoints:0 };
          let currentStreak = 0;
          let bestStreak = 0;
          (gameSlice || []).forEach(gr => {
            if (!gr.players.some(n => Stats.nameKey(n) === pk)) return;
            imp.games++;
            const gc = contractsByGame.get(gameKey(gr)) || [];
            const own = gc.filter(c => Stats.nameKey(c.player) === pk);
            const finalContract = gc.length ? gc[gc.length - 1] : null;
            imp.contracts += own.length;
            imp.hands += gc.length;
            if (!own.length) imp.noBidGames++;
            bid.contracts += own.length;
            own.forEach(c => {
              const pts = Number(c.contractPoints) || 0;
              bid.attemptedPoints += pts;
              if (c.success) { bid.success++; bid.successPoints += pts; }
              else { bid.failed++; bid.failedCost += Math.abs(Number(c.awardedPoints) || 0); }
              bid.netImpact += Number(c.netImpact) || 0;
            });
            const won = gr.winnerPlayers.some(w => Stats.nameKey(w) === pk);
            if (won) {
              imp.wins++;
              currentStreak++;
              bestStreak = Math.max(bestStreak, currentStreak);
              if (own.some(c => c.success)) imp.winsWithSuccess++;
              if (finalContract?.success && Stats.nameKey(finalContract.player) === pk) imp.decisiveWins++;
            } else currentStreak = 0;
          });
          const idx = impactIndex(bid, imp);
          return {
            ...idx, imp, bid,
            netImpact: bid.netImpact,
            takeRate: Stats.pct(bid.contracts, imp.hands),
            avgContractValue: bid.contracts ? bid.attemptedPoints / bid.contracts : 0,
            currentStreak, bestStreak,
          };
        };

        const evolutionForPlayer = (pk, name) => {
          const playerGames = chronologicalGames.filter(gr => gr.players.some(n => Stats.nameKey(n) === pk));
          const snapshots = playerGames.map((gr, i) => {
            const m = metricsForPlayerGames(pk, name, playerGames.slice(0, i + 1));
            return { date:gr.date, games:m.imp.games, score:m.score, winPct:m.winPct, successPct:m.successPct, netImpact:m.netImpact, takeRate:m.takeRate, avgContractValue:m.avgContractValue };
          });
          const career = metricsForPlayerGames(pk, name, playerGames);
          const last10 = metricsForPlayerGames(pk, name, playerGames.slice(-10));
          const last5 = metricsForPlayerGames(pk, name, playerGames.slice(-5));
          const validPeaks = snapshots.filter(x => x.games >= 3);
          const peakImpact = validPeaks.slice().sort((a,b)=>b.score-a.score)[0] || null;
          const peakWinPct = validPeaks.slice().sort((a,b)=>b.winPct-a.winPct)[0] || null;
          const latest = snapshots[snapshots.length-1] || null;
          const prior5 = snapshots.length > 5 ? snapshots[snapshots.length-6] : null;
          const delta5 = latest && prior5 ? latest.score - prior5.score : null;
          return { playerGames, snapshots, career, last10, last5, peakImpact, peakWinPct, delta5 };
        };
        const impactIndexRows = eligibleImpact.map(imp => {
          const bid = bidderMap.get(Stats.nameKey(imp.name)) || { success:0, contracts:0, successPoints:0, failedCost:0, netImpact:0 };
          return { name:imp.name, imp, bid, ...impactIndex(bid,imp) };
        }).sort((a,b)=>b.score-a.score || b.imp.games-a.imp.games);
        const bestImpactIndex = impactIndexRows[0] || null;

        const kpi = (title, name, detail, infoKey) => `<div class="stats-kpi"><span>${Utils.esc(title)}${infoKey ? ` <button class="stats-info-btn stats-info-btn-mini" onclick="UI.openStatsInfo('${infoKey}')" aria-label="Information">i</button>` : ''}</span><strong>${Utils.esc(name || 'N/D')}</strong><small>${Utils.esc(detail || '')}</small></div>`;
        const kpis = [
          kpi('Meilleur duo', bestPair?.name, bestPair ? `${bestPair.wins}/${bestPair.games} victoires · ${Stats.pct(bestPair.wins,bestPair.games).toFixed(1)} %` : '', 'partnerships'),
          kpi('Indice d’impact', bestImpactIndex?.name, bestImpactIndex ? `${bestImpactIndex.score.toFixed(1)}/10` : '', 'impactIndex'),
          kpi('Meilleur impact net', bestNet?.name, bestNet ? `${Utils.signed(bestNet.netImpact)} pts sur ses contrats` : '', 'netImpact'),
          kpi('Contrat le plus fréquent', popular?.label, popular ? `${popular.attempts} tentative(s) · ${Stats.pct(popular.attempts,totalAttempts).toFixed(1)} % des contrats` : '', 'contractHistory'),
          kpi('Prend le plus souvent', mostActive?.name, mostActive ? `${mostActive.contracts} contrat(s) · ${Stats.pct(mostActive.contracts,totalAttempts).toFixed(1)} % du total filtré` : '', 'takeRate'),
          kpi('Meilleure efficacité', bestEfficiency?.name, bestEfficiency ? `${bestEfficiency.success}/${bestEfficiency.contracts} réussis · ${Stats.pct(bestEfficiency.success,bestEfficiency.contracts).toFixed(1)} %` : 'Minimum 3 contrats', 'successRate'),
          kpi('Plus utile aux victoires', mostUseful?.name, mostUseful ? `${mostUseful.winsWithSuccess} victoire(s) avec au moins 1 contrat réussi` : '', 'teamImpact'),
          kpi('Joue le plus assis', mostSeated?.name, mostSeated ? `${mostSeated.contracts}/${mostSeated.hands} contrats pris · ${Stats.pct(mostSeated.contracts,mostSeated.hands).toFixed(1)} % des donnes` : '', 'takeRate'),
          kpi('Meilleur finisseur', bestFinisher?.decisiveWins ? bestFinisher.name : null, bestFinisher?.decisiveWins ? `${bestFinisher.decisiveWins} contrat(s) réussi(s) ayant terminé une victoire` : 'Aucun contrat finisseur réussi', 'finisher'),
          kpi('Plus audacieux', boldest?.name, boldest ? `${boldest.bold} Partie/Mulot tenté(s) · ${boldest.boldSuccess} réussi(s)` : '', 'bidders'),
        ].join('');

        const bidderRows = eligibleBidders.slice().sort((a,b)=>b.contracts-a.contracts || Stats.pct(b.success,b.contracts)-Stats.pct(a.success,a.contracts) || a.name.localeCompare(b.name,'fr-CA'));
        const bidderHtml = bidderRows.length ? `
          <div class="stats-advanced-table stats-advanced-table-5">
            <div class="stats-advanced-head"><span>Joueur</span><span>Pris</span><span>R/P</span><span>Réussite</span><span>Net</span></div>
            ${bidderRows.map(x => `<div class="stats-advanced-row"><div><strong>${Utils.esc(x.name)}</strong><small>${x.types.size} type(s) différent(s)</small></div><div>${x.contracts}</div><div>${x.success}/${x.failed}</div><div class="stats-pct">${Stats.pct(x.success,x.contracts).toFixed(1)} %</div><div class="${x.netImpact >= 0 ? 'stats-net-positive' : 'stats-net-negative'}">${Utils.signed(x.netImpact)}</div></div>`).join('')}
          </div>` : `<div class="empty-state-text">Aucun joueur ne satisfait le minimum de parties.</div>`;

        const partnershipRows = eligiblePartnerships.slice().sort((a,b)=>Stats.pct(b.wins,b.games)-Stats.pct(a.wins,a.games) || b.games-a.games || b.netImpact-a.netImpact);
        const partnershipHtml = partnershipRows.length ? `
          <div class="stats-advanced-table stats-partnership-table">
            <div class="stats-advanced-head"><span>Duo</span><span>V/G</span><span>%</span><span>Contrats</span><span>Net</span></div>
            ${partnershipRows.map(x => `<div class="stats-advanced-row"><div><strong>${Utils.esc(x.name)}</strong><small>${x.success}/${x.contracts} contrats réussis</small></div><div>${x.wins}/${x.games}</div><div class="stats-pct">${Stats.pct(x.wins,x.games).toFixed(1)} %</div><div>${x.contracts}</div><div class="${x.netImpact >= 0 ? 'stats-net-positive' : 'stats-net-negative'}">${Utils.signed(x.netImpact)}</div></div>`).join('')}
          </div>` : `<div class="empty-state-text">Aucun duo ne satisfait le minimum de parties.</div>`;

        const impactRows = eligibleImpact.slice().sort((a,b)=>b.winsWithSuccess-a.winsWithSuccess || b.decisiveWins-a.decisiveWins || a.name.localeCompare(b.name,'fr-CA'));
        const impactHtml = impactRows.length ? `
          <div class="stats-advanced-table stats-advanced-table-impact">
            <div class="stats-advanced-head"><span>Joueur</span><span>Impact V</span><span>Finisseur</span><span>Part prise</span></div>
            ${impactRows.map(x => `<div class="stats-advanced-row"><div><strong>${Utils.esc(x.name)}</strong><small>${x.noBidGames} partie(s) sans prendre un contrat</small></div><div>${x.winsWithSuccess}/${x.wins}</div><div>${x.decisiveWins}</div><div class="stats-pct">${Stats.pct(x.contracts,x.hands).toFixed(1)} %</div></div>`).join('')}
          </div>` : `<div class="empty-state-text">Pas assez de parties terminées pour mesurer l'impact d'équipe.</div>`;

        const positionRows = [...positionMap.values()].filter(x => x.attempts > 0);
        const positionHtml = positionRows.length ? `
          <div class="stats-advanced-table stats-position-table">
            <div class="stats-advanced-head"><span>Position</span><span>Contrats</span><span>R</span><span>Réussite</span></div>
            ${positionRows.map(x => {
              const leader = [...x.players.values()].sort((a,b)=>b.attempts-a.attempts || Stats.pct(b.success,b.attempts)-Stats.pct(a.success,a.attempts))[0];
              return `<div class="stats-advanced-row"><div><strong>${x.position}${x.position===1?'er':'e'} à parler</strong><small>${leader ? `Le plus actif : ${Utils.esc(leader.name)} (${leader.attempts})` : ''}</small></div><div>${x.attempts}</div><div>${x.success}</div><div class="stats-pct">${Stats.pct(x.success,x.attempts).toFixed(1)} %</div></div>`;
            }).join('')}
          </div>` : `<div class="empty-state-text">Position de parole non disponible dans ces données.</div>`;

        // Records de parties.
        const biggestSuccess = teamContracts.filter(r => r.success).sort((a,b)=>(b.contractPoints||0)-(a.contractPoints||0) || new Date(b.date)-new Date(a.date))[0] || null;
        const timedGames = teamGames.filter(g => Number(g.durationMs) > 0);
        const longestGame = timedGames.slice().sort((a,b)=>b.durationMs-a.durationMs)[0] || null;
        const fastestGame = timedGames.slice().sort((a,b)=>a.durationMs-b.durationMs)[0] || null;
        const busiestGame = teamGames.map(g => ({ game:g, contracts:(contractsByGame.get(gameKey(g)) || []).length })).sort((a,b)=>b.contracts-a.contracts)[0] || null;

        let biggestComeback = null;
        let bestSingleGameNet = null;
        teamGames.forEach(g => {
          const gc = contractsByGame.get(gameKey(g)) || [];
          const winnerIdx = Number.isInteger(g.winnerTeamIdx) ? g.winnerTeamIdx : g.teams.findIndex(t => t.key === g.winnerTeamKey);
          if (winnerIdx >= 0) {
            const scores = [0,0];
            let maxDeficit = 0;
            gc.forEach(c => {
              const opponentIdx = winnerIdx === 0 ? 1 : 0;
              maxDeficit = Math.max(maxDeficit, Math.max(0, scores[opponentIdx] - scores[winnerIdx]));
              if (Number.isInteger(c.awardedTeamIdx)) scores[c.awardedTeamIdx] = Math.max(0, scores[c.awardedTeamIdx] + (Number(c.awardedPoints) || 0));
            });
            if (!biggestComeback || maxDeficit > biggestComeback.deficit) biggestComeback = { deficit:maxDeficit, game:g };
          }
          const perPlayer = new Map();
          gc.forEach(c => perPlayer.set(Stats.nameKey(c.player), (perPlayer.get(Stats.nameKey(c.player)) || 0) + (Number(c.netImpact) || 0)));
          perPlayer.forEach((net,pk) => {
            const name = gc.find(c => Stats.nameKey(c.player) === pk)?.player || pk;
            if (!bestSingleGameNet || net > bestSingleGameNet.net) bestSingleGameNet = { net, name, game:g };
          });
        });
        const longestStreak = eligibleImpact.slice().sort((a,b)=>b.bestStreak-a.bestStreak || b.wins-a.wins)[0] || null;
        const recordCard = (title, main, detail='') => `<div class="stats-record"><span>${Utils.esc(title)}</span><strong>${Utils.esc(main || 'N/D')}</strong><small>${Utils.esc(detail)}</small></div>`;
        const recordsHtml = [
          recordCard('Plus gros contrat réussi', biggestSuccess ? `${Stats.contractDisplayLabel(biggestSuccess.contract)} · ${biggestSuccess.player}` : null, biggestSuccess ? `${biggestSuccess.contractPoints} pts · ${Utils.formatDate(biggestSuccess.date)}` : ''),
          recordCard('Plus gros comeback', biggestComeback?.deficit ? `${biggestComeback.deficit} pts` : 'Aucun déficit majeur', biggestComeback?.deficit ? `${Utils.formatDate(biggestComeback.game.date)}` : ''),
          recordCard('Plus de contrats dans une partie', busiestGame ? `${busiestGame.contracts} contrats` : null, busiestGame ? Utils.formatDate(busiestGame.game.date) : ''),
          recordCard('Meilleur impact sur une partie', bestSingleGameNet ? `${bestSingleGameNet.name} · ${Utils.signed(bestSingleGameNet.net)} pts` : null, bestSingleGameNet ? Utils.formatDate(bestSingleGameNet.game.date) : ''),
          recordCard('Plus longue série de victoires', longestStreak?.bestStreak ? `${longestStreak.name} · ${longestStreak.bestStreak}` : null, longestStreak?.bestStreak ? `${longestStreak.currentStreak} victoire(s) consécutive(s) actuellement` : ''),
          recordCard('Partie la plus longue', longestGame ? Utils.formatDuration(longestGame.durationMs) : null, longestGame ? Utils.formatDate(longestGame.date) : ''),
          recordCard('Partie la plus courte', fastestGame ? Utils.formatDuration(fastestGame.durationMs) : null, fastestGame ? Utils.formatDate(fastestGame.date) : ''),
        ].join('');

        // Profils détaillés par joueur.
        const profileKeys = new Set([...impactMap.keys(), ...bidderMap.keys()]);
        const profiles = [...profileKeys].map(pk => {
          const imp = impactMap.get(pk) || { name:bidderMap.get(pk)?.name || pk, games:0,wins:0,winsWithSuccess:0,decisiveWins:0,contracts:0,hands:0,noBidGames:0,partners:new Map(),opponents:new Map(),bestStreak:0,currentStreak:0 };
          const bid = bidderMap.get(pk) || { name:imp.name, contracts:0,success:0,failed:0,successPoints:0,failedCost:0,netImpact:0,contractCounts:new Map(),positions:new Map(),biggestSuccess:null };
          const idx = impactIndex(bid,imp);
          const partners = [...(imp.partners || new Map()).values()].sort((a,b)=>Stats.pct(b.wins,b.games)-Stats.pct(a.wins,a.games) || b.games-a.games);
          const opponents = [...(imp.opponents || new Map()).values()].sort((a,b)=>Stats.pct(a.wins,a.games)-Stats.pct(b.wins,b.games) || b.games-a.games);
          const favorite = [...(bid.contractCounts || new Map()).entries()].sort((a,b)=>b[1]-a[1])[0];
          const bestPos = [...(bid.positions || new Map()).entries()].filter(([,v])=>v.attempts>0).sort((a,b)=>Stats.pct(b[1].success,b[1].attempts)-Stats.pct(a[1].success,a[1].attempts) || b[1].attempts-a[1].attempts)[0];
          const trend = evolutionForPlayer(pk, imp.name || bid.name);
          return { pk, name:imp.name || bid.name, imp, bid, idx, partners, opponents, favorite, bestPos, trend };
        }).filter(x => x.imp.games >= minGames).sort((a,b)=>b.idx.score-a.idx.score || b.imp.games-a.imp.games);
        const profilesHtml = profiles.length ? profiles.map(x => {
          const bestPartner = x.partners[0] || null;
          const hardOpponent = x.opponents[0] || null;
          const favLabel = x.favorite ? Stats.contractDisplayLabel(x.favorite[0]) : 'Aucun';
          const periodCard = (label, m) => `<div class="stats-period-card"><span>${Utils.esc(label)}</span><strong>${m.score.toFixed(1)}/10</strong><small>${m.imp.wins}/${m.imp.games} V · ${m.winPct.toFixed(1)} % · contrats ${m.successPct.toFixed(1)} % · net ${Utils.signed(m.netImpact)}</small></div>`;
          const chartCard = (label, key, formatter) => {
            const vals = x.trend.snapshots.map(s => Number(s[key]) || 0);
            const last = vals.length ? vals[vals.length-1] : 0;
            const first = vals.length ? vals[0] : 0;
            return `<div class="stats-evolution-chart"><div class="stats-evolution-chart-head"><span>${Utils.esc(label)}</span><strong>${Utils.esc(formatter(last))}</strong></div>${Stats.sparklineSvg(vals)}<small>Début ${Utils.esc(formatter(first))} · ${vals.length} partie(s)</small></div>`;
          };
          const trendHtml = `<div class="stats-period-grid">${periodCard('Carrière / filtre',x.trend.career)}${periodCard('10 dernières',x.trend.last10)}${periodCard('5 dernières',x.trend.last5)}</div>
            <details class="stats-evolution-detail"><summary>Évolution et historique</summary>
              <div class="stats-trend-records">
                <div><span>Record impact</span><strong>${x.trend.peakImpact ? `${x.trend.peakImpact.score.toFixed(1)}/10` : 'N/D'}</strong><small>${x.trend.peakImpact ? Utils.formatDate(x.trend.peakImpact.date) : 'Minimum 3 parties'}</small></div>
                <div><span>Pic victoires</span><strong>${x.trend.peakWinPct ? `${x.trend.peakWinPct.winPct.toFixed(1)} %` : 'N/D'}</strong><small>${x.trend.peakWinPct ? Utils.formatDate(x.trend.peakWinPct.date) : 'Minimum 3 parties'}</small></div>
                <div><span>Tendance 5 parties</span><strong class="${x.trend.delta5 === null || x.trend.delta5 >= 0 ? 'stats-net-positive' : 'stats-net-negative'}">${x.trend.delta5 === null ? 'N/D' : `${x.trend.delta5 >= 0 ? '+' : ''}${x.trend.delta5.toFixed(1)}`}</strong><small>Variation de l'indice</small></div>
              </div>
              <div class="stats-evolution-grid">
                ${chartCard('Indice impact','score',v=>`${v.toFixed(1)}/10`)}
                ${chartCard('Victoires','winPct',v=>`${v.toFixed(1)} %`)}
                ${chartCard('Réussite contrats','successPct',v=>`${v.toFixed(1)} %`)}
                ${chartCard('Impact net','netImpact',v=>`${v>=0?'+':''}${Math.round(v)} pts`)}
                ${chartCard('Prise de contrat','takeRate',v=>`${v.toFixed(1)} %`)}
                ${chartCard('Valeur moyenne','avgContractValue',v=>`${Math.round(v)} pts`)}
              </div>
            </details>`;
          return `<details class="stats-player-profile">
            <summary><span><strong>${Utils.esc(x.name)}</strong><small>${x.imp.wins}/${x.imp.games} victoires · ${x.bid.success}/${x.bid.contracts} contrats réussis</small></span><span class="stats-impact-badge">${x.idx.score.toFixed(1)}</span></summary>
            <div class="stats-profile-grid">
              <div><span>Impact net <button class="stats-info-btn stats-info-btn-mini" onclick="event.stopPropagation();UI.openStatsInfo('netImpact')" aria-label="Information sur l’impact net">i</button></span><strong class="${x.bid.netImpact >= 0 ? 'stats-net-positive' : 'stats-net-negative'}">${Utils.signed(x.bid.netImpact)} pts</strong></div>
              <div><span>Réussite contrats <button class="stats-info-btn stats-info-btn-mini" onclick="event.stopPropagation();UI.openStatsInfo('successRate')" aria-label="Information sur la réussite des contrats">i</button></span><strong>${Stats.pct(x.bid.success,x.bid.contracts).toFixed(1)} %</strong></div>
              <div><span>Contrat préféré</span><strong>${Utils.esc(favLabel)}</strong></div>
              <div><span>Plus gros réussi</span><strong>${x.bid.biggestSuccess ? `${Utils.esc(x.bid.biggestSuccess.label)} (${x.bid.biggestSuccess.points})` : 'Aucun'}</strong></div>
              <div><span>Meilleur partenaire</span><strong>${bestPartner ? `${Utils.esc(bestPartner.name)} · ${Stats.pct(bestPartner.wins,bestPartner.games).toFixed(1)} %` : 'N/D'}</strong></div>
              <div><span>Adversaire difficile</span><strong>${hardOpponent ? `${Utils.esc(hardOpponent.name)} · ${Stats.pct(hardOpponent.wins,hardOpponent.games).toFixed(1)} % V` : 'N/D'}</strong></div>
              <div><span>Série actuelle</span><strong>${x.imp.currentStreak} V</strong></div>
              <div><span>Meilleure série</span><strong>${x.imp.bestStreak} V</strong></div>
              <div><span>Meilleure position</span><strong>${x.bestPos ? `${x.bestPos[0]}${x.bestPos[0]===1?'er':'e'} · ${Stats.pct(x.bestPos[1].success,x.bestPos[1].attempts).toFixed(1)} %` : 'N/D'}</strong></div>
              <div><span>Valeur efficace <button class="stats-info-btn stats-info-btn-mini" onclick="event.stopPropagation();UI.openStatsInfo('valueEfficiency')" aria-label="Information sur l’efficacité en points">i</button></span><strong>${x.idx.valueEfficiency.toFixed(1)} %</strong></div>
            </div>
            ${trendHtml}
            <div class="stats-impact-formula">Indice ${x.idx.score.toFixed(1)}/10 · formule v${x.idx.version} = 35 % victoires (${x.idx.winPct.toFixed(1)}) + 25 % réussite (${x.idx.successPct.toFixed(1)}) + 20 % efficacité en points (${x.idx.valueEfficiency.toFixed(1)}) + 10 % contribution aux victoires (${x.idx.contributionPct.toFixed(1)}) + 10 % finisseurs (${x.idx.finisherPct.toFixed(1)}).</div>
          </details>`;
        }).join('') : `<div class="empty-state-text">Aucun profil ne satisfait le minimum de parties.</div>`;

        const groups = [...contractGroups.values()].sort((a,b)=>b.attempts-a.attempts || a.label.localeCompare(b.label,'fr-CA'));
        const detailsHtml = groups.map(g => {
          const events = g.events.slice().sort((a,b)=>new Date(b.date)-new Date(a.date));
          const byPlayers = [...g.players.values()].sort((a,b)=>b.attempts-a.attempts || a.name.localeCompare(b.name,'fr-CA'))
            .map(p => `${p.name}: ${p.attempts} (${p.success} R)`).join(' · ');
          return `<details class="stats-contract-detail">
            <summary><span><strong>${Utils.esc(g.label)}</strong><small>${g.attempts} tentative(s) · ${g.success} réussie(s) · ${Stats.pct(g.success,g.attempts).toFixed(1)} %</small></span><span class="stats-contract-count">${g.attempts}</span></summary>
            <div class="stats-contract-players">${Utils.esc(byPlayers)}</div>
            <div class="stats-contract-events">${events.map(e => `<div><span>${Utils.esc(Utils.formatDate(e.date))}</span><strong>${Utils.esc(e.player)}</strong><em class="${e.success ? 'is-success' : 'is-fail'}">${e.success ? 'Réussi' : 'Perdu'}</em></div>`).join('')}</div>
          </details>`;
        }).join('');

        advancedEl.innerHTML = `
          <div class="stats-advanced-grid">${kpis}</div>
          <div class="stats-advanced-section"><div class="stats-advanced-title">Partenariats <button class="stats-info-btn" onclick="UI.openStatsInfo('partnerships')" aria-label="Information sur les partenariats">i</button></div><div class="stats-advanced-note">Compare les duos réellement formés. La rotation équilibrée permet de voir quels partenaires fonctionnent le mieux ensemble.</div>${partnershipHtml}</div>
          <div class="stats-advanced-section"><div class="stats-advanced-title">Preneurs, efficacité et impact net <button class="stats-info-btn" onclick="UI.openStatsInfo('bidders')" aria-label="Information sur les preneurs et l’impact net">i</button></div><div class="stats-advanced-note">Net = points de contrats réussis moins les points concédés à l'adversaire lors des contrats perdus.</div>${bidderHtml}</div>
          <div class="stats-advanced-section"><div class="stats-advanced-title">Impact dans l'équipe <button class="stats-info-btn" onclick="UI.openStatsInfo('teamImpact')" aria-label="Information sur l’impact dans l’équipe">i</button></div><div class="stats-advanced-note">Impact V = victoires où le joueur a réussi au moins un contrat. Part prise = proportion des donnes où ce joueur était preneur.</div>${impactHtml}</div>
          <div class="stats-advanced-section"><div class="stats-advanced-title">Position de parole <button class="stats-info-btn" onclick="UI.openStatsInfo('bidPosition')" aria-label="Information sur la position de parole">i</button></div><div class="stats-advanced-note">1er = joueur qui ouvre les enchères. La position du preneur est reconstruite sur les anciennes donnes lorsque l'historique le permet et enregistrée directement à partir de la v2.18.</div>${positionHtml}</div>
          <div class="stats-advanced-section"><div class="stats-advanced-title">Profils joueurs et indice d’impact <button class="stats-info-btn" onclick="UI.openStatsInfo('profiles')" aria-label="Information sur les profils joueurs">i</button></div><div class="stats-advanced-note">Ouvre un joueur pour voir partenaires, adversaires, séries, contrats, position et la formule complète de son indice.</div>${profilesHtml}</div>
          <div class="stats-advanced-section"><div class="stats-advanced-title">Records <button class="stats-info-btn" onclick="UI.openStatsInfo('records')" aria-label="Information sur les records">i</button></div><div class="stats-record-grid">${recordsHtml}</div></div>
          <div class="stats-advanced-section"><div class="stats-advanced-title">Fréquence et historique par contrat <button class="stats-info-btn" onclick="UI.openStatsInfo('contractHistory')" aria-label="Information sur l’historique des contrats">i</button></div><div class="stats-advanced-note">Ouvre un contrat pour voir qui l'a tenté, à quelle date et s'il a été réussi.</div>${detailsHtml}</div>`;
      }
    }

    // Historique détaillé des parties 500. Cette section est indépendante du minimum
    // de parties : chaque partie terminée correspondant aux filtres peut être ouverte.
    if (gameHistoryEl) {
      const historyAvailable = (gameFilter === 'all' || gameFilter === 'fiveHundred') && modeFilter !== 'individual';
      const historyGames = records
        .filter(r => r.gameType === 'fiveHundred' && r.mode === 'teams')
        .slice()
        .sort((a,b) => new Date(b.date) - new Date(a.date));
      const historyContracts = allContractRecords
        .filter(r => r.mode === 'teams' && inPeriod(r));
      const historyGameKey = (r) => `${r.sourceGameId || ''}|${r.seriesGameNumber || 1}`;
      const historyContractsByGame = new Map();
      historyContracts.forEach(r => {
        const k = historyGameKey(r);
        if (!historyContractsByGame.has(k)) historyContractsByGame.set(k, []);
        historyContractsByGame.get(k).push(r);
      });
      historyContractsByGame.forEach(arr => arr.sort((a,b) => new Date(a.date) - new Date(b.date)));

      const teamForPlayer = (g, name) => (g.teams || []).find(t => (t.members || []).some(m => Stats.nameKey(m) === Stats.nameKey(name))) || null;
      const winnerTeam = (g) => (g.teams || []).find(t => t.key === g.winnerTeamKey) || (Number.isInteger(g.winnerTeamIdx) ? g.teams?.[g.winnerTeamIdx] : null) || null;
      const scoreText = (g) => (g.teams || []).map((t,i) => `${Stats.teamLabel(t.members || [])} ${Number(g.finalScores?.[i]) || 0}`).join(' · ');

      const renderGame = (g) => {
        const gc = historyContractsByGame.get(historyGameKey(g)) || [];
        const winner = winnerTeam(g);
        const successCount = gc.filter(c => c.success).length;
        const failedCount = gc.length - successCount;
        const avgValue = gc.length ? gc.reduce((sum,c) => sum + (Number(c.contractPoints) || 0), 0) / gc.length : 0;
        const biggest = gc.slice().sort((a,b)=>(Number(b.contractPoints)||0)-(Number(a.contractPoints)||0))[0] || null;
        const last = gc[gc.length - 1] || null;

        const playerRows = (g.players || []).map(name => {
          const pk = Stats.nameKey(name);
          const own = gc.filter(c => Stats.nameKey(c.player) === pk);
          const successes = own.filter(c => c.success).length;
          const failures = own.length - successes;
          const successPoints = own.filter(c => c.success).reduce((sum,c)=>sum+(Number(c.contractPoints)||0),0);
          const failedCost = own.filter(c => !c.success).reduce((sum,c)=>sum+Math.abs(Number(c.awardedPoints)||0),0);
          const net = own.reduce((sum,c)=>sum+(Number(c.netImpact)||0),0);
          const team = teamForPlayer(g,name);
          const won = (g.winnerPlayers || []).some(w => Stats.nameKey(w) === pk);
          const finisher = !!(last?.success && Stats.nameKey(last.player) === pk && won);
          const bid = { contracts:own.length, success:successes, successPoints, failedCost };
          const imp = { games:1, wins:won?1:0, winsWithSuccess:won && successes>0 ? 1 : 0, decisiveWins:finisher ? 1 : 0 };
          const idx = Stats.impactIndex(bid, imp);
          const positions = own.map(c=>Number(c.bidPosition)).filter(Number.isInteger);
          const posText = positions.length ? positions.map(pos=>`${pos}${pos===1?'er':'e'}`).join(', ') : 'N/D';
          return `<div class="stats-game-player-row">
            <div><strong>${Utils.esc(name)}</strong><small>${Utils.esc(team ? Stats.teamLabel(team.members || []) : 'Équipe N/D')}${won ? ' · gagnant' : ''}</small></div>
            <div>${own.length}</div><div>${successes}/${failures}</div><div>${Stats.pct(successes,own.length).toFixed(1)} %</div>
            <div class="${net >= 0 ? 'stats-net-positive' : 'stats-net-negative'}">${Utils.signed(net)}</div>
            <div>${idx.score.toFixed(1)}</div>
            <div class="stats-game-player-extra"><small>Positions : ${Utils.esc(posText)}${finisher ? ' · finisseur' : ''}</small></div>
          </div>`;
        }).join('');

        const teamRows = (g.teams || []).map((t,i) => {
          const own = gc.filter(c => c.team?.key === t.key);
          const successes = own.filter(c=>c.success).length;
          const net = own.reduce((sum,c)=>sum+(Number(c.netImpact)||0),0);
          const won = t.key === g.winnerTeamKey || i === g.winnerTeamIdx;
          return `<div class="stats-game-team-row ${won ? 'is-winner' : ''}"><div><strong>${Utils.esc(Stats.teamLabel(t.members || []))}</strong><small>${won ? 'Gagnants' : 'Adversaires'}</small></div><div><strong>${Number(g.finalScores?.[i]) || 0}</strong><small>score final</small></div><div><strong>${own.length}</strong><small>contrats</small></div><div><strong>${successes}/${own.length-successes}</strong><small>R/P</small></div><div><strong class="${net >= 0 ? 'stats-net-positive' : 'stats-net-negative'}">${Utils.signed(net)}</strong><small>impact net</small></div></div>`;
        }).join('');

        const contractRows = gc.length ? gc.map((c,idx) => {
          const awardedTeam = Number.isInteger(c.awardedTeamIdx) ? g.teams?.[c.awardedTeamIdx] : null;
          const teamLabel = awardedTeam ? Stats.teamLabel(awardedTeam.members || []) : 'N/D';
          const pos = Number(c.bidPosition);
          const posLabel = Number.isInteger(pos) ? `${pos}${pos===1?'er':'e'} à parler` : 'position N/D';
          return `<div class="stats-game-contract-row">
            <div class="stats-game-contract-num">${idx+1}</div>
            <div class="stats-game-contract-main"><strong>${Utils.esc(c.player || 'Preneur N/D')} · ${Utils.esc(Stats.contractDisplayLabel(c.contract))}</strong><small>${Utils.esc(Utils.formatDate(c.date))} · ${Utils.esc(posLabel)}${c.openingBidder ? ` · ouvre : ${Utils.esc(c.openingBidder)}` : ''}</small></div>
            <div class="stats-game-contract-value"><strong>${Number(c.contractPoints)||0}</strong><small>valeur</small></div>
            <div class="stats-game-contract-result ${c.success ? 'is-success' : 'is-fail'}"><strong>${c.success ? 'Réussi' : 'Perdu'}</strong><small>+${Number(c.awardedPoints)||0} à ${Utils.esc(teamLabel)}</small></div>
            <div class="stats-game-contract-net ${Number(c.netImpact)>=0 ? 'stats-net-positive' : 'stats-net-negative'}">${Utils.signed(Number(c.netImpact)||0)}</div>
          </div>`;
        }).join('') : `<div class="empty-state-text">Aucun contrat avec preneur identifié pour cette partie.</div>`;

        const seriesLabel = g.seriesGameNumber ? `Partie ${g.seriesGameNumber}` : 'Partie';
        return `<details class="stats-game-detail">
          <summary>
            <div class="stats-game-summary-main"><strong>${Utils.esc(Utils.formatDate(g.date))}</strong><small>${Utils.esc(seriesLabel)} · ${Utils.esc(scoreText(g))}</small></div>
            <div class="stats-game-summary-winner"><span>🏆 ${Utils.esc(winner ? Stats.teamLabel(winner.members || []) : 'Gagnant N/D')}</span><small>${gc.length} contrat(s) · ${Stats.pct(successCount,gc.length).toFixed(1)} % réussis</small></div>
          </summary>
          <div class="stats-game-kpis">
            <div><span>Contrats</span><strong>${gc.length}</strong><small>${successCount} R · ${failedCount} P</small></div>
            <div><span>Réussite</span><strong>${Stats.pct(successCount,gc.length).toFixed(1)} %</strong><small>tous preneurs</small></div>
            <div><span>Valeur moyenne</span><strong>${Math.round(avgValue)} pts</strong><small>contrats tentés</small></div>
            <div><span>Plus gros contrat</span><strong>${biggest ? Utils.esc(Stats.contractDisplayLabel(biggest.contract)) : 'N/D'}</strong><small>${biggest ? `${Number(biggest.contractPoints)||0} pts · ${Utils.esc(biggest.player)}` : ''}</small></div>
            <div><span>Durée</span><strong>${Number(g.durationMs)>0 ? Utils.formatDuration(g.durationMs) : 'N/D'}</strong><small>${Utils.esc(seriesLabel)}</small></div>
            <div><span>Score final</span><strong>${Utils.esc((g.finalScores || []).map(n=>Number(n)||0).join(' - '))}</strong><small>${winner ? `victoire ${Utils.esc(Stats.teamLabel(winner.members || []))}` : ''}</small></div>
          </div>
          <div class="stats-game-subtitle">Équipes</div><div class="stats-game-team-list">${teamRows}</div>
          <div class="stats-game-subtitle">Joueurs</div>
          <div class="stats-game-player-table"><div class="stats-game-player-head"><span>Joueur</span><span>Pris</span><span>R/P</span><span>%</span><span>Net</span><span>Impact</span></div>${playerRows}</div>
          <div class="stats-game-subtitle">Tous les contrats, dans l'ordre</div><div class="stats-game-contract-list">${contractRows}</div>
        </details>`;
      };

      if (!historyAvailable) {
        gameHistoryEl.innerHTML = `<div class="empty-state-text">L'historique détaillé est disponible pour le 500 en équipes.</div>`;
      } else if (!historyGames.length) {
        gameHistoryEl.innerHTML = `<div class="empty-state-text">Aucune partie de 500 en équipes ne correspond aux filtres.</div>`;
      } else {
        gameHistoryEl.innerHTML = `<div class="stats-game-history-note">${historyGames.length} partie(s). Ouvre une partie pour voir ses équipes, les 4 joueurs, les statistiques propres à cette partie et tous les contrats dans l'ordre.</div>${historyGames.map(renderGame).join('')}`;
      }
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
          : (e.lossRule === 'mulot-supreme-500' ? ' · pénalité Mulot Suprême 500'
            : (e.lossRule === 'gros-mulot-440' ? ' · pénalité Gros Mulot 440'
            : (e.lossRule === 'mulot-225' ? ' · pénalité Mulot 225'
            : (e.lossRule === 'mulot-230' ? ' · pénalité Mulot 230'
            : (e.lossRule === 'mulot-325' ? ' · pénalité Mulot 325'
              : (e.lossRule === 'mulot-330' ? ' · pénalité Mulot 330'
                : (e.lossRule === 'mulot-250' ? ' · pénalité Mulot 250' : '')))))));
        // Compatibilité avec le premier build 2.4 qui journalisait encore une case « enchère ouverte ».
        const openText = e.openBid ? ' · enchère ouverte' : '';
        return `
          <div class="history-entry">
            <div class="history-header">
              <span class="history-player">${Utils.esc(e.bidder || e.team)} · ${contractLabel}${openText}</span>
              <span class="history-time">${Utils.formatDate(e.timestamp)}</span>
            </div>
            ${e.bidder ? `<div class="history-detail">Preneur : ${Utils.esc(e.bidder)} · équipe ${Utils.esc(e.team)}</div>` : ''}
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
        ? `<button class="contract-btn fh-mulot-contract fh-mulot-between-row ${UI._selectedContract === FIVE_HUNDRED_MULOT.key ? 'selected' : ''}" onclick="UI.selectContract('${FIVE_HUNDRED_MULOT.key}')" data-key="${FIVE_HUNDRED_MULOT.key}"><span class="contract-inline-label"><span class="bid-text">MULOT</span></span><small>225 / échec 225</small></button>`
        : `<div class="fh-contract-value-cell fh-mulot-contract fh-mulot-between-row"><span class="contract-inline-label"><span class="bid-text">MULOT</span></span><strong>225</strong><small>échec : 225</small></div>`)
      : '';

    const grosMulotHtml = game?.mode === 'teams'
      ? (interactive
        ? `<button class="contract-btn fh-gros-mulot-contract fh-mulot-between-row ${UI._selectedContract === FIVE_HUNDRED_GROS_MULOT.key ? 'selected' : ''}" onclick="UI.selectContract('${FIVE_HUNDRED_GROS_MULOT.key}')" data-key="${FIVE_HUNDRED_GROS_MULOT.key}"><span class="contract-inline-label"><span class="bid-text">GROS MULOT</span></span><small>440 / échec 440</small></button>`
        : `<div class="fh-contract-value-cell fh-gros-mulot-contract fh-mulot-between-row"><span class="contract-inline-label"><span class="bid-text">GROS MULOT</span></span><strong>440</strong><small>échec : 440</small></div>`)
      : '';


    const mulotSupremeHtml = game?.mode === 'teams'
      ? (interactive
        ? `<button class="contract-btn fh-mulot-supreme-contract fh-mulot-between-row ${UI._selectedContract === FIVE_HUNDRED_MULOT_SUPREME.key ? 'selected' : ''}" onclick="UI.selectContract('${FIVE_HUNDRED_MULOT_SUPREME.key}')" data-key="${FIVE_HUNDRED_MULOT_SUPREME.key}"><span class="contract-inline-label"><span class="bid-text">MULOT SUPRÊME</span></span><small>1000 / échec 500</small></button>`
        : `<div class="fh-contract-value-cell fh-mulot-supreme-contract fh-mulot-between-row"><span class="contract-inline-label"><span class="bid-text">MULOT SUPRÊME</span></span><strong>1000</strong><small>échec : 500</small></div>`)
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

      if (bid === '7' && mulotHtml) row += mulotHtml;
      if (bid === '9' && grosMulotHtml) row += grosMulotHtml;
      if (bid === '10' && mulotSupremeHtml) row += mulotSupremeHtml;
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
        <div class="card-title">Règles 500 adaptées v2.8</div>
        <div class="setting-sub"><strong>Enchère ouverte :</strong> 7, 8 ou 9 peuvent être annoncés sans nommer l'atout avant le minou. Après avoir pris le minou, le gagnant choisit ♠, ♣, ♦, ♥ ou S, mais conserve le pointage fixe de l'enchère ouverte : 7 = 130, 8 = 230, 9 = 330. Le risque est moindre, donc le contrat rapporte moins qu'une couleur annoncée immédiatement.</div>
        <div class="setting-sub" style="margin-top:8px"><strong>Surenchère :</strong> un joueur encore actif peut remonter sa propre enchère lors d'un tour suivant. Ordre clé : 7S (220) &lt; Mulot (225) &lt; 8 ouvert (230) &lt; 8♠ (240) ... 8S (320) &lt; 9 ouvert (330) &lt; 9♠ (340) ... 9S (420) &lt; Gros Mulot (440) &lt; Mulot Suprême (1000) &lt; Partie ♠ (1040). Le Mulot Suprême rapporte 1000 points s'il est réussi et donne 500 points aux adversaires s'il est chuté.</div>
        <div class="setting-sub" style="margin-top:8px"><strong>Partie chutée :</strong> les adversaires reçoivent 50 % de la valeur du contrat final. Exemples : Partie ♠ = 520, Partie ♥ = 550, Partie S = 560.</div>
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
        <div class="setting-sub" style="margin-bottom:12px">Sélectionnez le contrat final, puis le joueur qui a pris le contrat. Son équipe est déterminée automatiquement. Pour une enchère ouverte, choisissez 7 O, 8 O ou 9 O : le pointage demeure 130, 230 ou 330 même après le choix de l'atout. La pénalité réduite d'une Partie et la pénalité de 500 points du Mulot Suprême sont appliquées automatiquement.</div>
        ${this.fhContractTableHtml(true)}
        <div class="card-title" style="margin-top:14px">Joueur qui a pris le contrat</div>
        <div class="fh-player-select-grid" id="fh-modal-bidder-buttons"></div>
        <div class="result-btns" style="margin-top:14px">
          <button class="btn btn-success" id="fh-modal-btn-team-win" onclick="UI.fhApplyResult(true)" disabled>✅ Mise gagnée</button>
          <button class="btn btn-danger" id="fh-modal-btn-team-lose" onclick="UI.fhApplyResult(false)" disabled>❌ Mise perdue</button>
        </div>
        <div class="setting-sub fh-team-result-hint" id="fh-team-result-hint"></div>
        <div class="divider" style="margin-top:16px"></div>
        <button class="btn btn-secondary" id="fh-modal-null-deal-btn" onclick="UI.fhNullDeal()">∅ Partie nulle</button>
        <div class="setting-sub" style="margin-top:8px">Une partie nulle fait elle aussi avancer immédiatement la première mise au joueur suivant.</div>
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
          const defaultsUnchanged = tablePlayerNames.length === 4 && tablePlayerNames.every((name, i) => name === FIVE_HUNDRED_DEFAULT_TEAM_PLAYERS[i]);

          let defaultRotation = null;
          if (defaultsUnchanged) {
            const rotationState = await DB.getSetting('fhDefaultTeamRotation', {
              nextPairingIndex: 0,
              nextStarterOffset: 0,
              sequenceNumber: 1,
              history: [],
            }) || {};
            const pairingIndex = Number.isInteger(rotationState.nextPairingIndex) ? rotationState.nextPairingIndex : 0;
            const starterOffset = Number.isInteger(rotationState.nextStarterOffset) ? rotationState.nextStarterOffset : 0;
            const sequenceNumber = Math.max(1, Number(rotationState.sequenceNumber) || 1);
            defaultRotation = { pairingIndex, starterOffset, sequenceNumber };
          }

          game = Games.fiveHundred.createTeams(null, null, tablePlayerNames, seriesBestOf, defaultRotation);

          if (defaultsUnchanged && game.defaultTeamRotation?.managed) {
            const used = game.defaultTeamRotation;
            const currentHistory = (await DB.getSetting('fhDefaultTeamRotation', null))?.history || [];
            const history = [...currentHistory, {
              timestamp: new Date().toISOString(),
              gameId: game.id,
              sequenceNumber: used.sequenceNumber,
              pairingIndex: used.pairingIndex,
              starterOffset: used.starterOffset,
              teams: game.teams.map((t, idx) => ({
                name: t.name,
                members: Games.fiveHundred.teamMembers(game, idx),
              })),
              firstBidder: Games.fiveHundred.nextBidder(game).name,
            }].slice(-60);
            await DB.setSetting('fhDefaultTeamRotation', {
              nextPairingIndex: (used.pairingIndex + 1) % FIVE_HUNDRED_DEFAULT_TEAM_PAIRINGS.length,
              nextStarterOffset: (used.starterOffset + 1) % FIVE_HUNDRED_DEFAULT_TEAM_PLAYERS.length,
              sequenceNumber: used.sequenceNumber + 1,
              history,
            });
          }
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
    const list = game.mode === 'individual'
      ? game.players.map((p, i) => ({ name: p.name, selectionIdx: i, teamIdx: i % 2 }))
      : Games.fiveHundred.ensureTableSetup(game).map((p, i) => ({ ...p, selectionIdx: i }));
    ['fh-bidder-buttons', 'fh-modal-bidder-buttons'].forEach((id) => {
      const wrap = document.getElementById(id);
      if (!wrap) return;
      if (game.mode === 'teams') wrap.classList.add('fh-player-select-grid');
      wrap.innerHTML = list.map((entity) => `
        <button class="team-select-btn ${UI._selectedTeam === entity.selectionIdx ? `selected team-${entity.teamIdx % 2}` : ''}"
          onclick="UI.selectFhTeam(${entity.selectionIdx})">${Utils.esc(entity.name)}</button>
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
      const seats = Games.fiveHundred.ensureTableSetup(game);
      const bidder = Number.isInteger(UI._selectedTeam) ? seats[UI._selectedTeam] : null;
      const bidderTeam = bidder ? game.teams?.[bidder.teamIdx] : null;
      const bidderPrefix = bidder ? `<strong>${Utils.esc(bidder.name)}</strong> · ${Utils.esc(bidderTeam?.name || '')}<br>` : '';
      const full = Games.fiveHundred.contractPoints(game, UI._selectedContract);
      const failed = Games.fiveHundred.failedTeamContractPoints(game, UI._selectedContract);
      if (Games.fiveHundred.isAnyMulotContract(UI._selectedContract)) {
        hint.innerHTML = bidderPrefix;
      } else if (Games.fiveHundred.isOpenContract(UI._selectedContract)) {
        hint.innerHTML = `${bidderPrefix}<strong>${Games.fiveHundred.contractLabel(UI._selectedContract)} :</strong> réussite +${full}; échec +${failed} aux adversaires. L'atout choisi après le minou ne change pas cette valeur.`;
      } else if (Games.fiveHundred.isGameContract(UI._selectedContract)) {
        hint.innerHTML = `${bidderPrefix}<strong>Partie :</strong> réussite +${full}; échec +${failed} aux adversaires (50 %).`;
      } else {
        hint.innerHTML = `${bidderPrefix}Réussite +${full}; échec +${failed} aux adversaires.`;
      }
    }
  },

  async fhApplyResult(success) {
    if (UI._selectedContract === null || UI._selectedTeam === null) return;
    this.unlockFhSound();
    const game = State.currentGame;
    if (game.mode === 'individual') return;
    const seats = Games.fiveHundred.ensureTableSetup(game);
    const bidderSeatIdx = UI._selectedTeam;
    const bidder = seats[bidderSeatIdx];
    if (!bidder || !Number.isInteger(bidder.teamIdx)) return;
    const biddingTeamIdx = bidder.teamIdx;
    const contract = UI._selectedContract;
    const biddingTeamName = game.teams[biddingTeamIdx].name;
    const result = Games.fiveHundred.applyContract(game, biddingTeamIdx, contract, success, bidderSeatIdx);
    await DB.save('games', game);

    const next = result.nextBidder;
    const awarded = result.awardedTeam?.name || '';
    const isSeriesFinished = !!result.gameCompletion?.seriesWon;
    Utils.toast(
      isSeriesFinished
        ? `🏆 Série terminée : ${result.gameCompletion.seriesWinner.name} gagne ${game.series.wins[0]}-${game.series.wins[1]}`
        : success
          ? `✅ ${bidder.name} (${biddingTeamName}) +${result.awardedPoints} pts · Prochaine mise : ${next.name}`
          : `❌ ${bidder.name} chute ${Games.fiveHundred.isGameContract(contract) ? 'la Partie' : Games.fiveHundred.contractLabel(contract)} : +${result.awardedPoints} pts à ${awarded} · Prochaine mise : ${next.name}`,
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
    this.closeAppModal();
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
      statsFormulaVersions: { impactIndex: IMPACT_INDEX_FORMULA_VERSION },
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
      statsFormulaVersions: { impactIndex: IMPACT_INDEX_FORMULA_VERSION },
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

  openStatsInfo(key) {
    const infos = {
      impactRanking: ['Classement par impact net', 'Classement principal du 500 en équipes. Impact net = points produits par les contrats réussis moins les points concédés à l’adversaire lors des contrats perdus. Le trophée va au meilleur impact net.'],
      strengths: ['Points forts et recommandations', 'Le point fort suit une hiérarchie stricte : 1) meilleur impact net, 2) meilleur indice d’impact, 3) meilleur ratio victoires/défaites, 4) meilleur taux de réussite des contrats, 5) plus forte fréquence de prise, 6) meilleur finisseur, 7) audacieux efficace, 8) polyvalent. La recommandation est calculée séparément : elle cible le levier d’amélioration le plus pertinent selon le bilan des contrats et les composantes pondérées de l’indice d’impact. Un impact net négatif ou des gros contrats souvent perdus sont traités en priorité.'],
      winsPlayers: ['Victoires par joueur', 'V/G = victoires sur parties jouées. Une partie d’une série compte comme une partie distincte. Ce classement mesure le résultat final, sans tenir compte directement de la valeur des contrats.'],
      winsTeams: ['Victoires par équipe', 'V/G = victoires sur parties jouées pour chaque duo. Les équipes sont comparées selon leur pourcentage de victoires dans les filtres actuels.'],
      advanced: ['Statistiques avancées 500', 'Analyse les contrats pris par les joueurs : fréquence, réussite, impact net, rôle dans les victoires, partenariats, position de parole, tendances, records et indice d’impact.'],
      history: ['Historique détaillé des parties', 'Chaque partie terminée peut être ouverte pour consulter les équipes, le score, la durée, les statistiques des quatre joueurs et tous les contrats dans leur ordre chronologique.'],
      netImpact: ['Impact net', 'Impact net = points des contrats réussis − points accordés aux adversaires à cause des contrats perdus. Un résultat positif signifie que les contrats du joueur ont produit un gain net pour son équipe.'],
      impactIndex: ['Indice d’impact', 'Score composite sur 10. Formule v1 : 35 % taux de victoire, 25 % réussite des contrats, 20 % efficacité en points, 10 % contribution aux victoires et 10 % contrats finisseurs. Il complète l’impact net mais ne détermine pas le trophée principal.'],
      partnerships: ['Partenariats', 'Compare les duos réellement formés : parties, victoires, contrats réussis et impact net. Cela permet de distinguer la performance d’un joueur de l’effet de son partenaire.'],
      bidders: ['Preneurs et efficacité', 'Pris = nombre de contrats pris. R/P = réussis/perdus. Réussite = contrats réussis ÷ contrats pris. Net = impact net cumulé des contrats du joueur.'],
      teamImpact: ['Impact dans l’équipe', 'Impact V = victoires où le joueur a lui-même réussi au moins un contrat. Finisseur = contrat réussi par ce joueur qui termine directement une partie gagnante. Part prise = proportion des contrats disponibles qu’il a pris.'],
      bidPosition: ['Position de parole', '1er = joueur qui ouvrait les enchères sur la donne. Les positions suivantes suivent l’ordre de table. Le taux de réussite montre dans quelle position les contrats pris ont le mieux fonctionné.'],
      profiles: ['Profils et indice d’impact', 'Regroupe les statistiques individuelles du joueur, ses partenaires, adversaires, séries, contrat préféré, historique d’évolution et l’indice d’impact sur 10.'],
      records: ['Records', 'Records calculés dans les filtres courants : gros contrat, comeback, activité, impact sur une partie, séries de victoires et durée des parties.'],
      contractHistory: ['Fréquence par contrat', 'Regroupe chaque type de contrat, le nombre de tentatives, les preneurs, les réussites et les dates. Les anciennes donnes sans preneur identifié ne peuvent pas être attribuées rétroactivement.'],
      winRate: ['Taux de victoire', 'Pourcentage de parties terminées gagnées par le joueur ou l’équipe dans les filtres actuels.'],
      successRate: ['Réussite des contrats', 'Nombre de contrats réussis ÷ nombre de contrats pris. Cette statistique ne tient pas compte à elle seule de la valeur des contrats.'],
      takeRate: ['Fréquence de prise', 'Part des contrats disponibles pris par le joueur pendant les parties où il était présent. Une valeur élevée indique qu’il prend souvent la responsabilité de la mise.'],
      valueEfficiency: ['Efficacité en points', 'Compare la valeur des points obtenus par les contrats réussis à la valeur totale engagée. Elle pénalise les échecs coûteux et complète le simple taux de réussite.'],
      finisher: ['Contrat finisseur', 'Dernier contrat réussi par un joueur qui fait atteindre le seuil de victoire à son équipe et termine la partie.'],
      filters: ['Filtres statistiques', 'Tous les classements et statistiques sont recalculés selon le jeu, le mode, le joueur, l’équipe, la période et le minimum de parties sélectionnés.']
    };
    const item = infos[key];
    if (!item) return;
    this.openAppModal(item[0], `<div class="stats-info-modal-text">${Utils.esc(item[1])}</div>`);
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

    <!-- Modale globale : utilisable depuis tous les écrans -->
    <div class="app-modal-overlay" id="app-modal-overlay" onclick="UI.closeModalFromBackdrop(event)" style="display:none">
      <div class="app-modal-card" id="app-modal-card">
        <div class="app-modal-header">
          <div class="app-modal-title" id="app-modal-title"></div>
          <button class="btn-back" onclick="UI.closeAppModal()" aria-label="Fermer">✕</button>
        </div>
        <div class="app-modal-body" id="app-modal-body"></div>
      </div>
    </div>

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
        <button class="btn btn-secondary" onclick="UI.openFhManualAdjustModal()">± Ajustement manuel</button>
      </div>

      <div class="fh-end-series-zone">
        <button class="btn btn-danger btn-sm" onclick="UI.endGame()">■ Terminer la série</button>
      </div>
      <div class="fh-starter-callout" id="fh-starter-callout" aria-live="polite">
        <span>À TOI DE COMMENCER</span>
        <strong id="fh-starter-callout-name">—</strong>
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
        <div class="card-title stats-title-with-info"><span>Filtres</span><button class="stats-info-btn" onclick="UI.openStatsInfo('filters')" aria-label="Information sur les filtres">i</button></div>
        <div class="stats-filter-grid">
          <div class="form-group"><label class="form-label">Jeu</label><select class="form-select" id="stats-game-filter" onchange="UI.refreshStats()"><option value="all">Tous les jeux</option><option value="fiveHundred">500</option><option value="hearts">Dame de Pique</option><option value="magic">Magic</option><option value="generic">Générique</option></select></div>
          <div class="form-group"><label class="form-label">Mode</label><select class="form-select" id="stats-mode-filter" onchange="UI.refreshStats()"><option value="all">Tous</option><option value="individual">Solo seulement (exclut les équipes)</option><option value="teams">Équipe seulement</option></select></div>
          <div class="form-group"><label class="form-label">Joueur</label><select class="form-select" id="stats-player-filter" onchange="UI.refreshStats()"><option value="all">Tous les joueurs</option></select></div>
          <div class="form-group"><label class="form-label">Équipe</label><select class="form-select" id="stats-team-filter" onchange="UI.refreshStats()"><option value="all">Toutes les équipes</option></select></div>
          <div class="form-group"><label class="form-label">Période</label><select class="form-select" id="stats-period-filter" onchange="UI.refreshStats()"><option value="all">Depuis toujours</option><option value="30">30 derniers jours</option><option value="90">90 derniers jours</option><option value="365">12 derniers mois</option></select></div>
          <div class="form-group"><label class="form-label">Minimum de parties</label><select class="form-select" id="stats-min-games-filter" onchange="UI.refreshStats()"><option value="3" selected>3 parties ou +</option><option value="all">Afficher tout</option></select></div>
        </div>
      </div>

      <div class="card stats-impact-ranking-card">
        <div class="card-title stats-title-with-info"><span>🏆 Classement des joueurs · Impact net</span><button class="stats-info-btn" onclick="UI.openStatsInfo('impactRanking')" aria-label="Information sur le classement par impact net">i</button></div>
        <div id="stats-impact-ranking"></div>
      </div>

      <div class="card stats-strengths-card">
        <div class="card-title stats-title-with-info"><span>Points forts et recommandations</span><button class="stats-info-btn" onclick="UI.openStatsInfo('strengths')" aria-label="Information sur les points forts et recommandations">i</button></div>
        <div class="setting-sub" style="margin-bottom:12px">Pour chaque joueur, l’application ressort la dimension où il se démarque le plus dans les filtres actuels.</div>
        <div id="stats-player-strengths"></div>
      </div>

      <div class="card"><div class="card-title">Résumé</div><div id="stats-summary" class="stats-summary"></div></div>
      <div class="card"><div class="card-title stats-title-with-info"><span>Victoires par joueur</span><button class="stats-info-btn" onclick="UI.openStatsInfo('winsPlayers')" aria-label="Information sur les victoires par joueur">i</button></div><div class="stats-header"><span>Joueur</span><span>V/G</span><span>%</span></div><div id="stats-player-results" class="stats-list"></div></div>
      <div class="card"><div class="card-title stats-title-with-info"><span>Victoires par équipe</span><button class="stats-info-btn" onclick="UI.openStatsInfo('winsTeams')" aria-label="Information sur les victoires par équipe">i</button></div><div class="stats-header"><span>Équipe</span><span>V/G</span><span>%</span></div><div id="stats-team-results" class="stats-list"></div></div>
      <div class="card stats-advanced-card">
        <div class="card-title stats-title-with-info"><span>Statistiques avancées 500</span><button class="stats-info-btn" onclick="UI.openStatsInfo('advanced')" aria-label="Information sur les statistiques avancées">i</button></div>
        <div class="setting-sub" style="margin-bottom:12px">Analyse les contrats réellement pris, l'impact, les partenariats et l'évolution carrière / 10 dernières / 5 dernières.</div>
        <div id="stats-advanced-results"></div>
      </div>

      <div class="card stats-game-history-card">
        <div class="card-title stats-title-with-info"><span>Historique détaillé des parties 500</span><button class="stats-info-btn" onclick="UI.openStatsInfo('history')" aria-label="Information sur l’historique détaillé">i</button></div>
        <div class="setting-sub" style="margin-bottom:12px">Liste toutes les parties correspondant aux filtres. Ouvre une partie pour consulter ses statistiques complètes et chacun de ses contrats.</div>
        <div id="stats-game-history-results"></div>
      </div>

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

      const registration = await navigator.serviceWorker.register('./service-worker.js?v=2.26', {
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
