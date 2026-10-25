// Home: say (well, type, until Whisper lands) where you're going, or tap a saved place.
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useTheme } from "../components/theme";
import { searchPlaces, type PlaceResult } from "../lib/places";
import { matchDestination, type SavedDestination } from "../lib/savedDestinations";
import { savedDestinations } from "../lib/storage";

function drive(dest: { name: string; lat: number; lng: number; placeId?: string }, demo = false) {
  router.push({
    pathname: "/drive",
    params: { name: dest.name, lat: String(dest.lat), lng: String(dest.lng), placeId: dest.placeId ?? "", demo: demo ? "1" : "" },
  });
}

export default function Home() {
  const t = useTheme();
  const [saved, setSaved] = useState<SavedDestination[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useFocusEffect(
    useCallback(() => {
      void savedDestinations.list().then(setSaved);
    }, []),
  );

  const go = async () => {
    const spoken = query.trim();
    if (!spoken) return;
    // "take me home" → the saved Home, no search needed.
    const match = matchDestination(spoken, saved);
    if (match) return drive({ name: match.label, lat: match.lat, lng: match.lng, placeId: match.placeId });
    setBusy(true);
    setError(undefined);
    try {
      const found = await searchPlaces(spoken);
      setResults(found);
      if (!found.length) setError(`Couldn't find "${spoken}". Try a name or an address.`);
    } catch {
      setError("Search failed. Check your connection and the Maps API key.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      <Text style={[styles.prompt, { color: t.ink }]}>Where are we going? And don't say "I'll know it when I see it."</Text>
      <View style={styles.row}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={go}
          placeholder={'"Take me home" or "Target"'}
          placeholderTextColor={t.muted}
          returnKeyType="go"
          style={[styles.input, { color: t.ink, borderColor: t.line, backgroundColor: t.panel }]}
        />
        <Pressable onPress={go} style={[styles.button, { backgroundColor: t.accent }]} accessibilityRole="button">
          <Text style={styles.buttonText}>Go</Text>
        </Pressable>
      </View>
      {busy && <ActivityIndicator color={t.accent} />}
      {error && <Text style={{ color: t.roast }}>{error}</Text>}

      {results.length > 0 && (
        <FlatList
          data={results}
          keyExtractor={(p) => p.placeId}
          style={styles.list}
          renderItem={({ item }) => (
            <Pressable onPress={() => drive(item)} onLongPress={() => drive(item, true)} style={[styles.item, { borderColor: t.line }]}>
              <Text style={[styles.itemTitle, { color: t.ink }]}>{item.name}</Text>
              <Text style={{ color: t.muted }}>{item.address}</Text>
            </Pressable>
          )}
        />
      )}

      <View style={styles.sectionHead}>
        <Text style={[styles.section, { color: t.muted }]}>SAVED PLACES</Text>
        <Pressable onPress={() => router.push("/saved")}>
          <Text style={{ color: t.accent, fontWeight: "600" }}>Edit</Text>
        </Pressable>
      </View>
      {saved.length === 0 ? (
        <Text style={{ color: t.muted }}>Nothing saved yet. Add Home and Work so I can mock you faster.</Text>
      ) : (
        <FlatList
          data={saved}
          keyExtractor={(d) => d.id}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => drive({ name: item.label, lat: item.lat, lng: item.lng, placeId: item.placeId })}
              onLongPress={() => drive({ name: item.label, lat: item.lat, lng: item.lng, placeId: item.placeId }, true)}
              style={[styles.item, { borderColor: t.line }]}
            >
              <Text style={[styles.itemTitle, { color: t.ink }]}>{item.label}</Text>
              <Text style={{ color: t.muted }}>{item.address || item.name}</Text>
            </Pressable>
          )}
        />
      )}
      <Text style={[styles.hint, { color: t.muted }]}>Long-press a place for a simulated demo drive.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 12 },
  prompt: { fontSize: 20, fontWeight: "600" },
  row: { flexDirection: "row", gap: 8 },
  input: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  button: { borderRadius: 8, paddingHorizontal: 18, justifyContent: "center" },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  list: { flexGrow: 0, maxHeight: 260 },
  item: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 2 },
  itemTitle: { fontSize: 16, fontWeight: "600" },
  sectionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 },
  section: { fontSize: 12, fontWeight: "700", letterSpacing: 1 },
  hint: { fontSize: 12, marginTop: "auto" },
});
