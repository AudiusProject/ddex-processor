import { expect, test, vi } from 'vitest'
import { getSdk, getSdkNetworkConfig } from './sdk'

test('getSdkNetworkConfig requires an explicit publishing env', () => {
  expect(() => getSdkNetworkConfig(undefined)).toThrow(
    'source env is required for DDEX publishing with @audius/sdk v15'
  )
})

test('getSdkNetworkConfig preserves production publishing writes', () => {
  expect(getSdkNetworkConfig('production')).toEqual({
    environment: 'production',
  })
})

test('getSdkNetworkConfig preserves development publishing writes', () => {
  expect(getSdkNetworkConfig('development')).toEqual({
    environment: 'development',
  })
})

test('getSdkNetworkConfig fails fast for unsupported staging publishing writes', () => {
  expect(() => getSdkNetworkConfig('staging')).toThrow(
    'staging DDEX publishing is not supported by @audius/sdk v15'
  )
})

test('getSdk surfaces unsupported staging publishing writes', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

  expect(() =>
    getSdk({
      env: 'staging',
      name: 'source-1',
      ddexKey: '0x0000000000000000000000000000000000000001',
      ddexSecret: '0000000000000000000000000000000000000001',
      labelUserIds: {},
    } as any)
  ).toThrow('staging DDEX publishing is not supported by @audius/sdk v15')

  logSpy.mockRestore()
})
