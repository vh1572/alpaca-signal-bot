import { strategies, formatStrategy } from '../strategies/index.js';

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

/**
 * Simulate long-only: one position at a time, trailing stop, flatten at EOD.
 */
function simulateStrategy(bars, strategy, { qty, trailPercent, eodCloseMin }) {
  const closes = barCloses(bars);
  const highs = barHighs(bars);
  const lows = barLows(bars);
  let cash = 0;
  let position = null;
  let trades = 0;
  let wins = 0;

  const trailFactor = 1 - trailPercent / 100;

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
      const stop = position.highWater * trailFactor;
      const stopped = bar.l <= stop;
      if (stopped || eodFlatten) {
        const exitPrice = stopped ? stop : price;
        const pnl = (exitPrice - position.entry) * qty;
        cash += pnl;
        if (pnl > 0) wins++;
        trades++;
        position = null;
      }
    }

    if (!position && !eodFlatten && strategy.detect(closes, highs, lows, i, strategy.params)) {
      position = { entry: price, highWater: price, day: sessionDateEt(bar.t) };
    }
  }

  if (position) {
    const last = bars[bars.length - 1].c;
    const pnl = (last - position.entry) * qty;
    cash += pnl;
    if (pnl > 0) wins++;
    trades++;
  }

  return { pnl: cash, trades, wins, winRate: trades ? wins / trades : 0 };
}

export async function runBacktests(client, symbol, config) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - Math.ceil(config.backtestDays * 1.5));

  console.log(`\nFetching ${config.backtestDays}d of 15Min bars for ${symbol}...`);
  const bars = await client.getBars(symbol, {
    start: start.toISOString(),
    end: end.toISOString(),
    timeframe: '15Min',
  });

  if (bars.length < 50) {
    throw new Error(`Insufficient historical bars (${bars.length}). Need a funded data plan or different symbol.`);
  }

  console.log(`Loaded ${bars.length} bars (${bars[0].t} → ${bars[bars.length - 1].t})\n`);

  const results = strategies.map((strategy) => {
    const result = simulateStrategy(bars, strategy, config);
    return { strategy, ...result };
  });

  results.sort((a, b) => b.pnl - a.pnl);
  return { bars, results, best: results[0] };
}

export function printBacktestResults(results, best) {
  console.log('── Backtest results (all strategies) ──');
  for (const r of results) {
    const marker = r.strategy.id === best.strategy.id ? ' ★' : '';
    console.log(
      `${formatStrategy(r.strategy)}${marker}\n` +
        `  P/L: $${r.pnl.toFixed(2)} | trades: ${r.trades} | win rate: ${(r.winRate * 100).toFixed(1)}%`,
    );
  }
  console.log('\n── Selected for live trading ──');
  console.log(formatStrategy(best.strategy));
  console.log(`Backtest P/L: $${best.pnl.toFixed(2)} (${best.trades} trades, ${(best.winRate * 100).toFixed(1)}% wins)\n`);
}
