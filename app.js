/**
 * ScoreKeeper Pro — app.js
 * Application PWA complète : Dame de Pique, Magic, Jeu de 500, Générique
 * Architecture modulaire vanilla JS + IndexedDB
 */

'use strict';

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

  /** Vide complètement un store IndexedDB */
  async clear(store) {
    return new Promise((resolve, reject) => {
      const tx  = DB.db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).clear();
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  },

  /** Supprime toutes les parties et toutes les entrées de journal */
  async clearGamesAndLogs() {
    return new Promise((resolve, reject) => {
      const tx = DB.db.transaction(['games', 'logs'], 'readwrite');
      tx.objectStore('logs').clear();
      tx.objectStore('games').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
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
      // Appelé au changement d'écran pour rendre le contenu dynamique
      Screens.render(screenId, data);
    }
  }
};

/* ================================================================
   SECTION 5 : TABLES DE POINTAGE — JEU DE 500
   ================================================================ */

const FIVE_HUNDRED_SCORES = {
  '8♠':  240, '8♣': 260, '8♦': 280, '8♥': 300, '8NT': 320,
  '9♠':  340, '9♣': 360, '9♦': 380, '9♥': 400, '9NT': 420,
  '10♠': 440, '10♣':460, '10♦':480, '10♥':500, '10NT':520,
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
    create(team0Name, team1Name) {
      return {
        id: Utils.uid(),
        type: 'fiveHundred',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        teams: [
          { name: team0Name, score: 0 },
          { name: team1Name, score: 0 },
        ],
        history: [],
      };
    },

    /** Applique un résultat de contrat */
    applyContract(game, teamIdx, contractKey, success) {
      const pts   = FIVE_HUNDRED_SCORES[contractKey] || 0;
      const team  = game.teams[teamIdx];
      const old   = team.score;
      const delta = success ? pts : -pts;
      team.score += delta;

      game.history.push({
        timestamp: new Date().toISOString(),
        team: team.name,
        contract: contractKey,
        points: pts,
        success,
        oldValue: old,
        delta,
        newValue: team.score,
      });
      game.updatedAt = new Date().toISOString();

      // Vérifier victoire
      const winner = game.teams.find(t => t.score >= 1000);
      if (winner) game.status = 'finished';

      return { delta, newValue: team.score, winner };
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
      if (winner) game.status = 'finished';

      return { old, newValue: p.score, winner };
    }
  }
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
      container.innerHTML = `
        <div class="card">
          <div class="card-title">Noms des équipes</div>
          <div class="form-group">
            <label class="form-label">Équipe 1</label>
            <input class="form-input" id="team0-name" type="text" value="Nord-Sud" maxlength="20">
          </div>
          <div class="form-group">
            <label class="form-label">Équipe 2</label>
            <input class="form-input" id="team1-name" type="text" value="Est-Ouest" maxlength="20">
          </div>
        </div>
      `;
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

    // Scores des équipes
    const teamsEl = document.getElementById('fh-teams');
    const winner  = game.teams.find(t => t.score >= 1000);
    teamsEl.innerHTML = game.teams.map((t, i) => `
      <div class="team-card ${winner === t ? 'winner' : ''}">
        <div class="team-name">${Utils.esc(t.name)}</div>
        <div class="team-score ${t.score < 0 ? 'negative' : 'positive'}">${t.score}</div>
      </div>
    `).join('');

    // Victoire
    const victBanner = document.getElementById('fh-victory');
    if (winner) {
      victBanner.style.display = 'block';
      document.getElementById('fh-winner-name').textContent = winner.name;
      document.getElementById('fh-winner-score').textContent = winner.score;
    } else {
      victBanner.style.display = 'none';
    }

    // Sélecteur de contrat (rebuild si nécessaire)
    UI.renderContractPicker();
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
        return `
          <div class="history-entry">
            <div class="history-header">
              <span class="history-player">${Utils.esc(e.team)} · ${e.contract}</span>
              <span class="history-time">${Utils.formatDate(e.timestamp)}</span>
            </div>
            <div class="history-detail">
              ${e.oldValue} <span class="${e.delta >= 0 ? 'history-delta-pos' : 'history-delta-neg'}">${Utils.signed(e.delta)}</span> → ${e.newValue}
              (${e.success ? '✅ Réussi' : '❌ Chuté'})
            </div>
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
  _selectedTeam: null,      // équipe sélectionnée en jeu de 500

  /** Démarre la création d'une partie */
  startNewGame(type) {
    Router.go('new-game', { type });
  },

  /** Reprend une partie existante */
  resumeGame(game) {
    State.currentGame = game;
    const screenMap = {
      hearts:      'hearts',
      magic:       'magic',
      fiveHundred: 'five-hundred',
      generic:     'generic',
    };
    Router.go(screenMap[game.type] || 'home');
  },

  /** Crée la partie à partir du formulaire */
  async createGame() {
    const type = document.getElementById('new-game-type').value;

    try {
      let game;

      if (type === 'fiveHundred') {
        const t0 = document.getElementById('team0-name').value.trim() || 'Équipe 1';
        const t1 = document.getElementById('team1-name').value.trim() || 'Équipe 2';
        game = Games.fiveHundred.create(t0, t1);

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

      State.currentGame = game;
      await DB.save('games', game);
      Utils.toast('Partie créée !', 'success');

      const screenMap = { hearts: 'hearts', magic: 'magic', fiveHundred: 'five-hundred', generic: 'generic' };
      Router.go(screenMap[type] || 'home');

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
  renderContractPicker() {
    const bids    = ['8','9','10'];
    const pickerEl = document.getElementById('fh-contract-picker');
    if (!pickerEl) return;

    // Mettre à jour les labels des équipes avec les vrais noms
    const game = State.currentGame;
    if (game && game.teams) {
      const btn0 = document.getElementById('fh-team-0');
      const btn1 = document.getElementById('fh-team-1');
      if (btn0) btn0.textContent = game.teams[0].name;
      if (btn1) btn1.textContent = game.teams[1].name;
    }

    // Construction de la grille des contrats
    const rows = bids.map(bid =>
      SUITS.map(suit => {
        const key = `${bid}${suit}`;
        const pts = FIVE_HUNDRED_SCORES[key];
        const label = suit === 'NT' ? '🚫' : suit;
        return `
          <button class="contract-btn ${UI._selectedContract === key ? 'selected' : ''}"
            onclick="UI.selectContract('${key}')" data-key="${key}">
            <span class="suit-icon">${label}</span>
            <span>${bid}</span>
            <small>${pts}</small>
          </button>
        `;
      }).join('')
    ).join('');

    pickerEl.innerHTML = rows;
  },

  selectContract(key) {
    UI._selectedContract = key;
    const pts = FIVE_HUNDRED_SCORES[key];
    document.querySelectorAll('.contract-btn').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.key === key);
    });
    const valEl = document.getElementById('fh-contract-value');
    if (valEl) {
      valEl.innerHTML = `<strong>${key}</strong> = <span>${pts} points</span>`;
    }
    this.updateFhSubmitBtn();
  },

  selectFhTeam(idx) {
    UI._selectedTeam = idx;
    document.querySelectorAll('.team-select-btn').forEach((btn, i) => {
      btn.classList.toggle('selected', i === idx);
      btn.classList.toggle(`team-${i}`, i === idx);
    });
    this.updateFhSubmitBtn();
  },

  updateFhSubmitBtn() {
    const ok = UI._selectedContract !== null && UI._selectedTeam !== null;
    document.getElementById('fh-btn-success').disabled = !ok;
    document.getElementById('fh-btn-fail').disabled    = !ok;
  },

  async fhApplyResult(success) {
    if (UI._selectedContract === null || UI._selectedTeam === null) return;
    const game   = State.currentGame;
    const result = Games.fiveHundred.applyContract(game, UI._selectedTeam, UI._selectedContract, success);

    await DB.save('games', game);

    const pts = result.delta;
    Utils.toast(
      success ? `✅ +${FIVE_HUNDRED_SCORES[UI._selectedContract]} pts` : `❌ ${result.delta} pts`,
      success ? 'success' : 'error'
    );

    UI._selectedContract = null;
    UI._selectedTeam     = null;
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
  async exportData() {
    const games    = await DB.getAll('games');
    const logs     = await DB.getAll('logs');
    const settings = await DB.getAll('settings');
    const data = {
      version: '1.0.2',
      exportedAt: new Date().toISOString(),
      games,
      logs,
      settings,
    };
    Utils.downloadJSON(data, `scorekeeper-${new Date().toISOString().slice(0,10)}.json`);
    Utils.toast(`Export réussi : ${games.length} partie(s), ${logs.length} entrée(s)`, 'success');
  },

  async exportCurrentGame() {
    if (!State.currentGame) return;
    const game = State.currentGame;
    const allLogs = await DB.getLogs(game.id);
    Utils.downloadJSON({
      version: '1.0.2',
      exportedAt: new Date().toISOString(),
      game,
      logs: allLogs,
    }, `partie-${game.type}-${new Date().toISOString().slice(0,10)}.json`);
    Utils.toast('Partie exportée avec son historique !', 'success');
  },

  async importBackupData(data) {
    let gamesImported = 0;
    let logsImported = 0;
    let settingsImported = 0;

    if (data.game) {
      await DB.save('games', data.game);
      gamesImported = 1;
    }

    if (Array.isArray(data.games)) {
      for (const g of data.games) {
        await DB.save('games', g);
        gamesImported++;
      }
    }

    if (Array.isArray(data.logs)) {
      for (const log of data.logs) {
        await DB.save('logs', log);
        logsImported++;
      }
    }

    if (Array.isArray(data.settings)) {
      for (const setting of data.settings) {
        await DB.save('settings', setting);
        settingsImported++;
      }
    }

    return { gamesImported, logsImported, settingsImported };
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
        const data = JSON.parse(text);

        if (!data.game && !Array.isArray(data.games)) {
          Utils.toast('Fichier invalide : aucune partie trouvée', 'error');
          return;
        }

        const result = await UI.importBackupData(data);
        Utils.toast(
          `Import réussi : ${result.gamesImported} partie(s), ${result.logsImported} entrée(s)`,
          'success'
        );

        if (State.currentScreen === 'central-journal' && typeof Screens.render_central_journal === 'function') {
          await Screens.render_central_journal();
        } else {
          await Screens.render_home();
        }
      } catch (err) {
        console.error(err);
        Utils.toast('Fichier invalide ou import impossible', 'error');
      }
    };
    input.click();
  },

  /* ─── SUPPRESSION COMPLÈTE DU JOURNAL CENTRAL ─── */
  async deleteAllGamesAndHistory() {
    const confirmed1 = confirm(
      'Supprimer tout le journal central ? Toutes les parties actives, archivées et toutes les entrées seront supprimées.'
    );
    if (!confirmed1) return;

    const confirmed2 = confirm(
      'Confirmation finale : cette action est irréversible. Supprimer définitivement toutes les parties et tout l’historique ?'
    );
    if (!confirmed2) return;

    try {
      await DB.clearGamesAndLogs();
      State.currentGame = null;
      Utils.toast('Journal central supprimé complètement', 'success');

      if (typeof Screens.render_central_journal === 'function') {
        Screens.render_central_journal();
      } else {
        Router.go('home');
      }
    } catch (err) {
      console.error(err);
      Utils.toast('Erreur pendant la suppression', 'error');
    }
  },

  /* ─── FIN DE PARTIE ─── */
  async endGame() {
    if (!State.currentGame) return;
    const confirmed = confirm('Terminer la partie ? Elle sera archivée.');
    if (!confirmed) return;

    State.currentGame.status = 'finished';
    State.currentGame.finishedAt = new Date().toISOString();
    await DB.save('games', State.currentGame);
    State.currentGame = null;
    Utils.toast('Partie terminée', 'info');
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
          <div class="game-card-desc">Deux équipes · 1000 pts</div>
        </div>
        <div class="game-card generic" onclick="UI.startNewGame('generic')">
          <span class="game-card-icon">🎮</span>
          <div class="game-card-name">Générique</div>
          <div class="game-card-desc">Tout type de jeu</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Données</div>
        <div class="btn-row">
          <button class="btn btn-secondary btn-sm" onclick="UI.exportData()">📤 Exporter tout</button>
          <button class="btn btn-secondary btn-sm" onclick="UI.importData()">📥 Importer</button>
        </div>
        <div style="height:10px"></div>
        <button class="btn btn-danger btn-sm" onclick="UI.deleteAllGamesAndHistory()">🗑️ Supprimer toutes les parties et l’historique</button>
      </div>

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
        <div class="header-title">🃏 Jeu de 500</div>
        <div class="header-actions">
          <button class="btn-back" onclick="UI.goHistory()" title="Historique">📋</button>
          <button class="btn-back" onclick="UI.exportCurrentGame()" title="Exporter">📤</button>
        </div>
      </div>

      <div class="five-hundred-teams" id="fh-teams"></div>

      <div id="fh-victory" class="victory-banner" style="display:none">
        <div class="victory-trophy">🏆</div>
        <div class="victory-title">Victoire !</div>
        <div class="victory-sub" id="fh-winner-name"></div>
        <div class="victory-sub"><strong id="fh-winner-score"></strong> points</div>
        <div style="height:12px"></div>
        <button class="btn btn-primary btn-sm" onclick="UI.endGame()">Terminer</button>
      </div>

      <div class="contract-picker card">
        <div class="card-title">Sélectionner un contrat</div>

        <!-- Ligne d'en-têtes suits -->
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:4px;text-align:center;font-size:13px;color:var(--text-secondary)">
          <div>♠</div><div>♣</div><div>♦</div><div>♥</div><div>NT</div>
        </div>

        <!-- Grid des contrats (rendu dynamique) -->
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:12px" id="fh-contract-picker"></div>

        <div class="contract-value-display" id="fh-contract-value">
          <span>Sélectionnez un contrat</span>
        </div>

        <div class="card-title" style="margin-top:12px">Équipe qui enchérit</div>
        <div class="team-select-row">
          <button class="team-select-btn" id="fh-team-0" onclick="UI.selectFhTeam(0)">Équipe 1</button>
          <button class="team-select-btn" id="fh-team-1" onclick="UI.selectFhTeam(1)">Équipe 2</button>
        </div>

        <div class="result-btns">
          <button class="btn btn-success" id="fh-btn-success" onclick="UI.fhApplyResult(true)" disabled>✅ Réussi</button>
          <button class="btn btn-danger"  id="fh-btn-fail"    onclick="UI.fhApplyResult(false)" disabled>❌ Chuté</button>
        </div>
      </div>

      <button class="btn btn-secondary btn-sm" onclick="UI.endGame()">Terminer la partie</button>
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

  // Enregistrer le service worker
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./service-worker.js');
      console.log('[App] Service Worker enregistré');
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

  // Rendre l'écran d'accueil
  await Screens.render_home();
}

// Démarrage
document.addEventListener('DOMContentLoaded', init);
