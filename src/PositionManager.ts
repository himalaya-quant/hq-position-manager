// =============================================================================
// PositionManager.ts
// Stateful manager responsible for the full lifecycle of a single trading
// position: open → monitor → partial close → close.
//
// Responsibilities:
//   - Materialising pending signals with T+1 entry (no lookahead bias)
//   - Spread-adjusted entry pricing
//   - Risk-based and fallback position sizing
//   - Candle-by-candle SL/TP evaluation (worst-case first)
//   - Trailing stop updates
//   - P&L accounting and capital tracking
//   - Immutable read-only access to internal state
//
// The manager has NO knowledge of strategy logic, signals origins, or
// market analysis tools.  All decisions are delegated to the consumer.
// =============================================================================

import type {
    BacktestStats,
    ClosedPosition,
    Direction,
    OHLC,
    OpenPosition,
    PartialExit,
    PendingSignal,
    PositionManagerConfig,
} from './types';

import { aggregatePnl, computePnl } from './functions/pnl';
import { resolveSize } from './functions/sizing';
import { computeStats } from './functions/stats';
import { Commission } from './functions/commission';
import type { CommissionModel } from './types';
import {
    validateCapital,
    validateStopLoss,
    validateTakeProfit,
} from './functions/validation';

export class PositionManager {
    // ---------------------------------------------------------------------------
    // Private state
    // ---------------------------------------------------------------------------

    private readonly config: PositionManagerConfig;

    /**
     * Resolved commission model — defaults to Commission.none() when
     * commissionModel is omitted from config.
     */
    private readonly _commissionModel: CommissionModel;

    private _capital: number;

    /** Active open position — null when flat. */
    private _position: OpenPosition | null = null;

    /** Signal queued from the previous candle — materialised at next evaluateCandle. */
    private _pendingSignal: PendingSignal | null = null;

    /** All completed trades in chronological order. */
    private _trades: ClosedPosition[] = [];

    /**
     * High-water mark for trailing stop on long positions.
     * Tracks the highest high seen since position open.
     */
    private _highWaterMark: number | null = null;

    /**
     * Low-water mark for trailing stop on short positions.
     * Tracks the lowest low seen since position open.
     */
    private _lowWaterMark: number | null = null;

    // ---------------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------------

    constructor(config: PositionManagerConfig) {
        if (config.initialCapital <= 0) {
            throw new Error('initialCapital must be positive');
        }
        if (config.riskPerTrade <= 0 || config.riskPerTrade >= 1) {
            throw new Error('riskPerTrade must be in the range (0, 1)');
        }
        if (config.fallbackAllocation <= 0 || config.fallbackAllocation >= 1) {
            throw new Error('fallbackAllocation must be in the range (0, 1)');
        }
        if (config.spread < 0) {
            throw new Error('spread must be non-negative');
        }
        if (config.trailingStop !== undefined && config.trailingStop <= 0) {
            throw new Error('trailingStop must be positive when defined');
        }

        this.config = Object.freeze({ ...config });
        this._commissionModel = config.commissionModel ?? Commission.none();
        this._capital = config.initialCapital;
    }

    // ---------------------------------------------------------------------------
    // Public getters (read-only, immutable snapshots)
    // ---------------------------------------------------------------------------

    /** True if there is an active open position. */
    get hasOpenPosition(): boolean {
        return this._position !== null;
    }

    /** True if a signal is queued and waiting to be materialised. */
    get hasPendingSignal(): boolean {
        return this._pendingSignal !== null;
    }

    /** Current portfolio capital, updated after every (partial) close. */
    get capital(): number {
        return this._capital;
    }

    /**
     * Frozen snapshot of the active position, or null when flat.
     * The returned object is immutable — mutations will throw in strict mode.
     */
    get activePosition(): Readonly<OpenPosition> | null {
        return this._position !== null
            ? Object.freeze({ ...this._position })
            : null;
    }

    /**
     * Frozen copy of all closed trades.
     * The array itself and every element are immutable.
     */
    get trades(): ReadonlyArray<Readonly<ClosedPosition>> {
        return Object.freeze([...this._trades]);
    }

    // ---------------------------------------------------------------------------
    // Public setters
    // ---------------------------------------------------------------------------
    /**
     * Allows to forcefully sync the capital from outside. This is useful when
     * you want to still use the position manager for sizing, and tracking, but
     * you have a different capital source of truth. Eg. your broker in paper,
     * or an external RiskManager that handles multiple positions at once, where
     * each position has its own PositionManager, but the capital is shared
     * across all positions
     *
     * @param capital
     */
    syncCapital(capital: number): void {
        if (capital <= 0) {
            throw new Error(`received non-positive capital: ${capital}`);
        }

        this._capital = capital;
    }

    // ---------------------------------------------------------------------------
    // Signal registration
    // ---------------------------------------------------------------------------

