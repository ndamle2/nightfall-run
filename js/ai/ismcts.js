/*
 * Nightfall Run — ISMCTS detectives (JavaScript port of ai/ismcts.py with its default
 * settings: PUCT prior from the heuristic detectives plus the territory term, bandit
 * fugitive model, leaves played 2 rounds by the heuristic players and then scored by the
 * value model, location estimate 'mix', tree kept across decisions ('game' reuse)).
 *
 * The detectives never see the fugitive, so every iteration samples a station from the
 * location estimate and pretends the fugitive is there. All samples share one tree, whose
 * fugitive branches are keyed by what the detectives would see (the ticket, and the
 * station on reveal rounds).
 *
 * The bot keeps its location estimate and tree between calls: use one bot per game.
 */
(function (root, factory) {
  const api = factory(root.AICore || (typeof require === 'function' ? require('./core.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AIISMCTS = api;
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  function newNode() {
    return { n: 0, w: 0, acts: null, prior: null, kids: null, children: null, fug: null };
  }

  /** Detective actions and a softmax prior over the heuristic scores (lower = better); a
   * step onto a candidate counts as 3 points better than the best other move. */
  function heuristicPrior(T, s, temp, terr, h, scratch) {
    const { tos, tks, scores } = C.detScores(T, s, terr, h, scratch);
    const acts = tos.map((v, j) => [v, tks[j]]);
    const sc = scores.slice();
    let otherMin = Infinity;
    for (const x of sc) if (x > -500 && x < otherMin) otherMin = x;
    if (otherMin < Infinity) for (let j = 0; j < sc.length; j++) sc[j] = Math.max(sc[j], otherMin - 3);
    const mn = Math.min(...sc);
    const z = sc.map((x) => Math.exp(-(x - mn) / temp));
    const tot = z.reduce((a, b) => a + b, 0);
    return [acts, z.map((x) => x / tot)];
  }

  const obsKey = (log, moves) => log.slice(log.length - moves).map(([t, p, rev]) => `${t}:${rev ? p : -1}`).join(',');

  class ISMCTSDetectives {
    constructor({
      iterations = 3072, timeLimit = null, batch = 64, c = 0.7, widen = 1.0, cPuct = 1.5, priorTemp = 1.0,
      rolloutRounds = 2, beliefBeta = 2.0, reuse = 'game', priorTerr = 0.3, terrH = 3, seed,
      valueWeights, moveWeights, belief = 'mix',
    } = {}) {
      if (!valueWeights) throw new Error('ISMCTS needs the value-model weights');
      this.iterations = iterations;
      this.timeLimit = timeLimit;
      this.batch = batch;
      this.c = c;
      this.widen = widen;
      this.cPuct = cPuct;
      this.priorTemp = priorTemp;
      this.rolloutRounds = rolloutRounds;
      this.W = C.valueWeights(valueWeights);
      this.reuse = reuse;
      this.priorTerr = priorTerr;
      this.terrH = terrH;
      this.rng = C.makeRng(seed);
      this.belief = belief;
      // move models for the location estimate: the fitted one, and "runs from detectives"
      this.moveWs = null;
      if (belief === 'mix' || belief === 'fitted') {
        if (!moveWeights) throw new Error('belief "mix" needs the move-model weights');
        if (moveWeights.features.join() !== C.MOVE_FEATS.join()) throw new Error('move weights do not match MOVE_FEATS');
        this.moveWs = [Float64Array.from(moveWeights.weights)];
        if (belief === 'mix') {
          const runs = new Float64Array(C.MOVE_FEATS.length);
          runs[C.MOVE_FEATS.indexOf('dg')] = beliefBeta;
          this.moveWs.push(runs);
        }
      }
      this.mem = null;    // [key, entries done, [mass per model], [log posterior]]
      this.carry = null;  // [public state expected next, node] for tree reuse
      this.last = {};
      this.lastPosterior = null;
    }

    // ---------- where is the fugitive? ----------

    /** (N) probability of each station, zero outside the candidates. Updated once per new
     * log entry, facing the detectives as they stand on the first call after it. */
    beliefMass(T, s) {
      const n = T.n;
      const key = `${T.key}:${s.detStart.join(',')}`;
      const cand = C.possibleMask(s);
      if (!this.moveWs) {
        const u = new Float64Array(n).fill(1);
        return C.restrict(u, cand);
      }
      const K = this.moveWs.length;
      if (!this.mem || this.mem[0] !== key || this.mem[1] > s.log.length) {
        const m = new Float64Array(n);
        for (const v of T.starts) m[v] = 1;
        for (const p of s.detStart) m[p] = 0;
        const tot = m.reduce((a, b) => a + b, 0);
        for (let v = 0; v < n; v++) m[v] /= tot;
        this.mem = [key, 0, Array.from({ length: K }, () => m.slice()), new Float64Array(K)];
      }
      let [, done, masses, logpost] = this.mem;
      if (done < s.log.length) {
        const fresh = s.log.slice(done);
        const tk = Array.from(s.fugTk);
        for (const [t] of fresh) tk[t]++;
        const before = [];
        let rnd = s.round - fresh.length;
        for (const [t] of fresh) {
          before.push([tk.slice(), rnd]);
          tk[t]--;
          rnd++;
        }
        masses = masses.slice();
        logpost = logpost.slice();
        this.moveWs.forEach((w, k) => {
          const [m, ev] = C.beliefUpdate(T, masses[k], fresh,
            (j) => C.moveOdds(T, s.detPos, s.detTk, before[j][0], before[j][1], w));
          masses[k] = m;
          logpost[k] += ev;
        });
        const mx = Math.max(...logpost);
        for (let k = 0; k < K; k++) logpost[k] -= mx;
        this.mem = [key, s.log.length, masses, logpost];
      }
      const post = Array.from(logpost, Math.exp);
      const ps = post.reduce((a, b) => a + b, 0);
      for (let k = 0; k < K; k++) post[k] /= ps;
      this.lastPosterior = post;
      const mix = new Float64Array(n);
      for (let k = 0; k < K; k++) for (let v = 0; v < n; v++) mix[v] += post[k] * masses[k][v];
      return C.restrict(mix, cand);
    }

    sampler(T, s) {
      const cands = C.possibleLocations(s);
      if (!cands.length) throw new Error('no candidate stations for the fugitive');
      const mass = this.beliefMass(T, s); // always, so no log entry is skipped
      if (cands.length === 1) return () => cands[0];
      const cum = [];
      let tot = 0;
      for (const v of cands) { tot += mass[v]; cum.push(tot); }
      return () => {
        const x = this.rng() * tot;
        let lo = 0, hi = cum.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (cum[mid] > x) hi = mid; else lo = mid + 1;
        }
        return cands[lo];
      };
    }

    // ---------- search ----------

    fugitiveTurn(T, s, node, picks, scratch) {
      if (!node.fug) node.fug = new Map();
      let fb = node.fug.get(s.fugPos);
      if (!fb) {
        const turns = C.rankedTurns(T, s, scratch);
        fb = { turns, n: new Array(turns.length).fill(0), w: new Array(turns.length).fill(0), total: 0 };
        node.fug.set(s.fugPos, fb);
      }
      const width = Math.min(fb.turns.length, 1 + Math.floor(this.widen * Math.sqrt(fb.total)));
      let pick = -1;
      for (let i = 0; i < width; i++) if (fb.n[i] === 0) { pick = i; break; }
      if (pick < 0) {
        const logN = Math.log(fb.total);
        let bestU = -1;
        for (let i = 0; i < width; i++) {
          const u = fb.w[i] / fb.n[i] + this.c * Math.sqrt(logN / fb.n[i]);
          if (u > bestU) { pick = i; bestU = u; }
        }
      }
      fb.total++;
      fb.n[pick]++; // virtual loss for the fugitive until backed up
      picks.push([fb, pick]);
      return fb.turns[pick];
    }

    select(T, s, root, scratch) {
      let node = root;
      const path = [root];
      const picks = [];
      root.n++; // virtual loss: a visit with no win until backed up
      while (s.phase !== C.OVER) {
        if (s.phase === C.DET) {
          if (!node.acts) {
            [node.acts, node.prior] = heuristicPrior(T, s, this.priorTemp, this.priorTerr, this.terrH, scratch);
            node.kids = new Array(node.acts.length).fill(null);
          }
          const sq = Math.sqrt(node.n);
          const fpu = node.w / node.n; // unvisited moves start at the parent's value
          let pick = 0, bestU = -Infinity;
          for (let i = 0; i < node.kids.length; i++) {
            const kid = node.kids[i];
            const u = kid === null
              ? fpu + this.cPuct * node.prior[i] * sq
              : kid.w / kid.n + this.cPuct * node.prior[i] * sq / (1 + kid.n);
            if (u > bestU) { pick = i; bestU = u; }
          }
          const a = node.acts[pick];
          C.moveDetective(T, s, a[0], a[1]);
          let kid = node.kids[pick];
          if (kid === null) {
            kid = node.kids[pick] = newNode();
            kid.n++;
            path.push(kid);
            return [s, path, picks];
          }
          node = kid;
        } else {
          const turn = this.fugitiveTurn(T, s, node, picks, scratch);
          C.applyTurn(T, s, turn);
          const moves = turn.length - (turn[0] === 'double' ? 1 : 0);
          const key = obsKey(s.log, moves);
          if (!node.children) node.children = new Map();
          let child = node.children.get(key);
          if (!child) { child = newNode(); node.children.set(key, child); }
          node = child;
        }
        node.n++;
        path.push(node);
      }
      return [s, path, picks];
    }

    evaluate(T, s, scratch) {
      if (s.phase === C.OVER) return s.winner === C.DET_WIN ? 1 : 0;
      return C.playoutValue(T, s, this.rolloutRounds, this.W, this.rng, scratch);
    }

    /** The current detective's move [to, ticket] from public state `pub`. */
    chooseMove(T, pub) {
      if (pub.phase !== C.DET) throw new Error('chooseMove expects a detective to move');
      const t0 = Date.now();
      let root = this.reuse !== 'none' ? this.reusedRoot(pub) : null;
      const reused = root ? root.n : 0;
      if (!root) root = newNode();
      const sample = this.sampler(T, pub);
      const scratch = C.makeScratch(T);
      const budget = this.iterations;
      let done = 0;
      while (budget > 0) {
        const leaves = [];
        for (let b = 0; b < this.batch; b++) {
          const s = C.clone(pub);
          s.fugPos = sample();
          leaves.push(this.select(T, s, root, scratch));
        }
        for (const [s, path, picks] of leaves) {
          const w = this.evaluate(T, s, scratch);
          for (const node of path) node.w += w;
          for (const [fb, i] of picks) fb.w[i] += 1 - w;
        }
        done += leaves.length;
        if (this.timeLimit != null) {
          if ((Date.now() - t0) / 1000 >= this.timeLimit) break;
        } else if (done >= budget) break;
        if (root.acts && root.acts.length === 1) break; // only one legal move
      }
      const kids = root.acts ? root.acts.map((a, j) => [a, root.kids[j]]).filter(([, k]) => k) : [];
      if (!kids.length) {
        const saved = this.reuse;
        this.reuse = 'none';
        try { return this.chooseMove(T, pub); } finally { this.reuse = saved; }
      }
      let best = kids[0];
      for (const kv of kids) if (kv[1].n > best[1].n) best = kv;
      if (this.reuse !== 'none') this.remember(T, pub, best);
      this.last = {
        iterations: done, reused, time: (Date.now() - t0) / 1000, value: best[1].w / best[1].n,
        children: kids.map(([a, ch]) => [a, ch.n, Math.round(1000 * ch.w / ch.n) / 1000]).sort((x, y) => y[1] - x[1]),
      };
      return best[0].slice();
    }

    // ---------- tree reuse ----------

    static sig(T, s) {
      return [T.key, s.detStart.join(','), Array.from(s.detPos).join(','), Array.from(s.detTk).join(','),
        s.round, s.log.length, s.current, s.phase].join('|');
    }

    remember(T, pub, best) {
      const [[to, t], node] = best;
      const after = C.clone(pub);
      C.moveDetective(T, after, to, t);
      this.carry = after.phase === C.OVER ? null : [T, after, node];
    }

    reusedRoot(pub) {
      const carry = this.carry;
      this.carry = null;
      if (!carry) return null;
      const [T, after, node] = carry;
      if (after.phase === C.DET) return ISMCTSDetectives.sig(T, after) === ISMCTSDetectives.sig(T, pub) ? node : null;
      if (this.reuse !== 'game') return null;
      // the round ended in the tree: follow the fugitive's observed turn
      const moves = pub.log.length - after.log.length;
      const same = (a, b) => a.length === b.length && a.every((x, j) => x === b[j]);
      if (moves !== 1 && moves !== 2) return null;
      for (let j = 0; j < after.log.length; j++) {
        const x = pub.log[j], y = after.log[j];
        if (x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2] || x[3] !== y[3]) return null;
      }
      if (!same(Array.from(pub.detPos), Array.from(after.detPos)) || !same(Array.from(pub.detTk), Array.from(after.detTk))) return null;
      return (node.children && node.children.get(obsKey(pub.log, moves))) || null;
    }
  }

  return { ISMCTSDetectives, heuristicPrior };
});
