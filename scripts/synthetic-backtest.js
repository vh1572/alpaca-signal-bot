#!/usr/bin/env node
/** Offline smoke test — no API keys required */
import { strategies } from '../src/strategies/index.js';

function makeBars(n, start = 100) {
  const bars = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 7) * 0.6 + (i % 20 < 10 ? 0.15 : -0.05);
    price = Math.max(1, price + drift);
    const t = new Date('2024-06-03T14:00:00Z');
    t.setMinutes(t.getMinutes() + i * 15);
    bars.push({
      t: t.toISOString(),
      o: price - 0.1,
      h: price + 0.2,
      l: price - 0.2,
      c: price,
      v: 1000,
    });
  }
  return bars;
}

// Inline minimal simulate (same rules as engine)
function simulate(bars, strategy, qty = 1, trailPercent = 2, eodCloseMin = 15) {
  const closes = bars.map((b) => b.c);
  const highs = bars.map((b) => b.h);
  const lows = bars.map((b) => b.l);
  let cash = 0;
  let position = null;
  const trailFactor = 1 - trailPercent / 100;
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    const price = bar.c;
    const et = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).format(new Date(bar.t));
    const [h, m] = et.split(':').map(Number);
    const eodFlatten = h * 60 + m >= 16 * 60 - eodCloseMin;
    if (position) {
      position.highWater = Math.max(position.highWater, bar.h);
      const stop = position.highWater * trailFactor;
      if (bar.l <= stop || eodFlatten) {
        cash += ((bar.l <= stop ? stop : price) - position.entry) * qty;
        position = null;
      }
    }
    if (!position && !eodFlatten && strategy.detect(closes, highs, lows, i, strategy.params)) {
      position = { entry: price, highWater: price };
    }
  }
  if (position) cash += (bars.at(-1).c - position.entry) * qty;
  return cash;
}

const bars = makeBars(400);
const results = strategies.map((s) => ({
  id: s.id,
  pnl: simulate(bars, s),
}));
results.sort((a, b) => b.pnl - a.pnl);
console.log('Synthetic backtest (offline):');
for (const r of results) console.log(`  ${r.id}: $${r.pnl.toFixed(2)}`);
console.log(`Winner: ${results[0].id}`);
