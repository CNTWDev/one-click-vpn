plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "com.northstar.client"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.northstar.client.dev"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0-dev"
        buildConfigField("String", "API_ORIGIN", "\"${System.getenv("NORTHSTAR_API_ORIGIN") ?: ""}\"")
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
