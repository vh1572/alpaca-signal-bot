import {
  isRegularSessionEt,
  shouldFlattenEod,
  msUntilNextInterval,
  msUntilMarketWake,
  formatEt,
  formatDuration,
  symbolJitterMs,
} from './marketHours.js';
import { AlpacaApiError, formatErrorReport, wrapError } from '../alpaca/errors.js';
import { logCheckDetails } from './logCheck.js';
import { minimumBarCount, requiredBarCount, trimBars } from '../strategies/index.js';

export class LiveMonitor {
  constructor(client, config, strategy) {
    this.client = client;
    this.config = config;
    this.strategy = strategy;
    this.maxBars = requiredBarCount(strategy);
    this.minBars = minimumBarCount(strategy);
    this.barHistory = [];
    this.trailingOrderId = null;
    this.didFlattenForClose = false;
    this.softwareTrail = false;
    this.trailHighWater = null;
  }

  /** Alpaca does not support trailing_stop on fractional / notional positions. */
  needsSoftwareTrail(sellQty) {
    if (this.config.useNotional) return true;
    return sellQty != null && !Number.isInteger(sellQty);
  }

  clockRetryDelayMs(consecutiveErrors) {
    const base = this.config.clockRetryBaseSec * 1000;
    const max = this.config.clockRetryMaxSec * 1000;
    const backoff = Math.min(max, base * consecutiveErrors);
    const jitter = symbolJitterMs(this.config.symbol, 30_000);
    return backoff + jitter;
  }

  tickRetryDelayMs(consecutiveErrors) {
    const base = 60_000;
    const max = 300_000;
    const backoff = Math.min(max, base * consecutiveErrors);
    const jitter = symbolJitterMs(this.config.symbol, 20_000);
    return backoff + jitter;
  }

  async sleepWhileClosed(clock) {
    const sleepMs = msUntilMarketWake(clock.next_open, this.config.symbol, {
      wakeBeforeMin: this.config.closedWakeBeforeMin,
      jitterMaxSec: this.config.closedJitterSec,
    });
    const nextOpen = formatEt(new Date(clock.next_open));
    if (sleepMs >= 60_000) {
      this.log(
        `Market closed until ${nextOpen} ET — sleeping ${formatDuration(sleepMs)} (then recheck)`,
      );
      await new Promise((r) => setTimeout(r, sleepMs));
    } else {
      this.log(`Market closed — next open ${nextOpen} ET — rechecking in ${formatDuration(sleepMs)}`);
      await new Promise((r) => setTimeout(r, Math.max(5000, sleepMs)));
    }
  }

  log(...args) {
    console.log(`[${formatEt(new Date())}]`, ...args);
  }

  logError(err, context) {
    console.error(`[${formatEt(new Date())}] ERROR (${context}):`);
    console.error(formatErrorReport(err, context));
  }

  async fetchRecentBars() {
    const bars = await this.client.getRecentBars(this.config.symbol, {
      limit: this.maxBars,
      timeframe: '15Min',
    });
    this.barHistory = trimBars(bars, this.maxBars);
    return this.barHistory;
  }

  latestSignal() {
    const bars = this.barHistory;
    if (bars.length < this.minBars) return false;
    const closes = bars.map((b) => b.c);
    const highs = bars.map((b) => b.h);
    const lows = bars.map((b) => b.l);
    const i = closes.length - 1;
    return this.strategy.detect(closes, highs, lows, i, this.strategy.params);
  }

  async getPosition() {
    return this.client.getPosition(this.config.symbol);
  }

  async hasOpenPosition() {
    const pos = await this.getPosition();
    return pos && Number(pos.qty) > 0;
  }

  async cancelTrailingOrders() {
    const orders = await this.client.listOrders({
      status: 'open',
      symbols: this.config.symbol,
    });
    for (const o of orders) {
      if (o.type === 'trailing_stop') {
        if (!this.config.dryRun) await this.client.cancelOrder(o.id);
        this.log(`Cancelled trailing stop ${o.id}`);
      }
    }
    this.trailingOrderId = null;
  }

