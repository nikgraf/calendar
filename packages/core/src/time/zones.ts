import { Temporal } from './temporal.ts';

/** How many zones the settings hold; one of them is the primary. */
export const MAX_TIME_ZONES = 3;

/**
 * The IANA zone catalog both apps offer in the picker: every id from
 * Node's `Intl.supportedValuesOf('timeZone')` minus `Etc/*`, plus `UTC`,
 * with ICU's legacy spellings (Asia/Calcutta, Europe/Kiev, …) replaced by
 * the current IANA names, checked in as a static list. Hermes has no
 * `supportedValuesOf`, and one catalog keeps the two apps identical. The
 * unit test validates every id against Temporal so tzdata drift shows up
 * at build time — on Node. Engines differ on the spellings they accept
 * (Hermes rejects Asia/Kolkata but takes Asia/Calcutta, and rejects
 * America/Buenos_Aires but takes America/Argentina/Buenos_Aires), so the
 * id a device stores comes from `runtimeZoneId`, and display, search and
 * test ids go through `canonicalZoneId` so both spellings read the same.
 */
export const TIME_ZONE_IDS: ReadonlyArray<string> = [
  'Africa/Abidjan',
  'Africa/Accra',
  'Africa/Addis_Ababa',
  'Africa/Algiers',
  'Africa/Asmara',
  'Africa/Bamako',
  'Africa/Bangui',
  'Africa/Banjul',
  'Africa/Bissau',
  'Africa/Blantyre',
  'Africa/Brazzaville',
  'Africa/Bujumbura',
  'Africa/Cairo',
  'Africa/Casablanca',
  'Africa/Ceuta',
  'Africa/Conakry',
  'Africa/Dakar',
  'Africa/Dar_es_Salaam',
  'Africa/Djibouti',
  'Africa/Douala',
  'Africa/El_Aaiun',
  'Africa/Freetown',
  'Africa/Gaborone',
  'Africa/Harare',
  'Africa/Johannesburg',
  'Africa/Juba',
  'Africa/Kampala',
  'Africa/Khartoum',
  'Africa/Kigali',
  'Africa/Kinshasa',
  'Africa/Lagos',
  'Africa/Libreville',
  'Africa/Lome',
  'Africa/Luanda',
  'Africa/Lubumbashi',
  'Africa/Lusaka',
  'Africa/Malabo',
  'Africa/Maputo',
  'Africa/Maseru',
  'Africa/Mbabane',
  'Africa/Mogadishu',
  'Africa/Monrovia',
  'Africa/Nairobi',
  'Africa/Ndjamena',
  'Africa/Niamey',
  'Africa/Nouakchott',
  'Africa/Ouagadougou',
  'Africa/Porto-Novo',
  'Africa/Sao_Tome',
  'Africa/Tripoli',
  'Africa/Tunis',
  'Africa/Windhoek',
  'America/Adak',
  'America/Anchorage',
  'America/Anguilla',
  'America/Antigua',
  'America/Araguaina',
  'America/Argentina/Buenos_Aires',
  'America/Argentina/Catamarca',
  'America/Argentina/Cordoba',
  'America/Argentina/Jujuy',
  'America/Argentina/La_Rioja',
  'America/Argentina/Mendoza',
  'America/Argentina/Rio_Gallegos',
  'America/Argentina/Salta',
  'America/Argentina/San_Juan',
  'America/Argentina/San_Luis',
  'America/Argentina/Tucuman',
  'America/Argentina/Ushuaia',
  'America/Aruba',
  'America/Asuncion',
  'America/Atikokan',
  'America/Bahia',
  'America/Bahia_Banderas',
  'America/Barbados',
  'America/Belem',
  'America/Belize',
  'America/Blanc-Sablon',
  'America/Boa_Vista',
  'America/Bogota',
  'America/Boise',
  'America/Cambridge_Bay',
  'America/Campo_Grande',
  'America/Cancun',
  'America/Caracas',
  'America/Cayenne',
  'America/Cayman',
  'America/Chicago',
  'America/Chihuahua',
  'America/Ciudad_Juarez',
  'America/Costa_Rica',
  'America/Coyhaique',
  'America/Creston',
  'America/Cuiaba',
  'America/Curacao',
  'America/Danmarkshavn',
  'America/Dawson',
  'America/Dawson_Creek',
  'America/Denver',
  'America/Detroit',
  'America/Dominica',
  'America/Edmonton',
  'America/Eirunepe',
  'America/El_Salvador',
  'America/Fort_Nelson',
  'America/Fortaleza',
  'America/Glace_Bay',
  'America/Goose_Bay',
  'America/Grand_Turk',
  'America/Grenada',
  'America/Guadeloupe',
  'America/Guatemala',
  'America/Guayaquil',
  'America/Guyana',
  'America/Halifax',
  'America/Havana',
  'America/Hermosillo',
  'America/Indiana/Indianapolis',
  'America/Indiana/Knox',
  'America/Indiana/Marengo',
  'America/Indiana/Petersburg',
  'America/Indiana/Tell_City',
  'America/Indiana/Vevay',
  'America/Indiana/Vincennes',
  'America/Indiana/Winamac',
  'America/Inuvik',
  'America/Iqaluit',
  'America/Jamaica',
  'America/Juneau',
  'America/Kentucky/Louisville',
  'America/Kentucky/Monticello',
  'America/Kralendijk',
  'America/La_Paz',
  'America/Lima',
  'America/Los_Angeles',
  'America/Lower_Princes',
  'America/Maceio',
  'America/Managua',
  'America/Manaus',
  'America/Marigot',
  'America/Martinique',
  'America/Matamoros',
  'America/Mazatlan',
  'America/Menominee',
  'America/Merida',
  'America/Metlakatla',
  'America/Mexico_City',
  'America/Miquelon',
  'America/Moncton',
  'America/Monterrey',
  'America/Montevideo',
  'America/Montserrat',
  'America/Nassau',
  'America/New_York',
  'America/Nome',
  'America/Noronha',
  'America/North_Dakota/Beulah',
  'America/North_Dakota/Center',
  'America/North_Dakota/New_Salem',
  'America/Nuuk',
  'America/Ojinaga',
  'America/Panama',
  'America/Paramaribo',
  'America/Phoenix',
  'America/Port-au-Prince',
  'America/Port_of_Spain',
  'America/Porto_Velho',
  'America/Puerto_Rico',
  'America/Punta_Arenas',
  'America/Rankin_Inlet',
  'America/Recife',
  'America/Regina',
  'America/Resolute',
  'America/Rio_Branco',
  'America/Santarem',
  'America/Santiago',
  'America/Santo_Domingo',
  'America/Sao_Paulo',
  'America/Scoresbysund',
  'America/Sitka',
  'America/St_Barthelemy',
  'America/St_Johns',
  'America/St_Kitts',
  'America/St_Lucia',
  'America/St_Thomas',
  'America/St_Vincent',
  'America/Swift_Current',
  'America/Tegucigalpa',
  'America/Thule',
  'America/Tijuana',
  'America/Toronto',
  'America/Tortola',
  'America/Vancouver',
  'America/Whitehorse',
  'America/Winnipeg',
  'America/Yakutat',
  'Antarctica/Casey',
  'Antarctica/Davis',
  'Antarctica/DumontDUrville',
  'Antarctica/Macquarie',
  'Antarctica/Mawson',
  'Antarctica/McMurdo',
  'Antarctica/Palmer',
  'Antarctica/Rothera',
  'Antarctica/Syowa',
  'Antarctica/Troll',
  'Antarctica/Vostok',
  'Arctic/Longyearbyen',
  'Asia/Aden',
  'Asia/Almaty',
  'Asia/Amman',
  'Asia/Anadyr',
  'Asia/Aqtau',
  'Asia/Aqtobe',
  'Asia/Ashgabat',
  'Asia/Atyrau',
  'Asia/Baghdad',
  'Asia/Bahrain',
  'Asia/Baku',
  'Asia/Bangkok',
  'Asia/Barnaul',
  'Asia/Beirut',
  'Asia/Bishkek',
  'Asia/Brunei',
  'Asia/Chita',
  'Asia/Colombo',
  'Asia/Damascus',
  'Asia/Dhaka',
  'Asia/Dili',
  'Asia/Dubai',
  'Asia/Dushanbe',
  'Asia/Famagusta',
  'Asia/Gaza',
  'Asia/Hebron',
  'Asia/Ho_Chi_Minh',
  'Asia/Hong_Kong',
  'Asia/Hovd',
  'Asia/Irkutsk',
  'Asia/Jakarta',
  'Asia/Jayapura',
  'Asia/Jerusalem',
  'Asia/Kabul',
  'Asia/Kamchatka',
  'Asia/Karachi',
  'Asia/Kathmandu',
  'Asia/Khandyga',
  'Asia/Kolkata',
  'Asia/Krasnoyarsk',
  'Asia/Kuala_Lumpur',
  'Asia/Kuching',
  'Asia/Kuwait',
  'Asia/Macau',
  'Asia/Magadan',
  'Asia/Makassar',
  'Asia/Manila',
  'Asia/Muscat',
  'Asia/Nicosia',
  'Asia/Novokuznetsk',
  'Asia/Novosibirsk',
  'Asia/Omsk',
  'Asia/Oral',
  'Asia/Phnom_Penh',
  'Asia/Pontianak',
  'Asia/Pyongyang',
  'Asia/Qatar',
  'Asia/Qostanay',
  'Asia/Qyzylorda',
  'Asia/Riyadh',
  'Asia/Sakhalin',
  'Asia/Samarkand',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Srednekolymsk',
  'Asia/Taipei',
  'Asia/Tashkent',
  'Asia/Tbilisi',
  'Asia/Tehran',
  'Asia/Thimphu',
  'Asia/Tokyo',
  'Asia/Tomsk',
  'Asia/Ulaanbaatar',
  'Asia/Urumqi',
  'Asia/Ust-Nera',
  'Asia/Vientiane',
  'Asia/Vladivostok',
  'Asia/Yakutsk',
  'Asia/Yangon',
  'Asia/Yekaterinburg',
  'Asia/Yerevan',
  'Atlantic/Azores',
  'Atlantic/Bermuda',
  'Atlantic/Canary',
  'Atlantic/Cape_Verde',
  'Atlantic/Faroe',
  'Atlantic/Madeira',
  'Atlantic/Reykjavik',
  'Atlantic/South_Georgia',
  'Atlantic/St_Helena',
  'Atlantic/Stanley',
  'Australia/Adelaide',
  'Australia/Brisbane',
  'Australia/Broken_Hill',
  'Australia/Darwin',
  'Australia/Eucla',
  'Australia/Hobart',
  'Australia/Lindeman',
  'Australia/Lord_Howe',
  'Australia/Melbourne',
  'Australia/Perth',
  'Australia/Sydney',
  'Europe/Amsterdam',
  'Europe/Andorra',
  'Europe/Astrakhan',
  'Europe/Athens',
  'Europe/Belgrade',
  'Europe/Berlin',
  'Europe/Bratislava',
  'Europe/Brussels',
  'Europe/Bucharest',
  'Europe/Budapest',
  'Europe/Busingen',
  'Europe/Chisinau',
  'Europe/Copenhagen',
  'Europe/Dublin',
  'Europe/Gibraltar',
  'Europe/Guernsey',
  'Europe/Helsinki',
  'Europe/Isle_of_Man',
  'Europe/Istanbul',
  'Europe/Jersey',
  'Europe/Kaliningrad',
  'Europe/Kirov',
  'Europe/Kyiv',
  'Europe/Lisbon',
  'Europe/Ljubljana',
  'Europe/London',
  'Europe/Luxembourg',
  'Europe/Madrid',
  'Europe/Malta',
  'Europe/Mariehamn',
  'Europe/Minsk',
  'Europe/Monaco',
  'Europe/Moscow',
  'Europe/Oslo',
  'Europe/Paris',
  'Europe/Podgorica',
  'Europe/Prague',
  'Europe/Riga',
  'Europe/Rome',
  'Europe/Samara',
  'Europe/San_Marino',
  'Europe/Sarajevo',
  'Europe/Saratov',
  'Europe/Simferopol',
  'Europe/Skopje',
  'Europe/Sofia',
  'Europe/Stockholm',
  'Europe/Tallinn',
  'Europe/Tirane',
  'Europe/Ulyanovsk',
  'Europe/Vaduz',
  'Europe/Vatican',
  'Europe/Vienna',
  'Europe/Vilnius',
  'Europe/Volgograd',
  'Europe/Warsaw',
  'Europe/Zagreb',
  'Europe/Zurich',
  'Indian/Antananarivo',
  'Indian/Chagos',
  'Indian/Christmas',
  'Indian/Cocos',
  'Indian/Comoro',
  'Indian/Kerguelen',
  'Indian/Mahe',
  'Indian/Maldives',
  'Indian/Mauritius',
  'Indian/Mayotte',
  'Indian/Reunion',
  'Pacific/Apia',
  'Pacific/Auckland',
  'Pacific/Bougainville',
  'Pacific/Chatham',
  'Pacific/Chuuk',
  'Pacific/Easter',
  'Pacific/Efate',
  'Pacific/Fakaofo',
  'Pacific/Fiji',
  'Pacific/Funafuti',
  'Pacific/Galapagos',
  'Pacific/Gambier',
  'Pacific/Guadalcanal',
  'Pacific/Guam',
  'Pacific/Honolulu',
  'Pacific/Kanton',
  'Pacific/Kiritimati',
  'Pacific/Kosrae',
  'Pacific/Kwajalein',
  'Pacific/Majuro',
  'Pacific/Marquesas',
  'Pacific/Midway',
  'Pacific/Nauru',
  'Pacific/Niue',
  'Pacific/Norfolk',
  'Pacific/Noumea',
  'Pacific/Pago_Pago',
  'Pacific/Palau',
  'Pacific/Pitcairn',
  'Pacific/Pohnpei',
  'Pacific/Port_Moresby',
  'Pacific/Rarotonga',
  'Pacific/Saipan',
  'Pacific/Tahiti',
  'Pacific/Tarawa',
  'Pacific/Tongatapu',
  'Pacific/Wake',
  'Pacific/Wallis',
  'UTC',
];

