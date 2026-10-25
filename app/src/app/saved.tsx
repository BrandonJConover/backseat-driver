// Manage saved places: name it ("Home", "Mom's"), search for it, tap the right result.
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useTheme } from "../components/theme";
import { searchPlaces, type PlaceResult } from "../lib/places";
import type { SavedDestination } from "../lib/savedDestinations";
import { savedDestinations } from "../lib/storage";

export default function Saved() {
  const t = useTheme();
  const [saved, setSaved] = useState<SavedDestination[]>([]);
  const [label, setLabel] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [message, setMessage] = useState<string>();

  const refresh = useCallback(() => void savedDestinations.list().then(setSaved), []);
  useFocusEffect(refresh);

  const search = async () => {
    if (!query.trim()) return;
    try {
      setResults(await searchPlaces(query.trim()));
      setMessage(undefined);
    } catch {
      setMessage("Search failed. Check your connection and the Maps API key.");
    }
  };

  const save = async (p: PlaceResult) => {
    const name = label.trim() || p.name;
    await savedDestinations.save({ label: name, aliases: [], name: p.name, address: p.address, placeId: p.placeId, lat: p.lat, lng: p.lng });
    setLabel("");
    setQuery("");
    setResults([]);
    setMessage(`Saved "${name}". Now you have no excuse for getting lost.`);
    refresh();
  };

  const input = [styles.input, { color: t.ink, borderColor: t.line, backgroundColor: t.panel }];
  return (
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      <Text style={[styles.section, { color: t.muted }]}>ADD A PLACE</Text>
      <TextInput value={label} onChangeText={setLabel} placeholder="Name it: Home, Work, Mom's" placeholderTextColor={t.muted} style={input} />
      <TextInput
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={search}
        placeholder="Search for the address or business"
        placeholderTextColor={t.muted}
        returnKeyType="search"
        style={input}
      />
      {message && <Text style={{ color: t.muted }}>{message}</Text>}
      {results.map((p) => (
        <Pressable key={p.placeId} onPress={() => save(p)} style={[styles.item, { borderColor: t.line }]}>
          <Text style={[styles.itemTitle, { color: t.ink }]}>{p.name}</Text>
          <Text style={{ color: t.muted }}>{p.address}</Text>
        </Pressable>
      ))}

      <Text style={[styles.section, { color: t.muted, marginTop: 16 }]}>SAVED</Text>
      <FlatList
        data={saved}
        keyExtractor={(d) => d.id}
        ListEmptyComponent={<Text style={{ color: t.muted }}>Nothing yet.</Text>}
        renderItem={({ item }) => (
          <View style={[styles.item, styles.savedRow, { borderColor: t.line }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.itemTitle, { color: t.ink }]}>{item.label}</Text>
              <Text style={{ color: t.muted }}>{item.address || item.name}</Text>
            </View>
            <Pressable onPress={() => savedDestinations.remove(item.id).then(refresh)} accessibilityLabel={`Delete ${item.label}`}>
              <Text style={{ color: t.roast, fontWeight: "600" }}>Delete</Text>
            </Pressable>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 10 },
  section: { fontSize: 12, fontWeight: "700", letterSpacing: 1 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  item: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 2 },
  itemTitle: { fontSize: 16, fontWeight: "600" },
  savedRow: { flexDirection: "row", alignItems: "center", gap: 12 },
});
