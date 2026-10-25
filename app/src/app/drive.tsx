// The drive: Google's navigation map full screen, Backseat Driver's commentary on top.
// Google's own voice is muted; every spoken line comes from the critique engine.
import {
  AudioGuidanceMode,
  NavigationSessionStatus,
  NavigationView,
  RouteStatus,
  TravelMode,
  useNavigation,
  type Waypoint,
} from "@googlemaps/react-native-navigation-sdk";
import type { Commentary } from "@backseat/engine";
import * as Battery from "expo-battery";
import * as Location from "expo-location";
import { router, useLocalSearchParams } from "expo-router";
import { Pedometer } from "expo-sensors";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../components/theme";
import { placeAt } from "../lib/places";
import { systemSpeaker } from "../lib/speaker";
import { SpeechQueue } from "../lib/speechQueue";
import { OsmSpeedLimits } from "../lib/speedLimits";
import { appendTrip, loadHistory } from "../lib/storage";
import { TripSession } from "../lib/tripSession";
import { lastTrip } from "../state/lastTrip";

const speedLimits = new OsmSpeedLimits();

const SESSION_ERRORS: Partial<Record<NavigationSessionStatus, string>> = {
  [NavigationSessionStatus.NOT_AUTHORIZED]: "The Google Maps API key isn't authorized for the Navigation SDK.",
  [NavigationSessionStatus.TERMS_NOT_ACCEPTED]: "You have to accept the terms. I don't make the rules. Google does.",
  [NavigationSessionStatus.LOCATION_PERMISSION_MISSING]: "I need your location. How else would I judge you?",
  [NavigationSessionStatus.NETWORK_ERROR]: "No network. Even I can't navigate without one.",
};

export default function Drive() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ name: string; lat: string; lng: string; placeId?: string; demo?: string }>();
  const { navigationController, setOnLocationChanged, setOnTurnByTurn, setOnReroutingRequestedByOffRoute, setOnArrival, removeAllListeners } =
    useNavigation();
  const [caption, setCaption] = useState<Commentary>();
  const [frustration, setFrustration] = useState(0);
  const [error, setError] = useState<string>();
  const session = useRef<TripSession | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const queue = new SpeechQueue(systemSpeaker);
    queue.onSpeak = (c) => {
      setCaption(c);
      setFrustration(c.frustration);
    };
    const subs: { remove(): void }[] = [];
    const destination = { name: params.name, lat: Number(params.lat), lng: Number(params.lng) };

    const start = async () => {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== "granted") return setError("I need your location. How else would I judge you?");

      if (!(await navigationController.showTermsAndConditionsDialog())) return setError(SESSION_ERRORS[NavigationSessionStatus.TERMS_NOT_ACCEPTED]);
      const status = await navigationController.init();
      if (status !== NavigationSessionStatus.OK) return setError(SESSION_ERRORS[status] ?? `Navigation failed to start (${status}).`);
      if (cancelled) return;

      await navigationController.setAudioGuidanceSettings({
        guidanceMode: AudioGuidanceMode.SILENT,
        vibrationEnabled: false,
        bluetoothAudioEnabled: false,
      });
      navigationController.setTurnByTurnLoggingEnabled(true);
      navigationController.setBackgroundLocationUpdatesEnabled(true);

      const history = await loadHistory();
      const trip = new TripSession(destination, {
        speak: (lines) => queue.push(lines),
        speedLimits,
        history,
        lookupPlace: placeAt,
        onFinished: ({ report, record }) => {
          void appendTrip(record);
          lastTrip.set({ report, incidents: trip.engine.incidents, destination: destination.name });
          // Let the arrival line play before switching screens.
          setTimeout(() => router.replace("/report"), 6000);
        },
      });
      session.current = trip;

      // Route calculation needs a location fix first, so wait for one.
      const firstFix = new Promise<void>((resolve) => {
        setOnLocationChanged((loc) => {
          trip.onLocation(loc);
          resolve();
        });
      });
      setOnTurnByTurn((events) => events[0] && trip.onTurnByTurn(events[0]));
      setOnReroutingRequestedByOffRoute(() => trip.onOffRoute());
      setOnArrival((e) => trip.onArrival(e.isFinalDestination ?? true));
      navigationController.startUpdatingLocation();
      await firstFix;
      if (cancelled) return;

      const waypoint: Waypoint = params.placeId
        ? { title: destination.name, placeId: params.placeId }
        : { title: destination.name, position: { lat: destination.lat, lng: destination.lng } };
      const route = await navigationController.setDestinations([waypoint], {
        routingOptions: { travelMode: TravelMode.DRIVING },
        displayOptions: { showDestinationMarkers: true },
      });
      if (route !== RouteStatus.OK) return setError(`Couldn't find a route (${route}). Even I can't get you there.`);
      await navigationController.startGuidance();
      if (params.demo) navigationController.simulator.simulateLocationsAlongExistingRoute({ speedMultiplier: 3 });

      subs.push(
        Battery.addBatteryLevelListener(async ({ batteryLevel }) => {
          const state = await Battery.getBatteryStateAsync();
          trip.onBattery(batteryLevel, state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL);
        }),
      );
      if (await Pedometer.isAvailableAsync()) {
        let last = 0;
        subs.push(
          Pedometer.watchStepCount(({ steps }) => {
            trip.addSteps(Math.max(0, steps - last));
            last = steps;
          }),
        );
      }
    };

    start().catch((e: unknown) => setError(`Something broke: ${e instanceof Error ? e.message : String(e)}`));

    return () => {
      cancelled = true;
      subs.forEach((s) => s.remove());
      removeAllListeners();
      queue.clear();
      navigationController.simulator.stopLocationSimulation();
      void navigationController.stopGuidance().then(() => navigationController.clearDestinations());
    };
    // One trip per screen mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.screen}>
      <NavigationView style={StyleSheet.absoluteFill} speedometerEnabled speedLimitIconEnabled tripProgressBarEnabled />
      <View style={[styles.overlay, { paddingBottom: insets.bottom + 12, backgroundColor: t.panel }]}>
        {error ? (
          <Text style={[styles.caption, { color: t.roast }]}>{error}</Text>
        ) : (
          <>
            <Text style={[styles.caption, { color: t.ink }]} numberOfLines={3}>
              {caption?.text ?? "Calculating route. And my opinion of you."}
            </Text>
            <View style={[styles.meter, { backgroundColor: t.line }]} accessibilityLabel={`Frustration ${frustration} percent`}>
              <View style={[styles.meterFill, { width: `${frustration}%`, backgroundColor: t.roast }]} />
            </View>
          </>
        )}
        <Pressable onPress={() => router.replace("/")} style={[styles.end, { borderColor: t.line }]} accessibilityRole="button">
          <Text style={{ color: t.ink, fontWeight: "600" }}>End trip</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  overlay: { position: "absolute", left: 0, right: 0, bottom: 0, paddingTop: 14, paddingHorizontal: 16, gap: 10, borderTopLeftRadius: 14, borderTopRightRadius: 14 },
  caption: { fontSize: 17, fontWeight: "500" },
  meter: { height: 6, borderRadius: 3, overflow: "hidden" },
  meterFill: { height: "100%" },
  end: { alignSelf: "flex-start", borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
});
