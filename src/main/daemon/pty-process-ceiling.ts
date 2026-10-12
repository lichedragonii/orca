/**
 * An OS-enforced ceiling on how many processes the terminals of one daemon may run. Off by
 * default: it turns on only when `ORCA_TERMINAL_PROCESS_CEILING` names a limit, until saturation
 * tests show the daemon keeps serving with it on.
 *
 * Linux puts each PTY in its own transient scope under one slice that carries `TasksMax`, so the
 * kernel refuses forks past the limit with EAGAIN. The slice is a sibling of the daemon's own
 * scope: `pids.max` counts threads too, and the daemon must keep serving sockets, attach and
 * cancel while a build inside a terminal hits the ceiling.
 */
import { runProcessSync } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'
import { isDurableDaemonScopeSupported, userManagerEnv } from './daemon-cgroup-scope'
import { setPtyActiveProcessLimit } from '../windows/windows-pty-job'
import type { PtyProcessCeilingState } from './pty-process-ceiling-state'

export type { PtyProcessCeilingState } from './pty-process-ceiling-state'

export const PTY_PROCESS_CEILING_ENV = 'ORCA_TERMINAL_PROCESS_CEILING'
/** Below this a shell, its prompt hooks and one build step already collide. */
const MIN_CEILING = 64

type Runner = (
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv
) => Pick<ProcessResult, 'code' | 'timedOut'>

const defaultRunner: Runner = (program, args, env) =>
  runProcessSync({ program, args, env, stdio: 'ignore', timeoutMs: 5_000 })

export function parsePtyProcessCeiling(
  raw: string | undefined
): { kind: 'off' } | { kind: 'limit'; limit: number } | { kind: 'invalid' } {
  if (raw === undefined || raw.trim() === '' || raw.trim() === '0') {
    return { kind: 'off' }
  }
  const limit = Number(raw.trim())
  return Number.isSafeInteger(limit) && limit >= MIN_CEILING
    ? { kind: 'limit', limit }
    : { kind: 'invalid' }
}

/** No dashes: systemd reads `a-b.slice` as a child of `a.slice`, and this one must be top-level. */
export function ptyCeilingSliceName(launchId: string): string {
  return `orca_ptys_${launchId.replace(/[^A-Za-z0-9]/g, '_')}.slice`
}

/**
 * Decides once, at daemon start, whether this host gets a ceiling. Every failure is a named
 * "off", never a guess: a host without a user manager or linger keeps today's behaviour.
 */
export function resolvePtyProcessCeiling(input: {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  launchId: string
  scopeSupported?: () => boolean
  run?: Runner
  setWindowsLimit?: (limit: number) => boolean
}): PtyProcessCeilingState {
  const parsed = parsePtyProcessCeiling(input.env[PTY_PROCESS_CEILING_ENV])
  if (parsed.kind === 'off') {
    return { state: 'off', reason: 'disabled' }
  }
  if (parsed.kind === 'invalid') {
    return { state: 'off', reason: 'invalid_limit' }
  }
  if (input.platform === 'win32') {
    return input.setWindowsLimit?.(parsed.limit)
      ? { state: 'on', limit: parsed.limit, mechanism: 'windows-job', unit: null }
      : { state: 'off', reason: 'native_unavailable' }
  }
  if (input.platform !== 'linux') {
    return { state: 'off', reason: 'unsupported_platform' }
  }
  if (!(input.scopeSupported ?? isDurableDaemonScopeSupported)()) {
    return { state: 'off', reason: 'no_user_manager' }
  }
  const slice = ptyCeilingSliceName(input.launchId)
  try {
    const result = (input.run ?? defaultRunner)(
      'busctl',
      [
        '--user',
        'call',
        'org.freedesktop.systemd1',
        '/org/freedesktop/systemd1',
        'org.freedesktop.systemd1.Manager',
        'StartTransientUnit',
        'ssa(sv)a(sa(sv))',
        slice,
        'fail',
        '1',
        'TasksMax',
        't',
        String(parsed.limit),
        '0'
      ],
      userManagerEnv(input.env)
    )
    return result.code === 0 && !result.timedOut
      ? { state: 'on', limit: parsed.limit, mechanism: 'systemd-slice', unit: slice }
      : { state: 'off', reason: 'slice_unavailable' }
  } catch {
    return { state: 'off', reason: 'slice_unavailable' }
  }
}

let current: PtyProcessCeilingState = { state: 'off', reason: 'disabled' }
let scopeCounter = 0

export function setPtyProcessCeiling(state: PtyProcessCeilingState): void {
  current = state
}

export function currentPtyProcessCeiling(): PtyProcessCeilingState {
  return current
}

/**
 * Linux only: the PTY execs through `systemd-run --scope`, which keeps its pid and exit status,
 * into a scope under the ceiling slice. Anything else spawns exactly as before.
 */
export function wrapPtySpawnForCeiling(
  file: string,
  args: string[],
  env: Record<string, string>,
  state: PtyProcessCeilingState = current
): { file: string; args: string[]; env: Record<string, string> } {
  if (state.state !== 'on' || state.mechanism !== 'systemd-slice' || !state.unit) {
    return { file, args, env }
  }
  scopeCounter += 1
  const scopeEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(userManagerEnv(env))) {
    if (typeof value === 'string') {
      scopeEnv[key] = value
    }
  }
  return {
    file: 'systemd-run',
    args: [
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      `--slice=${state.unit}`,
      `--unit=orca_pty_${process.pid}_${scopeCounter}.scope`,
      '--',
      file,
      ...args
    ],
    env: scopeEnv
  }
}

/** Daemon start: decide, remember for every spawn, and return what the pid record reports. */
export function initializePtyProcessCeiling(launchId: string): PtyProcessCeilingState {
  const state = resolvePtyProcessCeiling({
    env: process.env,
    platform: process.platform,
    launchId: launchId || `${process.pid}`,
    setWindowsLimit: setPtyActiveProcessLimit
  })
  setPtyProcessCeiling(state)
  return state
}