/**
 * ICU's legacy spellings and the current IANA names, both ways. V8 accepts
 * both; Hermes accepts an inconsistent mix, so every catalog id is tried
 * in this order: the modern name, then the legacy one.
 */
const LEGACY_TO_MODERN: Readonly<Record<string, string>> = {
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Coral_Harbour': 'America/Atikokan',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
};
const MODERN_TO_LEGACY: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(LEGACY_TO_MODERN).map(([legacy, modern]) => [modern, legacy]),
);

/** The current IANA name for a stored id, whichever spelling the device kept. */
export const canonicalZoneId = (id: string): string => LEGACY_TO_MODERN[id] ?? id;

/** true when Temporal (and so tzdata) knows the zone id. */
export const isValidTimeZone = (id: string): boolean => {
  try {
    Temporal.Now.zonedDateTimeISO(id);
    return true;
  } catch {
    return false;
  }
};

/**
 * The spelling this engine accepts for a zone id — the id itself, else its
 * current name, else ICU's legacy name for that — or undefined when it
 * knows none. Both ways round: a catalog id is current (Asia/Kolkata,
 * which Hermes rejects for Asia/Calcutta), but a zone Google stored may be
 * legacy (America/Buenos_Aires, which Hermes rejects for
 * America/Argentina/Buenos_Aires). `isValid` is injectable so tests can act
 * out an engine with a different table.
 */
