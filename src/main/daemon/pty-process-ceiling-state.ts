/** What a daemon reports about its terminal process ceiling; additive in the pid record and health. */
export type PtyProcessCeilingOffReason =
  | 'disabled'
  | 'invalid_limit'
  | 'unsupported_platform'
  | 'no_user_manager'
  | 'slice_unavailable'
  | 'native_unavailable'

export type PtyProcessCeilingState =
  | { state: 'on'; limit: number; mechanism: 'systemd-slice' | 'windows-job'; unit: string | null }
  | { state: 'off'; reason: PtyProcessCeilingOffReason }

const OFF_REASONS: readonly PtyProcessCeilingOffReason[] = [
  'disabled',
  'invalid_limit',
  'unsupported_platform',
  'no_user_manager',
  'slice_unavailable',
  'native_unavailable'
]

export function parsePtyProcessCeilingState(value: unknown): PtyProcessCeilingState | null {
  if (typeof value !== 'object' || value === null || !('state' in value)) {
    return null
  }
  if (value.state === 'off') {
    const reason =
      'reason' in value ? OFF_REASONS.find((entry) => entry === value.reason) : undefined
    return reason ? { state: 'off', reason } : null
  }
  if (
    value.state === 'on' &&
    'limit' in value &&
    typeof value.limit === 'number' &&
    'mechanism' in value &&
    (value.mechanism === 'systemd-slice' || value.mechanism === 'windows-job')
  ) {
    const unit = 'unit' in value && typeof value.unit === 'string' ? value.unit : null
    return { state: 'on', limit: value.limit, mechanism: value.mechanism, unit }
  }
  return null
}

export function describePtyProcessCeiling(state: PtyProcessCeilingState | null): string {
  if (!state) {
    return 'not reported'
  }
  return state.state === 'on'
    ? `on (${state.limit} processes, ${state.mechanism === 'systemd-slice' ? `systemd ${state.unit ?? 'slice'}` : 'per-terminal job'})`
    : `off (${state.reason.replace(/_/g, ' ')})`
}
