import React, { useEffect, useMemo, useState } from 'react';
import { SafeAreaView, View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, Dimensions, Platform } from 'react-native';
import Constants from 'expo-constants';
import { Svg, Circle, Rect } from 'react-native-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface ShapeCircle {
  type: 'circle';
  cx: number;
  cy: number;
  r: number;
  fill: string;
  opacity?: number;
}

interface ShapeRect {
  type: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  rx?: number;
  fill: string;
  opacity?: number;
}

type Shape = ShapeCircle | ShapeRect;

interface GenerateResponse {
  summary: string;
  emotions?: { name: string; intensity: number }[];
  palette: string[];
  shapes: Shape[];
  canvas: { width: number; height: number };
  seed: string;
}

const API_BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL as string) || (Constants.expoConfig?.extra as any)?.apiBaseUrl || 'http://localhost:3001';

function DreamInput({ value, onChange, onSubmit, loading }: { value: string; onChange: (t: string) => void; onSubmit: () => void; loading: boolean }) {
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ fontSize: 16, fontWeight: '600' }}>Rüya Metni</Text>
      <TextInput
        placeholder="Rüyanızı yazın (TR)"
        value={value}
        onChangeText={onChange}
        multiline
        style={{
          minHeight: 120,
          borderWidth: 1,
          borderColor: '#ddd',
          borderRadius: 10,
          padding: 12,
          textAlignVertical: 'top',
          backgroundColor: '#fff',
        }}
      />
      <TouchableOpacity
        onPress={onSubmit}
        disabled={loading || value.trim().length < 5}
        style={{
          backgroundColor: loading || value.trim().length < 5 ? '#ccc' : '#111827',
          padding: 14,
          alignItems: 'center',
          borderRadius: 10,
        }}
      >
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '700' }}>Görselleştir</Text>}
      </TouchableOpacity>
    </View>
  );
}

function PaletteChips({ palette }: { palette: string[] }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
      {palette.map((c) => (
        <View key={c} style={{ backgroundColor: c, width: 28, height: 28, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(0,0,0,0.1)' }} />
      ))}
    </View>
  );
}

function Visualization({ result }: { result: GenerateResponse }) {
  const windowWidth = Dimensions.get('window').width - 24; // padding compensation
  const scale = windowWidth / result.canvas.width;
  const canvasHeight = Math.round(result.canvas.height * scale);

  return (
    <View style={{ gap: 8 }}>
      <Svg width={windowWidth} height={canvasHeight} viewBox={`0 0 ${result.canvas.width} ${result.canvas.height}`}>
        {result.shapes.map((s, idx) => {
          if (s.type === 'circle') {
            return <Circle key={idx} cx={s.cx} cy={s.cy} r={s.r} fill={s.fill} opacity={s.opacity ?? 0.8} />;
          }
          return <Rect key={idx} x={s.x} y={s.y} width={s.width} height={s.height} rx={(s as any).rx ?? 0} fill={s.fill} opacity={s.opacity ?? 0.8} />;
        })}
      </Svg>
      <PaletteChips palette={result.palette} />
    </View>
  );
}

export default function App() {
  const [text, setText] = useState('Geniş bir denizde uçarken ateş ışıkları gördüm.');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [apiBase, setApiBase] = useState<string>(API_BASE_URL);
  const [history, setHistory] = useState<Array<{ id: string; text: string; summary: string; palette: string[]; createdAt: number }>>([]);

  const canSubmit = text.trim().length >= 5;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`${apiBase}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Sunucu hatası: ${resp.status}`);
      }
      const data = (await resp.json()) as GenerateResponse;
      setResult(data);
      const item = { id: `${Date.now()}`, text, summary: data.summary, palette: data.palette, createdAt: Date.now() };
      setHistory((prev) => {
        const next = [item, ...prev].slice(0, 20);
        AsyncStorage.setItem('dream_history', JSON.stringify(next)).catch(() => {});
        return next;
      });
    } catch (e: any) {
      setError(e.message || 'Bir hata oluştu');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    AsyncStorage.getItem('dream_history')
      .then((raw) => {
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setHistory(parsed);
      })
      .catch(() => {});
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#f5f6f8' }}>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 16 }} keyboardShouldPersistTaps="handled">
        <Text style={{ fontSize: 22, fontWeight: '800' }}>DreamViz</Text>

        <View style={{ gap: 8 }}>
          <Text style={{ fontWeight: '600' }}>API Adresi</Text>
          <TextInput
            value={apiBase}
            onChangeText={setApiBase}
            autoCapitalize="none"
            autoCorrect={false}
            style={{ borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 10, backgroundColor: '#fff' }}
            placeholder={Platform.select({ ios: 'http://localhost:3001', android: 'http://10.0.2.2:3001', default: 'http://localhost:3001' })}
          />
        </View>

        <DreamInput value={text} onChange={setText} onSubmit={handleSubmit} loading={loading} />

        {error ? (
          <Text style={{ color: 'tomato' }}>{error}</Text>
        ) : null}

        {result ? (
          <View style={{ gap: 8 }}>
            <Text style={{ fontWeight: '700' }}>Özet</Text>
            <Text>{result.summary}</Text>
            <Visualization result={result} />
          </View>
        ) : null}

        {history.length > 0 ? (
          <View style={{ gap: 8 }}>
            <Text style={{ fontWeight: '700', marginTop: 8 }}>Geçmiş</Text>
            {history.map((h) => (
              <TouchableOpacity
                key={h.id}
                onPress={() => setText(h.text)}
                style={{ padding: 10, backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#eee', marginBottom: 6 }}
              >
                <Text numberOfLines={2} style={{ fontWeight: '600' }}>{h.text}</Text>
                <Text numberOfLines={1} style={{ color: '#666', marginTop: 4 }}>{h.summary}</Text>
                <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
                  {h.palette.slice(0, 6).map((c, i) => (
                    <View key={`${h.id}-${i}`} style={{ width: 16, height: 16, backgroundColor: c, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(0,0,0,0.1)' }} />
                  ))}
                </View>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
