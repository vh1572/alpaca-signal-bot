import { strategies, formatStrategy } from '../strategies/index.js';
import { wrapError } from '../alpaca/errors.js';

function barCloses(bars) {
  return bars.map((b) => b.c);
}

function barHighs(bars) {
  return bars.map((b) => b.h);
}

function barLows(bars) {
  return bars.map((b) => b.l);
}

function sessionDateEt(barTime) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(barTime));
}

export function sharesForNotional(price, minNotional) {
  if (!price || price <= 0) return 1;
  return Math.max(1, Math.floor(minNotional / price));
}

export function trailDollarRange(trailMin, trailMax) {
  const lo = Math.min(trailMin, trailMax);
  const hi = Math.max(trailMin, trailMax);
  const out = [];
  for (let t = lo; t <= hi; t++) out.push(t);
  return out;
}

export function notionalDisplayAmount(config) {
  return config.minNotional > 0 ? config.minNotional : 500;
}

/**
 * Simulate long-only: one position at a time, trailing stop, flatten at EOD.
 * Uses dollar trail when trailDollars is set; otherwise percent trail.
 * Always tracks pnlOneShare (1 share) and pnlNotional ($500 or --min-notional).
 */
function simulateStrategy(
  bars,
  strategy,
  { minNotional, qty, trailDollars, trailPercent, eodCloseMin, displayNotional = 500 },
) {
  const closes = barCloses(bars);
  const highs = barHighs(bars);
  const lows = barLows(bars);
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

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    const price = bar.c;
    const barEt = new Date(bar.t);
    const et = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).format(barEt);
    const [h, m] = et.split(':').map(Number);
    const mins = h * 60 + m;
    const eodFlatten = mins >= 16 * 60 - eodCloseMin;

    if (position) {
      position.highWater = Math.max(position.highWater, bar.h);
      const stop = useDollarTrail
        ? position.highWater - trailDollars
        : position.highWater * trailFactor;
      const stopped = bar.l <= stop;
      if (stopped || eodFlatten) {
        const exitPrice = stopped ? stop : price;
        recordExit(exitPrice, position.entry);
        position = null;
      }
    }

    if (!position && !eodFlatten && strategy.detect(closes, highs, lows, i, strategy.params)) {
      position = {
        entry: price,
        highWater: price,
        day: sessionDateEt(bar.t),
      };
    }
  }

  if (position) {
    const last = bars[bars.length - 1].c;
    recordExit(last, position.entry);
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
    throw new Error(`Insufficient historical bars (${bars.length}). Need a funded data plan or different symbol.`);
  }

  console.log(`Loaded ${bars.length} bars (${bars[0].t} → ${bars[bars.length - 1].t})\n`);

  const useNotional = config.minNotional > 0;
  const results = [];

  if (useNotional) {
    const trails = trailDollarRange(config.trailMin, config.trailMax);
    console.log(
      `Backtesting ${strategies.length} strategies × ${trails.length} trail distances ($${trails[0]}–$${trails.at(-1)}) @ min $${config.minNotional} notional...\n`,
    );
    for (const strategy of strategies) {
      for (const trailDollars of trails) {
        const result = simulateStrategy(bars, strategy, {
          minNotional: config.minNotional,
          trailDollars,
          eodCloseMin: config.eodCloseMin,
          displayNotional: config.minNotional,
        });
        results.push({ strategy, trailDollars, ...result });
      }
    }
  } else {
    for (const strategy of strategies) {
      const result = simulateStrategy(bars, strategy, {
        qty: config.qty,
        trailPercent: config.trailPercent,
        eodCloseMin: config.eodCloseMin,
        displayNotional: config.minNotional > 0 ? config.minNotional : 500,
      });
      results.push({ strategy, trailDollars: null, ...result });
    }
  }

  results.sort((a, b) =>
    config.minNotional > 0 ? b.pnlNotional - a.pnlNotional : b.pnl - a.pnl,
  );
  return { results, best: results[0] };
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

export function printBacktestResults(results, best, config) {
  const useNotional = config.minNotional > 0;
  console.log('── Backtest results (top 10) ──');
  for (const r of results.slice(0, 10)) {
    const marker = r === best ? ' ★' : '';
    const trailLabel = useNotional ? ` trail $${r.trailDollars}` : ` trail ${config.trailPercent}%`;
    console.log(
      `${formatStrategy(r.strategy)}${trailLabel}${marker}\n` +
        `  ${formatPnlLine(r, config)}`,
    );
  }
  if (results.length > 10) {
    console.log(`  … and ${results.length - 10} more combinations`);
  }
  console.log('\n── Selected for live trading ──');
  console.log(formatStrategy(best.strategy));
  if (useNotional) {
    console.log(`Min notional: $${config.minNotional}`);
    console.log(`Trailing stop:  $${best.trailDollars} (from backtest range $${config.trailMin}–$${config.trailMax})`);
  } else {
    console.log(`Qty per entry:  ${config.qty} shares`);
    console.log(`Trailing stop:  ${config.trailPercent}%`);
  }
  console.log(formatFinalBacktestPnl(best, config));
  console.log('');
}