export const runtimeZoneId = (
  id: string,
  isValid: (candidate: string) => boolean = isValidTimeZone,
): string | undefined => {
  if (isValid(id)) {
    return id;
  }
  const current = canonicalZoneId(id);
  if (current !== id && isValid(current)) {
    return current;
  }
  const legacy = MODERN_TO_LEGACY[current];
  return legacy !== undefined && legacy !== id && isValid(legacy) ? legacy : undefined;
};

const engineZoneIds = new Map<string, string>();

/**
 * A zone an event carries (from Google, EventKit or a stored row) in the
 * spelling this engine accepts, or as it was when the engine knows none
 * (its reader then fails as before). Hermes rejects Asia/Kolkata, and a
 * series in it was left out of every view on iOS. Memoised: rows decode
 * by the thousand.
 */
export const engineZoneId = (id: string): string => {
  let spelled = engineZoneIds.get(id);
  if (spelled === undefined) {
    spelled = runtimeZoneId(id) ?? id;
    engineZoneIds.set(id, spelled);
  }
  return spelled;
};

/**
 * Recurrence lines with every TZID parameter (an EXDATE's or RDATE's) in
 * the engine's spelling, which rrule-temporal hands to Temporal as is.
 * `spell` is injectable so tests can act out another engine.
 */
