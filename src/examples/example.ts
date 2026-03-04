/**
 * example.ts
 *
 * A complete, runnable backtest loop using PositionManager.
 * Copy this file into the same directory as src/ and run with:
 *
 *   npx tsx example.ts
 *
 * Demonstrates every API surface:
 *   - Signal registration and T+1 entry
 *   - Partial close mid-trade
 *   - Breakeven stop (SL moved to entry price)
 *   - TP hit
 *   - SL hit
 *   - Direct open() without a pending signal
 *   - forceCloseAtEnd at backtest termination
 *   - getStats()
 *
 * The strategy used here is intentionally trivial — its purpose is to
 * show API usage, not to be profitable.
 */

import type { OHLC } from '../types';
import { PositionManager } from '../PositionManager';

// ─── Configuration ─────────────────────────────────────────────────────────

const pm = new PositionManager({
    initialCapital: 10_000, // €
    riskPerTrade: 0.02, // 2% of current capital risked per trade (when SL is set)
    fallbackAllocation: 0.1, // 10% allocated when no SL is provided
    spread: 0, // no spread to keep example numbers clean
});

// ─── Synthetic candle data ─────────────────────────────────────────────────
//
// Hand-crafted to exercise each scenario predictably.
// Timestamps are sequential integers for readability.

const candles: OHLC[] = [
    //                         open    high    low     close
    { timestamp: 1, open: 1.2, high: 1.204, low: 1.198, close: 1.203 }, // flat — signal registered at end
    { timestamp: 2, open: 1.203, high: 1.208, low: 1.195, close: 1.206 }, // trade 1 opens at 1.2030
    { timestamp: 3, open: 1.206, high: 1.215, low: 1.204, close: 1.212 }, // partial close before this candle
    { timestamp: 4, open: 1.212, high: 1.217, low: 1.209, close: 1.215 }, // SL moved to breakeven before this candle
    { timestamp: 5, open: 1.215, high: 1.222, low: 1.213, close: 1.22 }, // TP hit — short signal registered at end
    { timestamp: 6, open: 1.218, high: 1.221, low: 1.215, close: 1.217 }, // trade 2 (short) opens at 1.2180
    { timestamp: 7, open: 1.217, high: 1.23, low: 1.214, close: 1.228 }, // SL hit — direct open at end
    { timestamp: 8, open: 1.228, high: 1.231, low: 1.225, close: 1.229 }, // trade 3 active (no SL/TP)
    { timestamp: 9, open: 1.229, high: 1.233, low: 1.227, close: 1.231 },
    { timestamp: 10, open: 1.231, high: 1.236, low: 1.229, close: 1.235 }, // trade 3 open — force-closed here // still open — will be force-closed
];

// ─── Strategy parameters ───────────────────────────────────────────────────

const SL_DISTANCE = 0.01; // 100 pip
const TP_DISTANCE = 0.02; // 200 pip

// ─── Backtest loop ─────────────────────────────────────────────────────────
//
// Correct loop order:
//
//   1. Pre-candle actions  — partial closes and SL updates decided on
//                            the previous candle, executed at this candle's open.
//   2. evaluateCandle      — materialises any pending signal (using candle.open),
//                            updates trailing stop, checks SL/TP.
//   3. Post-candle strategy — inspect result, register signals or plan
//                             adjustments for the next candle.
//
// Signals registered in step 3 are consumed in step 2 of the NEXT iteration.
// This is what enforces the T → T+1 entry rule.

console.log(
    '── Backtest start ────────────────────────────────────────────────',
);
console.log(`   Initial capital : €${pm.capital.toFixed(2)}\n`);

// Flags set at end of one candle, acted upon at the start of the next.
let planPartialClose = false;
let planBreakevenStop = false;

