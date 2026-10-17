import { describe, expect, it } from 'vite-plus/test';
import { invitesAnyone, inviteesOf, mentionsInvitees, titleWithoutInvitees } from './invitees.ts';

describe('inviteesOf', () => {
  it('keeps the names under an invitation cue, as the model wrote them', () => {
    expect(inviteesOf(['Tom', 'Anna'], 'Lunch Tuesday at 1, invite Tom and Anna')).toEqual({
      invite: ['Tom', 'Anna'],
      uninvite: [],
    });
    expect(inviteesOf(['Sarah'], 'Invite Sarah to lunch on Tuesday').invite).toEqual(['Sarah']);
    expect(inviteesOf(['Tom'], 'send an invite to Tom for the review').invite).toEqual(['Tom']);
    expect(inviteesOf(['Tom'], 'Review Friday, add Tom as a guest').invite).toEqual(['Tom']);
    expect(inviteesOf(['tom@example.com'], 'Sync at 3, invite tom@example.com').invite).toEqual([
      'tom@example.com',
    ]);
  });

  it('reads addresses from the words, not a name the model cut out of one', () => {
    // Observed: Apple's model answered "Tom" for "invite tom@example.com".
    expect(inviteesOf(['Tom'], 'Team sync Monday 9am and invite Tom.Baker@Example.com.')).toEqual({
      invite: ['Tom.Baker@Example.com'],
      uninvite: [],
    });
    expect(inviteesOf([], 'invite Anna and bo@example.com').invite).toEqual(['bo@example.com']);
    // No cue, no address.
    expect(inviteesOf([], 'Call with bo@example.com').invite).toEqual([]);
    expect(inviteesOf([], 'remove bo@example.com').uninvite).toEqual(['bo@example.com']);
  });

  it('invites no one the words only mention', () => {
    // "with Sarah" is company, not an invitation.
    expect(inviteesOf(['Sarah'], 'Lunch with Sarah on Tuesday').invite).toEqual([]);
    expect(inviteesOf(['Sarah', 'Tom'], 'Lunch with Sarah Tuesday at 1, invite Tom')).toEqual({
      invite: ['Tom'],
      uninvite: [],
    });
    expect(inviteesOf(['Tom', 'Sarah'], 'invite Tom to lunch with Sarah').invite).toEqual(['Tom']);
    // In another sentence, the cue reaches no one.
    expect(inviteesOf(['Anna'], 'Invite the team. Anna presents.').invite).toEqual([]);
  });

  it('drops names that are not in the words, the user, pronouns and everyone', () => {
    expect(inviteesOf(['Tom Baker'], 'invite Tom').invite).toEqual([]);
    expect(inviteesOf(['me', 'her', 'everyone'], 'invite me, her and everyone').invite).toEqual([]);
    expect(inviteesOf(['', 'unknown', 'Tom'], 'invite Tom').invite).toEqual(['Tom']);
    // Part of another word is not the name.
    expect(inviteesOf(['Ann'], 'invite Anna').invite).toEqual([]);
    // The same name twice is one guest.
    expect(inviteesOf(['Tom', 'tom'], 'invite Tom').invite).toEqual(['Tom']);
  });

  it('takes a name as the words spell it', () => {
    // Observed: "Järg Möller" for "lade Jörg Müller ein".
    expect(inviteesOf(['Järg Möller'], 'Essen am Freitag, lade Jörg Müller ein').invite).toEqual([
      'Jörg Müller',
    ]);
    expect(inviteesOf(['zoé', 'TOM'], 'invite Zoë and Tom').invite).toEqual(['Zoë', 'Tom']);
    // Too short to tell apart, or not there at all.
    expect(inviteesOf(['Bo'], 'invite Ba').invite).toEqual([]);
    expect(inviteesOf(['Kim'], 'invite Tom').invite).toEqual([]);
  });

  it('reads German cues on either side of the names', () => {
    expect(inviteesOf(['Tom'], 'Mittagessen mit Sarah am Dienstag, lade Tom ein').invite).toEqual([
      'Tom',
    ]);
    expect(inviteesOf(['Tom', 'Anna'], 'Essen am Freitag, Tom und Anna einladen').invite).toEqual([
      'Tom',
      'Anna',
    ]);
    expect(inviteesOf(['Sarah', 'Tom'], 'Essen mit Sarah, Tom einladen').invite).toEqual(['Tom']);
    expect(inviteesOf(['Jörg'], 'Einladung an Jörg für Montag').invite).toEqual(['Jörg']);
  });

  it('reads who the words take off the guest list', () => {
    expect(inviteesOf(['Tom'], "don't invite Tom")).toEqual({ invite: [], uninvite: ['Tom'] });
    expect(inviteesOf(['Tom'], 'remove Tom')).toEqual({ invite: [], uninvite: ['Tom'] });
    expect(inviteesOf(['Anna', 'Tom'], 'invite Anna and remove Tom')).toEqual({
      invite: ['Anna'],
      uninvite: ['Tom'],
    });
    expect(inviteesOf(['Tom'], 'lade Tom aus').uninvite).toEqual(['Tom']);
    expect(inviteesOf(['Tom'], 'Tom nicht einladen').uninvite).toEqual(['Tom']);
    expect(inviteesOf(['Tom'], 'ohne Tom').uninvite).toEqual(['Tom']);
  });

  it('leaves out a name the words rule out after the cue', () => {
    // Review: both addresses were invited.
    expect(inviteesOf([], 'invite anna@example.com but not tom@example.com')).toEqual({
      invite: ['anna@example.com'],
      uninvite: [],
    });
    expect(inviteesOf(['Anna', 'Tom'], 'invite Anna instead of Tom').invite).toEqual(['Anna']);
    expect(inviteesOf(['Anna', 'Tom'], 'invite everyone except Tom, and Anna').invite).toEqual([]);
    expect(inviteesOf(['Anna', 'Tom'], 'lade Anna statt Tom ein').invite).toEqual(['Anna']);
    expect(inviteesOf(['Anna', 'Tom'], 'Anna und nicht Tom einladen').invite).toEqual(['Anna']);
    expect(inviteesOf(['Tom'], 'Tom nicht einladen').uninvite).toEqual(['Tom']);
    expect(inviteesOf(['Tom'], 'remove Anna but not Tom').uninvite).toEqual([]);
  });

  it('reads "add … as a guest" around an address', () => {
    // Review: the address's dot ended the cue's reach.
    expect(inviteesOf([], 'add tom@example.com as a guest').invite).toEqual(['tom@example.com']);
    expect(invitesAnyone('Sync at 3, add tom.baker@example.com as an attendee')).toBe(true);
    // A sentence end still stops it.
    expect(invitesAnyone('Add milk. Tom comes as a guest')).toBe(false);
  });

  it('takes off the guests an invitation is said not to happen for', () => {
    // Review: these invited the person they excluded.
    expect(inviteesOf([], 'do not add tom@example.com as a guest')).toEqual({
      invite: [],
      uninvite: ['tom@example.com'],
    });
    expect(inviteesOf([], 'lade tom@example.com nicht ein').uninvite).toEqual(['tom@example.com']);
    expect(inviteesOf(['Anna'], 'never invite Anna').uninvite).toEqual(['Anna']);
    expect(inviteesOf(['Tom'], 'why not invite Tom').invite).toEqual(['Tom']);
    // "nicht" before one name only rules that one out.
    expect(inviteesOf(['Anna', 'Tom'], 'lade Anna und nicht Tom ein')).toEqual({
      invite: ['Anna'],
      uninvite: [],
    });
  });

  it('reads a German list of guests past its commas', () => {
    // Review: the first comma hid the particle, and everyone was lost.
    expect(inviteesOf(['Tom', 'Anna', 'Bob'], 'lade Tom, Anna und Bob ein').invite).toEqual([
      'Tom',
      'Anna',
      'Bob',
    ]);
    expect(inviteesOf([], 'lade anna@example.com, bo@example.com ein').invite).toEqual([
      'anna@example.com',
      'bo@example.com',
    ]);
    // Two verbs: each name under its own.
    expect(inviteesOf(['Tom', 'Anna'], 'lade Tom ein und lade Anna aus')).toEqual({
      invite: ['Tom'],
      uninvite: ['Anna'],
    });
  });

  it('has no opinion about an address said under both', () => {
    // Review: the first place decided, so the removal was lost.
    expect(inviteesOf([], 'invite tom@example.com, then remove tom@example.com')).toEqual({
      invite: [],
      uninvite: [],
    });
  });

  it('has no opinion about a name said under both', () => {
    expect(inviteesOf(['Tom'], 'invite Tom, then remove Tom')).toEqual({
      invite: [],
      uninvite: [],
    });
  });

  it('says whether the words invite anyone, or take anyone off', () => {
    expect(mentionsInvitees('Lunch with Sarah')).toBe(false);
    expect(mentionsInvitees('and invite Tom')).toBe(true);
    expect(mentionsInvitees('Tom einladen')).toBe(true);
    expect(mentionsInvitees('Kaffee ohne Zucker')).toBe(true);
    expect(invitesAnyone('Kaffee ohne Zucker')).toBe(false);
    expect(invitesAnyone("don't invite Tom")).toBe(false);
    expect(invitesAnyone('lade Tom ein')).toBe(true);
  });
});

