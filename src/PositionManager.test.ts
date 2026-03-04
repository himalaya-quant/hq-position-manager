// =============================================================================
// PositionManager.test.ts
// Unit tests written with Vitest.
// Run with: vitest run  (or vitest for watch mode)
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { PositionManager } from './PositionManager';
import type { OHLC, PositionManagerConfig } from './types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_CONFIG: PositionManagerConfig = {
    initialCapital: 10_000,
    riskPerTrade: 0.02, // 2 %
    fallbackAllocation: 0.1, // 10 %
    spread: 0.0002,
};

/** Shorthand for building an OHLC candle. */
const candle = (o: number, h: number, l: number, c: number, ts = 0): OHLC => ({
    open: o,
    high: h,
    low: l,
    close: c,
    timestamp: ts,
});

// ---------------------------------------------------------------------------
// 1. PendingSignal — T → T+1 lookahead prevention
// ---------------------------------------------------------------------------

describe('PendingSignal', () => {
    it('is registered but does not open a position immediately', () => {
        const pm = new PositionManager(BASE_CONFIG);
        pm.registerSignal({ direction: 'long', createdAtTimestamp: 100 });

        expect(pm.hasPendingSignal).toBe(true);
        expect(pm.hasOpenPosition).toBe(false);
    });

    it('is materialised at the next evaluateCandle using candle.open as entry', () => {
        const pm = new PositionManager(BASE_CONFIG);
        pm.registerSignal({ direction: 'long', createdAtTimestamp: 100 });

        const result = pm.evaluateCandle(candle(1.2, 1.21, 1.196, 1.205, 200));

        expect(pm.hasOpenPosition).toBe(true);
        expect(pm.hasPendingSignal).toBe(false);
        expect(result).toBeNull();
    });

    it('applies spread to the open price on materialisation (long)', () => {
        const pm = new PositionManager(BASE_CONFIG);
        pm.registerSignal({ direction: 'long', createdAtTimestamp: 1 });
        pm.evaluateCandle(candle(1.2, 1.21, 1.196, 1.205, 2));

        expect(pm.activePosition!.entryPrice).toBeCloseTo(1.2 + 0.0002);
    });

    it('overwrites a previous pending signal when registerSignal is called twice', () => {
        const pm = new PositionManager(BASE_CONFIG);
        pm.registerSignal({ direction: 'long', createdAtTimestamp: 1 });
        pm.registerSignal({ direction: 'short', createdAtTimestamp: 2 });
        pm.evaluateCandle(candle(1.2, 1.21, 1.196, 1.205, 3));

        expect(pm.activePosition!.direction).toBe('short');
    });
});

// ---------------------------------------------------------------------------
// 2. Spread
// ---------------------------------------------------------------------------

describe('Spread', () => {
    it('adds spread to entry on long (buyer pays the ask)', () => {
        const pm = new PositionManager(BASE_CONFIG);
        pm.open('long', 1.2, 1);

        expect(pm.activePosition!.entryPrice).toBeCloseTo(1.2002);
    });

    it('subtracts spread from entry on short (seller receives the bid)', () => {
        const pm = new PositionManager(BASE_CONFIG);
        pm.open('short', 1.2, 1);

        expect(pm.activePosition!.entryPrice).toBeCloseTo(1.1998);
    });
});

// ---------------------------------------------------------------------------
// 3. Position sizing
// ---------------------------------------------------------------------------

describe('Position sizing', () => {
    it('computes risk-based size when SL is present', () => {
        const pm = new PositionManager(BASE_CONFIG);
        const adjustedEntry = 1.2 + 0.0002;
        const expectedSize = (10_000 * 0.02) / (adjustedEntry - 1.195);

        pm.registerSignal({
            direction: 'long',
            stopLoss: 1.195,
            createdAtTimestamp: 1,
        });
        pm.evaluateCandle(candle(1.2, 1.22, 1.196, 1.21, 2));

        expect(pm.activePosition!.size).toBeCloseTo(expectedSize, 2);
    });

    it('computes fallback-allocation size when SL is absent', () => {
        const pm = new PositionManager(BASE_CONFIG);
        const adjustedEntry = 1.2 + 0.0002;
        const expectedSize = (10_000 * 0.1) / adjustedEntry;

        pm.registerSignal({ direction: 'long', createdAtTimestamp: 1 });
        pm.evaluateCandle(candle(1.2, 1.22, 1.18, 1.21, 2));

        expect(pm.activePosition!.size).toBeCloseTo(expectedSize, 2);
    });

    it('throws when capital is exhausted', () => {
        const pm = new PositionManager({
            ...BASE_CONFIG,
            initialCapital: 100,
            spread: 0,
        });
        pm.open('long', 1.0, 1, 0.999);
        pm.close(0.0001, 2, 'SIGNAL');

        expect(() => pm.open('long', 1.0, 3)).toThrow();
    });
});

