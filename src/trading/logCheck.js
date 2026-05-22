import { ema, rsi, macd, bollinger } from '../indicators/index.js';

export function summarizeBars(bars) {
  if (!bars?.length) return { last: null, prev: null };
  const last = bars[bars.length - 1];
  const prev = bars.length > 1 ? bars[bars.length - 2] : null;
  return { last, prev };
}

export function priceChangePct(last, prev) {
  if (!last || !prev) return null;
  return ((last.c - prev.c) / prev.c) * 100;
}

export function formatBarPrice(bar) {
  if (!bar) return 'n/a';
  return `$${Number(bar.c).toFixed(2)} (O ${Number(bar.o).toFixed(2)} H ${Number(bar.h).toFixed(2)} L ${Number(bar.l).toFixed(2)})`;
}

export function formatPosition(pos) {
  if (!pos || Number(pos.qty) <= 0) return 'none';
  const qty = Number(pos.qty);
  const entry = Number(pos.avg_entry_price);
  const current = Number(pos.current_price);
  const upl = Number(pos.unrealized_pl);
  const uplPct = Number(pos.unrealized_plpc) * 100;
  return (
    `${qty} @ $${entry.toFixed(2)} | mkt $${current.toFixed(2)} | ` +
    `uP/L $${upl.toFixed(2)} (${uplPct.toFixed(2)}%)`
  );
}

/** Strategy-specific snapshot for the check log */
export function strategySnapshot(strategy, closes) {
  const p = strategy.params;
  const i = closes.length - 1;
  if (i < 2) return '';

  switch (strategy.id) {
    case 'ema_crossover': {
      const fast = ema(closes, p.fastPeriod);
      const slow = ema(closes, p.slowPeriod);
      if (!fast.length || !slow.length) return '';
      return `fastEMA=${fast.at(-1).toFixed(2)} slowEMA=${slow.at(-1).toFixed(2)}`;
    }
    case 'rsi_reversal': {
      const series = rsi(closes, p.period);
      if (!series.length) return '';
      return `RSI=${series.at(-1).toFixed(1)} (oversold<${p.oversold}, cross>${p.crossAbove})`;
    }
    case 'macd_crossover': {
      const { macdLine, signalLine } = macd(closes, p.fast, p.slow, p.signal);
      const m = macdLine.filter((v) => v != null).at(-1);
      const s = signalLine.filter((v) => v != null).at(-1);
      if (m == null || s == null) return '';
      return `MACD=${m.toFixed(3)} signal=${s.toFixed(3)}`;
    }
    case 'momentum_breakout': {
      if (i < p.lookback) return '';
      const chg = ((closes[i] - closes[i - p.lookback]) / closes[i - p.lookback]) * 100;
      return `${p.lookback}-bar change=${chg.toFixed(2)}% (need ≥${p.thresholdPct}%)`;
    }
    case 'bollinger_bounce': {
      const { middle, lower } = bollinger(closes, p.period, p.stdDev);
      if (middle[i] == null) return '';
      return `close=${closes[i].toFixed(2)} mid=${middle[i].toFixed(2)} lower=${lower[i].toFixed(2)}`;
    }
    default:
      return '';
  }
}

export function logCheckDetails(log, { symbol, strategy, bars, signal, position, clock }) {
  const { last, prev } = summarizeBars(bars);
  const chg = priceChangePct(last, prev);
  const chgStr = chg == null ? '' : ` | Δ ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
  const barTime = last?.t ? new Date(last.t).toISOString() : 'n/a';
  const vol = last?.v != null ? ` vol=${Number(last.v).toLocaleString()}` : '';
  const closes = bars.map((b) => b.c);
  const snap = strategySnapshot(strategy, closes);

  log('── check ──');
  log(`${symbol} | bar ${barTime}`);
  log(`  price: ${formatBarPrice(last)}${chgStr}${vol}`);
  if (snap) log(`  ${strategy.id}: ${snap}`);
  log(`  signal: ${signal ? 'BUY' : 'hold'} | position: ${formatPosition(position)}`);
  if (clock) {
    log(
      `  market: ${clock.is_open ? 'OPEN' : 'CLOSED'} | next_close ${clock.next_close} | next_open ${clock.next_open}`,
    );
  }
}
