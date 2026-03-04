// =============================================================================
// index.ts
// Public API surface of the position-manager module.
// Only export what consumers need — internal helpers stay private.
// =============================================================================

export { PositionManager } from './PositionManager';

export type {
    OHLC,
    Direction,
    SLTPChange,
    ExitReason,
    PartialExit,
    OpenPosition,
    PendingSignal,
    BacktestStats,
    ClosedPosition,
    PositionManagerConfig,
} from './types';
