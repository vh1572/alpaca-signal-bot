import {
  isRegularSessionEt,
  shouldFlattenEod,
  msUntilNextInterval,
  formatEt,
  waitForMarketOpen,
} from './marketHours.js';

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

  async hasOpenPosition() {
    const pos = await this.client.getPosition(this.config.symbol);
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
      if (!String(e.message).includes('404')) throw e;
      this.log('No position to close');
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
    const inPosition = await this.hasOpenPosition();

    this.log(
      `Bars=${this.barHistory.length} signal=${signal} inPosition=${inPosition}`,
    );

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

    for (;;) {
      const clock = await this.client.getClock();
      if (!clock.is_open) {
        await this.flatten('Market closed');
        this.log('Waiting for next market open...');
        await waitForMarketOpen(this.client, (...a) => this.log(...a));
        continue;
      }

      const now = new Date();
      if (shouldFlattenEod(now, this.config.eodCloseMin)) {
        await this.flatten('EOD window');
      } else if (isRegularSessionEt(now)) {
        try {
          await this.tick();
        } catch (e) {
          this.log('Tick error:', e.message);
        }
      }

      const waitMs = msUntilNextInterval(new Date(), this.config.intervalMin);
      this.log(`Next check in ${Math.round(waitMs / 1000)}s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
