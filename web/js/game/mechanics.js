// Sector mechanics and their counters. Each counter can only move when a
// distinct entity resolves (a gem collected, a beacon scanned, a critter
// calmed...), and each entity resolves at most once, so the counters stay
// within scoring.js's sectorCaps by construction. The clamps below are a
// second fence, not the mechanism.

import { sectorCaps, COUNTERS } from '../scoring.js';

export class Mechanics {
  constructor(sector) {
    this.sector = sector;
    this.caps = sectorCaps(sector);
    for (const k of COUNTERS) this[k] = 0;
    this.chainLast = null; // 'human' | 'si'
    this.chainRun = 0; // current alternating run length, for display
    this.podsTaken = 0;
  }

  bump(k) {
    if (this[k] < this.caps[k]) {
      this[k]++;
      return true;
    }
    console.error(`[nova] ${k} would exceed its cap of ${this.caps[k]}; ignored`);
    return false;
  }

  core() { return this.bump('cores'); }
  scan() { return this.bump('scans'); }
  assist() { return this.bump('assists'); }
  harmonize() { return this.bump('harmonized'); }
  review() { return this.bump('reviews'); }
  shortcut() { return this.bump('shortcuts'); }

  /**
   * Oversight chain: alternating SI and human pods extend it; the same kind
   * twice is an unchecked step and breaks it. Returns 'link', 'start' or 'break'.
   */
  pod(kind) {
    this.podsTaken++;
    if (this.chainLast && this.chainLast !== kind) {
      this.bump('chainLinks');
      this.chainLast = kind;
      this.chainRun++;
      return 'link';
    }
    const broke = this.chainLast === kind;
    this.chainLast = kind;
    this.chainRun = 1;
    return broke ? 'break' : 'start';
  }

  /** The value the HUD shows for this sector's mechanic, and its maximum. */
  hudCounter() {
    switch (this.sector.mechanic) {
      case 'scan': return { label: 'Scans', value: this.scans, max: this.caps.scans };
      case 'integrity': return { label: 'Shortcuts', value: this.shortcuts, max: this.caps.shortcuts };
      case 'harmonize': return { label: 'Calmed', value: this.harmonized, max: this.caps.harmonized };
      case 'chain': return { label: 'Chain', value: this.chainLinks, max: this.caps.chainLinks };
      case 'assist': return { label: 'Assists', value: this.assists, max: this.caps.assists };
      case 'review': return { label: 'Reviews', value: this.reviews, max: this.caps.reviews };
      default: return null;
    }
  }

  /** Mechanic items done and possible, for the personal completion record. */
  mechanicProgress() {
    switch (this.sector.mechanic) {
      case 'scan': return [this.scans, this.caps.scans];
      // Integrity is about the shortcuts you leave alone.
      case 'integrity': return [this.caps.shortcuts - this.shortcuts, this.caps.shortcuts];
      case 'harmonize': return [this.harmonized, this.caps.harmonized];
      case 'chain': return [this.chainLinks, this.caps.chainLinks];
      case 'assist': return [this.assists, this.caps.assists];
      case 'review': return [this.reviews, this.caps.reviews];
      default: return [0, 0];
    }
  }

  /** An exact SectorResult as scoring.js defines it. */
  result({ cleared, verdicts, timeMs }) {
    return {
      id: this.sector.id,
      cleared,
      cores: this.cores,
      chainLinks: this.chainLinks,
      assists: this.assists,
      harmonized: this.harmonized,
      scans: this.scans,
      reviews: this.reviews,
      shortcuts: this.shortcuts,
      verdicts: cleared ? verdicts.slice() : this.sector.gate.map(() => -1),
      timeMs: Math.max(0, Math.round(timeMs)),
    };
  }
}
