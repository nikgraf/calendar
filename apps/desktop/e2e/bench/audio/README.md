# Recordings

One voice on an iPhone, recorded with Voice Memos as it comes (its
Enhance Recording and Skip Silence options off), the phone held as when
talking to the app. The places set and the short turns say which place
and people names the recognisers hear; the scripted phrases give the
model bench its word error rate.

People in a recording are made up, some with English names and some with
German ones: Tom Baker, Emily Carter, James Wright, Sarah, Anna, Max and
David; Stefan Müller, Thomas Karpfeneder, Katharina Gruber and Jörg
Hofstätter. Places are public ones. Clips are committed once recorded
(Nik's call), though the repo may go public: nothing private in what is
said, and a clip is copied in without its metadata (Voice Memos names a
memo after where it was recorded).

## Where a phrase ends

No set for it. Dictation sends a phrase once its words have stood still
for about a second (`packages/ai/src/phraseEnd.ts`), and a thought takes
longer than that; read speech has no such pauses, and Nik records by
reading only (2026-11-23). What a thinking pause does is measured from
phrases dictated to the app itself, once it can keep them.

## The places set

For names: the phone listens in one language, and a name said the
German way inside an English sentence is written as English words
("Fiegemuller", "Nashmacht"). Forty places, each one MapKit finds when
it is spelled right: thirty in Vienna, six towns and cities, four street
addresses. Each is said once in an English sentence and once in a German
one, and about half the sentences name a person in full. Say the names
as you would to a friend, not as an English speaker would.

Recorded by Nik on 2026-11-23 in a quiet room, one memo per sentence,
the words as written so that what the recogniser writes can be scored:
`places/place-en-<#>.m4a` and `places/place-de-<#>.m4a`.

| #   | Place (MapKit's name) | English                                                                         | German                                                                       |
| --- | --------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Figlmüller            | Lunch with Sarah tomorrow at one at Figlmüller                                  | Mittagessen mit Sarah morgen um eins im Figlmüller                           |
| 2   | Café Prückel          | Coffee with Thomas Karpfeneder at Café Prückel on Friday at three               | Kaffee mit Thomas Karpfeneder im Café Prückel am Freitag um drei             |
| 3   | Naschmarkt            | Meet Tom Baker at the Naschmarkt on Saturday at ten                             | Treffen mit Tom Baker am Naschmarkt am Samstag um zehn                       |
| 4   | Schönbrunn            | Walk with Anna in Schönbrunn on Sunday morning                                  | Spaziergang mit Anna in Schönbrunn am Sonntagvormittag                       |
| 5   | Stephansplatz         | Meet Stefan Müller at Stephansplatz today at six                                | Treffen mit Stefan Müller am Stephansplatz heute um sechs                    |
| 6   | Praterstern           | Pick up David at Praterstern tomorrow at half past five                         | David am Praterstern abholen, morgen um halb sechs                           |
| 7   | Karlsplatz            | Concert at Karlsplatz next Thursday at eight                                    | Konzert am Karlsplatz nächsten Donnerstag um acht                            |
| 8   | Mariahilfer Straße    | Shopping with Emily Carter on Mariahilfer Straße on Saturday afternoon          | Einkaufen mit Emily Carter auf der Mariahilfer Straße am Samstagnachmittag   |
| 9   | Schwedenplatz         | Meet Max at Schwedenplatz tonight at seven                                      | Treffen mit Max am Schwedenplatz heute Abend um sieben                       |
| 10  | Gasthaus Pöschl       | Dinner with Katharina Gruber at Gasthaus Pöschl on Wednesday at half past seven | Abendessen mit Katharina Gruber im Gasthaus Pöschl am Mittwoch um halb acht  |
| 11  | Kaffemik              | Coffee with Sarah at Kaffemik tomorrow at ten                                   | Kaffee mit Sarah im Kaffemik morgen um zehn                                  |
| 12  | Kleinod               | Drinks with James Wright at Kleinod on Friday at nine                           | Drinks mit James Wright im Kleinod am Freitag um neun                        |
| 13  | Café Sperl            | Breakfast with Tom at Café Sperl on Sunday at nine                              | Frühstück mit Tom im Café Sperl am Sonntag um neun                           |
| 14  | Coffee Hawelka        | Meet Jörg Hofstätter at Café Hawelka on Tuesday at four                         | Treffen mit Jörg Hofstätter im Café Hawelka am Dienstag um vier              |
| 15  | Augarten              | Run in the Augarten tomorrow morning at seven                                   | Laufen im Augarten morgen früh um sieben                                     |
| 16  | Türkenschanzpark      | Picnic with Anna in the Türkenschanzpark on Saturday at noon                    | Picknick mit Anna im Türkenschanzpark am Samstag zu Mittag                   |
| 17  | Westbahnhof           | Train from Westbahnhof on Monday at eight fifteen                               | Zug vom Westbahnhof am Montag um Viertel nach acht                           |
| 18  | Wien Hauptbahnhof     | Pick up Thomas Karpfeneder at Hauptbahnhof on Thursday at six                   | Thomas Karpfeneder am Hauptbahnhof abholen, Donnerstag um sechs              |
| 19  | Burggarten            | Lunch break in the Burggarten tomorrow at twelve thirty                         | Mittagspause im Burggarten morgen um halb eins                               |
| 20  | Volksgarten           | Meet Emily Carter in the Volksgarten on Sunday at three                         | Treffen mit Emily Carter im Volksgarten am Sonntag um drei                   |
| 21  | MuseumsQuartier       | Exhibition with Stefan at the MuseumsQuartier on Saturday at eleven             | Ausstellung mit Stefan im MuseumsQuartier am Samstag um elf                  |
| 22  | Donauinsel            | Bike ride on the Donauinsel next Sunday at ten                                  | Radtour auf der Donauinsel nächsten Sonntag um zehn                          |
| 23  | Kahlenberg            | Hike up the Kahlenberg with Katharina Gruber on Saturday morning                | Wanderung auf den Kahlenberg mit Katharina Gruber am Samstagvormittag        |
| 24  | Mayer am Pfarrplatz   | Dinner with Tom Baker at Mayer am Pfarrplatz next Friday at seven               | Abendessen mit Tom Baker beim Mayer am Pfarrplatz nächsten Freitag um sieben |
| 25  | Schweizerhaus         | Beer with Max at the Schweizerhaus on Thursday at six                           | Bier mit Max im Schweizerhaus am Donnerstag um sechs                         |
| 26  | Zum Schwarzen Kameel  | Lunch with David at Zum Schwarzen Kameel on Wednesday at one                    | Mittagessen mit David im Schwarzen Kameel am Mittwoch um eins                |
| 27  | Plachutta Wollzeile   | Dinner with Jörg Hofstätter at Plachutta on Saturday at eight                   | Abendessen mit Jörg Hofstätter im Plachutta am Samstag um acht               |
| 28  | Steirereck            | Dinner with Sarah at Steirereck on the fifth of December at seven               | Abendessen mit Sarah im Steirereck am fünften Dezember um sieben             |
| 29  | Schottentor           | Meet James Wright at Schottentor tomorrow at quarter to nine                    | Treffen mit James Wright am Schottentor morgen um Viertel vor neun           |
| 30  | Rathausplatz          | Christmas market at Rathausplatz on Friday at five                              | Christkindlmarkt am Rathausplatz am Freitag um fünf                          |
| 31  | Munich                | Train to München on Monday at seven                                             | Zug nach München am Montag um sieben                                         |
| 32  | Zürich                | Flight to Zürich next Wednesday at half past six                                | Flug nach Zürich nächsten Mittwoch um halb sieben                            |
| 33  | Salzburg              | Weekend in Salzburg with Anna from Friday to Sunday                             | Wochenende in Salzburg mit Anna von Freitag bis Sonntag                      |
| 34  | Klosterneuburg        | Visit Stefan Müller in Klosterneuburg on Sunday at two                          | Besuch bei Stefan Müller in Klosterneuburg am Sonntag um zwei                |
| 35  | St. Pölten            | Meeting in St. Pölten on Tuesday at ten                                         | Besprechung in St. Pölten am Dienstag um zehn                                |
| 36  | Kitzbühel             | Skiing in Kitzbühel next Saturday                                               | Skifahren in Kitzbühel nächsten Samstag                                      |
| 37  | Wollzeile 5           | Doctor at Wollzeile 5 tomorrow at nine                                          | Arzt in der Wollzeile 5 morgen um neun                                       |
| 38  | Neubaugasse 12        | Haircut at Neubaugasse 12 on Thursday at four                                   | Friseur in der Neubaugasse 12 am Donnerstag um vier                          |
| 39  | Währinger Straße 46   | Dinner at Emily Carter's, Währinger Straße 46, on Saturday at seven             | Abendessen bei Emily Carter, Währinger Straße 46, am Samstag um sieben       |
| 40  | Praterstraße 1        | Workshop at Praterstraße 1 next Monday from nine to twelve                      | Workshop in der Praterstraße 1 nächsten Montag von neun bis zwölf            |

MapKit's names are as it answered near Vienna on 2026-11-23, each asked
for by the name in the sentence.

## The short turns

A change said to a draft that is already there: a few words, so the
recogniser has no sentence to lean on. This is where a name is misheard
most ("in Vienna" was once written "Indiana").

Recorded with the places set, one memo per row:
`turns/turn-<#>.m4a`.

| #   | Say                                    |
| --- | -------------------------------------- |
| 1   | at Kaffemik                            |
| 2   | it's in Vienna                         |
| 3   | invite Thomas Karpfeneder              |
| 4   | make it half past seven                |
| 5   | at Café Sperl instead                  |
| 6   | add Stefan Müller                      |
| 7   | Thursday instead                       |
| 8   | in the Augarten                        |
| 9   | with Katharina Gruber                  |
| 10  | move it to Plachutta                   |
| 11  | invite Emily Carter and James Wright   |
| 12  | at the Schweizerhaus                   |
| 13  | call it team dinner                    |
| 14  | remind me an hour before               |
| 15  | it's on Mariahilfer Straße             |
| 16  | without Jörg Hofstätter                |
| 17  | im Café Prückel                        |
| 18  | lade Thomas Karpfeneder ein            |
| 19  | lieber am Mittwoch                     |
| 20  | um halb acht                           |
| 21  | mit Stefan Müller und Katharina Gruber |
| 22  | am Schwedenplatz                       |
| 23  | nenn es Teamessen                      |
| 24  | ohne Jörg Hofstätter                   |

## The scripted phrases

The clips the cases ask for, one phrase per file, named as the case's
`audio` field names it. A clip that is not here runs as its transcript;
the ones below give the bench its speech signal (names, numbers, German,
a spoken address, the short turns of a flow).

How to record: one memo per row, said the way you would to the app,
with the words as the transcript has them, so the word error rate means
something; the punctuation is not spoken. Each clip takes its row's
file name (any file AVAudioFile reads works).

| File                                | Say                                                                                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lunch-sarah-tomorrow-at-1-1.m4a`   | Lunch with Sarah tomorrow at 1                                                                                                                                                         |
| `zahnarzt-dienstag-halb-drei-1.m4a` | Zahnarzt nächsten Dienstag um halb drei                                                                                                                                                |
| `kaffee-max-figlmueller-1.m4a`      | Kaffee mit Max um 10 Uhr im Figlmüller                                                                                                                                                 |
| `lunch-tom-tomorrow-1.m4a`          | lunch with tom tomorrow                                                                                                                                                                |
| `kaffee-cafe-prueckel-1.m4a`        | Kaffee morgen um 15 Uhr im Café Prückel                                                                                                                                                |
| `invite-tom-baker-1.m4a`            | Lunch tomorrow at noon, invite Tom Baker                                                                                                                                               |
| `invite-german-1.m4a`               | Teammeeting am Mittwoch um 9, lade Tom Baker und Jörg Müller ein                                                                                                                       |
| `jeden-dienstag-fussball-1.m4a`     | Jeden Dienstag um 18 Uhr Fußball                                                                                                                                                       |
| `erinnerung-eine-stunde-1.m4a`      | Zahnarzt Dienstag um 10, erinnere mich eine Stunde vorher                                                                                                                              |
| `long-german-full-1.m4a`            | Trag mir für nächsten Mittwoch um 10 Uhr einen Zahnarzttermin in der Praxis Dr. Huber ein, erinnere mich eine Stunde vorher und notier, dass ich die Versicherungskarte mitnehmen muss |
| `long-workshop-full-1.m4a`          | Workshop with the design team on Tuesday from 2 to 4 in the big meeting room, invite tom.baker@example.com and Anna Berger, notes: bring the printouts, notification 30 minutes before |
| `long-call-chatty-1.m4a`            | I'd like to schedule a call with Sarah sometime tomorrow afternoon, let's say 3pm, it should take about half an hour                                                                   |
| `flow-dinner-2.m4a`                 | make it 8                                                                                                                                                                              |
| `flow-dinner-3.m4a`                 | Thursday instead                                                                                                                                                                       |
| `flow-dinner-5.m4a`                 | invite Tom Baker                                                                                                                                                                       |
| `flow-dinner-6.m4a`                 | call it team dinner                                                                                                                                                                    |
| `flow-zahnarzt-2.m4a`               | lieber Mittwoch                                                                                                                                                                        |
| `flow-zahnarzt-3.m4a`               | um 16 Uhr                                                                                                                                                                              |
| `flow-zahnarzt-4.m4a`               | in der Praxis Dr. Huber                                                                                                                                                                |
| `flow-zahnarzt-5.m4a`               | nenn es Kontrolle                                                                                                                                                                      |
| `add-event-lunch-stefan-1.m4a`      | Add an event to have lunch with Stefan tomorrow at 1                                                                                                                                   |
| `trag-mir-zahnarzt-ein-1.m4a`       | Trag mir am Dienstag um 10 einen Zahnarzttermin ein                                                                                                                                    |
| `flow-place-in-city-1.m4a`          | Lunch tomorrow at 1                                                                                                                                                                    |
| `flow-place-in-city-2.m4a`          | at Kaffemik                                                                                                                                                                            |
| `flow-place-in-city-3.m4a`          | it's in Vienna                                                                                                                                                                         |
| `flow-place-in-city-4.m4a`          | with Stefan                                                                                                                                                                            |

Not recorded for now: the seven clips whose cases name Teo, Jo or Loos
Bar. Nik asked for other names and another place in the recordings
(2026-11-23), and these cases are built on them. They run as their
transcripts, as every case without a clip does.

| File                           | Say                                                                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dinner-teo-next-friday-1.m4a` | Dinner with Teo next Friday                                                                                                                                    |
| `abendessen-teo-freitag-1.m4a` | Abendessen mit Teo nächsten Freitag                                                                                                                            |
| `drinks-jo-loos-bar-1.m4a`     | drinks with jo at Loos Bar friday 7pm                                                                                                                          |
| `long-dinner-full-1.m4a`       | Set up a dinner with Tom Baker next Friday at seven at Loos Bar, invite Anna Lee too, remind me an hour before and note that we need to talk about the roadmap |
| `flow-dinner-4.m4a`            | at Loos Bar                                                                                                                                                    |
| `invite-email-1.m4a`           | Sync on Friday at 10, invite jo@example.com                                                                                                                    |
| `long-run-prater-1.m4a`        | Block Saturday morning for a run in the Prater with Jo around 8 and invite jo@example.com                                                                      |

The first turns of `flow-dinner` and `flow-zahnarzt` reuse the clips of
`dinner-teo-next-friday` and `zahnarzt-dienstag-halb-drei`.

`flow-place-in-city` is the flow of the 2026-11-06 recordings: a name
the recogniser does not know, then where it is ("in Vienna" was heard as
"Indiana"), then who it is with. `flow-place-as-heard` runs the same
flow on the words as the recogniser wrote them.

The address in `invite-email` and `long-run-prater` is spoken as "jo at
example dot com"; whatever the recogniser writes is the point of those
two. The people of these cases are the fixtures of `../contacts.json`,
never real contacts. None of these clips is in the repo yet.
