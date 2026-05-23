import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

function loadEnvFile() {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

function parseArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

function parseFlag(name) {
  return process.argv.includes(name);
}

function parseNumber(name, fallback) {
  const raw = parseArg(name, String(fallback));
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function parseConfig() {
  if (parseFlag('--help') || parseFlag('-h')) {
    printUsage();
    process.exit(0);
  }

  const cliArgs = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const symbol = (
    cliArgs.find((a) => !/\.(js|mjs|cjs)$/i.test(a)) ||
    parseArg('--symbol', '')
  ).toUpperCase();

  if (!symbol) {
    printUsage();
    process.exit(1);
  }

  const live = parseFlag('--live');
  const paper = parseFlag('--paper') || !live;

  const apiBase =
    process.env.APCA_API_BASE_URL ||
    (paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets');

  const dataBase = process.env.APCA_DATA_BASE_URL || 'https://data.alpaca.markets';

  const keyId = process.env.APCA_API_KEY_ID;
  const secretKey = process.env.APCA_API_SECRET_KEY;

  if (!keyId || !secretKey) {
    console.error('Missing APCA_API_KEY_ID or APCA_API_SECRET_KEY. Copy .env.example to .env');
    process.exit(1);
  }

  const envNum = (key, fallback) => {
    const v = Number(process.env[key]);
    return Number.isFinite(v) ? v : fallback;
  };

  return {
    symbol,
    qty: parseNumber('--qty', 1),
    intervalMin: parseNumber('--interval-min', 15),
    trailPercent: parseNumber('--trail-percent', 2),
    backtestDays: parseNumber('--backtest-days', 60),
    eodCloseMin: parseNumber('--eod-close-min', 15),
    clockRetryBaseSec: parseNumber('--clock-retry-base-sec', envNum('APCA_CLOCK_RETRY_BASE_SEC', 60)),
    clockRetryMaxSec: parseNumber('--clock-retry-max-sec', envNum('APCA_CLOCK_RETRY_MAX_SEC', 600)),
    closedWakeBeforeMin: parseNumber('--closed-wake-before-min', envNum('APCA_CLOSED_WAKE_BEFORE_MIN', 2)),
    closedJitterSec: parseNumber('--closed-jitter-sec', envNum('APCA_CLOSED_JITTER_SEC', 180)),
    dryRun: parseFlag('--dry-run'),
    paper,
    apiBase,
    dataBase,
    keyId,
    secretKey,
  };
}

function printUsage() {
  console.error(`
Usage: node src/index.js SYMBOL [options]

Required:
  SYMBOL                    Stock ticker (e.g. AAPL)

Options:
  --qty N                   Shares per buy (default: 1)
  --interval-min N          Poll interval in minutes (default: 15)
  --trail-percent P         Trailing stop % below high (default: 2)
  --backtest-days N         Historical days for backtest (default: 60)
  --eod-close-min N         Minutes before close to flatten (default: 15)
  --clock-retry-base-sec N  First clock retry delay in seconds (default: 60)
  --clock-retry-max-sec N   Max clock retry delay in seconds (default: 600)
  --closed-wake-before-min N  Wake before next_open to resume (default: 2)
  --closed-jitter-sec N     Per-symbol sleep spread 0..N sec (default: 180)
  --dry-run                 Log actions without placing orders
  --paper                   Use paper API (default if APCA_API_BASE_URL unset)
  --live                    Use live trading API (dangerous)

Environment (.env):
  APCA_API_KEY_ID, APCA_API_SECRET_KEY
  APCA_API_BASE_URL (default: paper-api.alpaca.markets)
  APCA_DATA_BASE_URL (default: data.alpaca.markets)
`);
}