    /**
     * Registers a new pending signal to be materialised at the NEXT candle open.
     * Calling this method does NOT open a position immediately — it merely queues
     * the intent.  The strategy is responsible for deciding whether to overwrite
     * an existing pending signal.
     *
     * @param signal PendingSignal generated at candle T
     */
    registerSignal(signal: PendingSignal): void {
        this._pendingSignal = { ...signal };
    }

    // ---------------------------------------------------------------------------
    // Main loop step
    // ---------------------------------------------------------------------------

    /**
     * Core loop step — must be called once per candle in chronological order.
     *
     * Execution order (critical — reversing this produces incorrect results):
     *   1. Materialise pending signal using candle.open as entry (T → T+1)
     *   2. Update trailing stop with current candle's extreme
     *   3. Check SL hit (worst-case first)
     *   4. Check TP hit
     *   5. Return null if no event occurred
     *
     * @param candle Current OHLC candle
     * @returns ClosedPosition if the position was closed on this candle, else null
     */
    evaluateCandle(candle: OHLC): ClosedPosition | null {
        // Step 1 — Materialise pending signal
        this._materialisePendingSignal(candle);

        // Nothing more to do if no position is open
        if (this._position === null) {
            return null;
        }

        // Step 2 — Update trailing stop before checking SL/TP
        this._updateTrailingStop(candle);

        const pos = this._position;

        // Step 3 — SL check (worst-case first)
        // For a long: SL is hit when candle.low dips at or below the SL level.
        // For a short: SL is hit when candle.high rises at or above the SL level.
        if (pos.stopLoss !== undefined) {
            const slHit =
                pos.direction === 'long'
                    ? candle.low <= pos.stopLoss
                    : candle.high >= pos.stopLoss;

            if (slHit) {
                return this.close(pos.stopLoss, candle.timestamp, 'SL_HIT');
            }
        }

        // Step 4 — TP check
        // For a long: TP is hit when candle.high reaches or exceeds the TP level.
        // For a short: TP is hit when candle.low drops to or below the TP level.
        if (pos.takeProfit !== undefined) {
            const tpHit =
                pos.direction === 'long'
                    ? candle.high >= pos.takeProfit
                    : candle.low <= pos.takeProfit;

            if (tpHit) {
                return this.close(pos.takeProfit, candle.timestamp, 'TP_HIT');
            }
        }

        // Step 5 — No event
        return null;
    }

    // ---------------------------------------------------------------------------
    // Position lifecycle methods
    // ---------------------------------------------------------------------------

    /**
     * Opens a new position.
     *
     * The entry price is adjusted for spread asymmetrically:
     *   Long  → entryPrice + spread  (buyer pays the ask)
     *   Short → entryPrice - spread  (seller receives the bid)
     *
     * Size is computed automatically via risk-based or fallback allocation.
     *
     * @param direction   Trade direction
     * @param entryPrice  Raw open price of the entry candle (spread applied internally)
     * @param timestamp   Timestamp of the entry candle
     * @param sl          Optional stop-loss in absolute price
     * @param tp          Optional take-profit in absolute price
     * @throws If a position is already open, capital is exhausted, or SL/TP are invalid
     */
    open(
        direction: Direction,
        entryPrice: number,
        timestamp: number,
        sl?: number,
        tp?: number,
    ): void {
        if (this._position !== null) {
            throw new Error(
                'Cannot open a new position while one is already active. ' +
                    'Close the current position first.',
            );
        }

        validateCapital(this._capital);

        // Apply spread asymmetrically based on direction.
        // Spread is in price units — add for long (buyer pays ask),
        // subtract for short (seller receives bid).
        const adjustedEntry =
            direction === 'long'
                ? entryPrice + this.config.spread
                : entryPrice - this.config.spread;

        // Validate SL/TP against the adjusted entry price before sizing
        if (sl !== undefined) {
            validateStopLoss(sl, adjustedEntry, direction);
        }
        if (tp !== undefined) {
            validateTakeProfit(tp, adjustedEntry, direction);
        }

        const size = resolveSize(adjustedEntry, sl, this._capital, this.config);

        // Deduct open-leg commission before snapshotting capitalAtOpen,
        // so that capitalAtOpen already reflects the net available capital.
        const openCommission = this._commissionModel(adjustedEntry, size);
        this._capital -= openCommission;

        this._position = {
            direction,
            entryPrice: adjustedEntry,
            entryTimestamp: timestamp,
            size,
            initialSize: size,
            capitalAtOpen: this._capital,
            stopLoss: sl,
            takeProfit: tp,
            partialExits: [],
            slHistory: [],
            commissionPaid: openCommission,
        };

        // Initialise trailing stop water marks
        if (this.config.trailingStop !== undefined) {
            this._highWaterMark = adjustedEntry;
            this._lowWaterMark = adjustedEntry;
        }
    }

