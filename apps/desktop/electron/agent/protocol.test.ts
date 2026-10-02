import { describe, expect, it } from 'vitest';
import { agentSocketPath } from './protocol.ts';

describe('agentSocketPath', () => {
  it('keeps the packaged app and a dev build on different sockets', () => {
    expect(agentSocketPath({ env: {}, home: '/home/nik', packaged: true })).toBe(
      '/home/nik/.solunivo/run/agent.sock',
    );
    expect(agentSocketPath({ env: {}, home: '/home/nik', packaged: false })).toBe(
      '/home/nik/.solunivo/run/agent-dev.sock',
    );
  });

  it('lets CALENDAR_AGENT_SOCKET override both', () => {
    const env = { CALENDAR_AGENT_SOCKET: '/tmp/profile/agent.sock' };
    for (const packaged of [true, false]) {
      expect(agentSocketPath({ env, home: '/home/nik', packaged })).toBe('/tmp/profile/agent.sock');
    }
  });
});