  async placeBuy() {
    const { symbol, qty, minNotional, useNotional, dryRun } = this.config;
    if (dryRun) {
      if (useNotional) {
        this.log(`[DRY-RUN] Would BUY $${minNotional} notional ${symbol}`);
      } else {
        this.log(`[DRY-RUN] Would BUY ${qty} ${symbol}`);
      }
      return { id: 'dry-run-buy' };
    }
    const order = useNotional
      ? {
          symbol,
          notional: String(minNotional),
          side: 'buy',
          type: 'market',
          time_in_force: 'day',
        }
      : {
          symbol,
          qty: String(qty),
          side: 'buy',
          type: 'market',
          time_in_force: 'day',
        };
    const placed = await this.client.createOrder(order);
    const label = useNotional ? `notional=$${minNotional}` : `qty=${qty}`;
    this.log(`BUY order placed: ${placed.id} ${label}`);
    return placed;
  }

  async positionQty() {
    const pos = await this.getPosition();
    if (!pos) return null;
    const q = Math.abs(Number(pos.qty));
    return q > 0 ? q : null;
  }

  trailStopPrice(highWater) {
    const { trailDollars, trailPercent } = this.config;
    if (trailDollars != null && trailDollars > 0) {
      return highWater - trailDollars;
    }
    return highWater * (1 - (trailPercent ?? 2) / 100);
  }

  trailLabel() {
    const { trailDollars, trailPercent } = this.config;
    return trailDollars != null && trailDollars > 0 ? `$${trailDollars}` : `${trailPercent}%`;
  }

  async manageSoftwareTrail(position) {
    const last = this.barHistory[this.barHistory.length - 1];
    if (!last) return;

    const mkt = Number(position.current_price) || last.c;
    const entry = Number(position.avg_entry_price) || mkt;
    if (this.trailHighWater == null) {
      this.trailHighWater = Math.max(entry, mkt, last.h);
      this.log(`Software trail armed — ${this.trailLabel()} below $${this.trailHighWater.toFixed(2)}`);
    } else {
      this.trailHighWater = Math.max(this.trailHighWater, mkt, last.h);
    }

    const stop = this.trailStopPrice(this.trailHighWater);
    if (last.l <= stop || mkt <= stop) {
      await this.flatten(`software trail hit (${this.trailLabel()}, stop $${stop.toFixed(2)})`);
      return;
    }
    this.log(
      `Software trail: hwm $${this.trailHighWater.toFixed(2)} | stop $${stop.toFixed(2)} | mkt $${mkt.toFixed(2)}`,
    );
  }

  async placeTrailingStop() {
    const { symbol, qty, trailDollars, trailPercent, useNotional, dryRun } = this.config;
    let sellQty = await this.positionQty();
    if (!sellQty && !dryRun) {
      this.log('No position qty for trailing stop — skipping');
      return null;
    }

    if (this.needsSoftwareTrail(sellQty)) {
      this.softwareTrail = true;
      this.trailingOrderId = null;
      this.trailHighWater = null;
      if (dryRun) {
        sellQty = sellQty ?? qty;
        this.log(
          `[DRY-RUN] Software-managed trail ${this.trailLabel()} on ${sellQty} ${symbol}`,
        );
        return { id: 'dry-run-software-trail' };
      }
      this.log(
        `Software-managed trail ${this.trailLabel()} on ${sellQty} ${symbol} (fractional — no broker trailing_stop)`,
      );
      return { id: 'software-trail' };
    }

    const useDollarTrail = trailDollars != null && trailDollars > 0;
    if (dryRun) {
      sellQty = sellQty ?? qty;
      const trailDesc = useDollarTrail ? `$${trailDollars}` : `${trailPercent}%`;
      this.log(
        `[DRY-RUN] Would place trailing_stop ${trailDesc} on ${sellQty} ${symbol} (gtc)`,
      );
      return { id: 'dry-run-trail' };
    }
    await this.cancelTrailingOrders();
    const placed = await this.client.createOrder(
      useDollarTrail
        ? {
            symbol,
            qty: String(sellQty),
            side: 'sell',
            type: 'trailing_stop',
            trail_price: String(trailDollars),
            time_in_force: 'gtc',
          }
        : {
            symbol,
            qty: String(sellQty),
            side: 'sell',
            type: 'trailing_stop',
            trail_percent: String(trailPercent),
            time_in_force: 'gtc',
          },
    );
    this.trailingOrderId = placed.id;
    this.softwareTrail = false;
    const trailDesc = useDollarTrail ? `$${trailDollars}` : `${trailPercent}%`;
    this.log(`Trailing stop placed: ${placed.id} (${trailDesc}, qty=${sellQty}, gtc)`);
    return placed;
  }