// ---------------------------------------------------------------------------
// 4. evaluateCandle — SL / TP hit detection
// ---------------------------------------------------------------------------

describe('evaluateCandle — SL/TP detection', () => {
    let pm: PositionManager;

    beforeEach(() => {
        pm = new PositionManager({ ...BASE_CONFIG, spread: 0 });
    });

    it('closes long with SL_HIT when candle.low touches SL', () => {
        pm.open('long', 1.2, 1, 1.195);
        const closed = pm.evaluateCandle(candle(1.2, 1.205, 1.194, 1.195, 2));

        expect(closed!.exitReason).toBe('SL_HIT');
        expect(closed!.exitPrice).toBeCloseTo(1.195);
        expect(pm.hasOpenPosition).toBe(false);
    });

    it('closes short with SL_HIT when candle.high touches SL', () => {
        pm.open('short', 1.2, 1, 1.205);
        const closed = pm.evaluateCandle(candle(1.2, 1.206, 1.195, 1.201, 2));

        expect(closed!.exitReason).toBe('SL_HIT');
        expect(closed!.exitPrice).toBeCloseTo(1.205);
    });

    it('closes long with TP_HIT when candle.high touches TP', () => {
        pm.open('long', 1.2, 1, undefined, 1.22);
        const closed = pm.evaluateCandle(candle(1.21, 1.225, 1.208, 1.22, 2));

        expect(closed!.exitReason).toBe('TP_HIT');
        expect(closed!.exitPrice).toBeCloseTo(1.22);
    });

    it('closes short with TP_HIT when candle.low touches TP', () => {
        pm.open('short', 1.2, 1, undefined, 1.18);
        const closed = pm.evaluateCandle(candle(1.19, 1.195, 1.179, 1.185, 2));

        expect(closed!.exitReason).toBe('TP_HIT');
        expect(closed!.exitPrice).toBeCloseTo(1.18);
    });

    it('returns null when neither SL nor TP is touched', () => {
        pm.open('long', 1.2, 1, 1.19, 1.23);
        const result = pm.evaluateCandle(candle(1.201, 1.21, 1.195, 1.205, 2));

        expect(result).toBeNull();
        expect(pm.hasOpenPosition).toBe(true);
    });

    it('prefers SL over TP (worst-case first) when both are touched in the same candle', () => {
        pm.open('long', 1.2, 1, 1.19, 1.22);
        const closed = pm.evaluateCandle(candle(1.205, 1.225, 1.188, 1.21, 2));

        expect(closed!.exitReason).toBe('SL_HIT');
    });
});

// ---------------------------------------------------------------------------
// 5. open() — guards
// ---------------------------------------------------------------------------

