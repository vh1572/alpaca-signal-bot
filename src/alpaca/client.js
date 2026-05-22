import { AlpacaApiError } from './errors.js';

export class AlpacaClient {
  constructor({ apiBase, dataBase, keyId, secretKey }) {
    this.apiBase = apiBase.replace(/\/$/, '');
    this.dataBase = dataBase.replace(/\/$/, '');
    this.headers = {
      'APCA-API-KEY-ID': keyId,
      'APCA-API-SECRET-KEY': secretKey,
      Accept: 'application/json',
    };
  }

  async request(base, path, { params, method = 'GET', body } = {}) {
    const url = new URL(`${base}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url, {
      method,
      headers: {
        ...this.headers,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const apiMessage =
        typeof data === 'object' && data?.message
          ? data.message
          : typeof data === 'object'
            ? JSON.stringify(data)
            : text;
      throw new AlpacaApiError({
        message: `Alpaca API error: ${apiMessage}`,
        status: res.status,
        method,
        path,
        base,
        url: url.toString(),
        body: data,
      });
    }
    return data;
  }

  getClock() {
    return this.request(this.apiBase, '/v2/clock');
  }

  getAccount() {
    return this.request(this.apiBase, '/v2/account');
  }

  getPosition(symbol) {
    return this.request(this.apiBase, `/v2/positions/${symbol}`).catch((e) => {
      if (e instanceof AlpacaApiError && e.isNotFound()) return null;
      throw e;
    });
  }

  listPositions() {
    return this.request(this.apiBase, '/v2/positions');
  }

  listOrders({ status = 'open', symbols } = {}) {
    return this.request(this.apiBase, '/v2/orders', {
      params: { status, limit: 200, ...(symbols ? { symbols } : {}) },
    });
  }

  cancelOrder(id) {
    return this.request(this.apiBase, `/v2/orders/${id}`, { method: 'DELETE' });
  }

  cancelAllOrders() {
    return this.request(this.apiBase, '/v2/orders', { method: 'DELETE' });
  }

  createOrder(order) {
    return this.request(this.apiBase, '/v2/orders', { method: 'POST', body: order });
  }

  closePosition(symbol) {
    return this.request(this.apiBase, `/v2/positions/${symbol}`, { method: 'DELETE' });
  }

  closeAllPositions() {
    return this.request(this.apiBase, '/v2/positions', { method: 'DELETE' });
  }

  async getBars(symbol, { start, end, timeframe = '15Min', limit = 10000 }) {
    const all = [];
    let pageToken;
    do {
      const params = {
        symbols: symbol,
        timeframe,
        start,
        end,
        limit,
        adjustment: 'split',
        feed: 'iex',
        ...(pageToken ? { page_token: pageToken } : {}),
      };
      const data = await this.request(this.dataBase, '/v2/stocks/bars', { params });
      const bars = data?.bars?.[symbol] || [];
      all.push(...bars);
      pageToken = data?.next_page_token;
    } while (pageToken);
    return all.sort((a, b) => new Date(a.t) - new Date(b.t));
  }

  getLatestBar(symbol) {
    return this.request(this.dataBase, '/v2/stocks/bars/latest', {
      params: { symbols: symbol, feed: 'iex' },
    });
  }

  /** Fetch only the most recent N bars (minimal memory / API payload for live ticks). */
  async getRecentBars(symbol, { limit, end, timeframe = '15Min' }) {
    const data = await this.request(this.dataBase, '/v2/stocks/bars', {
      params: {
        symbols: symbol,
        timeframe,
        end: end ?? new Date().toISOString(),
        limit,
        adjustment: 'split',
        feed: 'iex',
      },
    });
    const bars = data?.bars?.[symbol] || [];
    return bars.sort((a, b) => new Date(a.t) - new Date(b.t));
  }
}
