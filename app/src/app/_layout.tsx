import { NavigationProvider, TaskRemovedBehavior } from "@googlemaps/react-native-navigation-sdk";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useTheme } from "../components/theme";

export default function RootLayout() {
  const theme = useTheme();
  return (
    <NavigationProvider
      termsAndConditionsDialogOptions={{ title: "Before we drive", companyName: "Backseat Driver" }}
      taskRemovedBehavior={TaskRemovedBehavior.CONTINUE_SERVICE}
    >
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.panel },
          headerTintColor: theme.ink,
          contentStyle: { backgroundColor: theme.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: "Backseat Driver" }} />
        <Stack.Screen name="saved" options={{ title: "Saved places" }} />
        <Stack.Screen name="drive" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="report" options={{ title: "Trip report", headerBackVisible: false }} />
      </Stack>
    </NavigationProvider>
  );
}