export const engineRecurrenceLines = (
  lines: ReadonlyArray<string>,
  spell: (id: string) => string = engineZoneId,
): Array<string> =>
  lines.map((line) =>
    line.replaceAll(
      /TZID=("?)([^";:]+)\1/g,
      (_match, quote: string, zone: string) => `TZID=${quote}${spell(zone)}${quote}`,
    ),
  );

let runtimeIds: ReadonlyArray<string> | undefined;

/** The catalog as this engine can store and draw it, resolved once. */
export const allTimeZoneIds = (): ReadonlyArray<string> => {
  runtimeIds ??= TIME_ZONE_IDS.map((id) => runtimeZoneId(id)).filter(
    (id): id is string => id !== undefined,
  );
  return runtimeIds;
};

/** The city part of an id: 'America/Argentina/Buenos_Aires' → 'Buenos Aires'; 'Asia/Calcutta' → 'Kolkata'; 'UTC' → 'UTC'. */
export const zoneCity = (id: string): string => {
  const canonical = canonicalZoneId(id);
  const last = canonical.slice(canonical.lastIndexOf('/') + 1);
  return last.replaceAll('_', ' ');
};

/** The region part of an id: 'America/Argentina/Buenos_Aires' → 'America'; 'UTC' → ''. */
export const zoneRegion = (id: string): string => {
  const canonical = canonicalZoneId(id);
  const slash = canonical.indexOf('/');
  return slash === -1 ? '' : canonical.slice(0, slash);
};

