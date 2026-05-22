import {
  isRegularSessionEt,
  shouldFlattenEod,
  msUntilNextInterval,
  formatEt,
  waitForMarketOpen,
} from './marketHours.js';
import { AlpacaApiError, formatErrorReport, wrapError } from '../alpaca/errors.js';
import { logCheckDetails } from './logCheck.js';

export class LiveMonitor {
  constructor(client, config, strategy) {
    this.client = client;
    this.config = config;
    this.strategy = strategy;
    this.barHistory = [];
    this.trailingOrderId = null;
  }

  log(...args) {
    console.log(`[${formatEt(new Date())}]`, ...args);
  }

  logError(err, context) {
    console.error(`[${formatEt(new Date())}] ERROR (${context}):`);
    console.error(formatErrorReport(err, context));
  }

  async fetchRecentBars() {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 10);
    const bars = await this.client.getBars(this.config.symbol, {
      start: start.toISOString(),
      end: end.toISOString(),
      timeframe: '15Min',
    });
    this.barHistory = bars;
    return bars;
  }

  latestSignal() {
    const bars = this.barHistory;
    if (bars.length < 30) return false;
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
    const { symbol, qty, dryRun } = this.config;
    if (dryRun) {
      this.log(`[DRY-RUN] Would BUY ${qty} ${symbol}`);
      return { id: 'dry-run-buy' };
    }
    const order = await this.client.createOrder({
      symbol,
      qty: String(qty),
      side: 'buy',
      type: 'market',
      time_in_force: 'day',
    });
    this.log(`BUY order placed: ${order.id} qty=${qty}`);
    return order;
  }

  async placeTrailingStop() {
    const { symbol, qty, trailPercent, dryRun } = this.config;
    if (dryRun) {
      this.log(`[DRY-RUN] Would place trailing_stop ${trailPercent}% on ${qty} ${symbol}`);
      return { id: 'dry-run-trail' };
    }
    await this.cancelTrailingOrders();
    const order = await this.client.createOrder({
      symbol,
      qty: String(qty),
      side: 'sell',
      type: 'trailing_stop',
      trail_percent: String(trailPercent),
      time_in_force: 'gtc',
    });
    this.trailingOrderId = order.id;
    this.log(`Trailing stop placed: ${order.id} (${trailPercent}%)`);
    return order;
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
    } catch (e) {
      if (e instanceof AlpacaApiError && e.isNotFound()) {
        this.log('No position to close');
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
      await this.placeTrailingStop();
    } else if (inPosition && !this.trailingOrderId) {
      const orders = await this.client.listOrders({
        status: 'open',
        symbols: this.config.symbol,
      });
      const trail = orders.find((o) => o.type === 'trailing_stop');
      if (trail) this.trailingOrderId = trail.id;
      else await this.placeTrailingStop();
    }
  }

  async run() {
    this.log(`Live monitor started — ${this.config.symbol}`);
    this.log(`Poll every ${this.config.intervalMin} min | trail ${this.config.trailPercent}%`);

    let consecutiveErrors = 0;

    for (;;) {
      let clock;
      try {
        clock = await this.client.getClock();
        consecutiveErrors = 0;
      } catch (e) {
        consecutiveErrors++;
        this.logError(e, 'market clock');
        const waitMs = Math.min(60_000, 5000 * consecutiveErrors);
        this.log(`Retrying clock in ${waitMs / 1000}s (${consecutiveErrors} consecutive errors)`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      if (!clock.is_open) {
        try {
          await this.flatten('Market closed');
        } catch (e) {
          this.logError(e, 'flatten at close');
        }
        this.log('Waiting for next market open...');
        try {
          await waitForMarketOpen(this.client, (...a) => this.log(...a));
        } catch (e) {
          this.logError(e, 'wait for market open');
          await new Promise((r) => setTimeout(r, 30_000));
        }
        continue;
      }

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
        const waitMs = Math.min(120_000, 10_000 * consecutiveErrors);
        this.log(`Backing off ${waitMs / 1000}s after error (${consecutiveErrors} consecutive)`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      const waitMs = msUntilNextInterval(new Date(), this.config.intervalMin);
      this.log(`Next check in ${Math.round(waitMs / 1000)}s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
