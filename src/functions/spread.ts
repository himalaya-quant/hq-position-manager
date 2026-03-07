// =============================================================================
// spread.ts
// Helper for converting broker-advertised spread values to price units.
//
// Brokers advertise spread in pips. The PositionManager works in price units.
// This helper bridges the two without requiring the consumer to know the
// conversion formula.
//
// IMPORTANT: pip conventions are standardised for forex only.
// For crypto and other instruments, spread conventions vary by broker and
// exchange — pass the spread directly in price units instead:
//
//   // Forex — use Spread.fromPips with PipSize
//   spread: Spread.fromPips(0.06, PipSize.FOREX_MAJOR)
//
//   // Crypto — pass directly in price units (broker-specific)
//   spread: 6.46    // ICMarkets BTCUSD: $6.46 per unit
//   spread: 0       // Binance: spread is in the order book, not applied here
// =============================================================================

/**
 * Standard pip sizes for forex instruments.
 *
 * These values are universally standardised across all forex brokers.
 * Do NOT use these constants for crypto, indices, or commodities —
 * pip conventions for those instruments vary by broker.
 */
export const PipSize = Object.freeze({
    /**
     * Most forex pairs: EUR/USD, GBP/USD, USD/CAD, USD/CHF, AUD/USD, NZD/USD.
     * 1 pip = 0.0001
     */
    FOREX_MAJOR: 0.0001,

    /**
     * JPY pairs: USD/JPY, EUR/JPY, GBP/JPY.
     * 1 pip = 0.01
     */
    FOREX_JPY: 0.01,
});

export const Spread = Object.freeze({
    /**
     * Converts a forex spread expressed in pips to a spread in price units,
     * which is what PositionManager.config.spread expects.
     *
     * Use PipSize constants for the pipSize argument on standard forex pairs.
     * For crypto or other instruments, do not use this function — pass the
     * spread directly in price units instead.
     *
     * @param pips     Spread in pips, as shown in the broker's fee table
     *                 e.g. 0.06 for EURUSD on ICMarkets Raw
     * @param pipSize  Value of 1 pip in price units for the instrument.
     *                 Use PipSize constants for forex pairs.
     * @returns Spread in price units, ready for PositionManagerConfig.spread
     *
     * @example
     * // ICMarkets Raw — EURUSD (0.06 pip)
     * Spread.fromPips(0.06, PipSize.FOREX_MAJOR)  // → 0.000006
     *
     * // ICMarkets Standard — EURUSD (0.80 pip)
     * Spread.fromPips(0.80, PipSize.FOREX_MAJOR)  // → 0.00008
     *
     * // USD/JPY (0.60 pip)
     * Spread.fromPips(0.60, PipSize.FOREX_JPY)    // → 0.006
     */
    fromPips(pips: number, pipSize: number): number {
        if (pips < 0) {
            throw new Error(`Spread pips must be non-negative, got ${pips}`);
        }
        if (pipSize <= 0) {
            throw new Error(`Pip size must be positive, got ${pipSize}`);
        }
        return pips * pipSize;
    },
});
