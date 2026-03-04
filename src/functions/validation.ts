// =============================================================================
// validation.ts
// Guard functions that enforce business rules on SL, TP, and capital.
// Centralising validation here prevents duplication across methods and
// makes rules easy to audit in a single place.
// =============================================================================

import type { Direction } from '../types';

/**
 * Validates a new stop-loss level against the position's entry price and
 * direction.  Uses strict inequality (>) so that breakeven stops — where
 * SL equals entry — are permitted.
 *
 * @throws If the SL would be on the wrong side of the entry price
 */
export function validateStopLoss(
    newSL: number,
    entryPrice: number,
    direction: Direction,
): void {
    if (direction === 'long' && newSL > entryPrice) {
        throw new Error(
            `Invalid SL for long: ${newSL} must be below entry price ${entryPrice}`,
        );
    }
    if (direction === 'short' && newSL < entryPrice) {
        throw new Error(
            `Invalid SL for short: ${newSL} must be above entry price ${entryPrice}`,
        );
    }
}

/**
 * Validates a new take-profit level against the position's entry price and
 * direction.
 *
 * @throws If the TP would be on the wrong side of the entry price
 */
export function validateTakeProfit(
    newTP: number,
    entryPrice: number,
    direction: Direction,
): void {
    if (direction === 'long' && newTP <= entryPrice) {
        throw new Error(
            `Invalid TP for long: ${newTP} must be above entry price ${entryPrice}`,
        );
    }
    if (direction === 'short' && newTP >= entryPrice) {
        throw new Error(
            `Invalid TP for short: ${newTP} must be below entry price ${entryPrice}`,
        );
    }
}

/**
 * Ensures the current capital is positive before attempting to open a
 * position.  Exhausted or negative capital must block any new trade.
 *
 * @throws If capital is zero or negative
 */
export function validateCapital(currentCapital: number): void {
    if (currentCapital <= 0) {
        throw new Error(
            `Cannot open position: capital exhausted (${currentCapital})`,
        );
    }
}
