import { describe, expect, it, vi } from 'vitest'
import {
  parsePtyProcessCeiling,
  PTY_PROCESS_CEILING_ENV,
  resolvePtyProcessCeiling,
  wrapPtySpawnForCeiling
} from './pty-process-ceiling'
import { describePtyProcessCeiling, parsePtyProcessCeilingState } from './pty-process-ceiling-state'
import { parseDaemonPidFile } from './daemon-pid-file-parse'

const on = { [PTY_PROCESS_CEILING_ENV]: '2048' }

describe('resolvePtyProcessCeiling', () => {
  it('is off by default and refuses limits too small to run a shell', () => {
    expect(resolvePtyProcessCeiling({ env: {}, platform: 'linux', launchId: 'a' })).toEqual({
      state: 'off',
      reason: 'disabled'
    })
    expect(parsePtyProcessCeiling('0')).toEqual({ kind: 'off' })
    expect(
      resolvePtyProcessCeiling({
        env: { [PTY_PROCESS_CEILING_ENV]: '10' },
        platform: 'linux',
        launchId: 'a'
      })
    ).toEqual({ state: 'off', reason: 'invalid_limit' })
  })

  it('degrades with a reason on hosts without a user manager or linger, and on macOS', () => {
    const run = vi.fn()
    expect(
      resolvePtyProcessCeiling({
        env: on,
        platform: 'linux',
        launchId: 'a',
        scopeSupported: () => false,
        run
      })
    ).toEqual({ state: 'off', reason: 'no_user_manager' })
    expect(run).not.toHaveBeenCalled()
    expect(resolvePtyProcessCeiling({ env: on, platform: 'darwin', launchId: 'a' })).toEqual({
      state: 'off',
      reason: 'unsupported_platform'
    })
  })

  it('creates a top-level slice with TasksMax, separate from the daemon scope', () => {
    const run = vi.fn((_program: string, _args: string[]) => ({ code: 0, timedOut: false }))
    const state = resolvePtyProcessCeiling({
      env: on,
      platform: 'linux',
      launchId: '1f-2e',
      scopeSupported: () => true,
      run
    })
    expect(state).toEqual({
      state: 'on',
      limit: 2048,
      mechanism: 'systemd-slice',
      unit: 'orca_ptys_1f_2e.slice'
    })
    expect(run.mock.calls[0]?.[0]).toBe('busctl')
    expect(run.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['StartTransientUnit', 'orca_ptys_1f_2e.slice', 'TasksMax', '2048'])
    )
    expect(
      resolvePtyProcessCeiling({
        env: on,
        platform: 'linux',
        launchId: 'a',
        scopeSupported: () => true,
        run: () => ({ code: 1, timedOut: false })
      })
    ).toEqual({ state: 'off', reason: 'slice_unavailable' })
  })

  it('uses the per-terminal job limit on Windows only when the native build has it', () => {
    expect(
      resolvePtyProcessCeiling({
        env: on,
        platform: 'win32',
        launchId: 'a',
        setWindowsLimit: () => true
      })
    ).toEqual({ state: 'on', limit: 2048, mechanism: 'windows-job', unit: null })
    expect(
      resolvePtyProcessCeiling({
        env: on,
        platform: 'win32',
        launchId: 'a',
        setWindowsLimit: () => false
      })
    ).toEqual({ state: 'off', reason: 'native_unavailable' })
  })
})

describe('wrapPtySpawnForCeiling', () => {
  it('leaves the spawn untouched while off', () => {
    const env = { TERM: 'xterm' }
    expect(
      wrapPtySpawnForCeiling('/bin/bash', ['-l'], env, { state: 'off', reason: 'disabled' })
    ).toEqual({ file: '/bin/bash', args: ['-l'], env })
  })

  it('execs the shell through systemd-run into the ceiling slice, keeping its argv', () => {
    const wrapped = wrapPtySpawnForCeiling(
      '/bin/bash',
      ['-l'],
      { TERM: 'xterm', DBUS_SESSION_BUS_ADDRESS: 'disabled:' },
      { state: 'on', limit: 2048, mechanism: 'systemd-slice', unit: 'orca_ptys_a.slice' }
    )
    expect(wrapped.file).toBe('systemd-run')
    expect(wrapped.args).toEqual(
      expect.arrayContaining(['--user', '--scope', '--slice=orca_ptys_a.slice'])
    )
    expect(wrapped.args.slice(-3)).toEqual(['--', '/bin/bash', '-l'])
    expect(wrapped.env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
    expect(wrapped.env.TERM).toBe('xterm')
  })
})

describe('ceiling report', () => {
  it('round-trips through the daemon pid record and reads old records as not reported', () => {
    const record = parseDaemonPidFile(
      JSON.stringify({ pid: 7, processCeiling: { state: 'off', reason: 'no_user_manager' } })
    )
    expect(record?.processCeiling).toEqual({ state: 'off', reason: 'no_user_manager' })
    expect(parseDaemonPidFile(JSON.stringify({ pid: 7 }))?.processCeiling).toBeNull()
    expect(parsePtyProcessCeilingState({ state: 'off', reason: 'made-up' })).toBeNull()
    expect(describePtyProcessCeiling(null)).toBe('not reported')
    expect(describePtyProcessCeiling({ state: 'off', reason: 'no_user_manager' })).toBe(
      'off (no user manager)'
    )
  })
})
