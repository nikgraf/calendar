/// <reference types="node" />
import { transformFileSync } from '@babel/core';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

interface Worklet {
  (...args: Array<unknown>): unknown;
  readonly __closure: Record<string, unknown>;
  readonly __initData: { readonly code: string };
}

const coreSource = (file: string) =>
  path.resolve(import.meta.dirname, '../../../packages/core/src', file);

/**
 * The module's exports as the worklets babel plugin builds them for the app,
 * with its imports stubbed: each worklet carries the code string and the
 * captured values the UI runtime receives.
 */
const workletExports = (
  file: string,
  imports: Record<string, unknown>,
): Record<string, Worklet> => {
  const require = createRequire(import.meta.url);
  const result = transformFileSync(coreSource(file), {
    babelrc: false,
    configFile: false,
    plugins: [
      require.resolve('react-native-worklets/plugin'),
      require.resolve('@babel/plugin-transform-modules-commonjs'),
    ],
    presets: [require.resolve('@babel/preset-typescript')],
  });
  const module = { exports: {} as Record<string, Worklet> };
  vm.runInNewContext(result!.code!, {
    exports: module.exports,
    // Dev builds tag each worklet with a stack for error reports.
    global: { Error },
    module,
    require: (specifier: string) => imports[specifier],
  });
  return module.exports;
};

/**
 * The function as the UI runtime rebuilds it: only its code string, in a
 * scope without the module's bindings, with the captured values on `this`.
 */
const onUiRuntime =
  (worklet: Worklet) =>
  (...args: Array<unknown>): unknown => {
    const rebuilt = vm.runInNewContext(`(${worklet.__initData.code})`) as Worklet;
    return rebuilt.apply({ __closure: worklet.__closure }, args);
  };

describe('core worklets on the UI runtime', () => {
  const slots = workletExports('time/slotSelection.ts', {
    './dragMath.ts': { DRAG_SNAP_MINUTES: 15 },
  });

  it('runs the slot helpers with their defaults, as the iOS gestures call them', () => {
    expect(onUiRuntime(slots.minuteOfDay!)(96, 48)).toBe(120);
    expect(onUiRuntime(slots.slotFromHold!)(607, 610)).toEqual({
      endMinute: 660,
      startMinute: 600,
    });
    expect(onUiRuntime(slots.slotFromDrag!)(607, 680)).toEqual({
      endMinute: 690,
      startMinute: 600,
    });
    expect(onUiRuntime(slots.slotTimes!)({ endMinute: 1440, startMinute: 600 })).toEqual({
      endTime: '23:59',
      startTime: '10:00',
    });
  });
});
