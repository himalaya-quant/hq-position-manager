// =============================================================================
// index.ts
// Public API surface of the position-manager module.
// Only export what consumers need — internal helpers stay private.
// =============================================================================

export { PositionManager } from './PositionManager';
export { Spread, PipSize } from './functions/spread';
export { Commission } from './functions/commission';

export type {
    BacktestStats,
    ClosedPosition,
    CommissionModel,
    Direction,
    ExitReason,
    OHLC,
    OpenPosition,
    PartialExit,
    PendingSignal,
    PositionManagerConfig,
    SLTPChange,
} from './types';
