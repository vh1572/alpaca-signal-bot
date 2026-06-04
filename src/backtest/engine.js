import { strategies, formatStrategy } from '../strategies/index.js';
import { wrapError } from '../alpaca/errors.js';

const NY = 'America/New_York';
const eodFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: NY,
  hour: 'numeric',
  minute: 'numeric',
  hour12: false,
});

export function sharesForNotional(price, minNotional) {
  if (!price || price <= 0) return 1;
  return Math.max(1, Math.floor(minNotional / price));
}

export function trailDollarRange(trailMin, trailMax, step = 1) {
  const lo = Math.min(trailMin, trailMax);
  const hi = Math.max(trailMin, trailMax);
  const s = Math.max(1, step);
  const out = [];
  for (let t = lo; t <= hi; t += s) out.push(t);
  return out;
}

export function notionalDisplayAmount(config) {
  return config.minNotional > 0 ? config.minNotional : 500;
}

/** Build shared OHLC + session flags once per backtest. */
function buildBarContext(bars, eodCloseMin) {
  const closes = barCloses(bars);
  const highs = barHighs(bars);
  const lows = barLows(bars);
  const eodFlatten = bars.map((bar) => {
    const et = eodFmt.format(new Date(bar.t));
    const [h, m] = et.split(':').map(Number);
    return h * 60 + m >= 16 * 60 - eodCloseMin;
  });
  return { closes, highs, lows, eodFlatten };
}

function barCloses(bars) {
  const out = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) out[i] = bars[i].c;
  return out;
}

function barHighs(bars) {
  const out = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) out[i] = bars[i].h;
  return out;
}

function barLows(bars) {
  const out = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) out[i] = bars[i].l;
  return out;
}

/** Run detect once per bar — reused for all trail values of this strategy. */
function buildEntrySignals(strategy, closes, highs, lows) {
  const signals = new Array(closes.length);
  signals[0] = false;
  for (let i = 1; i < closes.length; i++) {
    signals[i] = strategy.detect(closes, highs, lows, i, strategy.params);
  }
  return signals;
}

/**
 * Simulate with precomputed signals (no per-bar detect).
 */
function simulateWithSignals(
  ctx,
  signals,
  { minNotional, qty, trailDollars, trailPercent, displayNotional = 500 },
) {
  const { closes, highs, lows, eodFlatten } = ctx;
  let cash = 0;
  let cashOneShare = 0;
  let cashNotional = 0;
  let position = null;
  let trades = 0;
  let wins = 0;

  const useDollarTrail = trailDollars != null && trailDollars > 0;
  const trailFactor = 1 - (trailPercent ?? 2) / 100;
  const notionalSize = minNotional > 0 ? minNotional : displayNotional;

  function recordExit(exitPrice, entryPrice) {
    const perShare = exitPrice - entryPrice;
    const sizedQty =
      minNotional > 0 ? sharesForNotional(entryPrice, minNotional) : qty;
    const notionalQty = sharesForNotional(entryPrice, notionalSize);
    const tradePnl = perShare * sizedQty;
    cash += tradePnl;
    cashOneShare += perShare;
    cashNotional += perShare * notionalQty;
    if (tradePnl > 0) wins++;
    trades++;
  }

  for (let i = 1; i < closes.length; i++) {
    const price = closes[i];
    const barHigh = highs[i];
    const barLow = lows[i];

    if (position) {
      position.highWater = Math.max(position.highWater, barHigh);
      const stop = useDollarTrail
        ? position.highWater - trailDollars
        : position.highWater * trailFactor;
      const stopped = barLow <= stop;
      if (stopped || eodFlatten[i]) {
        const exitPrice = stopped ? stop : price;
        recordExit(exitPrice, position.entry);
        position = null;
      }
    }

    if (!position && !eodFlatten[i] && signals[i]) {
      position = { entry: price, highWater: barHigh };
    }
  }

  if (position) {
    recordExit(closes[closes.length - 1], position.entry);
  }

  return {
    pnl: cash,
    pnlOneShare: cashOneShare,
    pnlNotional: cashNotional,
    notionalLabel: notionalSize,
    trades,
    wins,
    winRate: trades ? wins / trades : 0,
  };
}

function comparePnl(a, b, useNotional) {
  return useNotional ? b.pnlNotional - a.pnlNotional : b.pnl - a.pnl;
}

function pickBest(list, useNotional) {
  let best = list[0];
  for (let i = 1; i < list.length; i++) {
    if (comparePnl(list[i], best, useNotional) > 0) best = list[i];
  }
  return best;
}

