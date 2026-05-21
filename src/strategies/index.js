import { ema, rsi, macd, bollinger } from '../indicators/index.js';

/**
 * Each strategy exposes:
 * - id, name, description
 * - params: { key: default } for display/tuning
 * - detect(closes, highs, lows, index): boolean — bullish direction-change at bar index
 */
export const strategies = [
  {
    id: 'ema_crossover',
    name: 'EMA Crossover',
    description: 'Buy when fast EMA crosses above slow EMA (trend turning up).',
    params: { fastPeriod: 9, slowPeriod: 21 },
    detect(closes, _h, _l, i, p) {
      const slice = closes.slice(0, i + 1);
      const fast = ema(slice, p.fastPeriod);
      const slow = ema(slice, p.slowPeriod);
      if (fast.length < 2 || slow.length < 2) return false;
      const f0 = fast[fast.length - 2];
      const f1 = fast[fast.length - 1];
      const s0 = slow[slow.length - 2];
      const s1 = slow[slow.length - 1];
      return f0 <= s0 && f1 > s1;
    },
  },
  {
    id: 'rsi_reversal',
    name: 'RSI Reversal',
    description: 'Buy when RSI crosses above threshold after being oversold.',
    params: { period: 14, oversold: 30, crossAbove: 50 },
    detect(closes, _h, _l, i, p) {
      const series = rsi(closes.slice(0, i + 1), p.period);
      if (series.length < 2) return false;
      const prev = series[series.length - 2];
      const curr = series[series.length - 1];
      return prev < p.oversold && prev < p.crossAbove && curr >= p.crossAbove;
    },
  },
  {
    id: 'macd_crossover',
    name: 'MACD Signal Cross',
    description: 'Buy when MACD line crosses above signal line.',
    params: { fast: 12, slow: 26, signal: 9 },
    detect(closes, _h, _l, i, p) {
      const { macdLine, signalLine } = macd(closes.slice(0, i + 1), p.fast, p.slow, p.signal);
      let prevM = null;
      let prevS = null;
      let currM = null;
      let currS = null;
      for (let j = macdLine.length - 2; j < macdLine.length; j++) {
        if (macdLine[j] != null && signalLine[j] != null) {
          if (j === macdLine.length - 2) {
            prevM = macdLine[j];
            prevS = signalLine[j];
          } else {
            currM = macdLine[j];
            currS = signalLine[j];
          }
        }
      }
      if (prevM == null || currM == null) return false;
      return prevM <= prevS && currM > currS;
    },
  },
  {
    id: 'momentum_breakout',
    name: 'Momentum Breakout',
    description: 'Buy when price rises more than threshold % over lookback bars.',
    params: { lookback: 8, thresholdPct: 0.75 },
    detect(closes, _h, _l, i, p) {
      if (i < p.lookback) return false;
      const prev = closes[i - p.lookback];
      const curr = closes[i];
      const changePct = ((curr - prev) / prev) * 100;
      const priorChange = i > p.lookback + 1
        ? ((closes[i - 1] - closes[i - p.lookback - 1]) / closes[i - p.lookback - 1]) * 100
        : 0;
      return changePct >= p.thresholdPct && priorChange < p.thresholdPct;
    },
  },
  {
    id: 'bollinger_bounce',
    name: 'Bollinger Bounce',
    description: 'Buy when price was at/below lower band and closes back above middle band.',
    params: { period: 20, stdDev: 2 },
    detect(closes, _h, _l, i, p) {
      const slice = closes.slice(0, i + 1);
      const { middle, lower } = bollinger(slice, p.period, p.stdDev);
      if (i < 1 || middle[i] == null) return false;
      const touchedLower = closes[i - 1] <= lower[i - 1];
      const crossedMid = closes[i - 1] < middle[i - 1] && closes[i] >= middle[i];
      return touchedLower && crossedMid;
    },
  },
];

export function getStrategy(id) {
  return strategies.find((s) => s.id === id);
}

export function formatStrategy(strategy) {
  const params = Object.entries(strategy.params)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return `${strategy.name} (${strategy.id}) [${params}]`;
}
