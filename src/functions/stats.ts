// =============================================================================
// stats.ts
// Computes aggregate BacktestStats from an array of ClosedPosition records.
// This is intentionally a pure function so it can be called without
// instantiating a PositionManager (useful for testing and post-processing).
// =============================================================================

import type { BacktestStats, ClosedPosition } from '../types';

/**
 * Computes the maximum peak-to-valley drawdown from an equity curve.
 * Returns both the absolute drawdown in currency and the percentage
 * drawdown relative to the peak.
 */
function computeMaxDrawdown(equityCurve: number[]): {
    maxDrawdown: number;
    maxDrawdownPct: number;
} {
    let peak = equityCurve[0] ?? 0;
    let maxDrawdown = 0;
    let maxDrawdownPct = 0;

    for (const equity of equityCurve) {
        if (equity > peak) {
            peak = equity;
        }
        const drawdown = peak - equity;
        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
            maxDrawdownPct = peak > 0 ? drawdown / peak : 0;
        }
    }

    return { maxDrawdown, maxDrawdownPct };
}

/**
 * Computes all BacktestStats from the list of closed trades and the
 * initial capital.
 *
 * The equity curve starts with initialCapital and appends the running
 * capital after each trade.  Stats are recomputed from scratch on every
 * call (on-demand, not incrementally maintained).
 *
 * @param trades          All closed trades in chronological order
 * @param initialCapital  Starting capital for the backtest
 * @param finalCapital    Current capital after all trades
 */
export function computeStats(
    trades: ClosedPosition[],
    initialCapital: number,
    finalCapital: number,
): BacktestStats {
    const totalTrades = trades.length;

    // Winning / losing trade counts and sums
    const winners = trades.filter((t) => t.pnlAbsolute > 0);
    const losers = trades.filter((t) => t.pnlAbsolute < 0);

    const winningTrades = winners.length;
    const losingTrades = losers.length;

    const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;

    const totalGain = winners.reduce((acc, t) => acc + t.pnlAbsolute, 0);
    const totalLoss = Math.abs(
        losers.reduce((acc, t) => acc + t.pnlAbsolute, 0),
    );

    const profitFactor =
        totalLoss > 0 ? totalGain / totalLoss : totalGain > 0 ? Infinity : 0;

    const avgWin = winningTrades > 0 ? totalGain / winningTrades : 0;
    const avgLoss = losingTrades > 0 ? totalLoss / losingTrades : 0;
    const riskReward =
        avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;

    // Build equity curve: initial capital + running total after each trade
    const equityCurve: number[] = [initialCapital];
    let running = initialCapital;
    for (const trade of trades) {
        running += trade.pnlAbsolute;
        equityCurve.push(running);
    }

    const { maxDrawdown, maxDrawdownPct } = computeMaxDrawdown(equityCurve);

    const totalReturn =
        initialCapital > 0
            ? (finalCapital - initialCapital) / initialCapital
            : 0;

    return Object.freeze({
        totalTrades,
        winningTrades,
        losingTrades,
        winRate,
        profitFactor,
        avgWin,
        avgLoss,
        riskReward,
        maxDrawdown,
        maxDrawdownPct,
        finalCapital,
        totalReturn,
        equityCurve,
    });
}