  resetTrailState() {
    this.trailingOrderId = null;
    this.softwareTrail = false;
    this.trailHighWater = null;
  }

  async flatten(reason) {
    const { symbol, dryRun } = this.config;
    this.log(`Flattening position: ${reason}`);
    if (dryRun) {
      this.log(`[DRY-RUN] Would close ${symbol} and cancel orders`);
      return;
    }
    await this.cancelTrailingOrders();
    try {
      await this.client.closePosition(symbol);
      this.log(`Position closed for ${symbol}`);
      this.resetTrailState();
    } catch (e) {
      if (e instanceof AlpacaApiError && e.isNotFound()) {
        this.log('No position to close');
        this.resetTrailState();
        return;
      }
      throw wrapError(e, `flatten ${symbol}`);
    }
  }

  async tick() {
    const now = new Date();
    const clock = await this.client.getClock();

    if (!clock.is_open || !isRegularSessionEt(now)) {
      this.log('Outside regular session — skipping tick');
      return;
    }

    if (shouldFlattenEod(now, this.config.eodCloseMin)) {
      await this.flatten(`EOD (${this.config.eodCloseMin} min before close)`);
      return;
    }

    await this.fetchRecentBars();
    const signal = this.latestSignal();
    const position = await this.getPosition();
    const inPosition = position && Number(position.qty) > 0;

    logCheckDetails(this.log.bind(this), {
      symbol: this.config.symbol,
      strategy: this.strategy,
      bars: this.barHistory,
      signal,
      position,
      clock,
    });

    if (signal && !inPosition) {
      await this.placeBuy();
      await new Promise((r) => setTimeout(r, 2000));
      this.resetTrailState();
      await this.placeTrailingStop();
    } else if (inPosition) {
      const sellQty = await this.positionQty();
      if (this.needsSoftwareTrail(sellQty)) {
        if (!this.softwareTrail) await this.placeTrailingStop();
        await this.manageSoftwareTrail(position);
      } else {
        const orders = await this.client.listOrders({
          status: 'open',
          symbols: this.config.symbol,
        });
        const trail = orders.find((o) => o.type === 'trailing_stop');
        if (trail) {
          this.trailingOrderId = trail.id;
        } else {
          this.trailingOrderId = null;
          await this.placeTrailingStop();
        }
      }
    }
  }

  async run() {
    this.log(`Live monitor started — ${this.config.symbol}`);
    this.log(`Poll every ${this.config.intervalMin} min`);
    if (this.config.useNotional) {
      this.log(
        `Entry $${this.config.minNotional} notional | trail $${this.config.trailDollars} (software-managed on fractional)`,
      );
    } else if (this.config.trailDollars) {
      this.log(`Entry ${this.config.qty} shares | trail $${this.config.trailDollars} (from backtest)`);
    }
    this.log(`Bar window: keep ${this.maxBars}, need ≥${this.minBars} × 15Min bars`);

    let consecutiveErrors = 0;

    for (;;) {
      let clock;
      try {
        clock = await this.client.getClock();
        consecutiveErrors = 0;
      } catch (e) {
        consecutiveErrors++;
        this.logError(e, 'market clock');
        const waitMs = this.clockRetryDelayMs(consecutiveErrors);
        this.log(
          `Retrying clock in ${formatDuration(waitMs)} (${consecutiveErrors} consecutive errors)`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      if (!clock.is_open) {
        if (!this.didFlattenForClose) {
          try {
            await this.flatten('Market closed');
          } catch (e) {
            this.logError(e, 'flatten at close');
          }
          this.didFlattenForClose = true;
        }
        await this.sleepWhileClosed(clock);
        continue;
      }

      this.didFlattenForClose = false;

      const now = new Date();
      try {
        if (shouldFlattenEod(now, this.config.eodCloseMin)) {
          await this.flatten('EOD window');
        } else if (isRegularSessionEt(now)) {
          await this.tick();
        } else {
          this.log('Outside regular session — idle until next interval');
        }
        consecutiveErrors = 0;
      } catch (e) {
        consecutiveErrors++;
        this.logError(e, 'tick');
        const waitMs = this.tickRetryDelayMs(consecutiveErrors);
        this.log(
          `Backing off ${formatDuration(waitMs)} after tick error (${consecutiveErrors} consecutive)`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      const waitMs = msUntilNextInterval(new Date(), this.config.intervalMin);
      this.log(`Next check in ${Math.round(waitMs / 1000)}s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
