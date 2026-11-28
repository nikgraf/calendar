import { Effect } from 'effect';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState, Platform, StyleSheet, Text, View } from 'react-native';
import { loadParakeet, type ParakeetVersion } from '../../../modules/solunivo-speech/index.ts';
import { loadProcessMemoryModule } from '../../../modules/solunivo-process-memory/index.ts';
import { loadAssistantModel, releaseAssistantModel } from '../../assistantRuntime.ts';
import { backendClient } from '../../backend.ts';
import { holdParakeetForSpike } from '../../parakeetRuntime.ts';
import { llamaHolder } from '../../llamaOwner.ts';
import { SPIKE_CLIPS, SPIKE_PEOPLE, SPIKE_PLACES } from '../../speechSpikeClips.ts';
import {
  type ClipFiles,
  createSpeechSpikeStore,
  hasPeople,
  hasPlaces,
  type ParakeetPort,
  type SpeechSpikeReport,
  type SpeechSpikeStore,
  withPeople,
  withPlaces,
} from '../../speechSpikeStore.ts';
import {
  ActionRow,
  CheckRow,
  Footer,
  Row,
  Section,
  SettingsPage,
  SwitchRow,
} from '../GroupedList.tsx';
import { type ThemeColors, useStyles } from '../theme.ts';

/** Where the recordings are fetched from: the public repository's main branch. */
const CLIPS_URL =
  'https://raw.githubusercontent.com/nikgraf/calendar/main/apps/desktop/e2e/bench/audio';

const VERSIONS: ReadonlyArray<{
  readonly name: string;
  readonly size: string;
  readonly version: ParakeetVersion;
}> = [
  { name: 'Parakeet Ultra', size: '613 MB', version: 'ultra' },
  { name: 'Parakeet TDT 0.6B v3', size: '470 MB', version: 'v3' },
];

/** Native modules lazily and inside a try, as on the Model Spike page. */
const loadNative = () => {
  try {
    /* eslint-disable typescript/no-require-imports -- deliberate: see above */
    return {
      files: require('expo-file-system') as typeof import('expo-file-system'),
      sharing: require('expo-sharing') as typeof import('expo-sharing'),
    };
    /* eslint-enable typescript/no-require-imports */
  } catch {
    return undefined;
  }
};

/** The recordings under the app's caches, fetched once; the report through the share sheet. */
const deviceFiles = (): ClipFiles | undefined => {
  const native = loadNative();
  if (!native) {
    return undefined;
  }
  const { Directory, File, Paths } = native.files;
  return {
    fetch: async (clip, signal) => {
      const folder = new Directory(Paths.cache, 'speech-spike');
      if (!folder.exists) {
        folder.create();
      }
      const file = new File(folder, clip.path.replaceAll('/', '-'));
      if (!file.exists || file.size === 0) {
        await File.downloadFileAsync(`${CLIPS_URL}/${clip.path}`, file, {
          idempotent: true,
          signal,
        });
      }
      return file.uri;
    },
    share: async (name, text) => {
      const file = new File(Paths.cache, name);
      if (file.exists) {
        file.delete();
      }
      file.create();
      await file.write(text);
      await native.sharing.shareAsync(file.uri, { mimeType: 'application/json' });
    },
  };
};

/** The device's people, as `deviceNames` last read them: they ask for a closer match, as in dictation. */
let devicePeople: ReadonlyArray<string> = [];

const parakeetPort = (): ParakeetPort | undefined => {
  const native = loadParakeet();
  if (native === undefined) {
    return undefined;
  }
  return {
    load: async (version, vocabulary, onProgress) => {
      holdParakeetForSpike(true);
      const listening = native.addListener('onParakeetProgress', ({ fraction }) =>
        onProgress(fraction),
      );
      try {
        const people = new Set([...SPIKE_PEOPLE, ...devicePeople]);
        return await native.parakeetSpikeLoad(
          version,
          vocabulary,
          vocabulary.filter((name) => people.has(name)),
        );
      } finally {
        listening.remove();
      }
    },
    release: async () => {
      await native.parakeetSpikeRelease();
      holdParakeetForSpike(false);
    },
    transcribe: (uri) => native.parakeetSpikeTranscribe(uri),
  };
};

