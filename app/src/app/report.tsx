// End of trip: the grade, the breakdown, and the hall of shame.
import { router } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../components/theme";
import { lastTrip } from "../state/lastTrip";

const LABEL: Record<string, string> = {
  speeding: "speeding",
  tooSlow: "dawdling",
  traffic: "sat in traffic",
  hardBraking: "brake check",
  hardAccel: "jackrabbit start",
  longStop: "long stop",
  missedTurn: "missed turn",
  wrongTurn: "wrong-way turn",
  lateTurn: "late turn",
  unplannedStop: "unplanned stop",
  rerouted: "reroute",
};

export default function Report() {
  const t = useTheme();
  const trip = lastTrip.get();
  if (!trip) {
    return (
      <View style={[styles.screen, { backgroundColor: t.bg }]}>
        <Text style={{ color: t.muted }}>No trip yet. Go drive badly and come back.</Text>
      </View>
    );
  }
  const { report: r, destination } = trip;
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={styles.screen}>
      <View style={styles.header}>
        <View style={styles.sign} accessibilityLabel={`Trip grade ${r.overall.letter}`}>
          <Text style={styles.signSmall}>TRIP{"\n"}GRADE</Text>
          <Text style={styles.signBig}>{r.overall.letter}</Text>
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={[styles.dest, { color: t.muted }]}>To {destination}</Text>
          <Text style={[styles.quip, { color: t.ink }]}>{r.overall.quip}</Text>
        </View>
      </View>

      <View style={[styles.card, { backgroundColor: t.panel, borderColor: t.line }]}>
        <Text style={[styles.section, { color: t.muted }]}>FOLLOWING DIRECTIONS</Text>
        <Text style={[styles.value, { color: t.ink }]}>
          {r.instructions.letter} · {r.instructions.score}
        </Text>
        <Text style={{ color: t.muted }}>
          {r.instructions.onTime} on time, {r.instructions.late} late, {r.instructions.missed} missed, {r.instructions.wrongWay} wrong way,{" "}
          {r.instructions.reroutes} reroutes
        </Text>
      </View>
      <View style={[styles.card, { backgroundColor: t.panel, borderColor: t.line }]}>
        <Text style={[styles.section, { color: t.muted }]}>DRIVING</Text>
        <Text style={[styles.value, { color: t.ink }]}>
          {r.driving.letter} · {r.driving.score}
        </Text>
        <Text style={{ color: t.muted }}>
          {r.driving.speedingSeconds}s speeding (worst +{r.driving.maxOverLimit}), {r.driving.hardBrakes} brake checks, {r.driving.hardAccels}{" "}
          jackrabbit starts
        </Text>
      </View>

      <View style={[styles.card, { backgroundColor: t.panel, borderColor: t.line }]}>
        <Text style={[styles.section, { color: t.muted }]}>WHERE YOU WENT WRONG</Text>
        {r.heatmap.cells.length === 0 ? (
          <Text style={{ color: t.muted }}>Nowhere. Suspicious.</Text>
        ) : (
          r.heatmap.cells.slice(0, 6).map((c) => (
            <View key={`${c.lat},${c.lon}`} style={styles.shameRow}>
              <Text style={[styles.heat, { color: t.roast }]}>{c.weight.toFixed(1)}</Text>
              <Text style={{ color: t.ink, flex: 1 }}>
                {Object.entries(c.kinds)
                  .map(([k, n]) => (n && n > 1 ? `${LABEL[k] ?? k} ×${n}` : (LABEL[k] ?? k)))
                  .join(", ")}
              </Text>
            </View>
          ))
        )}
        <Text style={{ color: t.muted, fontSize: 12 }}>The map version of this heat map comes in a later update.</Text>
      </View>

      <Pressable onPress={() => router.replace("/")} style={[styles.button, { backgroundColor: t.accent }]}>
        <Text style={styles.buttonText}>Done</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 16, gap: 14 },
  header: { flexDirection: "row", gap: 16, alignItems: "center" },
  sign: { width: 96, backgroundColor: "#fff", borderColor: "#111", borderWidth: 3, borderRadius: 8, alignItems: "center", paddingVertical: 6 },
  signSmall: { color: "#111", fontWeight: "800", textAlign: "center", fontSize: 13, letterSpacing: 1 },
  signBig: { color: "#111", fontWeight: "900", fontSize: 52, lineHeight: 58 },
  dest: { fontSize: 13, fontWeight: "600" },
  quip: { fontSize: 17, fontWeight: "500" },
  card: { borderWidth: 1, borderRadius: 10, padding: 14, gap: 4 },
  section: { fontSize: 12, fontWeight: "700", letterSpacing: 1 },
  value: { fontSize: 24, fontWeight: "800" },
  shameRow: { flexDirection: "row", gap: 10, paddingVertical: 4 },
  heat: { width: 40, fontVariant: ["tabular-nums"], fontWeight: "700" },
  button: { borderRadius: 8, paddingVertical: 14, alignItems: "center" },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
