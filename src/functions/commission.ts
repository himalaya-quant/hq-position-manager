// =============================================================================
// commission.ts
// Commission model type and factory functions for different broker structures.
//
// A CommissionModel is a plain function — the PositionManager calls it at
// trade time with the actual price and size, and receives the commission
// amount in account currency. This makes the model broker-agnostic: any
// pricing structure can be represented as a function.
//
// Usage:
//   import { Commission } from './commission';
//
//   // ICMarkets Raw Forex — fixed per lot per side
//   commissionModel: Commission.perLot(3.0, 100_000)
//
//   // Binance / Bybit — percentage of notional
//   commissionModel: Commission.percentageOfNotional(0.001)
// =============================================================================

/**
 * A function that computes the commission for a single trade leg
 * (one side — open OR close, not both).
 *
 * Called at trade time with the actual execution price and size.
 * Returns the commission amount in account currency.
 *
 * @param price  Execution price of the trade leg
 * @param size   Number of units being traded in this leg
 * @returns      Commission in account currency (always positive)
 */
export type CommissionModel = (price: number, size: number) => number;

export const Commission = Object.freeze({
    /**
     * Fixed commission per lot, per side. Common on Raw Spread accounts
     * (e.g. ICMarkets cTrader: $3 per standard lot per side).
     *
     * @param amountPerLotPerSide  Commission in account currency per lot per side
     *                             e.g. 3.0 for ICMarkets Raw ($3/lot/side)
     * @param lotSize              Number of units in one lot
     *                             e.g. 100_000 for forex standard lot, 1 for crypto
     * @returns CommissionModel ready for PositionManagerConfig.commissionModel
     *
     * @example
     * // ICMarkets Raw — Forex standard lot
     * Commission.perLot(3.0, 100_000)
     *
     * // ICMarkets Raw — Forex micro lot (0.01)
     * Commission.perLot(3.0, 100_000)  // same — size passed at trade time handles scaling
     */
    perLot(amountPerLotPerSide: number, lotSize: number): CommissionModel {
        if (amountPerLotPerSide < 0) {
            throw new Error(
                `Commission amount must be non-negative, got ${amountPerLotPerSide}`,
            );
        }
        if (lotSize <= 0) {
            throw new Error(`Lot size must be positive, got ${lotSize}`);
        }
        return (_price: number, size: number) =>
            (size / lotSize) * amountPerLotPerSide;
    },

    /**
     * Percentage of the trade notional value, per side.
     * Common on crypto spot and futures exchanges (Binance, Bybit, etc.).
     *
     * @param feeRate  Fee as a decimal fraction
     *                 e.g. 0.001 for 0.1% (Binance maker/taker)
     * @returns CommissionModel ready for PositionManagerConfig.commissionModel
     *
     * @example
     * // Binance Futures — 0.05% maker, 0.10% taker
     * Commission.percentageOfNotional(0.0005)  // maker
     * Commission.percentageOfNotional(0.001)   // taker
     *
     * // Bybit — 0.1% taker
     * Commission.percentageOfNotional(0.001)
     */
    percentageOfNotional(feeRate: number): CommissionModel {
        if (feeRate < 0) {
            throw new Error(`Fee rate must be non-negative, got ${feeRate}`);
        }
        return (price: number, size: number) => price * size * feeRate;
    },

    /**
     * No commission. Use when the broker embeds all costs in the spread
     * (e.g. ICMarkets Standard Account, or crypto where spread covers cost).
     *
     * This is the default when commissionModel is omitted from config.
     */
    none(): CommissionModel {
        return () => 0;
    },
});