describe('titleWithoutInvitees', () => {
  it('cuts the invitation the model left in the title', () => {
    expect(titleWithoutInvitees('Lunch with Sarah, invite Tom', ['Tom'])).toBe('Lunch with Sarah');
    expect(titleWithoutInvitees('Lunch with Sarah and invite Tom and Anna', ['Anna'])).toBe(
      'Lunch with Sarah',
    );
    expect(titleWithoutInvitees('Essen mit Sarah, Tom einladen', ['Tom'])).toBe('Essen mit Sarah');
  });

  it('keeps what follows an invitation the title opens with', () => {
    // Observed: the whole phrase came back as the title.
    expect(
      titleWithoutInvitees('Invite Tom Baker to the planning meeting tomorrow at 3', ['Tom Baker']),
    ).toBe('Planning meeting tomorrow at 3');
    expect(titleWithoutInvitees('invite Tom, Anna and Bo for dinner', ['Tom', 'Anna', 'Bo'])).toBe(
      'Dinner',
    );
    // Someone not invited, or nothing after "to": the title stays.
    expect(titleWithoutInvitees('Invite Sarah to lunch', ['Tom'])).toBe('Invite Sarah to lunch');
    expect(titleWithoutInvitees('Invite Tom to', ['Tom'])).toBe('Invite Tom to');
  });

  it('keeps a title that is the invitation, or names no one invited', () => {
    expect(titleWithoutInvitees('Invite Tom', ['Tom'])).toBe('Invite Tom');
    expect(titleWithoutInvitees('Planning: invite list', ['Tom'])).toBe('Planning: invite list');
    expect(titleWithoutInvitees('Lunch with Sarah, invite Tom', [])).toBe(
      'Lunch with Sarah, invite Tom',
    );
  });
});
