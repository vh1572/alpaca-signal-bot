# Alpaca Signal Bot

Node.js monitor that polls a stock every 15 minutes on Alpaca, detects **bullish direction-change** signals, buys with a **trailing stop**, and **flattens before the close**. On startup it **backtests several strategies** on historical 15-minute bars and runs the best one live.

## Signal strategies (parameterized)

| ID | Idea | Default params |
|----|------|----------------|
| `ema_crossover` | Fast EMA crosses above slow EMA | `fastPeriod=9`, `slowPeriod=21` |
| `rsi_reversal` | RSI recovers from oversold through a level | `period=14`, `oversold=30`, `crossAbove=50` |
| `macd_crossover` | MACD line crosses above signal | `fast=12`, `slow=26`, `signal=9` |
| `momentum_breakout` | Price jumps ≥ threshold % over lookback | `lookback=8`, `thresholdPct=0.75` |
| `bollinger_bounce` | Touch lower band, then close above middle | `period=20`, `stdDev=2` |

Tune parameters in `src/strategies/index.js`.

## Requirements

- Node.js 18+
- [Alpaca](https://alpaca.markets/) account (paper trading recommended)
- API keys with trading + market data access

## Setup

```bash
cd ~/Projects/alpaca-signal-bot
cp .env.example .env
# Edit .env with APCA_API_KEY_ID and APCA_API_SECRET_KEY
```

## Usage

```bash
# Paper trading, dry-run (no orders)
node src/index.js AAPL --dry-run

# Paper trading, live orders
node src/index.js AAPL --qty 2 --trail-percent 2.5

# Options
node src/index.js SYMBOL --qty 1 --interval-min 15 --trail-percent 2 \
  --backtest-days 60 --eod-close-min 15 --dry-run
```

### CLI parameters

| Flag | Default | Description |
|------|---------|-------------|
| `SYMBOL` | (required) | Ticker to trade |
| `--qty` | `1` | Shares per entry |
| `--interval-min` | `15` | Poll interval (minutes) |
| `--trail-percent` | `2` | Trailing stop distance (%) |
| `--backtest-days` | `60` | History length for strategy selection |
| `--eod-close-min` | `15` | Flatten when this many minutes remain before 16:00 ET |
| `--dry-run` | off | Log only, no orders |

## Behavior

1. **Startup** — Downloads 15Min bars, backtests all strategies, prints P/L table and the **selected winner**.
2. **Live** — Aligns checks to 15-minute boundaries during **9:30–16:00 ET** weekdays.
3. **Entry** — On bullish signal with no position: market buy + trailing stop sell.
4. **EOD** — Closes positions and cancels trailing stops within `--eod-close-min` of the close.
5. **Closed market** — Waits for next open via Alpaca clock API.

## Risk disclaimer

This is example/educational software, not financial advice. Backtest results do not guarantee future performance. Test thoroughly on **paper** before any live capital.