    /**
     * Closes a portion of the open position.
     *
     * Validates that sizeToClose is strictly less than the current remaining
     * size (use close() to shut the position entirely).  Capital is updated
     * immediately with the partial P&L.
     *
     * @param exitPrice   Price at which units are closed
     * @param timestamp   Candle timestamp of the close
     * @param sizeToClose Number of units to close
     * @returns PartialExit record for this operation
     * @throws If no position is open, or sizeToClose >= remaining size
     */
    partialClose(
        exitPrice: number,
        timestamp: number,
        sizeToClose: number,
    ): PartialExit {
        if (this._position === null) {
            throw new Error('No open position to partially close');
        }
        if (sizeToClose <= 0) {
            throw new Error('sizeToClose must be positive');
        }
        if (sizeToClose >= this._position.size) {
            throw new Error(
                `sizeToClose (${sizeToClose}) must be strictly less than the ` +
                    `current remaining size (${this._position.size}). ` +
                    'Use close() to shut the entire position.',
            );
        }

        const pos = this._position;
        const exitCommission = this._commissionModel(exitPrice, sizeToClose);
        const { pnlAbsolute: grossPnl, pnlPercentage: grossPct } = computePnl(
            pos.direction,
            pos.entryPrice,
            exitPrice,
            sizeToClose,
            pos.capitalAtOpen,
        );

        // P&L is net of commission — what the trader actually receives
        const pnlAbsolute = grossPnl - exitCommission;
        const pnlPercentage = pnlAbsolute / pos.capitalAtOpen;

        const partialExit: PartialExit = Object.freeze({
            exitPrice,
            exitTimestamp: timestamp,
            closedSize: sizeToClose,
            pnlAbsolute,
            pnlPercentage,
            commissionPaid: exitCommission,
        });

        // Mutate position state
        pos.size -= sizeToClose;
        pos.partialExits = [...pos.partialExits, partialExit];
        pos.commissionPaid += exitCommission;

        // Update capital with net P&L (gross movement minus commission)
        this._capital += pnlAbsolute;

        return partialExit;
    }

    /**
     * Closes the entire remaining position and produces a ClosedPosition record.
     *
     * Aggregates P&L from all partial exits plus the final residual close.
     * Capital is updated, the position is cleared, and water marks are reset.
     *
     * @param exitPrice Final exit price
     * @param timestamp Candle timestamp of the close
     * @param reason    ExitReason classifying the cause of closure
     * @returns The final ClosedPosition record (also appended to this.trades)
     * @throws If no position is open
     */
    close(
        exitPrice: number,
        timestamp: number,
        reason: import('./types').ExitReason,
    ): ClosedPosition {
        if (this._position === null) {
            throw new Error('No open position to close');
        }

        const pos = this._position;

        // Commission on the close leg
        const exitCommission = this._commissionModel(exitPrice, pos.size);

        // Gross P&L for the residual size (the final lot)
        const { pnlAbsolute: grossFinalLegPnl } = computePnl(
            pos.direction,
            pos.entryPrice,
            exitPrice,
            pos.size,
            pos.capitalAtOpen,
        );

        // Net P&L for the final leg after deducting close commission
        const netFinalLegPnl = grossFinalLegPnl - exitCommission;

        // Aggregate net P&L across all partial exits and the final leg
        const { pnlAbsolute, pnlPercentage } = aggregatePnl(
            pos.partialExits,
            netFinalLegPnl,
            pos.capitalAtOpen,
        );

        // Total commission for the entire trade lifecycle
        const totalCommission = pos.commissionPaid + exitCommission;

        const closedPosition: ClosedPosition = Object.freeze({
            direction: pos.direction,
            entryPrice: pos.entryPrice,
            entryTimestamp: pos.entryTimestamp,
            // initialSize preserved; size field is replaced by finalClosedSize
            initialSize: pos.initialSize,
            finalClosedSize: pos.size,
            capitalAtOpen: pos.capitalAtOpen,
            stopLoss: pos.stopLoss,
            takeProfit: pos.takeProfit,
            partialExits: Object.freeze([...pos.partialExits]),
            slHistory: Object.freeze([...pos.slHistory]),
            exitPrice,
            exitTimestamp: timestamp,
            exitReason: reason,
            pnlAbsolute,
            pnlPercentage,
            commissionPaid: totalCommission,
        });

        // Update capital with net final leg P&L
        this._capital += netFinalLegPnl;

        // Record and reset
        this._trades = [...this._trades, closedPosition];
        this._position = null;
        this._highWaterMark = null;
        this._lowWaterMark = null;

        return closedPosition;
    }

    // ---------------------------------------------------------------------------
    // SL / TP modification
    // ---------------------------------------------------------------------------

