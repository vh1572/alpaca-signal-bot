export function ema(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function sma(values, period) {
  const out = [];
  for (let i = period - 1; i < values.length; i++) {
    const slice = values.slice(i - period + 1, i + 1);
    out.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return out;
}

export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return [];
  const out = [];
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  out.push(100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out.push(100 - 100 / (1 + rs));
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = expandEma(closes, fast);
  const emaSlow = expandEma(closes, slow);
  const macdLine = closes.map((_, i) => {
    if (emaFast[i] == null || emaSlow[i] == null) return null;
    return emaFast[i] - emaSlow[i];
  });
  const macdValues = macdLine.filter((v) => v != null);
  const signalEma = expandEmaFromSparse(macdLine, signal);
  const histogram = macdLine.map((m, i) =>
    m != null && signalEma[i] != null ? m - signalEma[i] : null,
  );
  return { macdLine, signalLine: signalEma, histogram };
}

function expandEma(closes, period) {
  const series = ema(closes, period);
  const pad = closes.length - series.length;
  return [...Array(pad).fill(null), ...series];
}

function expandEmaFromSparse(sparse, period) {
  const values = sparse.filter((v) => v != null);
  const sig = ema(values, period);
  const pad = sparse.length - sig.length;
  return [...Array(pad).fill(null), ...sig];
}

export function bollinger(closes, period = 20, stdDevMult = 2) {
  const middle = [];
  const upper = [];
  const lower = [];
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    middle.push(mean);
    upper.push(mean + stdDevMult * std);
    lower.push(mean - stdDevMult * std);
  }
  const pad = closes.length - middle.length;
  return {
    middle: [...Array(pad).fill(null), ...middle],
    upper: [...Array(pad).fill(null), ...upper],
    lower: [...Array(pad).fill(null), ...lower],
  };
}
