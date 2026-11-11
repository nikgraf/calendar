import { Temporal } from '@calendar/core';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState, Platform, StyleSheet, Text, View } from 'react-native';
import { loadProcessMemoryModule } from '../../../modules/solunivo-process-memory/index.ts';
import { describeAnswer, SPIKE_MODELS, SPIKE_TIME_ZONE, summarize } from '../../modelSpike.ts';
import { SPIKE_CASES } from '../../modelSpikeCases.ts';
import { createSpikeStore, type SpikeFiles } from '../../modelSpikeStore.ts';
import { loadOpenModelRuntime } from '../../openModel.ts';
import { ActionRow, Footer, Row, Section, SettingsPage } from '../GroupedList.tsx';
import { type ThemeColors, useStyles } from '../theme.ts';

/**
 * Native modules are loaded lazily and inside a try: a static import of a
 * module whose pod is missing crashes the app at launch on a binary built
 * before it. See appleSpeech.ts for the same rule.
 */
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

/** The model files under the app's documents, and the report through the share sheet. */
const deviceFiles = (): SpikeFiles | undefined => {
  const native = loadNative();
  if (!native) {
    return undefined;
  }
  const { Directory, File, Paths } = native.files;
  const fileOf = (name: string) => {
    const folder = new Directory(Paths.document, 'model-spike');
    if (!folder.exists) {
      folder.create();
    }
    return new File(folder, name);
  };
  return {
    download: async (model, onProgress, signal) => {
      const file = fileOf(model.file);
      await File.downloadFileAsync(model.url, file, {
        idempotent: true,
        onProgress: ({ bytesWritten }) => onProgress(bytesWritten),
        signal,
      });
      return file.size;
    },
    pathOf: (model) => fileOf(model.file).uri,
    remove: (model) => {
      const file = fileOf(model.file);
      if (file.exists) {
        file.delete();
      }
    },
    share: async (name, text) => {
      const file = new File(Paths.cache, name);
      if (file.exists) {
        file.delete();
      }
      file.create();
      file.write(text);
      await native.sharing.shareAsync(file.uri, { mimeType: 'application/json' });
    },
    sizeOf: (model) => {
      const file = fileOf(model.file);
      return file.exists ? file.size : undefined;
    },
  };
};

const probe = loadProcessMemoryModule();

const store = createSpikeStore({
  cases: SPIKE_CASES,
  files: deviceFiles(),
  keepAwake: (on) => probe?.keepAwake(on),
  memory: () => probe?.read(),
  now: Date.now,
  platform: `${Platform.OS} ${String(Platform.Version)}`,
  runtime: loadOpenModelRuntime(),
  today: () => Temporal.Now.plainDateISO(SPIKE_TIME_ZONE).toString(),
});

const SHORT_RUN = 20;

const gigabytes = (bytes: number): string => `${(bytes / 1_000_000_000).toFixed(2)} GB`;
const megabytes = (bytes: number): string => `${String(Math.round(bytes / 1_000_000))} MB`;
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/**
 * Measures a small open model on this device: fetch a model file, load it
 * into the app, send the model bench's first phrases through the app's
 * own quick-add pipeline, and read the time, the tokens per second and the
 * memory. The report it shares is scored on the Mac with the bench's
 * checks (`apps/desktop/e2e/bench/phoneReport.ts`). For internal
 * measuring only: the page is listed where the binary has the runtime,
 * which is the development variant. Nothing it does touches the calendar.
 */