    /**
     * Updates the stop-loss of the active position.
     * The new value is validated against the entry price and direction, then
     * logged to slHistory for full audit traceability.
     *
     * Uses strict inequality (>) to permit breakeven stops (SL === entry).
     *
     * @param newSL New stop-loss price, or undefined to remove the SL
     * @throws If no position is open or the new SL is invalid
     */
    updateStopLoss(newSL: number | undefined): void {
        if (this._position === null) {
            throw new Error('Cannot update SL: no open position');
        }

        if (newSL !== undefined) {
            validateStopLoss(
                newSL,
                this._position.entryPrice,
                this._position.direction,
            );
        }

        this._logSLTPChange('SL', this._position.stopLoss, newSL);
        this._position.stopLoss = newSL;
    }

    /**
     * Updates the take-profit of the active position.
     * Validates and logs the change to slHistory (same audit trail as SL).
     *
     * @param newTP New take-profit price, or undefined to remove the TP
     * @throws If no position is open or the new TP is invalid
     */
    updateTakeProfit(newTP: number | undefined): void {
        if (this._position === null) {
            throw new Error('Cannot update TP: no open position');
        }

        if (newTP !== undefined) {
            validateTakeProfit(
                newTP,
                this._position.entryPrice,
                this._position.direction,
            );
        }

        this._logSLTPChange('TP', this._position.takeProfit, newTP);
        this._position.takeProfit = newTP;
    }

    // ---------------------------------------------------------------------------
    // Statistics
    // ---------------------------------------------------------------------------

    /**
     * Computes and returns aggregate backtest statistics over all closed trades.
     * Recalculated on every call (not cached) to guarantee accuracy.
     */
    getStats(): BacktestStats {
        return computeStats(
            this._trades,
            this.config.initialCapital,
            this._capital,
        );
    }

    // ---------------------------------------------------------------------------
    // Force close (end-of-backtest utility)
    // ---------------------------------------------------------------------------

    /**
     * Force-closes the open position using the last available candle's close
     * price.  Intended for use at the end of a backtest when no exit signal
     * has been generated for the remaining open trade.
     *
     * @param lastCandle The final candle of the backtest
     * @returns ClosedPosition with reason FORCE_CLOSE, or null if no position open
     */
    forceCloseAtEnd(lastCandle: OHLC): ClosedPosition | null {
        if (this._position === null) {
            return null;
        }
        return this.close(
            lastCandle.close,
            lastCandle.timestamp,
            'FORCE_CLOSE',
        );
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    /**
     * Materialises a queued pending signal by calling open() with the current
     * candle's open price.  Clears the pending signal afterwards regardless of
     * outcome.
     */
    private _materialisePendingSignal(candle: OHLC): void {
        if (this._pendingSignal === null) {
            return;
        }

        const signal = this._pendingSignal;
        this._pendingSignal = null; // Always clear before open() to avoid re-entry on error

        this.open(
            signal.direction,
            candle.open,
            candle.timestamp,
            signal.stopLoss,
            signal.takeProfit,
        );
    }

    /**
     * Updates the trailing stop for the active position based on the candle's
     * extreme price.  Only executes if trailingStop is configured and a
     * position is open.
     *
     * The trailing SL update is recorded in slHistory for full traceability.
     */
    private _updateTrailingStop(candle: OHLC): void {
        if (this.config.trailingStop === undefined || this._position === null) {
            return;
        }

        const pos = this._position;
        const distance = this.config.trailingStop;

        if (pos.direction === 'long') {
            // Move water mark up if the current candle sets a new high
            if (
                this._highWaterMark === null ||
                candle.high > this._highWaterMark
            ) {
                this._highWaterMark = candle.high;
                const newSL = this._highWaterMark - distance;
                this._logSLTPChange('SL', pos.stopLoss, newSL);
                pos.stopLoss = newSL;
            }
        } else {
            // Move water mark down if the current candle sets a new low
            if (
                this._lowWaterMark === null ||
                candle.low < this._lowWaterMark
            ) {
                this._lowWaterMark = candle.low;
                const newSL = this._lowWaterMark + distance;
                this._logSLTPChange('SL', pos.stopLoss, newSL);
                pos.stopLoss = newSL;
            }
        }
    }

    /**
     * Appends a SLTPChange audit entry to the active position's slHistory.
     * Called by updateStopLoss, updateTakeProfit, and _updateTrailingStop.
     */
    private _logSLTPChange(
        type: 'SL' | 'TP',
        oldValue: number | undefined,
        newValue: number | undefined,
    ): void {
        if (this._position === null) return;

        const entry = Object.freeze({
            timestamp: Date.now(), // wall-clock for the audit log; candle timestamp is on the OHLC
            type,
            oldValue,
            newValue,
        });

        this._position.slHistory = [...this._position.slHistory, entry];
    }
}
