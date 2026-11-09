/**
 * Kinds of place, folded as `foldSearchText` leaves them: what a place is
 * said by when it has no name to say ("at the office", "at home", "im
 * Büro"), and what a name holds beside its own words ("Hotel Sacher",
 * "Loos Bar"). English says the kind last ("the big meeting room"),
 * German first when a name follows ("Café Prückel"). Only built places:
 * "club", "market", "store" and "library" are as often no place at all
 * ("book club", "app store"), "Praxis" is "in practice" too, and "Hof" is
 * a square ("Am Hof").
 */
export const PLACE_KINDS: ReadonlySet<string> = new Set([
  'airport',
  'apartment',
  'arena',
  'backyard',
  'ballroom',
  'bar',
  'basement',
  'boardroom',
  'cafe',
  'cafeteria',
  'campus',
  'canteen',
  'center',
  'centre',
  'church',
  'cinema',
  'classroom',
  'clinic',
  'garage',
  'garden',
  'gym',
  'hall',
  'home',
  'hospital',
  'hotel',
  'house',
  'kitchen',
  'lab',
  'lobby',
  'lounge',
  'mall',
  'museum',
  'office',
  'park',
  'pool',
  'pub',
  'restaurant',
  'room',
  'school',
  'stadium',
  'station',
  'studio',
  'theater',
  'theatre',
  'university',
  // German, and the compounds as common as the word they end in.
  'arztpraxis',
  'bad',
  'bahnhof',
  'besprechungsraum',
  'besprechungszimmer',
  'bibliothek',
  'buro',
  'fitnessstudio',
  'flughafen',
  'garten',
  'gasthaus',
  'halle',
  'hallenbad',
  'haus',
  'kaffeehaus',
  'kantine',
  'kanzlei',
  'keller',
  'kindergarten',
  'kino',
  'kirche',
  'klinik',
  'konferenzraum',
  'krankenhaus',
  'kuche',
  'lokal',
  'mensa',
  'oper',
  'ordination',
  'raum',
  'saal',
  'schule',
  'schwimmbad',
  'seminarraum',
  'sitzungsraum',
  'sitzungszimmer',
  'spital',
  'stadion',
  'uni',
  'universitat',
  'werkstatt',
  'wirtshaus',
  'wohnung',
  'wohnzimmer',
  'zahnarztpraxis',
  'zentrum',
  'zimmer',
]);

/**
 * The kinds a town has one of, or one that everybody means: said alone
 * they still name a place a search knows ("airport" is the airport,
 * "Uni" the university), where "hotel", "office" or "Kino" names the
 * one the speaker has in mind.
 */
export const ONE_IN_TOWN: ReadonlySet<string> = new Set([
  'airport',
  'arena',
  'bahnhof',
  'flughafen',
  'oper',
  'stadion',
  'stadium',
  'uni',
  'universitat',
  'university',
]);

/**
 * German builds a place as one word, its kind last ("Konzerthaus",
 * "Hauptbahnhof", "Tanzschule", "Yogastudio"). Never "-raum" ("Zeitraum",
 * "Albtraum"), "-praxis" ("Berufspraxis") or "-hof".
 */
const KIND_AT_END =
  /.{3}(?:bad|bahnhof|buro|cafe|garten|halle|haus|hotel|kino|kirche|klinik|kuche|museum|park|restaurant|saal|schule|studio|theater|zentrum|zimmer)$/;

/**
 * Whether a folded word says a kind of place: one of `PLACE_KINDS`, or a
 * compound that ends in one. A compound is as often a place's own name
 * ("Konzerthaus", "Schweizerhaus") — a kind for reading a phrase, never
 * for refusing a lookup (`placeMatch`).
 */
export const isPlaceKind = (word: string): boolean =>
  PLACE_KINDS.has(word) || KIND_AT_END.test(word);
