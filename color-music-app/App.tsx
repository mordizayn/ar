import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
import { Audio } from 'expo-av';
import { toByteArray, fromByteArray } from 'base64-js';
import { decode as decodeJpeg } from 'jpeg-js';

type Rgb = { r: number; g: number; b: number };
type Cluster = { center: Rgb; weight: number };
type Note = { frequencyHz: number; durationSec: number; gain: number };

export default function App() {
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [palette, setPalette] = useState<Cluster[] | null>(null);
  const [audioUri, setAudioUri] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);

  useEffect(() => {
    Audio.setAudioModeAsync({ playsInSilentModeIOS: true }).catch(() => {});
  }, []);

  const pickImage = useCallback(async () => {
    setErrorMessage(null);
    setIsProcessing(true);
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        throw new Error('Galeri izni verilmedi.');
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1,
        base64: false,
      });
      if (result.canceled || result.assets.length === 0) {
        setIsProcessing(false);
        return;
      }
      const asset = result.assets[0];

      const manipulated = await ImageManipulator.manipulateAsync(
        asset.uri,
        [{ resize: { width: 256 } }],
        { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG, base64: true }
      );

      if (!manipulated.base64) {
        throw new Error('Görüntü dönüştürülemedi.');
      }

      setImageUri(manipulated.uri);

      // Process image -> palette -> notes -> wav -> play
      const { clusters } = await extractPaletteFromBase64Jpeg(manipulated.base64);
      setPalette(clusters);
      const notes = mapPaletteToNotes(clusters);
      const wavBase64 = synthesizeWavBase64(notes, 44100);
      const uri = await saveWavToCache(wavBase64);
      const newSound = await playSound(uri, soundRef.current);
      soundRef.current = newSound;
      setAudioUri(uri);
    } catch (err: any) {
      setErrorMessage(err?.message ?? 'Beklenmeyen bir hata oluştu.');
    } finally {
      setIsProcessing(false);
    }
  }, []);

  const stopPlayback = useCallback(async () => {
    try {
      if (soundRef.current) {
        await soundRef.current.stopAsync();
        await soundRef.current.unloadAsync();
      }
    } catch {
      // ignore
    } finally {
      soundRef.current = null;
    }
  }, []);

  const playExisting = useCallback(async () => {
    if (!audioUri) return;
    const newSound = await playSound(audioUri, soundRef.current);
    soundRef.current = newSound;
  }, [audioUri]);

  return (
    <View style={styles.container}>
      <StatusBar style="auto" />
      <Text style={styles.title}>Renklerden Müzik</Text>
      <Text style={styles.subtitle}>
        Bir resim seçin, renklerinden müzik oluşturalım.
      </Text>

      <View style={styles.buttonRow}>
        <Pressable style={styles.button} onPress={pickImage} disabled={isProcessing}>
          <Text style={styles.buttonText}>{isProcessing ? 'İşleniyor…' : 'Resim Seç'}</Text>
        </Pressable>
        <Pressable
          style={[styles.button, !audioUri && styles.buttonDisabled]}
          onPress={playExisting}
          disabled={!audioUri || isProcessing}
        >
          <Text style={styles.buttonText}>Çal</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={stopPlayback} disabled={isProcessing}>
          <Text style={styles.buttonText}>Durdur</Text>
        </Pressable>
      </View>

      {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

      <ScrollView contentContainerStyle={styles.content}>
        {imageUri ? (
          <Image source={{ uri: imageUri }} style={styles.preview} resizeMode="contain" />
        ) : (
          <View style={styles.previewPlaceholder}>
            <Text style={styles.placeholderText}>Henüz bir resim seçilmedi</Text>
          </View>
        )}

        {isProcessing ? <ActivityIndicator size="large" style={{ marginTop: 16 }} /> : null}

        {palette ? (
          <View style={{ marginTop: 16, width: '100%' }}>
            <Text style={styles.sectionTitle}>Palet</Text>
            <View style={styles.paletteRow}>
              {palette.map((c, idx) => (
                <View key={idx} style={styles.paletteItem}>
                  <View
                    style={{
                      height: 34,
                      width: 34,
                      borderRadius: 8,
                      backgroundColor: rgbToHex(c.center),
                      borderWidth: 1,
                      borderColor: 'rgba(0,0,0,0.1)',
                    }}
                  />
                  <Text style={styles.paletteText}>{rgbToHex(c.center)}</Text>
                  <Text style={styles.paletteMeta}>Ağırlık: {(c.weight * 100).toFixed(0)}%</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

async function extractPaletteFromBase64Jpeg(base64Jpeg: string, k = 5) {
  const bytes = toByteArray(base64Jpeg);
  const decoded = decodeJpeg(bytes, { useTArray: true });
  const { width, height, data } = decoded; // RGBA

  const samples: Rgb[] = [];
  const stride = 4; // RGBA
  const step = Math.max(1, Math.floor(Math.min(width, height) / 64));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const idx = (y * width + x) * stride;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      samples.push({ r, g, b });
    }
  }

  const clusters = kmeans(samples, k, 8);
  return { clusters };
}

function kmeans(points: Rgb[], k: number, maxIters: number): Cluster[] {
  if (points.length === 0) return [];
  const centers: Rgb[] = [];
  const chosen = new Set<number>();
  while (centers.length < k && centers.length < points.length) {
    const i = Math.floor(Math.random() * points.length);
    if (!chosen.has(i)) {
      centers.push({ ...points[i] });
      chosen.add(i);
    }
  }
  while (centers.length < k) centers.push({ ...points[0] });

  let assignments = new Array(points.length).fill(0);
  for (let iter = 0; iter < maxIters; iter++) {
    // Assign
    for (let i = 0; i < points.length; i++) {
      let best = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let c = 0; c < centers.length; c++) {
        const d = dist2(points[i], centers[c]);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      assignments[i] = best;
    }

    // Recompute
    const sums = new Array(centers.length).fill(0).map(() => ({ r: 0, g: 0, b: 0, n: 0 }));
    for (let i = 0; i < points.length; i++) {
      const c = assignments[i];
      const p = points[i];
      sums[c].r += p.r;
      sums[c].g += p.g;
      sums[c].b += p.b;
      sums[c].n += 1;
    }
    for (let c = 0; c < centers.length; c++) {
      if (sums[c].n > 0) {
        centers[c] = {
          r: sums[c].r / sums[c].n,
          g: sums[c].g / sums[c].n,
          b: sums[c].b / sums[c].n,
        };
      }
    }
  }

  // Weights
  const weights = new Array(centers.length).fill(0);
  for (const a of assignments) weights[a]++;
  const total = points.length;
  const clusters: Cluster[] = centers.map((c, i) => ({ center: clampRgb(c), weight: weights[i] / total }));
  clusters.sort((a, b) => rgbToHsv(a.center).h - rgbToHsv(b.center).h);
  return clusters;
}

function dist2(a: Rgb, b: Rgb): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

function clampRgb(c: Rgb): Rgb {
  return { r: clamp(c.r, 0, 255), g: clamp(c.g, 0, 255), b: clamp(c.b, 0, 255) };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function rgbToHsv(rgb: Rgb): { h: number; s: number; v: number } {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0));
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h *= 60;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return { h, s, v };
}

function rgbToHex(c: Rgb): string {
  const rh = c.r.toFixed(0).padStart(1, '0');
  const gh = c.g.toFixed(0).padStart(1, '0');
  const bh = c.b.toFixed(0).padStart(1, '0');
  const r = clamp(Math.round(Number(rh)), 0, 255).toString(16).padStart(2, '0');
  const g = clamp(Math.round(Number(gh)), 0, 255).toString(16).padStart(2, '0');
  const b = clamp(Math.round(Number(bh)), 0, 255).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`.toUpperCase();
}

function mapPaletteToNotes(clusters: Cluster[]): Note[] {
  const scaleSemis = [0, 2, 4, 5, 7, 9, 11]; // C maj
  const baseMidi = 52; // E3, a bit bright
  const octaves = 3;
  const scale: number[] = [];
  for (let o = 0; o < octaves; o++) {
    for (const s of scaleSemis) scale.push(baseMidi + o * 12 + s);
  }
  const N = scale.length;

  const notes: Note[] = clusters.map((c) => {
    const hsv = rgbToHsv(c.center);
    const idx = Math.round(((hsv.h % 360) / 360) * (N - 1));
    const midi = clamp(scale[idx], 24, 96);
    const frequencyHz = 440 * Math.pow(2, (midi - 69) / 12);
    const durationSec = clamp(0.35 + c.weight * 1.1, 0.25, 1.5);
    const gain = clamp(0.25 + hsv.v * 0.65, 0.15, 0.9);
    return { frequencyHz, durationSec, gain };
  });

  // Ensure at least one note
  if (notes.length === 0) {
    return [{ frequencyHz: 440, durationSec: 0.6, gain: 0.5 }];
  }
  return notes;
}

function synthesizeWavBase64(sequence: Note[], sampleRate: number): string {
  const attack = 0.01;
  const decay = 0.08;
  const sustainLevel = 0.7;
  const release = 0.12;

  const totalSamples = Math.floor(
    sequence.reduce((acc, n) => acc + n.durationSec, 0) * sampleRate + release * sampleRate
  );
  const samples = new Float32Array(totalSamples);

  let cursor = 0;
  for (const note of sequence) {
    const nSamp = Math.floor(note.durationSec * sampleRate);
    for (let i = 0; i < nSamp; i++) {
      const t = i / sampleRate;
      const env = adsr(t, attack, decay, sustainLevel, note.durationSec, release);
      const value = Math.sin(2 * Math.PI * note.frequencyHz * t) * env * note.gain;
      const idx = cursor + i;
      if (idx < samples.length) samples[idx] += value;
    }
    cursor += nSamp;
  }

  // Apply simple limiter
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const norm = peak > 1 ? 1 / peak : 1;
  for (let i = 0; i < samples.length; i++) samples[i] *= norm;

  const wavBytes = floatTo16BitWav(samples, sampleRate);
  return fromByteArray(wavBytes);
}

function adsr(
  t: number,
  attack: number,
  decay: number,
  sustainLevel: number,
  noteDuration: number,
  release: number
): number {
  if (t < attack) return t / attack; // Attack
  if (t < attack + decay) {
    const dt = (t - attack) / decay;
    return 1 - dt * (1 - sustainLevel);
  }
  if (t < noteDuration) return sustainLevel;
  if (t < noteDuration + release) {
    const rt = (t - noteDuration) / release;
    return sustainLevel * (1 - rt);
  }
  return 0;
}

function floatTo16BitWav(float32: Float32Array, sampleRate: number): Uint8Array {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  const dataSize = float32.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');

  // fmt chunk
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample

  // data chunk
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // samples
  let offset = 44;
  for (let i = 0; i < float32.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

async function saveWavToCache(base64Wav: string): Promise<string> {
  const uri = `${FileSystem.cacheDirectory}color-music.wav`;
  await FileSystem.writeAsStringAsync(uri, base64Wav, { encoding: FileSystem.EncodingType.Base64 });
  return uri;
}

async function playSound(uri: string, previous?: Audio.Sound | null): Promise<Audio.Sound> {
  try {
    if (previous) {
      try { await previous.stopAsync(); } catch {}
      try { await previous.unloadAsync(); } catch {}
    }
  } catch {}
  const sound = new Audio.Sound();
  await sound.loadAsync({ uri });
  await sound.playAsync();
  return sound;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    paddingTop: Platform.select({ ios: 48, android: 32, default: 24 }),
    paddingHorizontal: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
  },
  subtitle: {
    textAlign: 'center',
    color: '#666',
    marginTop: 4,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'center',
    marginTop: 16,
  },
  button: {
    backgroundColor: '#111827',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
  },
  content: {
    alignItems: 'center',
    paddingVertical: 16,
  },
  preview: {
    width: '100%',
    height: 280,
    borderRadius: 12,
    backgroundColor: '#f3f4f6',
  },
  previewPlaceholder: {
    width: '100%',
    height: 280,
    borderRadius: 12,
    backgroundColor: '#f3f4f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholderText: {
    color: '#6b7280',
  },
  sectionTitle: {
    fontWeight: '700',
    marginBottom: 8,
    fontSize: 16,
  },
  paletteRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
  },
  paletteItem: {
    alignItems: 'center',
    width: 88,
  },
  paletteText: {
    marginTop: 6,
    fontVariant: ['tabular-nums'],
  },
  paletteMeta: {
    fontSize: 12,
    color: '#6b7280',
  },
  error: {
    textAlign: 'center',
    color: '#b91c1c',
    marginTop: 8,
  },
});
