import groovy.json.JsonSlurper

plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

// One marketing version for every client (clients/version.json); CI supplies a
// monotonically increasing build number, which is what update checks compare.
val clientVersion = (JsonSlurper().parse(rootProject.file("../version.json")) as Map<*, *>)["version"] as String
val buildNumber = (System.getenv("NORTHSTAR_BUILD_NUMBER") ?: "1").toInt()
val releaseKeystore = System.getenv("NORTHSTAR_ANDROID_KEYSTORE")

android {
    namespace = "com.northstar.client"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.northstar.client"
        minSdk = 26
        targetSdk = 35
        versionCode = buildNumber
        versionName = clientVersion
        buildConfigField("String", "API_ORIGIN", "\"${System.getenv("NORTHSTAR_API_ORIGIN") ?: ""}\"")
    }
    flavorDimensions += "environment"
    productFlavors {
        create("prod") {
            dimension = "environment"
            manifestPlaceholders["appLabel"] = "NORTHSTAR"
            // Published APKs are prod builds; they update themselves from the stable channel.
            buildConfigField("boolean", "SELF_UPDATE", "true")
        }
        create("dev") {
            dimension = "environment"
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            manifestPlaceholders["appLabel"] = "NORTHSTAR Dev"
            buildConfigField("boolean", "SELF_UPDATE", "false")
        }
    }
    signingConfigs {
        // Release signing only from the environment (CI secrets); never committed.
        if (releaseKeystore != null) create("release") {
            storeFile = file(releaseKeystore)
            storePassword = System.getenv("NORTHSTAR_ANDROID_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("NORTHSTAR_ANDROID_KEY_ALIAS")
            keyPassword = System.getenv("NORTHSTAR_ANDROID_KEY_PASSWORD")
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
}
dependencies {
    implementation("com.wireguard.android:tunnel:1.0.20260102")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
}
