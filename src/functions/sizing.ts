// =============================================================================
// sizing.ts
// Pure functions for position sizing.
// Two strategies are supported: risk-based (when SL is present) and
// fallback-allocation (when SL is absent).  Keeping sizing logic separate
// from the manager class respects the Single-Responsibility Principle.
// =============================================================================

import type { PositionManagerConfig } from '../types';

/**
 * Calculates position size using risk-based sizing.
 * The size is chosen so that a full SL hit results in exactly
 * (currentCapital * riskPerTrade) of loss.
 *
 * @param entryPrice    Adjusted entry price
 * @param stopLoss      SL price (must be on the correct side of entry)
 * @param currentCapital Current portfolio capital
 * @param config         Manager configuration
 * @returns Size in units
 * @throws If SL distance is zero (entry === stopLoss)
 */
export function riskBasedSize(
    entryPrice: number,
    stopLoss: number,
    currentCapital: number,
    config: Pick<PositionManagerConfig, 'riskPerTrade'>,
): number {
    const slDistance = Math.abs(entryPrice - stopLoss);
    if (slDistance === 0) {
        throw new Error('SL distance is zero — cannot compute risk-based size');
    }
    const riskInCurrency = currentCapital * config.riskPerTrade;
    return riskInCurrency / slDistance;
}

/**
 * Calculates position size using a fixed capital-allocation fallback.
 * Used when no SL is provided.  The actual trade risk is undefined in
 * this mode — prefer risk-based sizing whenever possible.
 *
 * @param entryPrice     Adjusted entry price
 * @param currentCapital Current portfolio capital
 * @param config         Manager configuration
 * @returns Size in units
 * @throws If entryPrice is zero or negative
 */
export function fallbackAllocationSize(
    entryPrice: number,
    currentCapital: number,
    config: Pick<PositionManagerConfig, 'fallbackAllocation'>,
): number {
    if (entryPrice <= 0) {
        throw new Error('Entry price must be positive for fallback allocation');
    }
    const allocatedCapital = currentCapital * config.fallbackAllocation;
    return allocatedCapital / entryPrice;
}

/**
 * Resolves the correct sizing strategy based on whether a SL is present,
 * then returns the computed size.
 */
export function resolveSize(
    entryPrice: number,
    stopLoss: number | undefined,
    currentCapital: number,
    config: PositionManagerConfig,
): number {
    return stopLoss !== undefined
        ? riskBasedSize(entryPrice, stopLoss, currentCapital, config)
        : fallbackAllocationSize(entryPrice, currentCapital, config);
}
