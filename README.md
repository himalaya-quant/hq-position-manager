# HimalayaQuant Position Manager

Stateful position lifecycle manager for backtesting engines. Handles open, monitor, partial close, and close operations for a single trading position, with built-in P&L accounting, position sizing, and SL/TP evaluation.

Part of the **HimalayaQuant** backtest engine, this library has **no runtime dependencies**

---

## Contents

- [Overview](#overview)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [API](#api)
    - [registerSignal](#registersignal)
    - [evaluateCandle](#evaluatecandle)
    - [open](#open)
    - [partialClose](#partialclose)
    - [close](#close)
    - [updateStopLoss / updateTakeProfit](#updatestoplosspupdatetakeprofit)
    - [forceCloseAtEnd](#forcecloseatend)
    - [getStats](#getstats)
    - [Getters](#getters)
- [Position Sizing](#position-sizing)
- [Design Decisions](#design-decisions)

---

## Overview

The `PositionManager` sits between the strategy layer and raw market data. The strategy decides _when_ and _where_ to trade — the manager handles everything else.

```
Strategy Layer          PositionManager            Market Data
──────────────    ──────────────────────────    ──────────────
registerSignal ──▶  pending signal queue
                    ↓ (next candle open)
                    open()  ◀────────────────── OHLC.open
                    evaluateCandle() ◀────────── OHLC candle
                      ├─ update trailing stop
                      ├─ check SL hit
                      └─ check TP hit
partialClose() ──▶  reduce size, update capital
close()        ──▶  aggregate P&L, emit ClosedPosition
getStats()     ──▶  BacktestStats
```

**What it does not do:** it has no knowledge of signal logic, indicators, or any analytical tool. It receives instructions and executes them.

---

## Installation

```bash
npm i @himalaya-quant/position-manager
```

---

## Quick Start

complete runnable example is in [`example.ts`](./src/examples/example.ts)

```typescript
import { PositionManager } from '@himalaya-quant/position-manager';

const pm = new PositionManager({
    initialCapital: 10_000,
    riskPerTrade: 0.02, // 2% of capital at risk per trade
    fallbackAllocation: 0.1, // 10% allocated when no SL is provided
    spread: 0.0002, // 2 pip spread on EUR/USD
    trailingStop: 0.005, // optional: 50 pip trailing stop
});

// ── Backtest loop ──────────────────────────────────────────────────────────

for (const candle of candles) {
    // 1. Your strategy decides when to act
    if (shouldEnter(candle) && !pm.hasOpenPosition) {
        pm.registerSignal({
            direction: 'long',
            stopLoss: candle.close - 0.005,
            takeProfit: candle.close + 0.015,
            createdAtTimestamp: candle.timestamp,
        });
    }

    // 2. Manager handles everything else
    const closed = pm.evaluateCandle(candle);
    if (closed) {
        console.log(
            `Trade closed: ${closed.exitReason}, P&L: ${closed.pnlAbsolute.toFixed(2)}€`,
        );
    }

    // 3. Optional: manual SL/TP adjustments mid-trade
    if (pm.hasOpenPosition && shouldMoveSL(candle)) {
        pm.updateStopLoss(newSLPrice);
    }
}

// ── End of backtest ────────────────────────────────────────────────────────

pm.forceCloseAtEnd(candles.at(-1)!);
console.log(pm.getStats());
```

---

## Configuration

`PositionManagerConfig` is passed to the constructor and is immutable for the lifetime of the backtest.

| Property             | Type      | Description                                                                                                                                                                                 |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialCapital`     | `number`  | Starting capital in currency (EUR, USD, etc..)                                                                                                                                              |
| `riskPerTrade`       | `number`  | Fraction of capital at risk per trade, e.g. `0.02` = 2%. Used only when an SL is present.                                                                                                   |
| `fallbackAllocation` | `number`  | Fraction of capital allocated when no SL is provided, e.g. `0.10` = 10%. See [Position Sizing](#position-sizing).                                                                           |
| `spread`             | `number`  | Fixed spread in price units. e.g. `0.0002` = 2 pip on EUR/USD. Applied asymmetrically on entry.                                                                                             |
| `trailingStop`       | `number?` | Distance of the trailing stop from the most favourable price, in **price units** (same unit as `entryPrice`). `0.0050` = 50 pip on EUR/USD, `50.0` = 50 points on S&P 500. Omit to disable. |

---

## API

### registerSignal

```typescript
pm.registerSignal(signal: PendingSignal): void
```

Queues a signal to be materialised at the **next** `evaluateCandle` call, using that candle's open price as entry. This is the mechanism that prevents lookahead bias — see [Design Decisions](#no-entry-at-signal-candle-t--t1).

```typescript
pm.registerSignal({
    direction: 'long',
    stopLoss: 1.195, // optional
    takeProfit: 1.22, // optional
    createdAtTimestamp: candle.timestamp,
});
```

If `registerSignal` is called a second time before the signal is consumed, the new signal silently overwrites the previous one. If your strategy requires different behaviour, check `pm.hasPendingSignal` before calling.

---

### evaluateCandle

```typescript
pm.evaluateCandle(candle: OHLC): ClosedPosition | null
```

The main loop step. Call once per candle, in chronological order. Internally executes the following sequence — **order is critical**:

1. **Materialise pending signal** — opens a position at `candle.open` if a signal was registered on the previous candle.
2. **Update trailing stop** — advances the trailing SL to the new extreme (if configured).
3. **Check SL** — uses `candle.low` for longs, `candle.high` for shorts.
4. **Check TP** — uses `candle.high` for longs, `candle.low` for shorts.
5. **Return** — `ClosedPosition` if a SL/TP was hit this candle, `null` otherwise.

---

### open

```typescript
pm.open(direction, entryPrice, timestamp, sl?, tp?): void
```

Opens a position directly, without a pending signal. Useful when the strategy wants immediate entry rather than T+1.

- Spread is applied to `entryPrice` before storing (see [Spread Application](#spread-application)).
- Size is calculated automatically from the config (see [Position Sizing](#position-sizing)).
- SL and TP, if provided, are validated against the adjusted entry price before the position opens.

Throws if a position is already open.

---

### partialClose

```typescript
pm.partialClose(exitPrice, timestamp, sizeToClose): PartialExit
```

Closes a portion of the open position. Capital is updated immediately. The partial exit is recorded and will be included in the final `ClosedPosition` when the trade is fully closed.

`sizeToClose` must be **strictly less than** the current remaining size. To close the entire position, use `close()`.

Throws if no position is open, or if `sizeToClose >= currentSize`.

---

### close

```typescript
pm.close(exitPrice, timestamp, reason: ExitReason): ClosedPosition
```

Closes the entire remaining position. Aggregates P&L from all prior partial exits plus the final lot. Capital is updated and the position is cleared.

`ExitReason` values: `'SL_HIT'` | `'TP_HIT'` | `'SIGNAL'` | `'FORCE_CLOSE'`

Throws if no position is open.

---

### updateStopLoss / updateTakeProfit

```typescript
pm.updateStopLoss(newSL: number | undefined): void
pm.updateTakeProfit(newTP: number | undefined): void
```

Modifies the SL or TP of the active position. Every change is appended to `slHistory` with old and new values.

Pass `undefined` to remove the level entirely.

**Validation rules:**

|     | Long                    | Short                   |
| --- | ----------------------- | ----------------------- |
| SL  | must be `<= entryPrice` | must be `>= entryPrice` |
| TP  | must be `> entryPrice`  | must be `< entryPrice`  |

> **Breakeven stop:** placing SL exactly at `entryPrice` is valid. The check uses `>` (strict) for long and `<` (strict) for short, so `SL === entryPrice` is intentionally allowed.

Both methods throw if no position is open.

---

### forceCloseAtEnd

```typescript
pm.forceCloseAtEnd(lastCandle: OHLC): ClosedPosition | null
```

Closes any open position at `lastCandle.close` with reason `FORCE_CLOSE`. Call this after the loop to clean up positions left open at the end of the backtest period. Returns `null` if no position is open.

---

### getStats

```typescript
pm.getStats(): BacktestStats
```

Computes and returns aggregate metrics over all closed trades. Recalculated on every call — not cached.

| Property         | Description                                               |
| ---------------- | --------------------------------------------------------- |
| `totalTrades`    | Total number of closed trades                             |
| `winningTrades`  | Trades with `pnlAbsolute > 0`                             |
| `losingTrades`   | Trades with `pnlAbsolute < 0`                             |
| `winRate`        | `winningTrades / totalTrades` (0–1)                       |
| `profitFactor`   | Sum of gains / sum of losses. `> 1` = profitable strategy |
| `avgWin`         | Average P&L of winning trades in €                        |
| `avgLoss`        | Average P&L of losing trades in € (absolute value)        |
| `riskReward`     | `avgWin / avgLoss`                                        |
| `maxDrawdown`    | Maximum peak-to-valley loss on the equity curve, in €     |
| `maxDrawdownPct` | Maximum peak-to-valley loss as % of the peak capital      |
| `finalCapital`   | Capital after all closed trades                           |
| `totalReturn`    | `(finalCapital - initialCapital) / initialCapital`        |
| `equityCurve`    | Capital after each trade, starting with `initialCapital`  |

---

### Getters

| Property           | Type                                      | Description                                             |
| ------------------ | ----------------------------------------- | ------------------------------------------------------- |
| `hasOpenPosition`  | `boolean`                                 | `true` if a position is currently active                |
| `hasPendingSignal` | `boolean`                                 | `true` if a signal is queued for the next candle        |
| `capital`          | `number`                                  | Current capital, updated after every (partial) close    |
| `activePosition`   | `Readonly<OpenPosition> \| null`          | Frozen snapshot of the active position. See note below. |
| `trades`           | `ReadonlyArray<Readonly<ClosedPosition>>` | Frozen copy of all closed trades.                       |

> `activePosition` and `trades` return **immutable snapshots**. Mutating the returned objects will either throw (strict mode) or have no effect on the manager's internal state. Never rely on the reference persisting across calls — always read from the getter.

---

## Position Sizing

Size is calculated automatically on every `open()`. It is never a free parameter.

### With SL — Risk-Based Sizing

```
riskInEuro = currentCapital × riskPerTrade
slDistance = |entryPrice − stopLoss|
size       = riskInEuro / slDistance
```

The size is chosen so that a full SL hit loses exactly `riskPerTrade × currentCapital`. Risk stays constant as a fraction of capital regardless of how capital evolves over the backtest.

**Example:** 10,000€ capital, 2% risk, entry 1.2002, SL 1.1950 → distance 0.0052 → size = 200 / 0.0052 = **38,461 units**.

### Without SL — Fallback Allocation

```
allocatedCapital = currentCapital × fallbackAllocation
size             = allocatedCapital / entryPrice
```

Without an SL, there is no price level at which the manager exits automatically. The worst-case loss equals the full allocated amount — `fallbackAllocation × currentCapital` — if the price reaches zero. This is not comparable to the controlled risk of the SL-based approach. **Prefer risk-based sizing whenever possible.**

### Spread Application

Spread is applied to the entry price before sizing and before SL/TP validation:

| Direction | Adjusted Entry                                  |
| --------- | ----------------------------------------------- |
| Long      | `entryPrice + spread` (buyer pays the ask)      |
| Short     | `entryPrice − spread` (seller receives the bid) |

Exit prices are not adjusted for spread, as it is implicitly embedded in the OHLC mid prices.

---

## Design Decisions

This section documents behaviours that are **intentional by design**. Please read before opening an issue.

---

### No entry at signal candle (T → T+1)

`registerSignal()` never opens a position immediately. The signal is queued and materialised at the `open` price of the **next** candle.

**Why:** a signal generated at candle T uses data up to and including T. The close price of T was not available when the signal was being evaluated — it emerged as a result of the move that triggered the signal. Entering at `close[T]` introduces lookahead bias and produces unrealistically positive backtest results.

The `open[T+1]` is the first price realistically accessible after the signal is confirmed.

---

### One position at a time

Attempting to open a second position while one is already active throws an error.

**Why:** multiple concurrent positions multiply complexity non-linearly — aggregated exposure, per-position capital allocation, interaction between SL/TP levels. This constraint keeps equity curves clean, capital accounting unambiguous, and results interpretable. Multiple positions may be added as a future extension but are out of scope for this component.

---

### SL takes priority over TP on the same candle

When a single candle's range covers both the SL and the TP level (e.g. `low <= SL` and `high >= TP` on a long), the position is closed at the SL with reason `SL_HIT`.

**Why:** we cannot know the intracandle order of events from OHLC data alone. Assuming the best case (TP hit first) would overstate performance. Assuming the worst case (SL hit first) is the conservative and reproducible choice.

---

### partialClose requires strictly less than full size

`partialClose(exitPrice, timestamp, sizeToClose)` throws if `sizeToClose >= currentSize`.

**Why:** closing exactly 100% of the remaining size is semantically a full close, not a partial one. Allowing it would leave a position open with `size = 0` — a state that is neither flat nor active, which causes undefined behaviour in P&L calculations and makes `hasOpenPosition` misleading. Use `close()` to shut the position entirely.

---

### Breakeven stop is valid

`updateStopLoss(entryPrice)` is allowed. The SL validation uses strict inequality (`>` for long, `<` for short), so placing the stop exactly at entry is intentional and will not throw.

---

### Trailing stop logs to slHistory

Every automatic trailing stop update is recorded in `slHistory` with the same structure as a manual SL change. This is by design — the audit trail does not distinguish between manual and automatic updates. Filter by timestamp range or cross-reference with candle data if you need to separate the two.

---

### Spread is only applied on entry

The exit price is not adjusted for spread. OHLC mid prices implicitly include half the spread on each side; applying it again on exit would double-count the cost. The entry adjustment (paying ask on long, receiving bid on short) captures the full round-trip cost at open.

---

### getStats() is computed on demand

Stats are recalculated from scratch on every `getStats()` call. There is no incremental state. This trades a small amount of CPU for guaranteed correctness — stale or partially-updated stat objects are not possible.

---

### Pending signal is overwritten silently

Calling `registerSignal()` twice before `evaluateCandle()` replaces the first signal with the second, without error. The manager has no opinion on whether this is correct — that decision belongs to the strategy. Check `pm.hasPendingSignal` before registering if your strategy requires a different policy.

---

<br/>
<br/>
<p align="center">Developed with ❤️ by Caius Citiriga</p>
