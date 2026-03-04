// =============================================================================
// pnl.ts
// Pure helper functions for P&L calculations.
// Keeping these as standalone functions (not methods) makes them easily
// testable in isolation and reusable without depending on class internals.
// =============================================================================

import type { Direction, PartialExit } from '../types';

/**
 * Computes the signed price delta for a trade leg.
 * Long profits when price rises; short profits when price falls.
 */
export function priceDelta(
    direction: Direction,
    entryPrice: number,
    exitPrice: number,
): number {
    return direction === 'long'
        ? exitPrice - entryPrice
        : entryPrice - exitPrice;
}

/**
 * Computes P&L in currency for a number of units closed at a given price.
 *
 * @param direction    Trade direction
 * @param entryPrice   Adjusted entry price (already includes spread)
 * @param exitPrice    Price at which units are exited
 * @param closedSize   Number of units being closed
 * @param capitalAtOpen Capital snapshot at position open (used for pct)
 */
export function computePnl(
    direction: Direction,
    entryPrice: number,
    exitPrice: number,
    closedSize: number,
    capitalAtOpen: number,
): { pnlAbsolute: number; pnlPercentage: number } {
    const delta = priceDelta(direction, entryPrice, exitPrice);
    const pnlAbsolute = delta * closedSize;
    const pnlPercentage = pnlAbsolute / capitalAtOpen;
    return { pnlAbsolute, pnlPercentage };
}

/**
 * Aggregates P&L from all partial exits plus the final close leg.
 *
 * @param partialExits   Partial-exit records already on the position
 * @param finalPnl       P&L of the last (full residual) close operation
 * @param capitalAtOpen  Used for computing the aggregate percentage
 */
export function aggregatePnl(
    partialExits: ReadonlyArray<PartialExit>,
    finalPnl: number,
    capitalAtOpen: number,
): { pnlAbsolute: number; pnlPercentage: number } {
    const partialSum = partialExits.reduce(
        (acc, pe) => acc + pe.pnlAbsolute,
        0,
    );
    const pnlAbsolute = partialSum + finalPnl;
    const pnlPercentage = pnlAbsolute / capitalAtOpen;
    return { pnlAbsolute, pnlPercentage };
}