describe('open()', () => {
    it('throws when a position is already open', () => {
        const pm = new PositionManager({ ...BASE_CONFIG, spread: 0 });
        pm.open('long', 1.2, 1);

        expect(() => pm.open('short', 1.2, 2)).toThrow();
    });

    it('allows opening a new position after the previous one is closed', () => {
        const pm = new PositionManager({ ...BASE_CONFIG, spread: 0 });
        pm.open('long', 1.2, 1);
        pm.close(1.21, 2, 'SIGNAL');

        expect(() => pm.open('short', 1.21, 3)).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// 6. partialClose()
// ---------------------------------------------------------------------------

describe('partialClose()', () => {
    let pm: PositionManager;
    const ENTRY = 1.2;

    beforeEach(() => {
        pm = new PositionManager({ ...BASE_CONFIG, spread: 0 });
        pm.open('long', ENTRY, 1, 1.19);
    });

    it('reduces the remaining size by the closed amount', () => {
        const originalSize = pm.activePosition!.size;
        pm.partialClose(1.21, 2, originalSize / 2);

        expect(pm.activePosition!.size).toBeCloseTo(originalSize / 2, 4);
    });

    it('keeps the position open after a partial close', () => {
        pm.partialClose(1.21, 2, pm.activePosition!.size / 2);
        expect(pm.hasOpenPosition).toBe(true);
    });

    it('computes the correct P&L for the closed units', () => {
        const halfSize = pm.activePosition!.size / 2;
        const exitPrice = 1.21;
        const partial = pm.partialClose(exitPrice, 2, halfSize);

        expect(partial.pnlAbsolute).toBeCloseTo(
            (exitPrice - ENTRY) * halfSize,
            4,
        );
    });

    it('updates capital immediately after partial close', () => {
        const capitalBefore = pm.capital;
        const halfSize = pm.activePosition!.size / 2;
        const exitPrice = 1.21;
        pm.partialClose(exitPrice, 2, halfSize);

        expect(pm.capital).toBeCloseTo(
            capitalBefore + (exitPrice - ENTRY) * halfSize,
            4,
        );
    });

    it('throws when sizeToClose equals the full remaining size', () => {
        expect(() =>
            pm.partialClose(1.21, 2, pm.activePosition!.size),
        ).toThrow();
    });

    it('throws when sizeToClose exceeds the remaining size', () => {
        expect(() =>
            pm.partialClose(1.21, 2, pm.activePosition!.size * 2),
        ).toThrow();
    });

    it('throws when no position is open', () => {
        const fresh = new PositionManager({ ...BASE_CONFIG, spread: 0 });
        expect(() => fresh.partialClose(1.21, 1, 100)).toThrow();
    });
});

// ---------------------------------------------------------------------------
// 7. close() — P&L aggregation
// ---------------------------------------------------------------------------

describe('close()', () => {
    it('aggregates P&L from partial exits plus the final residual close', () => {
        const pm = new PositionManager({ ...BASE_CONFIG, spread: 0 });
        pm.open('long', 1.0, 1, 0.99);
        const halfSize = pm.activePosition!.size / 2;

        pm.partialClose(1.01, 2, halfSize);
        const closed = pm.close(1.0, 3, 'SIGNAL');

        const expectedTotal = (1.01 - 1.0) * halfSize; // final leg is breakeven
        expect(closed.pnlAbsolute).toBeCloseTo(expectedTotal, 4);
    });

    it('updates capital after close', () => {
        const pm = new PositionManager({ ...BASE_CONFIG, spread: 0 });
        const capitalBefore = pm.capital;
        pm.open('long', 1.0, 1);
        const size = pm.activePosition!.size;
        pm.close(1.02, 2, 'SIGNAL');

        expect(pm.capital).toBeCloseTo(capitalBefore + (1.02 - 1.0) * size, 4);
    });

    it('clears the active position after close', () => {
        const pm = new PositionManager({ ...BASE_CONFIG, spread: 0 });
        pm.open('long', 1.0, 1);
        pm.close(1.01, 2, 'SIGNAL');

        expect(pm.hasOpenPosition).toBe(false);
        expect(pm.activePosition).toBeNull();
    });

    it('throws when no position is open', () => {
        const pm = new PositionManager({ ...BASE_CONFIG, spread: 0 });
        expect(() => pm.close(1.0, 1, 'SIGNAL')).toThrow();
    });
});

// ---------------------------------------------------------------------------
// 8. updateStopLoss / updateTakeProfit
// ---------------------------------------------------------------------------

describe('updateStopLoss()', () => {
    let pm: PositionManager;

    beforeEach(() => {
        pm = new PositionManager({ ...BASE_CONFIG, spread: 0 });
        pm.open('long', 1.2, 1);
    });

    it('updates the SL to a valid value below entry', () => {
        pm.updateStopLoss(1.19);
        expect(pm.activePosition!.stopLoss).toBe(1.19);
    });

    it('allows breakeven SL equal to entry price', () => {
        pm.updateStopLoss(1.2);
        expect(pm.activePosition!.stopLoss).toBe(1.2);
    });

    it('throws when SL is above entry price on a long', () => {
        expect(() => pm.updateStopLoss(1.21)).toThrow();
    });

    it('logs each change in slHistory with old and new values', () => {
        pm.updateStopLoss(1.19);
        pm.updateStopLoss(1.195);

        const history = pm.activePosition!.slHistory;
        expect(history).toHaveLength(2);
        expect(history[0].type).toBe('SL');
        expect(history[0].newValue).toBe(1.19);
        expect(history[1].oldValue).toBe(1.19);
        expect(history[1].newValue).toBe(1.195);
    });

    it('throws when no position is open', () => {
        const fresh = new PositionManager({ ...BASE_CONFIG, spread: 0 });
        expect(() => fresh.updateStopLoss(1.19)).toThrow();
    });
});

describe('updateTakeProfit()', () => {
    let pm: PositionManager;

    beforeEach(() => {
        pm = new PositionManager({ ...BASE_CONFIG, spread: 0 });
        pm.open('long', 1.2, 1);
    });

    it('updates the TP to a valid value above entry', () => {
        pm.updateTakeProfit(1.23);
        expect(pm.activePosition!.takeProfit).toBe(1.23);
    });

    it('throws when TP is at or below entry price on a long', () => {
        expect(() => pm.updateTakeProfit(1.15)).toThrow();
        expect(() => pm.updateTakeProfit(1.2)).toThrow();
    });

    it('logs the change in slHistory', () => {
        pm.updateTakeProfit(1.23);

        const history = pm.activePosition!.slHistory;
        expect(history).toHaveLength(1);
        expect(history[0].type).toBe('TP');
        expect(history[0].newValue).toBe(1.23);
    });

    it('throws when no position is open', () => {
        const fresh = new PositionManager({ ...BASE_CONFIG, spread: 0 });
        expect(() => fresh.updateTakeProfit(1.23)).toThrow();
    });
});

// ---------------------------------------------------------------------------
// 9. Trailing stop
// ---------------------------------------------------------------------------

describe('Trailing stop', () => {
    it('moves SL up as new highs are set on a long', () => {
        const pm = new PositionManager({
            ...BASE_CONFIG,
            spread: 0,
            trailingStop: 0.01,
        });
        pm.open('long', 1.2, 1, 1.19);

        // Low must stay above new SL (1.2150 - 0.01 = 1.2140) to avoid triggering it
        pm.evaluateCandle(candle(1.205, 1.215, 1.2145, 1.21, 2));

        expect(pm.activePosition!.stopLoss).toBeCloseTo(1.215 - 0.01);
    });

    it('does not retreat SL when no new high is set', () => {
        const pm = new PositionManager({
            ...BASE_CONFIG,
            spread: 0,
            trailingStop: 0.01,
        });
        pm.open('long', 1.2, 1, 1.19);

        pm.evaluateCandle(candle(1.205, 1.215, 1.2145, 1.21, 2));
        const slAfterFirstCandle = pm.activePosition!.stopLoss;

        // Lower high — SL must not move; keep low above current SL
        pm.evaluateCandle(candle(1.21, 1.212, 1.2145, 1.211, 3));

        expect(pm.activePosition!.stopLoss).toBeCloseTo(slAfterFirstCandle!, 6);
    });

    it('moves SL down as new lows are set on a short', () => {
        const pm = new PositionManager({
            ...BASE_CONFIG,
            spread: 0,
            trailingStop: 0.01,
        });
        pm.open('short', 1.2, 1, 1.21);

        // High must stay below new SL (1.1850 + 0.01 = 1.1950) to avoid triggering it
        pm.evaluateCandle(candle(1.195, 1.1945, 1.185, 1.19, 2));

        expect(pm.activePosition!.stopLoss).toBeCloseTo(1.185 + 0.01);
    });

    it('logs every trailing SL update in slHistory', () => {
        const pm = new PositionManager({
            ...BASE_CONFIG,
            spread: 0,
            trailingStop: 0.01,
        });
        pm.open('long', 1.2, 1, 1.19);

        pm.evaluateCandle(candle(1.205, 1.215, 1.2145, 1.21, 2));
        pm.evaluateCandle(candle(1.21, 1.22, 1.2155, 1.218, 3));

        const trailEntries = pm.activePosition!.slHistory.filter(
            (e) => e.type === 'SL',
        );
        expect(trailEntries.length).toBeGreaterThanOrEqual(2);
    });

    it('does nothing when trailingStop is not configured', () => {
        const pm = new PositionManager({ ...BASE_CONFIG, spread: 0 });
        pm.open('long', 1.2, 1, 1.19);
        const slBefore = pm.activePosition!.stopLoss;

        pm.evaluateCandle(candle(1.205, 1.23, 1.196, 1.22, 2));

        expect(pm.activePosition!.stopLoss).toBe(slBefore);
    });
});

// ---------------------------------------------------------------------------
// 10. getStats()
// ---------------------------------------------------------------------------

describe('getStats()', () => {
    it('returns zeroed stats when no trades have been closed', () => {
        const pm = new PositionManager(BASE_CONFIG);
        const stats = pm.getStats();

        expect(stats.totalTrades).toBe(0);
        expect(stats.winRate).toBe(0);
        expect(stats.equityCurve).toEqual([BASE_CONFIG.initialCapital]);
    });

    it('counts winning and losing trades correctly', () => {
        const pm = new PositionManager({ ...BASE_CONFIG, spread: 0 });

        pm.open('long', 1.0, 1, 0.99);
        pm.close(1.02, 2, 'SIGNAL');

        pm.open('short', 1.02, 3, 1.03);
        pm.close(1.03, 4, 'SL_HIT');

        const stats = pm.getStats();
        expect(stats.totalTrades).toBe(2);
        expect(stats.winningTrades).toBe(1);
        expect(stats.losingTrades).toBe(1);
        expect(stats.winRate).toBeCloseTo(0.5);
    });

    it('equity curve starts with initialCapital and has one entry per closed trade', () => {
        const pm = new PositionManager({ ...BASE_CONFIG, spread: 0 });
        pm.open('long', 1.0, 1);
        pm.close(1.01, 2, 'SIGNAL');

        const stats = pm.getStats();
        expect(stats.equityCurve).toHaveLength(2);
        expect(stats.equityCurve[0]).toBe(BASE_CONFIG.initialCapital);
    });

    it('profitFactor is greater than 1 when gains outweigh losses', () => {
        const pm = new PositionManager({ ...BASE_CONFIG, spread: 0 });

        pm.open('long', 1.0, 1, 0.99);
        pm.close(1.04, 2, 'SIGNAL');

        pm.open('long', 1.04, 3, 1.03);
        pm.close(1.03, 4, 'SL_HIT');

        expect(pm.getStats().profitFactor).toBeGreaterThan(1);
    });

    it('computes a positive maxDrawdown after a losing trade follows a winner', () => {
        const pm = new PositionManager({ ...BASE_CONFIG, spread: 0 });

        pm.open('long', 1.0, 1, 0.99);
        pm.close(1.02, 2, 'SIGNAL');

        pm.open('long', 1.02, 3, 1.01);
        pm.close(1.01, 4, 'SL_HIT');

        const stats = pm.getStats();
        expect(stats.maxDrawdown).toBeGreaterThan(0);
        expect(stats.maxDrawdownPct).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// 11. forceCloseAtEnd()
// ---------------------------------------------------------------------------

describe('forceCloseAtEnd()', () => {
    it('closes the open position at candle.close with reason FORCE_CLOSE', () => {
        const pm = new PositionManager({ ...BASE_CONFIG, spread: 0 });
        pm.open('long', 1.2, 1);

        const lastCandle = candle(1.21, 1.215, 1.208, 1.212, 999);
        const closed = pm.forceCloseAtEnd(lastCandle);

        expect(closed!.exitReason).toBe('FORCE_CLOSE');
        expect(closed!.exitPrice).toBe(lastCandle.close);
        expect(pm.hasOpenPosition).toBe(false);
    });

    it('returns null when no position is open', () => {
        const pm = new PositionManager(BASE_CONFIG);
        expect(
            pm.forceCloseAtEnd(candle(1.2, 1.21, 1.19, 1.205, 1)),
        ).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// 12. Immutability of public snapshots
// ---------------------------------------------------------------------------

describe('Immutability', () => {
    it('activePosition snapshot does not expose internal state to mutation', () => {
        const pm = new PositionManager({ ...BASE_CONFIG, spread: 0 });
        pm.open('long', 1.2, 1);
        const originalSize = pm.activePosition!.size;

        const snap = pm.activePosition!;
        try {
            (snap as any).size = 9999;
        } catch {
            /* strict mode throws — expected */
        }

        expect(pm.activePosition!.size).toBe(originalSize);
    });

    it('trades snapshot does not expose internal array to mutation', () => {
        const pm = new PositionManager({ ...BASE_CONFIG, spread: 0 });
        pm.open('long', 1.2, 1);
        pm.close(1.21, 2, 'SIGNAL');

        const snapshot = pm.trades;
        try {
            (snapshot as any).push(null);
        } catch {
            /* frozen array throws */
        }

        expect(pm.trades).toHaveLength(1);
    });
});
