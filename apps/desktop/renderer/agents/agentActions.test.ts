import { describe, expect, it } from 'vite-plus/test';
import { agentActionQuestion, agentsErrorMessage } from './agentActions.ts';

describe('agentActionQuestion', () => {
  it('says a new token cuts the agent off until it gets it', () => {
    expect(agentActionQuestion('rotate', 'Hermes', 0)).toEqual({
      confirm: 'Replace token',
      detail:
        'The current token stops working now: Hermes cannot connect until you give it the new one.',
      title: 'Replace the token for “Hermes”?',
    });
  });

  it('says what a removal deletes and counts the waiting requests it cancels', () => {
    expect(agentActionQuestion('remove', 'Hermes', 0).detail).toBe(
      'Its token stops working now and its access is deleted. Adding it again needs a new token and new access.',
    );
    expect(agentActionQuestion('remove', 'Hermes', 1).detail).toContain(
      'Its request waiting for you is cancelled.',
    );
    expect(agentActionQuestion('remove', 'Hermes', 3).detail).toContain(
      'Its 3 requests waiting for you are cancelled.',
    );
    expect(agentActionQuestion('remove', 'Hermes', 0).title).toBe('Remove “Hermes”?');
  });
});

describe('agentsErrorMessage', () => {
  it("drops Electron's remote-method wrapper", () => {
    expect(
      agentsErrorMessage(
        new Error("Error invoking remote method 'agents:state': Error: database is locked"),
      ),
    ).toBe('database is locked');
    expect(
      agentsErrorMessage(
        new Error("Error invoking remote method 'agents:state': SqlError: no such table"),
      ),
    ).toBe('no such table');
    expect(agentsErrorMessage('plain')).toBe('plain');
  });
});
