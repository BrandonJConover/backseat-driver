// Config plugin for @googlemaps/react-native-navigation-sdk, which ships without one.
// Applies the native setup from the SDK's README during `npx expo prebuild`:
//   Android: API key meta-data, Jetifier, core library desugaring, Kotlin 2.3 (the SDK
//            needs Kotlin Gradle Plugin 2.3+; React Native 0.88 ships 2.2).
//   iOS:     GMSServices.provideAPIKey in AppDelegate, background modes, motion usage string.
// The key comes from the GOOGLE_MAPS_API_KEY environment variable at build time, so it
// never lands in the repo.

const {
  AndroidConfig,
  withAndroidManifest,
  withAppBuildGradle,
  withAppDelegate,
  withGradleProperties,
  withInfoPlist,
} = require("expo/config-plugins");

const KOTLIN_VERSION = "2.3.21";
const DESUGAR_DEP = "coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs_nio:2.1.5'";

function apiKey() {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    console.warn("[withGoogleNavigation] GOOGLE_MAPS_API_KEY is not set; navigation will fail to authorize.");
  }
  return key ?? "";
}

const withAndroid = (config) => {
  config = withAndroidManifest(config, (c) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(c.modResults);
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, "com.google.android.geo.API_KEY", apiKey());
    return c;
  });

  config = withGradleProperties(config, (c) => {
    const ours = { "android.enableJetifier": "true", "android.kotlinVersion": KOTLIN_VERSION };
    const props = c.modResults.filter((p) => !(p.type === "property" && p.key in ours));
    for (const [key, value] of Object.entries(ours)) props.push({ type: "property", key, value });
    c.modResults = props;
    return c;
  });

  config = withAppBuildGradle(config, (c) => {
    let gradle = c.modResults.contents;
    if (!gradle.includes("coreLibraryDesugaringEnabled")) {
      gradle = gradle.replace(/android\s*\{/, (m) => `${m}\n    compileOptions {\n        coreLibraryDesugaringEnabled true\n    }\n`);
    }
    if (!gradle.includes(DESUGAR_DEP)) {
      gradle = gradle.replace(/dependencies\s*\{/, (m) => `${m}\n    ${DESUGAR_DEP}\n`);
    }
    c.modResults.contents = gradle;
    return c;
  });

  return config;
};

const withIos = (config) => {
  config = withInfoPlist(config, (c) => {
    const modes = new Set(c.modResults.UIBackgroundModes ?? []);
    modes.add("location");
    modes.add("audio");
    c.modResults.UIBackgroundModes = [...modes];
    c.modResults.NSMotionUsageDescription ??=
      "Backseat Driver uses motion to improve navigation and to notice when you leave your phone in the car.";
    return c;
  });

  config = withAppDelegate(config, (c) => {
    if (c.modResults.language !== "swift") {
      throw new Error("[withGoogleNavigation] Expected a Swift AppDelegate.");
    }
    let src = c.modResults.contents;
    if (!src.includes("import GoogleMaps")) {
      src = src.replace(/import Expo\n/, "import Expo\nimport GoogleMaps\n");
    }
    if (!src.includes("GMSServices.provideAPIKey")) {
      src = src.replace(
        /(didFinishLaunchingWithOptions[^{]*\{\n)/,
        `$1    GMSServices.provideAPIKey("${apiKey()}")\n`,
      );
    }
    c.modResults.contents = src;
    return c;
  });

  return config;
};

module.exports = (config) => withIos(withAndroid(config));
