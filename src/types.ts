// =============================================================================
// types.ts
// Core types and data structures for the PositionManager.
// All types are kept in one file for cohesion; they are logically grouped
// from primitive → composite → config → output.
// =============================================================================

// ---------------------------------------------------------------------------
// Primitive types
// ---------------------------------------------------------------------------

/** Trade direction. */
export type Direction = 'long' | 'short';

/**
 * Reason a position was closed.
 * - SL_HIT    : stop-loss level was breached
 * - TP_HIT    : take-profit level was reached
 * - SIGNAL    : strategy explicitly requested the close
 * - FORCE_CLOSE: position was force-closed at end of backtest
 */
export type ExitReason = 'SL_HIT' | 'TP_HIT' | 'SIGNAL' | 'FORCE_CLOSE';

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

/** Single OHLC candle passed to evaluateCandle on every loop step. */
export interface OHLC {
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
    /** Unix timestamp in milliseconds. */
    readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Signal
// ---------------------------------------------------------------------------

/**
 * Signal generated at candle T that will be materialised at candle T+1.
 * This is the mechanism that prevents lookahead bias on the entry price.
 */
export interface PendingSignal {
    readonly direction: Direction;
    /** Absolute stop-loss price (optional). */
    readonly stopLoss?: number;
    /** Absolute take-profit price (optional). */
    readonly takeProfit?: number;
    /** Timestamp of the candle that generated the signal. */
    readonly createdAtTimestamp: number;
}

// ---------------------------------------------------------------------------
// Position lifecycle records
// ---------------------------------------------------------------------------

/** Record produced each time a partial close is executed. */
export interface PartialExit {
    readonly exitPrice: number;
    readonly exitTimestamp: number;
    /** Number of units closed in this operation. */
    readonly closedSize: number;
    /** P&L in currency (€) for the units closed. */
    readonly pnlAbsolute: number;
    /** P&L as a percentage of capitalAtOpen. */
    readonly pnlPercentage: number;
}

/** Audit-trail entry for every SL or TP modification. */
export interface SLTPChange {
    readonly timestamp: number;
    readonly type: 'SL' | 'TP';
    /** Previous level — undefined if the level was not previously set. */
    readonly oldValue: number | undefined;
    /** New level — undefined if the level was removed. */
    readonly newValue: number | undefined;
}

/** Internal state of an active position. Mutated throughout its lifetime. */
export interface OpenPosition {
    readonly direction: Direction;
    /** Entry price already adjusted for spread. */
    readonly entryPrice: number;
    /** Timestamp of opening (T+1 relative to the signal candle). */
    readonly entryTimestamp: number;
    /** Currently open units (decreases with each partial close). */
    size: number;
    /** Original size at opening — never changes. */
    readonly initialSize: number;
    /** Capital snapshot at the moment of opening. */
    readonly capitalAtOpen: number;
    stopLoss?: number;
    takeProfit?: number;
    /** Accumulated partial-exit records. Replaced (not mutated) on each partial close. */
    partialExits: ReadonlyArray<PartialExit>;
    /** Full audit trail of SL/TP modifications. Replaced (not mutated) on each change. */
    slHistory: ReadonlyArray<SLTPChange>;
}

/** Final record of a completed trade (extends OpenPosition with close data). */
export interface ClosedPosition extends Omit<OpenPosition, 'size'> {
    /** Final (or only) exit price. */
    readonly exitPrice: number;
    readonly exitTimestamp: number;
    readonly exitReason: ExitReason;
    /** Total P&L in currency, aggregating all partial exits and the final close. */
    readonly pnlAbsolute: number;
    /** Total P&L as a percentage of capitalAtOpen. */
    readonly pnlPercentage: number;
    /** Remaining size that was closed in the final operation. */
    readonly finalClosedSize: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Immutable configuration passed to the PositionManager constructor. */
export interface PositionManagerConfig {
    /** Starting capital in currency (€). */
    readonly initialCapital: number;
    /**
     * Fraction of current capital risked per trade (e.g. 0.02 = 2%).
     * Used for risk-based sizing when SL is present.
     */
    readonly riskPerTrade: number;
    /**
     * Fraction of capital allocated when no SL is provided (e.g. 0.10 = 10%).
     * Fallback sizing only — used when the strategy opens a position without a
     * stop-loss level.
     *
     * Because there is no SL, there is no price level at which the manager will
     * automatically exit the trade. The worst-case loss for that trade therefore
     * equals the full allocated amount (fallbackAllocation × currentCapital) —
     * for example 10% of capital if the price goes to zero — rather than the
     * controlled percentage defined by riskPerTrade.
     *
     * Prefer risk-based sizing (i.e. always provide an SL) whenever possible.
     */
    readonly fallbackAllocation: number;
    /** Fixed spread in price units (e.g. 0.0002 for 2 pip on EUR/USD). */
    readonly spread: number;
    /**
     * Distance of the trailing stop from the most favourable price reached,
     * expressed in **price units** — the same unit as `entryPrice`, `stopLoss`,
     * and all other price fields.
     *
     * Examples:
     *   - EUR/USD, 50 pip trail  → 0.0050  (1 pip = 0.0001)
     *   - S&P 500, 50 point trail → 50.0
     *
     * The consumer is responsible for passing the correct value for the
     * instrument being traded — no unit conversion is applied internally.
     *
     * Undefined means trailing stop is disabled.
     */
    readonly trailingStop?: number;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Aggregate backtest metrics returned by getStats(). Computed on demand. */
export interface BacktestStats {
    readonly totalTrades: number;
    readonly winningTrades: number;
    readonly losingTrades: number;
    /** Ratio of winners to total trades (0–1). */
    readonly winRate: number;
    /** Sum of gains / sum of losses (absolute). Values > 1 indicate profitability. */
    readonly profitFactor: number;
    /** Average P&L of winning trades in currency. */
    readonly avgWin: number;
    /** Average P&L of losing trades in currency (absolute value). */
    readonly avgLoss: number;
    /** avgWin / avgLoss — realised risk-reward ratio. */
    readonly riskReward: number;
    /** Maximum peak-to-valley drawdown on the equity curve in currency. */
    readonly maxDrawdown: number;
    /** Maximum peak-to-valley drawdown as a percentage of the peak capital. */
    readonly maxDrawdownPct: number;
    readonly finalCapital: number;
    /** Total return as a percentage of initialCapital. */
    readonly totalReturn: number;
    /** Capital after each closed trade (first element = initialCapital). */
    readonly equityCurve: number[];
}