export function ModelSpikePage() {
  const styles = useStyles(makeStyles);
  const { memory, notice, step, stored } = useSyncExternalStore(store.subscribe, store.getState);

  // What is here before any button: the stored files, the memory now.
  useEffect(() => {
    store.refresh();
  }, []);

  // A run must not go on in the background: iOS ends an app that asks the GPU for work there.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        store.stopRun();
      }
    });
    return () => subscription.remove();
  }, []);

  const busy = step.kind === 'downloading' || step.kind === 'loading' || step.kind === 'running';
  const loaded = step.kind === 'loaded' || step.kind === 'running' ? step.loaded : undefined;
  const rows =
    step.kind === 'running' ? step.rows : step.kind === 'loaded' ? (step.report?.rows ?? []) : [];
  const summary = summarize(rows);
  const hasRuntime = loadOpenModelRuntime() !== undefined;

  return (
    <SettingsPage testID="settings-page-model-spike">
      <Section
        footer={
          <>
            <Footer>
              Measures a small open model inside this app on the model bench’s first phrases. For
              internal testing: nothing here reads or changes the calendar.
            </Footer>
            {notice ? (
              <Footer selectable testID="model-spike-notice" tone="danger">
                {notice}
              </Footer>
            ) : null}
          </>
        }
        header="This Device"
      >
        <Row
          testID="model-spike-runtime"
          title="Runtime"
          value={hasRuntime ? 'llama.rn' : 'Not in this build'}
        />
        {memory ? (
          <>
            <Row title="Memory" value={gigabytes(memory.physical)} />
            <Row title="App Holds" value={megabytes(memory.footprint)} />
            <Row
              title="App May Still Take"
              value={memory.available > 0 ? megabytes(memory.available) : 'Not reported here'}
            />
          </>
        ) : null}
      </Section>

      {SPIKE_MODELS.map((model) => {
        const size = stored[model.file];
        const downloading = step.kind === 'downloading' && step.model.file === model.file;
        const loading = step.kind === 'loading' && step.model.file === model.file;
        return (
          <Section
            footer={`${model.url}\n${model.licence}. File by ${model.quantizedBy}.`}
            header={model.name}
            key={model.file}
          >
            <Row
              testID={`model-spike-file-${model.file}`}
              title="File"
              value={
                downloading
                  ? `${gigabytes(step.received)} of ${gigabytes(model.bytes)}`
                  : size === undefined
                    ? `Not here · ${gigabytes(model.bytes)}`
                    : gigabytes(size)
              }
            />
            {downloading ? (
              <ActionRow onPress={store.stopDownload} title="Stop Download" />
            ) : size === undefined ? (
              <ActionRow
                disabled={busy}
                onPress={() => void store.fetchModel(model)}
                title="Download"
              />
            ) : (
              <>
                <ActionRow
                  disabled={busy || !hasRuntime || loaded !== undefined}
                  onPress={() => void store.load(model)}
                  testID={`model-spike-load-${model.file}`}
                  title={loading ? `Loading… ${String(Math.round(step.percent))}%` : 'Load'}
                />
                <ActionRow
                  disabled={busy || loaded?.model.file === model.file}
                  onPress={() => store.removeModel(model)}
                  title="Delete File"
                  tone="destructive"
                />
              </>
            )}
          </Section>
        );
      })}

      {loaded ? (
        <Section
          footer="Keep the app open during a run: it stops when the app leaves the screen."
          header={`Loaded: ${loaded.model.name}`}
        >
          <Row title="Model" value={loaded.context.model.desc} />
          <Row
            testID="model-spike-gpu"
            title="GPU"
            value={loaded.context.gpu ? 'Yes' : `No (${loaded.context.reasonNoGPU || 'unknown'})`}
          />
          <Row testID="model-spike-load-time" title="Time to Load" value={seconds(loaded.loadMs)} />
          {loaded.memory ? (
            <Row
              title="App Holds, Loaded"
              value={`${megabytes(loaded.memory.footprint)} (${megabytes(loaded.footprintBefore)} before)`}
            />
          ) : null}
          {step.kind === 'running' ? (
            <ActionRow
              onPress={store.stopRun}
              title={`Stop (${String(step.rows.length)} of ${String(step.total)})`}
            />
          ) : (
            <>
              <ActionRow
                onPress={() => void store.run(SHORT_RUN)}
                testID="model-spike-run-short"
                title={`Run ${String(SHORT_RUN)} Phrases`}
              />
              <ActionRow
                onPress={() => void store.run(SPIKE_CASES.length)}
                testID="model-spike-run-all"
                title={`Run All ${String(SPIKE_CASES.length)} Phrases`}
              />
              <ActionRow onPress={() => void store.unload()} title="Unload" tone="destructive" />
            </>
          )}
        </Section>
      ) : null}

      {rows.length > 0 ? (
        <Section
          footer={
            summary.firstError === undefined ? undefined : (
              <Footer selectable testID="model-spike-first-error" tone="danger">
                {`The first call without an answer: ${summary.firstError}`}
              </Footer>
            )
          }
          header="Result"
          testID="model-spike-result"
        >
          <Row
            testID="model-spike-turns"
            title="Phrases"
            value={`${String(summary.turns)} · ${String(summary.parsed)} drafts`}
          />
          <Row
            testID="model-spike-median"
            title="Per Phrase"
            value={`${seconds(summary.medianMs)} median · ${seconds(summary.worstMs)} worst`}
          />
          <Row
            title="Tokens per Second"
            value={`${summary.promptTokensPerSecond.toFixed(0)} read · ${summary.answerTokensPerSecond.toFixed(0)} written`}
          />
          <Row
            title="Prompt Already Cached"
            value={`${String(Math.round(summary.cachedShare * 100))}%`}
          />
          {summary.failedCalls > 0 ? (
            <Row title="Calls Without an Answer" value={String(summary.failedCalls)} />
          ) : null}
          {step.kind === 'loaded' && step.report ? (
            <ActionRow
              onPress={() => void store.share()}
              testID="model-spike-share"
              title="Share Report"
            />
          ) : null}
          <View style={styles.answers}>
            {rows.map((row) => (
              <View key={row.id} style={styles.answer}>
                <Text style={styles.phrase}>{row.input}</Text>
                <Text selectable style={styles.made}>
                  {`${seconds(row.ms)} · ${describeAnswer(row.result)}`}
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
    answer: {
      gap: 2,
    },
    answers: {
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    made: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    phrase: {
      color: colors.text,
      fontSize: 15,
    },
  });
