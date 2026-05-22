#!/usr/bin/env node

import { parseConfig } from './config.js';
import { AlpacaClient } from './alpaca/client.js';
import { runBacktests, printBacktestResults } from './backtest/engine.js';
import { LiveMonitor } from './trading/monitor.js';
import { formatStrategy } from './strategies/index.js';
import { formatErrorReport } from './alpaca/errors.js';

async function main() {
  const config = parseConfig();
  const client = new AlpacaClient({
    apiBase: config.apiBase,
    dataBase: config.dataBase,
    keyId: config.keyId,
    secretKey: config.secretKey,
  });

  console.log('═══════════════════════════════════════════');
  console.log('  Alpaca Signal Bot');
  console.log('═══════════════════════════════════════════');
  console.log(`Symbol:     ${config.symbol}`);
  console.log(`Qty:        ${config.qty}`);
  console.log(`Interval:   ${config.intervalMin} minutes`);
  console.log(`Trail stop: ${config.trailPercent}%`);
  console.log(`API:        ${config.apiBase}`);
  console.log(`Mode:       ${config.dryRun ? 'DRY-RUN (no orders)' : config.paper ? 'PAPER' : 'LIVE'}`);
  console.log('═══════════════════════════════════════════\n');

  let account;
  try {
    account = await client.getAccount();
  } catch (err) {
    console.error(formatErrorReport(err, 'fetching account'));
    process.exit(1);
  }
  console.log(`Account: ${account.id} | equity: $${Number(account.equity).toFixed(2)} | status: ${account.status}\n`);

  let results;
  let best;
  try {
    ({ results, best } = await runBacktests(client, config.symbol, config));
  } catch (err) {
    console.error(formatErrorReport(err, `backtesting ${config.symbol}`));
    process.exit(1);
  }
  printBacktestResults(results, best);

  console.log('Starting live price monitoring in 5 seconds...\n');
  await new Promise((r) => setTimeout(r, 5000));

  const monitor = new LiveMonitor(client, config, best.strategy);
  await monitor.run();
}

main().catch((err) => {
  console.error('\n═══ Fatal error ═══');
  console.error(formatErrorReport(err));
  process.exit(1);
});