for (const candle of candles) {
    // ── Step 1: pre-candle actions ─────────────────────────────────────────
    // These execute at candle.open — before SL/TP is evaluated.

    if (planPartialClose && pm.hasOpenPosition) {
        const halfSize = pm.activePosition!.size / 2;
        const partial = pm.partialClose(
            candle.open,
            candle.timestamp,
            halfSize,
        );
        console.log(
            `[ts=${candle.timestamp}] Partial close : ${halfSize.toFixed(2)} units at ${candle.open.toFixed(4)}`,
        );
        console.log(
            `            P&L : +€${partial.pnlAbsolute.toFixed(2)}   Capital : €${pm.capital.toFixed(2)}`,
        );
        planPartialClose = false;
    }

    if (planBreakevenStop && pm.hasOpenPosition) {
        const breakevenPrice = pm.activePosition!.entryPrice;
        pm.updateStopLoss(breakevenPrice);
        console.log(
            `[ts=${candle.timestamp}] SL → breakeven : ${breakevenPrice.toFixed(4)}`,
        );
        planBreakevenStop = false;
    }

    // ── Step 2: evaluateCandle ─────────────────────────────────────────────

    const closed = pm.evaluateCandle(candle);

    if (closed) {
        const sign = closed.pnlAbsolute >= 0 ? '+' : '';
        console.log(
            `[ts=${candle.timestamp}] Closed (${closed.exitReason.padEnd(11)}) at ${closed.exitPrice.toFixed(4)}  P&L : ${sign}€${closed.pnlAbsolute.toFixed(2)}  Capital : €${pm.capital.toFixed(2)}`,
        );
    } else if (pm.hasOpenPosition) {
        const pos = pm.activePosition!;
        const sl =
            pos.stopLoss !== undefined ? pos.stopLoss.toFixed(4) : '—    ';
        const tp =
            pos.takeProfit !== undefined ? pos.takeProfit.toFixed(4) : '—    ';
        console.log(
            `[ts=${candle.timestamp}] Open (${pos.direction.padEnd(5)}) size : ${pos.size.toFixed(2)}  SL : ${sl}  TP : ${tp}`,
        );
    } else {
        console.log(`[ts=${candle.timestamp}] Flat`);
    }

    // ── Step 3: post-candle strategy decisions ─────────────────────────────
    // Signals registered here will be materialised at the NEXT candle's open.

    if (candle.timestamp === 1 && !pm.hasOpenPosition) {
        // Entry signal based on current candle's close
        pm.registerSignal({
            direction: 'long',
            stopLoss: candle.close - SL_DISTANCE,
            takeProfit: candle.close + TP_DISTANCE,
            createdAtTimestamp: candle.timestamp,
        });
        console.log(
            `         → Signal : LONG  SL ${(candle.close - SL_DISTANCE).toFixed(4)}  TP ${(candle.close + TP_DISTANCE).toFixed(4)}`,
        );
    }

    if (candle.timestamp === 2 && pm.hasOpenPosition) {
        // Candle closed in our favour — plan a partial close at next open
        planPartialClose = true;
    }

    if (candle.timestamp === 3 && pm.hasOpenPosition) {
        // Position is well in profit after partial — plan to move SL to breakeven
        planBreakevenStop = true;
    }

    if (closed?.exitReason === 'TP_HIT') {
        // Immediately register a counter-trend short signal
        pm.registerSignal({
            direction: 'short',
            stopLoss: closed.exitPrice + SL_DISTANCE,
            takeProfit: closed.exitPrice - TP_DISTANCE,
            createdAtTimestamp: candle.timestamp,
        });
        console.log(
            `         → Signal : SHORT  SL ${(closed.exitPrice + SL_DISTANCE).toFixed(4)}  TP ${(closed.exitPrice - TP_DISTANCE).toFixed(4)}`,
        );
    }

    if (closed?.exitReason === 'SL_HIT') {
        // Open a new long directly — bypasses the T+1 mechanism, enters immediately.
        // Use this only when you want to enter at a known price (e.g. current close)
        // rather than waiting for the next candle's open.
        pm.open('long', candle.close, candle.timestamp);
        const pos = pm.activePosition!;
        console.log(
            `         → Direct open : LONG at ${candle.close.toFixed(4)}  size : ${pos.size.toFixed(2)} units (no SL — fallback allocation)`,
        );
    }
}

// ─── End of backtest ───────────────────────────────────────────────────────
// Close any position still open at the last candle's close price.

const lastCandle = candles.at(-1)!;
const forceClose = pm.forceCloseAtEnd(lastCandle);
if (forceClose) {
    const sign = forceClose.pnlAbsolute >= 0 ? '+' : '';
    console.log(
        `\n[end] Force-closed at ${forceClose.exitPrice.toFixed(4)}  P&L : ${sign}€${forceClose.pnlAbsolute.toFixed(2)}  Capital : €${pm.capital.toFixed(2)}`,
    );
}

// ─── Statistics ────────────────────────────────────────────────────────────

const s = pm.getStats();

console.log(
    '\n── Results ───────────────────────────────────────────────────────',
);
console.log(
    `Trades: ${s.totalTrades}  (${s.winningTrades}W / ${s.losingTrades}L)`,
);

console.log(`Win rate: ${(s.winRate * 100).toFixed(1)}%`);

console.log(
    `Profit factor: ${isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'}`,
);

console.log(`Avg win: €${s.avgWin.toFixed(2)}`);

console.log(`Avg loss: €${s.avgLoss.toFixed(2)}`);

console.log(
    `Risk / reward: ${isFinite(s.riskReward) ? s.riskReward.toFixed(2) : '∞'}`,
);

console.log(
    `Max drawdown: €${s.maxDrawdown.toFixed(2)} (${(s.maxDrawdownPct * 100).toFixed(2)}%)`,
);

console.log(`Final capital: €${s.finalCapital.toFixed(2)}`);

console.log(`Total return: ${(s.totalReturn * 100).toFixed(2)}%`);

console.log(
    `Equity curve: [${s.equityCurve.map((v) => '€' + v.toFixed(0)).join(' → ')}]`,
);