/** Made once for as long as the JavaScript lives, as the Model Spike page's store is. */
const makeStore = (): SpeechSpikeStore => {
  const probe = loadProcessMemoryModule();
  const made = createSpeechSpikeStore({
    assistant: {
      load: loadAssistantModel,
      release: async () => {
        // A model Model Spike left loaded stays across pages, and its memory would read as Parakeet's.
        if (llamaHolder() === 'spike') {
          throw new Error(
            'Model Spike holds a model: unload it there first, so this run measures Parakeet.',
          );
        }
        await releaseAssistantModel();
      },
    },
    clips: SPIKE_CLIPS,
    deviceNames: async () => {
      const names = await Effect.runPromise(backendClient.dictationVocabulary());
      devicePeople = names.people;
      return [...names.people, ...names.places];
    },
    files: deviceFiles(),
    keepAwake: (on) => probe?.keepAwake(on),
    memory: () => probe?.read(),
    now: Date.now,
    parakeet: parakeetPort(),
    people: SPIKE_PEOPLE,
    places: SPIKE_PLACES,
    platform: `${Platform.OS} ${String(Platform.Version)}`,
    simulator: probe?.isSimulator() ?? false,
  });
  AppState.addEventListener('change', (state) => {
    if (state !== 'active') {
      made.interrupt();
    }
  });
  AppState.addEventListener('memoryWarning', () => made.memoryWarning());
  return made;
};

const kept = globalThis as typeof globalThis & { solunivoSpeechSpike?: SpeechSpikeStore };
kept.solunivoSpeechSpike ??= makeStore();
const store = kept.solunivoSpeechSpike;

const megabytes = (bytes: number | undefined): string =>
  bytes === undefined ? '–' : `${String(Math.round(bytes / 1_000_000))} MB`;
const percent = (share: number): string => `${(share * 100).toFixed(1)} %`;
const ratio = ({ named, right }: { readonly named: number; readonly right: number }): string =>
  `${String(right)} of ${String(named)}`;

const GROUPS: ReadonlyArray<{ readonly group: 'de' | 'en' | 'turns'; readonly title: string }> = [
  { group: 'en', title: 'English Sentences' },
  { group: 'de', title: 'German Sentences' },
  { group: 'turns', title: 'Short Turns' },
];