/** A testID-safe slug from the current name, whatever spelling is stored: 'Asia/Calcutta' → 'Asia-Kolkata'. */
export const zoneSlug = (id: string): string => canonicalZoneId(id).replaceAll('/', '-');

export interface TimeZoneMatch {
  readonly city: string;
  readonly id: string;
  readonly region: string;
}

const MAX_MATCHES = 50;

const normalize = (value: string): string => value.toLowerCase().replaceAll('_', ' ');

const words = (value: string): ReadonlyArray<string> => normalize(value).split(/[\s/]+/);

/**
 * Picker search: a case- and underscore-insensitive word-prefix match on
 * the city, the region and the raw id. City matches rank first, then
 * region matches, then anything else; ties keep catalog order. An empty
 * query lists everything (capped). `exclude` drops the zones already
 * picked. `ids` defaults to the catalog as this engine accepts it.
 */
export const searchTimeZones = (
  query: string,
  exclude: ReadonlyArray<string> = [],
  ids: ReadonlyArray<string> = allTimeZoneIds(),
): ReadonlyArray<TimeZoneMatch> => {
  const needle = normalize(query.trim());
  const excluded = new Set(exclude);
  const ranked: Array<{ readonly match: TimeZoneMatch; readonly rank: number }> = [];
  for (const id of ids) {
    if (excluded.has(id)) {
      continue;
    }
    const match = { city: zoneCity(id), id, region: zoneRegion(id) };
    const rank =
      needle === ''
        ? 2
        : words(match.city).some((word) => word.startsWith(needle)) ||
            normalize(match.city).startsWith(needle)
          ? 0
          : words(match.region).some((word) => word.startsWith(needle))
            ? 1
            : normalize(canonicalZoneId(id)).includes(needle) || normalize(id).includes(needle)
              ? 2
              : -1;
    if (rank >= 0) {
      ranked.push({ match, rank });
    }
  }
  return ranked
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_MATCHES)
    .map((entry) => entry.match);
};