/** Pick best strategy (mid-trail), then sweep $ trail on winner — qty or notional sizing. */
function runTwoPhaseTrailBacktest(ctx, config, sizing) {
  const useNotional = config.minNotional > 0;
  const trailStep = config.trailStep ?? 1;
  const trails = trailDollarRange(config.trailMin, config.trailMax, trailStep);
  const midTrail = trails[Math.floor(trails.length / 2)];
  const sizeLabel = useNotional
    ? `$${config.minNotional} notional`
    : `${config.qty} share(s)`;

  console.log(
    `Backtest: ${strategies.length} strategies, then trail $${trails[0]}–$${trails.at(-1)}` +
      (trailStep > 1 ? ` (step ${trailStep})` : '') +
      ` on winner @ ${sizeLabel}...\n`,
  );

  const simBase = {
    ...sizing,
    displayNotional: notionalDisplayAmount(config),
  };

  const strategyScores = [];
  for (const strategy of strategies) {
    const signals = buildEntrySignals(strategy, ctx.closes, ctx.highs, ctx.lows);
    const result = simulateWithSignals(ctx, signals, {
      ...simBase,
      trailDollars: midTrail,
    });
    strategyScores.push({ strategy, trailDollars: midTrail, signals, ...result });
  }

  const bestStrategyRow = pickBest(strategyScores, useNotional);
  const allResults = [];

  for (const trailDollars of trails) {
    const result = simulateWithSignals(ctx, bestStrategyRow.signals, {
      ...simBase,
      trailDollars,
    });
    allResults.push({
      strategy: bestStrategyRow.strategy,
      trailDollars,
      ...result,
    });
  }

  for (const row of strategyScores) {
    if (row.strategy.id !== bestStrategyRow.strategy.id) {
      allResults.push({
        strategy: row.strategy,
        trailDollars: midTrail,
        pnl: row.pnl,
        pnlOneShare: row.pnlOneShare,
        pnlNotional: row.pnlNotional,
        trades: row.trades,
        wins: row.wins,
        winRate: row.winRate,
      });
    }
  }

  return allResults;
}

export async function runBacktests(client, symbol, config) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - Math.ceil(config.backtestDays * 1.5));

  console.log(`\nFetching ${config.backtestDays}d of 15Min bars for ${symbol}...`);
  let bars;
  try {
    bars = await client.getBars(symbol, {
      start: start.toISOString(),
      end: end.toISOString(),
      timeframe: '15Min',
    });
  } catch (err) {
    throw wrapError(err, `fetching historical bars for ${symbol}`);
  }

  if (bars.length < 50) {
    throw new Error(
      `Insufficient historical bars (${bars.length}). Need a funded data plan or different symbol.`,
    );
  }

  console.log(`Loaded ${bars.length} bars (${bars[0].t} → ${bars[bars.length - 1].t})\n`);

  const ctx = buildBarContext(bars, config.eodCloseMin);
  bars = null; // allow GC of raw bar objects before heavy sim loop

  const useNotional = config.minNotional > 0;
  const sizing = useNotional
    ? { minNotional: config.minNotional }
    : { qty: config.qty };
  const allResults = runTwoPhaseTrailBacktest(ctx, config, sizing);

  allResults.sort((a, b) => comparePnl(a, b, useNotional));
  const best = allResults[0];
  const topResults = allResults.slice(0, 10);

  return { best, topResults };
}

export function formatPnlLine(r, config) {
  const n = notionalDisplayAmount(config);
  return (
    `1 share: $${r.pnlOneShare.toFixed(2)} | $${n} notional: $${r.pnlNotional.toFixed(2)}` +
    ` | trades: ${r.trades} | win rate: ${(r.winRate * 100).toFixed(1)}%`
  );
}

export function formatFinalBacktestPnl(r, config) {
  const n = notionalDisplayAmount(config);
  return [
    'Backtest P/L:',
    `  1 share:       $${r.pnlOneShare.toFixed(2)}`,
    `  $${n} notional: $${r.pnlNotional.toFixed(2)}`,
    `  (${r.trades} trades, ${(r.winRate * 100).toFixed(1)}% wins)`,
  ].join('\n');
}

function trailResultLabel(r, config) {
  return r.trailDollars != null
    ? ` trail $${r.trailDollars}`
    : ` trail ${config.trailPercent}%`;
}

export function printBacktestResults(topResults, best, config) {
  const useNotional = config.minNotional > 0;
  console.log('── Backtest results (top 10) ──');
  for (const r of topResults) {
    const marker = r === best ? ' ★' : '';
    const trailLabel = trailResultLabel(r, config);
    console.log(
      `${formatStrategy(r.strategy)}${trailLabel}${marker}\n` +
        `  ${formatPnlLine(r, config)}`,
    );
  }
  console.log('\n── Selected for live trading ──');
  console.log(formatStrategy(best.strategy));
  if (useNotional) {
    console.log(`Min notional: $${config.minNotional}`);
  } else {
    console.log(`Qty per entry:  ${config.qty} shares`);
  }
  if (best.trailDollars != null) {
    console.log(
      `Trailing stop:  $${best.trailDollars} (from backtest range $${config.trailMin}–$${config.trailMax})`,
    );
  } else {
    console.log(`Trailing stop:  ${config.trailPercent}%`);
  }
  console.log(formatFinalBacktestPnl(best, config));
  console.log('');
}
