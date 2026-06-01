import { expect, test } from 'vitest'

import {
  ClaimableHandleRequiredError,
  defaultClaimableHandle,
} from './createUserPublish'

test('defaultClaimableHandle uses ASCII artist names directly', () => {
  expect(defaultClaimableHandle('DJ Theo')).toBe('DJTheo')
})

test('defaultClaimableHandle returns no handle for non-ASCII artist names', () => {
  expect(defaultClaimableHandle('ОСОБО ТЯЖКИЙ')).toBeUndefined()
})

test('defaultClaimableHandle preserves dots in artist names', () => {
  expect(defaultClaimableHandle('DJ Theo Jr.')).toBe('DJTheoJr.')
})

test('ClaimableHandleRequiredError explains the operator action', () => {
  expect(new ClaimableHandleRequiredError('ОСОБО ТЯЖКИЙ').message).toContain(
    'Set audiusHandle in the UI'
  )
})