/** One set's score: its name, then the numbers on a line of their own (a row's value would squeeze the name). */
function GroupScores({ scores }: { scores: SpeechSpikeReport['scores'] }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.rows} testID="speech-spike-scores">
      {GROUPS.map(({ group, title }) => {
        const score = scores[group];
        return (
          <View key={group} style={styles.row}>
            <Text style={styles.heard}>{title}</Text>
            <Text selectable style={styles.detail}>
              {score.wordErrorRate === undefined
                ? 'Not run'
                : `${percent(score.wordErrorRate)} words wrong · places ${ratio(score.places)} · full names ${ratio(score.people)}`}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/**
 * Measures Parakeet (FluidAudio's Core ML port) inside this app on Nik's
 * recordings: fetch the clips, load the Assistant's model beside it if
 * asked, load Parakeet, transcribe every clip and score it against the
 * sheet, reading the app's memory throughout. For internal measuring
 * only, listed where the binary has the module: a run takes dictation's
 * Parakeet over until it ends (`holdParakeetForSpike`), and nothing here
 * touches the calendar.
 */
export function SpeechSpikePage() {
  const styles = useStyles(makeStyles);
  const { memory, notice, options, report, step } = useSyncExternalStore(
    store.subscribe,
    store.getState,
  );

  useEffect(() => {
    store.readMemory();
  }, []);

  const idle = step.kind === 'idle';
  const status =
    step.kind === 'fetching'
      ? `Fetching recordings… ${String(step.done)} of ${String(step.total)}`
      : step.kind === 'assistant'
        ? 'Loading the Assistant’s model…'
        : step.kind === 'loading'
          ? `Loading Parakeet… ${String(Math.round(step.fraction * 100))}%`
          : step.kind === 'running'
            ? `Transcribing… ${String(step.done)} of ${String(step.total)}`
            : `Run ${String(SPIKE_CLIPS.length)} Recordings`;

  return (
    <SettingsPage testID="settings-page-speech-spike">
      <Section
        footer={
          <>
            <Footer>
              Measures Parakeet inside this app on Nik’s recordings, fetched once from the
              repository. The first load fetches the model from Hugging Face and prepares it for
              this iPhone, which takes minutes. For internal testing: a run takes over dictation’s
              Parakeet until it ends.
            </Footer>
            {notice ? (
              <Footer selectable testID="speech-spike-notice" tone="danger">
                {notice}
              </Footer>
            ) : null}
          </>
        }
        header="Model"
      >
        {VERSIONS.map((each) => (
          <CheckRow
            checked={options.version === each.version}
            disabled={!idle}
            key={each.version}
            onPress={() => store.setOptions({ version: each.version })}
            testID={`speech-spike-version-${each.version}`}
            title={each.name}
            value={each.size}
          />
        ))}
        <SwitchRow
          disabled={!idle}
          onValueChange={(on) =>
            store.setOptions({ vocabulary: withPeople(options.vocabulary, on) })
          }
          title="The People as Vocabulary"
          value={hasPeople(options.vocabulary)}
        />
        <SwitchRow
          disabled={!idle}
          onValueChange={(on) =>
            store.setOptions({ vocabulary: withPlaces(options.vocabulary, on) })
          }
          title="The Places as Vocabulary"
          value={hasPlaces(options.vocabulary)}
        />
        <SwitchRow
          disabled={!idle}
          onValueChange={(device) => store.setOptions({ device })}
          title="This iPhone’s Names and Places"
          value={options.device}
        />
        <SwitchRow
          disabled={!idle}
          onValueChange={(beside) => store.setOptions({ beside })}
          title="Assistant’s Model Loaded Beside"
          value={options.beside}
        />
        <ActionRow
          disabled={!idle}
          onPress={() => void store.run()}
          testID="speech-spike-run"
          title={status}
        />
      </Section>

      {memory ? (
        <Section header="This Device">
          <Row title="App Holds" value={megabytes(memory.footprint)} />
          <Row
            title="App May Still Take"
            value={memory.available > 0 ? megabytes(memory.available) : 'Not reported here'}
          />
        </Section>
      ) : null}

      {report ? (
        <Section
          footer={
            <>
              {report.cut ? (
                <Footer selectable tone="danger">
                  {`Cut short: ${report.cut}`}
                </Footer>
              ) : null}
              <Footer>
                Error rate over the sheet’s words; places and full names written right with case and
                accents folded. Parakeet by NVIDIA (CC BY 4.0), through FluidAudio (Apache 2.0).
              </Footer>
            </>
          }
          header={`Result: ${report.options.version}${report.simulator ? ' (simulator)' : ''}`}
          testID="speech-spike-result"
        >
          <GroupScores scores={report.scores} />
          {report.memoryWarnings > 0 ? (
            <Row
              title="Memory Warnings"
              value={`${String(report.memoryWarnings)} (the Assistant’s model may have gone)`}
            />
          ) : null}
          <Row
            testID="speech-spike-timing"
            title="Per Recording"
            value={
              report.rows.length === 0
                ? '–'
                : `${String(Math.round(report.timing.medianMs))} ms median · ${String(Math.round(report.timing.p90Ms))} ms p90`
            }
          />
          <Row title="Time to Load" value={`${(report.loadMs / 1000).toFixed(1)} s`} />
          <Row
            testID="speech-spike-peak"
            title="App Held at Most"
            value={megabytes(report.memory.peak)}
          />
          <Row
            title="Before · Assistant · Parakeet"
            value={`${megabytes(report.memory.before)} · ${megabytes(report.memory.afterAssistant)} · ${megabytes(report.memory.afterLoad)}`}
          />
          <Row
            title="Least Left to Take"
            value={
              report.memory.leastAvailable && report.memory.leastAvailable > 0
                ? megabytes(report.memory.leastAvailable)
                : 'Not reported here'
            }
          />
          <ActionRow
            onPress={() => void store.share()}
            testID="speech-spike-share"
            title="Share Report"
          />
          <View style={styles.rows}>
            {report.rows.map((row) => (
              <View key={row.id} style={styles.row}>
                <Text style={styles.heard}>{row.text}</Text>
                <Text selectable style={styles.detail}>
                  {`${row.id} · ${String(Math.round(row.ms))} ms${row.raw === undefined ? '' : ` · was “${row.raw}”`}`}
                </Text>
              </View>
            ))}
          </View>
        </Section>
      ) : null}
    </SettingsPage>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    detail: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    heard: {
      color: colors.text,
      fontSize: 15,
    },
    row: {
      gap: 2,
    },
    rows: {
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
  });
