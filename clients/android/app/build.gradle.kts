import groovy.json.JsonSlurper

plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

// One marketing version for every client (clients/version.json); CI supplies a
// monotonically increasing build number, which is what update checks compare.
val clientVersion = (JsonSlurper().parse(rootProject.file("../version.json")) as Map<*, *>)["version"] as String
val buildNumber = (System.getenv("VEILBIRD_BUILD_NUMBER") ?: "1").toInt()
val releaseKeystore = System.getenv("VEILBIRD_ANDROID_KEYSTORE")

android {
    namespace = "com.veilbird.client"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.veilbird.client"
        minSdk = 26
        targetSdk = 35
        versionCode = buildNumber
        versionName = clientVersion
        buildConfigField("String", "API_ORIGIN", "\"${System.getenv("VEILBIRD_API_ORIGIN") ?: ""}\"")
    }
    flavorDimensions += "environment"
    productFlavors {
        create("prod") {
            dimension = "environment"
            manifestPlaceholders["appLabel"] = "TrackNothing"
            // Published APKs are prod builds; they update themselves from the stable channel.
            buildConfigField("boolean", "SELF_UPDATE", "true")
        }
        create("dev") {
            dimension = "environment"
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            manifestPlaceholders["appLabel"] = "TrackNothing Dev"
            buildConfigField("boolean", "SELF_UPDATE", "false")
        }
    }
    signingConfigs {
        // Release signing only from the environment (CI secrets); never committed.
        if (releaseKeystore != null) create("release") {
            storeFile = file(releaseKeystore)
            storePassword = System.getenv("VEILBIRD_ANDROID_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("VEILBIRD_ANDROID_KEY_ALIAS")
            keyPassword = System.getenv("VEILBIRD_ANDROID_KEY_PASSWORD")
        }
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }
    kotlinOptions { jvmTarget = "17" }
    // Two downloads: arm64 (nearly every phone) and a universal APK for the rest. Each holds the embedded
    // core once per ABI, so a phone downloads one copy instead of two.
    splits { abi { isEnable = true; reset(); include("arm64-v8a"); isUniversalApk = true } }
    packaging {
        // WireGuard runs inside the embedded core (libs/veilbird-core.aar); the library's own engine is not shipped.
        jniLibs.excludes += "**/libwg-go.so"
        // Native libraries compressed inside the APK: a much smaller download (the core is most of the app),
        // unpacked once at install time. Uncompressed is the default and only pays off for store-split installs.
        jniLibs.useLegacyPackaging = true
    }
}
dependencies {
    // Built by clients/core/build-android.sh (gomobile bind of mihomo); CI builds it before Gradle.
    implementation(files("libs/veilbird-core.aar"))
    // Only for Curve25519 key pairs: the private key never leaves the device.
    implementation("com.wireguard.android:tunnel:1.0.20260102")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
}
